export const VERIFIED_MINILM_MODEL = {
  modelId: "Xenova/all-MiniLM-L6-v2",
  revision: "751bff37182d3f1213fa05d7196b954e230abad9",
  license: "Apache-2.0",
  quantizedOnnx: {
    bytes: 22_972_370,
    sha256: "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1",
  },
} as const;

export interface EmbeddingInstallEvent {
  state: "resolving" | "downloading" | "loading" | "ready" | "cancelled" | "failed";
  file?: string;
  loadedBytes?: number;
  totalBytes?: number;
  progress?: number;
  message?: string;
}

export interface TransformersEmbeddingOptions {
  modelId?: string;
  revision?: string;
  cacheNamespace?: string;
  dtype?: "q8" | "fp32" | "fp16" | "q4";
  device?: "wasm" | "webgpu" | "auto";
  executionContext?: "web" | "extension";
  localRuntimeWasmPath?: string;
  allowRemoteModels?: boolean;
  localFilesOnly?: boolean;
  maxBatchSize?: number;
}

export interface EmbeddingCapabilities {
  modelId: string;
  modelRevision: string;
  loaded: boolean;
  installed: boolean;
  dimensions?: number;
  device: "wasm" | "webgpu" | "auto";
  remoteModelsAllowed: boolean;
  integrity: "runtime-managed-cache-unverified" | "local-files-unverified";
}

interface ProgressPayload {
  status?: string;
  file?: string;
  loaded?: number;
  total?: number;
  progress?: number;
}

interface TensorLike {
  tolist(): unknown;
  dispose?(): void;
}

interface FeatureExtractor {
  (texts: string | string[], options: { pooling: "mean"; normalize: true; signal?: AbortSignal }): Promise<TensorLike>;
  dispose?(): Promise<void> | void;
}

interface TransformersModule {
  env: {
    allowRemoteModels: boolean;
    allowLocalModels: boolean;
    fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    localModelPath?: string;
    backends?: { onnx?: { wasm?: { wasmPaths?: string; numThreads?: number } } };
  };
  pipeline(
    task: "feature-extraction",
    modelId: string,
    options: {
      revision: string;
      dtype: string;
      device?: "wasm" | "webgpu";
      local_files_only: boolean;
      signal?: AbortSignal;
      progress_callback: (payload: ProgressPayload) => void;
    },
  ): Promise<FeatureExtractor>;
}

let transformersEnvironmentQueue: Promise<void> = Promise.resolve();

function abortReason(signal: AbortSignal, message: string): unknown {
  return signal.reason ?? new DOMException(message, "AbortError");
}

async function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  onLateValue?: (value: T) => Promise<void> | void,
): Promise<T> {
  if (signal.aborted) throw abortReason(signal, "Embedding operation cancelled.");
  return new Promise<T>((resolve, reject) => {
    let aborted = false;
    const onAbort = (): void => {
      aborted = true;
      reject(abortReason(signal, "Embedding operation cancelled."));
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

async function withTransformersEnvironment<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  const previous = transformersEnvironmentQueue.catch(() => undefined);
  let release = (): void => undefined;
  const current = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  transformersEnvironmentQueue = previous.then(() => current);
  try {
    await abortable(previous, signal);
  } catch (error) {
    release();
    throw error;
  }
  try {
    return await operation();
  } finally {
    release();
  }
}

function cancellationAwareFetch(
  baseFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  operationSignal: AbortSignal,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const controller = new AbortController();
    const signals = [operationSignal, init?.signal].filter(
      (candidate): candidate is AbortSignal => candidate !== undefined && candidate !== null,
    );
    const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
    for (const signal of signals) {
      if (signal.aborted) {
        controller.abort(signal.reason);
        break;
      }
      const listener = (): void => controller.abort(signal.reason);
      signal.addEventListener("abort", listener, { once: true });
      listeners.push({ signal, listener });
    }
    try {
      return await baseFetch(input, { ...init, signal: controller.signal });
    } finally {
      for (const { signal, listener } of listeners) signal.removeEventListener("abort", listener);
    }
  };
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
      const next = await new Promise<IteratorResult<T>>((resolve) => this.#waiters.push(resolve));
      if (next.done) return;
      yield next.value;
    }
  }
}

type NormalizedOptions = TransformersEmbeddingOptions & { modelId: string; revision: string };

function validateOptions(options: TransformersEmbeddingOptions): NormalizedOptions {
  const normalized: NormalizedOptions = {
    ...options,
    modelId: options.modelId ?? VERIFIED_MINILM_MODEL.modelId,
    revision: options.revision ?? VERIFIED_MINILM_MODEL.revision,
  };
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(normalized.modelId)) throw new Error("A namespaced embedding model ID is required.");
  if (!/^[a-f0-9]{40}$/u.test(normalized.revision)) throw new Error("Embedding revision must be an immutable 40-character commit SHA.");
  if (options.executionContext === "extension" && !options.localRuntimeWasmPath) {
    throw new Error("Extension mode requires a packaged local ONNX Runtime WASM path.");
  }
  if (options.localRuntimeWasmPath && /^https?:/iu.test(options.localRuntimeWasmPath) && options.executionContext === "extension") {
    throw new Error("Extension runtime WASM must be packaged locally.");
  }
  return normalized;
}

function normalizedVectors(value: unknown): number[][] {
  if (!Array.isArray(value)) throw new Error("Embedding runtime returned an unsupported tensor.");
  const rows = value.length > 0 && typeof value[0] === "number" ? [value] : value;
  return rows.map((row) => {
    if (!Array.isArray(row) || row.length === 0 || !row.every((item) => typeof item === "number" && Number.isFinite(item))) {
      throw new Error("Embedding runtime returned a malformed vector.");
    }
    const vector = row as number[];
    const norm = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0));
    if (!Number.isFinite(norm) || norm === 0) throw new Error("Embedding vector has zero or invalid norm.");
    return vector.map((item) => item / norm);
  });
}

export class TransformersEmbeddingRuntime {
  readonly modelId: string;
  readonly modelRevision: string;
  readonly #options: NormalizedOptions;
  #extractor: FeatureExtractor | undefined;
  #dimensions: number | undefined;
  #loading: Promise<void> | undefined;
  #installed = false;
  #disposed = false;

  constructor(options: TransformersEmbeddingOptions) {
    this.#options = validateOptions(options);
    this.modelId = this.#options.modelId;
    this.modelRevision = this.#options.revision;
  }

  capabilities(): EmbeddingCapabilities {
    const base: EmbeddingCapabilities = {
      modelId: this.modelId,
      modelRevision: this.modelRevision,
      loaded: Boolean(this.#extractor),
      installed: this.#installed,
      device: this.#options.device ?? "auto",
      remoteModelsAllowed: this.#options.allowRemoteModels ?? !this.#options.localFilesOnly,
      integrity: this.#options.localFilesOnly ? "local-files-unverified" : "runtime-managed-cache-unverified",
    };
    return this.#dimensions === undefined ? base : { ...base, dimensions: this.#dimensions };
  }

  install(signal: AbortSignal): AsyncIterable<EmbeddingInstallEvent>;
  install(modelId: string, signal: AbortSignal): AsyncIterable<EmbeddingInstallEvent>;
  async *install(modelIdOrSignal: string | AbortSignal, maybeSignal?: AbortSignal): AsyncIterable<EmbeddingInstallEvent> {
    const signal = typeof modelIdOrSignal === "string" ? maybeSignal : modelIdOrSignal;
    if (!signal) throw new Error("An AbortSignal is required for model installation.");
    if (typeof modelIdOrSignal === "string" && modelIdOrSignal !== this.modelId) {
      throw new Error("This runtime is bound to a different immutable model configuration.");
    }
    if (this.#disposed) throw new Error("Embedding runtime is disposed.");
    const previouslyInstalled = this.#installed;
    const events = new AsyncEventQueue<EmbeddingInstallEvent>();
    const loading = this.#ensureLoaded(signal, (event) => events.push(event), true)
      .then(() => {
        this.#installed = true;
        events.push({ state: "ready", progress: 1 });
      })
      .catch((error: unknown) => {
        this.#installed = previouslyInstalled;
        if (signal.aborted) events.push({ state: "cancelled", message: "Embedding installation was cancelled." });
        else events.push({ state: "failed", message: error instanceof Error ? error.message : "Embedding installation failed." });
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

  async embed(texts: readonly string[], signal?: AbortSignal): Promise<readonly (readonly number[])[]> {
    if (this.#disposed) throw new Error("Embedding runtime is disposed.");
    if (!this.#installed) throw new Error("MODEL_NOT_INSTALLED: call install() after explicit user consent before embedding.");
    if (texts.length < 1 || texts.length > (this.#options.maxBatchSize ?? 32)) throw new Error("Embedding batch size is invalid.");
    if (texts.some((item) => item.length > 24_000)) throw new Error("Embedding input exceeds the text limit.");
    const activeSignal = signal ?? new AbortController().signal;
    await this.#ensureLoaded(activeSignal, undefined, false);
    if (activeSignal.aborted) throw activeSignal.reason ?? new DOMException("Embedding cancelled.", "AbortError");
    const pendingOutput = this.#extractor?.([...texts], { pooling: "mean", normalize: true, signal: activeSignal });
    const output = pendingOutput ? await abortable(pendingOutput, activeSignal, (late) => late.dispose?.()) : undefined;
    if (!output) throw new Error("Embedding runtime did not return output.");
    const vectors = normalizedVectors(output.tolist());
    if (vectors.length !== texts.length) throw new Error("Embedding runtime returned an unexpected batch size.");
    const firstVector = vectors[0];
    if (!firstVector) throw new Error("Embedding runtime returned an empty batch.");
    this.#dimensions ??= firstVector.length;
    if (!this.#dimensions || vectors.some((vector) => vector.length !== this.#dimensions)) throw new Error("Embedding dimensions are inconsistent.");
    return vectors;
  }

  async unload(): Promise<void> {
    await this.#extractor?.dispose?.();
    this.#extractor = undefined;
    this.#loading = undefined;
    this.#dimensions = undefined;
  }

  async dispose(): Promise<void> {
    await this.unload();
    this.#disposed = true;
  }

  async #ensureLoaded(
    signal: AbortSignal,
    onProgress: ((event: EmbeddingInstallEvent) => void) | undefined,
    installationMayFetch: boolean,
  ): Promise<void> {
    if (signal.aborted) throw signal.reason ?? new DOMException("Embedding load cancelled.", "AbortError");
    if (this.#extractor) return;
    if (this.#disposed) throw new Error("Embedding runtime is disposed.");
    this.#loading ??= this.#load(signal, onProgress, installationMayFetch).finally(() => {
      if (!this.#extractor) this.#loading = undefined;
    });
    await abortable(this.#loading, signal);
  }

  async #load(
    signal: AbortSignal,
    onProgress: ((event: EmbeddingInstallEvent) => void) | undefined,
    installationMayFetch: boolean,
  ): Promise<void> {
    onProgress?.({ state: "resolving", progress: 0 });
    const transformers = (await import("@huggingface/transformers")) as unknown as TransformersModule;
    if (signal.aborted) throw abortReason(signal, "Embedding load cancelled.");
    const extractor = await withTransformersEnvironment(signal, async () => {
      const configuredRemote = this.#options.allowRemoteModels ?? !this.#options.localFilesOnly;
      const allowRemoteModels = installationMayFetch && configuredRemote;
      const previousAllowRemoteModels = transformers.env.allowRemoteModels;
      const previousAllowLocalModels = transformers.env.allowLocalModels;
      transformers.env.allowRemoteModels = allowRemoteModels;
      // App-shell servers commonly return index.html with a 200 response for an
      // unknown /models path. Do not let that local fallback shadow the pinned
      // Hugging Face revision during a consented remote installation. Cache-only
      // and explicit local-file loads retain local access.
      transformers.env.allowLocalModels = !allowRemoteModels;
      const wasm = transformers.env.backends?.onnx?.wasm;
      const previousWasmPaths = wasm?.wasmPaths;
      const previousNumThreads = wasm?.numThreads;
      if (wasm && this.#options.localRuntimeWasmPath) wasm.wasmPaths = this.#options.localRuntimeWasmPath;
      if (wasm && this.#options.executionContext === "extension") wasm.numThreads = 1;
      const device = this.#options.device === "auto" || this.#options.device === undefined ? undefined : this.#options.device;
      const previousFetch = transformers.env.fetch;
      const baseFetch = previousFetch ?? globalThis.fetch.bind(globalThis);
      const scopedFetch = cancellationAwareFetch(baseFetch, signal);
      transformers.env.fetch = scopedFetch;
      try {
        const pendingExtractor = transformers.pipeline("feature-extraction", this.modelId, {
          revision: this.modelRevision,
          dtype: this.#options.dtype ?? "q8",
          ...(device === undefined ? {} : { device }),
          local_files_only: !allowRemoteModels,
          signal,
          progress_callback: (payload) => {
            if (signal.aborted) return;
            const progress = typeof payload.progress === "number" ? Math.max(0, Math.min(1, payload.progress > 1 ? payload.progress / 100 : payload.progress)) : undefined;
            const event: EmbeddingInstallEvent = {
              state: payload.status === "ready" ? "loading" : "downloading",
              ...(payload.file === undefined ? {} : { file: payload.file }),
              ...(payload.loaded === undefined ? {} : { loadedBytes: payload.loaded }),
              ...(payload.total === undefined ? {} : { totalBytes: payload.total }),
              ...(progress === undefined ? {} : { progress }),
            };
            onProgress?.(event);
          },
        });
        return await abortable(pendingExtractor, signal, async (late) => late.dispose?.());
      } finally {
        if (transformers.env.fetch === scopedFetch) {
          if (previousFetch) transformers.env.fetch = previousFetch;
          else delete transformers.env.fetch;
        }
        transformers.env.allowRemoteModels = previousAllowRemoteModels;
        transformers.env.allowLocalModels = previousAllowLocalModels;
        if (wasm) {
          if (previousWasmPaths === undefined) delete wasm.wasmPaths;
          else wasm.wasmPaths = previousWasmPaths;
          if (previousNumThreads === undefined) delete wasm.numThreads;
          else wasm.numThreads = previousNumThreads;
        }
      }
    });
    if (signal.aborted) {
      await extractor.dispose?.();
      throw signal.reason ?? new DOMException("Embedding load cancelled.", "AbortError");
    }
    this.#extractor = extractor;
    onProgress?.({ state: "loading", progress: 1 });
  }
}

export function createTransformersEmbeddingRuntime(options: TransformersEmbeddingOptions): TransformersEmbeddingRuntime {
  return new TransformersEmbeddingRuntime(options);
}
