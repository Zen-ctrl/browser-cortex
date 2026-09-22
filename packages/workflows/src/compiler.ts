import { parseCsv } from "./csv.js";
import type { CompatibleCompileRequest, NaturalLanguageWorkflowRequest, WorkflowDefinition, WorkflowPlanner } from "./types.js";
import { WORKFLOW_SCHEMA_VERSION } from "./types.js";
import { validateWorkflow } from "./validation.js";

function baseWorkflow(request: NaturalLanguageWorkflowRequest): Omit<WorkflowDefinition, "steps"> {
  const inputName = request.inputName ?? "csv";
  if (request.sourceId && !request.sourceRevision) {
    throw new Error("Source-backed workflows require an immutable source revision.");
  }
  const dependency = request.sourceId
    ? [{ sourceId: request.sourceId, revision: request.sourceRevision as string }]
    : [];
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: request.id,
    version: "1.0.0",
    name: request.name,
    inputSchema: { [inputName]: "string" },
    requiredCapabilities: ["input:read"],
    sourceDependencies: dependency,
    toolDependencies: [],
    limits: { maxRows: 10_000, maxSteps: 32, maxDurationMs: 120_000 },
  };
}

function compileDeterministic(request: NaturalLanguageWorkflowRequest): WorkflowDefinition | undefined {
  const instruction = request.instruction.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  const inputName = request.inputName ?? "csv";
  const countryField = request.inputColumns.find((column) => column.toLocaleLowerCase("en-US") === "country");
  if (/\b(non[- ]?us|outside (?:the )?us|international)\b/u.test(instruction)) {
    if (!countryField) throw new Error("The requested international-order filter requires a country column.");
    return {
      ...baseWorkflow(request),
      requiredCapabilities: ["input:read", "local-file:export"],
      steps: [
        { id: "parse", op: "csv.parse", input: { ref: `input.${inputName}` }, output: "rows" },
        {
          id: "filter",
          op: "rows.filter",
          input: { ref: "steps.parse.rows" },
          predicate: { op: "neq", left: { field: countryField }, right: { literal: "US" } },
          output: "rows",
        },
        { id: "preview", op: "preview.show", input: { ref: "steps.filter.rows" } },
        { id: "approve", op: "approval.require", input: { ref: "steps.filter.rows" }, scope: "export-reviewed-rows" },
        {
          id: "export",
          op: "file.export",
          input: { ref: "steps.filter.rows" },
          approvalRef: "steps.approve",
          filename: "reviewed-orders.csv",
          format: "csv",
          output: "file",
        },
      ],
    };
  }
  const sortMatch = /\bsort by ([a-zA-Z][a-zA-Z0-9_-]*)(?: (ascending|descending|asc|desc))?\b/u.exec(instruction);
  if (sortMatch) {
    const requested = sortMatch[1] as string;
    const field = request.inputColumns.find((column) => column.toLocaleLowerCase("en-US") === requested.toLocaleLowerCase("en-US"));
    if (!field) throw new Error(`The requested sort field ${requested} is not present.`);
    const direction = sortMatch[2]?.startsWith("desc") ? "desc" : "asc";
    return {
      ...baseWorkflow(request),
      steps: [
        { id: "parse", op: "csv.parse", input: { ref: `input.${inputName}` }, output: "rows" },
        { id: "sort", op: "rows.sort", input: { ref: "steps.parse.rows" }, sort: [{ field, direction }], output: "rows" },
        { id: "preview", op: "preview.show", input: { ref: "steps.sort.rows" }, output: "rows" },
      ],
    };
  }
  return undefined;
}

export async function compileWorkflow(
  requestInput: NaturalLanguageWorkflowRequest | CompatibleCompileRequest,
  options: { planner?: WorkflowPlanner; signal?: AbortSignal } = {},
): Promise<ReturnType<typeof validateWorkflow>> {
  const compatible = "input" in requestInput;
  const rows = compatible ? parseCsv(requestInput.input.csv, 10_000) : undefined;
  const request: NaturalLanguageWorkflowRequest = compatible
    ? {
        id: requestInput.id ?? "compiled-workflow",
        name: requestInput.name ?? "Compiled workflow",
        instruction: requestInput.instruction,
        inputName: "csv",
        inputColumns: rows?.[0] ? Object.keys(rows[0]) : [],
      }
    : requestInput;
  if (request.instruction.length < 1 || request.instruction.length > 24_000) throw new Error("Workflow instruction is empty or too long.");
  if (request.inputColumns.length < 1 || request.inputColumns.length > 256) throw new Error("Input column description is invalid.");
  const deterministic = compileDeterministic(request);
  if (deterministic) {
    if (compatible && requestInput.origin) deterministic.originScope = [requestInput.origin];
    return validateWorkflow(deterministic);
  }
  if (!options.planner) throw new Error("The instruction is outside the deterministic compiler's supported task set.");
  if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("Compilation cancelled.", "AbortError");
  const planned = await options.planner.compile(request, options.signal);
  return validateWorkflow(planned);
}
