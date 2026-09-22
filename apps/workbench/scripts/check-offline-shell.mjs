import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageDirectory, '../..');
const distribution = resolve(packageDirectory, 'dist');
const registry = JSON.parse(await readFile(resolve(repositoryRoot, 'models/registry.json'), 'utf8'));
const generation = registry.models?.find((model) => model.taskCapabilities?.includes('generation'));
const executable = generation?.artifacts?.find((artifact) => artifact.kind === 'executable-model-library');
if (!executable?.local || typeof executable.path !== 'string' || typeof executable.sha256 !== 'string' || !Number.isSafeInteger(executable.bytes)) {
  throw new Error('The model registry has no valid local generation executable.');
}
const serviceWorker = await readFile(resolve(distribution, 'service-worker.js'), 'utf8');
const manifestMatch = /const PRECACHE = Object\.freeze\((\[[^;]+\])\);/u.exec(serviceWorker);
if (!manifestMatch?.[1]) throw new Error('Production service worker has no static precache manifest.');
const precache = JSON.parse(manifestMatch[1]);
if (!Array.isArray(precache) || precache.some((value) => typeof value !== 'string')) throw new Error('Production precache manifest is invalid.');
if (precache.some((path) => /\/(?:api|v1|inference|gateway|private|vault)(?:\/|$)/u.test(path) || /^https?:/u.test(path))) {
  throw new Error('Production precache contains a private, API, inference, or remote URL.');
}
const runtimePath = `/runtime/${basename(executable.path)}`;
if (!precache.includes(runtimePath)) throw new Error('The pinned local generation executable is missing from the offline shell.');
if (!precache.some((path) => /generation-worker.+\.js$/u.test(path))) throw new Error('Generation worker is missing from the offline shell.');
for (const path of new Set(precache)) {
  const file = path === '/' ? 'index.html' : path.replace(/^\//u, '');
  const absolute = resolve(distribution, file);
  const child = relative(distribution, absolute);
  if (child.startsWith('..') || isAbsolute(child)) throw new Error(`Precache path escaped dist: ${path}`);
  const metadata = await stat(absolute);
  if (!metadata.isFile()) throw new Error(`Precache entry is not a file: ${path}`);
}
if (serviceWorker.includes('cache.put(') || serviceWorker.includes('caches.match(event.request')) {
  throw new Error('Service worker must not runtime-cache arbitrary requests.');
}
const runtime = await readFile(resolve(distribution, runtimePath.slice(1)));
if (runtime.byteLength !== executable.bytes) throw new Error('Packaged model library has an unexpected byte length.');
const digest = createHash('sha256').update(runtime).digest('hex');
if (digest !== executable.sha256) {
  throw new Error('Packaged model library failed the production offline-shell integrity check.');
}
console.log(`Verified ${precache.length} production offline-shell assets.`);
