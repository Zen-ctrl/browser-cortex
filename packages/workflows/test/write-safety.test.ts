import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApprovalBroker,
  MemoryCheckpointStore,
  createWorkflowInterpreter,
} from "../src/index.js";
import type {
  JsonValue,
  ToolImplementation,
  WorkflowDefinition,
} from "../src/index.js";

function toolWorkflow(name: string): WorkflowDefinition {
  return {
    schemaVersion: 1,
    id: `${name}-workflow`,
    version: "1.0.0",
    name: `${name} workflow`,
    inputSchema: {},
    requiredCapabilities: [`tool:${name}@1`],
    sourceDependencies: [],
    toolDependencies: [{ name, version: "1" }],
    limits: { maxRows: 10, maxSteps: 2, maxDurationMs: 5_000 },
    steps: [
      { id: "approve", op: "approval.require", input: {}, scope: `run-${name}` },
      {
        id: "write",
        op: "tool.invoke",
        tool: { name, version: "1" },
        arguments: {},
        approvalRef: "steps.approve",
        timeoutMs: 25,
      },
    ],
  };
}

function writeTool(
  name: string,
  effect: "local-write" | "external-write",
  idempotency: "keyed" | "none",
  execute: ToolImplementation["execute"],
): ToolImplementation {
  return {
    descriptor: {
      name,
      version: "1",
      effect,
      timeoutMs: 25,
      maxOutputBytes: 1_024,
      idempotency,
      requiredCapabilities: [],
    },
    execute,
  };
}

function allow(name: string): { grantedCapabilities: string[] } {
  return { grantedCapabilities: [`tool:${name}@1`] };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("workflow write dispatch safety", () => {
  it("rejects at the deadline and never accepts a late non-idempotent local write completion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const runId = "timeout-local-write";
    const checkpointStore = new MemoryCheckpointStore();
    const approvals = new ApprovalBroker({ review: async () => true });
    let releaseLateResult: (value: JsonValue) => void = () => undefined;
    const dispatchObservation: { signal?: AbortSignal } = {};
    let checkpointAtDispatch = await checkpointStore.load(runId);
    let startedDispatch: () => void = () => undefined;
    const dispatched = new Promise<void>((resolve) => {
      startedDispatch = resolve;
    });
    const lateResult = new Promise<JsonValue>((resolve) => {
      releaseLateResult = resolve;
    });
    const tool = writeTool("local-timeout", "local-write", "none", async (_arguments, context) => {
      dispatchObservation.signal = context.signal;
      checkpointAtDispatch = await checkpointStore.load(runId);
      startedDispatch();
      return lateResult;
    });
    const interpreter = createWorkflowInterpreter({ checkpointStore, approvalBroker: approvals, tools: [tool] });

    const pendingRun = interpreter.run(toolWorkflow("local-timeout"), {}, {
      runId,
      authorization: allow("local-timeout"),
    });
    await dispatched;
    expect(checkpointAtDispatch?.activeStep).toMatchObject({
      stepId: "write",
      effect: "local-write",
      idempotency: "none",
    });
    await vi.advanceTimersByTimeAsync(25);
    const result = await pendingRun;

    expect(result.state).toBe("outcome-unknown");
    expect(result.receipts.at(-1)).toMatchObject({ state: "outcome-unknown", errorCode: "OUTCOME_UNKNOWN" });
    expect(dispatchObservation.signal?.aborted).toBe(true);
    expect(result.outputs["steps.write"]).toBeUndefined();

    releaseLateResult({ acceptedTooLate: true });
    await Promise.resolve();
    const afterLateCompletion = await checkpointStore.load(runId);
    expect(afterLateCompletion?.state).toBe("outcome-unknown");
    expect(afterLateCompletion?.values["steps.write"]).toBeUndefined();
  });

  it("checkpoints an external non-idempotent write before dispatch and treats rejection as outcome unknown", async () => {
    const runId = "failed-external-write";
    const checkpointStore = new MemoryCheckpointStore();
    const approvals = new ApprovalBroker({ review: async () => true });
    let checkpointAtDispatch = await checkpointStore.load(runId);
    const tool = writeTool("external-failure", "external-write", "none", async () => {
      checkpointAtDispatch = await checkpointStore.load(runId);
      throw new Error("Synthetic transport failure after dispatch.");
    });
    const interpreter = createWorkflowInterpreter({ checkpointStore, approvalBroker: approvals, tools: [tool] });

    const result = await interpreter.run(toolWorkflow("external-failure"), {}, {
      runId,
      authorization: allow("external-failure"),
    });

    expect(checkpointAtDispatch?.activeStep).toMatchObject({
      stepId: "write",
      effect: "external-write",
      idempotency: "none",
    });
    expect(result.state).toBe("outcome-unknown");
    expect(result.receipts.at(-1)?.errorCode).toBe("OUTCOME_UNKNOWN");
  });

  it("checkpoints file export as a non-idempotent local write and fails closed during recovery", async () => {
    const runId = "failed-file-export";
    const checkpointStore = new MemoryCheckpointStore();
    const approvals = new ApprovalBroker({ review: async () => true });
    const workflow: WorkflowDefinition = {
      schemaVersion: 1,
      id: "file-export-safety",
      version: "1.0.0",
      name: "File export safety",
      inputSchema: { content: "string" },
      requiredCapabilities: ["local-file:export"],
      sourceDependencies: [],
      toolDependencies: [],
      limits: { maxRows: 10, maxSteps: 2, maxDurationMs: 5_000 },
      steps: [
        { id: "approve", op: "approval.require", input: { ref: "input.content" }, scope: "export-reviewed-content" },
        {
          id: "export",
          op: "file.export",
          input: { ref: "input.content" },
          approvalRef: "steps.approve",
          filename: "reviewed.txt",
          format: "text",
        },
      ],
    };
    let checkpointAtDispatch = await checkpointStore.load(runId);
    const exportFile = vi.fn(async () => {
      checkpointAtDispatch = await checkpointStore.load(runId);
      throw new Error("Synthetic file-system failure after dispatch.");
    });
    const interpreter = createWorkflowInterpreter({
      checkpointStore,
      approvalBroker: approvals,
      adapters: { exportFile },
    });

    const first = await interpreter.run(workflow, { content: "reviewed" }, {
      runId,
      authorization: { grantedCapabilities: ["local-file:export"] },
    });

    expect(checkpointAtDispatch?.activeStep).toMatchObject({
      stepId: "export",
      effect: "local-write",
      idempotency: "none",
    });
    expect(first.state).toBe("outcome-unknown");

    const recovered = await createWorkflowInterpreter({ checkpointStore, adapters: { exportFile } }).run(
      workflow,
      { content: "reviewed" },
      {
        runId,
        resume: true,
        authorization: { grantedCapabilities: ["local-file:export"] },
      },
    );
    expect(recovered.state).toBe("outcome-unknown");
    expect(exportFile).toHaveBeenCalledOnce();
  });

  it("reuses one stable per-step idempotency key when a keyed write is resumed", async () => {
    const runId = "resume-keyed-write";
    const checkpointStore = new MemoryCheckpointStore();
    const approvals = new ApprovalBroker({ review: async () => true });
    const observedKeys: Array<string | undefined> = [];
    let attempt = 0;
    const tool = writeTool("keyed-writer", "external-write", "keyed", async (_arguments, context) => {
      observedKeys.push(context.idempotencyKey);
      attempt += 1;
      if (attempt === 1) throw new Error("Synthetic response loss.");
      return { ok: true };
    });
    const workflow = toolWorkflow("keyed-writer");
    const firstInterpreter = createWorkflowInterpreter({ checkpointStore, approvalBroker: approvals, tools: [tool] });

    const first = await firstInterpreter.run(workflow, {}, {
      runId,
      authorization: allow("keyed-writer"),
    });
    expect(first.state).toBe("failed");
    const failedCheckpoint = await checkpointStore.load(runId);
    expect(failedCheckpoint?.activeStep?.idempotencyKey).toMatch(/^bc-workflow-v1:[a-f0-9]{64}$/u);

    const recovered = await createWorkflowInterpreter({ checkpointStore, tools: [tool] }).run(workflow, {}, {
      runId,
      resume: true,
      authorization: allow("keyed-writer"),
    });

    expect(recovered.state).toBe("succeeded");
    expect(observedKeys).toHaveLength(2);
    expect(observedKeys[0]).toBe(observedKeys[1]);
    expect((await checkpointStore.load(runId))?.activeStep).toBeUndefined();
  });
});
