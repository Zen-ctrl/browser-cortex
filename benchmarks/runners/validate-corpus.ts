import { generateEvaluationCorpus, verifyCorpus } from "../../packages/testkit/src/index.js";

const corpus = generateEvaluationCorpus();
verifyCorpus(corpus);

const counts = new Map<string, number>();
for (const item of corpus) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
for (const [category, count] of counts) {
  console.log(`${category}: ${count}`);
}
console.log(`total: ${corpus.length}`);
