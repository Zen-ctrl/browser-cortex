import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Field, Notice } from '@browser-cortex/ui';
import {
  DEMO_STATUSES,
  type CompiledDemoWorkflow,
  type DemoStatus,
} from '../shared/demo-contract';
import { sendBroker } from './broker';
import {
  listExtensionWorkflows,
  onVaultPlaintextInvalidated,
  saveExtensionWorkflow,
  type SavedExtensionWorkflow,
} from './runtime';
import type { TabState } from './types';

interface GrantReview {
  readonly reviewId: string;
  readonly origin: string;
  readonly pageIdentity: string;
  readonly documentId: string;
  readonly integrationId: string;
  readonly integrationVersion: string;
  readonly recordId: string;
  readonly operations: readonly string[];
  readonly statuses: readonly string[];
  readonly reviewExpiresAt: number;
  readonly expiresAt: number;
  readonly parameterFingerprint: string;
}

interface ActionReview {
  readonly approvalHandle: string;
  readonly kind: string;
  readonly origin: string;
  readonly pageIdentity: string;
  readonly documentId: string;
  readonly parameters: Record<string, unknown>;
  readonly expiresAt: number;
  readonly planFingerprint?: string;
}

export function RecordView({ tab, onRefresh }: { tab: TabState; onRefresh: () => Promise<void> }) {
  const [grant, setGrant] = useState<Record<string, unknown> | undefined>(tab.grant);
  const [grantReview, setGrantReview] = useState<GrantReview>();
  const [comparison, setComparison] = useState<Record<string, unknown>>();
  const [targetStatus, setTargetStatus] = useState<DemoStatus>('Approved');
  const [actionReview, setActionReview] = useState<ActionReview>();
  const [lastRun, setLastRun] = useState<Record<string, unknown> | undefined>(tab.lastRun);
  const [events, setEvents] = useState<Array<Record<string, unknown>>>([]);
  const [recordingId, setRecordingId] = useState<string>();
  const [variableName, setVariableName] = useState('targetStatus');
  const [compiled, setCompiled] = useState<CompiledDemoWorkflow>();
  const [savedWorkflows, setSavedWorkflows] = useState<SavedExtensionWorkflow[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState('');
  const [replayStatus, setReplayStatus] = useState<DemoStatus>('Approved');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => setGrant(tab.grant), [tab.grant]);
  useEffect(() => setLastRun(tab.lastRun), [tab.lastRun]);
  useEffect(() => onVaultPlaintextInvalidated(() => {
    setSavedWorkflows([]);
    setSelectedWorkflowId('');
    setActionReview(undefined);
  }), []);

  const selectedWorkflow = useMemo(
    () => savedWorkflows.find((workflow) => workflow.source.id === selectedWorkflowId),
    [savedWorkflows, selectedWorkflowId],
  );

  async function act(task: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await task();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The trusted extension operation failed.');
    } finally {
      setBusy(false);
    }
  }

  async function reviewAccess() {
    await act(async () => {
      const data = await sendBroker('grant.review');
      setGrantReview(parseGrantReview(data));
      setActionReview(undefined);
    });
  }

  async function confirmAccess() {
    if (!grantReview) return;
    await act(async () => {
      const data = await sendBroker('grant.create', { reviewId: grantReview.reviewId });
      const current = objectValue(data.grant, 'Grant response');
      setGrant(current);
      setGrantReview(undefined);
      setNotice('The document-scoped grant is active for this exact tab and document only.');
      await onRefresh();
    });
  }

  async function revokeAccess() {
    const grantId = stringValue(grant?.id);
    if (!grantId) return;
    await act(async () => {
      await sendBroker('grant.revoke', { grantId });
      setGrant(undefined);
      setGrantReview(undefined);
      setActionReview(undefined);
      setComparison(undefined);
      setNotice('The document grant and outstanding action approvals were revoked.');
      await onRefresh();
    });
  }

  async function readAndCompare() {
    const grantId = stringValue(grant?.id);
    if (!grantId) return;
    await act(async () => {
      const data = await sendBroker('demo.read', { grantId });
      setComparison(objectValue(data.comparison, 'Comparison'));
      setNotice('The packaged integration read two synthetic records and ordinary code computed the difference.');
      await onRefresh();
    });
  }

  async function previewWrite() {
    const grantId = stringValue(grant?.id);
    if (!grantId) return;
    await act(async () => {
      const data = await sendBroker('demo.action.preview', { grantId, to: targetStatus });
      setActionReview(parseActionReview(data));
    });
  }

  async function previewUndo() {
    const grantId = stringValue(grant?.id);
    const runId = stringValue(lastRun?.id);
    if (!grantId || !runId) return;
    await act(async () => {
      const data = await sendBroker('demo.action.preview', { grantId, undoRunId: runId });
      setActionReview(parseActionReview(data));
    });
  }

  async function executeReviewedAction() {
    if (!actionReview) return;
    await act(async () => {
      const data = await sendBroker('demo.action.execute', { approvalHandle: actionReview.approvalHandle });
      const run = objectValue(data.run, 'Action receipt');
      setLastRun(run);
      setActionReview(undefined);
      setNotice(run.state === 'succeeded'
        ? `Verified status change: ${String(run.from)} to ${String(run.to)}.`
        : 'The action did not produce a verified success receipt.');
      await onRefresh();
    });
  }

  async function toggleRecording() {
    await act(async () => {
      const data = await sendBroker(tab.recording ? 'recording.stop' : 'recording.start');
      if (tab.recording) {
        const captured = Array.isArray(data.events)
          ? data.events.filter((event): event is Record<string, unknown> => typeof event === 'object' && event !== null && !Array.isArray(event))
          : [];
        setEvents(captured);
        setRecordingId(stringValue(data.recordingId));
        setCompiled(undefined);
        setNotice('Recording stopped. Events remain in short-lived extension session storage until compiled, discarded, or expired.');
      } else {
        setEvents([]);
        setRecordingId(undefined);
        setCompiled(undefined);
        setNotice('Recording is active only on this bound demo document. A persistent in-page indicator is visible.');
      }
      await onRefresh();
    });
  }

  async function discardRecording() {
    await act(async () => {
      await sendBroker('recording.discard', { ...(recordingId ? { recordingId } : {}), active: tab.recording });
      setEvents([]);
      setRecordingId(undefined);
      setCompiled(undefined);
      setNotice('The short-lived recording was discarded.');
      await onRefresh();
    });
  }

  async function compile() {
    if (!recordingId) return;
    await act(async () => {
      const data = await sendBroker('recording.compile', { recordingId, variableName });
      const value = objectValue(data.compiled, 'Compiled workflow') as unknown as CompiledDemoWorkflow;
      setCompiled(value);
      setReplayStatus(value.variables[0].defaultValue);
      setNotice('The semantic recording was normalized into a finite typed workflow. Review variables and assumptions before saving.');
    });
  }

  async function saveCompiled() {
    if (!compiled) return;
    await act(async () => {
      const saved = await saveExtensionWorkflow(compiled);
      await sendBroker('recording.discard', { recordingId: compiled.recordingId });
      setSavedWorkflows((current) => [saved, ...current.filter((item) => item.source.id !== saved.source.id)]);
      setSelectedWorkflowId(saved.source.id);
      setRecordingId(undefined);
      setNotice('The reviewed workflow and normalized recording were saved inside the encrypted extension vault.');
    });
  }

  async function loadSavedWorkflows() {
    await act(async () => {
      const workflows = await listExtensionWorkflows();
      setSavedWorkflows(workflows);
      if (!selectedWorkflowId && workflows[0]) {
        setSelectedWorkflowId(workflows[0].source.id);
        setReplayStatus(workflows[0].compiled.variables[0].defaultValue);
      }
      setNotice(workflows.length === 0 ? 'No reviewed workflows are saved in the unlocked vault.' : `Loaded ${workflows.length} reviewed workflow${workflows.length === 1 ? '' : 's'} from the unlocked vault.`);
    });
  }

  async function previewReplay() {
    const grantId = stringValue(grant?.id);
    if (!grantId || !selectedWorkflow) return;
    await act(async () => {
      const variable = selectedWorkflow.compiled.replay.variableName;
      const data = await sendBroker('workflow.replay.preview', {
        grantId,
        compiled: selectedWorkflow.compiled as unknown as Record<string, unknown>,
        inputs: { [variable]: replayStatus },
      });
      setActionReview(parseActionReview(data));
      setNotice('Replay target validation passed. The write still requires a fresh one-use approval below.');
    });
  }

  const grantActive = grant?.active === true;
  const runSucceeded = lastRun?.undoAvailable === true;
  const lastRunErrorCode = stringValue(lastRun?.errorCode);

  return (
    <div className="ext-stack">
      <section className={`record-card${tab.recording ? ' is-recording' : ''}`}>
        <div className="record-signal"><span /><span /><span /></div>
        <p className="ext-kicker">Bounded demo recording</p>
        <h1>{tab.recording ? 'Recording this demo document' : 'Review, record, and replay one vetted integration'}</h1>
        <p>Only semantic status events from the packaged Northline demo are accepted. Passwords, keystrokes, raw page snapshots, and unrelated tabs are excluded.</p>
        <dl><div><dt>Scope</dt><dd>{tab.demoSite ? 'Exact bundled demo' : 'Unavailable here'}</dd></div><div><dt>Events</dt><dd>{tab.eventCount} of 200</dd></div><div><dt>Time limit</dt><dd>5 minutes</dd></div></dl>
        <div className="ext-actions"><Button disabled={busy || (!tab.demoSite && !tab.recording)} icon={tab.recording ? 'pause' : 'play'} onClick={() => void toggleRecording()} tone={tab.recording ? 'danger' : 'primary'}>{busy ? 'Updating...' : tab.recording ? 'Stop and review' : 'Start demo recording'}</Button>{(tab.recording || recordingId) && <Button disabled={busy} icon="close" onClick={() => void discardRecording()}>Discard</Button>}</div>
      </section>

      <section className="permission-card">
        <div className="section-heading"><div><p className="ext-kicker">Document grant</p><h2>Trusted panel permission</h2></div><Badge tone={grantActive ? 'positive' : grantReview ? 'warning' : 'neutral'}>{grantActive ? 'Active' : grantReview ? 'Awaiting confirmation' : 'Not granted'}</Badge></div>
        {!grantActive && !grantReview && <><p>Review exact origin, browser document identity, tool versions, operations, parameter limits, and the fixed expiry before creating a grant of up to 30 minutes.</p><Button disabled={busy || !tab.demoSite} icon="eye" onClick={() => void reviewAccess()} tone="primary">Review demo access</Button></>}
        {grantReview && <div className="review-box"><dl className="compact-details"><div><dt>Origin</dt><dd>{grantReview.origin}</dd></div><div><dt>Document</dt><dd>{grantReview.documentId}</dd></div><div><dt>Integration</dt><dd>{grantReview.integrationId}@{grantReview.integrationVersion}</dd></div><div><dt>Record</dt><dd>{grantReview.recordId}</dd></div><div><dt>Operations</dt><dd>{grantReview.operations.join(', ')}</dd></div><div><dt>Allowed status values</dt><dd>{grantReview.statuses.join(', ')}</dd></div><div><dt>Confirm by</dt><dd>{new Date(grantReview.reviewExpiresAt).toLocaleTimeString()}</dd></div><div><dt>Grant expires</dt><dd>{new Date(grantReview.expiresAt).toLocaleTimeString()}</dd></div></dl><code className="fingerprint">{grantReview.parameterFingerprint}</code><div className="ext-actions"><Button disabled={busy} icon="key" onClick={() => void confirmAccess()} tone="primary">Confirm scoped grant</Button><Button onClick={() => setGrantReview(undefined)}>Cancel</Button></div></div>}
        {grantActive && <div className="review-box"><dl className="compact-details"><div><dt>Origin</dt><dd>{String(grant?.origin)}</dd></div><div><dt>Document</dt><dd>{String(grant?.documentId)}</dd></div><div><dt>Expires</dt><dd>{new Date(numberValue(grant?.expiresAt) ?? 0).toLocaleTimeString()}</dd></div><div><dt>Uses</dt><dd>{numberValue(grant?.readUses) ?? 0} reads, {numberValue(grant?.writeUses) ?? 0} writes</dd></div></dl><div className="ext-actions"><Button disabled={busy} icon="search" onClick={() => void readAndCompare()}>Read and compare</Button><Button disabled={busy} icon="close" onClick={() => void revokeAccess()} tone="danger">Revoke</Button></div></div>}
      </section>

      {comparison && <section className="comparison-card"><div className="section-heading"><div><p className="ext-kicker">Deterministic result</p><h2>Purchase order vs invoice</h2></div><Badge tone="warning">Evidence backed</Badge></div><div className="comparison-values"><strong>{signed(numberValue(comparison.quantityDifference) ?? 0)}</strong><span>quantity</span><strong>{formatMinor(numberValue(comparison.monetaryDifferenceMinor) ?? 0, stringValue(comparison.currency) ?? 'USD')}</strong><span>value difference</span></div>{Array.isArray(comparison.evidence) && <ul>{comparison.evidence.map((item) => <li key={String(item)}>{String(item)}</li>)}</ul>}</section>}

      {grantActive && <section className="permission-card"><div className="section-heading"><div><p className="ext-kicker">Reversible write</p><h2>Prepare exact status action</h2></div></div><Field label="New synthetic ticket status"><select onChange={(event) => setTargetStatus(event.target.value as DemoStatus)} value={targetStatus}>{DEMO_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}</select></Field><Button disabled={busy} icon="eye" onClick={() => void previewWrite()}>Preview exact write</Button>{runSucceeded && <Button disabled={busy} icon="arrow" onClick={() => void previewUndo()}>Preview verified undo</Button>}</section>}

      {actionReview && <section className="approval-card"><div className="section-heading"><div><p className="ext-kicker">One-use action approval</p><h2>Approve only these exact parameters</h2></div><Badge tone="danger">Local write</Badge></div><dl className="compact-details"><div><dt>Kind</dt><dd>{actionReview.kind}</dd></div><div><dt>Origin</dt><dd>{actionReview.origin}</dd></div><div><dt>Document</dt><dd>{actionReview.documentId}</dd></div>{Object.entries(actionReview.parameters).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}<div><dt>Expires</dt><dd>{new Date(actionReview.expiresAt).toLocaleTimeString()}</dd></div></dl>{actionReview.planFingerprint && <code className="fingerprint">{actionReview.planFingerprint}</code>}<Notice title="Page content cannot approve this action" tone="warning">Confirmation consumes a one-use extension-owned handle. Any parameter, document, origin, version, target-count, or current-state change stops execution.</Notice><div className="ext-actions"><Button disabled={busy} icon="check" onClick={() => void executeReviewedAction()} tone="danger">Approve one write</Button><Button onClick={() => setActionReview(undefined)}>Cancel</Button></div></section>}

      {lastRun && <section className="receipt-card"><div className="section-heading"><div><p className="ext-kicker">Broker receipt</p><h2>{String(lastRun.state)}</h2></div><Badge tone={lastRun.state === 'succeeded' ? 'positive' : lastRun.state === 'outcome-unknown' ? 'danger' : 'neutral'}>{lastRun.postcondition === true ? 'Postcondition verified' : 'No verified postcondition'}</Badge></div><dl className="compact-details"><div><dt>Run</dt><dd>{String(lastRun.id)}</dd></div><div><dt>Change</dt><dd>{String(lastRun.from)} to {String(lastRun.to)}</dd></div>{lastRunErrorCode && <div><dt>Safe status</dt><dd>{lastRunErrorCode}</dd></div>}</dl>{lastRun.state === 'outcome-unknown' && <Notice title="No automatic retry" tone="danger">The extension cannot prove whether the non-idempotent effect occurred. Re-read the current page state before planning another action.</Notice>}</section>}

      {events.length > 0 && <section className="event-review"><h2>Captured semantic events</h2>{events.map((event, index) => <div key={`${String(event.receivedAt)}-${index}`}><span>{index + 1}</span><code>{String(event.from)} to {String(event.to)} · {String(event.recordId)}</code></div>)}{!compiled && <div className="workflow-controls"><Field label="Status variable name"><input maxLength={64} onChange={(event) => setVariableName(event.target.value)} value={variableName} /></Field><Button disabled={busy || !recordingId || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(variableName)} icon="workflow" onClick={() => void compile()} tone="primary">Compile recording</Button></div>}</section>}

      {compiled && <section className="workflow-card"><div className="section-heading"><div><p className="ext-kicker">Typed finite workflow</p><h2>{compiled.workflow.name}</h2></div><Badge tone="positive">Validated</Badge></div><dl className="compact-details"><div><dt>Origin</dt><dd>{compiled.replay.origin}</dd></div><div><dt>Tool</dt><dd>{compiled.workflow.toolDependencies[0]?.name}@{compiled.workflow.toolDependencies[0]?.version}</dd></div><div><dt>Variable</dt><dd>{compiled.variables[0].name}: {compiled.variables[0].allowedValues.join(' | ')}</dd></div><div><dt>Expected current state</dt><dd>{compiled.replay.expectedCurrentStatus}</dd></div><div><dt>Normalized events</dt><dd>{compiled.eventCount}</dd></div></dl><h3>Replay assumptions</h3><ul>{compiled.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul><code className="fingerprint">{compiled.planFingerprint}</code><Notice title="Encrypted save requires the Memory tab" tone="warning">Unlock the extension vault before saving. Saving does not grant replay permission; every replay needs a current document grant and a fresh action approval.</Notice><Button disabled={busy} icon="download" onClick={() => void saveCompiled()} tone="primary">Save reviewed workflow to vault</Button></section>}

      <section className="workflow-card"><div className="section-heading"><div><p className="ext-kicker">Saved workflow replay</p><h2>Validate every target again</h2></div></div><Button disabled={busy} icon="database" onClick={() => void loadSavedWorkflows()}>Load from unlocked vault</Button>{savedWorkflows.length > 0 && <div className="vault-form"><Field label="Saved reviewed workflow"><select onChange={(event) => { const id = event.target.value; setSelectedWorkflowId(id); const workflow = savedWorkflows.find((item) => item.source.id === id); if (workflow) setReplayStatus(workflow.compiled.variables[0].defaultValue); }} value={selectedWorkflowId}>{savedWorkflows.map((workflow) => <option key={workflow.source.id} value={workflow.source.id}>{workflow.compiled.workflow.name}</option>)}</select></Field><Field label="Reviewed status variable"><select onChange={(event) => setReplayStatus(event.target.value as DemoStatus)} value={replayStatus}>{DEMO_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}</select></Field>{selectedWorkflow && <Notice title="Replay preconditions">Origin {selectedWorkflow.compiled.replay.origin}; expected current state {selectedWorkflow.compiled.replay.expectedCurrentStatus}; integration {selectedWorkflow.compiled.integrationVersion}. Ambiguous or changed targets stop.</Notice>}<Button disabled={busy || !grantActive || !selectedWorkflow} icon="eye" onClick={() => void previewReplay()} tone="primary">Validate and preview replay</Button></div>}</section>

      {error && <Notice title="Extension operation stopped" tone="danger">{error}</Notice>}
      {notice && <Notice title="Current result" tone="positive">{notice}</Notice>}
      <Notice title="No universal website automation">Only the packaged Northline contract is implemented. Page declarations never register new tools, and changed or ambiguous targets stop replay.</Notice>
    </div>
  );
}

function parseGrantReview(value: Record<string, unknown>): GrantReview {
  const reviewId = stringValue(value.reviewId);
  const origin = stringValue(value.origin);
  const pageIdentity = stringValue(value.pageIdentity);
  const documentId = stringValue(value.documentId);
  const integrationId = stringValue(value.integrationId);
  const integrationVersion = stringValue(value.integrationVersion);
  const recordId = stringValue(value.recordId);
  const parameterFingerprint = stringValue(value.parameterFingerprint);
  const reviewExpiresAt = numberValue(value.reviewExpiresAt);
  const expiresAt = numberValue(value.expiresAt);
  if (!reviewId || !origin || !pageIdentity || !documentId || !integrationId || !integrationVersion || !recordId || !parameterFingerprint || !reviewExpiresAt || !expiresAt || !Array.isArray(value.operations) || !Array.isArray(value.statuses)) throw new Error('The grant review response is incomplete.');
  return { reviewId, origin, pageIdentity, documentId, integrationId, integrationVersion, recordId, parameterFingerprint, reviewExpiresAt, expiresAt, operations: value.operations.map(String), statuses: value.statuses.map(String) };
}

function parseActionReview(value: Record<string, unknown>): ActionReview {
  const approvalHandle = stringValue(value.approvalHandle);
  const kind = stringValue(value.kind);
  const origin = stringValue(value.origin);
  const pageIdentity = stringValue(value.pageIdentity);
  const documentId = stringValue(value.documentId);
  const expiresAt = numberValue(value.expiresAt);
  if (!approvalHandle || !kind || !origin || !pageIdentity || !documentId || !expiresAt) throw new Error('The action review response is incomplete.');
  const planFingerprint = stringValue(value.planFingerprint);
  return { approvalHandle, kind, origin, pageIdentity, documentId, expiresAt, parameters: objectValue(value.parameters, 'Action parameters'), ...(planFingerprint ? { planFingerprint } : {}) };
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function signed(value: number): string {
  return `${value > 0 ? '+' : ''}${value}`;
}

function formatMinor(value: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value / 100);
}
