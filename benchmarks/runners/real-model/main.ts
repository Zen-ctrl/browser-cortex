import {
  createTransformersEmbeddingRuntime,
  VERIFIED_MINILM_MODEL,
  type EmbeddingInstallEvent,
  type TransformersEmbeddingRuntime,
} from '../../../packages/runtime-transformers/src/index';
import {
  createWebLLMRuntime,
  VERIFIED_SMOLLM2_MODEL,
  type GenerationEvent,
  type GenerationRequest,
  type ModelInstallEvent,
  type WebLLMRuntime,
} from '../../../packages/runtime-webllm/src/index';

const LATENCY_SAMPLE_COUNT = 20;
const MARKER_SOURCE = 'BROWSER_CORTEX_OK';
const MARKER_INSTRUCTION = `Reply with the marker ${MARKER_SOURCE} in lowercase and nothing else.`;
const EXACT_MODEL_MARKER = 'browser_cortex_ok';
const QUALITY_PROBE_SET = 'browser-cortex-real-model-synthetic-v1';
const GENERATION_QUALITY_GATE = 'schema-validity';

type Timing = { installMs: number; inferenceMs: number };

interface LatencySummary {
  method: 'nearest-rank';
  sampleCount: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

interface VerificationReport {
  schemaVersion: 2;
  status: 'passed' | 'failed';
  observedAt: string;
  environment: Record<string, unknown>;
  consent: Record<string, unknown>;
  methodology: Record<string, unknown>;
  embedding?: Record<string, unknown>;
  generation?: Record<string, unknown>;
  storage?: Record<string, unknown>;
  error?: { name: string; message: string };
}

interface GenerationMeasurement {
  firstTokenMs?: number;
  totalGenerationMs: number;
  output: string;
  tokenEvents: number;
  completed: boolean;
}

interface GenerationPhase {
  installMs: number;
  firstTokenMs?: number;
  totalGenerationMs: number;
  output: string;
  exactMarker: boolean;
  exactMarkerPasses: number;
  samples: Array<GenerationMeasurement & { exactMarker: boolean }>;
  firstTokenLatency: LatencySummary;
  totalGenerationLatency: LatencySummary;
  events: ModelInstallEvent[];
}

const embeddingPassages = [
  'Shipment demo-17 was rescheduled. The revised delivery date is October 14, 2026.',
  'The invoice lists five additional units compared with the purchase order.',
  'The encrypted local vault locks after the configured inactivity period.',
] as const;

const embeddingQualityProbes = [
  {
    id: 'retrieval-delivery-date',
    query: 'What is the revised date for the shipment?',
    expectedTopMatch: 0,
  },
  {
    id: 'retrieval-quantity-discrepancy',
    query: 'Which note reports a quantity mismatch between an invoice and a purchase order?',
    expectedTopMatch: 1,
  },
  {
    id: 'retrieval-vault-timeout',
    query: 'What happens after the configured inactivity period?',
    expectedTopMatch: 2,
  },
] as const;

const generationQualityProbes = [
  {
    id: 'extract-known-delivery-date',
    category: 'fact-extraction',
    record: 'shipment_id: demo-17\ndelivery_date: 2026-10-14',
    question: 'What is the delivery_date?',
    expectedAnswer: '2026-10-14',
    expectedAbstain: false,
  },
  {
    id: 'abstain-missing-invoice-total',
    category: 'abstention',
    record: 'shipment_id: demo-18\ndelivery_date: 2026-10-14',
    question: 'What is the invoice_total?',
    expectedAnswer: '',
    expectedAbstain: true,
  },
] as const;

const generationProbeSchema = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    abstain: { type: 'boolean' },
  },
  required: ['answer', 'abstain'],
  additionalProperties: false,
} as const;

declare global {
  interface Window {
    __BROWSER_CORTEX_REPORT__?: VerificationReport;
  }
}

function requiredElement<TElement extends Element>(selector: string): TElement {
  const element = document.querySelector<TElement>(selector);
  if (!element) throw new Error(`Real-model verification control ${selector} is missing.`);
  return element;
}

const consent = requiredElement<HTMLButtonElement>('#consent');
const status = requiredElement<HTMLElement>('#status');
const output = requiredElement<HTMLElement>('#output');

function write(message: string): void {
  status.textContent = message;
  output.textContent = `${output.textContent ?? ''}${message}\n`;
  console.info(`[browser-cortex-real-model] ${message}`);
}

function elapsed(started: number): number {
  return Math.round((performance.now() - started) * 100) / 100;
}

function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length === 0) throw new Error('Embedding dimensions do not match.');
  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
}

function percentile(samples: readonly number[], quantile: number): number {
  if (samples.length === 0) throw new Error('A percentile requires at least one latency sample.');
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(quantile * sorted.length) - 1);
  const value = sorted[index];
  if (value === undefined) throw new Error('A percentile sample is missing.');
  return value;
}

function latencySummary(samples: readonly number[]): LatencySummary {
  if (samples.some((sample) => !Number.isFinite(sample) || sample <= 0)) {
    throw new Error('Latency samples must be positive finite durations.');
  }
  return {
    method: 'nearest-rank',
    sampleCount: samples.length,
    minMs: Math.min(...samples),
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    maxMs: Math.max(...samples),
  };
}

function ratio(passed: number, total: number): number {
  return total === 0 ? 0 : Math.round((passed / total) * 10_000) / 10_000;
}

async function gpuDetails(): Promise<Record<string, unknown>> {
  type Adapter = {
    info: { vendor?: string; architecture?: string; device?: string; description?: string };
    features: Iterable<string>;
  };
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<Adapter | null> } }).gpu;
  if (!gpu) return { available: false };
  const adapter = await gpu.requestAdapter();
  if (!adapter) return { available: true, adapter: 'unavailable' };
  const info = adapter.info;
  return {
    available: true,
    vendor: info.vendor,
    architecture: info.architecture,
    device: info.device,
    description: info.description,
    features: [...adapter.features].sort(),
  };
}

async function environment(): Promise<Record<string, unknown>> {
  const glCanvas = document.createElement('canvas');
  const gl = glCanvas.getContext('webgl');
  const debug = gl?.getExtension('WEBGL_debug_renderer_info');
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemoryGiB: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
    crossOriginIsolated,
    webglRenderer: gl && debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : undefined,
    webgpu: await gpuDetails(),
  };
}

async function storage(): Promise<Record<string, unknown>> {
  const estimate = await navigator.storage.estimate();
  const usageBytes = estimate.usage;
  const quotaBytes = estimate.quota;
  if (
    typeof usageBytes !== 'number' ||
    !Number.isSafeInteger(usageBytes) ||
    usageBytes < 0 ||
    typeof quotaBytes !== 'number' ||
    !Number.isSafeInteger(quotaBytes) ||
    quotaBytes <= 0
  ) {
    throw new Error('Chrome did not provide a valid storage estimate.');
  }
  const extendedEstimate = estimate as StorageEstimate & { usageDetails?: Record<string, number> };
  const databaseProvider = indexedDB as IDBFactory & {
    databases?: () => Promise<Array<{ name?: string; version?: number }>>;
  };
  const databases = databaseProvider.databases ? await databaseProvider.databases() : [];
  return {
    usageBytes,
    quotaBytes,
    usageDetails: extendedEstimate.usageDetails ?? {},
    persisted: await navigator.storage.persisted(),
    cacheNames: (await caches.keys()).sort(),
    indexedDbDatabases: databases
      .map((database) => ({ name: database.name ?? 'unnamed', version: database.version ?? 0 }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

function ensureInstallSucceeded(events: readonly (EmbeddingInstallEvent | ModelInstallEvent)[], label: string): void {
  const failed = events.find((event) => event.state === 'failed');
  if (failed) throw new Error(`${label} installation failed: ${failed.message ?? 'unknown failure'}`);
  if (!events.some((event) => event.state === 'ready')) throw new Error(`${label} installation did not reach ready state.`);
}

async function measureEmbedding(runtime: TransformersEmbeddingRuntime): Promise<{
  inferenceMs: number;
  dimensions: number;
  similarities: number[];
  topMatch: number;
}> {
  const inputs = [...embeddingPassages, 'When is the revised shipment scheduled to arrive?'];
  const inferenceStarted = performance.now();
  const vectors = await runtime.embed(inputs, new AbortController().signal);
  const inferenceMs = elapsed(inferenceStarted);
  const query = vectors.at(-1);
  if (!query) throw new Error('Embedding query vector is missing.');
  const similarities = vectors.slice(0, -1).map((vector) => cosine(vector, query));
  const topMatch = similarities.indexOf(Math.max(...similarities));
  const dimensions = query.length;
  if (dimensions < 32 || vectors.some((vector) => vector.some((value) => !Number.isFinite(value)))) {
    throw new Error('Embedding runtime returned malformed vectors.');
  }
  return { inferenceMs, dimensions, similarities, topMatch };
}

async function runEmbeddingQuality(runtime: TransformersEmbeddingRuntime): Promise<Record<string, unknown>> {
  const probes = [];
  for (const probe of embeddingQualityProbes) {
    const vectors = await runtime.embed([...embeddingPassages, probe.query], new AbortController().signal);
    const query = vectors.at(-1);
    const schemaValid = Boolean(
      query &&
      query.length >= 32 &&
      vectors.length === embeddingPassages.length + 1 &&
      vectors.every((vector) => vector.length === query.length && vector.every((value) => Number.isFinite(value))),
    );
    const similarities = query ? vectors.slice(0, -1).map((vector) => cosine(vector, query)) : [];
    const topMatch = similarities.length > 0 ? similarities.indexOf(Math.max(...similarities)) : -1;
    probes.push({
      id: probe.id,
      expectedTopMatch: probe.expectedTopMatch,
      topMatch,
      similarities,
      schemaValid,
      semanticCorrect: topMatch === probe.expectedTopMatch,
    });
  }
  const vectorPasses = probes.filter((probe) => probe.schemaValid).length;
  const retrievalPasses = probes.filter((probe) => probe.semanticCorrect).length;
  return {
    probeSetId: QUALITY_PROBE_SET,
    synthetic: true,
    vectorValidity: { passed: vectorPasses, total: probes.length, rate: ratio(vectorPasses, probes.length) },
    semanticCorrectness: { passed: retrievalPasses, total: probes.length, rate: ratio(retrievalPasses, probes.length) },
    probes,
  };
}

async function runEmbedding(label: 'cold' | 'warm', includeQuality: boolean): Promise<{
  timing: Timing;
  dimensions: number;
  similarities: number[];
  topMatch: number;
  inferenceSamplesMs: number[];
  inferenceLatency: LatencySummary;
  events: EmbeddingInstallEvent[];
  quality?: Record<string, unknown>;
}> {
  write(`${label} embedding load started.`);
  const runtime = createTransformersEmbeddingRuntime({
    modelId: VERIFIED_MINILM_MODEL.modelId,
    revision: VERIFIED_MINILM_MODEL.revision,
    dtype: 'q8',
    device: 'wasm',
    allowRemoteModels: true,
    cacheNamespace: 'browser-cortex-real-model-verification',
  });
  try {
    const events: EmbeddingInstallEvent[] = [];
    const installStarted = performance.now();
    for await (const event of runtime.install(new AbortController().signal)) {
      events.push(event);
      if (event.state === 'downloading' && event.file) write(`Embedding asset: ${event.file}`);
    }
    const installMs = elapsed(installStarted);
    ensureInstallSucceeded(events, 'Embedding');
    const measurements = [];
    for (let index = 0; index < LATENCY_SAMPLE_COUNT; index += 1) {
      measurements.push(await measureEmbedding(runtime));
      if ((index + 1) % 5 === 0) write(`${label} embedding inference samples: ${index + 1}/${LATENCY_SAMPLE_COUNT}.`);
    }
    const first = measurements[0];
    if (!first) throw new Error('Embedding latency samples are missing.');
    const inferenceSamplesMs = measurements.map((measurement) => measurement.inferenceMs);
    const quality = includeQuality ? await runEmbeddingQuality(runtime) : undefined;
    write(`${label} embedding completed in ${installMs} ms load; ${LATENCY_SAMPLE_COUNT} inference samples recorded.`);
    return {
      timing: { installMs, inferenceMs: first.inferenceMs },
      dimensions: first.dimensions,
      similarities: first.similarities,
      topMatch: first.topMatch,
      inferenceSamplesMs,
      inferenceLatency: latencySummary(inferenceSamplesMs),
      events,
      ...(quality === undefined ? {} : { quality }),
    };
  } finally {
    await runtime.dispose();
  }
}

function generationWorker(): Worker {
  return new Worker(new URL('../../../packages/runtime-webllm/src/worker.ts', import.meta.url), {
    type: 'module',
    name: 'browser-cortex-real-model-webllm',
  });
}

function generationRuntime(): WebLLMRuntime {
  return createWebLLMRuntime({
    modelId: VERIFIED_SMOLLM2_MODEL.modelId,
    modelRevision: VERIFIED_SMOLLM2_MODEL.modelRevision,
    executionContext: 'web',
    localModelLibUrl: VERIFIED_SMOLLM2_MODEL.modelLibrary.packagedPath,
    localModelLibSha256: VERIFIED_SMOLLM2_MODEL.modelLibrary.sha256,
    localModelLibSri: VERIFIED_SMOLLM2_MODEL.modelLibrary.sri,
    workerFactory: generationWorker,
    temperature: 0,
    maxTokens: 24,
  });
}

async function generateOnce(
  runtime: WebLLMRuntime,
  request: GenerationRequest,
  signal = new AbortController().signal,
): Promise<GenerationMeasurement> {
  let generated = '';
  let firstTokenMs: number | undefined;
  let tokenEvents = 0;
  let completed = false;
  const generationStarted = performance.now();
  for await (const event of runtime.generate(request, signal)) {
    const current = event as GenerationEvent;
    if (current.type === 'token') {
      firstTokenMs ??= elapsed(generationStarted);
      tokenEvents += 1;
      generated += current.text;
    } else if (current.type === 'complete') {
      generated = current.text || generated;
      completed = true;
    } else if (current.type === 'error') {
      throw new Error(`Generation failed: ${current.message}`);
    } else if (current.type === 'cancelled') {
      throw new Error('Generation was unexpectedly cancelled.');
    }
  }
  const totalGenerationMs = elapsed(generationStarted);
  if (!completed || !generated.trim()) throw new Error('Generation did not return a completed non-empty response.');
  return {
    ...(firstTokenMs === undefined ? {} : { firstTokenMs }),
    totalGenerationMs,
    output: generated,
    tokenEvents,
    completed,
  };
}

function parseQualityOutput(outputText: string): {
  schemaValid: boolean;
  parsed?: { answer: string; abstain: boolean };
} {
  try {
    const parsed = JSON.parse(outputText.trim()) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { schemaValid: false };
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (
      keys.length !== 2 ||
      keys[0] !== 'abstain' ||
      keys[1] !== 'answer' ||
      typeof record.answer !== 'string' ||
      typeof record.abstain !== 'boolean'
    ) {
      return { schemaValid: false };
    }
    return { schemaValid: true, parsed: { answer: record.answer, abstain: record.abstain } };
  } catch {
    return { schemaValid: false };
  }
}

async function runGenerationQuality(runtime: WebLLMRuntime): Promise<Record<string, unknown>> {
  const probes = [];
  for (const probe of generationQualityProbes) {
    write(`Generation quality probe ${probe.id} started.`);
    const result = await generateOnce(runtime, {
      system: 'You are a strict JSON fact extractor. Use only RECORD. Return exactly the requested JSON object. If the field is absent, use an empty answer and set abstain to true. Do not infer or add markdown.',
      prompt: `RECORD\n${probe.record}\nEND RECORD\nQUESTION\n${probe.question}\nReturn one JSON object with answer as a string and abstain as a boolean.`,
      responseSchema: generationProbeSchema,
      temperature: 0,
      maxTokens: 48,
    });
    const parsed = parseQualityOutput(result.output);
    const semanticCorrect = Boolean(
      parsed.parsed &&
      parsed.parsed.answer === probe.expectedAnswer &&
      parsed.parsed.abstain === probe.expectedAbstain,
    );
    probes.push({
      id: probe.id,
      category: probe.category,
      expected: { answer: probe.expectedAnswer, abstain: probe.expectedAbstain },
      output: result.output,
      ...(parsed.parsed === undefined ? {} : { parsed: parsed.parsed }),
      schemaValid: parsed.schemaValid,
      semanticCorrect,
    });
    write(`Generation quality probe ${probe.id} recorded: schema=${String(parsed.schemaValid)}, semantic=${String(semanticCorrect)}.`);
  }
  const schemaPasses = probes.filter((probe) => probe.schemaValid).length;
  const semanticPasses = probes.filter((probe) => probe.semanticCorrect).length;
  const abstentionProbes = probes.filter((probe) => probe.category === 'abstention');
  const abstentionPasses = abstentionProbes.filter((probe) => probe.semanticCorrect).length;
  return {
    probeSetId: QUALITY_PROBE_SET,
    synthetic: true,
    schemaValidity: { passed: schemaPasses, total: probes.length, rate: ratio(schemaPasses, probes.length) },
    semanticCorrectness: { passed: semanticPasses, total: probes.length, rate: ratio(semanticPasses, probes.length) },
    abstention: { passed: abstentionPasses, total: abstentionProbes.length, rate: ratio(abstentionPasses, abstentionProbes.length) },
    acceptance: {
      gate: GENERATION_QUALITY_GATE,
      passed: schemaPasses === probes.length,
      semanticCorrectness: 'reported-only',
      abstention: 'reported-only',
    },
    probes,
  };
}

async function runGenerationCancellation(runtime: WebLLMRuntime): Promise<Record<string, unknown>> {
  write('Generation cancellation probe started.');
  const controller = new AbortController();
  let observedStart = false;
  let abortRequested = false;
  let cancelledEvent = false;
  let completedAfterAbort = false;
  let errorAfterAbort = false;
  let tokenEventsBeforeAbort = 0;
  let tokenEventsAfterAbort = 0;
  const started = performance.now();
  for await (const event of runtime.generate({
    system: 'Follow the request and continue until interrupted.',
    prompt: 'Write the integers from 1 through 100 in words, one per line.',
    temperature: 0,
    maxTokens: 128,
  }, controller.signal)) {
    if (event.type === 'start') {
      observedStart = true;
    } else if (event.type === 'token') {
      if (abortRequested) tokenEventsAfterAbort += 1;
      else {
        tokenEventsBeforeAbort += 1;
        abortRequested = true;
        controller.abort(new DOMException('Trusted verification requested cancellation.', 'AbortError'));
      }
    } else if (event.type === 'cancelled') {
      cancelledEvent = true;
    } else if (event.type === 'complete' && abortRequested) {
      completedAfterAbort = true;
    } else if (event.type === 'error' && abortRequested) {
      errorAfterAbort = true;
    }
  }
  const elapsedMs = elapsed(started);
  const recovery = await generateOnce(runtime, {
    system: 'Follow the user format exactly. Do not add commentary.',
    prompt: MARKER_INSTRUCTION,
    temperature: 0,
    maxTokens: 24,
  });
  const recoveryExactMarker = recovery.output.trim() === EXACT_MODEL_MARKER;
  const passed = Boolean(
    observedStart &&
    abortRequested &&
    tokenEventsBeforeAbort === 1 &&
    tokenEventsAfterAbort === 0 &&
    cancelledEvent &&
    !completedAfterAbort &&
    !errorAfterAbort &&
    recoveryExactMarker,
  );
  write(`Generation cancellation probe recorded: passed=${String(passed)}.`);
  return {
    kind: 'in-flight-generation',
    trigger: 'after-first-token',
    observedStart,
    abortRequested,
    signalAborted: controller.signal.aborted,
    cancelledEvent,
    completedAfterAbort,
    errorAfterAbort,
    tokenEventsBeforeAbort,
    tokenEventsAfterAbort,
    elapsedMs,
    recovery: {
      output: recovery.output,
      exactMarker: recoveryExactMarker,
      firstTokenMs: recovery.firstTokenMs,
      totalGenerationMs: recovery.totalGenerationMs,
    },
    passed,
  };
}

async function runGeneration(label: 'cold' | 'warm', includeEvaluation: boolean): Promise<{
  phase: GenerationPhase;
  quality?: Record<string, unknown>;
  cancellation?: Record<string, unknown>;
}> {
  write(`${label} generation load started.`);
  const runtime = generationRuntime();
  try {
    const events: ModelInstallEvent[] = [];
    const installStarted = performance.now();
    for await (const event of runtime.install(new AbortController().signal)) {
      events.push(event);
      if (event.message && (event.state === 'downloading' || event.state === 'loading')) write(`Generation runtime: ${event.message}`);
    }
    const installMs = elapsed(installStarted);
    ensureInstallSucceeded(events, 'Generation');

    const samples: Array<GenerationMeasurement & { exactMarker: boolean }> = [];
    for (let index = 0; index < LATENCY_SAMPLE_COUNT; index += 1) {
      const measurement = await generateOnce(runtime, {
        system: 'Follow the user format exactly. Do not add commentary.',
        prompt: MARKER_INSTRUCTION,
        temperature: 0,
        maxTokens: 24,
      });
      samples.push({ ...measurement, exactMarker: measurement.output.trim() === EXACT_MODEL_MARKER });
      if ((index + 1) % 5 === 0) write(`${label} generation inference samples: ${index + 1}/${LATENCY_SAMPLE_COUNT}.`);
    }
    const first = samples[0];
    if (!first) throw new Error('Generation latency samples are missing.');
    const firstTokenSamples = samples.map((sample) => sample.firstTokenMs);
    if (firstTokenSamples.some((sample) => sample === undefined)) {
      throw new Error('Generation completed without an observable streamed token in every measured sample.');
    }
    const measuredFirstTokens = firstTokenSamples as number[];
    const totalSamples = samples.map((sample) => sample.totalGenerationMs);
    const quality = includeEvaluation ? await runGenerationQuality(runtime) : undefined;
    const cancellation = includeEvaluation ? await runGenerationCancellation(runtime) : undefined;
    write(`${label} generation completed in ${installMs} ms load; ${LATENCY_SAMPLE_COUNT} inference samples recorded.`);
    return {
      phase: {
        installMs,
        ...(first.firstTokenMs === undefined ? {} : { firstTokenMs: first.firstTokenMs }),
        totalGenerationMs: first.totalGenerationMs,
        output: first.output,
        exactMarker: first.exactMarker,
        exactMarkerPasses: samples.filter((sample) => sample.exactMarker).length,
        samples,
        firstTokenLatency: latencySummary(measuredFirstTokens),
        totalGenerationLatency: latencySummary(totalSamples),
        events,
      },
      ...(quality === undefined ? {} : { quality }),
      ...(cancellation === undefined ? {} : { cancellation }),
    };
  } finally {
    await runtime.dispose();
  }
}

function completeSummary(value: unknown, expectedTotal: number): boolean {
  const summary = value as { passed?: unknown; total?: unknown; rate?: unknown } | undefined;
  return summary?.passed === expectedTotal && summary.total === expectedTotal && summary.rate === 1;
}

async function run(): Promise<void> {
  consent.disabled = true;
  status.textContent = 'Running pinned models with synthetic data.';
  const report: VerificationReport = {
    schemaVersion: 2,
    status: 'failed',
    observedAt: new Date().toISOString(),
    environment: await environment(),
    consent: {
      explicitButtonActivation: true,
      embeddingHost: 'huggingface.co',
      embeddingReviewedArtifactBytes: VERIFIED_MINILM_MODEL.quantizedOnnx.bytes,
      generationHost: 'huggingface.co',
      generationWeightBytes: VERIFIED_SMOLLM2_MODEL.weightBytes,
      packagedExecutableBytes: VERIFIED_SMOLLM2_MODEL.modelLibrary.bytes,
      syntheticInputsOnly: true,
    },
    methodology: {
      qualityProbeSet: QUALITY_PROBE_SET,
      latencySampleCountPerPhase: LATENCY_SAMPLE_COUNT,
      percentileMethod: 'nearest-rank',
      latencySampleScope: 'sequential inference after phase load; installation measured separately',
      coldProfile: 'fresh temporary Chrome profile with empty model cache',
      warmProfile: 'same temporary Chrome profile after cold model acquisition',
      markerSource: MARKER_SOURCE,
      markerInstruction: MARKER_INSTRUCTION,
      exactOutputMarker: EXACT_MODEL_MARKER,
      generationQualityGate: GENERATION_QUALITY_GATE,
    },
  };
  const storageBefore = await storage();
  try {
    const coldEmbedding = await runEmbedding('cold', false);
    const warmEmbedding = await runEmbedding('warm', true);
    const coldGeneration = await runGeneration('cold', false);
    const warmGeneration = await runGeneration('warm', true);
    report.embedding = {
      modelId: VERIFIED_MINILM_MODEL.modelId,
      revision: VERIFIED_MINILM_MODEL.revision,
      runtime: '@huggingface/transformers 4.3.0',
      device: 'wasm',
      dimensions: coldEmbedding.dimensions,
      topMatch: coldEmbedding.topMatch,
      similarities: coldEmbedding.similarities,
      cold: {
        ...coldEmbedding.timing,
        dimensions: coldEmbedding.dimensions,
        topMatch: coldEmbedding.topMatch,
        similarities: coldEmbedding.similarities,
        inferenceSamplesMs: coldEmbedding.inferenceSamplesMs,
        inferenceLatency: coldEmbedding.inferenceLatency,
      },
      warm: {
        ...warmEmbedding.timing,
        dimensions: warmEmbedding.dimensions,
        topMatch: warmEmbedding.topMatch,
        similarities: warmEmbedding.similarities,
        inferenceSamplesMs: warmEmbedding.inferenceSamplesMs,
        inferenceLatency: warmEmbedding.inferenceLatency,
      },
      quality: warmEmbedding.quality,
      observedInstallEvents: coldEmbedding.events.length + warmEmbedding.events.length,
    };
    report.generation = {
      modelId: VERIFIED_SMOLLM2_MODEL.modelId,
      revision: VERIFIED_SMOLLM2_MODEL.modelRevision,
      sourceRevision: VERIFIED_SMOLLM2_MODEL.sourceRevision,
      runtime: '@mlc-ai/web-llm 0.2.85',
      device: 'webgpu',
      exactOutputMarker: EXACT_MODEL_MARKER,
      cold: coldGeneration.phase,
      warm: warmGeneration.phase,
      quality: warmGeneration.quality,
      cancellation: warmGeneration.cancellation,
    };
    const storageAfter = await storage();
    report.storage = {
      before: storageBefore,
      after: storageAfter,
      observedUsageDeltaBytes: Number(storageAfter.usageBytes) - Number(storageBefore.usageBytes),
      scope: 'fresh temporary verification origin profile estimate',
    };

    if (coldEmbedding.topMatch !== 0 || warmEmbedding.topMatch !== 0) {
      throw new Error('The embedding model did not satisfy the cold and warm synthetic marker retrieval probe.');
    }
    if (!completeSummary((warmEmbedding.quality as Record<string, unknown> | undefined)?.vectorValidity, embeddingQualityProbes.length)) {
      throw new Error('The embedding quality probes did not all return schema-valid vectors.');
    }
    if (!completeSummary((warmEmbedding.quality as Record<string, unknown> | undefined)?.semanticCorrectness, embeddingQualityProbes.length)) {
      throw new Error('The embedding quality probes did not all select the expected synthetic passage.');
    }
    if (
      coldGeneration.phase.exactMarkerPasses !== LATENCY_SAMPLE_COUNT ||
      warmGeneration.phase.exactMarkerPasses !== LATENCY_SAMPLE_COUNT
    ) {
      throw new Error('The generation model did not reproduce the calibrated deterministic marker in every cold and warm sample.');
    }
    const generationQuality = warmGeneration.quality as Record<string, unknown> | undefined;
    if (!completeSummary(generationQuality?.schemaValidity, generationQualityProbes.length)) {
      throw new Error('The generation quality probes did not all return schema-valid JSON.');
    }
    const generationAcceptance = generationQuality?.acceptance as Record<string, unknown> | undefined;
    if (
      generationAcceptance?.gate !== GENERATION_QUALITY_GATE ||
      generationAcceptance.passed !== true ||
      generationAcceptance.semanticCorrectness !== 'reported-only' ||
      generationAcceptance.abstention !== 'reported-only'
    ) {
      throw new Error('The generation quality acceptance policy or schema gate is incomplete.');
    }
    if ((warmGeneration.cancellation as { passed?: unknown } | undefined)?.passed !== true) {
      throw new Error('The generation cancellation and recovery probe did not pass.');
    }

    report.status = 'passed';
    window.__BROWSER_CORTEX_REPORT__ = report;
    status.textContent = 'Real-model execution and integration gates passed; generation semantic and abstention measurements were recorded.';
    output.textContent = `${output.textContent ?? ''}\n${JSON.stringify(report, null, 2)}`;
  } catch (error) {
    if (!report.storage) {
      const storageAfter = await storage();
      report.storage = {
        before: storageBefore,
        after: storageAfter,
        observedUsageDeltaBytes: Number(storageAfter.usageBytes) - Number(storageBefore.usageBytes),
        scope: 'fresh temporary verification origin profile estimate',
      };
    }
    report.error = {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : 'Unknown real-model verification failure.',
    };
    window.__BROWSER_CORTEX_REPORT__ = report;
    status.textContent = 'Real-model verification failed.';
    output.textContent = `${output.textContent ?? ''}\n${JSON.stringify(report, null, 2)}`;
  }
}

consent.addEventListener('click', () => void run());
