import { describe, expect, it, vi } from "vitest";
import { createOrdersCsv, expectedFixtureResults } from "../../testkit/src/index.js";
import {
  ApprovalBroker,
  MemoryCheckpointStore,
  aggregateRows,
  compileWorkflow,
  createWorkflowInterpreter,
  parseCsv,
  serializeCsv,
  sortRows,
  validateWorkflow,
} from "../src/index.js";
import type { JsonValue, WorkflowDefinition, WorkflowSourceAccess, WorkflowStep } from "../src/index.js";

describe("bounded compiled workflow", () => {
  it("keeps decimal aggregates exact and requires explicit canonical date sorting", () => {
    const aggregateStep: WorkflowStep = {
      id: "aggregate",
      op: "rows.aggregate",
      aggregate: [{ field: "amount", operation: "sum", output: "total" }],
    };
    expect(aggregateRows([{ amount: "0.1" }, { amount: "0.2" }], aggregateStep)).toEqual({ total: "0.3" });

    const dated = [{ date: "2026-10-02" }, { date: "2026-01-12" }];
    expect(() => sortRows(dated, { id: "sort", op: "rows.sort", sort: [{ field: "date", direction: "asc" }] })).toThrow("explicit iso-date");
    expect(sortRows(dated, { id: "sort", op: "rows.sort", sort: [{ field: "date", direction: "asc", mode: "iso-date" }] }))
      .toEqual([{ date: "2026-01-12" }, { date: "2026-10-02" }]);

    const currencyStep: WorkflowStep = {
      id: "money",
      op: "rows.aggregate",
      aggregate: [{
        field: "amount_minor", operation: "sum", output: "total_minor",
        currency: { field: "currency", output: "currency" },
      }],
    };
    expect(() => aggregateRows([
      { amount_minor: "100", currency: "USD" },
      { amount_minor: "100", currency: "EUR" },
    ], currencyStep)).toThrow("mixed currencies");
  });

  it("enforces the CSV row limit when the last row has no trailing newline", () => {
    expect(() => parseCsv("id\n1\n2", 1)).toThrow("row limit");
  });

  it("applies the CSV byte limit to UTF-8 bytes instead of JavaScript code units", () => {
    expect(() => parseCsv("value\né", 1, 7)).toThrow("byte limit");
    expect(parseCsv("value\né", 1, 8)).toHaveLength(1);
  });

  it("escapes leading tab and carriage return cells plus whitespace-prefixed formulas", () => {
    const dangerous = ["\tcommand", "\rcommand", "  =1+1", "  +2", "  @hidden", "  -3"];
    const exported = serializeCsv([...dangerous.map((value) => ({ value })), { value: "safe" }]);

    expect(exported.escapedFormulaCells).toBe(dangerous.length);
    for (const value of dangerous) expect(exported.content).toContain(`'${value}`);
    expect(exported.content).not.toContain("'safe");
  });

  it("filters exactly 35 non-US rows and binds export approval", async () => {
    const compiled = await compileWorkflow({
      instruction: "Show non-US orders and export reviewed rows",
      input: { csv: createOrdersCsv() },
      origin: "https://demo.invalid",
    });
    const approvals = new ApprovalBroker({ review: async () => true });
    const interpreter = createWorkflowInterpreter({ approvalBroker: approvals });
    const result = await interpreter.run(compiled.workflow, { csv: createOrdersCsv() }, {
      authorization: {
        origin: "https://demo.invalid",
        grantedCapabilities: compiled.requiredCapabilities,
      },
    });
    expect(result.state).toBe("succeeded");
    const rows = result.outputs["steps.filter"];
    expect(Array.isArray(rows) ? rows.length : -1).toBe(expectedFixtureResults.nonUsOrders);
    const exported = result.outputs["steps.export"];
    expect(JSON.stringify(exported)).toContain("reviewed-orders.csv");
  });

  it("rejects missing capabilities and an origin outside the compiled scope", async () => {
    const compiled = await compileWorkflow({
      instruction: "Show non-US orders and export reviewed rows",
      input: { csv: createOrdersCsv() },
      origin: "https://demo.invalid",
    });
    const interpreter = createWorkflowInterpreter();

    await expect(
      interpreter.run(compiled.workflow, { csv: createOrdersCsv() }, {
        authorization: { origin: "https://demo.invalid", grantedCapabilities: [] },
      }),
    ).rejects.toThrow("Missing workflow capabilities");
    await expect(
      interpreter.run(compiled.workflow, { csv: createOrdersCsv() }, {
        authorization: { origin: "https://other.invalid", grantedCapabilities: compiled.requiredCapabilities },
      }),
    ).rejects.toThrow("not authorized for the current origin");
  });

  it("rejects a source-backed workflow after the source revision changes", async () => {
    const compiled = await compileWorkflow({
      id: "source-bound-sort",
      name: "Source-bound sort",
      instruction: "sort by amount ascending",
      inputColumns: ["amount"],
      sourceId: "orders-source",
      sourceRevision: "revision-1",
    });
    const interpreter = createWorkflowInterpreter();

    await expect(
      interpreter.run(compiled.workflow, { csv: "amount\n1" }, {
        authorization: {
          grantedCapabilities: compiled.requiredCapabilities,
          sourceRevisions: { "orders-source": "revision-2" },
        },
      }),
    ).rejects.toThrow("missing or stale");
  });

  it("checks implementation-level tool capabilities before invoking a vetted tool", async () => {
    const execute = vi.fn(async () => ({ ok: true }) as const);
    const workflow: WorkflowDefinition = {
      schemaVersion: 1,
      id: "tool-capability-check",
      version: "1.0.0",
      name: "Tool capability check",
      inputSchema: {},
      requiredCapabilities: ["tool:lookup@1"],
      sourceDependencies: [],
      toolDependencies: [{ name: "lookup", version: "1" }],
      limits: { maxRows: 10, maxSteps: 2, maxDurationMs: 5_000 },
      steps: [{ id: "lookup", op: "tool.invoke", tool: { name: "lookup", version: "1" }, arguments: {} }],
    };
    const interpreter = createWorkflowInterpreter({
      tools: [{
        descriptor: {
          name: "lookup",
          version: "1",
          effect: "read",
          timeoutMs: 1_000,
          maxOutputBytes: 1_024,
          idempotency: "read-only",
          requiredCapabilities: ["network:read"],
        },
        execute,
      }],
    });

    const result = await interpreter.run(workflow, {}, {
      authorization: { grantedCapabilities: ["tool:lookup@1"] },
    });
    expect(result.state).toBe("failed");
    expect(result.receipts[0]?.errorCode).toBe("PERMISSION_DENIED");
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects extraction adapter output that does not match the reviewed field schema", async () => {
    const workflow: WorkflowDefinition = {
      schemaVersion: 1,
      id: "strict-extraction",
      version: "1.0.0",
      name: "Strict extraction",
      inputSchema: { text: "string" },
      requiredCapabilities: [],
      sourceDependencies: [],
      toolDependencies: [],
      limits: { maxRows: 10, maxSteps: 1, maxDurationMs: 5_000 },
      steps: [{ id: "extract", op: "text.extract", input: { ref: "input.text" }, schema: { date: "string" } }],
    };
    const interpreter = createWorkflowInterpreter({
      adapters: { textExtract: async () => ({ date: "2026-10-08", fabricated: true }) },
    });

    const result = await interpreter.run(workflow, { text: "The date is 2026-10-08." }, { authorization: { grantedCapabilities: [] } });
    expect(result.state).toBe("failed");
    expect(result.receipts[0]?.errorCode).toBe("INVALID_MODEL_OUTPUT");
  });

  it("rejects structured extraction output above 16 KiB before checkpointing it", async () => {
    const workflow: WorkflowDefinition = {
      schemaVersion: 1,
      id: "bounded-extraction",
      version: "1.0.0",
      name: "Bounded extraction",
      inputSchema: { text: "string" },
      requiredCapabilities: [],
      sourceDependencies: [],
      toolDependencies: [],
      limits: { maxRows: 10, maxSteps: 1, maxDurationMs: 5_000 },
      steps: [{ id: "extract", op: "text.extract", input: { ref: "input.text" }, schema: { answer: "string" } }],
    };
    const checkpointStore = new MemoryCheckpointStore();
    const interpreter = createWorkflowInterpreter({
      checkpointStore,
      adapters: { textExtract: async () => ({ answer: "é".repeat(8_190) }) },
    });

    const result = await interpreter.run(workflow, { text: "Extract an answer." }, {
      runId: "oversized-extraction",
      authorization: { grantedCapabilities: [] },
    });
    const checkpoint = await checkpointStore.load("oversized-extraction");

    expect(result.state).toBe("failed");
    expect(result.receipts[0]?.errorCode).toBe("PAYLOAD_TOO_LARGE");
    expect(checkpoint?.values["steps.extract"]).toBeUndefined();
  });

  it("rejects source operations without exact dependencies and gives adapters a frozen allowlist", async () => {
    const workflow: WorkflowDefinition = {
      schemaVersion: 1,
      id: "source-allowlist-check",
      version: "1.0.0",
      name: "Source allowlist check",
      inputSchema: { selector: "object" },
      requiredCapabilities: ["source:read"],
      sourceDependencies: [],
      toolDependencies: [],
      limits: { maxRows: 10, maxSteps: 1, maxDurationMs: 5_000 },
      steps: [{ id: "source", op: "source.select", input: { ref: "input.selector" } }],
    };
    expect(() => validateWorkflow(workflow)).toThrow("exact source dependency");

    workflow.sourceDependencies = [{ sourceId: "source-1", revision: "revision-1" }];
    const sourceSelect = vi.fn(async (_value: JsonValue, access: WorkflowSourceAccess) => {
      expect(Object.isFrozen(access)).toBe(true);
      expect(Object.isFrozen(access.sources)).toBe(true);
      expect(access.sources).toEqual([{ sourceId: "source-1", revision: "revision-1" }]);
      return { sourceId: access.sources[0]?.sourceId ?? "missing" };
    });
    const interpreter = createWorkflowInterpreter({ adapters: { sourceSelect } });
    const result = await interpreter.run(workflow, { selector: {} }, {
      authorization: {
        grantedCapabilities: ["source:read"],
        sourceRevisions: { "source-1": "revision-1" },
      },
    });
    expect(result.state).toBe("succeeded");
    expect(sourceSelect).toHaveBeenCalledOnce();
  });
});
