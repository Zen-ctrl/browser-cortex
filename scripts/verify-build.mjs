import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';

import { BUILD_PROVENANCE_PATH, createBuildProvenance } from './lib/build-provenance.mjs';

const required = [
  'apps/workbench/dist/index.html',
  'apps/workbench/dist/service-worker.js',
  'apps/demo-site/dist/index.html',
  'apps/extension/dist/manifest.json',
  'apps/extension/dist/LICENSE.txt',
  'apps/extension/dist/THIRD_PARTY_NOTICES.md',
  'apps/extension/dist/THIRD_PARTY_LICENSES.txt',
];

for (const path of required) await access(path);

async function files(directory, root = directory, output = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await files(path, root, output);
    else if (entry.isFile()) output.push(relative(root, path).replaceAll('\\', '/'));
  }
  return output;
}

const registry = JSON.parse(await readFile('models/registry.json', 'utf8'));
const embedding = registry.models?.find((model) => model.taskCapabilities?.includes('embedding'));
const generation = registry.models?.find((model) => model.taskCapabilities?.includes('generation'));
const embeddingExecutable = embedding?.artifacts?.find((artifact) => artifact.kind === 'runtime-executable');
const executable = generation?.artifacts?.find((artifact) => artifact.kind === 'executable-model-library');
if (
  !embeddingExecutable ||
  embeddingExecutable.packagedDependency !== true ||
  typeof embeddingExecutable.outputName !== 'string' ||
  typeof embeddingExecutable.sha256 !== 'string' ||
  !Number.isSafeInteger(embeddingExecutable.bytes)
) {
  throw new Error('The reviewed embedding runtime executable is missing from the model registry.');
}
if (!executable || typeof executable.path !== 'string' || typeof executable.sha256 !== 'string' || !Number.isSafeInteger(executable.bytes)) {
  throw new Error('The reviewed generation executable is missing from the model registry.');
}
const runtimePath = `runtime/${basename(executable.path)}`;
const escapedEmbeddingName = embeddingExecutable.outputName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const embeddingOutputPattern = new RegExp(`^assets/${escapedEmbeddingName}-[A-Za-z0-9_-]+\\.wasm$`, 'u');

for (const application of ['workbench', 'extension']) {
  const directory = `apps/${application}/dist`;
  const builtFiles = await files(directory);
  const workerFiles = builtFiles.filter((file) => /(?:^|\/)generation-worker[^/]*\.js$/u.test(file));
  const wasmFiles = builtFiles.filter((file) => file.endsWith('.wasm')).sort();
  const embeddingFiles = wasmFiles.filter((file) => embeddingOutputPattern.test(file));
  if (workerFiles.length < 1) throw new Error(`${application} build is missing its dedicated generation worker.`);
  const reviewedWasm = application === 'workbench' && embeddingFiles.length === 1
    ? [embeddingFiles[0], runtimePath].sort()
    : [runtimePath];
  if (JSON.stringify(wasmFiles) !== JSON.stringify(reviewedWasm)) {
    throw new Error(`${application} build contains an unreviewed WASM executable.`);
  }
  const runtime = await readFile(`${directory}/${runtimePath}`);
  if (runtime.byteLength !== executable.bytes) throw new Error(`${application} build has the wrong generation executable byte count.`);
  const actual = createHash('sha256').update(runtime).digest('hex');
  if (actual !== executable.sha256) throw new Error(`${application} build has a corrupt generation executable.`);
  if (application === 'workbench') {
    const embeddingRuntime = await readFile(`${directory}/${embeddingFiles[0]}`);
    if (embeddingRuntime.byteLength !== embeddingExecutable.bytes) {
      throw new Error('workbench build has the wrong embedding runtime executable byte count.');
    }
    const embeddingSha256 = createHash('sha256').update(embeddingRuntime).digest('hex');
    if (embeddingSha256 !== embeddingExecutable.sha256) {
      throw new Error('workbench build has a corrupt embedding runtime executable.');
    }
  }
}

const provenance = await createBuildProvenance();
await mkdir('release', { recursive: true });
await writeFile(BUILD_PROVENANCE_PATH, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
console.log(`Required application, worker, service-worker, and verified runtime build artifacts are present. Build provenance recorded for ${provenance.source.commit}.`);
