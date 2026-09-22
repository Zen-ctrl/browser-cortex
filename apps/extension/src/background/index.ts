import {
  sha256Fingerprint,
  type ApprovalBinding,
  type CapabilityGrant,
} from '@browser-cortex/contracts';
import { ApprovalStore, evaluateCapability } from '@browser-cortex/policy';
import {
  DEMO_APPROVAL_LIFETIME_MS,
  DEMO_GRANT_LIFETIME_MS,
  DEMO_INTEGRATION_ID,
  DEMO_INTEGRATION_VERSION,
  DEMO_RECORD_ID,
  DEMO_RECORDING_RETENTION_MS,
  DEMO_STATUSES,
  DEMO_TOOL_READ,
  DEMO_TOOL_WRITE,
  canonicalDemoOrigin,
  canonicalDemoPageIdentity,
  compareDemoRecords,
  compileDemoRecording,
  demoGrantParameterScope,
  isDemoStatus,
  parseCompiledDemoWorkflow,
  parseDemoSnapshot,
  parseRecordedDemoEvent,
  type CompiledDemoWorkflow,
  type CompletedDemoRecording,
  type DemoSnapshot,
  type DemoStatus,
  type RecordedDemoEvent,
} from '../shared/demo-contract';
import {
  createMessage,
  isMessageEnvelope,
  safeError,
  type BrokerResponse,
  type MessageEnvelope,
} from '../shared/messages';

const MAX_RECORDING_EVENTS = 200;
const MAX_RECORDING_MS = 300_000;
const MAX_PERSISTED_RUNS = 24;
const BROKER_SESSION_KEY = 'browserCortexBrokerSessionV1';
const BROKER_DURABLE_RUN_KEY = 'browserCortexDurableRunV1';
const POLICY_VERSION = 'extension-demo-policy-1';

interface SessionRecord {
  readonly id: string;
  readonly tabId: number;
  readonly pageIdentity: string;
  readonly bindingToken: string;
  readonly documentId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  recording: boolean;
  readonly events: RecordedDemoEvent[];
}

interface DemoGrantRecord {
  readonly id: string;
  readonly tabId: number;
  readonly origin: string;
  readonly pageIdentity: string;
  readonly documentId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly parameterFingerprint: string;
  readonly readCapability: CapabilityGrant;
  readonly writeCapability: CapabilityGrant;
  readUses: number;
  writeUses: number;
  revoked: boolean;
}

type BrokerRunState = 'executing' | 'succeeded' | 'failed' | 'outcome-unknown' | 'undone';
type BrokerActionKind = 'write' | 'undo' | 'replay';

interface BrokerRunRecord {
  readonly id: string;
  readonly actionKind: BrokerActionKind;
  readonly grantId?: string;
  readonly tabId?: number;
  readonly documentId?: string;
  readonly from: DemoStatus;
  readonly to: DemoStatus;
  readonly createdAt: number;
  updatedAt: number;
  state: BrokerRunState;
  postcondition: boolean;
  parentRunId?: string;
  errorCode?: string;
}

interface BrokerState {
  schemaVersion: 1;
  sessions: Map<number, SessionRecord>;
  grants: Map<string, DemoGrantRecord>;
  recordings: Map<string, CompletedDemoRecording>;
  runs: Map<string, BrokerRunRecord>;
}

interface PendingBinding {
  readonly id: string;
  readonly token: string;
  readonly tabId: number;
  readonly pageIdentity: string;
  readonly expiresAt: number;
  documentId?: string;
}

interface BoundInspection {
  readonly tabId: number;
  readonly url: string;
  readonly title: string;
  readonly origin: string;
  readonly pageIdentity: string;
  readonly documentId: string;
  readonly executionSessionId: string;
  readonly executionToken: string;
  readonly snapshot: DemoSnapshot;
}

interface PendingGrantReview {
  readonly id: string;
  readonly inspection: BoundInspection;
  readonly parameterFingerprint: string;
  readonly reviewExpiresAt: number;
  readonly grantExpiresAt: number;
}

interface DemoActionParameters {
  readonly integrationId: typeof DEMO_INTEGRATION_ID;
  readonly integrationVersion: typeof DEMO_INTEGRATION_VERSION;
  readonly recordId: typeof DEMO_RECORD_ID;
  readonly field: 'status';
  readonly from: DemoStatus;
  readonly to: DemoStatus;
}

interface PendingAction {
  readonly approvalHandle: string;
  readonly grantId: string;
  readonly tabId: number;
  readonly origin: string;
  readonly pageIdentity: string;
  readonly documentId: string;
  readonly kind: BrokerActionKind;
  readonly parameters: DemoActionParameters;
  readonly binding: ApprovalBinding;
  readonly expiresAt: number;
  readonly parentRunId?: string;
  readonly planFingerprint?: string;
}

interface ActiveTab {
  readonly tabId: number;
  readonly url: string;
  readonly title: string;
}

const approvalStore = new ApprovalStore();
const pendingBindings = new Map<string, PendingBinding>();
const pendingGrantReviews = new Map<string, PendingGrantReview>();
const pendingActions = new Map<string, PendingAction>();
const tabNavigationEpochs = new Map<number, number>();
let brokerState: BrokerState = emptyState();
let persistenceQueue: Promise<void> = Promise.resolve();
const stateReady = restoreState();

void chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => undefined);

chrome.runtime.onInstalled.addListener((details) => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  void stateReady.then(async () => {
    await invalidateAllAuthority(details.reason === 'update' ? 'EXTENSION_UPDATED' : 'EXTENSION_INSTALLED');
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' || typeof changeInfo.url === 'string') {
    tabNavigationEpochs.set(tabId, (tabNavigationEpochs.get(tabId) ?? 0) + 1);
    void stateReady.then(() => invalidateTab(tabId, 'DOCUMENT_NAVIGATED'));
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const removedEpoch = (tabNavigationEpochs.get(tabId) ?? 0) + 1;
  tabNavigationEpochs.set(tabId, removedEpoch);
  void stateReady.then(async () => {
    await invalidateTab(tabId, 'TAB_CLOSED');
    if (tabNavigationEpochs.get(tabId) === removedEpoch) tabNavigationEpochs.delete(tabId);
  });
});

chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  void stateReady
    .then(() => dispatch(raw, sender))
    .then(sendResponse)
    .catch(() => sendResponse(safeError('unknown', 'BROKER_FAILURE', 'The extension broker could not complete the request.')));
  return true;
});

async function dispatch(raw: unknown, sender: chrome.runtime.MessageSender): Promise<BrokerResponse> {
  if (!isMessageEnvelope(raw)) {
    return safeError('unknown', 'INVALID_MESSAGE', 'The message did not match the versioned extension contract.');
  }
  await purgeExpiredState();
  if (raw.type === 'content.recording-bind') return bindRecording(raw, sender);
  if (raw.type === 'content.recording-event') return receiveRecordingEvent(raw, sender);
  if (raw.type === 'content.integration-bind') return bindIntegration(raw, sender);
  if (sender.tab && !isTrustedPanelSender(sender)) {
    return safeError(raw.requestId, 'UNEXPECTED_SENDER', 'Page contexts cannot call panel broker operations.');
  }
  switch (raw.type) {
    case 'panel.status':
      return panelStatus(raw);
    case 'capture.selection':
      return capture(raw, 'content.capture-selection');
    case 'capture.visible-content':
      return capture(raw, 'content.capture-visible');
    case 'grant.review':
      return reviewGrant(raw, sender);
    case 'grant.create':
      return createGrant(raw, sender);
    case 'grant.status':
      return grantStatus(raw);
    case 'grant.revoke':
      return revokeGrant(raw, sender);
    case 'demo.read':
      return readDemoRecords(raw);
    case 'demo.action.preview':
      return previewDemoAction(raw, sender);
    case 'demo.action.execute':
      return executeDemoAction(raw, sender);
    case 'recording.start':
      return startRecording(raw, sender);
    case 'recording.stop':
      return stopRecording(raw);
    case 'recording.status':
      return recordingStatus(raw);
    case 'recording.discard':
      return discardRecording(raw, sender);
    case 'recording.compile':
      return compileRecording(raw, sender);
    case 'workflow.replay.preview':
      return previewWorkflowReplay(raw, sender);
    default:
      return safeError(raw.requestId, 'UNSUPPORTED_MESSAGE', 'This request type is not available to the panel.');
  }
}

function emptyState(): BrokerState {
  return {
    schemaVersion: 1,
    sessions: new Map(),
    grants: new Map(),
    recordings: new Map(),
    runs: new Map(),
  };
}

async function activeTab(): Promise<ActiveTab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined || !tab.url) throw new Error('No active page is available.');
  const parsed = new URL(tab.url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Browser internal pages cannot be captured.');
  }
  return { tabId: tab.id, url: tab.url, title: tab.title ?? parsed.hostname };
}

function isTrustedPanelSender(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || !sender.url) return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === 'chrome-extension:'
      && url.hostname === chrome.runtime.id
      && url.pathname === '/panel.html';
  } catch {
    return false;
  }
}

function requireTrustedPanel(message: MessageEnvelope, sender: chrome.runtime.MessageSender): BrokerResponse | undefined {
  return isTrustedPanelSender(sender)
    ? undefined
    : safeError(message.requestId, 'TRUSTED_UI_REQUIRED', 'This decision must be confirmed in the extension-owned panel.');
}

async function ensureContent(tabId: number): Promise<void> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, createMessage('content.ping'));
    if (isContentResponse(response)) return;
  } catch {
    // The packaged content script has not been injected into this document yet.
  }
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['assets/content.js'] });
  const response = await chrome.tabs.sendMessage(tabId, createMessage('content.ping'));
  if (!isContentResponse(response)) throw new Error('The packaged capture script did not initialize.');
}

async function inspectActiveDemo(expected?: {
  readonly tabId?: number;
  readonly pageIdentity?: string;
  readonly documentId?: string;
}): Promise<BoundInspection> {
  const tab = await activeTab();
  if (expected?.tabId !== undefined && expected.tabId !== tab.tabId) throw new Error('The active tab changed.');
  const pageIdentity = canonicalDemoPageIdentity(tab.url);
  if (expected?.pageIdentity !== undefined && expected.pageIdentity !== pageIdentity) throw new Error('The active demo document changed.');
  await ensureContent(tab.tabId);
  const binding: PendingBinding = {
    id: crypto.randomUUID(),
    token: crypto.randomUUID(),
    tabId: tab.tabId,
    pageIdentity,
    expiresAt: Date.now() + 10_000,
  };
  pendingBindings.set(binding.id, binding);
  try {
    const response = await chrome.tabs.sendMessage(tab.tabId, createMessage('content.integration-inspect', {
      integrationId: DEMO_INTEGRATION_ID,
      bindingToken: binding.token,
    }, binding.id));
    if (!isContentResponse(response) || response.data?.contractValid !== true || !binding.documentId) {
      const reason = stringValue(response && typeof response === 'object'
        ? (response as { data?: Record<string, unknown> }).data?.reason
        : undefined);
      throw new Error(reason ?? 'The page does not match the packaged demo integration.');
    }
    if (expected?.documentId !== undefined && expected.documentId !== binding.documentId) {
      throw new Error('The browser document identity changed.');
    }
    const snapshot = parseDemoSnapshot(response.data.snapshot);
    if (snapshot.pageIdentity !== pageIdentity) throw new Error('The page-reported location did not match the browser-verified tab.');
    return {
      tabId: tab.tabId,
      url: tab.url,
      title: tab.title,
      origin: canonicalDemoOrigin(tab.url),
      pageIdentity,
      documentId: binding.documentId,
      executionSessionId: binding.id,
      executionToken: binding.token,
      snapshot,
    };
  } finally {
    pendingBindings.delete(binding.id);
  }
}

function bindIntegration(message: MessageEnvelope, sender: chrome.runtime.MessageSender): BrokerResponse {
  const tabId = sender.tab?.id;
  if (tabId === undefined || sender.frameId !== 0 || !sender.documentId || !sender.url || !message.sessionId) {
    return safeError(message.requestId, 'INVALID_EVENT_SENDER', 'The integration must bind to a browser-verified top-level document.');
  }
  const binding = pendingBindings.get(message.sessionId);
  let identity: string;
  try {
    identity = canonicalDemoPageIdentity(sender.url);
  } catch {
    return safeError(message.requestId, 'INTEGRATION_SCOPE_DENIED', 'The sender is outside the reviewed demo page.');
  }
  if (
    !binding
    || Date.now() >= binding.expiresAt
    || binding.tabId !== tabId
    || binding.pageIdentity !== identity
    || !hasExactKeys(message.payload, ['integrationId', 'bindingToken'])
    || message.payload.bindingToken !== binding.token
    || message.payload.integrationId !== DEMO_INTEGRATION_ID
  ) {
    return safeError(message.requestId, 'STALE_SESSION', 'The integration binding challenge did not match this document.');
  }
  binding.documentId = sender.documentId;
  return { ok: true, requestId: message.requestId, data: { bound: true } };
}

async function panelStatus(message: MessageEnvelope): Promise<BrokerResponse> {
  if (!hasExactKeys(message.payload, [])) {
    return safeError(message.requestId, 'INVALID_INPUT', 'Panel status does not accept parameters.');
  }
  try {
    const tab = await activeTab();
    const session = await validatedSessionForDocument(tab.tabId, tab.url);
    const grant = activeGrantForTab(tab.tabId, tab.url);
    const lastRun = [...brokerState.runs.values()]
      .filter((run) => run.tabId === tab.tabId || run.tabId === undefined)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    return {
      ok: true,
      requestId: message.requestId,
      data: {
        ...tab,
        sessionId: session?.id,
        recording: session?.recording ?? false,
        eventCount: session?.events.length ?? 0,
        demoSite: isDemoUrl(tab.url),
        grant: grant ? grantSummary(grant) : undefined,
        lastRun: lastRun ? publicRun(lastRun) : undefined,
      },
    };
  } catch (error) {
    return safeError(message.requestId, 'TAB_UNAVAILABLE', errorMessage(error, 'No supported tab is active.'));
  }
}

async function capture(
  message: MessageEnvelope,
  type: 'content.capture-selection' | 'content.capture-visible',
): Promise<BrokerResponse> {
  if (!hasExactKeys(message.payload, [])) {
    return safeError(message.requestId, 'INVALID_INPUT', 'Capture does not accept page-supplied parameters.');
  }
  try {
    const tab = await activeTab();
    await ensureContent(tab.tabId);
    const response = await chrome.tabs.sendMessage(tab.tabId, createMessage(type, {}, sessionForPage(tab.tabId, tab.url)?.id));
    if (!isContentResponse(response)) {
      return safeError(message.requestId, 'INVALID_CONTENT_RESPONSE', 'The page returned an invalid capture response.');
    }
    const data = response.data ?? {};
    return {
      ok: true,
      requestId: message.requestId,
      data: { ...data, tabId: tab.tabId, title: tab.title, origin: new URL(tab.url).origin },
    };
  } catch (error) {
    return safeError(message.requestId, 'CAPTURE_FAILED', errorMessage(error, 'The selected content could not be captured.'));
  }
}

async function reviewGrant(message: MessageEnvelope, sender: chrome.runtime.MessageSender): Promise<BrokerResponse> {
  const denied = requireTrustedPanel(message, sender);
  if (denied) return denied;
  if (!hasExactKeys(message.payload, [])) return safeError(message.requestId, 'INVALID_INPUT', 'Grant review does not accept page-supplied parameters.');
  try {
    const inspection = await inspectActiveDemo();
    const parameterFingerprint = await sha256Fingerprint(demoGrantParameterScope());
    const now = Date.now();
    const review: PendingGrantReview = {
      id: crypto.randomUUID(),
      inspection,
      parameterFingerprint,
      reviewExpiresAt: now + 2 * 60 * 1_000,
      grantExpiresAt: now + DEMO_GRANT_LIFETIME_MS,
    };
    pendingGrantReviews.set(review.id, review);
    return {
      ok: true,
      requestId: message.requestId,
      data: {
        reviewId: review.id,
        origin: inspection.origin,
        pageIdentity: inspection.pageIdentity,
        documentId: inspection.documentId,
        integrationId: DEMO_INTEGRATION_ID,
        integrationVersion: DEMO_INTEGRATION_VERSION,
        recordId: DEMO_RECORD_ID,
        operations: [DEMO_TOOL_READ, DEMO_TOOL_WRITE],
        statuses: [...DEMO_STATUSES],
        reviewExpiresAt: review.reviewExpiresAt,
        expiresAt: review.grantExpiresAt,
        parameterFingerprint,
      },
    };
  } catch (error) {
    return safeError(message.requestId, 'GRANT_REVIEW_FAILED', errorMessage(error, 'The demo integration could not be reviewed.'));
  }
}

async function createGrant(message: MessageEnvelope, sender: chrome.runtime.MessageSender): Promise<BrokerResponse> {
  const denied = requireTrustedPanel(message, sender);
  if (denied) return denied;
  const reviewId = exactStringPayload(message.payload, 'reviewId');
  if (!reviewId) return safeError(message.requestId, 'INVALID_INPUT', 'A single trusted review identifier is required.');
  const review = pendingGrantReviews.get(reviewId);
  pendingGrantReviews.delete(reviewId);
  if (!review || Date.now() >= review.reviewExpiresAt || Date.now() >= review.grantExpiresAt) {
    return safeError(message.requestId, 'REVIEW_EXPIRED', 'The grant review expired. Review the active document again.');
  }
  try {
    const inspection = await inspectActiveDemo(review.inspection);
    const now = Date.now();
    const expiresAt = review.grantExpiresAt;
    const id = `grant:${crypto.randomUUID()}`;
    const common = {
      schemaVersion: 1 as const,
      subject: `document:${inspection.documentId}`,
      originatingApplication: inspection.origin,
      workspaceId: 'extension-vault',
      sourceIds: [DEMO_RECORD_ID],
      toolVersion: DEMO_INTEGRATION_VERSION,
      parameterFingerprint: review.parameterFingerprint,
      recipient: `integration:${DEMO_INTEGRATION_ID}`,
      issuedAt: now,
      expiresAt,
      usageLimit: 100,
      revoked: false,
    };
    const grant: DemoGrantRecord = {
      id,
      tabId: inspection.tabId,
      origin: inspection.origin,
      pageIdentity: inspection.pageIdentity,
      documentId: inspection.documentId,
      issuedAt: now,
      expiresAt,
      parameterFingerprint: review.parameterFingerprint,
      readCapability: { ...common, grantId: `${id}:read`, operation: DEMO_TOOL_READ },
      writeCapability: { ...common, grantId: `${id}:write`, operation: DEMO_TOOL_WRITE },
      readUses: 0,
      writeUses: 0,
      revoked: false,
    };
    // Force schema validation through the shared policy package before persistence.
    const readDecision = evaluateCapability(grant.readCapability, capabilityRequest(grant, DEMO_TOOL_READ), 0, now);
    const writeDecision = evaluateCapability(grant.writeCapability, capabilityRequest(grant, DEMO_TOOL_WRITE), 0, now);
    if (!readDecision.allowed || !writeDecision.allowed) throw new Error('The scoped grant could not be validated.');
    for (const current of brokerState.grants.values()) {
      if (current.tabId === grant.tabId) current.revoked = true;
    }
    brokerState.grants.set(grant.id, grant);
    await persistState();
    return { ok: true, requestId: message.requestId, data: { grant: grantSummary(grant) } };
  } catch (error) {
    return safeError(message.requestId, 'GRANT_CREATE_FAILED', errorMessage(error, 'The scoped grant could not be created.'));
  }
}

async function grantStatus(message: MessageEnvelope): Promise<BrokerResponse> {
  if (!hasExactKeys(message.payload, [])) return safeError(message.requestId, 'INVALID_INPUT', 'Grant status does not accept parameters.');
  try {
    const tab = await activeTab();
    const grant = activeGrantForTab(tab.tabId, tab.url);
    if (!grant) return { ok: true, requestId: message.requestId, data: { active: false } };
    try {
      await inspectActiveDemo({ tabId: grant.tabId, pageIdentity: grant.pageIdentity, documentId: grant.documentId });
    } catch {
      await revokeGrantRecord(grant);
      return { ok: true, requestId: message.requestId, data: { active: false } };
    }
    return { ok: true, requestId: message.requestId, data: { active: true, grant: grantSummary(grant) } };
  } catch {
    return { ok: true, requestId: message.requestId, data: { active: false } };
  }
}

async function revokeGrant(message: MessageEnvelope, sender: chrome.runtime.MessageSender): Promise<BrokerResponse> {
  const denied = requireTrustedPanel(message, sender);
  if (denied) return denied;
  const grantId = exactStringPayload(message.payload, 'grantId');
  if (!grantId) return safeError(message.requestId, 'INVALID_INPUT', 'A single grant identifier is required.');
  const grant = brokerState.grants.get(grantId);
  if (!grant) return safeError(message.requestId, 'GRANT_NOT_FOUND', 'The grant is no longer active.');
  await revokeGrantRecord(grant);
  return { ok: true, requestId: message.requestId, data: { revoked: true, grantId } };
}

async function readDemoRecords(message: MessageEnvelope): Promise<BrokerResponse> {
  const grantId = exactStringPayload(message.payload, 'grantId');
  if (!grantId) return safeError(message.requestId, 'INVALID_INPUT', 'A single grant identifier is required.');
  try {
    const inspection = await inspectActiveDemo();
    const grant = authorizeGrant(grantId, inspection, DEMO_TOOL_READ, true);
    await persistState();
    return {
      ok: true,
      requestId: message.requestId,
      data: {
        grant: grantSummary(grant),
        currentStatus: inspection.snapshot.currentStatus,
        purchaseOrder: inspection.snapshot.purchaseOrder as unknown as Record<string, unknown>,
        invoice: inspection.snapshot.invoice as unknown as Record<string, unknown>,
        comparison: compareDemoRecords(inspection.snapshot) as unknown as Record<string, unknown>,
        declarationAuthority: 'matched-to-packaged-integration',
      },
    };
  } catch (error) {
    return safeError(message.requestId, 'DEMO_READ_DENIED', errorMessage(error, 'The reviewed demo records could not be read.'));
  }
}

async function previewDemoAction(message: MessageEnvelope, sender: chrome.runtime.MessageSender): Promise<BrokerResponse> {
  const denied = requireTrustedPanel(message, sender);
  if (denied) return denied;
  const keys = Object.keys(message.payload);
  if (keys.some((key) => !['grantId', 'to', 'undoRunId'].includes(key))) {
    return safeError(message.requestId, 'INVALID_INPUT', 'The action preview contains unsupported parameters.');
  }
  const grantId = stringValue(message.payload.grantId);
  const requestedTo = message.payload.to;
  const undoRunId = stringValue(message.payload.undoRunId);
  if (!grantId || (undoRunId ? requestedTo !== undefined : !isDemoStatus(requestedTo))) {
    return safeError(message.requestId, 'INVALID_INPUT', 'The action preview parameters are invalid.');
  }
  try {
    const inspection = await inspectActiveDemo();
    authorizeGrant(grantId, inspection, DEMO_TOOL_WRITE, false);
    let from = inspection.snapshot.currentStatus;
    let to = requestedTo as DemoStatus;
    let kind: BrokerActionKind = 'write';
    let parentRunId: string | undefined;
    if (undoRunId) {
      const previous = brokerState.runs.get(undoRunId);
      if (!previous || previous.state !== 'succeeded' || !previous.postcondition || previous.tabId !== inspection.tabId || previous.documentId !== inspection.documentId) {
        throw new Error('The selected action does not have a verified undo on this document.');
      }
      if (inspection.snapshot.currentStatus !== previous.to) throw new Error('The current status drifted, so undo was stopped.');
      from = previous.to;
      to = previous.from;
      kind = 'undo';
      parentRunId = previous.id;
    }
    if (from === to) throw new Error('The requested status is already current.');
    const pending = await createPendingAction({
      grantId,
      inspection,
      kind,
      from,
      to,
      ...(parentRunId ? { parentRunId } : {}),
    });
    return { ok: true, requestId: message.requestId, data: actionPreview(pending) };
  } catch (error) {
    return safeError(message.requestId, 'ACTION_PREVIEW_DENIED', errorMessage(error, 'The action preview could not be prepared.'));
  }
}

async function previewWorkflowReplay(message: MessageEnvelope, sender: chrome.runtime.MessageSender): Promise<BrokerResponse> {
  const denied = requireTrustedPanel(message, sender);
  if (denied) return denied;
  if (!hasExactKeys(message.payload, ['grantId', 'compiled', 'inputs'])) {
    return safeError(message.requestId, 'INVALID_INPUT', 'The workflow replay request contains unsupported fields.');
  }
  const grantId = stringValue(message.payload.grantId);
  if (!grantId) return safeError(message.requestId, 'INVALID_INPUT', 'A current document grant is required.');
  try {
    const compiled = await parseCompiledDemoWorkflow(message.payload.compiled);
    const inputs = objectValue(message.payload.inputs, 'Workflow inputs');
    if (!hasExactKeys(inputs, [compiled.replay.variableName])) throw new Error('The workflow inputs do not match the reviewed variable set.');
    const to = inputs[compiled.replay.variableName];
    if (!isDemoStatus(to) || !compiled.variables[0].allowedValues.includes(to)) {
      throw new Error('The selected workflow variable is outside its reviewed values.');
    }
    if (to === compiled.replay.expectedCurrentStatus) {
      throw new Error('The selected workflow value would not change the current status.');
    }
    const inspection = await inspectActiveDemo();
    if (
      inspection.origin !== compiled.replay.origin
      || inspection.snapshot.integrationId !== compiled.integrationId
      || inspection.snapshot.integrationVersion !== compiled.integrationVersion
      || inspection.snapshot.recordId !== compiled.replay.recordId
      || inspection.snapshot.currentStatus !== compiled.replay.expectedCurrentStatus
    ) {
      throw new Error('Replay stopped because origin, integration, record, or current state drifted.');
    }
    authorizeGrant(grantId, inspection, DEMO_TOOL_WRITE, false);
    const pending = await createPendingAction({
      grantId,
      inspection,
      kind: 'replay',
      from: compiled.replay.expectedCurrentStatus,
      to,
      planFingerprint: compiled.planFingerprint,
    });
    return {
      ok: true,
      requestId: message.requestId,
      data: { ...actionPreview(pending), workflow: publicCompiledWorkflow(compiled) },
    };
  } catch (error) {
    return safeError(message.requestId, 'REPLAY_DRIFT', errorMessage(error, 'Workflow replay stopped on validation drift.'));
  }
}

async function createPendingAction(input: {
  readonly grantId: string;
  readonly inspection: BoundInspection;
  readonly kind: BrokerActionKind;
  readonly from: DemoStatus;
  readonly to: DemoStatus;
  readonly parentRunId?: string;
  readonly planFingerprint?: string;
}): Promise<PendingAction> {
  const parameters: DemoActionParameters = {
    integrationId: DEMO_INTEGRATION_ID,
    integrationVersion: DEMO_INTEGRATION_VERSION,
    recordId: DEMO_RECORD_ID,
    field: 'status',
    from: input.from,
    to: input.to,
  };
  const payloadFingerprint = await sha256Fingerprint({
    kind: input.kind,
    parameters,
    documentId: input.inspection.documentId,
    ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
    ...(input.planFingerprint ? { planFingerprint: input.planFingerprint } : {}),
  });
  const binding: ApprovalBinding = {
    schemaVersion: 1,
    purpose: 'tool-action',
    payloadFingerprint,
    endpoint: chrome.runtime.getURL(`integrations/${DEMO_INTEGRATION_ID}`),
    method: 'POST',
    model: 'deterministic-vetted-tool',
    sourceRevisions: [{ sourceId: DEMO_RECORD_ID, revision: `${DEMO_INTEGRATION_VERSION}:${input.inspection.documentId}` }],
    policyVersion: POLICY_VERSION,
  };
  const approvalHandle = await approvalStore.issue(binding, {
    lifetimeMs: DEMO_APPROVAL_LIFETIME_MS,
    maxUses: 1,
  });
  const pending: PendingAction = {
    approvalHandle,
    grantId: input.grantId,
    tabId: input.inspection.tabId,
    origin: input.inspection.origin,
    pageIdentity: input.inspection.pageIdentity,
    documentId: input.inspection.documentId,
    kind: input.kind,
    parameters,
    binding,
    expiresAt: Date.now() + DEMO_APPROVAL_LIFETIME_MS,
    ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
    ...(input.planFingerprint ? { planFingerprint: input.planFingerprint } : {}),
  };
  pendingActions.set(approvalHandle, pending);
  return pending;
}

async function executeDemoAction(message: MessageEnvelope, sender: chrome.runtime.MessageSender): Promise<BrokerResponse> {
  const denied = requireTrustedPanel(message, sender);
  if (denied) return denied;
  const approvalHandle = exactStringPayload(message.payload, 'approvalHandle');
  if (!approvalHandle) return safeError(message.requestId, 'INVALID_INPUT', 'A single one-use approval handle is required.');
  const pending = pendingActions.get(approvalHandle);
  pendingActions.delete(approvalHandle);
  if (!pending || Date.now() >= pending.expiresAt) {
    approvalStore.revoke(approvalHandle);
    return safeError(message.requestId, 'APPROVAL_EXPIRED', 'The one-use action approval expired. Review the action again.');
  }
  try {
    const inspection = await inspectActiveDemo({
      tabId: pending.tabId,
      pageIdentity: pending.pageIdentity,
      documentId: pending.documentId,
    });
    if (inspection.origin !== pending.origin || inspection.snapshot.currentStatus !== pending.parameters.from) {
      approvalStore.revoke(approvalHandle);
      throw new Error('The document or current state changed after review.');
    }
    const grant = authorizeGrant(pending.grantId, inspection, DEMO_TOOL_WRITE, true);
    const approval = await approvalStore.consume(approvalHandle, pending.binding);
    if (!approval.approved) throw new Error(`The one-use approval was rejected: ${approval.reason}.`);
    await persistState();
    const run: BrokerRunRecord = {
      id: `run:${crypto.randomUUID()}`,
      actionKind: pending.kind,
      grantId: grant.id,
      tabId: pending.tabId,
      documentId: pending.documentId,
      from: pending.parameters.from,
      to: pending.parameters.to,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      state: 'executing',
      postcondition: false,
      ...(pending.parentRunId ? { parentRunId: pending.parentRunId } : {}),
    };
    brokerState.runs.set(run.id, run);
    trimRuns();
    await persistState();
    try {
      await persistDurableRun(run);
    } catch {
      run.state = 'failed';
      run.errorCode = 'DURABLE_CHECKPOINT_FAILED';
      run.updatedAt = Date.now();
      await persistState();
      return safeError(message.requestId, 'ACTION_STOPPED', 'The durable pre-write checkpoint failed, so no write was attempted.');
    }
    let executionInspection: BoundInspection;
    try {
      executionInspection = await inspectActiveDemo({
        tabId: pending.tabId,
        pageIdentity: pending.pageIdentity,
        documentId: pending.documentId,
      });
      if (
        executionInspection.origin !== pending.origin
        || executionInspection.snapshot.currentStatus !== pending.parameters.from
      ) {
        throw new Error('The reviewed document state changed before dispatch.');
      }
    } catch {
      run.state = 'failed';
      run.errorCode = 'PRE_WRITE_DRIFT';
      run.updatedAt = Date.now();
      await persistState().catch(() => undefined);
      await persistDurableRun(run).catch(() => undefined);
      return safeError(message.requestId, 'ACTION_STOPPED', 'The exact document binding or current state changed before the write, so no write was attempted.');
    }
    let response: unknown;
    try {
      response = await withTimeout(
        chrome.tabs.sendMessage(pending.tabId, createMessage('content.integration-write', {
          actionId: run.id,
          executionToken: executionInspection.executionToken,
          ...pending.parameters,
        }, executionInspection.executionSessionId), { documentId: pending.documentId }),
        5_000,
      );
    } catch (error) {
      run.state = 'outcome-unknown';
      run.errorCode = 'WRITE_RESULT_UNRESOLVED';
      run.updatedAt = Date.now();
      await persistState().catch(() => undefined);
      await persistDurableRun(run).catch(() => undefined);
      return safeError(message.requestId, 'OUTCOME_UNKNOWN', errorMessage(error, 'The write result is unknown and will not be retried.'));
    }
    if (!isContentResponse(response) || response.data?.postcondition !== true) {
      const reason = stringValue(response && typeof response === 'object'
        ? (response as { data?: Record<string, unknown> }).data?.reason
        : undefined);
      run.state = reason === 'current-state-drift'
        || reason === 'ambiguous-target'
        || reason === 'integration-drift'
        || reason === 'execution-binding-denied'
        ? 'failed'
        : 'outcome-unknown';
      run.errorCode = reason ?? 'POSTCONDITION_NOT_CONFIRMED';
      run.updatedAt = Date.now();
      await persistState().catch(() => undefined);
      await persistDurableRun(run).catch(() => undefined);
      return safeError(
        message.requestId,
        run.state === 'outcome-unknown' ? 'OUTCOME_UNKNOWN' : 'ACTION_STOPPED',
        run.state === 'outcome-unknown'
          ? 'The write postcondition could not be confirmed and the action will not be retried.'
          : 'The action stopped before a write because the reviewed target drifted.',
      );
    }
    let postcondition: BoundInspection;
    try {
      postcondition = await inspectActiveDemo({
        tabId: pending.tabId,
        pageIdentity: pending.pageIdentity,
        documentId: pending.documentId,
      });
    } catch {
      run.state = 'outcome-unknown';
      run.errorCode = 'POSTCONDITION_UNAVAILABLE';
      run.updatedAt = Date.now();
      await persistState().catch(() => undefined);
      await persistDurableRun(run).catch(() => undefined);
      return safeError(message.requestId, 'OUTCOME_UNKNOWN', 'The write returned but its current-state postcondition could not be verified. It will not be retried.');
    }
    if (postcondition.snapshot.currentStatus !== pending.parameters.to) {
      run.state = 'outcome-unknown';
      run.errorCode = 'POSTCONDITION_MISMATCH';
      run.updatedAt = Date.now();
      await persistState().catch(() => undefined);
      await persistDurableRun(run).catch(() => undefined);
      return safeError(message.requestId, 'OUTCOME_UNKNOWN', 'The page state did not match the reviewed write. It will not be retried.');
    }
    run.state = 'succeeded';
    run.postcondition = true;
    run.updatedAt = Date.now();
    if (pending.kind === 'undo' && pending.parentRunId) {
      const parent = brokerState.runs.get(pending.parentRunId);
      if (parent) {
        parent.state = 'undone';
        parent.updatedAt = run.updatedAt;
      }
    }
    await persistState().catch(() => undefined);
    await persistDurableRun(run).catch(() => undefined);
    return {
      ok: true,
      requestId: message.requestId,
      data: { run: publicRun(run), undoAvailable: pending.kind !== 'undo' },
    };
  } catch (error) {
    approvalStore.revoke(approvalHandle);
    return safeError(message.requestId, 'ACTION_EXECUTION_DENIED', errorMessage(error, 'The action was denied before execution.'));
  }
}

async function startRecording(message: MessageEnvelope, sender: chrome.runtime.MessageSender): Promise<BrokerResponse> {
  // Dispatch has already rejected page-owned senders. A packaged panel opened in
  // a browser tab can legitimately carry sender.tab, as can the visible side panel.
  void sender;
  if (!hasExactKeys(message.payload, [])) return safeError(message.requestId, 'INVALID_INPUT', 'Recording start does not accept page-supplied scope.');
  try {
    const inspection = await inspectActiveDemo();
    const session: SessionRecord = {
      id: crypto.randomUUID(),
      tabId: inspection.tabId,
      pageIdentity: inspection.pageIdentity,
      bindingToken: crypto.randomUUID(),
      documentId: inspection.documentId,
      createdAt: Date.now(),
      expiresAt: Date.now() + MAX_RECORDING_MS,
      recording: false,
      events: [],
    };
    brokerState.sessions.set(inspection.tabId, session);
    await persistState();
    const response = await chrome.tabs.sendMessage(inspection.tabId, createMessage('content.recording-start', {
      maxEvents: MAX_RECORDING_EVENTS,
      maxDurationMs: MAX_RECORDING_MS,
      integrationId: DEMO_INTEGRATION_ID,
      bindingToken: session.bindingToken,
    }, session.id), { documentId: inspection.documentId });
    if (!isContentResponse(response) || response.data?.bound !== true || !session.recording) {
      brokerState.sessions.delete(inspection.tabId);
      await persistState();
      return safeError(message.requestId, 'RECORDING_BIND_FAILED', 'The demo document could not be bound to the recording session.');
    }
    return {
      ok: true,
      requestId: message.requestId,
      data: {
        sessionId: session.id,
        recording: true,
        eventCount: 0,
        origin: inspection.origin,
        documentId: inspection.documentId,
        expiresAt: session.expiresAt,
      },
    };
  } catch (error) {
    return safeError(message.requestId, 'RECORDING_START_FAILED', errorMessage(error, 'Recording could not start.'));
  }
}

async function stopRecording(message: MessageEnvelope): Promise<BrokerResponse> {
  if (!hasExactKeys(message.payload, [])) return safeError(message.requestId, 'INVALID_INPUT', 'Recording stop does not accept parameters.');
  try {
    const tab = await activeTab();
    const navigationEpoch = tabNavigationEpochs.get(tab.tabId) ?? 0;
    const candidate = brokerState.sessions.get(tab.tabId);
    if (!candidate) return safeError(message.requestId, 'NO_RECORDING', 'No recording exists for this page.');
    const session = await validatedSessionForDocument(tab.tabId, tab.url);
    if (!session || session.id !== candidate.id || !session.recording) {
      brokerState.sessions.delete(tab.tabId);
      await persistState();
      return safeError(message.requestId, 'STALE_DOCUMENT', 'Recording was discarded because the bound browser document could not be verified.');
    }
    session.recording = false;
    try {
      const stopped = await chrome.tabs.sendMessage(
        tab.tabId,
        createMessage('content.recording-stop', {}, session.id),
        { documentId: session.documentId },
      );
      if (!isContentResponse(stopped) || stopped.data?.recording !== false) {
        throw new Error('The bound document did not confirm recording stop.');
      }
    } catch {
      brokerState.sessions.delete(tab.tabId);
      await persistState();
      return safeError(message.requestId, 'STALE_DOCUMENT', 'Recording was discarded because the exact bound document disappeared before stop was confirmed.');
    }
    if ((tabNavigationEpochs.get(tab.tabId) ?? 0) !== navigationEpoch) {
      brokerState.sessions.delete(tab.tabId);
      await persistState();
      return safeError(message.requestId, 'STALE_DOCUMENT', 'Recording was discarded because navigation started during finalization.');
    }
    brokerState.sessions.delete(tab.tabId);
    if (session.events.length === 0) {
      await persistState();
      return safeError(message.requestId, 'EMPTY_RECORDING', 'No reviewed semantic events were recorded.');
    }
    const recording: CompletedDemoRecording = Object.freeze({
      id: `recording:${crypto.randomUUID()}`,
      origin: canonicalDemoOrigin(session.pageIdentity),
      sourceDocumentId: session.documentId,
      createdAt: session.createdAt,
      expiresAt: Date.now() + DEMO_RECORDING_RETENTION_MS,
      events: Object.freeze(session.events.map((event) => Object.freeze({ ...event }))),
    });
    brokerState.recordings.set(recording.id, recording);
    await persistState();
    return {
      ok: true,
      requestId: message.requestId,
      data: {
        sessionId: session.id,
        recordingId: recording.id,
        recording: false,
        events: recording.events as unknown as Record<string, unknown>[],
        eventCount: recording.events.length,
        expiresAt: recording.expiresAt,
      },
    };
  } catch (error) {
    return safeError(message.requestId, 'RECORDING_STOP_FAILED', errorMessage(error, 'Recording could not stop safely.'));
  }
}

async function recordingStatus(message: MessageEnvelope): Promise<BrokerResponse> {
  if (!hasExactKeys(message.payload, [])) return safeError(message.requestId, 'INVALID_INPUT', 'Recording status does not accept parameters.');
  try {
    const tab = await activeTab();
    const session = await validatedSessionForDocument(tab.tabId, tab.url);
    return {
      ok: true,
      requestId: message.requestId,
      data: {
        recording: session?.recording ?? false,
        eventCount: session?.events.length ?? 0,
        sessionId: session?.id,
        demoSite: isDemoUrl(tab.url),
        expiresAt: session?.expiresAt,
      },
    };
  } catch (error) {
    return safeError(message.requestId, 'TAB_UNAVAILABLE', errorMessage(error, 'No supported tab is active.'));
  }
}

async function discardRecording(message: MessageEnvelope, sender: chrome.runtime.MessageSender): Promise<BrokerResponse> {
  const denied = requireTrustedPanel(message, sender);
  if (denied) return denied;
  const allowed = new Set(['recordingId', 'active']);
  if (Object.keys(message.payload).some((key) => !allowed.has(key))) return safeError(message.requestId, 'INVALID_INPUT', 'The discard request is invalid.');
  const recordingId = stringValue(message.payload.recordingId);
  let discarded = false;
  if (recordingId) discarded = brokerState.recordings.delete(recordingId) || discarded;
  if (message.payload.active === true) {
    try {
      const tab = await activeTab();
      const session = brokerState.sessions.get(tab.tabId);
      if (session) {
        session.recording = false;
        brokerState.sessions.delete(tab.tabId);
        discarded = true;
        try {
          await chrome.tabs.sendMessage(tab.tabId, createMessage('content.recording-stop', {}, session.id), { documentId: session.documentId });
        } catch {
          // The stale document cannot retain authority after the broker removes the session.
        }
      }
    } catch {
      // There is no active supported tab, so no active recording can be retained.
    }
  }
  await persistState();
  return { ok: true, requestId: message.requestId, data: { discarded } };
}

async function compileRecording(message: MessageEnvelope, sender: chrome.runtime.MessageSender): Promise<BrokerResponse> {
  const denied = requireTrustedPanel(message, sender);
  if (denied) return denied;
  if (Object.keys(message.payload).some((key) => !['recordingId', 'variableName'].includes(key))) {
    return safeError(message.requestId, 'INVALID_INPUT', 'The recording compilation request contains unsupported fields.');
  }
  const recordingId = stringValue(message.payload.recordingId);
  const variableName = stringValue(message.payload.variableName) ?? 'targetStatus';
  if (!recordingId) return safeError(message.requestId, 'INVALID_INPUT', 'A completed recording is required.');
  const recording = brokerState.recordings.get(recordingId);
  if (!recording || Date.now() >= recording.expiresAt) {
    brokerState.recordings.delete(recordingId);
    await persistState();
    return safeError(message.requestId, 'RECORDING_EXPIRED', 'The short-lived recording expired or was discarded.');
  }
  try {
    const compiled = await compileDemoRecording(recording, variableName);
    return {
      ok: true,
      requestId: message.requestId,
      data: { compiled: compiled as unknown as Record<string, unknown> },
    };
  } catch (error) {
    return safeError(message.requestId, 'WORKFLOW_COMPILE_FAILED', errorMessage(error, 'The recording could not be normalized into a finite workflow.'));
  }
}

async function bindRecording(message: MessageEnvelope, sender: chrome.runtime.MessageSender): Promise<BrokerResponse> {
  const tabId = sender.tab?.id;
  if (tabId === undefined || sender.frameId !== 0 || !sender.documentId || !sender.url) {
    return safeError(message.requestId, 'INVALID_EVENT_SENDER', 'Recording must bind to a top-level document identity.');
  }
  const session = brokerState.sessions.get(tabId);
  let identity: string | undefined;
  try {
    identity = canonicalDemoPageIdentity(sender.url);
  } catch {
    identity = undefined;
  }
  if (
    !session
    || !message.sessionId
    || message.sessionId !== session.id
    || !identity
    || identity !== session.pageIdentity
    || sender.documentId !== session.documentId
  ) {
    return safeError(message.requestId, 'STALE_SESSION', 'The recording session does not match this demo document.');
  }
  if (
    !hasExactKeys(message.payload, ['integrationId', 'bindingToken'])
    || message.payload.bindingToken !== session.bindingToken
    || message.payload.integrationId !== DEMO_INTEGRATION_ID
  ) {
    return safeError(message.requestId, 'RECORDING_BIND_FAILED', 'The packaged demo integration marker did not match.');
  }
  session.recording = true;
  await persistState();
  return { ok: true, requestId: message.requestId, data: { bound: true } };
}

async function receiveRecordingEvent(message: MessageEnvelope, sender: chrome.runtime.MessageSender): Promise<BrokerResponse> {
  const tabId = sender.tab?.id;
  if (tabId === undefined || sender.frameId !== 0 || !sender.documentId || !sender.url) {
    return safeError(message.requestId, 'INVALID_EVENT_SENDER', 'Recording events must come from the bound top-level document.');
  }
  const session = brokerState.sessions.get(tabId);
  if (!session?.recording || !message.sessionId || message.sessionId !== session.id) {
    return safeError(message.requestId, 'STALE_SESSION', 'The recording session is no longer active.');
  }
  let identity: string | undefined;
  try {
    identity = canonicalDemoPageIdentity(sender.url);
  } catch {
    identity = undefined;
  }
  if (sender.documentId !== session.documentId || identity !== session.pageIdentity) {
    session.recording = false;
    brokerState.sessions.delete(tabId);
    await persistState();
    return safeError(message.requestId, 'STALE_DOCUMENT', 'Recording stopped because the bound document changed.');
  }
  if (Date.now() >= session.expiresAt || session.events.length >= MAX_RECORDING_EVENTS) {
    session.recording = false;
    await persistState();
    return safeError(message.requestId, 'RECORDING_LIMIT', 'Recording reached its bounded limit and stopped.');
  }
  try {
    const event = parseRecordedDemoEvent({ ...message.payload, receivedAt: Date.now() });
    const previous = session.events[session.events.length - 1];
    if (previous && previous.to !== event.from) throw new Error('The recorded event does not continue the current semantic state chain.');
    session.events.push(event);
    await persistState();
    return { ok: true, requestId: message.requestId, data: { eventCount: session.events.length } };
  } catch (error) {
    return safeError(message.requestId, 'INVALID_RECORDING_EVENT', errorMessage(error, 'The semantic event was outside the reviewed demo contract.'));
  }
}

function authorizeGrant(
  grantId: string,
  inspection: BoundInspection,
  operation: typeof DEMO_TOOL_READ | typeof DEMO_TOOL_WRITE,
  consume: boolean,
): DemoGrantRecord {
  const grant = brokerState.grants.get(grantId);
  if (
    !grant
    || grant.revoked
    || Date.now() >= grant.expiresAt
    || grant.tabId !== inspection.tabId
    || grant.origin !== inspection.origin
    || grant.pageIdentity !== inspection.pageIdentity
    || grant.documentId !== inspection.documentId
  ) {
    throw new Error('No active grant matches this exact browser document.');
  }
  const capability = operation === DEMO_TOOL_READ ? grant.readCapability : grant.writeCapability;
  const usage = operation === DEMO_TOOL_READ ? grant.readUses : grant.writeUses;
  const decision = evaluateCapability(capability, capabilityRequest(grant, operation), usage, Date.now());
  if (!decision.allowed) throw new Error(`The scoped grant denied this operation: ${decision.reason}.`);
  if (consume) {
    if (operation === DEMO_TOOL_READ) grant.readUses += 1;
    else grant.writeUses += 1;
  }
  return grant;
}

function capabilityRequest(grant: DemoGrantRecord, operation: typeof DEMO_TOOL_READ | typeof DEMO_TOOL_WRITE) {
  return {
    subject: `document:${grant.documentId}`,
    originatingApplication: grant.origin,
    workspaceId: 'extension-vault',
    operation,
    sourceIds: [DEMO_RECORD_ID],
    toolVersion: DEMO_INTEGRATION_VERSION,
    parameterFingerprint: grant.parameterFingerprint,
    recipient: `integration:${DEMO_INTEGRATION_ID}`,
  };
}

function sessionForPage(tabId: number, url: string): SessionRecord | undefined {
  const session = brokerState.sessions.get(tabId);
  if (!session) return undefined;
  let identity: string | undefined;
  try {
    identity = canonicalDemoPageIdentity(url);
  } catch {
    identity = undefined;
  }
  if (!identity || identity !== session.pageIdentity || Date.now() >= session.expiresAt) {
    brokerState.sessions.delete(tabId);
    void persistState();
    return undefined;
  }
  return session;
}

async function validatedSessionForDocument(tabId: number, url: string): Promise<SessionRecord | undefined> {
  const session = sessionForPage(tabId, url);
  if (!session?.recording) return session;
  try {
    await ensureContent(tabId);
    const response = await chrome.tabs.sendMessage(tabId, createMessage('content.ping'), { documentId: session.documentId });
    if (isContentResponse(response) && response.data?.recording === true && response.data.sessionId === session.id) return session;
  } catch {
    // A replaced or unreachable document cannot retain a recording authority.
  }
  brokerState.sessions.delete(tabId);
  await persistState();
  return undefined;
}

function activeGrantForTab(tabId: number, url: string): DemoGrantRecord | undefined {
  let pageIdentity: string;
  try {
    pageIdentity = canonicalDemoPageIdentity(url);
  } catch {
    return undefined;
  }
  return [...brokerState.grants.values()].find((grant) => (
    !grant.revoked
    && Date.now() < grant.expiresAt
    && grant.tabId === tabId
    && grant.pageIdentity === pageIdentity
  ));
}

function grantSummary(grant: DemoGrantRecord): Record<string, unknown> {
  return {
    id: grant.id,
    active: !grant.revoked && Date.now() < grant.expiresAt,
    origin: grant.origin,
    pageIdentity: grant.pageIdentity,
    documentId: grant.documentId,
    integrationId: DEMO_INTEGRATION_ID,
    integrationVersion: DEMO_INTEGRATION_VERSION,
    recordId: DEMO_RECORD_ID,
    operations: [DEMO_TOOL_READ, DEMO_TOOL_WRITE],
    statuses: [...DEMO_STATUSES],
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    readUses: grant.readUses,
    writeUses: grant.writeUses,
    parameterFingerprint: grant.parameterFingerprint,
  };
}

function actionPreview(action: PendingAction): Record<string, unknown> {
  return {
    approvalHandle: action.approvalHandle,
    kind: action.kind,
    origin: action.origin,
    pageIdentity: action.pageIdentity,
    documentId: action.documentId,
    integrationId: DEMO_INTEGRATION_ID,
    integrationVersion: DEMO_INTEGRATION_VERSION,
    parameters: action.parameters as unknown as Record<string, unknown>,
    effect: 'local-write',
    reversible: true,
    expiresAt: action.expiresAt,
    policyVersion: POLICY_VERSION,
    ...(action.planFingerprint ? { planFingerprint: action.planFingerprint } : {}),
  };
}

function publicRun(run: BrokerRunRecord): Record<string, unknown> {
  return {
    id: run.id,
    actionKind: run.actionKind,
    from: run.from,
    to: run.to,
    state: run.state,
    postcondition: run.postcondition,
    undoAvailable: run.actionKind !== 'undo'
      && run.state === 'succeeded'
      && run.postcondition
      && run.tabId !== undefined
      && run.documentId !== undefined,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
    ...(run.errorCode ? { errorCode: run.errorCode } : {}),
  };
}

function publicCompiledWorkflow(compiled: CompiledDemoWorkflow): Record<string, unknown> {
  return {
    recordingId: compiled.recordingId,
    planFingerprint: compiled.planFingerprint,
    assumptions: [...compiled.assumptions],
    variables: compiled.variables as unknown as Record<string, unknown>[],
  };
}

async function revokeGrantRecord(grant: DemoGrantRecord): Promise<void> {
  grant.revoked = true;
  for (const [handle, pending] of pendingActions) {
    if (pending.grantId === grant.id) {
      approvalStore.revoke(handle);
      pendingActions.delete(handle);
    }
  }
  await persistState();
}

async function invalidateTab(tabId: number, reason: string): Promise<void> {
  const session = brokerState.sessions.get(tabId);
  if (session) {
    session.recording = false;
    brokerState.sessions.delete(tabId);
  }
  for (const grant of brokerState.grants.values()) {
    if (grant.tabId === tabId) grant.revoked = true;
  }
  for (const [reviewId, review] of pendingGrantReviews) {
    if (review.inspection.tabId === tabId) pendingGrantReviews.delete(reviewId);
  }
  for (const [bindingId, binding] of pendingBindings) {
    if (binding.tabId === tabId) pendingBindings.delete(bindingId);
  }
  for (const [handle, action] of pendingActions) {
    if (action.tabId === tabId) {
      approvalStore.revoke(handle);
      pendingActions.delete(handle);
    }
  }
  for (const run of brokerState.runs.values()) {
    if (run.tabId === tabId && run.state === 'executing') {
      run.state = 'outcome-unknown';
      run.errorCode = reason;
      run.updatedAt = Date.now();
    }
  }
  await persistState();
  await persistLatestDurableRun();
}

async function invalidateAllAuthority(reason: string): Promise<void> {
  brokerState.sessions.clear();
  brokerState.recordings.clear();
  for (const grant of brokerState.grants.values()) grant.revoked = true;
  pendingBindings.clear();
  pendingGrantReviews.clear();
  for (const handle of pendingActions.keys()) approvalStore.revoke(handle);
  pendingActions.clear();
  for (const run of brokerState.runs.values()) {
    if (run.state === 'executing') {
      run.state = 'outcome-unknown';
      run.errorCode = reason;
      run.updatedAt = Date.now();
    }
  }
  await persistState();
  await persistLatestDurableRun();
}

async function purgeExpiredState(): Promise<void> {
  const now = Date.now();
  let changed = false;
  for (const [tabId, session] of brokerState.sessions) {
    if (now >= session.expiresAt) {
      brokerState.sessions.delete(tabId);
      changed = true;
    }
  }
  for (const [grantId, grant] of brokerState.grants) {
    if (grant.revoked || now >= grant.expiresAt) {
      brokerState.grants.delete(grantId);
      changed = true;
    }
  }
  for (const [recordingId, recording] of brokerState.recordings) {
    if (now >= recording.expiresAt) {
      brokerState.recordings.delete(recordingId);
      changed = true;
    }
  }
  for (const [reviewId, review] of pendingGrantReviews) {
    if (now >= review.reviewExpiresAt || now >= review.grantExpiresAt) pendingGrantReviews.delete(reviewId);
  }
  for (const [bindingId, binding] of pendingBindings) {
    if (now >= binding.expiresAt) pendingBindings.delete(bindingId);
  }
  for (const [handle, action] of pendingActions) {
    if (now >= action.expiresAt) {
      pendingActions.delete(handle);
      approvalStore.revoke(handle);
    }
  }
  approvalStore.purgeExpired(now);
  if (changed) await persistState();
}

async function restoreState(): Promise<void> {
  try {
    const [sessionValues, durableValues] = await Promise.all([
      chrome.storage.session.get(BROKER_SESSION_KEY),
      chrome.storage.local.get(BROKER_DURABLE_RUN_KEY),
    ]);
    brokerState = parseStoredState(sessionValues[BROKER_SESSION_KEY]);
    const durable = parseDurableRun(durableValues[BROKER_DURABLE_RUN_KEY]);
    let changed = false;
    for (const run of brokerState.runs.values()) {
      if (run.state === 'executing') {
        run.state = 'outcome-unknown';
        run.errorCode = 'SERVICE_WORKER_RESTORED_DURING_WRITE';
        run.updatedAt = Date.now();
        changed = true;
      }
    }
    if (durable && !brokerState.runs.has(durable.id)) {
      brokerState.runs.set(durable.id, durable.state === 'executing'
        ? {
            ...durable,
            state: 'outcome-unknown',
            postcondition: false,
            updatedAt: Date.now(),
            errorCode: 'BROWSER_RESTARTED_DURING_WRITE',
          }
        : durable);
      changed = durable.state === 'executing';
    }
    await purgeExpiredState();
    if (changed) {
      await persistState();
      await persistLatestDurableRun();
    }
  } catch {
    brokerState = emptyState();
    await chrome.storage.session.remove(BROKER_SESSION_KEY).catch(() => undefined);
  }
}

function parseStoredState(value: unknown): BrokerState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return emptyState();
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || !Array.isArray(record.sessions) || !Array.isArray(record.grants) || !Array.isArray(record.recordings) || !Array.isArray(record.runs)) {
    return emptyState();
  }
  const state = emptyState();
  try {
    for (const raw of record.sessions.slice(0, 32)) {
      const session = parseStoredSession(raw);
      state.sessions.set(session.tabId, session);
    }
    for (const raw of record.grants.slice(0, 32)) {
      const grant = parseStoredGrant(raw);
      state.grants.set(grant.id, grant);
    }
    for (const raw of record.recordings.slice(0, 32)) {
      const recording = parseStoredRecording(raw);
      state.recordings.set(recording.id, recording);
    }
    for (const raw of record.runs.slice(0, MAX_PERSISTED_RUNS)) {
      const run = parseStoredRun(raw);
      state.runs.set(run.id, run);
    }
    return state;
  } catch {
    return emptyState();
  }
}

function parseStoredSession(value: unknown): SessionRecord {
  const record = objectValue(value, 'Stored session');
  if (!hasExactKeys(record, ['id', 'tabId', 'pageIdentity', 'bindingToken', 'documentId', 'createdAt', 'expiresAt', 'recording', 'events'])) throw new Error('Stored session shape is invalid.');
  if (!Array.isArray(record.events) || record.events.length > MAX_RECORDING_EVENTS) throw new Error('Stored recording events are invalid.');
  return {
    id: requiredString(record.id, 'Session ID', 128),
    tabId: nonnegativeInteger(record.tabId, 'Session tab'),
    pageIdentity: canonicalDemoPageIdentity(requiredString(record.pageIdentity, 'Session page', 2_048)),
    bindingToken: requiredString(record.bindingToken, 'Session token', 128),
    documentId: requiredString(record.documentId, 'Session document', 256),
    createdAt: nonnegativeInteger(record.createdAt, 'Session creation time'),
    expiresAt: nonnegativeInteger(record.expiresAt, 'Session expiry'),
    recording: record.recording === true,
    events: record.events.map(parseRecordedDemoEvent),
  };
}

function parseStoredGrant(value: unknown): DemoGrantRecord {
  const record = objectValue(value, 'Stored grant');
  if (!hasExactKeys(record, ['id', 'tabId', 'origin', 'pageIdentity', 'documentId', 'issuedAt', 'expiresAt', 'parameterFingerprint', 'readCapability', 'writeCapability', 'readUses', 'writeUses', 'revoked'])) throw new Error('Stored grant shape is invalid.');
  const grant: DemoGrantRecord = {
    id: requiredString(record.id, 'Grant ID', 128),
    tabId: nonnegativeInteger(record.tabId, 'Grant tab'),
    origin: canonicalDemoOrigin(requiredString(record.origin, 'Grant origin', 2_048)),
    pageIdentity: canonicalDemoPageIdentity(requiredString(record.pageIdentity, 'Grant page', 2_048)),
    documentId: requiredString(record.documentId, 'Grant document', 256),
    issuedAt: nonnegativeInteger(record.issuedAt, 'Grant issue time'),
    expiresAt: nonnegativeInteger(record.expiresAt, 'Grant expiry'),
    parameterFingerprint: requiredString(record.parameterFingerprint, 'Grant parameter fingerprint', 80),
    readCapability: record.readCapability as CapabilityGrant,
    writeCapability: record.writeCapability as CapabilityGrant,
    readUses: nonnegativeInteger(record.readUses, 'Grant read usage'),
    writeUses: nonnegativeInteger(record.writeUses, 'Grant write usage'),
    revoked: record.revoked === true,
  };
  // Parsing through evaluateCapability validates the versioned grant schema.
  const readDecision = evaluateCapability(grant.readCapability, capabilityRequest(grant, DEMO_TOOL_READ), 0, grant.issuedAt);
  const writeDecision = evaluateCapability(grant.writeCapability, capabilityRequest(grant, DEMO_TOOL_WRITE), 0, grant.issuedAt);
  if (!readDecision.allowed || !writeDecision.allowed) throw new Error('Stored capability grant is invalid.');
  return grant;
}

function parseStoredRecording(value: unknown): CompletedDemoRecording {
  const record = objectValue(value, 'Stored recording');
  if (!hasExactKeys(record, ['id', 'origin', 'sourceDocumentId', 'createdAt', 'expiresAt', 'events'])) throw new Error('Stored recording shape is invalid.');
  if (!Array.isArray(record.events) || record.events.length < 1 || record.events.length > MAX_RECORDING_EVENTS) throw new Error('Stored recording events are invalid.');
  return Object.freeze({
    id: requiredString(record.id, 'Recording ID', 128),
    origin: canonicalDemoOrigin(requiredString(record.origin, 'Recording origin', 2_048)),
    sourceDocumentId: requiredString(record.sourceDocumentId, 'Recording document', 256),
    createdAt: nonnegativeInteger(record.createdAt, 'Recording creation time'),
    expiresAt: nonnegativeInteger(record.expiresAt, 'Recording expiry'),
    events: Object.freeze(record.events.map(parseRecordedDemoEvent)),
  });
}

function parseStoredRun(value: unknown): BrokerRunRecord {
  const record = objectValue(value, 'Stored run');
  const allowed = new Set(['id', 'actionKind', 'grantId', 'tabId', 'documentId', 'from', 'to', 'createdAt', 'updatedAt', 'state', 'postcondition', 'parentRunId', 'errorCode']);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error('Stored run shape is invalid.');
  if (!['write', 'undo', 'replay'].includes(String(record.actionKind)) || !['executing', 'succeeded', 'failed', 'outcome-unknown', 'undone'].includes(String(record.state)) || !isDemoStatus(record.from) || !isDemoStatus(record.to)) {
    throw new Error('Stored run values are invalid.');
  }
  const grantId = optionalString(record.grantId, 'Run grant', 128);
  const documentId = optionalString(record.documentId, 'Run document', 256);
  const parentRunId = optionalString(record.parentRunId, 'Parent run', 128);
  const errorCode = optionalString(record.errorCode, 'Run error code', 128);
  return {
    id: requiredString(record.id, 'Run ID', 128),
    actionKind: record.actionKind as BrokerActionKind,
    ...(grantId ? { grantId } : {}),
    ...(record.tabId === undefined ? {} : { tabId: nonnegativeInteger(record.tabId, 'Run tab') }),
    ...(documentId ? { documentId } : {}),
    from: record.from,
    to: record.to,
    createdAt: nonnegativeInteger(record.createdAt, 'Run creation time'),
    updatedAt: nonnegativeInteger(record.updatedAt, 'Run update time'),
    state: record.state as BrokerRunState,
    postcondition: record.postcondition === true,
    ...(parentRunId ? { parentRunId } : {}),
    ...(errorCode ? { errorCode } : {}),
  };
}

function parseDurableRun(value: unknown): BrokerRunRecord | undefined {
  if (value === undefined) return undefined;
  try {
    return parseStoredRun(value);
  } catch {
    return undefined;
  }
}

function serializeState(): Record<string, unknown> {
  const now = Date.now();
  return {
    schemaVersion: 1,
    sessions: [...brokerState.sessions.values()],
    grants: [...brokerState.grants.values()].filter((grant) => !grant.revoked && now < grant.expiresAt),
    recordings: [...brokerState.recordings.values()],
    runs: [...brokerState.runs.values()].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, MAX_PERSISTED_RUNS),
  };
}

function persistState(): Promise<void> {
  const snapshot = serializeState();
  persistenceQueue = persistenceQueue.catch(() => undefined).then(async () => {
    await chrome.storage.session.set({ [BROKER_SESSION_KEY]: snapshot });
  });
  return persistenceQueue;
}

async function persistDurableRun(run: BrokerRunRecord): Promise<void> {
  // This record deliberately omits origin, page content, parameters beyond the fixed
  // synthetic status values, and browser document identity.
  const durable: BrokerRunRecord = {
    id: run.id,
    actionKind: run.actionKind,
    from: run.from,
    to: run.to,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    state: run.state,
    postcondition: run.postcondition,
    ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
    ...(run.errorCode ? { errorCode: run.errorCode } : {}),
  };
  await chrome.storage.local.set({ [BROKER_DURABLE_RUN_KEY]: durable });
}

async function persistLatestDurableRun(): Promise<void> {
  const run = [...brokerState.runs.values()].sort((left, right) => right.updatedAt - left.updatedAt)[0];
  if (run) await persistDurableRun(run);
}

function trimRuns(): void {
  const ordered = [...brokerState.runs.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  for (const run of ordered.slice(MAX_PERSISTED_RUNS)) brokerState.runs.delete(run.id);
}

function isContentResponse(value: unknown): value is { ok: boolean; data?: Record<string, unknown> } {
  if (typeof value !== 'object' || value === null || (value as Record<string, unknown>).ok !== true) return false;
  const data = (value as Record<string, unknown>).data;
  return data === undefined || (typeof data === 'object' && data !== null && !Array.isArray(data));
}

function isDemoUrl(url: string): boolean {
  try {
    canonicalDemoPageIdentity(url);
    return true;
  } catch {
    return false;
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  const allowed = new Set(expected);
  return keys.length === allowed.size && keys.every((key) => allowed.has(key));
}

function exactStringPayload(payload: Record<string, unknown>, key: string): string | undefined {
  return hasExactKeys(payload, [key]) ? stringValue(payload[key]) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 2_048 ? value : undefined;
}

function requiredString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) throw new Error(`${label} is invalid.`);
  return value;
}

function optionalString(value: unknown, label: string, maximum: number): string | undefined {
  return value === undefined ? undefined : requiredString(value, label, maximum);
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} is invalid.`);
  return value as number;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} has an unsupported prototype.`);
  return value as Record<string, unknown>;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message.slice(0, 512) : fallback;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('The reviewed action timed out.')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
