import { BoundedRuntimeScheduler } from '@browser-cortex/core';
import {
  createEncryptedMemory,
  type DocumentRecord,
  type EncryptedMemoryVault,
  type SearchResult,
  type VaultStatus,
} from '@browser-cortex/memory';
import {
  VERIFIED_SMOLLM2_MODEL,
  createWebLLMRuntime,
  type ModelInstallEvent,
  type WebLLMRuntime,
} from '@browser-cortex/runtime-webllm';
import { parseCompiledDemoWorkflow, type CompiledDemoWorkflow } from '../shared/demo-contract';

const MODEL_LIBRARY_FILENAME = VERIFIED_SMOLLM2_MODEL.modelLibrary.filename;
const MODEL_HOST_PERMISSIONS = [
  'https://huggingface.co/*',
  'https://*.huggingface.co/*',
  'https://cdn-lfs.huggingface.co/*',
  'https://*.xethub.hf.co/*',
  'https://*.hf.co/*',
];
export const MODEL_LIBRARY_SHA256 = VERIFIED_SMOLLM2_MODEL.modelLibrary.sha256;
export const MODEL_LIBRARY_SRI = VERIFIED_SMOLLM2_MODEL.modelLibrary.sri;
export const PACKAGED_MODEL = Object.freeze({
  id: VERIFIED_SMOLLM2_MODEL.modelId,
  revision: VERIFIED_SMOLLM2_MODEL.modelRevision,
  displayName: 'SmolLM2 360M Instruct q4f16 MLC',
  host: 'huggingface.co',
  license: VERIFIED_SMOLLM2_MODEL.license,
  weightBytes: VERIFIED_SMOLLM2_MODEL.weightBytes,
  runtimeBytes: VERIFIED_SMOLLM2_MODEL.modelLibrary.bytes,
});

const runtimeScheduler = new BoundedRuntimeScheduler({ maximumQueued: 4 });
let generationRuntime: WebLLMRuntime | undefined;
let extensionVault: EncryptedMemoryVault | undefined;
let extensionWorkspaceId: string | undefined;
const VAULT_PLAINTEXT_INVALIDATED_EVENT = 'browser-cortex:vault-plaintext-invalidated';

export interface ExtensionCaptureInput {
  readonly title: string;
  readonly text: string;
  readonly origin?: string;
  readonly sourceUrl?: string;
}

export interface ExtensionSourceSummary {
  readonly id: string;
  readonly title: string;
  readonly mediaType: string;
  readonly sourceOrigin?: string;
  readonly sourceUrl?: string;
  readonly updatedAt: string;
  readonly byteLength: number;
  readonly preview: string;
}

export interface SavedExtensionWorkflow {
  readonly source: ExtensionSourceSummary;
  readonly compiled: CompiledDemoWorkflow;
}

export function localModelLibrary(): { url: string; sha256: string; integrity: string; filename: string } {
  return {
    url: chrome.runtime.getURL(`runtime/${MODEL_LIBRARY_FILENAME}`),
    sha256: MODEL_LIBRARY_SHA256,
    integrity: MODEL_LIBRARY_SRI,
    filename: MODEL_LIBRARY_FILENAME,
  };
}

export async function requestModelDownloadPermission(): Promise<boolean> {
  return chrome.permissions.request({ origins: MODEL_HOST_PERMISSIONS });
}

function createPackagedGenerationRuntime(): WebLLMRuntime {
  const modelLibrary = localModelLibrary();
  return createWebLLMRuntime({
    modelId: PACKAGED_MODEL.id,
    modelRevision: PACKAGED_MODEL.revision,
    executionContext: 'extension',
    localModelLibUrl: modelLibrary.url,
    localModelLibSha256: modelLibrary.sha256,
    localModelLibSri: modelLibrary.integrity,
    workerFactory: () => new Worker(new URL('./generation-worker.ts', import.meta.url), {
      type: 'module',
      name: 'browser-cortex-extension-generation',
    }),
  });
}

export async function installPackagedGenerationRuntime(
  signal: AbortSignal,
  onProgress: (event: ModelInstallEvent) => void,
): Promise<void> {
  const runtime = createPackagedGenerationRuntime();
  let ready = false;
  try {
    for await (const event of runtime.install(PACKAGED_MODEL.id, signal)) {
      onProgress(event);
      if (event.state === 'ready') ready = true;
      if (event.state === 'failed') throw new Error(event.message ?? 'Model installation failed.');
      if (event.state === 'cancelled') throw signal.reason ?? new DOMException('Model installation was cancelled.', 'AbortError');
    }
    if (signal.aborted) throw signal.reason ?? new DOMException('Model installation was cancelled.', 'AbortError');
    if (!ready || !runtime.capabilities().loaded || !runtime.capabilities().workerHosted) {
      throw new Error('The packaged worker runtime did not reach a verified ready state.');
    }
    await generationRuntime?.dispose();
    generationRuntime = runtime;
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

export async function runPackagedGeneration(prompt: string, signal: AbortSignal): Promise<string> {
  const runtime = generationRuntime;
  if (!runtime?.capabilities().loaded || !runtime.capabilities().workerHosted) throw new Error('Install the packaged worker runtime first.');
  return runtimeScheduler.schedule({
    requestId: crypto.randomUUID(),
    kind: 'generation',
    serializedInput: prompt,
    signal,
    run: async (scheduledSignal) => {
      let answer = '';
      let completed = false;
      for await (const event of runtime.generate({
        prompt,
        system: 'Return a short local-only response. Never claim tool authority or external side effects.',
        maxTokens: 128,
      }, scheduledSignal)) {
        if (event.type === 'token') answer += event.text;
        if (event.type === 'complete') { answer = event.text || answer; completed = true; }
        if (event.type === 'error') throw new Error(event.message);
        if (event.type === 'cancelled') throw scheduledSignal.reason ?? new DOMException('Generation was cancelled.', 'AbortError');
      }
      if (!completed) throw new Error('The worker did not complete its response.');
      return answer;
    },
  });
}

export async function unloadPackagedGenerationRuntime(): Promise<void> {
  await generationRuntime?.dispose();
  generationRuntime = undefined;
}

async function ensureExtensionWorkspace(vault: EncryptedMemoryVault): Promise<void> {
  if (extensionWorkspaceId) return;
  const workspaces = vault.listWorkspaces();
  const workspace = workspaces.find((candidate) => candidate.name === 'Extension captures')
    ?? workspaces[0]
    ?? await vault.createWorkspace('Extension captures', 'sensitive');
  extensionWorkspaceId = workspace.id;
}

async function ensureVaultInstance(): Promise<EncryptedMemoryVault> {
  if (!extensionVault) {
    extensionVault = createEncryptedMemory({ namespace: `browser-cortex-extension-${chrome.runtime.id}` });
    await extensionVault.initialize();
  }
  return extensionVault;
}

function requireUnlockedVault(): { vault: EncryptedMemoryVault; workspaceId: string } {
  if (!extensionVault || !extensionWorkspaceId) throw new Error('Unlock the extension vault first.');
  return { vault: extensionVault, workspaceId: extensionWorkspaceId };
}

export async function openExtensionVault(passphrase: string, createNew: boolean): Promise<void> {
  const vault = await ensureVaultInstance();
  if (createNew) await vault.create(passphrase);
  else await vault.unlock(passphrase);
  await ensureExtensionWorkspace(vault);
}

export async function extensionVaultStatus(): Promise<VaultStatus> {
  return (await ensureVaultInstance()).status();
}

export async function saveExtensionCapture(input: ExtensionCaptureInput): Promise<ExtensionSourceSummary> {
  const { vault, workspaceId } = requireUnlockedVault();
  const text = input.text.trim();
  if (!text || new TextEncoder().encode(text).byteLength > 512 * 1024) {
    throw new Error('The reviewed capture is empty or exceeds the extension save limit.');
  }
  const origin = input.origin ? new URL(input.origin).origin : undefined;
  const result = await vault.ingest({
    workspaceId,
    title: input.title.trim().slice(0, 256) || 'Reviewed page capture',
    mediaType: 'text/plain',
    content: text,
    sensitivity: 'sensitive',
    ...(origin ? { sourceOrigin: origin } : {}),
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
  });
  const document = vault.listDocuments(workspaceId).find((candidate) => candidate.id === result.documentId);
  if (!document) throw new Error('The encrypted capture was saved but could not be reopened.');
  return summarizeDocument(vault, document);
}

export function listExtensionSources(): ExtensionSourceSummary[] {
  const { vault, workspaceId } = requireUnlockedVault();
  return vault.listDocuments(workspaceId).map((document) => summarizeDocument(vault, document));
}

export async function searchExtensionSources(query: string): Promise<SearchResult[]> {
  const { vault, workspaceId } = requireUnlockedVault();
  const value = query.trim();
  if (!value || value.length > 2_000) throw new Error('Enter a bounded local search query.');
  return vault.search({ workspaceId, query: value, limit: 12 });
}

export async function deleteExtensionSource(documentId: string): Promise<number> {
  const { vault } = requireUnlockedVault();
  const deleted = await vault.deleteSource(documentId);
  invalidateVaultPlaintextViews();
  return deleted;
}

export async function exportExtensionVault(): Promise<string> {
  const { vault } = requireUnlockedVault();
  return JSON.stringify(await vault.exportEncrypted());
}

export async function importExtensionVault(serialized: string, passphrase: string): Promise<void> {
  if (new TextEncoder().encode(serialized).byteLength > 64 * 1024 * 1024) {
    throw new Error('The encrypted archive exceeds the extension import limit.');
  }
  let archive: unknown;
  try {
    archive = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error('The selected file is not a valid encrypted vault archive.');
  }
  const vault = await ensureVaultInstance();
  await vault.importEncrypted(archive, passphrase);
  extensionWorkspaceId = undefined;
  await ensureExtensionWorkspace(vault);
  invalidateVaultPlaintextViews();
}

export async function saveExtensionWorkflow(compiledInput: unknown): Promise<SavedExtensionWorkflow> {
  const compiled = await parseCompiledDemoWorkflow(compiledInput);
  const { vault, workspaceId } = requireUnlockedVault();
  const result = await vault.ingest({
    workspaceId,
    title: `Recorded workflow: ${compiled.workflow.name}`,
    mediaType: 'application/json',
    content: JSON.stringify(compiled),
    sensitivity: 'sensitive',
    sourceOrigin: compiled.replay.origin,
  });
  const document = vault.listDocuments(workspaceId).find((candidate) => candidate.id === result.documentId);
  if (!document) throw new Error('The encrypted workflow was saved but could not be reopened.');
  return { source: summarizeDocument(vault, document), compiled };
}

export async function listExtensionWorkflows(): Promise<SavedExtensionWorkflow[]> {
  const { vault, workspaceId } = requireUnlockedVault();
  const saved: SavedExtensionWorkflow[] = [];
  for (const document of vault.listDocuments(workspaceId)) {
    if (document.mediaType !== 'application/json' || !document.title.startsWith('Recorded workflow: ')) continue;
    const revision = vault.getRevision(document.currentRevisionId);
    if (!revision) continue;
    try {
      const compiled = await parseCompiledDemoWorkflow(JSON.parse(revision.originalText) as unknown);
      saved.push({ source: summarizeDocument(vault, document), compiled });
    } catch {
      // Invalid or obsolete JSON remains an ordinary encrypted source, not an executable workflow.
    }
  }
  return saved;
}

function summarizeDocument(vault: EncryptedMemoryVault, document: DocumentRecord): ExtensionSourceSummary {
  const revision = vault.getRevision(document.currentRevisionId);
  if (!revision) throw new Error('An encrypted source revision is missing.');
  const preview = revision.originalText.replace(/\s+/gu, ' ').trim().slice(0, 180);
  return {
    id: document.id,
    title: document.title,
    mediaType: document.mediaType,
    updatedAt: document.updatedAt,
    byteLength: revision.byteLength,
    preview,
    ...(document.sourceOrigin ? { sourceOrigin: document.sourceOrigin } : {}),
    ...(document.sourceUrl ? { sourceUrl: document.sourceUrl } : {}),
  };
}

export function lockExtensionVault(): void {
  const active = extensionVault;
  active?.lock();
  extensionVault = undefined;
  extensionWorkspaceId = undefined;
  invalidateVaultPlaintextViews();
  void active?.dispose().catch(() => undefined);
}

export function onVaultPlaintextInvalidated(listener: () => void): () => void {
  globalThis.addEventListener(VAULT_PLAINTEXT_INVALIDATED_EVENT, listener);
  return () => globalThis.removeEventListener(VAULT_PLAINTEXT_INVALIDATED_EVENT, listener);
}

function invalidateVaultPlaintextViews(): void {
  globalThis.dispatchEvent(new Event(VAULT_PLAINTEXT_INVALIDATED_EVENT));
}
