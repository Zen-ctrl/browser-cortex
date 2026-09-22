import { useEffect, useRef, useState } from 'react';
import { Badge, Button, EmptyState, Field, Icon, Meter, Notice } from '@browser-cortex/ui';
import { sendBroker } from './broker';
import { MemoryView } from './MemoryView';
import { RecordView } from './RecordView';
import {
  PACKAGED_MODEL,
  installPackagedGenerationRuntime,
  localModelLibrary,
  lockExtensionVault,
  requestModelDownloadPermission,
  runPackagedGeneration,
  unloadPackagedGenerationRuntime,
} from './runtime';
import type { PageCapture, TabState } from './types';

type View = 'context' | 'memory' | 'record' | 'models';

export function PanelApp() {
  const [view, setView] = useState<View>('context');
  const [tab, setTab] = useState<TabState>({ demoSite: false, recording: false, eventCount: 0 });
  const [capture, setCapture] = useState<PageCapture>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function refresh() {
    try {
      const data = await sendBroker('panel.status');
      const tabId = numberValue(data.tabId);
      const title = stringValue(data.title);
      const url = stringValue(data.url);
      const sessionId = stringValue(data.sessionId);
      const grant = recordValue(data.grant);
      const lastRun = recordValue(data.lastRun);
      setTab({
        ...(tabId === undefined ? {} : { tabId }),
        ...(title === undefined ? {} : { title }),
        ...(url === undefined ? {} : { url }),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(grant === undefined ? {} : { grant }),
        ...(lastRun === undefined ? {} : { lastRun }),
        demoSite: data.demoSite === true,
        recording: data.recording === true,
        eventCount: numberValue(data.eventCount) ?? 0,
      });
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not inspect the active tab.');
    }
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const onPageHide = () => {
      void sendBroker('recording.discard', { active: true }).catch(() => undefined);
      lockExtensionVault();
      void unloadPackagedGenerationRuntime();
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, []);

  async function capturePage(type: 'capture.selection' | 'capture.visible-content') {
    setBusy(true);
    setError('');
    try {
      const data = await sendBroker(type);
      const title = stringValue(data.title);
      const origin = stringValue(data.origin);
      const url = stringValue(data.url);
      const source = stringValue(data.source);
      const warning = stringValue(data.warning);
      setCapture({
        text: stringValue(data.text) ?? '',
        characters: numberValue(data.characters) ?? 0,
        ...(title === undefined ? {} : { title }),
        ...(origin === undefined ? {} : { origin }),
        ...(url === undefined ? {} : { url }),
        ...(source === undefined ? {} : { source }),
        truncated: data.truncated === true,
        ...(warning === undefined ? {} : { warning }),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Capture failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ext-shell">
      <header className="ext-header"><div className="ext-brand"><span><i /><i /><i /></span><div><strong>BrowserCortex</strong><small>permissioned panel</small></div></div><Badge dot tone="positive">Local only</Badge></header>
      <div className="tab-context"><span><Icon name="eye" size={15} /></span><div><strong>{tab.title ?? 'No supported page'}</strong><small>{displayOrigin(tab.url)}</small></div>{tab.tabId !== undefined && <Badge tone="neutral">Tab {tab.tabId}</Badge>}</div>
      <nav aria-label="Panel sections" className="ext-tabs">{([['context', 'Context'], ['memory', 'Memory'], ['record', 'Record'], ['models', 'Models']] as const).map(([id, label]) => <button aria-current={view === id ? 'page' : undefined} key={id} onClick={() => setView(id)} type="button">{label}{id === 'record' && tab.recording && <span />}</button>)}</nav>
      <main>
        {error && <Notice title="Panel request failed" tone="danger">{error}</Notice>}
        <section hidden={view !== 'context'}><ContextView busy={busy} capture={capture} onCapture={capturePage} onView={setView} /></section>
        <section hidden={view !== 'memory'}><MemoryView capture={capture} /></section>
        <section hidden={view !== 'record'}><RecordView onRefresh={refresh} tab={tab} /></section>
        {view === 'models' && <ModelsView />}
      </main>
      <footer><button onClick={() => void chrome.runtime.openOptionsPage()} type="button"><Icon name="settings" size={14} />Extension settings</button><span>v0.3 beta</span></footer>
    </div>
  );
}

function ContextView({ busy, capture, onCapture, onView }: {
  busy: boolean;
  capture: PageCapture | undefined;
  onCapture: (type: 'capture.selection' | 'capture.visible-content') => void;
  onView: (view: View) => void;
}) {
  return (
    <div className="ext-stack">
      <section className="ext-intro">
        <p className="ext-kicker">Current page</p>
        <h1>Bring in only the context you choose.</h1>
        <p>Selected text and visible-content capture exclude form fields, hidden nodes, scripts, extension indicators, and known sensitive controls.</p>
        <div className="ext-actions"><Button disabled={busy} icon="document" onClick={() => onCapture('capture.selection')} tone="primary">Use selection</Button><Button disabled={busy} icon="eye" onClick={() => onCapture('capture.visible-content')}>Review visible content</Button></div>
      </section>
      {capture ? (
        <section className="capture-card">
          <div><Badge tone={capture.warning ? 'warning' : 'positive'}>{capture.source ?? 'capture'}</Badge><span>{capture.characters.toLocaleString()} characters</span></div>
          <h2>{capture.title ?? 'Captured context'}</h2>
          {capture.warning ? <Notice title="Nothing captured" tone="warning">{capture.warning}</Notice> : <blockquote>{capture.text || 'The page returned no eligible visible text.'}</blockquote>}
          {capture.truncated && <small>Capture was truncated at the bounded page-content limit.</small>}
          <div className="capture-actions"><Button disabled={!capture.text} icon="database" onClick={() => onView('memory')}>Review and save</Button><Button disabled={!capture.text} icon="workflow" onClick={() => onView('record')}>Open vetted tools</Button></div>
        </section>
      ) : (
        <EmptyState icon="document" title="No page context selected">The extension does not silently record tabs. Start with a selection or a bounded visible-content review.</EmptyState>
      )}
      <Notice title="Page text cannot grant permission">Instructions found in a page remain untrusted source material, even when they look like policy, approval, or tool declarations.</Notice>
    </div>
  );
}

function ModelsView() {
  const [status, setStatus] = useState<'idle' | 'reviewing' | 'installing' | 'ready' | 'running' | 'error'>('idle');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('Not started');
  const [progressValue, setProgressValue] = useState(0);
  const [prompt, setPrompt] = useState('Reply briefly that the local worker is ready.');
  const [output, setOutput] = useState('');
  const abortRef = useRef<AbortController | undefined>(undefined);
  const library = localModelLibrary();

  useEffect(() => () => {
    abortRef.current?.abort('Models view closed.');
    void unloadPackagedGenerationRuntime();
  }, []);

  async function install() {
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus('installing');
    setError('');
    setOutput('');
    try {
      if (!await requestModelDownloadPermission()) {
        setStatus('reviewing');
        setError('Model-host permission was not granted. No download was started.');
        return;
      }
      await installPackagedGenerationRuntime(controller.signal, (event) => {
        setProgress(event.message ?? event.state);
        if (event.progress !== undefined) setProgressValue(event.progress <= 1 ? event.progress * 100 : event.progress);
      });
      setProgress('Worker runtime ready');
      setProgressValue(100);
      setStatus('ready');
    } catch (caught) {
      setError(controller.signal.aborted ? 'Installation cancelled. No retry was started.' : caught instanceof Error ? caught.message : 'Runtime installation failed.');
      setStatus(controller.signal.aborted ? 'reviewing' : 'error');
    } finally {
      abortRef.current = undefined;
    }
  }

  async function runCheck() {
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus('running');
    setError('');
    setOutput('');
    try {
      setOutput(await runPackagedGeneration(prompt.trim(), controller.signal));
      setStatus('ready');
    } catch (caught) {
      setError(controller.signal.aborted ? 'Generation cancelled.' : caught instanceof Error ? caught.message : 'Local generation failed.');
      setStatus(controller.signal.aborted ? 'ready' : 'error');
    } finally {
      abortRef.current = undefined;
    }
  }

  async function unload() {
    await unloadPackagedGenerationRuntime();
    setStatus('idle');
    setOutput('');
    setProgress('Not started');
    setProgressValue(0);
  }

  const active = status === 'installing' || status === 'running';
  return (
    <div className="ext-stack">
      <section className="runtime-card">
        <div className="runtime-card__header"><span><Icon name="model" size={23} /></span><Badge tone={status === 'ready' ? 'positive' : active ? 'info' : status === 'error' ? 'danger' : 'neutral'}>{status === 'ready' ? 'Worker ready' : status === 'installing' ? 'Installing' : status === 'running' ? 'Generating' : 'Not installed'}</Badge></div>
        <p className="ext-kicker">Generation runtime</p><h1>One pinned worker-hosted model</h1><p>The extension accepts only the reviewed SmolLM2 configuration. Its executable model-library WASM and module worker are packaged locally; model weights are data downloaded only after confirmation.</p>
        <div className="runtime-file"><Icon name="document" size={16} /><div><strong>{library.filename}</strong><small>{library.integrity}</small></div></div>
        <dl><div><dt>Model</dt><dd>{PACKAGED_MODEL.id}</dd></div><div><dt>Revision</dt><dd>{PACKAGED_MODEL.revision}</dd></div><div><dt>License</dt><dd>{PACKAGED_MODEL.license}</dd></div></dl>
        {(status === 'reviewing' || status === 'error') && <Notice title="Confirm model download" tone="warning">Host: {PACKAGED_MODEL.host}. Known weights: {formatBytes(PACKAGED_MODEL.weightBytes)}. Packaged executable: {formatBytes(PACKAGED_MODEL.runtimeBytes)}. Tokenizer and configuration files add bytes. WebLLM owns the browser cache. Confirming may open Chrome's optional host-permission prompt; denial starts no download.</Notice>}
        {status === 'installing' && <div className="model-progress"><Meter detail={progress} label="Downloading and loading pinned assets" value={progressValue} /></div>}
        {status === 'ready' || status === 'running' ? <div className="vault-form"><Field label="Bounded local worker check"><textarea disabled={status === 'running'} maxLength={2_000} onChange={(event) => setPrompt(event.target.value)} value={prompt} /></Field>{output && <blockquote>{output}</blockquote>}</div> : null}
        {error && <p className="ext-error">{error}</p>}
        <div className="ext-actions">{status === 'idle' ? <Button icon="eye" onClick={() => setStatus('reviewing')} tone="primary">Review installation</Button> : status === 'reviewing' || status === 'error' ? <><Button icon="download" onClick={() => void install()} tone="primary">Confirm download</Button><Button onClick={() => setStatus('idle')}>Cancel review</Button></> : status === 'installing' || status === 'running' ? <Button icon="close" onClick={() => abortRef.current?.abort('Cancelled by user.')} tone="danger">Cancel</Button> : <><Button disabled={!prompt.trim()} icon="play" onClick={() => void runCheck()} tone="primary">Run in local worker</Button><Button onClick={() => void unload()}>Unload</Button></>}</div>
      </section>
      <Notice title="No remote executable fallback">A missing or mismatched packaged model library stops installation. The extension never substitutes a remote <code>model_lib</code>.</Notice>
    </div>
  );
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function displayOrigin(url: string | undefined): string {
  if (!url) return 'Open an http or https page';
  try {
    return new URL(url).origin;
  } catch {
    return 'Unsupported page';
  }
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}
