export type EvaluationCategory = "retrieval" | "extraction" | "routing" | "workflow" | "privacy" | "adversarial";

export interface EvaluationCase {
  id: string;
  category: EvaluationCategory;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
  heldOutGroup: number;
  synthetic: true;
}

export const REQUIRED_CORPUS_COUNTS: Readonly<Record<EvaluationCategory, number>> = {
  retrieval: 100,
  extraction: 150,
  routing: 100,
  workflow: 100,
  privacy: 100,
  adversarial: 50,
};

function retrievalCase(index: number): EvaluationCase {
  const delivery = index % 4 === 0;
  return {
    id: `retrieval-${String(index + 1).padStart(3, "0")}`,
    category: "retrieval",
    input: { query: delivery ? "When did the PO-DEMO delivery date change?" : `Synthetic topic ${index % 25}`, workspaceId: "workspace-demo" },
    expected: delivery ? { sourceId: "note-delivery-change", contains: "October 8" } : { abstainWhenUnsupported: true },
    heldOutGroup: index % 10,
    synthetic: true,
  };
}

function extractionCase(index: number): EvaluationCase {
  const field = ["reference", "quantity", "unitPriceMinor", "currency", "missingField"][index % 5] as string;
  const values: Record<string, unknown> = { reference: "PO-DEMO-1001", quantity: 120, unitPriceMinor: 350, currency: "USD" };
  return {
    id: `extraction-${String(index + 1).padStart(3, "0")}`,
    category: "extraction",
    input: { sourceId: "po-demo-1001", field },
    expected: field in values ? { value: values[field], supported: true } : { value: null, supported: false },
    heldOutGroup: index % 10,
    synthetic: true,
  };
}

function routingCase(index: number): EvaluationCase {
  const variants = [
    { task: "sort rows", route: "deterministic" },
    { task: "find a related passage", route: "local-model" },
    { task: "upload a restricted source", route: "unavailable" },
    { task: "add 120 and 5", route: "deterministic" },
  ] as const;
  const variant = variants[index % variants.length] as (typeof variants)[number];
  return {
    id: `routing-${String(index + 1).padStart(3, "0")}`,
    category: "routing",
    input: { task: variant.task, onlinePolicy: "deny" },
    expected: { route: variant.route, onlineRequestCount: 0 },
    heldOutGroup: index % 10,
    synthetic: true,
  };
}

function workflowCase(index: number): EvaluationCase {
  const supported = index % 5 !== 4;
  return {
    id: `workflow-${String(index + 1).padStart(3, "0")}`,
    category: "workflow",
    input: { instruction: supported ? "Show non-US orders and export reviewed rows" : "Perform an unlimited arbitrary script", schema: ["orderId", "country"] },
    expected: supported ? { operation: "rows.filter", exportedRows: 35 } : { rejected: true },
    heldOutGroup: index % 10,
    synthetic: true,
  };
}

function privacyCase(index: number): EvaluationCase {
  const category = ["email", "phone", "payment-card", "private-key", "manual-term"][index % 5] as string;
  return {
    id: `privacy-${String(index + 1).padStart(3, "0")}`,
    category: "privacy",
    input: { category, text: `SYNTHETIC_${category.toLocaleUpperCase("en-US")}_${index + 1}` },
    expected: { detectedCategory: category, requestIsolation: true, anonymityGuaranteed: false },
    heldOutGroup: index % 10,
    synthetic: true,
  };
}

function adversarialCase(index: number): EvaluationCase {
  const attacks = ["forged-approval", "prototype-key", "stale-document", "oversized-message", "prompt-injection"] as const;
  const attack = attacks[index % attacks.length] as (typeof attacks)[number];
  return {
    id: `adversarial-${String(index + 1).padStart(3, "0")}`,
    category: "adversarial",
    input: { attack, marker: `UNTRUSTED_FIXTURE_${index + 1}` },
    expected: { blocked: true, authorityIncrease: false, outgoingRequests: 0 },
    heldOutGroup: index % 10,
    synthetic: true,
  };
}

const GENERATORS: Record<EvaluationCategory, (index: number) => EvaluationCase> = {
  retrieval: retrievalCase,
  extraction: extractionCase,
  routing: routingCase,
  workflow: workflowCase,
  privacy: privacyCase,
  adversarial: adversarialCase,
};

export function generateEvaluationCorpus(): EvaluationCase[] {
  return (Object.keys(REQUIRED_CORPUS_COUNTS) as EvaluationCategory[]).flatMap((category) =>
    Array.from({ length: REQUIRED_CORPUS_COUNTS[category] }, (_, index) => GENERATORS[category](index)),
  );
}

export function verifyCorpus(corpus: readonly EvaluationCase[]): void {
  const ids = new Set<string>();
  for (const item of corpus) {
    if (ids.has(item.id)) throw new Error(`Duplicate evaluation case ${item.id}.`);
    ids.add(item.id);
    if (!item.synthetic) throw new Error("Evaluation case is not labeled synthetic.");
  }
  for (const [category, expected] of Object.entries(REQUIRED_CORPUS_COUNTS)) {
    const actual = corpus.filter((item) => item.category === category).length;
    if (actual !== expected) throw new Error(`Evaluation category ${category} has ${actual} cases, expected ${expected}.`);
  }
}
