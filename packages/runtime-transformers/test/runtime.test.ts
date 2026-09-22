import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTransformersEmbeddingRuntime } from "../src/index.js";

const transformersMocks = vi.hoisted(() => ({
  env: {
    allowRemoteModels: false,
    allowLocalModels: false,
    backends: { onnx: { wasm: {} } },
  },
  pipeline: vi.fn(),
  observations: [] as Array<{ allowRemoteModels: boolean; allowLocalModels: boolean; localFilesOnly: boolean }>,
}));

vi.mock("@huggingface/transformers", () => ({
  env: transformersMocks.env,
  pipeline: transformersMocks.pipeline,
}));

beforeEach(() => {
  transformersMocks.env.allowRemoteModels = false;
  transformersMocks.env.allowLocalModels = false;
  transformersMocks.observations.length = 0;
  transformersMocks.pipeline.mockReset().mockImplementation(async (
    _task: string,
    _modelId: string,
    options: { local_files_only: boolean },
  ) => {
    transformersMocks.observations.push({
      allowRemoteModels: transformersMocks.env.allowRemoteModels,
      allowLocalModels: transformersMocks.env.allowLocalModels,
      localFilesOnly: options.local_files_only,
    });
    return Object.assign(
      async () => ({ tolist: () => [[1, 0]], dispose: () => undefined }),
      { dispose: async () => undefined },
    );
  });
});

describe("transformers installation boundary", () => {
  it("does not load or embed until an explicit installation completes", async () => {
    const runtime = createTransformersEmbeddingRuntime({});
    const signal = new AbortController().signal;

    expect(runtime.capabilities().installed).toBe(false);
    await expect(runtime.load(signal)).rejects.toThrow("MODEL_NOT_INSTALLED");
    await expect(runtime.embed(["private text"], signal)).rejects.toThrow("MODEL_NOT_INSTALLED");
  });

  it("keeps the runtime uninstalled when installation is already cancelled", async () => {
    const runtime = createTransformersEmbeddingRuntime({});
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled by user", "AbortError"));
    const events = [];

    for await (const event of runtime.install(controller.signal)) events.push(event);

    expect(events.at(-1)?.state).toBe("cancelled");
    expect(runtime.capabilities().installed).toBe(false);
  });

  it("does not let a same-origin app-shell fallback shadow remote model assets", async () => {
    const runtime = createTransformersEmbeddingRuntime({ allowRemoteModels: true });
    const events = [];

    for await (const event of runtime.install(new AbortController().signal)) events.push(event);

    expect(events.at(-1)?.state).toBe("ready");
    expect(transformersMocks.observations).toEqual([{
      allowRemoteModels: true,
      allowLocalModels: false,
      localFilesOnly: false,
    }]);
    expect(transformersMocks.env).toMatchObject({ allowRemoteModels: false, allowLocalModels: false });
    await runtime.dispose();
  });
});
