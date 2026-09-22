export const WORKFLOW_SCHEMA_VERSION = 1 as const;
export const MAX_WORKFLOW_STEPS = 32;
export const MAX_WORKFLOW_ROWS = 10_000;
export const MAX_VALUE_DEPTH = 32;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type Row = Record<string, JsonPrimitive>;

export type ValueExpression =
  | { literal: JsonPrimitive }
  | { field: string }
  | { op: "add" | "subtract" | "multiply" | "divide"; left: ValueExpression; right: ValueExpression };

export type PredicateExpression =
  | { op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte"; left: ValueExpression; right: ValueExpression }
  | { op: "and" | "or"; operands: PredicateExpression[] }
  | { op: "not"; operand: PredicateExpression };

export interface InputReference {
  ref: string;
}

export type WorkflowOperation =
  | "source.select"
  | "csv.parse"
  | "rows.filter"
  | "rows.sort"
  | "rows.project"
  | "rows.aggregate"
  | "records.compare"
  | "memory.search"
  | "text.extract"
  | "draft.create"
  | "preview.show"
  | "approval.require"
  | "tool.invoke"
  | "file.export";

export interface WorkflowStep {
  id: string;
  op: WorkflowOperation;
  input?: InputReference | JsonValue;
  output?: string;
  timeoutMs?: number;
  failurePolicy?: "stop" | "continue";
  predicate?: PredicateExpression;
  fields?: string[];
  sort?: { field: string; direction: "asc" | "desc"; mode?: "primitive" | "decimal" | "iso-date" }[];
  aggregate?: {
    field: string;
    operation: "count" | "sum" | "min" | "max" | "average";
    output: string;
    currency?: { field: string; output: string };
  }[];
  compareFields?: string[];
  scope?: string;
  approvalRef?: string;
  tool?: { name: string; version: string };
  arguments?: Record<string, JsonValue | InputReference>;
  filename?: string;
  format?: "csv" | "json" | "text";
  schema?: Record<string, "string" | "number" | "boolean" | "null">;
  query?: string;
}

export interface WorkflowDefinition {
  schemaVersion: typeof WORKFLOW_SCHEMA_VERSION;
  id: string;
  version: string;
  name: string;
  description?: string;
  inputSchema: Record<string, "string" | "number" | "boolean" | "object" | "array">;
  outputSchema?: Record<string, "string" | "number" | "boolean" | "object" | "array">;
  originScope?: string[];
  requiredCapabilities: string[];
  sourceDependencies: { sourceId: string; revision: string }[];
  toolDependencies: { name: string; version: string }[];
  limits: { maxRows: number; maxSteps: number; maxDurationMs: number };
  steps: WorkflowStep[];
}

export interface WorkflowValidationResult {
  workflow: WorkflowDefinition;
  requiredCapabilities: string[];
  canonicalPlan: string;
}

export type RunState =
  | "draft"
  | "validated"
  | "awaiting-approval"
  | "ready"
  | "running"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "outcome-unknown";

export interface StepReceipt {
  stepId: string;
  operation: WorkflowOperation;
  state: "succeeded" | "failed" | "cancelled" | "outcome-unknown";
  startedAt: string;
  endedAt: string;
  outputName?: string;
  errorCode?: string;
}

export interface RunCheckpoint {
  schemaVersion: typeof WORKFLOW_SCHEMA_VERSION;
  runId: string;
  workflowId: string;
  workflowVersion: string;
  planFingerprint: string;
  state: RunState;
  nextStepIndex: number;
  values: Record<string, JsonValue>;
  receipts: StepReceipt[];
  activeStep?: {
    stepId: string;
    effect: ToolDescriptor["effect"];
    idempotency: ToolDescriptor["idempotency"];
    dispatchedAt: string;
    idempotencyKey?: string;
  };
  updatedAt: string;
}

export interface WorkflowRunResult {
  runId: string;
  state: RunState;
  outputs: Record<string, JsonValue>;
  receipts: StepReceipt[];
  planFingerprint: string;
}

export interface WorkflowAuthorizationContext {
  origin?: string;
  grantedCapabilities: readonly string[];
  sourceRevisions?: Readonly<Record<string, string>>;
}

export interface WorkflowSourceAccess {
  readonly sources: readonly Readonly<{ sourceId: string; revision: string }>[];
}

export interface WorkflowRunOptions {
  signal?: AbortSignal;
  runId?: string;
  resume?: boolean;
  authorization?: WorkflowAuthorizationContext;
}

export interface CheckpointStore {
  load(runId: string): Promise<RunCheckpoint | undefined>;
  save(checkpoint: RunCheckpoint): Promise<void>;
  delete(runId: string): Promise<void>;
}

export interface ApprovalBinding {
  runId: string;
  workflowId: string;
  stepId: string;
  scope: string;
  planFingerprint: string;
  argumentsFingerprint: string;
  expiresAt: string;
}

export interface ApprovalHandle {
  id: string;
  binding: ApprovalBinding;
  approved: boolean;
  consumed: boolean;
}

export interface ToolDescriptor {
  name: string;
  version: string;
  effect: "read" | "local-write" | "external-write";
  timeoutMs: number;
  maxOutputBytes: number;
  idempotency: "read-only" | "keyed" | "none";
  requiredCapabilities: string[];
}

export interface ToolImplementation {
  descriptor: ToolDescriptor;
  execute(argumentsValue: Record<string, JsonValue>, context: ToolExecutionContext): Promise<JsonValue>;
  verify?(result: JsonValue, argumentsValue: Record<string, JsonValue>): Promise<boolean> | boolean;
}

export interface ToolExecutionContext {
  runId: string;
  workflowId: string;
  stepId: string;
  planFingerprint: string;
  signal: AbortSignal;
  /** Present only for a tool that declares keyed idempotency; stable for this run, plan, and step. */
  idempotencyKey?: string;
}

export interface InterpreterAdapters {
  sourceSelect?(value: JsonValue, access: WorkflowSourceAccess, signal: AbortSignal): Promise<JsonValue>;
  memorySearch?(query: string, value: JsonValue, access: WorkflowSourceAccess, signal: AbortSignal): Promise<JsonValue>;
  textExtract?(schema: WorkflowStep["schema"], value: JsonValue, signal: AbortSignal): Promise<JsonValue>;
  preview?(value: JsonValue, signal: AbortSignal): Promise<void>;
  exportFile?(file: ExportedFile, signal: AbortSignal): Promise<void>;
}

export interface ExportedFile {
  filename: string;
  mediaType: "text/csv" | "application/json" | "text/plain";
  content: string;
  escapedFormulaCells: number;
}

export interface InterpreterOptions {
  checkpointStore?: CheckpointStore;
  approvalBroker?: import("./approval.js").ApprovalBroker;
  tools?: readonly ToolImplementation[];
  adapters?: InterpreterAdapters;
  now?: () => Date;
  crypto?: Crypto;
}

export interface NaturalLanguageWorkflowRequest {
  id: string;
  name: string;
  instruction: string;
  inputName?: string;
  inputColumns: string[];
  sourceId?: string;
  sourceRevision?: string;
}

export interface CompatibleCompileRequest {
  instruction: string;
  input: { csv: string };
  origin?: string;
  id?: string;
  name?: string;
}

export interface WorkflowPlanner {
  compile(request: NaturalLanguageWorkflowRequest, signal?: AbortSignal): Promise<unknown>;
}

export interface ReuseDependencies {
  origin?: string;
  workspaceId: string;
  policyVersion: string;
  inputSchemaFingerprint: string;
  sourceRevisions: Record<string, string>;
  toolVersions: Record<string, string>;
  parameters: Record<string, JsonValue>;
}
