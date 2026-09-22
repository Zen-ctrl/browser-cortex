import { BoundedRuntimeScheduler } from '@browser-cortex/core';
import {
  DEFAULT_MAX_DOCUMENT_BYTES,
  createEncryptedMemory,
  type EmbeddingProvider,
  type EncryptedMemoryVault,
} from '@browser-cortex/memory';
import {
  VERIFIED_MINILM_MODEL,
  createTransformersEmbeddingRuntime,
  type TransformersEmbeddingRuntime,
} from '@browser-cortex/runtime-transformers';
import './style.css';

const VAULT_NAMESPACE = 'browser-cortex-vanilla-example';
const WORKSPACE_NAME = 'Vanilla local-search example';
const scheduler = new BoundedRuntimeScheduler({ maximumQueued: 4 });

let vault: EncryptedMemoryVault | undefined;
let workspaceId: string | undefined;
let embeddingRuntime: TransformersEmbeddingRuntime | undefined;
let modelState: 'idle' | 'review' | 'installing' | 'ready' = 'idle';
let installController: AbortController | undefined;

const syntheticNotes = [
  { name: 'delivery-update.md', text: '# Delivery update\nThe delivery date moved from October 12 to October 14 after the carrier review.' },
  { name: 'meeting-notes.md', text: '# Operations notes\nThe team accepted the revised October 14 delivery date for PO-DEMO-1001.' },
  { name: 'supplier-message.txt', text: 'Atlas Synthetic Supply confirmed quantity 120 and unit price USD 3.50.' },
];

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing example element: ${id}`);
  return element as T;
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Operation failed.';
}

function setText(id: string, text: string): void {
  byId(id).textContent = text;
}

function addEvent(text: string): void {
  const item = document.createElement('li');
  item.textContent = `${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ${text}`;
  byId<HTMLOListElement>('events').prepend(item);
}

function runtimeIsReady(): boolean {
  return embeddingRuntime?.capabilities().loaded === true;
}

const scheduledEmbeddingProvider: EmbeddingProvider = {
  modelId: VERIFIED_MINILM_MODEL.modelId,
  modelRevision: VERIFIED_MINILM_MODEL.revision,
  async embed(texts, signal) {
    const runtime = embeddingRuntime;
    if (!runtime?.capabilities().loaded) throw new Error('The reviewed embedding model is not loaded.');
    return scheduler.schedule({
      requestId: crypto.randomUUID(),
      kind: 'embedding',
      serializedInput: JSON.stringify(texts),
      ...(signal === undefined ? {} : { signal }),
      run: (scheduledSignal) => runtime.embed(texts, scheduledSignal),
    });
  },
};

async function ensureVault(): Promise<EncryptedMemoryVault> {
  if (vault) return vault;
  vault = createEncryptedMemory({
    namespace: VAULT_NAMESPACE,
    ...(runtimeIsReady() ? { embeddingProvider: scheduledEmbeddingProvider } : {}),
  });
  await vault.initialize();
  return vault;
}

async function ensureWorkspace(instance: EncryptedMemoryVault): Promise<string> {
  if (workspaceId) return workspaceId;
  const workspaces = instance.listWorkspaces();
  const workspace = workspaces.find((candidate) => candidate.name === WORKSPACE_NAME)
    ?? workspaces[0]
    ?? await instance.createWorkspace(WORKSPACE_NAME, 'internal');
  workspaceId = workspace.id;
  return workspace.id;
}

async function openVault(createNew: boolean): Promise<void> {
  const passphrase = byId<HTMLInputElement>('passphrase').value;
  if (passphrase.length < 12) {
    setText('vault-status', 'Use at least 12 characters.');
    return;
  }
  try {
    const instance = await ensureVault();
    if (createNew) await instance.create(passphrase);
    else await instance.unlock(passphrase);
    await ensureWorkspace(instance);
    byId<HTMLInputElement>('passphrase').value = '';
    setText('vault-status', `Vault unlocked. ${runtimeIsReady() ? 'New imports receive semantic embeddings.' : 'Lexical retrieval is available.'}`);
    addEvent(createNew ? 'Encrypted vault and workspace created.' : 'Encrypted vault and workspace unlocked.');
  } catch (error) {
    setText('vault-status', message(error));
    addEvent('Vault operation failed without changing online policy.');
  }
}

async function ingest(name: string, text: string, size: number): Promise<void> {
  if (size > DEFAULT_MAX_DOCUMENT_BYTES) throw new Error('The file exceeds the 20 MiB example limit.');
  const instance = await ensureVault();
  const activeWorkspace = await ensureWorkspace(instance);
  await instance.ingest({
    workspaceId: activeWorkspace,
    title: name,
    mediaType: name.toLowerCase().endsWith('.md') ? 'text/markdown' : 'text/plain',
    content: text,
  });
}

async function importFile(file: File): Promise<void> {
  try {
    if (file.size > DEFAULT_MAX_DOCUMENT_BYTES) throw new Error('The file exceeds the 20 MiB example limit.');
    if (!file.name.toLowerCase().endsWith('.txt') && !file.name.toLowerCase().endsWith('.md')) {
      throw new Error('Only .txt and .md files are accepted by this example.');
    }
    const text = await file.text();
    await ingest(file.name, text, file.size);
    renderSources([file.name]);
    addEvent(`Imported ${file.name} into encrypted local memory.`);
  } catch (error) {
    addEvent(`Import failed: ${message(error)}`);
  }
}

function renderSources(names: string[]): void {
  const list = byId<HTMLUListElement>('sources');
  if (list.children.length === 1 && list.textContent?.includes('No sources')) list.replaceChildren();
  for (const name of names) {
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = name;
    const state = document.createElement('small');
    state.textContent = runtimeIsReady() ? 'Encrypted + embedded' : 'Encrypted';
    item.append(label, state);
    list.append(item);
  }
}

async function search(query: string): Promise<void> {
  const results = byId('results');
  results.innerHTML = '<div class="empty"><strong>Searching local memory...</strong></div>';
  try {
    const instance = await ensureVault();
    const activeWorkspace = await ensureWorkspace(instance);
    const list = await instance.search({
      workspaceId: activeWorkspace,
      query,
      limit: 6,
      ...(runtimeIsReady() ? { embeddingProvider: scheduledEmbeddingProvider } : {}),
    });
    results.replaceChildren();
    if (!list.length) {
      results.innerHTML = '<div class="empty"><strong>No supporting passage found</strong><p>BrowserCortex does not invent a source when retrieval has no match.</p></div>';
    }
    for (const item of list) {
      const article = document.createElement('article');
      const meta = document.createElement('div');
      meta.textContent = item.title;
      const paragraph = document.createElement('p');
      paragraph.textContent = item.text;
      const code = document.createElement('code');
      code.textContent = `${item.chunkId} | score ${item.combinedScore.toFixed(3)}`;
      article.append(meta, paragraph, code);
      results.append(article);
    }
    addEvent(`Local ${runtimeIsReady() ? 'hybrid' : 'lexical'} search returned ${list.length} passage${list.length === 1 ? '' : 's'}.`);
  } catch (error) {
    results.replaceChildren();
    const warning = document.createElement('div');
    warning.className = 'empty error';
    warning.textContent = message(error);
    results.append(warning);
    addEvent('Search failed locally. No online fallback was attempted.');
  }
}

function resetModelReview(messageText: string): void {
  modelState = 'idle';
  installController = undefined;
  const button = byId<HTMLButtonElement>('configure-model');
  button.disabled = false;
  button.textContent = 'Review embedding download';
  setText('model-status', messageText);
}

async function installEmbedding(): Promise<void> {
  const button = byId<HTMLButtonElement>('configure-model');
  if (modelState === 'installing') {
    installController?.abort();
    return;
  }
  if (modelState === 'idle') {
    modelState = 'review';
    button.textContent = 'Download reviewed model';
    setText(
      'model-status',
      `Review: download from huggingface.co, Apache-2.0, ${VERIFIED_MINILM_MODEL.quantizedOnnx.bytes.toLocaleString()} registry-recorded ONNX bytes plus tokenizer/config. Revision ${VERIFIED_MINILM_MODEL.revision}. Transformers.js owns the browser cache; this remote cache is not independently hash-verified here.`,
    );
    return;
  }
  if (modelState !== 'review') return;

  const controller = new AbortController();
  installController = controller;
  modelState = 'installing';
  button.textContent = 'Cancel download';
  try {
    const runtime = createTransformersEmbeddingRuntime({
      modelId: VERIFIED_MINILM_MODEL.modelId,
      revision: VERIFIED_MINILM_MODEL.revision,
      cacheNamespace: 'browser-cortex-vanilla-minilm',
      dtype: 'q8',
      device: 'auto',
      allowRemoteModels: true,
    });
    let ready = false;
    for await (const event of runtime.install(VERIFIED_MINILM_MODEL.modelId, controller.signal)) {
      if (event.state === 'ready') ready = true;
      const progress = event.progress === undefined ? '' : ` ${Math.round(event.progress * 100)}%`;
      setText('model-status', `${event.state}${progress}${event.message ? `: ${event.message}` : ''}`);
      if (event.state === 'failed') throw new Error(event.message ?? 'Embedding installation failed.');
    }
    if (!ready || controller.signal.aborted) throw new DOMException('Embedding installation cancelled.', 'AbortError');
    embeddingRuntime = runtime;
    modelState = 'ready';
    installController = undefined;
    button.disabled = true;
    button.textContent = 'Embedding ready';
    if (vault) {
      await vault.dispose();
      vault = undefined;
      workspaceId = undefined;
      setText('vault-status', 'Vault locked. Unlock it again to bind the reviewed embedding provider to new imports.');
    }
    setText('model-status', 'Verified embedding loaded. Unlock the vault, then new imports and retrieval use the shared bounded scheduler.');
    addEvent('Reviewed embedding installed after explicit consent.');
  } catch (error) {
    if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      resetModelReview('Download cancelled. Nothing was retried or sent to another runtime.');
      addEvent('Embedding download cancelled without retry.');
    } else {
      resetModelReview(message(error));
      addEvent('Embedding installation failed without fallback.');
    }
  }
}

const modelId = byId<HTMLInputElement>('model-id');
modelId.value = VERIFIED_MINILM_MODEL.modelId;
modelId.readOnly = true;
const modelRevision = byId<HTMLInputElement>('model-revision');
modelRevision.value = VERIFIED_MINILM_MODEL.revision;
modelRevision.readOnly = true;
byId<HTMLButtonElement>('configure-model').textContent = 'Review embedding download';

byId('create-vault').addEventListener('click', () => void openVault(true));
byId('unlock-vault').addEventListener('click', () => void openVault(false));
byId<HTMLInputElement>('source-file').addEventListener('change', (event) => {
  const file = (event.currentTarget as HTMLInputElement).files?.[0];
  if (file) void importFile(file);
});
byId('load-synthetic').addEventListener('click', () => {
  void (async () => {
    try {
      for (const note of syntheticNotes) {
        await ingest(note.name, note.text, new TextEncoder().encode(note.text).byteLength);
      }
      renderSources(syntheticNotes.map((note) => note.name));
      addEvent('Imported three labeled synthetic notes.');
    } catch (error) {
      addEvent(`Synthetic import failed: ${message(error)}`);
    }
  })();
});
byId<HTMLFormElement>('search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const query = byId<HTMLInputElement>('query').value.trim();
  if (query) void search(query);
});
byId('configure-model').addEventListener('click', () => void installEmbedding());
