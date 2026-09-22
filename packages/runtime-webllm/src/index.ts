export const VERIFIED_SMOLLM2_MODEL = {
  modelId: "SmolLM2-360M-Instruct-q4f16_1-MLC",
  modelRepository: "mlc-ai/SmolLM2-360M-Instruct-q4f16_1-MLC",
  modelRevision: "3a622fd89e0216e8bb10c410c007c786baa8a033",
  sourceModel: "HuggingFaceTB/SmolLM2-360M-Instruct",
  sourceRevision: "a10cc1512eabd3dde888204e902eca88bddb4951",
  license: "Apache-2.0",
  weightBytes: 203_614_080,
  modelLibrary: {
    filename: "SmolLM2-360M-Instruct-q4f16_1_cs1k-webgpu.wasm",
    packagedPath: "/runtime/SmolLM2-360M-Instruct-q4f16_1_cs1k-webgpu.wasm",
    upstreamRevision: "025bcaf3780fa8254f5e5efd3bfea0a5397248f4",
    webLlmConfigVersion: "v0_2_84",
    bytes: 5_708_562,
    sha256: "5c20098605780550c40e9c64d288dd6e369707a08d4133037156019b064ad41b",
    sri: "sha256-XCAJhgV4BVDEDpxk0ojdbjaXB6CNQTMDcVYBmwZK1Bs=",
  },
} as const;

export interface WebLLMModelRecord {
  model: string;
  model_id: string;
  model_lib: string;
  overrides?: Record<string, unknown>;
  vram_required_MB?: number;
  low_resource_required?: boolean;
}

export interface WebLLMAppConfig {
  model_list: WebLLMModelRecord[];
  useIndexedDBCache?: boolean;
}

export interface DiscoveredWebLLMModel {
  modelId: string;
  modelUrl: string;
  modelLibraryUrl: string;
  modelLibraryIsRemote: boolean;
  vramRequiredMb?: number;
  lowResourceRequired?: boolean;
}

export interface WebLLMRuntimeOptions {
  modelId?: string;
  modelRevision?: string;
  cacheNamespace?: string;
  executionContext?: "web" | "extension";
  appConfig?: WebLLMAppConfig;
  localModelLibUrl?: string;
  localModelLibSha256?: string;
  localModelLibSri?: string;
  workerFactory?: () => Worker;
  temperature?: number;
  maxTokens?: number;
}

type NormalizedWebLLMRuntimeOptions = WebLLMRuntimeOptions & {
  localModelLibUrl: string;
  localModelLibSha256: string;
  localModelLibSri: string;
  workerFactory: () => Worker;
};

export interface GenerationRequest {
  prompt: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
  responseSchema?: Record<string, unknown>;
}

export type GenerationEvent =
  | { type: "start"; modelId: string; modelRevision: string }
  | { type: "token"; text: string }
  | { type: "complete"; text: string; finishReason?: string; usage?: { promptTokens?: number; completionTokens?: number } }
  | { type: "cancelled" }
  | { type: "error"; code: string; message: string };

export interface ModelInstallEvent {
  state: "resolving" | "verifying-runtime" | "downloading" | "loading" | "ready" | "cancelled" | "failed";
  progress?: number;
  elapsedSeconds?: number;
  message?: string;
}

interface InitProgressReport {
  progress: number;
  timeElapsed?: number;
  text?: string;
}

interface CompletionChunk {
  choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface CompletionResponse {
  choices?: { message?: { content?: string }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface MLCEngineLike {
  chat: {
    completions: {
      create(request: Record<string, unknown>): Promise<AsyncIterable<CompletionChunk> | CompletionResponse>;
    };
  };
  interruptGenerate(): Promise<void> | void;
  unload(): Promise<void>;
}

interface WebLLMModule {
  prebuiltAppConfig: WebLLMAppConfig;
  CreateWebWorkerMLCEngine(
    worker: Worker,
    modelId: string,
    options: { appConfig: WebLLMAppConfig; initProgressCallback: (report: InitProgressReport) => void },
  ): Promise<MLCEngineLike>;
}

class AsyncEventQueue<T> {
  readonly #items: T[] = [];
  readonly #waiters: ((value: IteratorResult<T>) => void)[] = [];
  #closed = false;

  push(value: T): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.#items.push(value);
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  async *iterate(): AsyncIterable<T> {
    while (true) {
      const item = this.#items.shift();
      if (item !== undefined) {
        yield item;
        continue;
      }
      if (this.#closed) return;
      const result = await new Promise<IteratorResult<T>>((resolve) => this.#waiters.push(resolve));
      if (result.done) return;
      yield result.value;
    }
  }
}

function remoteUrl(value: string): boolean {
  return /^https?:\/\//iu.test(value);
}

function defaultWorkerFactory(): Worker {
  if (typeof Worker === "undefined") throw new Error("WORKER_UNAVAILABLE: WebLLM requires a dedicated local worker.");
  return new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "browser-cortex-webllm" });
}

function validatePackagedModelLibraryUrl(value: string, context: WebLLMRuntimeOptions["executionContext"]): void {
  const expectedPath = VERIFIED_SMOLLM2_MODEL.modelLibrary.packagedPath;
  if (context === "extension") {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error("Extension model_lib must be a packaged chrome-extension URL.");
    }
    if (parsed.protocol !== "chrome-extension:" || !parsed.hostname) {
      throw new Error("Extension model_lib must be a packaged chrome-extension URL.");
    }
    if (parsed.pathname !== expectedPath || parsed.search || parsed.hash) {
      throw new Error("Extension model_lib must be the pinned packaged runtime asset.");
    }
    return;
  }
  if (value === expectedPath || value === expectedPath.slice(1)) return;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Web model_lib must use the pinned same-origin packaged path.");
  }
  const currentOrigin = globalThis.location?.origin;
  if (!currentOrigin || parsed.origin !== currentOrigin || parsed.pathname !== expectedPath || parsed.search || parsed.hash) {
    throw new Error("Web model_lib must use the pinned same-origin packaged path.");
  }
}

function normalizedSha256(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.toLocaleLowerCase("en-US");
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new Error("Model-library SHA-256 must be 64 hexadecimal characters.");
  return normalized;
}

function sha256SriFromHex(hex: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes = new Uint8Array(hex.match(/.{2}/gu)?.map((value) => Number.parseInt(value, 16)) ?? []);
  let encoded = "";
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const a = bytes[offset] ?? 0;
    const b = bytes[offset + 1] ?? 0;
    const c = bytes[offset + 2] ?? 0;
    const triple = (a << 16) | (b << 8) | c;
    encoded += alphabet[(triple >>> 18) & 63];
    encoded += alphabet[(triple >>> 12) & 63];
    encoded += offset + 1 < bytes.length ? alphabet[(triple >>> 6) & 63] : "=";
    encoded += offset + 2 < bytes.length ? alphabet[triple & 63] : "=";
  }
  return `sha256-${encoded}`;
}

function bytesToHex(value: Uint8Array): string {
  return [...value].map((item) => item.toString(16).padStart(2, "0")).join("");
}

async function verifyModelLibrary(url: string, expectedSha256: string, signal: AbortSignal): Promise<void> {
  const response = await fetch(url, { signal, cache: "no-store", credentials: "same-origin" });
  if (!response.ok) throw new Error(`Packaged model library could not be read (${response.status}).`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 32 * 1024 * 1024) throw new Error("Model library exceeds the verification size limit.");
  const actual = bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  if (signal.aborted) throw abortReason(signal);
  if (actual !== expectedSha256) throw new Error("MODEL_INTEGRITY_FAILED: packaged model library hash mismatch.");
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Model operation cancelled.", "AbortError");
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal, onLateValue?: (value: T) => Promise<void> | void): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  return new Promise<T>((resolve, reject) => {
    let aborted = false;
    const onAbort = (): void => {
      aborted = true;
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (aborted) {
          void Promise.resolve(onLateValue?.(value)).catch(() => undefined);
          return;
        }
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        if (!aborted) reject(error);
      },
    );
  });
}

function pinnedModelUrl(): string {
  return `https://huggingface.co/${VERIFIED_SMOLLM2_MODEL.modelRepository}/resolve/${VERIFIED_SMOLLM2_MODEL.modelRevision}/`;
}

async function moduleImport(): Promise<WebLLMModule> {
  return (await import("@mlc-ai/web-llm")) as unknown as WebLLMModule;
}

export async function discoverWebLLMModels(): Promise<DiscoveredWebLLMModel[]> {
  const webllm = await moduleImport();
  return webllm.prebuiltAppConfig.model_list.filter((record) => record.model_id === VERIFIED_SMOLLM2_MODEL.modelId).map((record) => {
    const base = {
      modelId: record.model_id,
      modelUrl: pinnedModelUrl(),
      modelLibraryUrl: record.model_lib,
      modelLibraryIsRemote: remoteUrl(record.model_lib),
    };
    const withVram = record.vram_required_MB === undefined ? base : { ...base, vramRequiredMb: record.vram_required_MB };
    return record.low_resource_required === undefined ? withVram : { ...withVram, lowResourceRequired: record.low_resource_required };
  });
}

function selectedConfig(module: WebLLMModule, options: WebLLMRuntimeOptions, modelId: string): WebLLMAppConfig {
  const source = options.appConfig ?? module.prebuiltAppConfig;
  const selected = source.model_list.find((record) => record.model_id === modelId);
  if (!selected) throw new Error(`WebLLM package configuration does not contain ${modelId}.`);
  const modelLibrary = options.localModelLibUrl;
  if (!modelLibrary) throw new Error("A pinned packaged model_lib URL is required.");
  const record: WebLLMModelRecord = {
    ...selected,
    model: modelId === VERIFIED_SMOLLM2_MODEL.modelId ? pinnedModelUrl() : selected.model,
    model_lib: modelLibrary,
  };
  return { ...source, model_list: [record] };
}

function finishReason(value: string | null | undefined): string | undefined {
  return value === null || value === undefined ? undefined : value;
}

function completionUsage(
  value: { prompt_tokens?: number; completion_tokens?: number } | undefined,
): { promptTokens?: number; completionTokens?: number } | undefined {
  if (!value) return undefined;
  return {
    ...(value.prompt_tokens === undefined ? {} : { promptTokens: value.prompt_tokens }),
    ...(value.completion_tokens === undefined ? {} : { completionTokens: value.completion_tokens }),
  };
}

export class WebLLMRuntime {
  readonly modelId: string;
  readonly modelRevision: string;
  readonly #options: NormalizedWebLLMRuntimeOptions;
  #engine: MLCEngineLike | undefined;
  #worker: Worker | undefined;
  #removeWorkerFailureListeners: (() => void) | undefined;
  #loading: Promise<void> | undefined;
  #installed = false;
  #modelLibraryVerified = false;
  #disposed = false;

  constructor(options: WebLLMRuntimeOptions = {}) {
    const defaultPackagedUrl = VERIFIED_SMOLLM2_MODEL.modelLibrary.packagedPath;
    const localModelLibUrl = options.localModelLibUrl ?? (options.executionContext === "extension" ? undefined : defaultPackagedUrl);
    if (!localModelLibUrl) throw new Error("A packaged local model_lib URL is required.");
    this.#options = {
      ...options,
      localModelLibUrl,
      localModelLibSha256: options.localModelLibSha256 ?? VERIFIED_SMOLLM2_MODEL.modelLibrary.sha256,
      localModelLibSri: options.localModelLibSri ?? VERIFIED_SMOLLM2_MODEL.modelLibrary.sri,
      workerFactory: options.workerFactory ?? defaultWorkerFactory,
    };
    this.modelId = options.modelId ?? VERIFIED_SMOLLM2_MODEL.modelId;
    this.modelRevision = options.modelRevision ?? VERIFIED_SMOLLM2_MODEL.modelRevision;
    if (this.modelId !== VERIFIED_SMOLLM2_MODEL.modelId) throw new Error("Unsupported WebLLM model ID; only the pinned reviewed model is enabled.");
    if (this.modelRevision !== VERIFIED_SMOLLM2_MODEL.modelRevision) throw new Error("Generation model revision does not match the pinned reviewed revision.");
    const hash = normalizedSha256(this.#options.localModelLibSha256);
    if (hash !== VERIFIED_SMOLLM2_MODEL.modelLibrary.sha256 || this.#options.localModelLibSri !== VERIFIED_SMOLLM2_MODEL.modelLibrary.sri) {
      throw new Error("Model-library integrity metadata does not match the pinned reviewed asset.");
    }
    if (this.#options.localModelLibSri !== sha256SriFromHex(hash)) throw new Error("Model-library SRI does not match its SHA-256 value.");
    validatePackagedModelLibraryUrl(this.#options.localModelLibUrl, this.#options.executionContext);
  }

  capabilities(): {
    modelId: string;
    modelRevision: string;
    installed: boolean;
    loaded: boolean;
    workerHosted: boolean;
    extensionSafeExecutableAssets: boolean;
    modelLibraryIntegrity: "pending-verification" | "verified";
  } {
    return {
      modelId: this.modelId,
      modelRevision: this.modelRevision,
      installed: this.#installed,
      loaded: Boolean(this.#engine),
      workerHosted: true,
      extensionSafeExecutableAssets: this.#options.executionContext !== "extension" || this.#modelLibraryVerified,
      modelLibraryIntegrity: this.#modelLibraryVerified ? "verified" : "pending-verification",
    };
  }

  install(signal: AbortSignal): AsyncIterable<ModelInstallEvent>;
  install(modelId: string, signal: AbortSignal): AsyncIterable<ModelInstallEvent>;
  async *install(modelIdOrSignal: string | AbortSignal, maybeSignal?: AbortSignal): AsyncIterable<ModelInstallEvent> {
    const signal = typeof modelIdOrSignal === "string" ? maybeSignal : modelIdOrSignal;
    if (!signal) throw new Error("An AbortSignal is required for model installation.");
    if (typeof modelIdOrSignal === "string" && modelIdOrSignal !== this.modelId) {
      throw new Error("This runtime is bound to a different immutable model configuration.");
    }
    if (this.#disposed) throw new Error("Generation runtime is disposed.");
    const previouslyInstalled = this.#installed;
    const events = new AsyncEventQueue<ModelInstallEvent>();
    const loading = this.#ensureLoaded(signal, (event) => events.push(event), true)
      .then(() => {
        this.#installed = true;
        events.push({ state: "ready", progress: 1 });
      })
      .catch((error: unknown) => {
        this.#installed = previouslyInstalled;
        if (signal.aborted) events.push({ state: "cancelled", message: "Model installation was cancelled." });
        else events.push({ state: "failed", message: errorMessage(error, "Model installation failed.") });
      })
      .finally(() => events.close());
    for await (const event of events.iterate()) yield event;
    await loading;
  }

  async load(signal: AbortSignal): Promise<void>;
  async load(modelId: string, signal: AbortSignal): Promise<void>;
  async load(modelIdOrSignal: string | AbortSignal, maybeSignal?: AbortSignal): Promise<void> {
    const signal = typeof modelIdOrSignal === "string" ? maybeSignal : modelIdOrSignal;
    if (!signal) throw new Error("An AbortSignal is required for model loading.");
    if (typeof modelIdOrSignal === "string" && modelIdOrSignal !== this.modelId) throw new Error("Runtime model ID mismatch.");
    if (!this.#installed) throw new Error("MODEL_NOT_INSTALLED: call install() after explicit user consent before loading.");
    await this.#ensureLoaded(signal, undefined, false);
  }

  async *generate(request: GenerationRequest, signal: AbortSignal): AsyncIterable<GenerationEvent> {
    if (!this.#installed) throw new Error("MODEL_NOT_INSTALLED: call install() after explicit user consent before generation.");
    if (request.prompt.length < 1 || request.prompt.length > 24_000) throw new Error("Generation prompt is empty or too long.");
    if (request.system && request.system.length > 8_000) throw new Error("System instruction is too long.");
    const temperature = request.temperature ?? this.#options.temperature ?? 0.2;
    const maxTokens = request.maxTokens ?? this.#options.maxTokens ?? 512;
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new Error("Generation temperature is invalid.");
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 2_048) throw new Error("Generation token limit is invalid.");
    await this.#ensureLoaded(signal, undefined, false);
    const engine = this.#engine;
    if (!engine) throw new Error("Generation runtime did not initialize.");
    const onAbort = (): void => {
      try {
        void Promise.resolve(engine.interruptGenerate()).catch(() => undefined);
      } catch {
        // Worker termination below is the authoritative cancellation fallback.
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    yield { type: "start", modelId: this.modelId, modelRevision: this.modelRevision };
    try {
      const messages = [
        ...(request.system ? [{ role: "system", content: request.system }] : []),
        { role: "user", content: request.prompt },
      ];
      const response = await abortable(engine.chat.completions.create({
        messages,
        stream: true,
        temperature,
        max_tokens: maxTokens,
        ...(request.responseSchema
          ? { response_format: { type: "json_object", schema: JSON.stringify(request.responseSchema) } }
          : {}),
      }), signal);
      if (!(Symbol.asyncIterator in Object(response))) {
        const complete = response as CompletionResponse;
        const content = complete.choices?.[0]?.message?.content ?? "";
        const reason = finishReason(complete.choices?.[0]?.finish_reason);
        const normalizedUsage = completionUsage(complete.usage);
        yield {
          type: "complete",
          text: content,
          ...(reason === undefined ? {} : { finishReason: reason }),
          ...(normalizedUsage === undefined ? {} : { usage: normalizedUsage }),
        };
        return;
      }
      let text = "";
      let reason: string | undefined;
      let usage: CompletionChunk["usage"];
      const iterator = (response as AsyncIterable<CompletionChunk>)[Symbol.asyncIterator]();
      while (true) {
        const next = await abortable(iterator.next(), signal);
        if (next.done) break;
        const chunk = next.value;
        if (signal.aborted) {
          this.#resetAfterRuntimeFailure(engine);
          yield { type: "cancelled" };
          return;
        }
        const token = chunk.choices?.[0]?.delta?.content ?? "";
        if (token) {
          text += token;
          yield { type: "token", text: token };
        }
        reason = finishReason(chunk.choices?.[0]?.finish_reason) ?? reason;
        usage = chunk.usage ?? usage;
      }
      if (signal.aborted) {
        this.#resetAfterRuntimeFailure(engine);
        yield { type: "cancelled" };
        return;
      }
      const normalizedUsage = completionUsage(usage);
      yield {
        type: "complete",
        text,
        ...(reason === undefined ? {} : { finishReason: reason }),
        ...(normalizedUsage === undefined ? {} : { usage: normalizedUsage }),
      };
    } catch (error) {
      if (signal.aborted) {
        this.#resetAfterRuntimeFailure(engine);
        yield { type: "cancelled" };
      }
      else {
        this.#resetAfterRuntimeFailure(engine);
        yield { type: "error", code: "GENERATION_FAILED", message: errorMessage(error, "Generation failed.") };
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async unload(): Promise<void> {
    const engine = this.#engine;
    const worker = this.#worker;
    this.#engine = undefined;
    this.#loading = undefined;
    this.#worker = undefined;
    this.#removeWorkerFailureListeners?.();
    this.#removeWorkerFailureListeners = undefined;
    try {
      await engine?.unload();
    } finally {
      worker?.terminate();
    }
  }

  async dispose(): Promise<void> {
    await this.unload();
    this.#disposed = true;
  }

  async #ensureLoaded(
    signal: AbortSignal,
    progress: ((event: ModelInstallEvent) => void) | undefined,
    installationMayFetch: boolean,
  ): Promise<void> {
    if (signal.aborted) throw signal.reason ?? new DOMException("Model load cancelled.", "AbortError");
    if (this.#engine) return;
    if (this.#disposed) throw new Error("Generation runtime is disposed.");
    this.#loading ??= this.#load(signal, progress, installationMayFetch).finally(() => {
      if (!this.#engine) this.#loading = undefined;
    });
    await abortable(this.#loading, signal);
  }

  async #load(
    signal: AbortSignal,
    progress: ((event: ModelInstallEvent) => void) | undefined,
    installationMayFetch: boolean,
  ): Promise<void> {
    progress?.({ state: "resolving", progress: 0 });
    const expectedHash = normalizedSha256(this.#options.localModelLibSha256);
    if (!this.#options.localModelLibUrl || !expectedHash) throw new Error("Pinned model-library metadata is unavailable.");
    progress?.({ state: "verifying-runtime", progress: 0 });
    await verifyModelLibrary(this.#options.localModelLibUrl, expectedHash, signal);
    this.#modelLibraryVerified = true;
    const webllm = await moduleImport();
    if (signal.aborted) throw abortReason(signal);
    const appConfig = selectedConfig(webllm, this.#options, this.modelId);
    const initProgressCallback = (report: InitProgressReport): void => {
      progress?.({
        state: report.progress >= 1 ? "loading" : "downloading",
        progress: Math.max(0, Math.min(1, report.progress)),
        ...(report.timeElapsed === undefined ? {} : { elapsedSeconds: report.timeElapsed }),
        ...(report.text === undefined ? {} : { message: report.text }),
      });
    };
    const workerFactory = this.#options.workerFactory;
    if (!workerFactory) throw new Error("WORKER_UNAVAILABLE: WebLLM requires a dedicated local worker.");
    const worker = workerFactory();
    worker.postMessage({
      type: "browser-cortex.runtime-policy",
      schemaVersion: 1,
      allowRemoteModelData: installationMayFetch,
    });
    this.#worker = worker;
    const onAbort = (): void => worker.terminate();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const pendingEngine = webllm.CreateWebWorkerMLCEngine(worker, this.modelId, { appConfig, initProgressCallback });
      const engine = await abortable(pendingEngine, signal, async (late) => late.unload());
      if (signal.aborted) {
        worker.terminate();
        throw abortReason(signal);
      }
      this.#engine = engine;
      const onWorkerFailure = (): void => {
        this.#resetAfterRuntimeFailure(engine);
      };
      worker.addEventListener("error", onWorkerFailure);
      worker.addEventListener("messageerror", onWorkerFailure);
      this.#removeWorkerFailureListeners = () => {
        worker.removeEventListener("error", onWorkerFailure);
        worker.removeEventListener("messageerror", onWorkerFailure);
      };
    } catch (error) {
      if (this.#worker === worker) this.#worker = undefined;
      worker.terminate();
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  #resetAfterRuntimeFailure(failedEngine: MLCEngineLike): void {
    if (this.#engine !== failedEngine) return;
    const worker = this.#worker;
    this.#engine = undefined;
    this.#loading = undefined;
    this.#worker = undefined;
    this.#removeWorkerFailureListeners?.();
    this.#removeWorkerFailureListeners = undefined;
    worker?.terminate();
    void failedEngine.unload().catch(() => {
      // The runtime is already invalidated; a failed best-effort unload must not
      // restore a crashed engine or hide the original generation failure.
    });
  }
}

export function createWebLLMRuntime(options: WebLLMRuntimeOptions = {}): WebLLMRuntime {
  return new WebLLMRuntime(options);
}
