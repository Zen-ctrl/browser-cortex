import { useEffect, useRef, useState } from 'react';
import { Badge, Button, EmptyState, Field, Icon, Notice, SegmentedControl } from '@browser-cortex/ui';
import type { SearchResult } from '@browser-cortex/memory';
import {
  deleteExtensionSource,
  exportExtensionVault,
  extensionVaultStatus,
  importExtensionVault,
  listExtensionSources,
  lockExtensionVault,
  openExtensionVault,
  saveExtensionCapture,
  searchExtensionSources,
  type ExtensionSourceSummary,
} from './runtime';
import type { PageCapture } from './types';

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

export function MemoryView({ capture }: { capture: PageCapture | undefined }) {
  const [state, setState] = useState<'missing' | 'locked' | 'unlocked'>('locked');
  const [mode, setMode] = useState<'unlock' | 'create'>('unlock');
  const [passphrase, setPassphrase] = useState('');
  const [captureTitle, setCaptureTitle] = useState(capture?.title ?? 'Reviewed page capture');
  const [sources, setSources] = useState<ExtensionSourceSummary[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [pendingDelete, setPendingDelete] = useState<string>();
  const [archive, setArchive] = useState<File>();
  const [archivePassphrase, setArchivePassphrase] = useState('');
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const unlockedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const synchronizeStatus = async () => {
      try {
        const status = await extensionVaultStatus();
        if (cancelled) return;
        const wasUnlocked = unlockedRef.current;
        if (wasUnlocked && status.state !== 'unlocked') {
          unlockedRef.current = false;
          lockExtensionVault();
          setSources([]);
          setResults([]);
          setNotice('The extension vault auto-locked and plaintext workflow views were cleared.');
        }
        unlockedRef.current = status.state === 'unlocked';
        setState(status.state);
        setMode(status.state === 'missing' ? 'create' : 'unlock');
        if (status.state === 'unlocked' && !wasUnlocked) refreshSources();
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : 'Vault status is unavailable.');
      }
    };
    void synchronizeStatus();
    const timer = window.setInterval(() => void synchronizeStatus(), 5_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (capture?.title) setCaptureTitle(capture.title);
  }, [capture?.title]);

  function refreshSources() {
    try {
      setSources(listExtensionSources());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Encrypted sources could not be listed.');
    }
  }

  async function open() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await openExtensionVault(passphrase, mode === 'create');
      setPassphrase('');
      unlockedRef.current = true;
      setState('unlocked');
      refreshSources();
      setNotice(mode === 'create' ? 'The extension-owned encrypted vault was created.' : 'The extension-owned vault is unlocked for this panel session.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Vault unavailable.');
    } finally {
      setBusy(false);
    }
  }

  function lock() {
    unlockedRef.current = false;
    lockExtensionVault();
    setState('locked');
    setSources([]);
    setResults([]);
    setNotice('The extension vault is locked and plaintext keys were released.');
  }

  async function saveCapture() {
    if (!capture?.text) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const saved = await saveExtensionCapture({
        title: captureTitle,
        text: capture.text,
        ...(capture.origin ? { origin: capture.origin } : {}),
        ...(capture.url ? { sourceUrl: capture.url } : {}),
      });
      refreshSources();
      setNotice(`Saved ${saved.title} as an encrypted extension source.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The capture could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  async function search() {
    setBusy(true);
    setError('');
    try {
      setResults(await searchExtensionSources(query));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Local search failed.');
    } finally {
      setBusy(false);
    }
  }

  async function removeSource(sourceId: string) {
    if (pendingDelete !== sourceId) {
      setPendingDelete(sourceId);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const count = await deleteExtensionSource(sourceId);
      setPendingDelete(undefined);
      setResults((current) => current.filter((result) => result.documentId !== sourceId));
      refreshSources();
      setNotice(`Deleted the source and ${Math.max(0, count - 1)} dependent encrypted records from this vault.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The source could not be deleted.');
    } finally {
      setBusy(false);
    }
  }

  async function downloadExport() {
    setBusy(true);
    setError('');
    try {
      const serialized = await exportExtensionVault();
      const url = URL.createObjectURL(new Blob([serialized], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `browser-cortex-extension-vault-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setNotice('Encrypted archive exported. Its copies are outside BrowserCortex deletion control.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The encrypted archive could not be exported.');
    } finally {
      setBusy(false);
    }
  }

  async function importArchive() {
    if (!archive || !replaceConfirmed) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (archive.size > MAX_ARCHIVE_BYTES) throw new Error('The encrypted archive exceeds the 64 MiB import limit.');
      await importExtensionVault(await archive.text(), archivePassphrase);
      unlockedRef.current = true;
      setState('unlocked');
      setArchive(undefined);
      setArchivePassphrase('');
      setReplaceConfirmed(false);
      if (fileRef.current) fileRef.current.value = '';
      refreshSources();
      setNotice('Encrypted archive imported into the extension origin. The workbench remains a separate vault.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The encrypted archive could not be imported.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ext-stack">
      <section className="vault-card">
        <span className={`vault-orbit${state === 'unlocked' ? ' is-open' : ''}`}><Icon name={state === 'unlocked' ? 'key' : 'lock'} size={24} /></span>
        <h1>{state === 'unlocked' ? 'Extension vault unlocked' : state === 'missing' ? 'Create the extension vault' : 'Extension vault locked'}</h1>
        <p>This IndexedDB vault belongs to the extension origin. Websites and the workbench cannot enumerate it.</p>
        {state !== 'unlocked' ? (
          <div className="vault-form">
            <SegmentedControl label="Vault action" onChange={setMode} options={[{ value: 'unlock', label: 'Unlock' }, { value: 'create', label: 'Create new' }]} value={mode} />
            <Field label="Passphrase"><input autoComplete={mode === 'create' ? 'new-password' : 'current-password'} minLength={12} onChange={(event) => setPassphrase(event.target.value)} type="password" value={passphrase} /></Field>
            <Button disabled={busy || passphrase.length < 12} icon="key" onClick={() => void open()} tone="primary">{busy ? 'Opening...' : mode === 'create' ? 'Create vault' : 'Unlock vault'}</Button>
          </div>
        ) : (
          <div className="vault-open"><div><span>Encrypted sources</span><strong>{sources.length} in the extension workspace</strong></div><Button icon="lock" onClick={lock}>Lock now</Button></div>
        )}
        {error && <p className="ext-error">{error}</p>}
        {notice && <p className="ext-success">{notice}</p>}
      </section>

      {state === 'unlocked' && capture?.text && (
        <section className="memory-section">
          <div className="section-heading"><div><p className="ext-kicker">Explicit save</p><h2>Review the current capture</h2></div><Badge tone="warning">Not saved yet</Badge></div>
          <Field label="Encrypted source title"><input maxLength={256} onChange={(event) => setCaptureTitle(event.target.value)} value={captureTitle} /></Field>
          <blockquote>{capture.text}</blockquote>
          <dl className="compact-details"><div><dt>Origin</dt><dd>{capture.origin ?? 'Unknown'}</dd></div><div><dt>Characters</dt><dd>{capture.characters.toLocaleString()}</dd></div></dl>
          <Button disabled={busy || !captureTitle.trim()} icon="download" onClick={() => void saveCapture()} tone="primary">Save reviewed capture</Button>
        </section>
      )}

      {state === 'unlocked' && (
        <section className="memory-section">
          <div className="section-heading"><div><p className="ext-kicker">Local retrieval</p><h2>Search encrypted sources</h2></div><Badge tone="positive">Local only</Badge></div>
          <div className="inline-form"><Field label="Search query"><input maxLength={2_000} onChange={(event) => setQuery(event.target.value)} value={query} /></Field><Button disabled={busy || !query.trim()} icon="search" onClick={() => void search()}>Search</Button></div>
          {results.length > 0 && <div className="search-results">{results.map((result) => <article key={result.chunkId}><strong>{result.title}</strong><p>{result.text}</p><small>Score {result.combinedScore.toFixed(3)} · offsets {result.startOffset}-{result.endOffset}</small></article>)}</div>}
        </section>
      )}

      {state === 'unlocked' && (
        <section className="memory-section">
          <div className="section-heading"><div><p className="ext-kicker">Source inventory</p><h2>Extension-owned sources</h2></div><Badge tone="neutral">{sources.length}</Badge></div>
          {sources.length === 0 ? <EmptyState icon="document" title="No encrypted sources">Capture a page or save a reviewed recording workflow.</EmptyState> : <div className="source-list">{sources.map((source) => <article key={source.id}><div><strong>{source.title}</strong><small>{source.sourceOrigin ?? 'Extension generated'} · {formatBytes(source.byteLength)}</small><p>{source.preview}</p></div><div>{pendingDelete === source.id ? <><Button disabled={busy} onClick={() => void removeSource(source.id)} tone="danger">Confirm delete</Button><Button onClick={() => setPendingDelete(undefined)}>Cancel</Button></> : <Button icon="close" onClick={() => void removeSource(source.id)}>Delete</Button>}</div></article>)}</div>}
        </section>
      )}

      <section className="memory-section">
        <div className="section-heading"><div><p className="ext-kicker">Encrypted transfer</p><h2>Export or import</h2></div></div>
        <Notice title="Separate-origin transfer warning" tone="warning">The extension and workbench have independent storage origins. Import explicitly replaces this extension vault. Exported copies are not removed when a source is deleted here.</Notice>
        <div className="ext-actions"><Button disabled={busy || state !== 'unlocked'} icon="download" onClick={() => void downloadExport()}>Export encrypted vault</Button></div>
        <div className="vault-form">
          <Field label="Encrypted vault archive"><input accept="application/json,.json" onChange={(event) => setArchive(event.target.files?.[0])} ref={fileRef} type="file" /></Field>
          <Field label="Archive passphrase"><input autoComplete="current-password" minLength={12} onChange={(event) => setArchivePassphrase(event.target.value)} type="password" value={archivePassphrase} /></Field>
          <label className="confirm-row"><input checked={replaceConfirmed} onChange={(event) => setReplaceConfirmed(event.target.checked)} type="checkbox" /><span>I understand this replaces the extension-origin vault and does not merge with the workbench.</span></label>
          <Button disabled={busy || !archive || archivePassphrase.length < 12 || !replaceConfirmed} icon="upload" onClick={() => void importArchive()} tone="danger">Import and replace extension vault</Button>
        </div>
      </section>
    </div>
  );
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}
