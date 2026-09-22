import { fingerprint } from "./canonical.js";
import { MemoryCheckpointStore } from "./checkpoints.js";
import {
  aggregateRows,
  compareRecords,
  createExport,
  filterRows,
  parseCsvOperation,
  projectRows,
  sortRows,
} from "./operations.js";
import type {
  ApprovalBinding,
  CheckpointStore,
  InterpreterOptions,
  JsonValue,
  RunCheckpoint,
  StepReceipt,
  ToolImplementation,
  WorkflowAuthorizationContext,
  WorkflowDefinition,
  WorkflowRunOptions,
  WorkflowRunResult,
  WorkflowSourceAccess,
  WorkflowStep,
} from "./types.js";
import { WORKFLOW_SCHEMA_VERSION } from "./types.js";
import { validateWorkflow } from "./validation.js";

class WorkflowExecutionError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly outcomeUnknown = false,
  ) {
    super(message);
    this.name = "WorkflowExecutionError";
  }
}

const MAX_EXTRACTION_OUTPUT_BYTES = 16 * 1024;

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Workflow cancelled.", "AbortError");
}

function randomId(cryptoProvider: Crypto): string {
  if (typeof cryptoProvider.randomUUID === "function") return cryptoProvider.randomUUID();
  return [...cryptoProvider.getRandomValues(new Uint8Array(16))].map((item) => item.toString(16).padStart(2, "0")).join("");
}

function jsonClone(value: unknown): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || serialized.length > 2 * 1024 * 1024) throw new Error("Workflow value is unsupported or too large.");
  return JSON.parse(serialized) as JsonValue;
}

function resolveReference(reference: string, values: Readonly<Record<string, JsonValue>>): JsonValue {
  const direct = values[reference];
  if (direct !== undefined) return direct;
  const match = /^(steps\.[A-Za-z][A-Za-z0-9_-]*)\.([A-Za-z][A-Za-z0-9_-]*)$/u.exec(reference);
  if (match) {
    const parent = values[match[1] as string];
    if (parent && typeof parent === "object" && !Array.isArray(parent)) {
      const child = parent[match[2] as string];
      if (child !== undefined) return child;
    }
  }
  throw new Error(`Workflow reference ${reference} is unavailable.`);
}

function resolveInput(step: WorkflowStep, values: Readonly<Record<string, JsonValue>>): JsonValue {
  if (step.input === undefined) return null;
  if (
    typeof step.input === "object"
    && step.input !== null
    && !Array.isArray(step.input)
    && "ref" in step.input
    && typeof step.input.ref === "string"
  ) {
    return resolveReference(step.input.ref, values);
  }
  return jsonClone(step.input);
}

function validateInputs(workflow: WorkflowDefinition, inputs: Record<string, JsonValue>): void {
  const expected = new Set(Object.keys(workflow.inputSchema));
  for (const key of Object.keys(inputs)) if (!expected.has(key)) throw new Error(`Unknown workflow input ${key}.`);
  for (const [key, type] of Object.entries(workflow.inputSchema)) {
    const value = inputs[key];
    if (value === undefined) throw new Error(`Missing workflow input ${key}.`);
    const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    if (actual !== type) throw new Error(`Workflow input ${key} must be ${type}.`);
  }
}

async function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, outer: AbortSignal): Promise<T> {
  if (outer.aborted) throw abortError(outer);
  const controller = new AbortController();
  let rejectInterruption: (reason: unknown) => void = () => undefined;
  const interruption = new Promise<never>((_resolve, reject) => {
    rejectInterruption = reject;
  });
  const interrupt = (reason: unknown): void => {
    rejectInterruption(reason);
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const onAbort = (): void => interrupt(abortError(outer));
  outer.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => interrupt(new DOMException("Step timed out.", "TimeoutError")), timeoutMs);
  const pendingOperation = Promise.resolve().then(() => operation(controller.signal));
  try {
    return await Promise.race([pendingOperation, interruption]);
  } finally {
    clearTimeout(timer);
    outer.removeEventListener("abort", onAbort);
  }
}

function toolKey(tool: { name: string; version: string }): string {
  return `${tool.name}@${tool.version}`;
}

function assertWorkflowAuthority(workflow: WorkflowDefinition, authorization: WorkflowAuthorizationContext | undefined): void {
  const granted = new Set(authorization?.grantedCapabilities ?? []);
  const missing = workflow.requiredCapabilities.filter((capability) => !granted.has(capability));
  if (missing.length > 0) {
    throw new WorkflowExecutionError(`Missing workflow capabilities: ${missing.join(", ")}.`, "PERMISSION_DENIED");
  }
  if (workflow.originScope && workflow.originScope.length > 0) {
    if (!authorization?.origin || !workflow.originScope.includes(authorization.origin)) {
      throw new WorkflowExecutionError("The workflow is not authorized for the current origin.", "PERMISSION_DENIED");
    }
  }
  for (const dependency of workflow.sourceDependencies) {
    const current = authorization?.sourceRevisions?.[dependency.sourceId];
    if (current !== dependency.revision) {
      throw new WorkflowExecutionError(`Source revision ${dependency.sourceId} is missing or stale.`, "STALE_SOURCE");
    }
  }
}

function assertToolAuthority(tool: ToolImplementation, authorization: WorkflowAuthorizationContext | undefined): void {
  const granted = new Set(authorization?.grantedCapabilities ?? []);
  const missing = tool.descriptor.requiredCapabilities.filter((capability) => !granted.has(capability));
  if (missing.length > 0) {
    throw new WorkflowExecutionError(`Missing tool capabilities: ${missing.join(", ")}.`, "PERMISSION_DENIED");
  }
}

function sourceAccess(workflow: WorkflowDefinition): WorkflowSourceAccess {
  return Object.freeze({
    sources: Object.freeze(
      workflow.sourceDependencies.map((source) => Object.freeze({
        sourceId: source.sourceId,
        revision: source.revision,
      })),
    ),
  });
}

function validateExtractionValue(value: JsonValue, schema: NonNullable<WorkflowStep["schema"]>): JsonValue {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new WorkflowExecutionError("Extraction output must be valid JSON.", "INVALID_MODEL_OUTPUT");
  }
  if (serialized === undefined) {
    throw new WorkflowExecutionError("Extraction output must be valid JSON.", "INVALID_MODEL_OUTPUT");
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_EXTRACTION_OUTPUT_BYTES) {
    throw new WorkflowExecutionError("Extraction output exceeds the 16 KiB limit.", "PAYLOAD_TOO_LARGE");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkflowExecutionError("Extraction output must be an object.", "INVALID_MODEL_OUTPUT");
  }
  const record = value as Record<string, JsonValue>;
  const expected = Object.keys(schema).sort();
  const actual = Object.keys(record).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new WorkflowExecutionError("Extraction output fields do not match the reviewed schema.", "INVALID_MODEL_OUTPUT");
  }
  for (const [field, type] of Object.entries(schema)) {
    const fieldValue = record[field];
    const actualType = fieldValue === null ? "null" : typeof fieldValue;
    if (actualType !== type || (type === "number" && !Number.isFinite(fieldValue as number))) {
      throw new WorkflowExecutionError(`Extraction field ${field} does not match type ${type}.`, "INVALID_MODEL_OUTPUT");
    }
  }
  return value;
}

export class WorkflowInterpreter {
  readonly #checkpointStore: CheckpointStore;
  readonly #approvalBroker: InterpreterOptions["approvalBroker"];
  readonly #tools = new Map<string, ToolImplementation>();
  readonly #adapters: NonNullable<InterpreterOptions["adapters"]>;
  readonly #now: () => Date;
  readonly #crypto: Crypto;

  constructor(options: InterpreterOptions = {}) {
    this.#checkpointStore = options.checkpointStore ?? new MemoryCheckpointStore();
    this.#approvalBroker = options.approvalBroker;
    this.#adapters = options.adapters ?? {};
    this.#now = options.now ?? (() => new Date());
    this.#crypto = options.crypto ?? globalThis.crypto;
    if (!this.#crypto?.subtle) throw new Error("Web Crypto is required by the workflow interpreter.");
    for (const tool of options.tools ?? []) {
      const key = toolKey(tool.descriptor);
      if (this.#tools.has(key)) throw new Error(`Duplicate tool implementation ${key}.`);
      this.#tools.set(key, tool);
    }
  }

  async run(
    workflowInput: unknown,
    inputs: Record<string, JsonValue>,
    options: WorkflowRunOptions = {},
  ): Promise<WorkflowRunResult> {
    const validation = validateWorkflow(workflowInput);
    const workflow = validation.workflow;
    validateInputs(workflow, inputs);
    assertWorkflowAuthority(workflow, options.authorization);
    const planFingerprint = await fingerprint(workflow, this.#crypto);
    const runId = options.runId ?? randomId(this.#crypto);
    const controller = new AbortController();
    const signal = options.signal ?? controller.signal;
    let checkpoint: RunCheckpoint | undefined = options.resume ? await this.#checkpointStore.load(runId) : undefined;
    if (checkpoint && (checkpoint.planFingerprint !== planFingerprint || checkpoint.workflowId !== workflow.id)) {
      throw new Error("Saved run does not match the current workflow.");
    }
    if (checkpoint?.activeStep?.effect !== "read" && checkpoint?.activeStep?.idempotency === "none") {
      checkpoint = { ...checkpoint, state: "outcome-unknown", updatedAt: this.#now().toISOString() };
      await this.#checkpointStore.save(checkpoint);
      return this.#result(checkpoint);
    }
    if (!checkpoint) {
      const values: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
      for (const [key, value] of Object.entries(inputs)) values[`input.${key}`] = jsonClone(value);
      checkpoint = {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        runId,
        workflowId: workflow.id,
        workflowVersion: workflow.version,
        planFingerprint,
        state: "validated",
        nextStepIndex: 0,
        values,
        receipts: [],
        updatedAt: this.#now().toISOString(),
      };
      await this.#checkpointStore.save(checkpoint);
    }
    const deadline = this.#now().getTime() + workflow.limits.maxDurationMs;
    for (let index = checkpoint.nextStepIndex; index < workflow.steps.length; index += 1) {
      const step = workflow.steps[index];
      if (!step) throw new Error("Workflow step index is invalid.");
      assertWorkflowAuthority(workflow, options.authorization);
      if (signal.aborted) {
        checkpoint = await this.#transition(checkpoint, "cancelled", index, checkpoint.activeStep !== undefined);
        return this.#result(checkpoint);
      }
      if (this.#now().getTime() > deadline) {
        checkpoint = await this.#transition(checkpoint, "paused", index, checkpoint.activeStep !== undefined);
        return this.#result(checkpoint);
      }
      const startedAt = this.#now().toISOString();
      const tool = step.op === "tool.invoke" && step.tool ? this.#tools.get(toolKey(step.tool)) : undefined;
      checkpoint = {
        ...checkpoint,
        state: "running",
        nextStepIndex: index,
        updatedAt: startedAt,
      };
      await this.#checkpointStore.save(checkpoint);
      try {
        const markDispatched = async (
          effect: NonNullable<RunCheckpoint["activeStep"]>["effect"],
          idempotency: NonNullable<RunCheckpoint["activeStep"]>["idempotency"],
          idempotencyKey?: string,
        ): Promise<void> => {
          const activeStep: NonNullable<RunCheckpoint["activeStep"]> = {
            stepId: step.id,
            effect,
            idempotency,
            dispatchedAt: this.#now().toISOString(),
            ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          };
          const currentCheckpoint = checkpoint;
          if (currentCheckpoint === undefined) throw new Error("Workflow checkpoint is unavailable.");
          const dispatched: RunCheckpoint = { ...currentCheckpoint, activeStep, updatedAt: activeStep.dispatchedAt };
          await this.#checkpointStore.save(dispatched);
          checkpoint = dispatched;
        };
        const value = await this.#executeStep(workflow, step, checkpoint, signal, tool, options.authorization, markDispatched);
        const outputName = `steps.${step.id}`;
        const values = { ...checkpoint.values, [outputName]: jsonClone(value) };
        if (step.output) values[`${outputName}.${step.output}`] = jsonClone(value);
        const receipt: StepReceipt = {
          stepId: step.id,
          operation: step.op,
          state: "succeeded",
          startedAt,
          endedAt: this.#now().toISOString(),
          ...(step.output ? { outputName: step.output } : {}),
        };
        const { activeStep: _activeStep, ...completed } = checkpoint;
        const completedCheckpoint: RunCheckpoint = {
          ...completed,
          values,
          state: "running",
          nextStepIndex: index + 1,
          receipts: [...checkpoint.receipts, receipt],
          updatedAt: receipt.endedAt,
        };
        await this.#checkpointStore.save(completedCheckpoint);
        checkpoint = completedCheckpoint;
      } catch (error) {
        const known = error instanceof WorkflowExecutionError ? error : undefined;
        const cancelled = signal.aborted || (error instanceof DOMException && error.name === "AbortError");
        const dispatchedWrite: boolean = checkpoint.activeStep?.stepId === step.id && checkpoint.activeStep.effect !== "read";
        const nonIdempotentWrite: boolean = dispatchedWrite && checkpoint.activeStep?.idempotency === "none";
        const state: "outcome-unknown" | "cancelled" | "failed" = nonIdempotentWrite || known?.outcomeUnknown
          ? "outcome-unknown"
          : cancelled
            ? "cancelled"
            : "failed";
        const receipt: StepReceipt = {
          stepId: step.id,
          operation: step.op,
          state,
          startedAt,
          endedAt: this.#now().toISOString(),
          errorCode: state === "outcome-unknown" ? "OUTCOME_UNKNOWN" : known?.code ?? (cancelled ? "CANCELLED" : "STEP_FAILED"),
        };
        const { activeStep: _activeStep, ...failed } = checkpoint;
        checkpoint = {
          ...(dispatchedWrite ? checkpoint : failed),
          state,
          nextStepIndex: index,
          receipts: [...checkpoint.receipts, receipt],
          updatedAt: receipt.endedAt,
        };
        await this.#checkpointStore.save(checkpoint);
        if (step.failurePolicy !== "continue" || state === "outcome-unknown" || dispatchedWrite) return this.#result(checkpoint);
        checkpoint = { ...checkpoint, state: "running", nextStepIndex: index + 1, updatedAt: this.#now().toISOString() };
      }
    }
    checkpoint = await this.#transition(checkpoint, "succeeded", workflow.steps.length);
    return this.#result(checkpoint);
  }

  async #executeStep(
    workflow: WorkflowDefinition,
    step: WorkflowStep,
    checkpoint: RunCheckpoint,
    signal: AbortSignal,
    tool: ToolImplementation | undefined,
    authorization: WorkflowAuthorizationContext | undefined,
    markDispatched: (
      effect: NonNullable<RunCheckpoint["activeStep"]>["effect"],
      idempotency: NonNullable<RunCheckpoint["activeStep"]>["idempotency"],
      idempotencyKey?: string,
    ) => Promise<void>,
  ): Promise<JsonValue> {
    const value = resolveInput(step, checkpoint.values);
    const timeoutMs = step.timeoutMs ?? 30_000;
    const authorizedSources = sourceAccess(workflow);
    switch (step.op) {
      case "source.select":
        if (!this.#adapters.sourceSelect) throw new WorkflowExecutionError("Source adapter is unavailable.", "UNSUPPORTED_TASK");
        return withTimeout((inner) => this.#adapters.sourceSelect?.(value, authorizedSources, inner) as Promise<JsonValue>, timeoutMs, signal);
      case "csv.parse":
        return parseCsvOperation(value, workflow.limits.maxRows);
      case "rows.filter":
        return filterRows(value, step);
      case "rows.sort":
        return sortRows(value, step);
      case "rows.project":
        return projectRows(value, step);
      case "rows.aggregate":
        return aggregateRows(value, step);
      case "records.compare":
        return compareRecords(value, step.compareFields);
      case "memory.search":
        if (!this.#adapters.memorySearch) throw new WorkflowExecutionError("Memory adapter is unavailable.", "UNSUPPORTED_TASK");
        return withTimeout((inner) => this.#adapters.memorySearch?.(step.query ?? "", value, authorizedSources, inner) as Promise<JsonValue>, timeoutMs, signal);
      case "text.extract": {
        if (!this.#adapters.textExtract) throw new WorkflowExecutionError("Extraction adapter is unavailable.", "UNSUPPORTED_TASK");
        const extracted = await withTimeout((inner) => this.#adapters.textExtract?.(step.schema, value, inner) as Promise<JsonValue>, timeoutMs, signal);
        return validateExtractionValue(extracted, step.schema as NonNullable<WorkflowStep["schema"]>);
      }
      case "draft.create":
        return value;
      case "preview.show":
        if (this.#adapters.preview) await withTimeout((inner) => this.#adapters.preview?.(value, inner) as Promise<void>, timeoutMs, signal);
        return value;
      case "approval.require": {
        if (!this.#approvalBroker) throw new WorkflowExecutionError("Approval broker is unavailable.", "PERMISSION_DENIED");
        const argumentsFingerprint = await fingerprint(value, this.#crypto);
        const binding: Omit<ApprovalBinding, "expiresAt"> = {
          runId: checkpoint.runId,
          workflowId: workflow.id,
          stepId: step.id,
          scope: step.scope ?? "unspecified",
          planFingerprint: checkpoint.planFingerprint,
          argumentsFingerprint,
        };
        const handle = await this.#approvalBroker.request(binding);
        if (!handle.approved) throw new WorkflowExecutionError("Approval was denied.", "PERMISSION_DENIED");
        return handle.id;
      }
      case "tool.invoke":
        return this.#invokeTool(workflow, step, checkpoint, signal, tool, authorization, markDispatched);
      case "file.export": {
        if (!step.approvalRef || !this.#approvalBroker) throw new WorkflowExecutionError("Export approval is required.", "PERMISSION_DENIED");
        const handle = resolveReference(step.approvalRef, checkpoint.values);
        if (typeof handle !== "string") throw new WorkflowExecutionError("Approval handle is invalid.", "PERMISSION_DENIED");
        const approvalStepId = /^steps\.([A-Za-z][A-Za-z0-9_-]*)/u.exec(step.approvalRef)?.[1];
        const approvalStep = workflow.steps.find((candidate) => candidate.id === approvalStepId);
        await this.#approvalBroker.consume(handle, {
          runId: checkpoint.runId,
          workflowId: workflow.id,
          stepId: approvalStepId ?? "unknown",
          scope: approvalStep?.scope ?? "unspecified",
          planFingerprint: checkpoint.planFingerprint,
          argumentsFingerprint: await fingerprint(value, this.#crypto),
        });
        const exported = createExport(value, step);
        if (this.#adapters.exportFile) {
          await markDispatched("local-write", "none");
          await withTimeout((inner) => this.#adapters.exportFile?.(exported, inner) as Promise<void>, timeoutMs, signal);
        }
        return jsonClone(exported);
      }
    }
  }

  async #invokeTool(
    workflow: WorkflowDefinition,
    step: WorkflowStep,
    checkpoint: RunCheckpoint,
    signal: AbortSignal,
    tool: ToolImplementation | undefined,
    authorization: WorkflowAuthorizationContext | undefined,
    markDispatched: (
      effect: NonNullable<RunCheckpoint["activeStep"]>["effect"],
      idempotency: NonNullable<RunCheckpoint["activeStep"]>["idempotency"],
      idempotencyKey?: string,
    ) => Promise<void>,
  ): Promise<JsonValue> {
    if (!tool) throw new WorkflowExecutionError("Vetted tool implementation is unavailable.", "UNSUPPORTED_TASK");
    assertToolAuthority(tool, authorization);
    const argumentsValue: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const [key, argument] of Object.entries(step.arguments ?? {})) {
      argumentsValue[key] =
        typeof argument === "object"
          && argument !== null
          && !Array.isArray(argument)
          && "ref" in argument
          && typeof argument.ref === "string"
          ? resolveReference(argument.ref, checkpoint.values)
          : jsonClone(argument);
    }
    const resumedKeyedWrite = checkpoint.activeStep?.stepId === step.id
      && checkpoint.activeStep.effect === tool.descriptor.effect
      && checkpoint.activeStep.idempotency === "keyed"
      && typeof checkpoint.activeStep.idempotencyKey === "string";
    if (tool.descriptor.effect !== "read" && !resumedKeyedWrite) {
      if (!step.approvalRef || !this.#approvalBroker) throw new WorkflowExecutionError("Tool approval is required.", "PERMISSION_DENIED");
      const handle = resolveReference(step.approvalRef, checkpoint.values);
      if (typeof handle !== "string") throw new WorkflowExecutionError("Approval handle is invalid.", "PERMISSION_DENIED");
      const approvalStepId = /^steps\.([A-Za-z][A-Za-z0-9_-]*)/u.exec(step.approvalRef)?.[1];
      const approvalStep = workflow.steps.find((candidate) => candidate.id === approvalStepId);
      await this.#approvalBroker.consume(handle, {
        runId: checkpoint.runId,
        workflowId: workflow.id,
        stepId: approvalStepId ?? "unknown",
        scope: approvalStep?.scope ?? "unspecified",
        planFingerprint: checkpoint.planFingerprint,
        argumentsFingerprint: await fingerprint(argumentsValue, this.#crypto),
      });
    }
    const idempotencyKey = tool.descriptor.idempotency === "keyed"
      ? checkpoint.activeStep?.stepId === step.id && checkpoint.activeStep.idempotencyKey
        ? checkpoint.activeStep.idempotencyKey
        : `bc-workflow-v1:${await fingerprint({
          runId: checkpoint.runId,
          workflowId: workflow.id,
          workflowVersion: workflow.version,
          planFingerprint: checkpoint.planFingerprint,
          stepId: step.id,
          tool: tool.descriptor.name,
          toolVersion: tool.descriptor.version,
        }, this.#crypto)}`
      : undefined;
    if (tool.descriptor.effect !== "read") {
      await markDispatched(tool.descriptor.effect, tool.descriptor.idempotency, idempotencyKey);
    }
    return withTimeout(
      async (inner) => {
        const result = await tool.execute(argumentsValue, {
          runId: checkpoint.runId,
          workflowId: workflow.id,
          stepId: step.id,
          planFingerprint: checkpoint.planFingerprint,
          signal: inner,
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        });
        const serialized = JSON.stringify(result);
        if (new TextEncoder().encode(serialized).byteLength > tool.descriptor.maxOutputBytes) {
          throw new Error("Tool output exceeds its limit.");
        }
        if (tool.verify && !(await tool.verify(result, argumentsValue))) {
          throw new WorkflowExecutionError("Tool postcondition failed.", "POSTCONDITION_FAILED");
        }
        return jsonClone(result);
      },
      Math.min(step.timeoutMs ?? tool.descriptor.timeoutMs, tool.descriptor.timeoutMs),
      signal,
    );
  }

  async #transition(
    checkpoint: RunCheckpoint,
    state: RunCheckpoint["state"],
    nextStepIndex: number,
    preserveActiveStep = false,
  ): Promise<RunCheckpoint> {
    const { activeStep: _activeStep, ...rest } = checkpoint;
    const updated: RunCheckpoint = {
      ...(preserveActiveStep ? checkpoint : rest),
      state,
      nextStepIndex,
      updatedAt: this.#now().toISOString(),
    };
    await this.#checkpointStore.save(updated);
    return updated;
  }

  #result(checkpoint: RunCheckpoint): WorkflowRunResult {
    const outputs: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const [key, value] of Object.entries(checkpoint.values)) if (key.startsWith("steps.")) outputs[key] = jsonClone(value);
    return {
      runId: checkpoint.runId,
      state: checkpoint.state,
      outputs,
      receipts: structuredClone(checkpoint.receipts),
      planFingerprint: checkpoint.planFingerprint,
    };
  }
}

export function createWorkflowInterpreter(options: InterpreterOptions = {}): WorkflowInterpreter {
  return new WorkflowInterpreter(options);
}
