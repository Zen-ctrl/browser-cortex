import { useMemo, useState } from 'react';
import * as WorkflowPackage from '@browser-cortex/workflows';

type UnknownRecord = Record<string, unknown>;
type UnknownFunction = (...args: unknown[]) => unknown;
type ReviewState = 'draft' | 'validated' | 'approved' | 'complete' | 'failed';

const csv = `order_id,country,amount_minor,currency
ORD-001,US,12900,USD
ORD-002,CA,8800,USD
ORD-003,GB,14300,USD
ORD-004,US,5200,USD
ORD-005,DE,9900,USD
ORD-006,JP,17500,USD`;

const workflowDraft = {
  schemaVersion: 1,
  id: 'review-international-orders',
  version: '1.0.0',
  name: 'Review international orders',
  description: 'Keep non-US rows, preview the result, and export only after review.',
  inputSchema: { csv: 'string' },
  outputSchema: { rows: 'array' },
  originScope: [location.origin],
  requiredCapabilities: ['input:read', 'local-file:export'],
  sourceDependencies: [],
  toolDependencies: [],
  limits: { maxRows: 10_000, maxSteps: 32, maxDurationMs: 120_000 },
  steps: [
    { id: 'parse', op: 'csv.parse', input: { ref: 'input.csv' }, output: 'orders' },
    { id: 'filter', op: 'rows.filter', input: { ref: 'steps.parse.orders' }, predicate: { op: 'neq', left: { field: 'country' }, right: { literal: 'US' } }, output: 'international' },
    { id: 'preview', op: 'preview.show', input: { ref: 'steps.filter.international' } },
    { id: 'approve', op: 'approval.require', input: { ref: 'steps.filter.international' }, scope: 'export-reviewed-rows' },
    { id: 'export', op: 'file.export', input: { ref: 'steps.filter.international' }, approvalRef: 'steps.approve', filename: 'reviewed-orders.csv', format: 'csv' },
  ],
};

function packageFunction(name: string): UnknownFunction {
  const value = (WorkflowPackage as UnknownRecord)[name];
  if (typeof value !== 'function') throw new Error(`Workflow package export ${name} is unavailable.`);
  return value as UnknownFunction;
}

function parseRows(value: string): Array<Record<string,string>> {
  const lines = value.trim().split(/\r?\n/); const headers = lines[0]?.split(',') ?? [];
  if (!headers.includes('country')) throw new Error('The country column is required.');
  return lines.slice(1).filter(Boolean).map((line) => { const cells = line.split(','); return Object.fromEntries(headers.map((header,index) => [header,cells[index] ?? ''])); });
}

export function WorkflowReviewApp() {
  const [state, setState] = useState<ReviewState>('draft');
  const [plan, setPlan] = useState<unknown>(workflowDraft);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [approvedFingerprint, setApprovedFingerprint] = useState('');
  const rows = useMemo(() => parseRows(csv), []);
  const outputRows = useMemo(() => rows.filter((row) => row.country !== 'US'), [rows]);
  const totalMinor = outputRows.reduce((sum,row) => sum + Number(row.amount_minor),0);

  async function validate() {
    setBusy(true); setError('');
    try { const validator = packageFunction('validateWorkflow'); const result = await validator(workflowDraft); const record = result as UnknownRecord; setPlan(record.workflow ?? workflowDraft); setState('validated'); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Workflow validation failed.'); setState('failed'); }
    finally { setBusy(false); }
  }

  async function approve() {
    setError('');
    try {
      const canonical = JSON.stringify({ workflow: plan, inputRows: rows, outputRows, destination: 'reviewed-orders.csv' });
      const bytes = new TextEncoder().encode(canonical); const digest = await crypto.subtle.digest('SHA-256', bytes); const fingerprint = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2,'0')).join('');
      setApprovedFingerprint(fingerprint); setState('approved');
    } catch { setError('The exact plan fingerprint could not be created.'); setState('failed'); }
  }

  async function execute() {
    setBusy(true); setError('');
    try {
      const Broker = packageFunction('ApprovalBroker') as unknown as new (options: { review: () => boolean }) => unknown;
      const approvalBroker = new Broker({ review: () => Boolean(approvedFingerprint) });
      const create = packageFunction('createWorkflowInterpreter'); const interpreter = await create({ approvalBroker });
      const target = interpreter as UnknownRecord; const method = target.execute ?? target.run;
      if (typeof method !== 'function') throw new Error('The workflow interpreter does not expose an execution method.');
      await (method as UnknownFunction).call(interpreter, plan, { csv });
      setState('complete');
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Execution failed.'); setState('failed'); }
    finally { setBusy(false); }
  }

  return <div className="review-shell"><aside><a className="review-brand" href="../../"><span><i/><i/><i/></span><div><strong>BrowserCortex</strong><small>workflow review</small></div></a><nav><a className="is-active" href="#plan"><span>1</span>Review plan</a><a href="#preview"><span>2</span>Inspect output</a><a href="#authority"><span>3</span>Grant capability</a></nav><div className="aside-note"><strong>Nothing runs from model text.</strong><p>The interpreter accepts only validated finite operations.</p></div></aside><main><header><div><p>React integration example</p><h1>Review international orders</h1></div><StateBadge state={state} /></header>{error && <div className="error-banner" role="alert"><strong>Workflow stopped</strong><span>{error}</span></div>}<section className="summary-row"><Summary label="Input rows" value={rows.length.toString()} detail="Synthetic CSV" /><Summary label="Output rows" value={outputRows.length.toString()} detail="country is not US" /><Summary label="Output total" value={formatMoney(totalMinor)} detail="No conversion applied" /><Summary label="Execution" value="Local" detail="Deterministic operations" /></section><section className="plan-card" id="plan"><div className="section-heading"><div><p>Typed plan</p><h2>Five bounded steps</h2></div><button disabled={busy || state === 'validated' || state === 'approved' || state === 'complete'} onClick={() => void validate()} type="button">{busy ? 'Validating...' : 'Validate with workflow package'}</button></div><div className="steps">{workflowDraft.steps.map((step,index) => <article className={state !== 'draft' && state !== 'failed' ? 'is-valid' : ''} key={step.id}><span>{state !== 'draft' && state !== 'failed' ? '✓' : index + 1}</span><div><strong>{stepLabel(step.op)}</strong><code>{step.op}</code></div><p>{stepDescription(step)}</p></article>)}</div></section><section className="preview-card" id="preview"><div className="section-heading"><div><p>Dry-run preview</p><h2>Rows that would be exported</h2></div><span>{outputRows.length} of {rows.length} rows</span></div><div className="table-wrap"><table><thead><tr><th>Order</th><th>Country</th><th>Amount</th><th>Currency</th><th>Reason</th></tr></thead><tbody>{outputRows.map((row) => <tr key={row.order_id}><td>{row.order_id}</td><td><span className="country">{row.country}</span></td><td>{formatMoney(Number(row.amount_minor))}</td><td>{row.currency}</td><td>country != US</td></tr>)}</tbody></table></div><p className="preview-note">The original CSV is unchanged. Formula-like cells would be escaped according to the export policy.</p></section><section className="authority-card" id="authority"><div><p>Capability review</p><h2>Export exactly these rows?</h2><span>Approval binds this plan, input, output, destination, and policy into one fingerprint. Any edit requires a new review.</span></div><dl><div><dt>Source</dt><dd>Inline synthetic CSV</dd></div><div><dt>Destination</dt><dd>reviewed-orders.csv</dd></div><div><dt>Effect</dt><dd>Create a new local file</dd></div><div><dt>Reversible</dt><dd>Original remains unchanged</dd></div></dl>{approvedFingerprint && <code className="fingerprint">SHA-256 {approvedFingerprint.slice(0,16)}...{approvedFingerprint.slice(-8)}</code>}<div className="review-actions"><button disabled={state !== 'validated'} onClick={() => void approve()} type="button">Approve exact plan</button><button className="primary" disabled={state !== 'approved' || busy} onClick={() => void execute()} type="button">{busy ? 'Running...' : 'Run approved workflow'}</button></div>{state === 'complete' && <div className="complete-banner"><strong>Interpreter completed the approved workflow.</strong><span>Check the browser download tray for the local export if this runtime supports file export.</span></div>}</section></main></div>;
}

function StateBadge({ state }: { state: ReviewState }) { const labels: Record<ReviewState,string> = { draft:'Draft',validated:'Validated',approved:'Approved',complete:'Complete',failed:'Stopped' }; return <span className={`state-badge state-badge--${state}`}><i />{labels[state]}</span>; }
function Summary({ label, value, detail }: { label: string; value: string; detail: string }) { return <article><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>; }
function stepLabel(op: string): string { return ({'csv.parse':'Parse selected CSV','rows.filter':'Filter international rows','preview.show':'Show dry-run output','approval.require':'Bind exact approval','file.export':'Create local export'} as Record<string,string>)[op] ?? op; }
function stepDescription(step: UnknownRecord): string { if (step.op === 'rows.filter') return 'Keep rows whose country field is not US.'; if (step.op === 'file.export') return `Write ${String(step.filename)} only after approval.`; if (step.op === 'approval.require') return 'Ask the trusted host for a one-use decision.'; return 'Validate inputs and preserve typed references.'; }
function formatMoney(minor: number): string { return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(minor/100); }
