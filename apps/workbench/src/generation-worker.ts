import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm';
import { addCacheEntryIdempotently } from '@browser-cortex/runtime-webllm/worker-cache';

const nativeCacheAdd = Cache.prototype.add;
Cache.prototype.add = async function addIdempotently(request: RequestInfo | URL): Promise<void> {
  await addCacheEntryIdempotently(this, (candidate) => nativeCacheAdd.call(this, candidate), request);
};
const handler = new WebWorkerMLCEngineHandler();
const nativeFetch = globalThis.fetch.bind(globalThis);
let allowRemoteModelData = false;

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const target = new URL(rawUrl, globalThis.location.href);
  if (!allowRemoteModelData && (target.protocol === 'http:' || target.protocol === 'https:') && target.origin !== globalThis.location.origin) {
    throw new Error('MODEL_NOT_INSTALLED: a local-only load cannot fetch missing model data.');
  }
  return nativeFetch(input, init);
};

self.onmessage = (event: MessageEvent): void => {
  if (
    typeof event.data === 'object'
    && event.data !== null
    && (event.data as { type?: unknown }).type === 'browser-cortex.runtime-policy'
    && (event.data as { schemaVersion?: unknown }).schemaVersion === 1
  ) {
    allowRemoteModelData = (event.data as { allowRemoteModelData?: unknown }).allowRemoteModelData === true;
    return;
  }
  handler.onmessage(event);
};
