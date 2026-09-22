export type ResearchRoute = 'deterministic' | 'retrieval' | 'local-model' | 'unsupported';

export interface RouterCase {
  text: string;
  expected: ResearchRoute;
  outOfDistribution?: boolean;
}

const deterministicTerms = new Set(['filter', 'sort', 'sum', 'count', 'compare', 'export']);
const retrievalTerms = new Set(['find', 'where', 'source', 'passage', 'mentioned']);
const semanticTerms = new Set(['summarize', 'extract', 'explain']);

export function ruleRoute(text: string): ResearchRoute {
  const terms = new Set(text.toLocaleLowerCase('en-US').split(/[^a-z0-9]+/u));
  if ([...deterministicTerms].some((term) => terms.has(term))) return 'deterministic';
  if ([...retrievalTerms].some((term) => terms.has(term))) return 'retrieval';
  if ([...semanticTerms].some((term) => terms.has(term))) return 'local-model';
  return 'unsupported';
}

export function evaluateRouter(cases: readonly RouterCase[]): {
  accuracy: number;
  outOfDistributionRejected: number;
  errors: Array<{ index: number; expected: ResearchRoute; actual: ResearchRoute }>;
} {
  const errors: Array<{ index: number; expected: ResearchRoute; actual: ResearchRoute }> = [];
  let rejected = 0;
  cases.forEach((entry, index) => {
    const actual = ruleRoute(entry.text);
    if (entry.outOfDistribution && actual === 'unsupported') rejected += 1;
    if (actual !== entry.expected) errors.push({ index, expected: entry.expected, actual });
  });
  return {
    accuracy: cases.length ? (cases.length - errors.length) / cases.length : 0,
    outOfDistributionRejected: rejected,
    errors
  };
}

// A learned baseline can be added only after a held-out corpus exists. Permission
// decisions remain deterministic and are intentionally absent from this harness.

