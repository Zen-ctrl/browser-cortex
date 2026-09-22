import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const releaseDirectory = resolve(root, 'release');
const outputDirectory = resolve(releaseDirectory, 'public-assets');
const outputRelative = relative(root, outputDirectory).replaceAll('\\', '/');

if (outputRelative !== 'release/public-assets') {
  throw new Error(`Refusing to write outside release/public-assets: ${outputDirectory}`);
}

function git(args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function requiredBytes(path) {
  try {
    return await readFile(resolve(root, path));
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Required release input is missing: ${path}`);
    throw error;
  }
}

async function requiredJson(path) {
  const bytes = await requiredBytes(path);
  try {
    return { bytes, value: JSON.parse(bytes.toString('utf8')) };
  } catch {
    throw new Error(`Required release input is not valid JSON: ${path}`);
  }
}

async function writeJson(name, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await writeFile(resolve(outputDirectory, name), bytes);
  return { bytes: bytes.byteLength, sha256: sha256(bytes) };
}

async function writeText(name, value) {
  const bytes = Buffer.from(value.endsWith('\n') ? value : `${value}\n`, 'utf8');
  await writeFile(resolve(outputDirectory, name), bytes);
  return { bytes: bytes.byteLength, sha256: sha256(bytes) };
}

async function copyAsset(source, name = basename(source)) {
  const sourcePath = resolve(root, source);
  const destination = resolve(outputDirectory, name);
  await copyFile(sourcePath, destination);
  const bytes = await readFile(destination);
  return { bytes: bytes.byteLength, sha256: sha256(bytes) };
}

function publicLatencyPhase(phase) {
  return {
    installMs: phase?.installMs,
    inferenceMs: phase?.inferenceMs,
    dimensions: phase?.dimensions,
    topMatch: phase?.topMatch,
    similarities: phase?.similarities,
    inferenceSamplesMs: phase?.inferenceSamplesMs,
    inferenceLatency: phase?.inferenceLatency,
  };
}

function publicGenerationPhase(phase) {
  return {
    installMs: phase?.installMs,
    firstTokenMs: phase?.firstTokenMs,
    totalGenerationMs: phase?.totalGenerationMs,
    output: phase?.output,
    exactMarker: phase?.exactMarker,
    exactMarkerPasses: phase?.exactMarkerPasses,
    samples: phase?.samples,
    firstTokenLatency: phase?.firstTokenLatency,
    totalGenerationLatency: phase?.totalGenerationLatency,
  };
}

function browserMajor(version) {
  const match = String(version ?? '').match(/^\d+/u);
  return match ? Number(match[0]) : null;
}

function percentage(value) {
  return `${(Number(value ?? 0) * 100).toFixed(1)}%`;
}

function markdownCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function localMarkdown(report) {
  const suiteRows = report.suites.map((suite) => (
    `| ${markdownCell(suite.category)} | ${suite.cases.passed}/${suite.cases.total} | ${percentage(suite.cases.passRate)} | ${suite.timing.p50Ms} | ${suite.timing.p95Ms} |`
  ));
  const gateRows = report.qualityGates.map((gate) => (
    `| ${markdownCell(gate.name)} | ${gate.passed ? 'pass' : 'fail'} | ${markdownCell(gate.observed)} |`
  ));
  return `# Public local benchmark report

Generated: ${report.generatedAt}

Source commit: \`${report.repositoryRevision}\`

This is a deterministic synthetic Node benchmark. Exact host and machine fingerprint details are intentionally omitted from this public report.

## Result

${report.summary.passedCases}/${report.summary.totalCases} cases passed. The measured suites took ${report.summary.measuredSuiteMs} ms. Quality gates ${report.summary.qualityGatesPassed ? 'passed' : 'failed'}.

| Suite | Passed | Pass rate | p50 ms | p95 ms |
| --- | ---: | ---: | ---: | ---: |
${suiteRows.join('\n')}

## Quality gates

| Gate | Result | Observed |
| --- | --- | --- |
${gateRows.join('\n')}

## Scope

- Corpus: ${report.corpus.totalCases} checked-in synthetic cases.
- Corpus fingerprint: \`${report.corpus.fingerprint}\`.
- Browser measured: ${report.methodology.browserMeasured}.
- Real model measured: ${report.methodology.realModelMeasured}.
- Blocked fetch attempts during measured suites: ${report.summary.fetchAttemptsBlocked}.

## Limitations

${report.limitations.map((item) => `- ${item}`).join('\n')}

Machine-readable companion: \`local-benchmark.json\`.
`;
}

function realModelMarkdown(report) {
  const embedding = report.embedding;
  const generation = report.generation;
  return `# Public real-model verification

Observed: ${report.observedAt}

Status: **${report.status}**

Source commit: \`${report.runner.sourceCommit}\`

This report records production-adapter inference over a fixed synthetic regression set. Exact host, operating-system, processor, graphics adapter, memory, storage-size, and run-identifier details are intentionally omitted.

## Runtime boundary

- Browser major: ${report.runner.browserMajor ?? 'withheld'}
- Browser channel: ${report.runner.browserChannel}
- Headless: ${report.runner.headless}
- Cross-origin isolated: ${report.environment.runtimeCapabilities.crossOriginIsolated}
- WebGPU available: ${report.environment.runtimeCapabilities.webgpuAvailable}
- Evidence scope: ${report.evidence.scope}

## Embedding

- Model: \`${embedding.modelId}\` at revision \`${embedding.revision}\`
- Runtime: \`${embedding.runtime}\`; device class: \`${embedding.device}\`
- Dimensions: ${embedding.dimensions}
- Cold load: ${embedding.cold.installMs} ms; inference p50/p95: ${embedding.cold.inferenceLatency.p50Ms}/${embedding.cold.inferenceLatency.p95Ms} ms
- Warm load: ${embedding.warm.installMs} ms; inference p50/p95: ${embedding.warm.inferenceLatency.p50Ms}/${embedding.warm.inferenceLatency.p95Ms} ms
- Vector validity: ${embedding.quality.vectorValidity.passed}/${embedding.quality.vectorValidity.total}
- Retrieval correctness: ${embedding.quality.semanticCorrectness.passed}/${embedding.quality.semanticCorrectness.total}

## Generation

- Model: \`${generation.modelId}\` at revision \`${generation.revision}\`
- Runtime: \`${generation.runtime}\`; device class: \`${generation.device}\`
- Cold load: ${generation.cold.installMs} ms; first-token p50/p95: ${generation.cold.firstTokenLatency.p50Ms}/${generation.cold.firstTokenLatency.p95Ms} ms; total p50/p95: ${generation.cold.totalGenerationLatency.p50Ms}/${generation.cold.totalGenerationLatency.p95Ms} ms
- Warm load: ${generation.warm.installMs} ms; first-token p50/p95: ${generation.warm.firstTokenLatency.p50Ms}/${generation.warm.firstTokenLatency.p95Ms} ms; total p50/p95: ${generation.warm.totalGenerationLatency.p50Ms}/${generation.warm.totalGenerationLatency.p95Ms} ms
- Exact-marker generations: ${generation.cold.exactMarkerPasses}/${generation.cold.firstTokenLatency.sampleCount} cold and ${generation.warm.exactMarkerPasses}/${generation.warm.firstTokenLatency.sampleCount} warm
- JSON schema validity: ${generation.quality.schemaValidity.passed}/${generation.quality.schemaValidity.total}
- Semantic correctness, reported only: ${generation.quality.semanticCorrectness.passed}/${generation.quality.semanticCorrectness.total}
- Missing-fact abstention, reported only: ${generation.quality.abstention.passed}/${generation.quality.abstention.total}
- In-flight cancellation: ${generation.cancellation.passed ? 'passed' : 'failed'}

## Important quality warning

A passed status covers adapter execution, the fixed marker and schema gates, embedding retrieval, cancellation, and recovery. Semantic correctness and missing-fact abstention are report-only measurements. This is not a certification of general model quality, factuality, safety, privacy, or cross-device support.

## Storage disclosure

The run used a fresh temporary verification profile. Cache names are retained for debugging, but exact usage, quota, and delta measurements are omitted from the public report.

## Limitations

${report.limitations.map((item) => `- **${item.id}:** ${item.statement}`).join('\n')}

Machine-readable companion: \`real-model-verification.json\`.
`;
}

function finalReport({ packageManifest, compatibility, localReport, realReport, assets }) {
  const rows = [...assets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, record]) => `| \`${name}\` | ${record.bytes} | \`${record.sha256}\` |`);
  const suites = localReport.suites
    .map((suite) => `| ${markdownCell(suite.category)} | ${suite.cases.passed}/${suite.cases.total} | ${suite.timing.p50Ms} | ${suite.timing.p95Ms} |`);
  return `# BrowserCortex ${packageManifest.version} public release report

## Release identity

| Field | Value |
| --- | --- |
| Product | BrowserCortex |
| Version | \`${packageManifest.version}\` |
| Source commit | \`${compatibility.commit}\` |
| Source tree | \`${compatibility.buildProvenance.sourceTree}\` |
| Distribution | Developer-mode unpacked Chromium extension |
| Browser-store approved | ${compatibility.browserStoreApproved} |
| Minimum Chrome version | ${compatibility.minimumChromeVersion} |

## Privacy treatment

The public evidence bundle deliberately excludes personal contact data, absolute home-directory paths, machine names, exact operating-system builds, processor and graphics-adapter identities, memory size, browser storage size and quota, and per-run identifiers. The source evidence remains bound to the commit, source tree, extension archive, and application digests through cryptographic hashes.

## Deterministic local benchmark

${localReport.summary.passedCases}/${localReport.summary.totalCases} synthetic cases passed, with all quality gates ${localReport.summary.qualityGatesPassed ? 'passing' : 'not passing'}.

| Suite | Passed | p50 ms | p95 ms |
| --- | ---: | ---: | ---: |
${suites.join('\n')}

This benchmark measures deterministic Node implementations. It is not a browser, graphics, real-model, or cross-device benchmark.

## Real-model verification

- Status: **${realReport.status}**
- Embedding vector validity: ${realReport.embedding.quality.vectorValidity.passed}/${realReport.embedding.quality.vectorValidity.total}
- Embedding retrieval correctness: ${realReport.embedding.quality.semanticCorrectness.passed}/${realReport.embedding.quality.semanticCorrectness.total}
- Generation marker checks: ${realReport.generation.cold.exactMarkerPasses + realReport.generation.warm.exactMarkerPasses}/${realReport.generation.cold.firstTokenLatency.sampleCount + realReport.generation.warm.firstTokenLatency.sampleCount}
- Generation schema validity: ${realReport.generation.quality.schemaValidity.passed}/${realReport.generation.quality.schemaValidity.total}
- In-flight cancellation: ${realReport.generation.cancellation.passed ? 'passed' : 'failed'}

Generation semantic correctness was ${realReport.generation.quality.semanticCorrectness.passed}/${realReport.generation.quality.semanticCorrectness.total}, and missing-fact abstention was ${realReport.generation.quality.abstention.passed}/${realReport.generation.quality.abstention.total}. These are visible report-only measurements. Model output remains untrusted proposed content and must pass independent source, schema, policy, approval, and effect checks.

## Artifact inventory

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
${rows.join('\n')}

The extension checksum file can be verified with a SHA-256 tool before extraction. The compatibility record binds the public reports and sanitized provenance to the same release archive.

## Boundaries

- The ZIP is a developer distribution and has not been reviewed by a browser store.
- The model observations describe one redacted runtime configuration and do not establish broad hardware support.
- The quality probes are small, synthetic regression checks rather than a general factuality, safety, or privacy evaluation.
- Firefox, Safari, mobile browsers, private mode, enterprise policy, and low-memory devices remain unsupported or unverified unless a later compatibility report says otherwise.
- Public evidence sanitation removes host-specific details; it does not weaken the product's local-first, approval, or policy boundaries.

Generate this directory from already verified release inputs with \`pnpm release:public\`.
`;
}

const status = git(['status', '--porcelain=v1', '--untracked-files=all']);
assert(status.length === 0, 'Public release generation requires a clean source tree. Commit or remove source changes first.');

const head = git(['rev-parse', 'HEAD']);
const packageManifest = (await requiredJson('package.json')).value;
const sourceProvenanceInput = await requiredJson('release/build-provenance.json');
const sourceCompatibilityInput = await requiredJson('release/compatibility.json');
const sbomInput = await requiredBytes('release/sbom.cdx.json');
const localInput = await requiredJson('benchmarks/reports/local/latest.json');
const realInput = await requiredJson('benchmarks/reports/real-model/latest.json');
const sourceProvenance = sourceProvenanceInput.value;
const sourceCompatibility = sourceCompatibilityInput.value;
const localSource = localInput.value;
const realSource = realInput.value;

assert(sourceCompatibility.version === packageManifest.version, 'Compatibility version does not match package.json.');
assert(sourceCompatibility.commit === head, 'Compatibility metadata is not bound to the current commit.');
assert(sourceProvenance.source?.commit === head, 'Build provenance is not bound to the current commit.');
assert(sourceProvenance.source?.clean === true, 'Build provenance was not recorded from a clean tree.');
assert(localSource.repositoryRevision === head, 'Local benchmark is not bound to the current commit.');
assert(localSource.summary?.qualityGatesPassed === true, 'Local benchmark quality gates did not pass.');
assert(realSource.status === 'passed', 'Real-model verification did not pass its documented gates.');
assert(realSource.runner?.sourceCommit === head, 'Real-model report is not bound to the current commit.');

const archiveName = sourceCompatibility.archive?.filename;
assert(typeof archiveName === 'string' && basename(archiveName) === archiveName, 'Compatibility archive filename is unsafe.');
const archiveBytes = await requiredBytes(`release/${archiveName}`);
const archiveSha256 = sha256(archiveBytes);
assert(archiveSha256 === sourceCompatibility.archive.sha256, 'Extension archive hash does not match compatibility metadata.');
assert(archiveBytes.byteLength === sourceCompatibility.archive.bytes, 'Extension archive size does not match compatibility metadata.');
const sourceChecksum = (await requiredBytes(`release/${archiveName}.sha256`)).toString('utf8').trim();
assert(sourceChecksum === `${archiveSha256}  ${archiveName}`, 'Extension checksum file does not match the archive.');

const sourceProvenanceSha256 = sha256(sourceProvenanceInput.bytes);
const sourceRealSha256 = sha256(realInput.bytes);
assert(sourceCompatibility.buildProvenance?.sha256 === sourceProvenanceSha256, 'Compatibility metadata does not match source build provenance.');
assert(sourceCompatibility.realModelEvidence?.sha256 === sourceRealSha256, 'Compatibility metadata does not match source real-model evidence.');
assert(realSource.evidence?.archive?.sha256 === archiveSha256, 'Real-model evidence does not match the extension archive.');
assert(realSource.evidence?.buildProvenance?.sha256 === sourceProvenanceSha256, 'Real-model evidence does not match build provenance.');

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

const assets = new Map();
assets.set(archiveName, await copyAsset(`release/${archiveName}`, archiveName));
assets.set(`${archiveName}.sha256`, await writeText(`${archiveName}.sha256`, `${archiveSha256}  ${archiveName}`));
assets.set('sbom.cdx.json', await copyAsset('release/sbom.cdx.json', 'sbom.cdx.json'));
assets.set('LICENSE', await copyAsset('LICENSE', 'LICENSE'));
assets.set('THIRD_PARTY_NOTICES.md', await copyAsset('THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'));

for (const screenshot of ['extension-panel.png', 'workbench-overview.png']) {
  assets.set(screenshot, await copyAsset(`release/${screenshot}`, screenshot));
}

const publicProvenance = {
  schemaVersion: 1,
  profile: 'public-sanitized',
  source: {
    commit: sourceProvenance.source.commit,
    tree: sourceProvenance.source.tree,
    clean: sourceProvenance.source.clean,
  },
  toolchain: {
    exactHostAndToolVersionsWithheld: true,
    reproducibilityNote: 'Use package.json, pnpm-lock.yaml, and the documented Node engine to reproduce the build.',
  },
  packageLockSha256: sourceProvenance.packageLockSha256,
  applications: sourceProvenance.applications,
  privacyReview: {
    hostFingerprintPublished: false,
    personalIdentifiersPublished: false,
    absoluteLocalPathsPublished: false,
  },
};
assets.set('build-provenance.json', await writeJson('build-provenance.json', publicProvenance));
const publicProvenanceSha256 = assets.get('build-provenance.json').sha256;

const localReport = {
  schemaVersion: localSource.schemaVersion,
  profile: 'public-sanitized',
  benchmark: localSource.benchmark,
  generatedAt: localSource.generatedAt,
  projectVersion: localSource.projectVersion,
  repositoryRevision: localSource.repositoryRevision,
  trackedWorkingTreeDirty: localSource.trackedWorkingTreeDirty,
  environment: {
    executionScope: 'single local Node process',
    exactHostDetailsWithheld: true,
  },
  corpus: localSource.corpus,
  methodology: localSource.methodology,
  suites: localSource.suites,
  qualityGates: localSource.qualityGates,
  summary: localSource.summary,
  artifacts: {
    json: 'local-benchmark.json',
    markdown: 'local-benchmark.md',
  },
  limitations: [
    ...localSource.limitations.slice(0, -1),
    'Memory, processor frequency, energy, graphics memory, model installation time, token throughput, and cost savings are not measured by this runner. Exact host metadata is not included in the public report.',
  ],
  privacyReview: {
    exactHostDetailsWithheld: true,
    sourceReportSha256: sha256(localInput.bytes),
  },
};
assets.set('local-benchmark.json', await writeJson('local-benchmark.json', localReport));
assets.set('local-benchmark.md', await writeText('local-benchmark.md', localMarkdown(localReport)));

const publicLimitations = realSource.limitations.map((item) => {
  if (item.id === 'single-device-observation') {
    return {
      id: item.id,
      statement: 'Results describe one host, browser build, processor path, and graphics-runtime path. They are not cross-device support evidence.',
    };
  }
  if (item.id === 'latency-sample-boundary') {
    return {
      id: item.id,
      statement: 'Latency percentiles cover twenty sequential samples per cold or warm phase on one redacted host and do not predict other loads, thermal states, or devices.',
    };
  }
  if (item.id === 'storage-estimate-boundary') {
    return {
      id: item.id,
      statement: 'Storage was observed through the browser origin estimate and cache inventory. Exact size and quota values are omitted from public evidence and are not a byte-exact audit.',
    };
  }
  return item;
});

const realReport = {
  schemaVersion: realSource.schemaVersion,
  profile: 'public-sanitized',
  status: realSource.status,
  observedAt: realSource.observedAt,
  environment: {
    runtimeCapabilities: {
      crossOriginIsolated: realSource.environment?.crossOriginIsolated,
      webgpuAvailable: realSource.environment?.webgpu?.available,
    },
    exactHostDetailsWithheld: true,
  },
  consent: realSource.consent,
  methodology: realSource.methodology,
  embedding: {
    modelId: realSource.embedding.modelId,
    revision: realSource.embedding.revision,
    runtime: realSource.embedding.runtime,
    device: realSource.embedding.device,
    dimensions: realSource.embedding.dimensions,
    topMatch: realSource.embedding.topMatch,
    similarities: realSource.embedding.similarities,
    cold: publicLatencyPhase(realSource.embedding.cold),
    warm: publicLatencyPhase(realSource.embedding.warm),
    quality: realSource.embedding.quality,
  },
  generation: {
    modelId: realSource.generation.modelId,
    revision: realSource.generation.revision,
    sourceRevision: realSource.generation.sourceRevision,
    runtime: realSource.generation.runtime,
    device: realSource.generation.device,
    exactOutputMarker: realSource.generation.exactOutputMarker,
    cold: publicGenerationPhase(realSource.generation.cold),
    warm: publicGenerationPhase(realSource.generation.warm),
    quality: realSource.generation.quality,
    cancellation: realSource.generation.cancellation,
  },
  storage: {
    scope: 'fresh temporary verification profile',
    cacheNamesAfter: realSource.storage?.after?.cacheNames ?? [],
    indexedDbDatabaseCountAfter: realSource.storage?.after?.indexedDbDatabases?.length ?? 0,
    exactMeasurementsWithheld: true,
  },
  evidence: {
    scope: realSource.evidence.scope,
    archive: realSource.evidence.archive,
    buildProvenance: {
      filename: 'build-provenance.json',
      sha256: publicProvenanceSha256,
      sourceTree: sourceProvenance.source.tree,
      extensionDigest: sourceProvenance.applications.extension.digest,
    },
    sanitizedFromSourceReportSha256: sourceRealSha256,
  },
  runner: {
    browserMajor: browserMajor(realSource.runner?.browserVersion),
    browserChannel: realSource.runner?.browserChannel,
    headless: realSource.runner?.headless,
    profile: 'fresh temporary browser profile',
    sourceCommit: realSource.runner?.sourceCommit,
    exactHostDetailsWithheld: true,
  },
  limitations: publicLimitations,
  privacyReview: {
    exactHostDetailsWithheld: true,
    exactStorageMeasurementsWithheld: true,
    perRunIdentifierWithheld: true,
  },
};
assets.set('real-model-verification.json', await writeJson('real-model-verification.json', realReport));
assets.set('real-model-verification.md', await writeText('real-model-verification.md', realModelMarkdown(realReport)));

const compatibility = {
  schemaVersion: 1,
  profile: 'public-sanitized',
  product: sourceCompatibility.product,
  version: sourceCompatibility.version,
  commit: sourceCompatibility.commit,
  distribution: sourceCompatibility.distribution,
  browserStoreApproved: sourceCompatibility.browserStoreApproved,
  manifestVersion: sourceCompatibility.manifestVersion,
  extensionVersion: sourceCompatibility.extensionVersion,
  extensionVersionName: sourceCompatibility.extensionVersionName,
  minimumChromeVersion: sourceCompatibility.minimumChromeVersion,
  packagedFileCount: sourceCompatibility.packagedFileCount,
  archive: sourceCompatibility.archive,
  buildProvenance: {
    filename: 'build-provenance.json',
    sha256: publicProvenanceSha256,
    sourceTree: sourceProvenance.source.tree,
    extensionDigest: sourceProvenance.applications.extension.digest,
  },
  generationModel: sourceCompatibility.generationModel,
  localBenchmarkEvidence: {
    filename: 'local-benchmark.json',
    sha256: assets.get('local-benchmark.json').sha256,
    sourceCommit: localReport.repositoryRevision,
    generatedAt: localReport.generatedAt,
  },
  realModelEvidence: {
    filename: 'real-model-verification.json',
    reportSchemaVersion: realReport.schemaVersion,
    sha256: assets.get('real-model-verification.json').sha256,
    sourceCommit: realReport.runner.sourceCommit,
    observedAt: realReport.observedAt,
    scope: realReport.evidence.scope,
    archiveSha256,
    buildProvenanceSha256: publicProvenanceSha256,
    extensionDigest: sourceProvenance.applications.extension.digest,
  },
  privacyReview: {
    publicEvidenceSanitized: true,
    exactHostAndStorageDetailsPublished: false,
    personalIdentifiersPublished: false,
  },
};
assets.set('compatibility.json', await writeJson('compatibility.json', compatibility));

const report = finalReport({ packageManifest, compatibility, localReport, realReport, assets });
assets.set('final-report.md', await writeText('final-report.md', report));

const forbiddenPublicEvidence = [
  /"(?:cpuModel|deviceMemoryGiB|hardwareConcurrency|invocationId|quotaBytes|reportedAverageCpuMHz|totalMemoryBytes|webglRenderer)"\s*:/u,
  /\b(?:AMD Ryzen|GeForce RTX|Radeon RX|Intel\(R\).*CPU)\b/iu,
  /\b[A-Za-z]:[\\/]Users[\\/][^\\/\s"'`<>]+/u,
  /\/(?:Users|home)\/[^/\s"'`<>]+/u,
];
const personalEmail = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/giu;
const allowedEmailDomains = ['example.com', 'example.invalid', 'example.test', 'users.noreply.github.com'];
const generatedTextAssets = new Set([
  'build-provenance.json',
  'compatibility.json',
  'final-report.md',
  'local-benchmark.json',
  'local-benchmark.md',
  'real-model-verification.json',
  'real-model-verification.md',
]);

for (const entry of await readdir(outputDirectory, { withFileTypes: true })) {
  if (!entry.isFile() || !['', '.json', '.md', '.sha256', '.txt'].includes(extname(entry.name))) continue;
  const text = (await readFile(resolve(outputDirectory, entry.name))).toString('utf8');
  for (const pattern of forbiddenPublicEvidence) {
    assert(!pattern.test(text), `${entry.name} contains a public host fingerprint or local path.`);
  }
  if (generatedTextAssets.has(entry.name)) {
    for (const match of text.matchAll(personalEmail)) {
      const domain = match[1].toLocaleLowerCase('en-US');
      assert(
        allowedEmailDomains.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`)),
        `${entry.name} contains a non-reserved email address.`,
      );
    }
  }
}

console.log(`Built ${assets.size} public-safe release assets in ${outputRelative} for commit ${head}.`);
