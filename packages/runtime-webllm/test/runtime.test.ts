import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebLLMRuntime, VERIFIED_SMOLLM2_MODEL } from "../src/index.js";

const webLlmMocks = vi.hoisted(() => ({
  createEngine: vi.fn(),
}));

vi.mock("@mlc-ai/web-llm", () => ({
  prebuiltAppConfig: {
    model_list: [{
      model: "unused-test-model-url",
      model_id: "SmolLM2-360M-Instruct-q4f16_1-MLC",
      model_lib: "/unused-test-runtime.wasm",
    }],
  },
  CreateWebWorkerMLCEngine: webLlmMocks.createEngine,
}));

class FakeWorker extends EventTarget {
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();
}

function verifiedDigest(): ArrayBuffer {
  return Uint8Array.from(
    VERIFIED_SMOLLM2_MODEL.modelLibrary.sha256.match(/.{2}/gu)?.map((value) => Number.parseInt(value, 16)) ?? [],
  ).buffer as ArrayBuffer;
}

function runtimeFixture(): { runtime: ReturnType<typeof createWebLLMRuntime>; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  return {
    runtime: createWebLLMRuntime({
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    }),
    workers,
  };
}

async function install(runtime: ReturnType<typeof createWebLLMRuntime>): Promise<void> {
  for await (const event of runtime.install(new AbortController().signal)) {
    if (event.state === "failed") throw new Error(event.message);
  }
}

beforeEach(() => {
  webLlmMocks.createEngine.mockReset();
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new Uint8Array([1]).buffer,
  })));
  vi.stubGlobal("crypto", {
    subtle: { digest: vi.fn(async () => verifiedDigest()) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WebLLM pinned installation boundary", () => {
  it("does not load or generate until an explicit installation completes", async () => {
    const runtime = createWebLLMRuntime();
    const signal = new AbortController().signal;

    expect(runtime.capabilities().installed).toBe(false);
    await expect(runtime.load(signal)).rejects.toThrow("MODEL_NOT_INSTALLED");
    await expect(runtime.generate({ prompt: "private prompt" }, signal).next()).rejects.toThrow("MODEL_NOT_INSTALLED");
  });

  it("keeps the runtime uninstalled when installation is already cancelled", async () => {
    const runtime = createWebLLMRuntime();
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled by user", "AbortError"));
    const events = [];

    for await (const event of runtime.install(controller.signal)) events.push(event);

    expect(events.at(-1)?.state).toBe("cancelled");
    expect(runtime.capabilities().installed).toBe(false);
  });

  it("preserves string errors returned across the worker boundary", async () => {
    webLlmMocks.createEngine.mockRejectedValueOnce("Error: detailed worker initialization failure");
    const { runtime } = runtimeFixture();
    const events = [];

    for await (const event of runtime.install(new AbortController().signal)) events.push(event);

    expect(events.at(-1)).toMatchObject({
      state: "failed",
      message: "Error: detailed worker initialization failure",
    });
    expect(runtime.capabilities().installed).toBe(false);
  });

  it("rejects unreviewed model identities, revisions, executable paths, and hashes", () => {
    expect(() => createWebLLMRuntime({ modelId: "unreviewed/model" })).toThrow("Unsupported WebLLM model ID");
    expect(() => createWebLLMRuntime({ modelRevision: "0".repeat(40) })).toThrow("pinned reviewed revision");
    expect(() => createWebLLMRuntime({ localModelLibUrl: "https://cdn.invalid/runtime.wasm" })).toThrow("same-origin packaged path");
    expect(() => createWebLLMRuntime({ localModelLibSha256: "0".repeat(64) })).toThrow("integrity metadata");
  });

  it("accepts only the pinned packaged extension executable URL", () => {
    const packagedUrl = `chrome-extension://abcdefghijklmnop${VERIFIED_SMOLLM2_MODEL.modelLibrary.packagedPath}`;
    const runtime = createWebLLMRuntime({
      executionContext: "extension",
      localModelLibUrl: packagedUrl,
      localModelLibSha256: VERIFIED_SMOLLM2_MODEL.modelLibrary.sha256,
      localModelLibSri: VERIFIED_SMOLLM2_MODEL.modelLibrary.sri,
    });

    expect(runtime.capabilities().extensionSafeExecutableAssets).toBe(false);
    expect(() => createWebLLMRuntime({
      executionContext: "extension",
      localModelLibUrl: "blob:chrome-extension://abcdefghijklmnop/arbitrary",
    })).toThrow("packaged chrome-extension URL");
  });

  it("cancels a stalled stream immediately and reloads with a fresh worker", async () => {
    async function* stalledStream(): AsyncIterable<{ choices: { delta: { content: string }; finish_reason: null }[] }> {
      yield { choices: [{ delta: { content: "first" }, finish_reason: null }] };
      await new Promise<never>(() => undefined);
    }
    async function* recoveredStream(): AsyncIterable<{ choices: { delta: { content: string }; finish_reason: string }[] }> {
      yield { choices: [{ delta: { content: "recovered" }, finish_reason: "stop" }] };
    }
    const firstEngine = {
      chat: { completions: { create: vi.fn(async () => stalledStream()) } },
      interruptGenerate: vi.fn(),
      unload: vi.fn(async () => undefined),
    };
    const recoveredEngine = {
      chat: { completions: { create: vi.fn(async () => recoveredStream()) } },
      interruptGenerate: vi.fn(),
      unload: vi.fn(async () => undefined),
    };
    webLlmMocks.createEngine.mockResolvedValueOnce(firstEngine).mockResolvedValueOnce(recoveredEngine);
    const { runtime, workers } = runtimeFixture();
    await install(runtime);
    const controller = new AbortController();
    const events = [];

    for await (const event of runtime.generate({ prompt: "bounded prompt" }, controller.signal)) {
      events.push(event);
      if (event.type === "token") controller.abort(new DOMException("cancelled by user", "AbortError"));
    }

    expect(events.map((event) => event.type)).toEqual(["start", "token", "cancelled"]);
    expect(firstEngine.interruptGenerate).toHaveBeenCalledOnce();
    expect(firstEngine.unload).toHaveBeenCalledOnce();
    expect(workers[0]?.terminate).toHaveBeenCalledOnce();
    expect(runtime.capabilities()).toMatchObject({ installed: true, loaded: false });

    const recovery = [];
    for await (const event of runtime.generate({ prompt: "recovery prompt" }, new AbortController().signal)) {
      recovery.push(event);
    }
    expect(recovery.at(-1)).toMatchObject({ type: "complete", text: "recovered" });
    expect(workers).toHaveLength(2);
  });

  it("withdraws the loaded capability after generation failure and reloads with a fresh worker", async () => {
    async function* failedStream(): AsyncIterable<never> {
      throw new Error("worker crashed during generation");
    }
    async function* completedStream(): AsyncIterable<{ choices: { delta: { content: string }; finish_reason: string }[] }> {
      yield { choices: [{ delta: { content: "recovered" }, finish_reason: "stop" }] };
    }
    const failedEngine = {
      chat: { completions: { create: vi.fn(async () => failedStream()) } },
      interruptGenerate: vi.fn(),
      unload: vi.fn(async () => undefined),
    };
    const recoveredEngine = {
      chat: { completions: { create: vi.fn(async () => completedStream()) } },
      interruptGenerate: vi.fn(),
      unload: vi.fn(async () => undefined),
    };
    webLlmMocks.createEngine.mockResolvedValueOnce(failedEngine).mockResolvedValueOnce(recoveredEngine);
    const { runtime, workers } = runtimeFixture();
    const signal = new AbortController().signal;

    await install(runtime);
    expect(runtime.capabilities().loaded).toBe(true);

    const events = [];
    for await (const event of runtime.generate({ prompt: "bounded prompt" }, signal)) events.push(event);

    expect(events.at(-1)).toMatchObject({ type: "error", code: "GENERATION_FAILED" });
    expect(runtime.capabilities()).toMatchObject({ installed: true, loaded: false });
    expect(failedEngine.unload).toHaveBeenCalledOnce();
    expect(workers[0]?.terminate).toHaveBeenCalledOnce();

    await runtime.load(signal);
    expect(runtime.capabilities().loaded).toBe(true);
    expect(workers).toHaveLength(2);
    expect(webLlmMocks.createEngine).toHaveBeenCalledTimes(2);
  });

  it("invalidates a loaded runtime when its worker reports an unrecoverable error", async () => {
    const firstEngine = {
      chat: { completions: { create: vi.fn() } },
      interruptGenerate: vi.fn(),
      unload: vi.fn(async () => undefined),
    };
    const recoveredEngine = {
      chat: { completions: { create: vi.fn() } },
      interruptGenerate: vi.fn(),
      unload: vi.fn(async () => undefined),
    };
    webLlmMocks.createEngine.mockResolvedValueOnce(firstEngine).mockResolvedValueOnce(recoveredEngine);
    const { runtime, workers } = runtimeFixture();
    const signal = new AbortController().signal;

    await install(runtime);
    workers[0]?.dispatchEvent(new Event("error"));

    expect(runtime.capabilities()).toMatchObject({ installed: true, loaded: false });
    await Promise.resolve();
    expect(firstEngine.unload).toHaveBeenCalledOnce();
    expect(workers[0]?.terminate).toHaveBeenCalledOnce();

    await runtime.load(signal);
    expect(runtime.capabilities().loaded).toBe(true);
    expect(workers).toHaveLength(2);
  });
});
