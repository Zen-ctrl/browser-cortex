import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

interface BrowserReport {
  schemaVersion: number;
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

interface EvidenceBinding {
  scope: 'adapter-runtime';
  invocationId: string;
  archive: { filename: string; bytes: number; sha256: string };
  buildProvenance: {
    filename: string;
    sha256: string;
    sourceTree: string;
    extensionDigest: string;
  };
}

interface PreflightCompatibility {
  commit?: unknown;
  archive?: { filename?: unknown; bytes?: unknown; sha256?: unknown };
  buildProvenance?: {
    sha256?: unknown;
    sourceTree?: unknown;
    extensionDigest?: unknown;
  };
  realModelEvidence?: unknown;
}

const address = 'http://127.0.0.1:4180';
const reportDirectory = resolve('benchmarks/reports/real-model');
const browserProfileRoot = resolve(tmpdir());
const browserProfilePrefix = 'browser-cortex-real-model-';
const browserReportTimeoutMs = 45 * 60_000;
const trustedBrowserChannel = 'chrome' as const;
const trustedHeadlessMode = false;
const reportLimitations = [
  {
    id: 'single-device-observation',
    statement: 'Results describe one Windows host, one Chrome build, one CPU/WASM path, and one WebGPU adapter; they are not cross-device support evidence.',
  },
  {
    id: 'adapter-runtime-scope',
    statement: 'Inference runs through the production adapters in a fresh page; packaged MV3 UI, service-worker, and content-script integration remain separate extension E2E evidence.',
  },
  {
    id: 'small-synthetic-quality-set',
    statement: 'The fixed synthetic probes are regression checks, not a general model-quality, safety, factuality, or privacy evaluation. Generation semantic correctness and missing-fact abstention are reported measurements rather than release gates, and product logic must independently reject unsupported output.',
  },
  {
    id: 'latency-sample-boundary',
    statement: 'Latency percentiles cover twenty sequential samples per cold or warm phase on this host and do not predict other loads, thermal states, or devices.',
  },
  {
    id: 'storage-estimate-boundary',
    statement: 'Storage figures come from the browser origin estimate and cache inventory; they are not a byte-exact audit of every runtime-managed model asset.',
  },
  {
    id: 'generation-cancellation-only',
    statement: 'The in-flight cancellation probe covers generation after its first token plus recovery; embedding and model-install cancellation are not measured by this run.',
  },
  {
    id: 'unmeasured-resource-claims',
    statement: 'GPU memory, process memory, energy use, network cost, and monetary savings are not measured and no claim is inferred for them.',
  },
] as const;

function runPnpm(script: string): void {
  execFileSync('pnpm', [script], {
    cwd: process.cwd(),
    stdio: 'inherit',
    windowsHide: true,
    shell: process.platform === 'win32',
  });
}

function startServer(): ChildProcess {
  const vite = resolve('node_modules/vite/bin/vite.js');
  const child = spawn(process.execPath, [vite, '--config', 'benchmarks/runners/real-model/vite.config.ts'], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout?.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  return child;
}

async function assertServerAddressUnused(): Promise<void> {
  let response: Response;
  try {
    response = await fetch(address, { signal: AbortSignal.timeout(1_000) });
  } catch {
    return;
  }
  await response.body?.cancel();
  throw new Error(`Real-model server address ${address} is already in use.`);
}

async function waitForServer(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Real-model Vite server exited with code ${child.exitCode}.`);
    try {
      const response = await fetch(address);
      if (response.ok && child.exitCode === null) return;
    } catch {
      // The server has not opened its listening socket yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error('Timed out waiting for the real-model verification server.');
}

function assertManagedBrowserProfile(profile: string): void {
  const resolvedProfile = resolve(profile);
  const profileName = basename(resolvedProfile);
  if (
    dirname(resolvedProfile) !== browserProfileRoot ||
    !profileName.startsWith(browserProfilePrefix) ||
    profileName.length !== browserProfilePrefix.length + 6
  ) {
    throw new Error('Real-model browser profile escaped the managed operating-system temporary directory.');
  }
}

async function verifyCacheStorage(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const id = crypto.randomUUID();
    const cacheName = `browser-cortex-real-model-preflight-${id}`;
    const request = new Request(new URL(`/__browser-cortex-cache-preflight__/${id}`, location.origin));
    const expected = `browser-cortex-cache-storage-${id}`;
    try {
      const cache = await caches.open(cacheName);
      await cache.put(request, new Response(expected, { status: 200 }));
      const matched = await cache.match(request);
      if (!matched?.ok || await matched.text() !== expected) {
        throw new Error('CacheStorage did not preserve the real-model preflight entry.');
      }
      if (!await cache.delete(request)) {
        throw new Error('CacheStorage did not delete the real-model preflight entry.');
      }
    } finally {
      await caches.delete(cacheName).catch(() => false);
    }
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Real-model CacheStorage preflight failed: ${message}`);
  });
}

async function waitForBrowserReport(page: Page): Promise<void> {
  try {
    await page.waitForFunction(() => window.__BROWSER_CORTEX_REPORT__ !== undefined, undefined, {
      timeout: browserReportTimeoutMs,
    });
  } catch (error) {
    const snapshot = await page.evaluate(() => ({
      status: document.querySelector('#status')?.textContent ?? 'missing',
      output: (document.querySelector('#output')?.textContent ?? '').slice(-8_000),
    })).catch(() => ({ status: 'unavailable', output: 'Browser snapshot unavailable.' }));
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Real-model browser report timed out or became unavailable: ${message}\nLast status: ${snapshot.status}\nRecent output:\n${snapshot.output}`);
  }
}

function markdown(
  report: BrowserReport,
  browserVersion: string,
  sourceCommit: string,
  evidence: EvidenceBinding,
): string {
  const environment = report.environment;
  const methodology = report.methodology;
  const embedding = report.embedding ?? {};
  const generation = report.generation ?? {};
  const coldGeneration = generation.cold as Record<string, unknown> | undefined;
  const warmGeneration = generation.warm as Record<string, unknown> | undefined;
  const coldEmbedding = embedding.cold as Record<string, unknown> | undefined;
  const warmEmbedding = embedding.warm as Record<string, unknown> | undefined;
  const embeddingQuality = embedding.quality as Record<string, unknown> | undefined;
  const generationQuality = generation.quality as Record<string, unknown> | undefined;
  const generationAcceptance = generationQuality?.acceptance as Record<string, unknown> | undefined;
  const cancellation = generation.cancellation as Record<string, unknown> | undefined;
  const storageReport = report.storage ?? {};
  const storageBefore = storageReport.before as Record<string, unknown> | undefined;
  const storageAfter = storageReport.after as Record<string, unknown> | undefined;
  const metric = (value: unknown): string => {
    const summary = value as Record<string, unknown> | undefined;
    return `${String(summary?.passed ?? 'unavailable')}/${String(summary?.total ?? 'unavailable')} (${String(summary?.rate ?? 'unavailable')})`;
  };
  const latency = (value: unknown): string => {
    const summary = value as Record<string, unknown> | undefined;
    return `n=${String(summary?.sampleCount ?? 'unavailable')}, p50=${String(summary?.p50Ms ?? 'unavailable')} ms, p95=${String(summary?.p95Ms ?? 'unavailable')} ms, min=${String(summary?.minMs ?? 'unavailable')} ms, max=${String(summary?.maxMs ?? 'unavailable')} ms`;
  };
  return `# Real-model verification\n\n` +
    `Observed: ${report.observedAt}\n\n` +
    `Status: **${report.status}**\n\n` +
    `This report records actual browser inference over a fixed synthetic regression set. A passed status means the real adapter execution, fixed marker and schema, cancellation, and embedding retrieval gates passed. Generation semantic correctness and missing-fact abstention remain report-only measurements. It is separate from deterministic adapter mocks.\n\n` +
    `Latency uses nearest-rank percentiles over sequential inference after each phase load; installation is measured separately.\n\n` +
    `## Environment\n\n` +
    `- Browser: Google Chrome channel ${trustedBrowserChannel} ${browserVersion}\n` +
    `- Headless: ${String(trustedHeadlessMode)}\n` +
    `- Source commit: ${sourceCommit}\n` +
    `- Evidence scope: ${evidence.scope}\n` +
    `- Invocation: ${evidence.invocationId}\n` +
    `- Extension archive: ${evidence.archive.filename} (sha256:${evidence.archive.sha256})\n` +
    `- Build provenance: sha256:${evidence.buildProvenance.sha256}\n` +
    `- Browser user agent: ${String(environment.userAgent ?? 'unavailable')}\n` +
    `- Host OS: ${platform()} ${release()} (${arch()})\n` +
    `- CPU: ${cpus()[0]?.model ?? 'unavailable'} (${cpus().length} logical processors)\n` +
    `- Host memory: ${(totalmem() / 1024 ** 3).toFixed(1)} GiB\n` +
    `- Browser-visible hardware concurrency: ${String(environment.hardwareConcurrency ?? 'unavailable')}\n` +
    `- Browser-visible device memory: ${String(environment.deviceMemoryGiB ?? 'unavailable')} GiB\n` +
    `- WebGPU: ${JSON.stringify(environment.webgpu ?? 'unavailable')}\n` +
    `- WebGL renderer: ${String(environment.webglRenderer ?? 'unavailable')}\n` +
    `- Cross-origin isolated: ${String(environment.crossOriginIsolated ?? false)}\n\n` +
    `## Storage observation\n\n` +
    `- Before model work: ${String(storageBefore?.usageBytes ?? 'unavailable')} bytes used of ${String(storageBefore?.quotaBytes ?? 'unavailable')} bytes quota\n` +
    `- After model work: ${String(storageAfter?.usageBytes ?? 'unavailable')} bytes used of ${String(storageAfter?.quotaBytes ?? 'unavailable')} bytes quota\n` +
    `- Observed usage delta: ${String(storageReport.observedUsageDeltaBytes ?? 'unavailable')} bytes\n` +
    `- Cache names after: ${JSON.stringify(storageAfter?.cacheNames ?? [])}\n` +
    `- IndexedDB databases after: ${JSON.stringify(storageAfter?.indexedDbDatabases ?? [])}\n\n` +
    `## Embedding latency and quality\n\n` +
    `- Model: ${String(embedding.modelId ?? 'unavailable')} at ${String(embedding.revision ?? 'unavailable')}\n` +
    `- Dimensions: ${String(embedding.dimensions ?? 'unavailable')}\n` +
    `- Synthetic retrieval top match: ${String(embedding.topMatch ?? 'unavailable')} (expected 0)\n` +
    `- Cold load: ${String(coldEmbedding?.installMs ?? 'unavailable')} ms; ${latency(coldEmbedding?.inferenceLatency)}\n` +
    `- Warm load: ${String(warmEmbedding?.installMs ?? 'unavailable')} ms; ${latency(warmEmbedding?.inferenceLatency)}\n` +
    `- Vector-schema validity: ${metric(embeddingQuality?.vectorValidity)}\n` +
    `- Retrieval semantic correctness: ${metric(embeddingQuality?.semanticCorrectness)}\n\n` +
    `## Generation latency and quality\n\n` +
    `- Model: ${String(generation.modelId ?? 'unavailable')} at ${String(generation.revision ?? 'unavailable')}\n` +
    `- Marker source: ${String(methodology.markerSource ?? 'unavailable')}\n` +
    `- Marker instruction: ${String(methodology.markerInstruction ?? 'unavailable')}\n` +
    `- Exact output marker: ${String(generation.exactOutputMarker ?? 'unavailable')}\n` +
    `- Cold load: ${String(coldGeneration?.installMs ?? 'unavailable')} ms; first-token ${latency(coldGeneration?.firstTokenLatency)}; total ${latency(coldGeneration?.totalGenerationLatency)}\n` +
    `- Warm load: ${String(warmGeneration?.installMs ?? 'unavailable')} ms; first-token ${latency(warmGeneration?.firstTokenLatency)}; total ${latency(warmGeneration?.totalGenerationLatency)}\n` +
    `- Cold marker passes: ${String(coldGeneration?.exactMarkerPasses ?? 'unavailable')}/${String((coldGeneration?.samples as unknown[] | undefined)?.length ?? 'unavailable')}\n` +
    `- Warm marker passes: ${String(warmGeneration?.exactMarkerPasses ?? 'unavailable')}/${String((warmGeneration?.samples as unknown[] | undefined)?.length ?? 'unavailable')}\n` +
    `- Generation schema release gate: ${String(generationAcceptance?.passed ?? false)} (${String(generationAcceptance?.gate ?? 'unavailable')})\n` +
    `- JSON schema validity: ${metric(generationQuality?.schemaValidity)}\n` +
    `- Semantic correctness (reported only): ${metric(generationQuality?.semanticCorrectness)}\n` +
    `- Missing-fact abstention (reported only): ${metric(generationQuality?.abstention)}\n\n` +
    `## Cancellation\n\n` +
    `- Probe: ${String(cancellation?.kind ?? 'unavailable')}, triggered ${String(cancellation?.trigger ?? 'unavailable')}\n` +
    `- AbortSignal observed aborted: ${String(cancellation?.signalAborted ?? false)}\n` +
    `- Cancel event observed: ${String(cancellation?.cancelledEvent ?? false)}\n` +
    `- Completion after abort: ${String(cancellation?.completedAfterAbort ?? true)}\n` +
    `- Tokens after abort: ${String(cancellation?.tokenEventsAfterAbort ?? 'unavailable')}\n` +
    `- Post-cancel marker recovery: ${String((cancellation?.recovery as Record<string, unknown> | undefined)?.exactMarker ?? false)}\n` +
    `- Result: ${String(cancellation?.passed ?? false)}\n\n` +
    `## Limitations\n\n` +
    reportLimitations.map((limitation) => `- **${limitation.id}:** ${limitation.statement}\n`).join('') +
    (report.error ? `\nFailure: ${report.error.name}: ${report.error.message}\n` : '');
}

const dirtySource = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  windowsHide: true,
}).trim();
if (dirtySource) throw new Error('Real-model evidence requires a clean tracked and untracked source tree.');
await assertServerAddressUnused();
runPnpm('build');

await mkdir(reportDirectory, { recursive: true });
await Promise.all([
  rm(resolve(reportDirectory, 'latest.json'), { force: true }),
  rm(resolve(reportDirectory, 'latest.md'), { force: true }),
]);
runPnpm('package:extension');

const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
const preflightCompatibility = JSON.parse(await readFile('release/compatibility.json', 'utf8')) as PreflightCompatibility;
const archive = preflightCompatibility.archive;
const provenance = preflightCompatibility.buildProvenance;
if (
  preflightCompatibility.commit !== sourceCommit ||
  !archive ||
  typeof archive.filename !== 'string' ||
  typeof archive.bytes !== 'number' ||
  !Number.isSafeInteger(archive.bytes) ||
  typeof archive.sha256 !== 'string' ||
  !provenance ||
  typeof provenance.sha256 !== 'string' ||
  typeof provenance.sourceTree !== 'string' ||
  typeof provenance.extensionDigest !== 'string' ||
  preflightCompatibility.realModelEvidence !== null
) {
  throw new Error('Preflight package metadata is incomplete or retained stale real-model evidence.');
}
const archiveFilename = archive.filename;
const archiveBytes = await readFile(resolve('release', archiveFilename));
const archiveSha256 = createHash('sha256').update(archiveBytes).digest('hex');
if (
  archiveBytes.byteLength !== archive.bytes ||
  archiveSha256 !== archive.sha256
) {
  throw new Error('Preflight extension archive differs from its compatibility metadata.');
}
const provenanceBytes = await readFile('release/build-provenance.json');
const provenanceSha256 = createHash('sha256').update(provenanceBytes).digest('hex');
if (provenanceSha256 !== provenance.sha256) {
  throw new Error('Preflight build provenance differs from its compatibility metadata.');
}
const evidence: EvidenceBinding = {
  scope: 'adapter-runtime',
  invocationId: randomUUID(),
  archive: {
    filename: archiveFilename,
    bytes: archiveBytes.byteLength,
    sha256: archiveSha256,
  },
  buildProvenance: {
    filename: 'release/build-provenance.json',
    sha256: provenanceSha256,
    sourceTree: provenance.sourceTree,
    extensionDigest: provenance.extensionDigest,
  },
};

const profile = await mkdtemp(join(browserProfileRoot, browserProfilePrefix));
assertManagedBrowserProfile(profile);
const server = startServer();
let context: BrowserContext | undefined;
try {
  await waitForServer(server);
  context = await chromium.launchPersistentContext(profile, {
    channel: trustedBrowserChannel,
    headless: trustedHeadlessMode,
    viewport: { width: 1280, height: 900 },
  });
  const page = context.pages()[0] ?? await context.newPage();
  page.on('console', (message) => process.stdout.write(`[browser:${message.type()}] ${message.text()}\n`));
  page.on('pageerror', (error) => process.stderr.write(`[browser:error] ${error.message}\n`));
  await page.goto(address, { waitUntil: 'networkidle' });
  await verifyCacheStorage(page);
  if (!await page.evaluate(() => Boolean((navigator as Navigator & { gpu?: unknown }).gpu))) {
    throw new Error('WebGPU is unavailable in the selected Chrome environment.');
  }
  await page.getByRole('button', { name: 'Consent and run pinned models' }).click();
  await waitForBrowserReport(page);
  const report = await page.evaluate(() => window.__BROWSER_CORTEX_REPORT__) as BrowserReport;
  if (report.schemaVersion !== 2) throw new Error('Browser harness returned an unsupported report schema.');
  const browserVersion = context.browser()?.version() ?? 'unavailable';
  const hostCpus = cpus();
  const envelope = {
    ...report,
    schemaVersion: 3,
    evidence,
    runner: {
      browserVersion,
      browserChannel: trustedBrowserChannel,
      headless: trustedHeadlessMode,
      nodeVersion: process.version,
      profile: 'fresh temporary Chrome profile in the operating-system temp directory',
      sourceCommit,
      host: {
        platform: platform(),
        release: release(),
        architecture: arch(),
        cpuModel: hostCpus[0]?.model ?? 'unavailable',
        logicalProcessors: hostCpus.length,
        totalMemoryBytes: totalmem(),
      },
    },
    limitations: reportLimitations,
  };
  await writeFile(resolve(reportDirectory, 'latest.json'), `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  await writeFile(resolve(reportDirectory, 'latest.md'), markdown(envelope, browserVersion, sourceCommit, evidence), 'utf8');
  if (report.status !== 'passed') throw new Error(report.error?.message ?? 'Real-model verification failed.');
  process.stdout.write(`Real-model verification passed. Report: ${resolve(reportDirectory, 'latest.md')}\n`);
} finally {
  try {
    await context?.close();
  } finally {
    if (server.exitCode === null) server.kill();
    assertManagedBrowserProfile(profile);
    await rm(profile, { recursive: true, force: true });
  }
}

for (const script of ['package:extension', 'sbom', 'verify:trusted-release']) {
  runPnpm(script);
}
