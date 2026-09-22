import type { JsonValue } from './json.js';
import type { RuntimeCapabilities } from './schemas.js';

export interface InstallEvent {
  readonly type: 'progress' | 'verified' | 'complete';
  readonly modelId: string;
  readonly receivedBytes: number;
  readonly totalBytes: number;
}

export interface GenerationRequest {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly modelId: string;
  readonly prompt: string;
  readonly maxOutputTokens: number;
  readonly outputSchema?: JsonValue;
}

export type ModelEvent =
  | { readonly type: 'token'; readonly requestId: string; readonly text: string }
  | { readonly type: 'complete'; readonly requestId: string; readonly finishReason: 'stop' | 'length' }
  | { readonly type: 'error'; readonly requestId: string; readonly code: string };

export interface LocalRuntime {
  capabilities(): Promise<RuntimeCapabilities>;
  install(modelId: string, signal: AbortSignal): AsyncIterable<InstallEvent>;
  load(modelId: string, signal: AbortSignal): Promise<void>;
  generate(request: GenerationRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
  unload(): Promise<void>;
  dispose(): Promise<void>;
}

export interface EmbeddingRequest {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly modelId: string;
  readonly texts: readonly string[];
}

export interface EmbeddingResult {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly modelId: string;
  readonly modelRevision: string;
  readonly dimensions: number;
  readonly vectors: readonly (readonly number[])[];
}

export interface EmbeddingRuntime {
  capabilities(): Promise<RuntimeCapabilities>;
  embed(request: EmbeddingRequest, signal: AbortSignal): Promise<EmbeddingResult>;
  dispose(): Promise<void>;
}
