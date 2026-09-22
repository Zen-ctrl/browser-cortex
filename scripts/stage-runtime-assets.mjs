import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const registry = JSON.parse(await readFile(resolve(root, 'models', 'registry.json'), 'utf8'));
const generation = registry.models?.find((model) => model.taskCapabilities?.includes('generation'));
const executable = generation?.artifacts?.find((artifact) => artifact.kind === 'executable-model-library');
if (!executable?.local || typeof executable.path !== 'string' || typeof executable.sha256 !== 'string' || !Number.isSafeInteger(executable.bytes)) {
  throw new Error('The model registry has no valid local generation executable.');
}
const name = basename(executable.path);
const source = resolve(root, executable.path);
const expected = executable.sha256;
const bytes = await readFile(source).catch(() => {
  throw new Error('Pinned WebLLM runtime asset is missing. Run pnpm runtime:fetch.');
});
if (bytes.byteLength !== executable.bytes) throw new Error('Pinned WebLLM runtime asset has an unexpected byte count.');
const actual = createHash('sha256').update(bytes).digest('hex');
if (actual !== expected) throw new Error('Pinned WebLLM runtime asset failed integrity validation.');

for (const target of [
  `apps/workbench/public/runtime/${name}`,
  `apps/extension/public/runtime/${name}`
]) {
  const destination = resolve(root, target);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}
console.log('Staged verified local WebLLM runtime assets for application builds.');
