import { canonicalize, assertSafeKey } from "./canonical.js";
import type {
  InputReference,
  PredicateExpression,
  ValueExpression,
  WorkflowDefinition,
  WorkflowOperation,
  WorkflowStep,
  WorkflowValidationResult,
} from "./types.js";
import { MAX_VALUE_DEPTH, MAX_WORKFLOW_ROWS, MAX_WORKFLOW_STEPS, WORKFLOW_SCHEMA_VERSION } from "./types.js";

const OPERATIONS = new Set<WorkflowOperation>([
  "source.select",
  "csv.parse",
  "rows.filter",
  "rows.sort",
  "rows.project",
  "rows.aggregate",
  "records.compare",
  "memory.search",
  "text.extract",
  "draft.create",
  "preview.show",
  "approval.require",
  "tool.invoke",
  "file.export",
]);

const TOP_LEVEL_KEYS = new Set([
  "schemaVersion",
  "id",
  "version",
  "name",
  "description",
  "inputSchema",
  "outputSchema",
  "originScope",
  "requiredCapabilities",
  "sourceDependencies",
  "toolDependencies",
  "limits",
  "steps",
]);

const STEP_KEYS = new Set([
  "id",
  "op",
  "input",
  "output",
  "timeoutMs",
  "failurePolicy",
  "predicate",
  "fields",
  "sort",
  "aggregate",
  "compareFields",
  "scope",
  "approvalRef",
  "tool",
  "arguments",
  "filename",
  "format",
  "schema",
  "query",
]);

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} has an unsupported prototype.`);
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    assertSafeKey(key);
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field ${key}.`);
  }
}

function boundedString(value: unknown, label: string, max = 512): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) throw new Error(`${label} is invalid.`);
  return value;
}

function stringArray(value: unknown, label: string, max = 128): string[] {
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== "string" || item.trim().length === 0 || item.length > 512)) {
    throw new Error(`${label} must be a bounded string array.`);
  }
  return value as string[];
}

function canonicalOrigin(value: unknown): string {
  const candidate = boundedString(value, "Workflow origin", 2_048);
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("Workflow origin is invalid.");
  }
  if (parsed.origin === "null" || parsed.origin !== candidate || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Workflow origin must be an exact non-opaque origin.");
  }
  return candidate;
}

function validateValueExpression(value: unknown, depth = 0): asserts value is ValueExpression {
  if (depth > MAX_VALUE_DEPTH) throw new Error("Expression exceeds the depth limit.");
  const node = object(value, "Value expression");
  if ("literal" in node) {
    rejectUnknown(node, new Set(["literal"]), "Literal expression");
    if (node.literal !== null && !["string", "number", "boolean"].includes(typeof node.literal)) throw new Error("Invalid literal.");
    if (typeof node.literal === "number" && !Number.isFinite(node.literal)) throw new Error("Literal number must be finite.");
    return;
  }
  if ("field" in node) {
    rejectUnknown(node, new Set(["field"]), "Field expression");
    boundedString(node.field, "Field name");
    assertSafeKey(node.field as string);
    return;
  }
  rejectUnknown(node, new Set(["op", "left", "right"]), "Arithmetic expression");
  if (!["add", "subtract", "multiply", "divide"].includes(String(node.op))) throw new Error("Unknown arithmetic operator.");
  validateValueExpression(node.left, depth + 1);
  validateValueExpression(node.right, depth + 1);
}

function validatePredicate(value: unknown, depth = 0): asserts value is PredicateExpression {
  if (depth > MAX_VALUE_DEPTH) throw new Error("Predicate exceeds the depth limit.");
  const node = object(value, "Predicate");
  const operation = node.op;
  if (["eq", "neq", "gt", "gte", "lt", "lte"].includes(String(operation))) {
    rejectUnknown(node, new Set(["op", "left", "right"]), "Comparison predicate");
    validateValueExpression(node.left, depth + 1);
    validateValueExpression(node.right, depth + 1);
    return;
  }
  if (operation === "and" || operation === "or") {
    rejectUnknown(node, new Set(["op", "operands"]), "Boolean predicate");
    if (!Array.isArray(node.operands) || node.operands.length < 1 || node.operands.length > 32) throw new Error("Predicate operands are invalid.");
    for (const operand of node.operands) validatePredicate(operand, depth + 1);
    return;
  }
  if (operation === "not") {
    rejectUnknown(node, new Set(["op", "operand"]), "Not predicate");
    validatePredicate(node.operand, depth + 1);
    return;
  }
  throw new Error("Unknown predicate operator.");
}

function isReference(value: unknown): value is InputReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length === 1 && entries[0]?.[0] === "ref" && typeof entries[0][1] === "string";
}

function assertJsonValue(value: unknown, depth = 0): void {
  if (depth > MAX_VALUE_DEPTH) throw new Error("Value exceeds the depth limit.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, depth + 1);
    return;
  }
  const record = object(value, "JSON value");
  for (const [key, item] of Object.entries(record)) {
    assertSafeKey(key);
    assertJsonValue(item, depth + 1);
  }
}

function validateReference(reference: string, availableSteps: ReadonlySet<string>, inputNames: ReadonlySet<string>): void {
  const inputMatch = /^input\.([A-Za-z][A-Za-z0-9_-]{0,127})$/u.exec(reference);
  if (inputMatch) {
    if (!inputNames.has(inputMatch[1] as string)) throw new Error(`Unknown workflow input reference ${reference}.`);
    return;
  }
  const stepMatch = /^steps\.([A-Za-z][A-Za-z0-9_-]{0,127})(?:\.([A-Za-z][A-Za-z0-9_-]{0,127}))?$/u.exec(reference);
  if (!stepMatch || !availableSteps.has(stepMatch[1] as string)) throw new Error(`Invalid or forward step reference ${reference}.`);
}

function validateStep(value: unknown, availableSteps: Set<string>, inputNames: ReadonlySet<string>): WorkflowStep {
  const step = object(value, "Workflow step");
  rejectUnknown(step, STEP_KEYS, "Workflow step");
  const id = boundedString(step.id, "Step ID", 128);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(id) || availableSteps.has(id)) throw new Error(`Duplicate or invalid step ID ${id}.`);
  const op = step.op;
  if (typeof op !== "string" || !OPERATIONS.has(op as WorkflowOperation)) throw new Error(`Unknown workflow operation ${String(op)}.`);
  if (step.input !== undefined) {
    if (isReference(step.input)) validateReference(step.input.ref, availableSteps, inputNames);
    else assertJsonValue(step.input);
  }
  if (step.output !== undefined) boundedString(step.output, "Step output", 128);
  if (step.timeoutMs !== undefined && (!Number.isSafeInteger(step.timeoutMs) || (step.timeoutMs as number) < 1 || (step.timeoutMs as number) > 120_000)) {
    throw new Error("Step timeout is invalid.");
  }
  if (step.failurePolicy !== undefined && step.failurePolicy !== "stop" && step.failurePolicy !== "continue") throw new Error("Invalid failure policy.");
  if (step.predicate !== undefined) validatePredicate(step.predicate);
  if (step.fields !== undefined) stringArray(step.fields, "Projection fields").forEach(assertSafeKey);
  if (step.compareFields !== undefined) stringArray(step.compareFields, "Comparison fields").forEach(assertSafeKey);
  if (step.sort !== undefined) {
    if (!Array.isArray(step.sort) || step.sort.length > 16) throw new Error("Sort definition is invalid.");
    for (const item of step.sort) {
      const sort = object(item, "Sort item");
      rejectUnknown(sort, new Set(["field", "direction", "mode"]), "Sort item");
      assertSafeKey(boundedString(sort.field, "Sort field"));
      if (sort.direction !== "asc" && sort.direction !== "desc") throw new Error("Sort direction is invalid.");
      if (sort.mode !== undefined && !["primitive", "decimal", "iso-date"].includes(String(sort.mode))) {
        throw new Error("Sort mode is invalid.");
      }
    }
  }
  if (step.aggregate !== undefined) {
    if (!Array.isArray(step.aggregate) || step.aggregate.length > 32) throw new Error("Aggregate definition is invalid.");
    for (const item of step.aggregate) {
      const aggregate = object(item, "Aggregate item");
      rejectUnknown(aggregate, new Set(["field", "operation", "output", "currency"]), "Aggregate item");
      assertSafeKey(boundedString(aggregate.field, "Aggregate field"));
      assertSafeKey(boundedString(aggregate.output, "Aggregate output"));
      if (!["count", "sum", "min", "max", "average"].includes(String(aggregate.operation))) throw new Error("Aggregate operation is invalid.");
      if (aggregate.currency !== undefined) {
        if (aggregate.operation === "count") throw new Error("Count aggregates cannot declare a currency guard.");
        const currency = object(aggregate.currency, "Aggregate currency guard");
        rejectUnknown(currency, new Set(["field", "output"]), "Aggregate currency guard");
        assertSafeKey(boundedString(currency.field, "Aggregate currency field"));
        assertSafeKey(boundedString(currency.output, "Aggregate currency output"));
      }
    }
  }
  if (step.arguments !== undefined) {
    const argumentsValue = object(step.arguments, "Tool arguments");
    for (const [key, item] of Object.entries(argumentsValue)) {
      assertSafeKey(key);
      if (isReference(item)) validateReference(item.ref, availableSteps, inputNames);
      else assertJsonValue(item);
    }
  }
  if (step.schema !== undefined) {
    const schema = object(step.schema, "Extraction schema");
    if (Object.keys(schema).length < 1 || Object.keys(schema).length > 128) throw new Error("Extraction schema is invalid.");
    for (const [key, fieldType] of Object.entries(schema)) {
      assertSafeKey(key);
      if (!["string", "number", "boolean", "null"].includes(String(fieldType))) throw new Error("Extraction schema field type is invalid.");
    }
  }
  if (step.approvalRef !== undefined) validateReference(boundedString(step.approvalRef, "Approval reference"), availableSteps, inputNames);
  if (op === "rows.filter" && step.predicate === undefined) throw new Error("rows.filter requires a predicate.");
  if (op === "rows.sort" && step.sort === undefined) throw new Error("rows.sort requires sort fields.");
  if (op === "rows.project" && step.fields === undefined) throw new Error("rows.project requires fields.");
  if (op === "rows.aggregate" && step.aggregate === undefined) throw new Error("rows.aggregate requires aggregate definitions.");
  if (op === "text.extract" && step.schema === undefined) throw new Error("text.extract requires an exact output schema.");
  if (op === "approval.require" && typeof step.scope !== "string") throw new Error("approval.require needs a scope.");
  if (op === "tool.invoke") {
    const tool = object(step.tool, "Tool reference");
    rejectUnknown(tool, new Set(["name", "version"]), "Tool reference");
    boundedString(tool.name, "Tool name");
    boundedString(tool.version, "Tool version");
  }
  if (op === "file.export" && (!step.filename || !step.format)) throw new Error("file.export requires filename and format.");
  availableSteps.add(id);
  return structuredClone(step) as unknown as WorkflowStep;
}

function validateSchema(value: unknown, label: string): Record<string, "string" | "number" | "boolean" | "object" | "array"> {
  const schema = object(value, label);
  if (Object.keys(schema).length > 128) throw new Error(`${label} has too many fields.`);
  for (const [key, type] of Object.entries(schema)) {
    assertSafeKey(key);
    if (!["string", "number", "boolean", "object", "array"].includes(String(type))) throw new Error(`${label} has an invalid field type.`);
  }
  return structuredClone(schema) as Record<string, "string" | "number" | "boolean" | "object" | "array">;
}

export function validateWorkflow(value: unknown): WorkflowValidationResult {
  const workflow = object(value, "Workflow");
  rejectUnknown(workflow, TOP_LEVEL_KEYS, "Workflow");
  if (workflow.schemaVersion !== WORKFLOW_SCHEMA_VERSION) throw new Error("Unsupported workflow schema version.");
  boundedString(workflow.id, "Workflow ID", 128);
  boundedString(workflow.version, "Workflow version", 64);
  boundedString(workflow.name, "Workflow name", 256);
  if (workflow.description !== undefined && (typeof workflow.description !== "string" || workflow.description.length > 4_096)) throw new Error("Workflow description is invalid.");
  const inputSchema = validateSchema(workflow.inputSchema, "Input schema");
  if (workflow.outputSchema !== undefined) validateSchema(workflow.outputSchema, "Output schema");
  const requiredCapabilities = [...stringArray(workflow.requiredCapabilities, "Required capabilities", 128)];
  if (workflow.originScope !== undefined) {
    const origins = stringArray(workflow.originScope, "Origin scope", 32).map(canonicalOrigin);
    if (new Set(origins).size !== origins.length) throw new Error("Origin scope contains duplicates.");
  }
  if (!Array.isArray(workflow.sourceDependencies) || workflow.sourceDependencies.length > 128) throw new Error("Source dependencies are invalid.");
  const declaredSources = new Map<string, string>();
  for (const dependency of workflow.sourceDependencies) {
    const item = object(dependency, "Source dependency");
    rejectUnknown(item, new Set(["sourceId", "revision"]), "Source dependency");
    const sourceId = boundedString(item.sourceId, "Source ID");
    const revision = boundedString(item.revision, "Source revision");
    if (declaredSources.has(sourceId)) throw new Error(`Source dependency ${sourceId} is duplicated.`);
    declaredSources.set(sourceId, revision);
  }
  if (!Array.isArray(workflow.toolDependencies) || workflow.toolDependencies.length > 64) throw new Error("Tool dependencies are invalid.");
  for (const dependency of workflow.toolDependencies) {
    const item = object(dependency, "Tool dependency");
    rejectUnknown(item, new Set(["name", "version"]), "Tool dependency");
    boundedString(item.name, "Tool name");
    boundedString(item.version, "Tool version");
  }
  const limits = object(workflow.limits, "Workflow limits");
  rejectUnknown(limits, new Set(["maxRows", "maxSteps", "maxDurationMs"]), "Workflow limits");
  if (!Number.isSafeInteger(limits.maxRows) || (limits.maxRows as number) < 1 || (limits.maxRows as number) > MAX_WORKFLOW_ROWS) throw new Error("maxRows is invalid.");
  if (!Number.isSafeInteger(limits.maxSteps) || (limits.maxSteps as number) < 1 || (limits.maxSteps as number) > MAX_WORKFLOW_STEPS) throw new Error("maxSteps is invalid.");
  if (!Number.isSafeInteger(limits.maxDurationMs) || (limits.maxDurationMs as number) < 1 || (limits.maxDurationMs as number) > 120_000) throw new Error("maxDurationMs is invalid.");
  if (!Array.isArray(workflow.steps) || workflow.steps.length < 1 || workflow.steps.length > (limits.maxSteps as number)) throw new Error("Workflow step count is invalid.");
  const availableSteps = new Set<string>();
  const inputNames = new Set(Object.keys(inputSchema));
  const steps = workflow.steps.map((step) => validateStep(step, availableSteps, inputNames));
  if (steps.some((step) => step.op === "source.select" || step.op === "memory.search") && declaredSources.size === 0) {
    throw new Error("Source-backed workflow operations require at least one exact source dependency.");
  }
  const declaredTools = new Set(
    (workflow.toolDependencies as { name: string; version: string }[]).map((dependency) => `${dependency.name}@${dependency.version}`),
  );
  for (const step of steps) {
    if (step.op === "source.select") requiredCapabilities.push("source:read");
    if (step.op === "memory.search") requiredCapabilities.push("memory:search");
    if (step.op === "file.export") requiredCapabilities.push("local-file:export");
    if (step.op === "tool.invoke" && step.tool) {
      const key = `${step.tool.name}@${step.tool.version}`;
      if (!declaredTools.has(key)) throw new Error(`Tool step ${step.id} is missing an exact tool dependency.`);
      requiredCapabilities.push(`tool:${key}`);
    }
  }
  const normalized = structuredClone(workflow) as unknown as WorkflowDefinition;
  normalized.steps = steps;
  normalized.requiredCapabilities = [...new Set(requiredCapabilities)].sort();
  return { workflow: normalized, requiredCapabilities: normalized.requiredCapabilities, canonicalPlan: canonicalize(normalized) };
}
