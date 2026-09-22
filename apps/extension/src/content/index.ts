(() => {
const MESSAGE_SCHEMA_VERSION = 1 as const;
const DEMO_INTEGRATION_ID = 'northline-demo-v1';
const DEMO_INTEGRATION_VERSION = '1.0.0';
const DEMO_RECORD_ID = 'PO-DEMO-1001';
const DEMO_STATUSES = ['Needs review', 'Approved', 'On hold'] as const;
const DEMO_STATUS_SET = new Set<string>(DEMO_STATUSES);
const MESSAGE_TYPES = new Set([
  'content.ping',
  'content.capture-selection',
  'content.capture-visible',
  'content.recording-start',
  'content.recording-stop',
  'content.integration-inspect',
  'content.integration-write',
]);

interface ContentEnvelope {
  schemaVersion: typeof MESSAGE_SCHEMA_VERSION;
  requestId: string;
  type: string;
  sessionId?: string;
  payload: Record<string, unknown>;
}

interface ActiveSession {
  id: string;
  startedAt: number;
  eventCount: number;
  maxEvents: number;
  maxDurationMs: number;
}

interface ActiveIntegrationBinding {
  id: string;
  token: string;
  pageIdentity: string;
  expiresAt: number;
}

interface DemoRecordSnapshot {
  reference: string;
  supplier: string;
  quantity: number;
  unitPriceMinor: number;
  currency: string;
  requestedDelivery: string;
  invoice?: string;
}

interface DemoPageSnapshot {
  integrationId: typeof DEMO_INTEGRATION_ID;
  integrationVersion: typeof DEMO_INTEGRATION_VERSION;
  pageIdentity: string;
  recordId: typeof DEMO_RECORD_ID;
  currentStatus: (typeof DEMO_STATUSES)[number];
  availableStatuses: (typeof DEMO_STATUSES)[number][];
  purchaseOrder: DemoRecordSnapshot;
  invoice: DemoRecordSnapshot;
  declarations: Array<{
    name: string;
    version: string;
    effect: 'read' | 'local-write';
    implementationId: string;
  }>;
}

let activeSession: ActiveSession | undefined;
let activeIntegrationBinding: ActiveIntegrationBinding | undefined;
let recordingListenerInstalled = false;

chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
  if (!isContentEnvelope(raw)) {
    sendResponse({ ok: false });
    return;
  }
  void handle(raw).then(sendResponse).catch(() => sendResponse({ ok: false }));
  return true;
});

function createMessage(type: string, payload: Record<string, unknown>, sessionId: string): ContentEnvelope {
  return { schemaVersion: MESSAGE_SCHEMA_VERSION, requestId: crypto.randomUUID(), type, payload, sessionId };
}

function isContentEnvelope(value: unknown): value is ContentEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => !['schemaVersion', 'requestId', 'type', 'sessionId', 'payload'].includes(key))) return false;
  let payloadLength = Number.POSITIVE_INFINITY;
  try {
    payloadLength = JSON.stringify(record.payload).length;
  } catch {
    return false;
  }
  return record.schemaVersion === MESSAGE_SCHEMA_VERSION
    && typeof record.requestId === 'string'
    && record.requestId.length > 0
    && record.requestId.length <= 128
    && typeof record.type === 'string'
    && MESSAGE_TYPES.has(record.type)
    && (record.sessionId === undefined || (typeof record.sessionId === 'string' && record.sessionId.length <= 128))
    && typeof record.payload === 'object'
    && record.payload !== null
    && !Array.isArray(record.payload)
    && payloadLength <= 64 * 1024;
}

async function handle(message: ContentEnvelope): Promise<{ ok: boolean; data?: Record<string, unknown> }> {
  switch (message.type) {
    case 'content.ping':
      if (!hasExactKeys(message.payload, [])) return { ok: false };
      return {
        ok: true,
        data: {
          documentUrl: location.href,
          recording: recordingActive(),
          sessionId: activeSession?.id,
          integrationAvailable: isExactDemoDocument(),
        },
      };
    case 'content.capture-selection':
      if (!hasExactKeys(message.payload, [])) return { ok: false };
      return { ok: true, data: captureSelection() };
    case 'content.capture-visible':
      if (!hasExactKeys(message.payload, [])) return { ok: false };
      return { ok: true, data: captureVisibleContent() };
    case 'content.recording-start':
      return startRecording(message);
    case 'content.recording-stop':
      if (!hasExactKeys(message.payload, [])) return { ok: false };
      stopRecording();
      return { ok: true, data: { recording: false } };
    case 'content.integration-inspect':
      return inspectDemoIntegration(message);
    case 'content.integration-write':
      return executeDemoStatusWrite(message);
    default:
      return { ok: false };
  }
}

function recordingActive(): boolean {
  const session = activeSession;
  if (!session) return false;
  if (Date.now() - session.startedAt > session.maxDurationMs || session.eventCount >= session.maxEvents) {
    stopRecording();
    return false;
  }
  return true;
}

function captureSelection(): Record<string, unknown> {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return { text: '', characters: 0, source: 'selection', warning: 'No text is selected.' };
  }
  const range = selection.getRangeAt(0);
  const container = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
    ? range.commonAncestorContainer as Element
    : range.commonAncestorContainer.parentElement;
  const cloned = range.cloneContents();
  if (
    !container
    || isSensitive(container)
    || cloned.querySelector('input,textarea,select,[contenteditable="true"],[data-browser-cortex-private],[hidden],[aria-hidden="true"]')
  ) {
    return { text: '', characters: 0, source: 'selection', warning: 'Selection contains a sensitive, hidden, or editable field.' };
  }
  const selected = selection.toString();
  const text = normalize(selected).slice(0, 16_000);
  return {
    text,
    characters: text.length,
    source: 'selection',
    truncated: selected.length > text.length,
    title: document.title,
    url: sanitizedUrl(),
  };
}

function captureVisibleContent(): Record<string, unknown> {
  const root = document.querySelector('main, article, [role="main"]') ?? document.body;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || isSensitive(parent) || !isVisible(parent)) return NodeFilter.FILTER_REJECT;
      const text = node.textContent?.trim();
      return text ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const parts: string[] = [];
  let length = 0;
  let current = walker.nextNode();
  while (current && length < 16_000) {
    const text = normalize(current.textContent ?? '');
    if (text) {
      parts.push(text);
      length += text.length + 1;
    }
    current = walker.nextNode();
  }
  const fullText = parts.join('\n');
  const joined = fullText.slice(0, 16_000);
  return {
    text: joined,
    characters: joined.length,
    source: 'visible-content',
    truncated: current !== null || fullText.length > joined.length,
    title: document.title,
    url: sanitizedUrl(),
  };
}

function isSensitive(element: Element): boolean {
  const blocked = element.closest('script,style,noscript,[hidden],[aria-hidden="true"],input,textarea,select,[contenteditable="true"],[data-browser-cortex-private]');
  if (blocked) return true;
  const field = element.closest('form');
  if (!field) return false;
  const context = `${field.getAttribute('aria-label') ?? ''} ${field.getAttribute('name') ?? ''} ${field.id}`.toLowerCase();
  return /(password|passcode|one.?time|card|cvv|secret|token|credential)/u.test(context);
}

function isVisible(element: Element): boolean {
  if (element.getClientRects().length === 0) return false;
  for (let current: Element | null = element; current; current = current.parentElement) {
    const style = getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden' || Number.parseFloat(style.opacity) === 0) return false;
  }
  return true;
}

function sanitizedUrl(): string {
  const url = new URL(location.href);
  return `${url.origin}${url.pathname}`;
}

function normalize(value: string): string {
  return value.replace(/[\t ]+/gu, ' ').replace(/\n{3,}/gu, '\n\n').trim();
}

async function startRecording(message: ContentEnvelope): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  if (
    !hasExactKeys(message.payload, ['maxEvents', 'maxDurationMs', 'integrationId', 'bindingToken'])
    || !isExactDemoDocument()
    || !message.sessionId
    || message.payload.integrationId !== DEMO_INTEGRATION_ID
    || typeof message.payload.bindingToken !== 'string'
  ) {
    return { ok: false, data: { recording: false } };
  }
  const candidate: ActiveSession = {
    id: message.sessionId,
    startedAt: Date.now(),
    eventCount: 0,
    maxEvents: numberInRange(message.payload.maxEvents, 1, 200, 200),
    maxDurationMs: numberInRange(message.payload.maxDurationMs, 1_000, 300_000, 300_000),
  };
  const binding = await chrome.runtime.sendMessage(createMessage('content.recording-bind', {
    integrationId: DEMO_INTEGRATION_ID,
    bindingToken: message.payload.bindingToken,
  }, candidate.id));
  if (!brokerAccepted(binding)) return { ok: false, data: { recording: false } };
  activeSession = candidate;
  if (!recordingListenerInstalled) {
    document.addEventListener('click', onTrustedDemoClick, true);
    recordingListenerInstalled = true;
  }
  setIndicator(true);
  return { ok: true, data: { recording: true, bound: true } };
}

function stopRecording(): void {
  activeSession = undefined;
  setIndicator(false);
}

function onTrustedDemoClick(event: MouseEvent): void {
  const session = activeSession;
  if (!session || !event.isTrusted || !isExactDemoDocument()) return;
  if (Date.now() - session.startedAt > session.maxDurationMs || session.eventCount >= session.maxEvents) {
    stopRecording();
    return;
  }
  const target = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>('[data-bc-demo-status-target]')
    : null;
  if (!target || !isVisible(target)) return;
  const to = target.dataset.bcDemoStatusTarget ?? '';
  const selected = document.querySelector<HTMLButtonElement>('[data-bc-demo-status-target][aria-pressed="true"]');
  const from = selected?.dataset.bcDemoStatusTarget ?? '';
  if (!DEMO_STATUS_SET.has(from) || !DEMO_STATUS_SET.has(to) || from === to) return;
  session.eventCount += 1;
  const brokerMessage = createMessage('content.recording-event', {
    operation: 'demo.ticket.status.set',
    recordId: DEMO_RECORD_ID,
    field: 'status',
    from,
    to,
    integrationVersion: DEMO_INTEGRATION_VERSION,
  }, session.id);
  void chrome.runtime.sendMessage(brokerMessage).then((response) => {
    if (!brokerAccepted(response)) stopRecording();
  }).catch(() => stopRecording());
}

async function inspectDemoIntegration(message: ContentEnvelope): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  if (
    !hasExactKeys(message.payload, ['integrationId', 'bindingToken'])
    || !message.sessionId
    || message.payload.integrationId !== DEMO_INTEGRATION_ID
    || typeof message.payload.bindingToken !== 'string'
  ) {
    return { ok: false, data: { contractValid: false } };
  }
  const sessionId = message.sessionId;
  const bindingToken = message.payload.bindingToken;
  const binding = await chrome.runtime.sendMessage(createMessage('content.integration-bind', {
    integrationId: DEMO_INTEGRATION_ID,
    bindingToken,
  }, sessionId));
  if (!brokerAccepted(binding)) return { ok: false, data: { contractValid: false } };
  try {
    const snapshot = readDemoSnapshot();
    activeIntegrationBinding = {
      id: sessionId,
      token: bindingToken,
      pageIdentity: snapshot.pageIdentity,
      expiresAt: Date.now() + 10_000,
    };
    return { ok: true, data: { contractValid: true, snapshot: snapshot as unknown as Record<string, unknown> } };
  } catch (error) {
    activeIntegrationBinding = undefined;
    return {
      ok: true,
      data: {
        contractValid: false,
        reason: error instanceof Error ? error.message.slice(0, 256) : 'The demo page contract did not match.',
      },
    };
  }
}

async function executeDemoStatusWrite(message: ContentEnvelope): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const allowedKeys = new Set([
    'actionId',
    'executionToken',
    'integrationId',
    'integrationVersion',
    'recordId',
    'field',
    'from',
    'to',
  ]);
  if (
    Object.keys(message.payload).some((key) => !allowedKeys.has(key))
    || !message.sessionId
    || typeof message.payload.actionId !== 'string'
    || typeof message.payload.executionToken !== 'string'
    || message.payload.integrationId !== DEMO_INTEGRATION_ID
    || message.payload.integrationVersion !== DEMO_INTEGRATION_VERSION
    || message.payload.recordId !== DEMO_RECORD_ID
    || message.payload.field !== 'status'
    || !DEMO_STATUS_SET.has(String(message.payload.from))
    || !DEMO_STATUS_SET.has(String(message.payload.to))
    || message.payload.from === message.payload.to
  ) {
    return { ok: false, data: { postcondition: false } };
  }
  let snapshot: DemoPageSnapshot;
  try {
    snapshot = readDemoSnapshot();
  } catch {
    return { ok: false, data: { postcondition: false, reason: 'integration-drift' } };
  }
  if (snapshot.currentStatus !== message.payload.from) {
    return { ok: false, data: { postcondition: false, reason: 'current-state-drift', currentStatus: snapshot.currentStatus } };
  }
  const targetStatus = String(message.payload.to);
  const targets = [...document.querySelectorAll<HTMLButtonElement>('[data-bc-demo-status-target]')]
    .filter((candidate) => candidate.dataset.bcDemoStatusTarget === targetStatus && isVisible(candidate));
  if (targets.length !== 1) {
    return { ok: false, data: { postcondition: false, reason: 'ambiguous-target', targetCount: targets.length } };
  }
  const binding = activeIntegrationBinding;
  if (
    !binding
    || Date.now() >= binding.expiresAt
    || binding.id !== message.sessionId
    || binding.token !== message.payload.executionToken
    || binding.pageIdentity !== snapshot.pageIdentity
  ) {
    return { ok: false, data: { postcondition: false, reason: 'execution-binding-denied' } };
  }
  activeIntegrationBinding = undefined;
  targets[0]?.click();
  const confirmed = await waitForStatus(targetStatus, 1_500);
  if (!confirmed) {
    return { ok: false, data: { postcondition: false, reason: 'postcondition-failed' } };
  }
  return {
    ok: true,
    data: {
      postcondition: true,
      actionId: message.payload.actionId,
      recordId: DEMO_RECORD_ID,
      previousStatus: message.payload.from,
      currentStatus: targetStatus,
    },
  };
}

function readDemoSnapshot(): DemoPageSnapshot {
  if (!isExactDemoDocument()) throw new Error('The page identity or integration marker changed.');
  const purchaseOrder = readRecord('purchase-order', false);
  const invoice = readRecord('invoice', true);
  const statusElements = document.querySelectorAll<HTMLElement>('[data-bc-demo-current-status]');
  if (statusElements.length !== 1 || !isVisible(statusElements[0] as HTMLElement)) {
    throw new Error('The current status target is missing or ambiguous.');
  }
  const currentStatus = statusElements[0]?.dataset.bcDemoCurrentStatus ?? '';
  if (!DEMO_STATUS_SET.has(currentStatus)) throw new Error('The current status is outside the reviewed contract.');
  const targetElements = [...document.querySelectorAll<HTMLButtonElement>('[data-bc-demo-status-target]')]
    .filter(isVisible);
  const availableStatuses = targetElements.map((target) => target.dataset.bcDemoStatusTarget ?? '');
  if (
    availableStatuses.length !== DEMO_STATUSES.length
    || new Set(availableStatuses).size !== DEMO_STATUSES.length
    || !DEMO_STATUSES.every((status) => availableStatuses.includes(status))
  ) {
    throw new Error('The visible status targets are missing, duplicated, or unsupported.');
  }
  const declarations: DemoPageSnapshot['declarations'] = [...document.querySelectorAll<HTMLElement>('[data-bc-demo-tool-name]')].map((element) => {
    const effect = element.dataset.bcDemoToolEffect;
    if (effect !== 'read' && effect !== 'local-write') throw new Error('A page tool declaration claims an unsupported effect.');
    return {
      name: requiredDataset(element, 'bcDemoToolName'),
      version: requiredDataset(element, 'bcDemoToolVersion'),
      effect,
      implementationId: requiredDataset(element, 'bcDemoToolImplementation'),
    };
  });
  const expected = [
    ['demo.records.read', DEMO_INTEGRATION_VERSION, 'read', 'northline-demo-record-reader'],
    ['demo.ticket.status.set', DEMO_INTEGRATION_VERSION, 'local-write', 'northline-demo-ticket-status'],
  ];
  if (
    declarations.length !== expected.length
    || !expected.every(([name, version, effect, implementationId]) => declarations.some((declaration) => (
      declaration.name === name
      && declaration.version === version
      && declaration.effect === effect
      && declaration.implementationId === implementationId
    )))
  ) {
    throw new Error('Page tool declarations do not match the packaged integration.');
  }
  return {
    integrationId: DEMO_INTEGRATION_ID,
    integrationVersion: DEMO_INTEGRATION_VERSION,
    pageIdentity: sanitizedUrl(),
    recordId: DEMO_RECORD_ID,
    currentStatus: currentStatus as DemoPageSnapshot['currentStatus'],
    availableStatuses: availableStatuses as DemoPageSnapshot['availableStatuses'],
    purchaseOrder,
    invoice,
    declarations,
  };
}

function readRecord(type: 'purchase-order' | 'invoice', requireInvoice: boolean): DemoRecordSnapshot {
  const records = document.querySelectorAll<HTMLElement>(`[data-bc-demo-record="${type}"]`);
  if (records.length !== 1 || !isVisible(records[0] as HTMLElement)) {
    throw new Error(`The ${type} record is missing or ambiguous.`);
  }
  const record = records[0] as HTMLElement;
  const value = (field: string): string => {
    const fields = record.querySelectorAll<HTMLElement>(`[data-bc-demo-field="${field}"]`);
    if (fields.length !== 1) throw new Error(`The ${type} ${field} field is missing or ambiguous.`);
    return requiredDataset(fields[0] as HTMLElement, 'bcDemoValue');
  };
  const reference = value('reference');
  if (reference !== DEMO_RECORD_ID) throw new Error(`The ${type} record identity changed.`);
  const result: DemoRecordSnapshot = {
    reference,
    supplier: value('supplier'),
    quantity: positiveInteger(value('quantity'), `${type} quantity`),
    unitPriceMinor: nonnegativeInteger(value('unitPriceMinor'), `${type} unit price`),
    currency: value('currency'),
    requestedDelivery: value('requestedDelivery'),
    ...(requireInvoice ? { invoice: value('invoice') } : {}),
  };
  if (
    result.supplier.length > 256
    || !/^[A-Z]{3}$/u.test(result.currency)
    || !/^\d{4}-\d{2}-\d{2}$/u.test(result.requestedDelivery)
    || (requireInvoice && (!result.invoice || result.invoice.length > 128))
  ) {
    throw new Error(`The ${type} record contains unsupported values.`);
  }
  return result;
}

function requiredDataset(element: HTMLElement, key: string): string {
  const value = element.dataset[key];
  if (!value || value.length > 512) throw new Error('The demo integration marker is missing or too long.');
  return value;
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} is invalid.`);
  return parsed;
}

function nonnegativeInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is invalid.`);
  return parsed;
}

async function waitForStatus(expected: string, maximumMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maximumMs) {
    const statuses = document.querySelectorAll<HTMLElement>('[data-bc-demo-current-status]');
    if (statuses.length === 1 && statuses[0]?.dataset.bcDemoCurrentStatus === expected) return true;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 20));
  }
  return false;
}

function brokerAccepted(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as Record<string, unknown>).ok === true;
}

function setIndicator(active: boolean): void {
  document.getElementById('browser-cortex-recording-indicator')?.remove();
  if (!active) return;
  const indicator = document.createElement('div');
  indicator.id = 'browser-cortex-recording-indicator';
  indicator.dataset.browserCortexPrivate = 'true';
  indicator.setAttribute('role', 'status');
  indicator.textContent = 'BrowserCortex recording reviewed actions on this demo page';
  Object.assign(indicator.style, {
    position: 'fixed',
    left: '50%',
    bottom: '18px',
    transform: 'translateX(-50%)',
    zIndex: '2147483647',
    padding: '9px 14px',
    borderRadius: '999px',
    background: '#8a332f',
    color: '#fff',
    font: '600 12px system-ui,sans-serif',
    boxShadow: '0 8px 30px rgba(0,0,0,.22)',
  });
  document.documentElement.append(indicator);
}

function isExactDemoDocument(): boolean {
  const url = new URL(location.href);
  const exactUrl = url.protocol === 'http:'
    && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
    && url.port === '4174'
    && !url.search
    && !url.hash
    && (url.pathname === '/' || url.pathname === '/index.html');
  if (!exactUrl || document.title !== 'Northline Demo Desk') return false;
  const shells = document.querySelectorAll<HTMLElement>('[data-bc-demo-integration]');
  return shells.length === 1
    && shells[0]?.dataset.bcDemoIntegration === DEMO_INTEGRATION_ID
    && shells[0]?.dataset.bcDemoVersion === DEMO_INTEGRATION_VERSION;
}

function numberInRange(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const allowed = new Set(expected);
  const keys = Object.keys(value);
  return keys.length === allowed.size && keys.every((key) => allowed.has(key));
}
})();
