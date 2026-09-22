import { useEffect, useMemo, useRef, useState, type ChangeEvent, type Dispatch, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type SetStateAction } from 'react';
import {
  AppFrame, Badge, Button, EmptyState, Field, Icon, InlineCode, Meter, Notice, PageHeader, Panel,
  SegmentedControl, Stat, Switch, Toolbar, type AppFrameItem, type IconName,
} from '@browser-cortex/ui';
import {
  cancelPendingTask, changeVaultPassphrase, clearOnlineSession, compileCsvWorkflow, configureOnlineSession,
  createSourceGrant, createVault, deleteLocalVault, deleteMemorySource, deleteModelCache, denyPreparedDisclosure,
  detectSensitive, dryRunWorkflow, executePendingTask, exportEncryptedVault, importEncryptedVault, importSource,
  initializeVault, inspectModel, inspectModelCache, inspectWorkspaceConnections, installModel, listEncryptedReceipts,
  listMemorySources, listSavedWorkflows, listSourceGrants, loadModel, lockVault, modelDescriptor,
  onlineSessionSummary, prepareOnlineDisclosure, prepareWorkflowApproval, proposeTask, readSourceRevision, reuseSavedWorkflow,
  requestPersistentStorage, revokeSourceGrant, runApprovedWorkflow, saveWorkflowDraft, searchMemory, sendPreparedDisclosure, storageEstimate,
  unlockVault, unloadModel, validateWorkflowJson,
  type CacheInspection, type DisclosurePreview, type GrantSummary, type MemoryPassage, type MemorySourceSummary,
  type ModelDescriptor, type ModelInspection, type OnlineResult, type OnlineSessionSummary, type RuntimeProgress,
  type SavedWorkflowSummary, type SensitiveFinding, type WorkflowApprovalPreview, type WorkflowDraft, type WorkflowRunReview,
} from './integrations';
import { activateWorkbenchUpdate, type WorkbenchServiceWorkerState } from './service-worker';

type PageId = 'overview' | 'ask' | 'memory' | 'workflows' | 'models' | 'privacy' | 'activity' | 'settings';
type VaultState = 'not-created' | 'locked' | 'unlocked' | 'recovery';
type OnlinePolicy = 'deny' | 'ask';
type ActivityRoute = 'deterministic' | 'local-model' | 'online-model' | 'system';
interface ActivityItem { id: string; at: Date; label: string; detail: string; route: ActivityRoute; outcome: 'complete' | 'cancelled' | 'failed' }
interface OnlineDraft { text: string; sourceIds: string[] }

const navigation: readonly AppFrameItem[] = [
  { id: 'overview', label: 'Overview', icon: 'brain' }, { id: 'ask', label: 'Ask', icon: 'spark' },
  { id: 'memory', label: 'Memory', icon: 'database' }, { id: 'workflows', label: 'Workflows', icon: 'workflow' },
  { id: 'models', label: 'Models', icon: 'model' }, { id: 'privacy', label: 'Privacy', icon: 'privacy' },
  { id: 'activity', label: 'Activity', icon: 'activity' }, { id: 'settings', label: 'Settings', icon: 'settings' },
];
const pageMeta: Record<PageId, { label: string; icon: IconName }> = Object.fromEntries(navigation.map((item) => [item.id, { label: item.label, icon: item.icon }])) as Record<PageId, { label: string; icon: IconName }>;
const syntheticCsv = `order_id,country,amount_minor,currency
DEMO-001,US,12900,USD
DEMO-002,CA,8800,USD
DEMO-003,GB,14300,USD
DEMO-004,US,5200,USD`;
const ONBOARDING_KEY = 'browser-cortex:onboarding:v1';

function formatBytes(bytes?: number): string {
  if (bytes === undefined) return 'Not reported';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}
function safeStatus(value: unknown, fallback: VaultState): VaultState {
  if (typeof value !== 'object' || value === null) return fallback;
  const raw = (value as { state?: unknown }).state;
  return raw === 'unlocked' ? 'unlocked' : raw === 'locked' ? 'locked' : raw === 'missing' ? 'not-created' : fallback;
}
function describeError(error: unknown): string { return error instanceof Error ? error.message : 'The operation could not be completed.'; }
function downloadText(name: string, type: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
function initialOnboarding(): boolean {
  try { return localStorage.getItem(ONBOARDING_KEY) !== 'complete'; } catch { return true; }
}
function Brand({ compact = false }: { compact?: boolean }) {
  return <div className={`brand${compact ? ' brand--compact' : ''}`}><span aria-hidden="true" className="brand__mark"><span /><span /><span /></span><span className="brand__copy"><strong>BrowserCortex</strong>{!compact && <small>local intelligence</small>}</span></div>;
}

export function App() {
  const [page, setPage] = useState<PageId>('overview');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [vaultState, setVaultState] = useState<VaultState>('not-created');
  const [sources, setSources] = useState<MemorySourceSummary[]>([]);
  const [grants, setGrants] = useState<GrantSummary[]>([]);
  const [savedWorkflows, setSavedWorkflows] = useState<SavedWorkflowSummary[]>([]);
  const [embedding, setEmbedding] = useState<ModelInspection>(() => inspectModel('embedding'));
  const [generation, setGeneration] = useState<ModelInspection>(() => inspectModel('generation'));
  const [onlinePolicy, setOnlinePolicy] = useState<OnlinePolicy>('deny');
  const [onlineSession, setOnlineSession] = useState<OnlineSessionSummary>(() => onlineSessionSummary());
  const [onlineDraft, setOnlineDraft] = useState<OnlineDraft>();
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [retentionDays, setRetentionDays] = useState(30);
  const [storage, setStorage] = useState<{ usage?: number; quota?: number; persisted?: boolean }>({});
  const [toast, setToast] = useState('');
  const [showOnboarding, setShowOnboarding] = useState(initialOnboarding);
  const [reducedMode, setReducedMode] = useState(!('gpu' in navigator));
  const [serviceWorkerState, setServiceWorkerState] = useState<WorkbenchServiceWorkerState>();
  const [privateViewEpoch, setPrivateViewEpoch] = useState(0);
  const [vaultInitializationError, setVaultInitializationError] = useState<string>();
  const connections = useMemo(() => inspectWorkspaceConnections(), []);

  async function refreshPrivateState(): Promise<void> {
    if (vaultState !== 'unlocked') return;
    const [nextSources, nextGrants, workflows] = await Promise.all([listMemorySources(), listSourceGrants(), listSavedWorkflows()]);
    setSources(nextSources); setGrants(nextGrants); setSavedWorkflows(workflows);
  }
  function refreshModels(): void { setEmbedding(inspectModel('embedding')); setGeneration(inspectModel('generation')); }
  function log(item: Omit<ActivityItem, 'id' | 'at'>): void {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    setActivity((current) => [{ ...item, id: crypto.randomUUID(), at: new Date() }, ...current].filter((entry) => entry.at.getTime() >= cutoff).slice(0, 250));
  }
  function notify(message: string): void { setToast(message); window.setTimeout(() => setToast(''), 3600); }
  function completeOnboarding(destination: PageId, reduced: boolean): void {
    setReducedMode(reduced); setShowOnboarding(false); setPage(destination);
    try { localStorage.setItem(ONBOARDING_KEY, 'complete'); } catch { /* Private browsing can reject preference storage. */ }
  }

  useEffect(() => { void storageEstimate().then(setStorage).catch(() => setStorage({})); }, [sources, vaultState, embedding.loaded, generation.loaded]);
  useEffect(() => {
    void initializeVault().then((status) => {
      setVaultInitializationError(undefined); setVaultState(safeStatus(status, 'not-created'));
    }).catch((error) => {
      setVaultInitializationError(describeError(error)); setVaultState('recovery');
    });
  }, []);
  useEffect(() => {
    if (vaultState === 'unlocked') void refreshPrivateState().catch((error) => notify(describeError(error)));
    else { setSources([]); setGrants([]); setSavedWorkflows([]); }
  }, [vaultState]);
  useEffect(() => {
    const onState = (event: WindowEventMap['browser-cortex:service-worker']) => setServiceWorkerState(event.detail.state);
    window.addEventListener('browser-cortex:service-worker', onState);
    return () => window.removeEventListener('browser-cortex:service-worker', onState);
  }, []);
  useEffect(() => {
    const onLock = (event: Event) => {
      const reason = (event as CustomEvent<{ reason?: string }>).detail?.reason;
      setVaultState('locked'); setSources([]); setGrants([]); setSavedWorkflows([]); setOnlineDraft(undefined);
      setVaultInitializationError(undefined);
      setOnlineSession({ configured: false, simulation: false, bearerPresent: false });
      setPrivateViewEpoch((current) => current + 1);
      notify(reason === 'auto' ? 'Vault auto-locked. Private views and active local work were cleared.' : 'Vault locked. Private views and active local work were cleared.');
    };
    window.addEventListener('browser-cortex:vault-lock', onLock);
    return () => window.removeEventListener('browser-cortex:vault-lock', onLock);
  }, []);

  const common: CommonProps = {
    vaultState, setVaultState, vaultInitializationError, setVaultInitializationError, sources, setSources, grants, setGrants, savedWorkflows, setSavedWorkflows,
    embedding, generation, refreshModels, onlinePolicy, setOnlinePolicy, onlineSession, setOnlineSession,
    onlineDraft, setOnlineDraft, activity, setActivity, retentionDays, setRetentionDays, storage, setStorage, connections,
    reducedMode, setReducedMode, refreshPrivateState, log, notify, navigate: setPage,
  };
  let content: ReactNode;
  switch (page) {
    case 'ask': content = <AskPage key={`ask:${privateViewEpoch}`} {...common} />; break;
    case 'memory': content = <MemoryPage key={`memory:${privateViewEpoch}`} {...common} />; break;
    case 'workflows': content = <WorkflowsPage key={`workflows:${privateViewEpoch}`} {...common} />; break;
    case 'models': content = <ModelsPage key={`models:${privateViewEpoch}`} {...common} />; break;
    case 'privacy': content = <PrivacyPage key={`privacy:${privateViewEpoch}`} {...common} />; break;
    case 'activity': content = <ActivityPage key={`activity:${privateViewEpoch}`} {...common} />; break;
    case 'settings': content = <SettingsPage key={`settings:${privateViewEpoch}`} {...common} />; break;
    default: content = <OverviewPage key={`overview:${privateViewEpoch}`} {...common} />;
  }
  return <>
    <div aria-hidden={showOnboarding || undefined} inert={showOnboarding || undefined}><AppFrame
      activeId={page} brand={<Brand />} items={navigation} mobileOpen={mobileOpen} onMobileOpenChange={setMobileOpen}
      onNavigate={(id) => setPage(id as PageId)}
      headerEnd={<div className="global-status"><Badge dot tone={onlinePolicy === 'deny' ? 'positive' : 'warning'}>{onlinePolicy === 'deny' ? 'Local only' : 'Ask before online'}</Badge><span className="global-status__divider" /><span><Icon name={vaultState === 'unlocked' ? 'key' : 'lock'} size={15} />Vault {vaultState === 'not-created' ? 'not created' : vaultState}</span></div>}
      sidebarFooter={<div className="sidebar-status"><span className={connections.every((item) => item.connected) ? 'is-ready' : ''} /><div><strong>{connections.filter((item) => item.connected).length}/{connections.length} modules wired</strong><small>{reducedMode ? 'Reduced mode' : 'Full local mode'}</small></div></div>}
    >
      <div className="mobile-page-title"><Icon name={pageMeta[page].icon} size={16} />{pageMeta[page].label}</div>
      {serviceWorkerState === 'update-available' && <Notice action={<Button compact onClick={() => activateWorkbenchUpdate()}>Apply update</Button>} title="Workbench update ready">The reviewed app shell is cached. Apply it when you are ready to reload.</Notice>}
      {serviceWorkerState === 'error' && <Notice title="Offline shell unavailable" tone="warning">Local data remains local, but the static shell could not be registered for offline startup.</Notice>}
      {content}
    </AppFrame></div>
    {showOnboarding && <Onboarding onComplete={completeOnboarding} />}
    {toast && <div className="toast" role="status"><Icon name="check" size={16} />{toast}</div>}
  </>;
}

type CommonProps = {
  vaultState: VaultState; setVaultState: (value: VaultState) => void;
  vaultInitializationError: string | undefined; setVaultInitializationError: (value: string | undefined) => void;
  sources: MemorySourceSummary[]; setSources: Dispatch<SetStateAction<MemorySourceSummary[]>>;
  grants: GrantSummary[]; setGrants: Dispatch<SetStateAction<GrantSummary[]>>;
  savedWorkflows: SavedWorkflowSummary[]; setSavedWorkflows: Dispatch<SetStateAction<SavedWorkflowSummary[]>>;
  embedding: ModelInspection; generation: ModelInspection; refreshModels: () => void;
  onlinePolicy: OnlinePolicy; setOnlinePolicy: (value: OnlinePolicy) => void;
  onlineSession: OnlineSessionSummary; setOnlineSession: (value: OnlineSessionSummary) => void;
  onlineDraft: OnlineDraft | undefined; setOnlineDraft: (value: OnlineDraft | undefined) => void;
  activity: ActivityItem[]; setActivity: Dispatch<SetStateAction<ActivityItem[]>>;
  retentionDays: number; setRetentionDays: (value: number) => void;
  storage: { usage?: number; quota?: number; persisted?: boolean };
  setStorage: Dispatch<SetStateAction<{ usage?: number; quota?: number; persisted?: boolean }>>;
  connections: ReturnType<typeof inspectWorkspaceConnections>;
  reducedMode: boolean; setReducedMode: (value: boolean) => void;
  refreshPrivateState: () => Promise<void>;
  log: (item: Omit<ActivityItem, 'id' | 'at'>) => void; notify: (message: string) => void; navigate: (page: PageId) => void;
};

function Onboarding({ onComplete }: { onComplete: (destination: PageId, reduced: boolean) => void }) {
  const [step, setStep] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const noWebGpu = !('gpu' in navigator);
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus();
    return () => { document.body.style.overflow = previousOverflow; };
  }, [step]);
  function containFocus(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'Tab') return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])];
    const first = focusable[0]; const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  return <div aria-labelledby="onboarding-title" aria-modal="true" className="onboarding" onKeyDown={containFocus} ref={dialogRef} role="dialog"><div className="onboarding__card">
    <div className="onboarding__progress" aria-label={`Step ${step + 1} of 3`}><span className={step >= 0 ? 'is-active' : ''} /><span className={step >= 1 ? 'is-active' : ''} /><span className={step >= 2 ? 'is-active' : ''} /></div>
    {step === 0 && <><p className="bc-eyebrow">Local first</p><h1 id="onboarding-title">Nothing leaves by default</h1><p>BrowserCortex starts with online inference disabled, no account, no analytics, and no model download. Sources you import stay in an encrypted browser vault.</p><Notice title="You remain in control" tone="positive">Source text is untrusted data. It cannot enable networking, install a model, or approve an action.</Notice><Button onClick={() => setStep(1)} tone="primary">Continue</Button></>}
    {step === 1 && <><p className="bc-eyebrow">Optional models</p><h1 id="onboarding-title">Downloads happen only after review</h1><p>Local search can download from <InlineCode>huggingface.co</InlineCode>. Local generation uses reviewed WebLLM weights and a packaged WASM executable. Storage totals include extra tokenizer/config files and browser overhead.</p>{noWebGpu && <Notice title="Reduced capability detected" tone="warning">No WebGPU interface is visible. Deterministic search, memory, privacy checks, and CSV workflows still work.</Notice>}<Toolbar><Button onClick={() => setStep(2)} tone="primary">Continue</Button><Button onClick={() => onComplete('overview', true)} tone="quiet">Use reduced mode</Button></Toolbar></>}
    {step === 2 && <><p className="bc-eyebrow">Vault choice</p><h1 id="onboarding-title">Encrypted vault or temporary mode</h1><p>An encrypted vault keeps chosen sources, grants, workflows, and receipts. The passphrase never leaves this page and cannot be recovered. Temporary mode keeps only session controls and synthetic workflow inputs.</p><div className="onboarding__choices"><Button icon="key" onClick={() => onComplete('memory', noWebGpu)} tone="primary">Set up encrypted vault</Button><Button icon="arrow" onClick={() => onComplete('overview', true)}>Continue temporarily</Button></div><small>No registration is required. You can set up the vault or install models later.</small></>}
  </div></div>;
}

function OverviewPage(props: CommonProps) {
  const ratio = props.storage.usage !== undefined && props.storage.quota ? Math.round(props.storage.usage / props.storage.quota * 100) : 0;
  return <>
    <PageHeader eyebrow="Local workspace" title="Your data. Your models. Your call." description="Search chosen sources, run reviewed deterministic workflows, and inspect every route before execution." actions={<><Button icon="document" onClick={() => props.navigate('memory')}>Add a source</Button><Button icon="spark" onClick={() => props.navigate('ask')} tone="primary">Start a task</Button></>} />
    <Notice title={props.onlinePolicy === 'deny' ? 'Online processing is off' : 'Online requests still require exact approval'} tone={props.onlinePolicy === 'deny' ? 'positive' : 'warning'}>{props.onlinePolicy === 'deny' ? 'Unsupported local work stops visibly. There is no hidden online fallback.' : 'Ask-before-online only permits a proposal. Endpoint configuration, redaction preview, and one-use approval remain separate.'}</Notice>
    <section aria-label="Current status" className="status-grid">
      <Stat detail="Encrypted workspace" icon={props.vaultState === 'unlocked' ? 'key' : 'lock'} label="Vault" value={props.vaultState === 'not-created' ? 'Not created' : props.vaultState} />
      <Stat detail={props.embedding.integrity} icon="search" label="Embedding model" value={props.embedding.loaded ? 'Loaded' : props.embedding.installed ? 'Installed' : 'Not installed'} />
      <Stat detail={props.generation.device} icon="model" label="Text model" value={props.generation.loaded ? 'Loaded' : props.generation.installed ? 'Installed' : 'Not installed'} />
      <Stat detail={props.storage.quota ? `${formatBytes(props.storage.quota)} quota` : 'Quota unavailable'} icon="database" label="Origin storage" value={formatBytes(props.storage.usage)} />
    </section>
    <div className="overview-grid"><Panel eyebrow="Start here" title="Bounded paths"><div className="action-list">
      <button onClick={() => props.navigate('memory')} type="button"><span className="action-list__icon"><Icon name="database" /></span><span><strong>Search explicit memories</strong><small>Import supported text and inspect source-backed passages.</small></span><Icon name="arrow" /></button>
      <button onClick={() => props.navigate('workflows')} type="button"><span className="action-list__icon action-list__icon--gold"><Icon name="workflow" /></span><span><strong>Review a CSV workflow</strong><small>Edit typed steps, dry-run, then approve an exact export.</small></span><Icon name="arrow" /></button>
      <button onClick={() => props.navigate('privacy')} type="button"><span className="action-list__icon action-list__icon--blue"><Icon name="privacy" /></span><span><strong>Preview a disclosure</strong><small>Inspect exact redacted bytes before optional online egress.</small></span><Icon name="arrow" /></button>
    </div></Panel><Panel eyebrow="Runtime wiring" title="Real integration points"><div className="panel-body readiness-list">{props.connections.map((item) => <div key={item.exportName}><span className={item.connected ? 'status-dot is-ready' : 'status-dot'} /><span><strong>{item.name}</strong><small><InlineCode>{item.exportName}</InlineCode></small></span><Badge tone={item.connected ? 'positive' : 'warning'}>{item.connected ? 'Wired' : 'Unavailable'}</Badge></div>)}</div></Panel></div>
    <div className="overview-grid overview-grid--lower"><Panel eyebrow="Storage" title="Browser-reported origin total"><div className="panel-body"><Meter detail={props.storage.quota ? `${formatBytes(props.storage.usage)} of ${formatBytes(props.storage.quota)}` : 'Browser did not report a quota'} label="All origin stores" value={ratio} /><p className="fine-print">This total is not a per-model measurement. Browser eviction remains possible{props.storage.persisted ? '; persistent storage is granted.' : '; persistent storage is not confirmed.'}</p></div></Panel><Panel eyebrow="Activity" title="Scrubbed session receipts">{props.activity.length ? <ActivityList items={props.activity.slice(0, 4)} /> : <EmptyState icon="activity" title="No activity yet">No sample metrics or fabricated receipts are shown.</EmptyState>}</Panel></div>
  </>;
}

function routeRecord(value: unknown): { route: string; reasons: string[] } {
  if (typeof value !== 'object' || value === null) return { route: 'unavailable', reasons: ['No route decision'] };
  const outer = value as Record<string, unknown>; const raw = typeof outer.route === 'object' && outer.route !== null ? outer.route as Record<string, unknown> : outer;
  return { route: typeof raw.route === 'string' ? raw.route : 'unavailable', reasons: Array.isArray(raw.reasonCodes) ? raw.reasonCodes.map(String) : [] };
}
function activityRoute(route: string): ActivityRoute { return route === 'deterministic' || route === 'local-model' || route === 'online-model' ? route : 'system'; }
function citationsFrom(output: unknown): MemoryPassage[] {
  if (Array.isArray(output)) return output.filter((item): item is MemoryPassage => typeof item === 'object' && item !== null && typeof (item as MemoryPassage).revisionId === 'string');
  if (typeof output !== 'object' || output === null) return [];
  const citations = (output as { citations?: unknown }).citations;
  return Array.isArray(citations) ? citations.filter((item): item is MemoryPassage => typeof item === 'object' && item !== null && typeof (item as MemoryPassage).revisionId === 'string') : [];
}

function AskPage(props: CommonProps) {
  const [task, setTask] = useState('search'); const [input, setInput] = useState(''); const [selected, setSelected] = useState<string[]>([]);
  const [proposal, setProposal] = useState<unknown>(); const [execution, setExecution] = useState<unknown>(); const [stream, setStream] = useState('');
  const [citation, setCitation] = useState<{ title: string; revisionId: string; text: string }>(); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const abortRef = useRef<AbortController | undefined>(undefined);
  useEffect(() => { setSelected((current) => current.filter((id) => props.sources.some((source) => source.id === id))); }, [props.sources]);
  useEffect(() => () => { abortRef.current?.abort('Task view closed.'); void cancelPendingTask(); }, []);
  async function submit(): Promise<void> {
    setBusy(true); setError(''); setExecution(undefined); setStream(''); setCitation(undefined);
    try {
      const next = await proposeTask(input.trim(), task, props.onlinePolicy, selected, props.reducedMode); setProposal(next);
      const decision = routeRecord(next); props.log({ label: `Proposed ${task} task`, detail: `Route: ${decision.route}; reasons: ${decision.reasons.join(', ') || 'none'}`, route: activityRoute(decision.route), outcome: 'complete' });
    } catch (caught) { const message = describeError(caught); setError(message); props.log({ label: 'Task proposal failed', detail: message, route: 'system', outcome: 'failed' }); }
    finally { setBusy(false); }
  }
  async function execute(): Promise<void> {
    const controller = new AbortController(); abortRef.current = controller; setBusy(true); setError(''); setStream('');
    try {
      const result = await executePendingTask(controller.signal, (token) => setStream((current) => current + token)); setExecution(result);
      props.log({ label: `${task} task completed`, detail: `${result.route} output returned; raw prompt omitted`, route: result.route, outcome: 'complete' });
    } catch (caught) {
      const cancelled = controller.signal.aborted; const message = cancelled ? 'Execution cancelled; partial output was not treated as complete.' : describeError(caught); setError(message);
      props.log({ label: `Task ${cancelled ? 'cancelled' : 'failed'}`, detail: message, route: 'system', outcome: cancelled ? 'cancelled' : 'failed' });
    } finally { abortRef.current = undefined; setBusy(false); props.refreshModels(); }
  }
  async function openCitation(item: MemoryPassage): Promise<void> {
    try { setCitation(await readSourceRevision(item.sourceId, item.revisionId, item.startOffset, item.endOffset)); }
    catch (caught) { setError(describeError(caught)); }
  }
  const decision = routeRecord(proposal); const output = typeof execution === 'object' && execution !== null ? (execution as { output?: unknown }).output : undefined;
  const answer = typeof output === 'object' && output !== null && typeof (output as { answer?: unknown }).answer === 'string' ? String((output as { answer: string }).answer) : stream;
  const citations = citationsFrom(output); const executable = decision.route === 'deterministic' || decision.route === 'local-model';
  return <>
    <PageHeader eyebrow="Bounded task" title="Ask with a visible route" description="Select exact sources, review deterministic route reasons, then run local work. Model text is output only and never action authority." />
    <div className="ask-layout"><Panel eyebrow="Request" title="Task and source scope"><div className="panel-body form-stack">
      <Field label="Task type"><select value={task} onChange={(event) => setTask(event.target.value)}><option value="search">Find supporting passages</option><option value="extract">Extract structured fields</option><option value="summarize">Summarize selected sources</option><option value="plan">Draft a bounded plan</option></select></Field>
      <Field hint="Source text is untrusted and cannot change this task." label="Instruction"><textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder="Where is the delivery date change mentioned?" /></Field>
      <fieldset className="source-picker"><legend>Sources included</legend>{props.sources.length === 0 ? <small>No unlocked source is available. Search requires an unlocked vault.</small> : props.sources.map((source) => <label key={source.id}><input checked={selected.includes(source.id)} type="checkbox" onChange={(event) => setSelected((current) => event.target.checked ? [...current, source.id] : current.filter((id) => id !== source.id))} /><span><strong>{source.title}</strong><small>Revision {source.currentRevisionId.slice(0, 12)}</small></span></label>)}</fieldset>
      <Notice title={props.onlinePolicy === 'deny' ? 'Local-only route enforced' : 'Online still requires a disclosure'} tone={props.onlinePolicy === 'deny' ? 'positive' : 'warning'}>{props.onlinePolicy === 'deny' ? 'Unavailable work stops with a reason. It never falls back online.' : 'A route proposal does not send data or grant approval.'}</Notice>
      {error && <Notice title="Task status" tone="danger">{error}</Notice>}<Button disabled={busy || !input.trim()} icon="spark" onClick={() => void submit()} tone="primary">{busy && !abortRef.current ? 'Preparing...' : 'Prepare route'}</Button>
    </div></Panel><Panel eyebrow="Review" title="Route, stream, and citations">
      {!proposal ? <EmptyState icon="spark" title="Nothing has run">A proposal will list its reason codes before execution.</EmptyState> : <div className="proposal">
        <div className="proposal__meta"><Badge tone={decision.route === 'unavailable' ? 'warning' : decision.route === 'online-model' ? 'warning' : 'positive'}>{decision.route}</Badge><span>{selected.length} selected source{selected.length === 1 ? '' : 's'}</span></div>
        <div className="reason-list">{decision.reasons.map((reason) => <InlineCode key={reason}>{reason}</InlineCode>)}</div>
        {(answer || abortRef.current) && <div aria-live="polite" className="answer-text">{answer || 'Waiting for the first local token...'}</div>}
        {citations.length > 0 && <div className="citation-grid">{citations.map((item) => <button key={item.id} onClick={() => void openCitation(item)} type="button"><strong>{item.title}</strong><span>Revision {item.revisionId.slice(0, 12)} · offsets {item.startOffset}-{item.endOffset}</span><p>{item.text}</p></button>)}</div>}
        {citation && <Notice title={`${citation.title}, revision ${citation.revisionId.slice(0, 12)}`} tone="info">{citation.text}</Notice>}
        {!execution && executable && (abortRef.current ? <Button icon="pause" onClick={() => abortRef.current?.abort('Cancelled by user.')} tone="danger">Cancel local execution</Button> : <Button disabled={busy} icon="play" onClick={() => void execute()} tone="primary">Run reviewed route</Button>)}
        {decision.route === 'online-model' && <Button icon="privacy" onClick={() => { props.setOnlineDraft({ text: input, sourceIds: selected }); props.navigate('privacy'); }} tone="primary">Review exact online disclosure</Button>}
        {decision.route === 'unavailable' && <Notice title="No supported route" tone="warning">Install and load a reviewed local model, change the task, or explicitly configure ask-before-online. No fallback occurred.</Notice>}
      </div>}
    </Panel></div>
  </>;
}

function MemoryPage(props: CommonProps) {
  const [passphrase, setPassphrase] = useState(''); const [newPassphrase, setNewPassphrase] = useState(''); const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState(''); const [results, setResults] = useState<MemoryPassage[]>([]); const [progress, setProgress] = useState<{ value: number; label: string }>();
  const [error, setError] = useState(''); const [revisionTarget, setRevisionTarget] = useState<string>(); const [selectedGrantSource, setSelectedGrantSource] = useState('');
  const [sourceRetentionDays, setSourceRetentionDays] = useState(30);
  const [grantRecipient, setGrantRecipient] = useState('ask-panel'); const [exportPreview, setExportPreview] = useState<Awaited<ReturnType<typeof exportEncryptedVault>>>();
  const sourceInput = useRef<HTMLInputElement>(null); const archiveInput = useRef<HTMLInputElement>(null);
  const importAbortRef = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => importAbortRef.current?.abort(new DOMException('Memory view closed.', 'AbortError')), []);
  async function vaultAction(action: 'create' | 'unlock' | 'lock'): Promise<void> {
    setBusy(true); setError('');
    try {
      const status = action === 'create' ? await createVault(passphrase) : action === 'unlock' ? await unlockVault(passphrase) : await lockVault();
      props.setVaultInitializationError(undefined); props.setVaultState(safeStatus(status, props.vaultState)); setPassphrase('');
      props.log({ label: `Vault ${action === 'create' ? 'created' : action === 'unlock' ? 'unlocked' : 'locked'}`, detail: 'No passphrase or plaintext content was recorded', route: 'system', outcome: 'complete' });
    } catch (caught) { const message = describeError(caught); setError(message); }
    finally { setBusy(false); }
  }
  async function selectedFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
    const controller = new AbortController(); importAbortRef.current?.abort(new DOMException('A newer import was selected.', 'AbortError')); importAbortRef.current = controller;
    setBusy(true); setError(''); setProgress({ value: 1, label: 'Starting local import' });
    try {
      const result = await importSource(file, (value, label) => setProgress({ value, label }), revisionTarget, sourceRetentionDays || undefined, controller.signal); setRevisionTarget(undefined);
      await props.refreshPrivateState(); props.notify(result.deduplicated ? 'That exact revision already exists.' : `Encrypted ${result.chunkCount} local chunk${result.chunkCount === 1 ? '' : 's'}.`);
      props.log({ label: result.deduplicated ? 'Duplicate revision skipped' : 'Source revision imported', detail: `${result.byteLength} bytes, ${result.chunkCount} chunks`, route: 'deterministic', outcome: 'complete' });
    } catch (caught) { const cancelled = controller.signal.aborted; const message = cancelled ? 'Source import cancelled before commit.' : describeError(caught); if (importAbortRef.current === controller) setError(message); props.log({ label: cancelled ? 'Source import cancelled' : 'Source import failed', detail: message, route: 'system', outcome: cancelled ? 'cancelled' : 'failed' }); }
    finally { if (importAbortRef.current === controller) { importAbortRef.current = undefined; setBusy(false); setProgress(undefined); } }
  }
  async function search(): Promise<void> {
    setBusy(true); setError('');
    try { setResults(await searchMemory(query)); props.log({ label: 'Encrypted memory searched', detail: 'Query omitted; result count retained only in this session', route: 'deterministic', outcome: 'complete' }); }
    catch (caught) { setError(describeError(caught)); } finally { setBusy(false); }
  }
  async function removeSource(source: MemorySourceSummary): Promise<void> {
    if (!window.confirm(`Delete ${source.title}, all revisions, embeddings, dependent grants, workflows, and receipts?`)) return;
    try { const removed = await deleteMemorySource(source.id); setResults((current) => current.filter((item) => item.sourceId !== source.id)); await props.refreshPrivateState(); props.notify(`Deleted ${removed} encrypted records.`); }
    catch (caught) { setError(describeError(caught)); }
  }
  async function issueGrant(): Promise<void> {
    try { await createSourceGrant([selectedGrantSource], grantRecipient, 30); await props.refreshPrivateState(); props.notify('Thirty-minute source grant issued.'); }
    catch (caught) { setError(describeError(caught)); }
  }
  async function importArchive(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
    try { const status = await importEncryptedVault(file, passphrase); props.setVaultInitializationError(undefined); props.setVaultState(safeStatus(status, 'unlocked')); await props.refreshPrivateState(); props.notify('Encrypted vault archive imported.'); }
    catch (caught) { setError(describeError(caught)); }
  }
  return <>
    <PageHeader eyebrow="Encrypted local memory" title="Sources you explicitly choose" description="Imports, revision text, embeddings, grants, workflows, and detailed receipts are encrypted at rest. Retrieved passages are suggestions, not saved facts." actions={<Button disabled={props.vaultState !== 'unlocked'} icon="upload" onClick={() => { setRevisionTarget(undefined); sourceInput.current?.click(); }} tone="primary">Import source</Button>} />
    <input ref={sourceInput} accept=".txt,.md,.csv,.json,text/plain,text/markdown,text/csv,application/json" aria-label="Local source file" className="visually-hidden" type="file" onChange={(event) => void selectedFile(event)} />
    <input ref={archiveInput} accept="application/json,.json" aria-label="Encrypted vault archive" className="visually-hidden" type="file" onChange={(event) => void importArchive(event)} />
    <div className="memory-top-grid"><Panel eyebrow="Vault" title={props.vaultState === 'not-created' ? 'Create encrypted storage' : props.vaultState === 'locked' ? 'Unlock locally' : props.vaultState === 'recovery' ? 'Recover unreadable storage' : 'Vault is unlocked'}><div className="panel-body form-stack">
      {props.vaultState === 'recovery' ? <><Notice title="Vault needs recovery" tone="danger">{props.vaultInitializationError ?? 'The stored vault header could not be safely read.'} Existing browser data was not changed. Preserve the browser profile before destructive cleanup; an invalid header cannot be safely exported as a verified vault archive.</Notice><Toolbar><Button onClick={() => void initializeVault().then((status) => { props.setVaultInitializationError(undefined); props.setVaultState(safeStatus(status, 'locked')); }).catch((caught) => props.setVaultInitializationError(describeError(caught)))}>Retry vault inspection</Button><Button icon="warning" onClick={() => props.navigate('settings')} tone="danger">Review recovery deletion</Button></Toolbar></> : props.vaultState !== 'unlocked' ? <><p className="supporting-copy">Use at least 12 characters. There is no recovery server.</p><Field label="Vault passphrase"><input autoComplete={props.vaultState === 'not-created' ? 'new-password' : 'current-password'} minLength={12} type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} /></Field><Toolbar><Button disabled={busy || passphrase.length < 12} icon="key" onClick={() => void vaultAction(props.vaultState === 'not-created' ? 'create' : 'unlock')} tone="primary">{props.vaultState === 'not-created' ? 'Create vault' : 'Unlock vault'}</Button>{props.vaultState !== 'not-created' && <Button disabled={passphrase.length < 12} icon="upload" onClick={() => archiveInput.current?.click()}>Import encrypted archive</Button>}</Toolbar></> : <><Notice title="Decryption is active" tone="positive">Locking discards decrypted keys and hides private records.</Notice><Field label="New passphrase"><input autoComplete="new-password" minLength={12} type="password" value={newPassphrase} onChange={(event) => setNewPassphrase(event.target.value)} /></Field><Toolbar><Button disabled={newPassphrase.length < 12} onClick={() => void changeVaultPassphrase(newPassphrase).then(() => { setNewPassphrase(''); props.notify('Vault passphrase changed.'); }).catch((caught) => setError(describeError(caught)))}>Change passphrase</Button><Button icon="lock" onClick={() => void vaultAction('lock')}>Lock now</Button></Toolbar></>}
    </div></Panel><Panel eyebrow="Retrieval" title="Source-backed local search"><div className="panel-body form-stack"><Field hint="Applied to new imports and revisions; expired sources are deleted on unlock, listing, search, or export." label="New source retention"><select value={sourceRetentionDays} onChange={(event) => setSourceRetentionDays(Number(event.target.value))}><option value={0}>Keep until I delete it</option><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option></select></Field><Field hint="Lexical search works without a model; loaded embeddings add semantic ranking." label="Search query"><input value={query} onChange={(event) => setQuery(event.target.value)} /></Field><Button disabled={busy || props.vaultState !== 'unlocked' || !query.trim()} onClick={() => void search()}>{busy ? 'Working...' : 'Search encrypted memory'}</Button>{progress && <><Meter detail={progress.label} label="Import progress" value={progress.value} /><Button icon="pause" onClick={() => importAbortRef.current?.abort(new DOMException('Cancelled by user.', 'AbortError'))} tone="danger">Cancel source import</Button></>}{error && <Notice title="Memory operation stopped" tone="danger">{error}</Notice>}</div></Panel></div>
    {results.length > 0 && <Panel eyebrow="Retrieved suggestions" title="Verifiable passages"><div className="search-results">{results.map((result) => <article key={result.id}><div><Badge tone="info">Suggestion</Badge><code>{result.revisionId.slice(0, 12)} · {result.startOffset}-{result.endOffset}</code></div><h3>{result.title}</h3><p>{result.text}</p><small>Score {result.score.toFixed(5)}. Open the same revision from its source card below.</small></article>)}</div></Panel>}
    <Panel className="sources-panel" action={<Badge>{props.sources.length} explicit source{props.sources.length === 1 ? '' : 's'}</Badge>} eyebrow="Explicit memory" title="Sources and revision history">
      {props.sources.length === 0 ? <EmptyState action={<Button disabled={props.vaultState !== 'unlocked'} icon="upload" onClick={() => sourceInput.current?.click()}>Choose a file</Button>} icon="document" title="No explicit memories">Nothing is uploaded by this screen.</EmptyState> : <div className="source-cards">{props.sources.map((source) => <article key={source.id}><div className="source-card__header"><span><Icon name="document" /><span><strong>{source.title}</strong><small>{formatBytes(source.currentBytes)} · {source.mediaType} · {source.sensitivity}</small></span></span><Badge tone="positive">Explicit import</Badge></div><p>Current revision <InlineCode>{source.currentRevisionId}</InlineCode></p><p className="fine-print">Retention: {source.retentionUntil ? `delete after ${new Date(source.retentionUntil).toLocaleString()}` : 'until you delete it'}</p><details><summary>{source.revisionCount} revision{source.revisionCount === 1 ? '' : 's'}</summary><ol>{source.revisions.map((revision) => <li key={revision.id}><code>{revision.id}</code><span>{formatBytes(revision.bytes)} · {new Date(revision.createdAt).toLocaleString()}</span><small>SHA-256 {revision.fingerprint}</small></li>)}</ol></details><Toolbar><Button compact icon="upload" onClick={() => { setRevisionTarget(source.id); sourceInput.current?.click(); }}>Add revision</Button><Button compact icon="warning" onClick={() => void removeSource(source)} tone="danger">Delete source</Button></Toolbar></article>)}</div>}
    </Panel>
    {props.vaultState === 'unlocked' && <div className="settings-grid memory-admin"><Panel eyebrow="Scoped access" title="Source grants"><div className="panel-body form-stack"><Field label="Source"><select value={selectedGrantSource} onChange={(event) => setSelectedGrantSource(event.target.value)}><option value="">Select source</option>{props.sources.map((source) => <option key={source.id} value={source.id}>{source.title}</option>)}</select></Field><Field hint="Grant is origin-bound and expires in 30 minutes." label="Recipient"><input value={grantRecipient} onChange={(event) => setGrantRecipient(event.target.value)} /></Field><Button disabled={!selectedGrantSource || !grantRecipient.trim()} onClick={() => void issueGrant()}>Issue grant</Button><GrantList grants={props.grants} onRevoke={async (id) => { await revokeSourceGrant(id); await props.refreshPrivateState(); }} /></div></Panel><Panel eyebrow="Backup" title="Encrypted archive"><div className="panel-body form-stack"><p className="supporting-copy">The archive contains ciphertext plus a wrapped key. Its passphrase is still required.</p><Button icon="eye" onClick={() => void exportEncryptedVault().then(setExportPreview).catch((caught) => setError(describeError(caught)))}>Preview export</Button>{exportPreview && <><Notice title="Encrypted export ready" tone="info">Vault {exportPreview.header.vaultId}; {exportPreview.records.length} encrypted records; exported {new Date(exportPreview.exportedAt).toLocaleString()}.</Notice><Button icon="download" onClick={() => downloadText(`browser-cortex-vault-${Date.now()}.json`, 'application/json', JSON.stringify(exportPreview))} tone="primary">Download encrypted archive</Button></>}<Button icon="upload" onClick={() => archiveInput.current?.click()}>Import encrypted archive</Button></div></Panel></div>}
  </>;
}

function GrantList({ grants, onRevoke }: { grants: GrantSummary[]; onRevoke: (id: string) => Promise<void> }) {
  return grants.length === 0 ? <small>No source grants are stored.</small> : <div className="grant-list">{grants.map((grant) => <div key={grant.id}><span><strong>{grant.recipient}</strong><small>{grant.sourceIds.length} source{grant.sourceIds.length === 1 ? '' : 's'} · expires {new Date(grant.expiresAt).toLocaleString()}</small></span>{grant.revokedAt ? <Badge>Revoked</Badge> : <Button compact onClick={() => void onRevoke(grant.id)} tone="danger">Revoke</Button>}</div>)}</div>;
}

function WorkflowsPage(props: CommonProps) {
  const [csv, setCsv] = useState(syntheticCsv); const [instruction, setInstruction] = useState('Keep orders outside the US and export the reviewed rows.');
  const [draft, setDraft] = useState<WorkflowDraft>(); const [editor, setEditor] = useState(''); const [run, setRun] = useState<WorkflowRunReview>();
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [approvalPreview, setApprovalPreview] = useState<WorkflowApprovalPreview>();
  async function compile(): Promise<void> {
    setBusy(true); setError(''); setRun(undefined);
    try { const next = await compileCsvWorkflow(instruction, csv); setDraft(next); setEditor(next.json); setApprovalPreview(undefined); setNotice('Typed plan compiled. Edit JSON, then validate before any run.'); }
    catch (caught) { setError(describeError(caught)); } finally { setBusy(false); }
  }
  function validatedEditor(): WorkflowDraft { const next = validateWorkflowJson(editor); setDraft(next); setEditor(next.json); return next; }
  async function dryRun(): Promise<void> {
    setBusy(true); setError('');
    try { const current = validatedEditor(); const result = await dryRunWorkflow(current.validation.workflow, csv); setRun(result); setNotice('Dry run completed locally. Approval and export steps were excluded.'); props.log({ label: 'Workflow dry run completed', detail: `${result.result.receipts.length} deterministic step receipts`, route: 'deterministic', outcome: 'complete' }); }
    catch (caught) { const message = describeError(caught); setError(message); props.log({ label: 'Workflow validation failed', detail: message, route: 'system', outcome: 'failed' }); } finally { setBusy(false); }
  }
  async function approve(): Promise<void> {
    if (!approvalPreview) { setError('Review the exact export before approving it.'); return; }
    setBusy(true); setError('');
    try { const current = validatedEditor(); const result = await runApprovedWorkflow(current.validation.workflow, csv, approvalPreview.id); setRun(result); setApprovalPreview(undefined); setNotice('One-use approval was bound to this plan and exact reviewed rows. The file is prepared but not downloaded.'); await props.refreshPrivateState().catch(() => undefined); }
    catch (caught) { setError(describeError(caught)); } finally { setBusy(false); }
  }
  async function reviewApproval(): Promise<void> {
    setBusy(true); setError(''); setRun(undefined);
    try { const current = validatedEditor(); setApprovalPreview(await prepareWorkflowApproval(current.validation.workflow, csv)); setNotice('Exact deterministic export prepared in memory. Inspect every row and target before one-use approval.'); }
    catch (caught) { setApprovalPreview(undefined); setError(describeError(caught)); } finally { setBusy(false); }
  }
  async function save(): Promise<void> {
    try { const current = validatedEditor(); await saveWorkflowDraft(current.validation.workflow, csv); await props.refreshPrivateState(); props.notify('Workflow saved inside the encrypted vault.'); }
    catch (caught) { setError(describeError(caught)); }
  }
  async function reuse(id: string): Promise<void> {
    try { const next = await reuseSavedWorkflow(id, csv); setDraft(next); setEditor(next.json); setNotice('Saved workflow dependencies match this CSV header. Review it again before running.'); }
    catch (caught) { setError(describeError(caught)); setNotice('Saved workflow invalidated. No schema repair was guessed.'); }
  }
  return <>
    <PageHeader eyebrow="Readable automation" title="Typed steps, not hidden scripts" description="Compile, edit, validate, dry-run, approve, and download as separate decisions." actions={<Button disabled={busy} icon="workflow" onClick={() => void compile()} tone="primary">Compile plan</Button>} />
    <Notice title="Synthetic fixture loaded">DEMO rows are local synthetic data and are not connected to an account or external system.</Notice>
    <div className="workflow-layout"><Panel eyebrow="Inputs" title="International order review"><div className="panel-body form-stack"><Field label="Instruction"><textarea value={instruction} onChange={(event) => { setInstruction(event.target.value); setApprovalPreview(undefined); }} /></Field><Field hint="Changing a column invalidates saved dependencies instead of guessing a mapping." label="CSV input"><textarea className="code-input" value={csv} onChange={(event) => { setCsv(event.target.value); setApprovalPreview(undefined); }} /></Field>{error && <Notice title="Workflow stopped" tone="danger">{error}</Notice>}{notice && <Notice title="Workflow state" tone="info">{notice}</Notice>}</div></Panel><Panel eyebrow="Typed review" title="Editable validated definition">
      {!draft ? <EmptyState icon="workflow" title="No plan yet">Compile the synthetic request to produce typed local operations.</EmptyState> : <div className="panel-body form-stack"><Field hint="Unknown fields and invalid references are rejected by validateWorkflow." label="Workflow JSON"><textarea className="workflow-editor" value={editor} onChange={(event) => { setEditor(event.target.value); setApprovalPreview(undefined); }} /></Field><Toolbar><Button onClick={() => { try { validatedEditor(); setApprovalPreview(undefined); setNotice('Edited plan is valid.'); setError(''); } catch (caught) { setError(describeError(caught)); } }}>Validate edits</Button><Button disabled={busy} icon="play" onClick={() => void dryRun()}>Deterministic dry run</Button></Toolbar><div className="workflow-steps">{draft.validation.workflow.steps.map((step, index) => <div className="workflow-step is-ready" key={step.id}><span>{index + 1}</span><div><strong>{step.id}: {step.op}</strong><small>{JSON.stringify(step)}</small></div></div>)}</div><p className="fine-print">Capabilities: {draft.validation.requiredCapabilities.join(', ')}. Assumptions: exact CSV header, current origin, bounded rows, no inferred tools.</p></div>}
    </Panel></div>
    {draft && <Panel className="capability-panel" eyebrow="Review gate" title="Exact export approval"><div className="panel-body form-stack"><p>The export step receives only the reviewed deterministic rows. Approval is one-use, plan-bound, argument-bound, and consumed before file creation.</p><Toolbar><Button disabled={busy} icon="eye" onClick={() => void reviewApproval()}>Review exact export</Button>{approvalPreview && <Button disabled={busy} icon="key" onClick={() => void approve()} tone="primary">Approve these exact rows once</Button>}<Button disabled={props.vaultState !== 'unlocked'} icon="database" onClick={() => void save()}>Save encrypted workflow</Button></Toolbar>{approvalPreview && <div className="approval-preview"><Notice title="Local file write awaiting approval" tone="warning">Target {approvalPreview.targetFilename}; {approvalPreview.rowCount ?? 'unknown'} data rows; {formatBytes(approvalPreview.byteLength)}; expires {new Date(approvalPreview.expiresAt).toLocaleTimeString()}. Postcondition: the file is held in memory until you separately download it.</Notice><p>Content SHA-256 <InlineCode>{approvalPreview.contentSha256}</InlineCode></p><pre className="result-code">{approvalPreview.content}</pre></div>}{run && <><div className="receipt-grid">{run.result.receipts.map((receipt) => <div key={`${receipt.stepId}-${receipt.startedAt}`}><Badge tone={receipt.state === 'succeeded' ? 'positive' : 'danger'}>{receipt.state}</Badge><strong>{receipt.stepId}</strong><small>{receipt.operation} · {receipt.endedAt}</small></div>)}</div><p>Plan fingerprint <InlineCode>{run.result.planFingerprint}</InlineCode></p>{run.exportedFile && <Button icon="download" onClick={() => downloadText(run.exportedFile?.filename ?? 'reviewed-export.txt', run.exportedFile?.mediaType ?? 'text/plain', run.exportedFile?.content ?? '')} tone="primary">Download {run.exportedFile.filename} ({formatBytes(new TextEncoder().encode(run.exportedFile.content).byteLength)})</Button>}</>}</div></Panel>}
    <Panel className="saved-workflows" action={<Badge>{props.savedWorkflows.length} encrypted</Badge>} eyebrow="Reuse" title="Saved workflows and invalidation">{props.savedWorkflows.length === 0 ? <EmptyState icon="workflow" title="No saved workflow">Unlock the vault and save a validated plan.</EmptyState> : <div className="saved-list">{props.savedWorkflows.map((saved) => <div key={saved.recordId}><span><strong>{saved.name}</strong><small>{saved.workflowId}@{saved.version} · schema {saved.schemaFingerprint.slice(0, 12)}</small></span><Button compact onClick={() => void reuse(saved.recordId)}>Check and reuse</Button></div>)}</div>}</Panel>
  </>;
}

function ModelsPage(props: CommonProps) {
  return <>
    <PageHeader eyebrow="Optional local runtimes" title="Inspect, install, load, unload, or clear" description="Opening this page never downloads a model. Installation starts only after the pinned host, revision, license, reviewed bytes, and storage caveats are shown." />
    <Panel className="device-card"><div className="device-card__body"><span className={`device-orbit${'gpu' in navigator && !props.reducedMode ? ' is-ready' : ''}`}><Icon name="model" size={27} /></span><div><p className="bc-eyebrow">This browser</p><h2>{'gpu' in navigator && !props.reducedMode ? 'WebGPU interface detected' : 'Reduced mode active'}</h2><p>Interface detection is not an inference proof. Install/load failures stay visible and never trigger an online fallback.</p></div><Switch checked={props.reducedMode} description="Keep deterministic tools available without attempting local generation." label="Reduced mode" onChange={(event) => props.setReducedMode(event.target.checked)} /></div></Panel>
    <div className="models-grid"><ModelCard inspection={props.embedding} onChanged={props.refreshModels} log={props.log} notify={props.notify} /><ModelCard inspection={props.generation} onChanged={props.refreshModels} log={props.log} notify={props.notify} /></div>
    <Notice title="Storage claims are bounded">Known artifact bytes are not cache totals. Browser metadata, tokenizer/config files, compiled kernels, and duplicate runtime stores can add space. Cache deletion lists exact origin store names before confirmation.</Notice>
  </>;
}

function ModelCard({ inspection, onChanged, log, notify }: { inspection: ModelInspection; onChanged: () => void; log: CommonProps['log']; notify: CommonProps['notify'] }) {
  const kind = inspection.descriptor.kind; const descriptor: ModelDescriptor = modelDescriptor(kind);
  const [reviewing, setReviewing] = useState(false); const [progress, setProgress] = useState<RuntimeProgress>({ phase: 'waiting' });
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [cache, setCache] = useState<CacheInspection>();
  const abortRef = useRef<AbortController | undefined>(undefined);
  async function install(): Promise<void> {
    const controller = new AbortController(); abortRef.current = controller; setBusy(true); setError('');
    try { await installModel(kind, controller.signal, setProgress); onChanged(); setReviewing(false); notify(kind === 'embedding' ? `${descriptor.displayName} is loaded. Lock and unlock the vault before new imports to create semantic embeddings.` : `${descriptor.displayName} is installed and loaded.`); log({ label: `${kind} model installed`, detail: `${descriptor.modelId}@${descriptor.revision}`, route: 'system', outcome: 'complete' }); }
    catch (caught) { const cancelled = controller.signal.aborted; const message = cancelled ? 'Installation cancelled. No retry was started.' : describeError(caught); setError(message); log({ label: `Model installation ${cancelled ? 'cancelled' : 'failed'}`, detail: message, route: 'system', outcome: cancelled ? 'cancelled' : 'failed' }); }
    finally { abortRef.current = undefined; setBusy(false); onChanged(); }
  }
  async function action(name: 'load' | 'unload'): Promise<void> {
    const controller = new AbortController(); setBusy(true); setError('');
    try { if (name === 'load') await loadModel(kind, controller.signal); else await unloadModel(kind); onChanged(); notify(`Model ${name === 'load' ? 'loaded' : 'unloaded'}.`); }
    catch (caught) { setError(describeError(caught)); } finally { setBusy(false); }
  }
  async function inspectCache(): Promise<void> { try { setCache(await inspectModelCache(kind)); } catch (caught) { setError(describeError(caught)); } }
  async function clearCache(): Promise<void> {
    if (!cache) return;
    try { await deleteModelCache(kind, cache); setCache(undefined); onChanged(); notify('Reviewed model cache stores deleted.'); }
    catch (caught) { setError(describeError(caught)); }
  }
  const pct = progress.progress === undefined ? 0 : Math.round(progress.progress <= 1 ? progress.progress * 100 : progress.progress);
  return <Panel className="model-card"><div className="model-card__top"><span><Icon name={kind === 'embedding' ? 'search' : 'brain'} /></span><Badge tone={inspection.loaded ? 'positive' : inspection.installed ? 'info' : 'neutral'}>{inspection.loaded ? 'Loaded' : inspection.installed ? 'Installed, unloaded' : 'Not installed this session'}</Badge></div><h2>{descriptor.displayName}</h2><p>{kind === 'embedding' ? 'Optional semantic ranking for encrypted source search.' : 'Optional bounded local generation in a dedicated module worker.'}</p><dl><div><dt>Model ID</dt><dd>{descriptor.modelId}</dd></div><div><dt>Immutable revision</dt><dd>{descriptor.revision}</dd></div><div><dt>Known reviewed bytes</dt><dd>{formatBytes(descriptor.knownDownloadBytes)}</dd></div><div><dt>Device</dt><dd>{inspection.device}</dd></div><div><dt>Integrity state</dt><dd>{inspection.integrity}</dd></div></dl>
    {reviewing && !busy && <Notice title="Explicit installation consent" tone="warning">Host {descriptor.host}; license {descriptor.license}; known model bytes {formatBytes(descriptor.knownDownloadBytes)}{descriptor.packagedRuntimeBytes ? `; packaged executable ${formatBytes(descriptor.packagedRuntimeBytes)}` : ''}. {descriptor.storageNote}</Notice>}
    {busy && abortRef.current && <div className="model-progress"><Meter detail={progress.detail ?? progress.phase} label="User-initiated install" value={pct} /><Button compact onClick={() => abortRef.current?.abort('Cancelled by user.')} tone="danger">Cancel</Button></div>}
    {error && <Notice title="Model operation stopped" tone="danger">{error}</Notice>}
    <Toolbar>{!inspection.installed && !reviewing && <Button icon="eye" onClick={() => setReviewing(true)} tone="primary">Inspect install</Button>}{reviewing && !inspection.installed && <><Button disabled={busy} icon="download" onClick={() => void install()} tone="primary">Confirm install</Button><Button onClick={() => setReviewing(false)} tone="quiet">Cancel review</Button></>}{inspection.installed && !inspection.loaded && <Button disabled={busy} icon="play" onClick={() => void action('load')}>Load cached model</Button>}{inspection.loaded && <Button disabled={busy} icon="pause" onClick={() => void action('unload')}>Unload model</Button>}<Button icon="database" onClick={() => void inspectCache()}>Inspect cache</Button></Toolbar>
    {cache && <div className="cache-review"><Notice title="Exact deletion candidates" tone="warning">CacheStorage: {cache.cacheStorageNames.join(', ') || 'none found'}. IndexedDB: {cache.indexedDbNames.join(', ') || 'none found'}. Origin usage: {formatBytes(cache.originUsage)}. {cache.note}</Notice><Button disabled={cache.cacheStorageNames.length + cache.indexedDbNames.length === 0} icon="warning" onClick={() => void clearCache()} tone="danger">Delete listed stores</Button></div>}
  </Panel>;
}

function PrivacyPage(props: CommonProps) {
  const [sample, setSample] = useState(props.onlineDraft?.text ?? 'Contact demo.user@example.test about order PO-DEMO-1001. Never upload SAMPLE_TOKEN_FOR_TESTS.');
  const [findings, setFindings] = useState<SensitiveFinding[]>([]); const [endpoint, setEndpoint] = useState(props.onlineSession.endpoint ?? 'http://127.0.0.1:8787/v1/assist');
  const [model, setModel] = useState(props.onlineSession.modelLabel ?? 'simulated-endpoint');
  const [destination, setDestination] = useState(props.onlineSession.destination ?? 'simulated://browser-cortex/local');
  const [bearer, setBearer] = useState(''); const [simulation, setSimulation] = useState(true);
  const [preview, setPreview] = useState<DisclosurePreview>(); const [result, setResult] = useState<OnlineResult>(); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const abortRef = useRef<AbortController | undefined>(undefined); const sourceIds = props.onlineDraft?.sourceIds ?? [];
  function configure(): void {
    try { const summary = configureOnlineSession({ endpoint, modelLabel: model, destination, bearer, simulation }); props.setOnlineSession(summary); setBearer(''); setPreview(undefined); setResult(undefined); setError(''); props.notify(simulation ? 'Synthetic gateway simulation configured for this session.' : 'Online endpoint configured for this session only.'); }
    catch (caught) { setError(describeError(caught)); }
  }
  async function inspect(): Promise<void> {
    setBusy(true); setError(''); setResult(undefined);
    try { setFindings(await detectSensitive(sample)); setPreview(await prepareOnlineDisclosure(sample, sourceIds)); props.log({ label: 'Disclosure preview created', detail: 'Exact serialized bytes prepared locally; no request sent', route: 'deterministic', outcome: 'complete' }); }
    catch (caught) { setError(describeError(caught)); } finally { setBusy(false); }
  }
  async function send(): Promise<void> {
    if (!preview) return; const controller = new AbortController(); abortRef.current = controller; setBusy(true); setError('');
    try { const response = await sendPreparedDisclosure(preview.disclosure.disclosureId, controller.signal); setResult(response); setPreview(undefined); props.log({ label: preview.simulation ? 'Gateway simulation completed' : 'Approved online request completed', detail: `${preview.disclosure.payloadByteLength} approved bytes; endpoint ${preview.disclosure.endpointOrigin}`, route: 'online-model', outcome: 'complete' }); }
    catch (caught) { const cancelled = controller.signal.aborted; const message = cancelled ? 'Online request cancelled. Local work remains available.' : describeError(caught); setError(message); props.log({ label: `Online request ${cancelled ? 'cancelled' : 'failed'}`, detail: message, route: 'online-model', outcome: cancelled ? 'cancelled' : 'failed' }); }
    finally { abortRef.current = undefined; setBusy(false); }
  }
  return <>
    <PageHeader eyebrow="Data boundary" title="Exact disclosure before optional egress" description="Endpoint configuration and bearer credentials live only in page memory. Refreshing clears them. Online remains disabled by default." />
    <Panel className="mode-panel" eyebrow="Default route" title="Online inference policy"><div className="mode-options"><button className={props.onlinePolicy === 'deny' ? 'is-selected' : ''} onClick={() => props.setOnlinePolicy('deny')} type="button"><span><Icon name="lock" /></span><div><strong>Local only</strong><small>Never make an online inference request.</small></div><span className="radio-mark" /></button><button className={props.onlinePolicy === 'ask' ? 'is-selected' : ''} onClick={() => props.setOnlinePolicy('ask')} type="button"><span><Icon name="eye" /></span><div><strong>Ask before online</strong><small>Allow disclosure preparation and a fresh one-use approval.</small></div><span className="radio-mark" /></button></div></Panel>
    <div className="privacy-layout"><Panel eyebrow="Session endpoint" title="Optional online configuration"><div className="panel-body form-stack"><Field hint="HTTPS is required except loopback HTTP." label="Endpoint"><input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} /></Field><Field label="Provider model label"><input value={model} onChange={(event) => setModel(event.target.value)} /></Field><Field hint="Must match the developer-owned gateway's fixed disclosed destination." label="Fixed destination"><input value={destination} onChange={(event) => setDestination(event.target.value)} /></Field><Field hint="Held only in this component until configuration; never persisted or logged." label="Session bearer"><input autoComplete="off" type="password" value={bearer} onChange={(event) => setBearer(event.target.value)} /></Field><Switch checked={simulation} description="Returns a strict BrowserCortex response locally and performs no fetch. This is not a provider test." label="Clearly labeled gateway simulation" onChange={(event) => { setSimulation(event.target.checked); if (event.target.checked) { setModel('simulated-endpoint'); setDestination('simulated://browser-cortex/local'); } }} /><Toolbar><Button disabled={props.onlinePolicy !== 'ask'} onClick={configure} tone="primary">Configure session</Button>{props.onlineSession.configured && <Button onClick={() => { clearOnlineSession(); props.setOnlineSession(onlineSessionSummary()); setPreview(undefined); }}>Clear session</Button>}</Toolbar><Notice title={props.onlineSession.configured ? 'Session endpoint configured' : 'No online endpoint configured'} tone={props.onlineSession.configured ? 'warning' : 'positive'}>{props.onlineSession.configured ? `${props.onlineSession.simulation ? 'SIMULATION' : 'LIVE CONFIGURATION'} · ${props.onlineSession.endpoint} · ${props.onlineSession.modelLabel} · destination ${props.onlineSession.destination} · bearer ${props.onlineSession.bearerPresent ? 'present' : 'not used'}` : 'No online request can be sent.'}</Notice></div></Panel><Panel eyebrow="Candidate payload" title="Local redaction input"><div className="panel-body form-stack"><Field hint="Synthetic identifiers are preloaded. Detection can miss contextual identifiers." label="Text"><textarea value={sample} onChange={(event) => setSample(event.target.value)} /></Field><p className="fine-print">Selected source revisions: {sourceIds.length ? sourceIds.join(', ') : 'none'}</p>{error && <Notice title="Online path stopped safely" tone="danger">{error}</Notice>}<Button disabled={busy || !props.onlineSession.configured || props.onlinePolicy !== 'ask' || !sample.trim()} icon="privacy" onClick={() => void inspect()} tone="primary">Create exact disclosure</Button></div></Panel></div>
    {preview && <Panel className="disclosure-panel" eyebrow={preview.simulation ? 'SIMULATION' : 'One-use online review'} title="Exact bytes awaiting approval"><div className="disclosure-grid"><dl><div><dt>Endpoint</dt><dd>{preview.disclosure.endpoint}</dd></div><div><dt>Model</dt><dd>{preview.disclosure.modelLabel}</dd></div><div><dt>Payload bytes</dt><dd>{preview.disclosure.payloadByteLength}</dd></div><div><dt>SHA-256</dt><dd>{preview.disclosure.payloadFingerprint}</dd></div><div><dt>Expires</dt><dd>{new Date(preview.disclosure.expiresAt).toLocaleTimeString()}</dd></div><div><dt>Sources</dt><dd>{preview.disclosure.sourceRevisions.map((source) => `${source.sourceId}@${source.revision}`).join(', ') || 'none'}</dd></div></dl><div><h3>Serialized request body</h3><pre className="result-code">{preview.disclosure.serializedPayload}</pre><h3>Detected redactions</h3><p>{findings.length ? findings.map((finding) => `${finding.category} ${finding.start}:${finding.end}`).join(', ') : 'No pattern match. This is not proof of anonymity.'}</p><ul>{preview.disclosure.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul></div></div><Toolbar>{abortRef.current ? <Button icon="pause" onClick={() => abortRef.current?.abort('Cancelled by user.')} tone="danger">Cancel request</Button> : <Button disabled={busy} icon="key" onClick={() => void send()} tone="primary">Approve these exact bytes once</Button>}<Button onClick={() => { denyPreparedDisclosure(preview.disclosure.disclosureId); setPreview(undefined); setError('Disclosure denied. Nothing was sent.'); }}>Deny and discard</Button></Toolbar></Panel>}
    {result && <Panel eyebrow="Untrusted response" title="Rendered as inert text"><div className="panel-body"><pre className="safe-response">{result.displayText}</pre>{result.unresolvedPlaceholders.length > 0 && <Notice title="Unknown placeholders left unresolved" tone="warning">{result.unresolvedPlaceholders.join(', ')}</Notice>}<p className="fine-print">Response model: {result.response.model ?? 'not declared'}. Provider output cannot invoke tools or approve actions.</p></div></Panel>}
    <Panel className="boundary-panel" eyebrow="Failure behavior" title="Deny, cancel, timeout, or unavailable"><div className="boundary-flow"><FlowNode icon="document" label="Exact payload" /><span /><FlowNode icon="privacy" label="Endpoint + model" /><span /><FlowNode icon="key" label="One use" /><span /><FlowNode icon="check" label="Broker" /></div><p>Any payload, endpoint, model, source revision, policy, or expiration change invalidates approval. Failure preserves the local vault, workflow, and prompt.</p></Panel>
  </>;
}
function FlowNode({ icon, label }: { icon: IconName; label: string }) { return <div><span><Icon name={icon} /></span><strong>{label}</strong></div>; }

function ActivityPage(props: CommonProps) {
  const [filter, setFilter] = useState<'all' | 'complete' | 'failed'>('all'); const [encryptedDetails, setEncryptedDetails] = useState<Array<{ id: string; createdAt: string; value: unknown }>>([]);
  const items = props.activity.filter((item) => filter === 'all' || item.outcome === filter);
  useEffect(() => {
    if (props.vaultState === 'unlocked') void listEncryptedReceipts().then((rows) => setEncryptedDetails(rows.map((row) => ({ id: row.id, createdAt: row.createdAt, value: row.value })))).catch(() => setEncryptedDetails([]));
    else setEncryptedDetails([]);
  }, [props.vaultState, props.savedWorkflows]);
  return <><PageHeader eyebrow="Local receipts" title="Scrubbed activity, encrypted details" description="Session summaries exclude prompts, source text, bearer tokens, and response bodies. Workflow run details are encrypted when the vault is unlocked." actions={<SegmentedControl label="Filter activity" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'complete', label: 'Complete' }, { value: 'failed', label: 'Failed' }]} />} /><Panel action={<Badge>{props.vaultState !== 'unlocked' ? 'Vault locked' : `${encryptedDetails.length} encrypted detail record${encryptedDetails.length === 1 ? '' : 's'}`}</Badge>} title="Session activity">{items.length ? <ActivityList items={items} detailed /> : <EmptyState icon="activity" title="No matching activity">No sample activity is fabricated.</EmptyState>}</Panel>{props.vaultState === 'unlocked' && encryptedDetails.length > 0 && <Panel className="saved-workflows" eyebrow="Decrypted on demand" title="Encrypted workflow receipts"><div className="saved-list">{encryptedDetails.map((receipt) => <details key={receipt.id}><summary>{new Date(receipt.createdAt).toLocaleString()} · {receipt.id.slice(0, 12)}</summary><pre className="result-code">{JSON.stringify(receipt.value, null, 2)}</pre></details>)}</div></Panel>}</>;
}
function ActivityList({ items, detailed = false }: { items: ActivityItem[]; detailed?: boolean }) {
  return <div className={`activity-list${detailed ? ' activity-list--detailed' : ''}`}>{items.map((item) => <article key={item.id}><span className={`activity-icon activity-icon--${item.outcome}`}><Icon name={item.outcome === 'complete' ? 'check' : item.outcome === 'cancelled' ? 'pause' : 'warning'} /></span><div><strong>{item.label}</strong><small>{item.detail}</small></div><div><Badge tone={item.route === 'online-model' ? 'warning' : item.route === 'local-model' ? 'violet' : item.route === 'deterministic' ? 'positive' : 'neutral'}>{item.route}</Badge><time dateTime={item.at.toISOString()}>{item.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div></article>)}</div>;
}

function SettingsPage(props: CommonProps) {
  const [diagnostic, setDiagnostic] = useState<string>(); const [cleanup, setCleanup] = useState(false); const [reducedMotion, setReducedMotion] = useState(matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [persistenceMessage, setPersistenceMessage] = useState('');
  function previewDiagnostic(): void {
    setDiagnostic(JSON.stringify({
      schemaVersion: 1, createdAt: new Date().toISOString(), userAgent: navigator.userAgent,
      vault: { state: props.vaultState, sourceCount: props.sources.length, grantCount: props.grants.filter((grant) => !grant.revokedAt).length },
      models: { embedding: { installed: props.embedding.installed, loaded: props.embedding.loaded }, generation: { installed: props.generation.installed, loaded: props.generation.loaded } },
      online: { policy: props.onlinePolicy, configured: props.onlineSession.configured, simulation: props.onlineSession.simulation },
      storage: props.storage,
      activity: props.activity.map((item) => ({ at: item.at.toISOString(), label: item.label, route: item.route, outcome: item.outcome })),
      omitted: ['prompts', 'source text', 'passphrases', 'bearer credentials', 'provider responses', 'encrypted record payloads'],
    }, null, 2));
  }
  async function destroyVault(): Promise<void> {
    try { await deleteLocalVault(); props.setVaultInitializationError(undefined); props.setVaultState('not-created'); props.setSources([]); props.setGrants([]); props.setSavedWorkflows([]); setCleanup(false); props.notify('Local encrypted vault deleted. Model caches were not changed.'); }
    catch (caught) { props.notify(describeError(caught)); }
  }
  async function persistStorage(): Promise<void> {
    const result = await requestPersistentStorage();
    props.setStorage(await storageEstimate());
    setPersistenceMessage(!result.supported
      ? 'This browser does not expose the persistent-storage request API.'
      : result.granted
        ? 'Persistent origin storage is granted. The browser can still clear data when you explicitly request it.'
        : 'The browser declined persistent storage. Encrypted vault and model caches remain subject to eviction.');
  }
  return <>
    <PageHeader eyebrow="Local preferences" title="Retention, grants, and diagnostics" description="These controls do not grant a workflow or source more authority. Secrets remain session-only." />
    <div className="settings-grid"><Panel eyebrow="Session controls" title="Privacy defaults"><div className="settings-body"><Field hint="Older in-memory summaries are pruned when new activity is recorded." label="Scrubbed activity retention"><select value={props.retentionDays} onChange={(event) => props.setRetentionDays(Number(event.target.value))}><option value={1}>1 day</option><option value={7}>7 days</option><option value={30}>30 days</option></select></Field><Switch checked={reducedMotion} description="A visual preference only; it does not alter execution." label="Reduced motion" onChange={(event) => { setReducedMotion(event.target.checked); document.documentElement.classList.toggle('reduced-motion', event.target.checked); }} /><Button onClick={() => props.setActivity([])}>Purge session activity now</Button><p className="fine-print">Endpoint bearer credentials are held only in page memory and never appear in these settings.</p></div></Panel><Panel eyebrow="Active grants" title="Revoke source access"><div className="settings-body"><GrantList grants={props.grants} onRevoke={async (id) => { await revokeSourceGrant(id); await props.refreshPrivateState(); }} /></div></Panel></div>
    <Panel eyebrow="Storage durability" title="Request persistent browser storage"><div className="panel-body form-stack"><p>Current status: {props.storage.persisted ? 'persistent storage granted' : 'not confirmed'}. This applies to the whole origin, not only BrowserCortex model files or the encrypted vault.</p><Button disabled={props.storage.persisted} icon="database" onClick={() => void persistStorage()}>{props.storage.persisted ? 'Persistence already granted' : 'Ask browser for persistence'}</Button>{persistenceMessage && <Notice title="Persistence request result" tone={props.storage.persisted ? 'positive' : 'warning'}>{persistenceMessage}</Notice>}</div></Panel>
    <Panel className="diagnostic-panel" eyebrow="User-initiated support" title="Scrubbed diagnostic export"><div className="panel-body form-stack"><p>Preview before download. The export contains capability booleans and scrubbed route receipts, not task input or private content.</p><Toolbar><Button icon="eye" onClick={previewDiagnostic}>Build preview</Button>{diagnostic && <Button icon="download" onClick={() => downloadText(`browser-cortex-diagnostic-${Date.now()}.json`, 'application/json', diagnostic)}>Download previewed JSON</Button>}</Toolbar>{diagnostic && <pre className="result-code">{diagnostic}</pre>}</div></Panel>
    <Panel className="danger-zone" eyebrow="Local cleanup" title="Separate vault and model deletion"><div className="danger-zone__body"><div><p>Deleting the vault removes its origin database but cannot revoke exported files or provider-side copies. Model caches use separate reviewed controls on the Models page.</p><small>Vault {props.vaultState}; origin total {formatBytes(props.storage.usage)}.</small></div><Toolbar><Button icon="database" onClick={() => props.navigate('models')}>Review model caches</Button><Button icon="warning" onClick={() => setCleanup(true)} tone="danger">Preview vault deletion</Button></Toolbar></div>{cleanup && <div className="cleanup-confirm"><Notice title="Permanent local deletion" tone="danger">This removes encrypted sources, every revision, grants, saved workflows, and encrypted receipts. Export first if needed.</Notice><Toolbar><Button onClick={() => setCleanup(false)}>Cancel</Button><Button disabled={props.vaultState === 'not-created'} onClick={() => void destroyVault()} tone="danger">Delete encrypted vault</Button></Toolbar></div>}</Panel>
  </>;
}
