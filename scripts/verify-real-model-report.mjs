import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { BUILD_PROVENANCE_PATH, buildProvenanceSha256 } from './lib/build-provenance.mjs';

const REPORT_SCHEMA_VERSION = 3;
const LATENCY_SAMPLE_COUNT = 20;
const MARKER_SOURCE = 'BROWSER_CORTEX_OK';
const MARKER_INSTRUCTION = `Reply with the marker ${MARKER_SOURCE} in lowercase and nothing else.`;
const EXACT_MODEL_MARKER = 'browser_cortex_ok';
const QUALITY_PROBE_SET = 'browser-cortex-real-model-synthetic-v1';
const GENERATION_QUALITY_GATE = 'schema-validity';
const requiredLimitationIds = [
  'adapter-runtime-scope',
  'generation-cancellation-only',
  'latency-sample-boundary',
  'single-device-observation',
  'small-synthetic-quality-set',
  'storage-estimate-boundary',
  'unmeasured-resource-claims',
];
const expectedEmbeddingProbes = new Map([
  ['retrieval-delivery-date', 0],
  ['retrieval-quantity-discrepancy', 1],
  ['retrieval-vault-timeout', 2],
]);
const expectedGenerationProbes = new Map([
  ['extract-known-delivery-date', { category: 'fact-extraction', answer: '2026-10-14', abstain: false }],
  ['abstain-missing-invoice-total', { category: 'abstention', answer: '', abstain: true }],
]);

const reportPath = 'benchmarks/reports/real-model/latest.json';
const reportBytes = await readFile(reportPath).catch(() => {
  throw new Error('Trusted release requires a real-model report from pnpm verify:real-model.');
});
const report = JSON.parse(reportBytes.toString('utf8'));
const compatibility = JSON.parse(await readFile('release/compatibility.json', 'utf8'));
const registry = JSON.parse(await readFile('models/registry.json', 'utf8'));
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
const generationModel = registry.models?.find((model) => model.taskCapabilities?.includes('generation'));
const embeddingModel = registry.models?.find((model) => model.taskCapabilities?.includes('embedding'));
const embeddingArtifact = embeddingModel?.artifacts?.find((artifact) => artifact.kind === 'model-data');
const buildProvenanceBytes = await readFile(BUILD_PROVENANCE_PATH);
const buildProvenance = JSON.parse(buildProvenanceBytes.toString('utf8'));

function positiveFinite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} is not a positive measured duration.`);
  }
}

function nonnegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is not a nonnegative safe integer.`);
}

function nonemptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0 || value === 'unavailable') {
    throw new Error(`${label} is missing.`);
  }
}

function percentile(samples, quantile) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)];
}

function assertLatencySummary(samples, summary, label) {
  if (!Array.isArray(samples) || samples.length !== LATENCY_SAMPLE_COUNT) {
    throw new Error(`${label} must contain exactly ${LATENCY_SAMPLE_COUNT} samples.`);
  }
  for (const [index, sample] of samples.entries()) positiveFinite(sample, `${label} sample ${index + 1}`);
  if (
    summary?.method !== 'nearest-rank' ||
    summary?.sampleCount !== LATENCY_SAMPLE_COUNT ||
    summary?.minMs !== Math.min(...samples) ||
    summary?.p50Ms !== percentile(samples, 0.5) ||
    summary?.p95Ms !== percentile(samples, 0.95) ||
    summary?.maxMs !== Math.max(...samples)
  ) {
    throw new Error(`${label} percentile summary does not match its raw samples.`);
  }
}

function assertPerfectSummary(summary, expectedTotal, label) {
  if (summary?.passed !== expectedTotal || summary?.total !== expectedTotal || summary?.rate !== 1) {
    throw new Error(`${label} is not a perfect ${expectedTotal}/${expectedTotal} result.`);
  }
}

function assertObservedSummary(summary, passed, total, label) {
  const rate = total === 0 ? 0 : Math.round((passed / total) * 10_000) / 10_000;
  if (summary?.passed !== passed || summary?.total !== total || summary?.rate !== rate) {
    throw new Error(`${label} does not match the recomputed ${passed}/${total} observation.`);
  }
}

function parseStrictQualityOutput(output, label) {
  if (typeof output !== 'string') throw new Error(`${label} output is missing.`);
  let parsed;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    throw new Error(`${label} output is not JSON.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} output is not a JSON object.`);
  }
  const keys = Object.keys(parsed).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== 'abstain' ||
    keys[1] !== 'answer' ||
    typeof parsed.answer !== 'string' ||
    typeof parsed.abstain !== 'boolean'
  ) {
    throw new Error(`${label} output does not satisfy the exact quality schema.`);
  }
  return parsed;
}

function assertStorageSnapshot(snapshot, label) {
  nonnegativeSafeInteger(snapshot?.usageBytes, `${label} storage usage`);
  if (!Number.isSafeInteger(snapshot?.quotaBytes) || snapshot.quotaBytes <= 0) {
    throw new Error(`${label} storage quota is invalid.`);
  }
  if (
    typeof snapshot?.persisted !== 'boolean' ||
    !Array.isArray(snapshot?.cacheNames) ||
    snapshot.cacheNames.some((name) => typeof name !== 'string') ||
    !Array.isArray(snapshot?.indexedDbDatabases) ||
    snapshot.indexedDbDatabases.some((database) =>
      typeof database?.name !== 'string' || !Number.isSafeInteger(database?.version) || database.version < 0) ||
    typeof snapshot?.usageDetails !== 'object' ||
    snapshot.usageDetails === null ||
    Array.isArray(snapshot.usageDetails)
  ) {
    throw new Error(`${label} storage inventory is incomplete.`);
  }
}

if (
  report.schemaVersion !== REPORT_SCHEMA_VERSION ||
  report.status !== 'passed' ||
  report.runner?.sourceCommit !== head ||
  typeof report.runner?.browserVersion !== 'string' ||
  report.runner.browserVersion === 'unavailable' ||
  report.runner?.browserChannel !== 'chrome' ||
  report.runner?.headless !== false ||
  report.runner?.profile !== 'fresh temporary Chrome profile in the operating-system temp directory' ||
  report.consent?.explicitButtonActivation !== true ||
  report.consent?.syntheticInputsOnly !== true ||
  report.environment?.webgpu?.available !== true
) {
  throw new Error('Real-model report is failed, incomplete, or not bound to the current commit and browser environment.');
}

if (
  report.methodology?.qualityProbeSet !== QUALITY_PROBE_SET ||
  report.methodology?.latencySampleCountPerPhase !== LATENCY_SAMPLE_COUNT ||
  report.methodology?.percentileMethod !== 'nearest-rank' ||
  report.methodology?.latencySampleScope !== 'sequential inference after phase load; installation measured separately' ||
  report.methodology?.markerSource !== MARKER_SOURCE ||
  report.methodology?.markerInstruction !== MARKER_INSTRUCTION ||
  report.methodology?.exactOutputMarker !== EXACT_MODEL_MARKER ||
  report.methodology?.generationQualityGate !== GENERATION_QUALITY_GATE ||
  report.methodology?.coldProfile !== 'fresh temporary Chrome profile with empty model cache' ||
  report.methodology?.warmProfile !== 'same temporary Chrome profile after cold model acquisition'
) {
  throw new Error('Real-model methodology metadata is incomplete or unexpected.');
}

if (
  report.consent?.embeddingHost !== 'huggingface.co' ||
  report.consent?.embeddingReviewedArtifactBytes !== embeddingArtifact?.bytes ||
  report.consent?.generationHost !== 'huggingface.co' ||
  report.consent?.generationWeightBytes !== generationModel?.weightBytes ||
  report.consent?.packagedExecutableBytes !== generationModel?.artifacts?.find((artifact) => artifact.kind === 'executable-model-library')?.bytes
) {
  throw new Error('Real-model consent metadata does not match the reviewed model registry.');
}

nonemptyString(report.environment?.userAgent, 'Browser user agent');
nonemptyString(report.environment?.platform, 'Browser platform');
const browserVisibleGpuIdentity = [
  report.environment?.webglRenderer,
  report.environment?.webgpu?.vendor,
  report.environment?.webgpu?.architecture,
  report.environment?.webgpu?.device,
  report.environment?.webgpu?.description,
].filter((value) => typeof value === 'string' && value.trim().length > 0);
if (browserVisibleGpuIdentity.length === 0) {
  throw new Error('Browser-visible GPU identity is missing.');
}
if (!Number.isSafeInteger(report.environment?.hardwareConcurrency) || report.environment.hardwareConcurrency <= 0) {
  throw new Error('Browser-visible hardware concurrency is invalid.');
}
positiveFinite(report.environment?.deviceMemoryGiB, 'Browser-visible device memory');
if (typeof report.environment?.crossOriginIsolated !== 'boolean') {
  throw new Error('Browser cross-origin isolation observation is missing.');
}
const host = report.runner?.host;
for (const [value, label] of [
  [host?.platform, 'Host platform'],
  [host?.release, 'Host release'],
  [host?.architecture, 'Host architecture'],
  [host?.cpuModel, 'Host CPU model'],
]) nonemptyString(value, label);
if (!Number.isSafeInteger(host?.logicalProcessors) || host.logicalProcessors <= 0) {
  throw new Error('Host logical processor count is invalid.');
}
if (!Number.isSafeInteger(host?.totalMemoryBytes) || host.totalMemoryBytes <= 0) {
  throw new Error('Host memory observation is invalid.');
}

if (!Array.isArray(report.limitations) || report.limitations.length !== requiredLimitationIds.length) {
  throw new Error('Real-model limitations are missing or incomplete.');
}
const limitationIds = report.limitations.map((limitation) => limitation?.id).sort();
if (
  limitationIds.some((id, index) => id !== requiredLimitationIds[index]) ||
  report.limitations.some((limitation) => typeof limitation?.statement !== 'string' || limitation.statement.trim().length < 40)
) {
  throw new Error('Real-model limitations do not match the required coverage boundaries.');
}

const observedAt = Date.parse(report.observedAt);
if (
  !Number.isFinite(observedAt) ||
  observedAt > Date.now() + 5 * 60_000 ||
  Date.now() - observedAt > 24 * 60 * 60_000
) {
  throw new Error('Real-model observation timestamp is invalid or older than the 24-hour trust window.');
}
const invocationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
if (
  report.evidence?.scope !== 'adapter-runtime' ||
  !invocationIdPattern.test(report.evidence?.invocationId) ||
  report.evidence?.archive?.filename !== compatibility.archive?.filename ||
  report.evidence?.archive?.bytes !== compatibility.archive?.bytes ||
  report.evidence?.archive?.sha256 !== compatibility.archive?.sha256 ||
  report.evidence?.buildProvenance?.filename !== BUILD_PROVENANCE_PATH ||
  report.evidence?.buildProvenance?.sha256 !== buildProvenanceSha256(buildProvenanceBytes) ||
  report.evidence?.buildProvenance?.sourceTree !== buildProvenance.source?.tree ||
  report.evidence?.buildProvenance?.extensionDigest !== buildProvenance.applications?.extension?.digest
) {
  throw new Error('Real-model report is not bound to the exact archive and production build provenance.');
}

if (
  report.embedding?.modelId !== embeddingModel?.sourceModel ||
  report.embedding?.revision !== embeddingModel?.revision ||
  report.embedding?.runtime !== '@huggingface/transformers 4.3.0' ||
  report.embedding?.device !== 'wasm' ||
  report.embedding?.topMatch !== 0 ||
  !Number.isSafeInteger(report.embedding?.dimensions) ||
  report.embedding.dimensions < 32 ||
  !Array.isArray(report.embedding?.similarities) ||
  report.embedding.similarities.length !== 3 ||
  report.embedding.similarities.some((similarity) => typeof similarity !== 'number' || !Number.isFinite(similarity))
) {
  throw new Error('Real embedding evidence does not match the reviewed model or retrieval marker probe.');
}
for (const phase of ['cold', 'warm']) {
  const result = report.embedding?.[phase];
  positiveFinite(result?.installMs, `${phase} embedding install`);
  positiveFinite(result?.inferenceMs, `${phase} embedding first inference`);
  assertLatencySummary(result?.inferenceSamplesMs, result?.inferenceLatency, `${phase} embedding inference`);
  if (
    result.inferenceMs !== result.inferenceSamplesMs[0] ||
    result.dimensions !== report.embedding.dimensions ||
    result.topMatch !== 0 ||
    !Array.isArray(result.similarities) ||
    result.similarities.length !== 3 ||
    result.similarities.some((similarity) => typeof similarity !== 'number' || !Number.isFinite(similarity)) ||
    result.similarities.indexOf(Math.max(...result.similarities)) !== 0
  ) {
    throw new Error(`${phase} embedding first-inference alias does not match the first raw sample.`);
  }
}

const embeddingQuality = report.embedding?.quality;
if (
  embeddingQuality?.probeSetId !== QUALITY_PROBE_SET ||
  embeddingQuality?.synthetic !== true ||
  !Array.isArray(embeddingQuality?.probes) ||
  embeddingQuality.probes.length !== expectedEmbeddingProbes.size
) {
  throw new Error('Embedding quality evidence is missing or uses an unexpected probe set.');
}
const observedEmbeddingProbeIds = new Set();
for (const probe of embeddingQuality.probes) {
  const expectedTopMatch = expectedEmbeddingProbes.get(probe?.id);
  if (expectedTopMatch === undefined || observedEmbeddingProbeIds.has(probe.id)) {
    throw new Error('Embedding quality evidence contains an unknown or duplicate probe.');
  }
  observedEmbeddingProbeIds.add(probe.id);
  if (
    probe.expectedTopMatch !== expectedTopMatch ||
    probe.topMatch !== expectedTopMatch ||
    probe.schemaValid !== true ||
    probe.semanticCorrect !== true ||
    !Array.isArray(probe.similarities) ||
    probe.similarities.length !== 3 ||
    probe.similarities.some((similarity) => typeof similarity !== 'number' || !Number.isFinite(similarity)) ||
    probe.similarities.indexOf(Math.max(...probe.similarities)) !== expectedTopMatch
  ) {
    throw new Error(`Embedding quality probe ${probe.id} did not satisfy its vector and retrieval contract.`);
  }
}
assertPerfectSummary(embeddingQuality.vectorValidity, expectedEmbeddingProbes.size, 'Embedding vector validity');
assertPerfectSummary(embeddingQuality.semanticCorrectness, expectedEmbeddingProbes.size, 'Embedding semantic correctness');

if (
  report.generation?.modelId !== generationModel?.runtimeModelId ||
  report.generation?.revision !== generationModel?.revision ||
  report.generation?.sourceRevision !== generationModel?.sourceRevision ||
  report.generation?.runtime !== '@mlc-ai/web-llm 0.2.85' ||
  report.generation?.device !== 'webgpu' ||
  report.generation?.exactOutputMarker !== EXACT_MODEL_MARKER
) {
  throw new Error('Real generation evidence does not match the reviewed model registry and exact marker.');
}
for (const phase of ['cold', 'warm']) {
  const result = report.generation?.[phase];
  if (
    result?.exactMarker !== true ||
    result.output?.trim() !== EXACT_MODEL_MARKER ||
    result.exactMarkerPasses !== LATENCY_SAMPLE_COUNT ||
    !Array.isArray(result.samples) ||
    result.samples.length !== LATENCY_SAMPLE_COUNT
  ) {
    throw new Error(`${phase} generation did not satisfy the exact synthetic output probe in every sample.`);
  }
  positiveFinite(result.installMs, `${phase} generation install`);
  const firstTokenSamples = [];
  const totalSamples = [];
  for (const [index, sample] of result.samples.entries()) {
    if (
      sample?.completed !== true ||
      sample?.exactMarker !== true ||
      sample?.output?.trim() !== EXACT_MODEL_MARKER ||
      !Number.isSafeInteger(sample?.tokenEvents) ||
      sample.tokenEvents < 1
    ) {
      throw new Error(`${phase} generation sample ${index + 1} is not a completed exact-marker stream.`);
    }
    positiveFinite(sample.firstTokenMs, `${phase} generation sample ${index + 1} first token`);
    positiveFinite(sample.totalGenerationMs, `${phase} generation sample ${index + 1} total`);
    if (sample.totalGenerationMs < sample.firstTokenMs) {
      throw new Error(`${phase} generation sample ${index + 1} completed before its first token.`);
    }
    firstTokenSamples.push(sample.firstTokenMs);
    totalSamples.push(sample.totalGenerationMs);
  }
  if (
    result.firstTokenMs !== firstTokenSamples[0] ||
    result.totalGenerationMs !== totalSamples[0] ||
    result.output !== result.samples[0].output
  ) {
    throw new Error(`${phase} generation compatibility fields do not match the first raw sample.`);
  }
  assertLatencySummary(firstTokenSamples, result.firstTokenLatency, `${phase} generation first-token latency`);
  assertLatencySummary(totalSamples, result.totalGenerationLatency, `${phase} generation total latency`);
}

const generationQuality = report.generation?.quality;
if (
  generationQuality?.probeSetId !== QUALITY_PROBE_SET ||
  generationQuality?.synthetic !== true ||
  !Array.isArray(generationQuality?.probes) ||
  generationQuality.probes.length !== expectedGenerationProbes.size
) {
  throw new Error('Generation quality evidence is missing or uses an unexpected probe set.');
}
const observedGenerationProbeIds = new Set();
let semanticPasses = 0;
let abstentionPasses = 0;
let abstentionTotal = 0;
for (const probe of generationQuality.probes) {
  const expected = expectedGenerationProbes.get(probe?.id);
  if (!expected || observedGenerationProbeIds.has(probe.id)) {
    throw new Error('Generation quality evidence contains an unknown or duplicate probe.');
  }
  observedGenerationProbeIds.add(probe.id);
  const parsed = parseStrictQualityOutput(probe.output, `Generation quality probe ${probe.id}`);
  const recordedParsedKeys = typeof probe.parsed === 'object' && probe.parsed !== null && !Array.isArray(probe.parsed)
    ? Object.keys(probe.parsed).sort()
    : [];
  const semanticCorrect = parsed.answer === expected.answer && parsed.abstain === expected.abstain;
  if (semanticCorrect) semanticPasses += 1;
  if (expected.category === 'abstention') {
    abstentionTotal += 1;
    if (semanticCorrect) abstentionPasses += 1;
  }
  if (
    probe.category !== expected.category ||
    probe.expected?.answer !== expected.answer ||
    probe.expected?.abstain !== expected.abstain ||
    recordedParsedKeys.length !== 2 ||
    recordedParsedKeys[0] !== 'abstain' ||
    recordedParsedKeys[1] !== 'answer' ||
    probe.parsed?.answer !== parsed.answer ||
    probe.parsed?.abstain !== parsed.abstain ||
    probe.schemaValid !== true ||
    probe.semanticCorrect !== semanticCorrect
  ) {
    throw new Error(`Generation quality probe ${probe.id} is inconsistent with its raw output or fixed definition.`);
  }
}
assertPerfectSummary(generationQuality.schemaValidity, expectedGenerationProbes.size, 'Generation schema validity');
assertObservedSummary(
  generationQuality.semanticCorrectness,
  semanticPasses,
  expectedGenerationProbes.size,
  'Generation semantic correctness',
);
assertObservedSummary(generationQuality.abstention, abstentionPasses, abstentionTotal, 'Generation abstention');
if (
  generationQuality.acceptance?.gate !== GENERATION_QUALITY_GATE ||
  generationQuality.acceptance?.passed !== true ||
  generationQuality.acceptance?.semanticCorrectness !== 'reported-only' ||
  generationQuality.acceptance?.abstention !== 'reported-only'
) {
  throw new Error('Generation quality acceptance metadata does not match the schema-only release gate.');
}

const cancellation = report.generation?.cancellation;
if (
  cancellation?.kind !== 'in-flight-generation' ||
  cancellation?.trigger !== 'after-first-token' ||
  cancellation?.observedStart !== true ||
  cancellation?.abortRequested !== true ||
  cancellation?.signalAborted !== true ||
  cancellation?.cancelledEvent !== true ||
  cancellation?.completedAfterAbort !== false ||
  cancellation?.errorAfterAbort !== false ||
  cancellation?.tokenEventsBeforeAbort !== 1 ||
  cancellation?.tokenEventsAfterAbort !== 0 ||
  cancellation?.recovery?.exactMarker !== true ||
  cancellation?.recovery?.output?.trim() !== EXACT_MODEL_MARKER ||
  cancellation?.passed !== true
) {
  throw new Error('Real generation cancellation or post-cancellation recovery evidence is invalid.');
}
positiveFinite(cancellation.elapsedMs, 'Generation cancellation');
positiveFinite(cancellation.recovery.firstTokenMs, 'Post-cancellation recovery first token');
positiveFinite(cancellation.recovery.totalGenerationMs, 'Post-cancellation recovery total');
if (cancellation.recovery.totalGenerationMs < cancellation.recovery.firstTokenMs) {
  throw new Error('Post-cancellation recovery completed before its first token.');
}

assertStorageSnapshot(report.storage?.before, 'Before');
assertStorageSnapshot(report.storage?.after, 'After');
if (
  report.storage?.scope !== 'fresh temporary verification origin profile estimate' ||
  !Number.isSafeInteger(report.storage?.observedUsageDeltaBytes) ||
  report.storage.observedUsageDeltaBytes !== report.storage.after.usageBytes - report.storage.before.usageBytes
) {
  throw new Error('Real-model storage delta is missing or inconsistent with its snapshots.');
}

const reportHash = createHash('sha256').update(reportBytes).digest('hex');
if (
  compatibility.commit !== head ||
  compatibility.realModelEvidence?.filename !== reportPath ||
  compatibility.realModelEvidence?.reportSchemaVersion !== REPORT_SCHEMA_VERSION ||
  compatibility.realModelEvidence?.sha256 !== reportHash ||
  compatibility.realModelEvidence?.sourceCommit !== head ||
  compatibility.realModelEvidence?.observedAt !== report.observedAt ||
  compatibility.realModelEvidence?.scope !== report.evidence.scope ||
  compatibility.realModelEvidence?.invocationId !== report.evidence.invocationId ||
  compatibility.realModelEvidence?.archiveSha256 !== report.evidence.archive.sha256 ||
  compatibility.realModelEvidence?.buildProvenanceSha256 !== report.evidence.buildProvenance.sha256 ||
  compatibility.realModelEvidence?.extensionDigest !== report.evidence.buildProvenance.extensionDigest
) {
  throw new Error('Release compatibility metadata is not bound to the current real-model report.');
}

console.log(`Trusted real-model evidence verified for commit ${head} with report sha256:${reportHash}.`);
