import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const artifact = {
  url: 'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/SmolLM2-360M-Instruct-q4f16_1_cs1k-webgpu.wasm',
  destination: 'vendor/runtime/SmolLM2-360M-Instruct-q4f16_1_cs1k-webgpu.wasm',
  bytes: 5_708_562,
  sha256: '5c20098605780550c40e9c64d288dd6e369707a08d4133037156019b064ad41b',
};

class IntegrityError extends Error {}

function assertDirectChild(directory, path, label) {
  const child = relative(directory, path);
  if (
    child.length === 0 ||
    child === '..' ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child) ||
    dirname(path) !== directory
  ) {
    throw new Error(`${label} must be a direct child of the reviewed runtime directory.`);
  }
}

function verify(bytes) {
  if (bytes.byteLength !== artifact.bytes) {
    throw new IntegrityError(`Unexpected runtime size: ${bytes.byteLength}`);
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== artifact.sha256) throw new IntegrityError(`Runtime integrity mismatch: ${digest}`);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function inspectInstalled(path) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    throw error;
  }
  try {
    verify(bytes);
    return 'valid';
  } catch (error) {
    if (error instanceof IntegrityError) return 'invalid';
    throw error;
  }
}

async function writeVerifiedTemporary(path, bytes) {
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    verify(await readFile(path));
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(path, { force: true }).catch(() => {});
    throw error;
  }
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDirectory = resolve(repositoryRoot, 'vendor', 'runtime');
const destination = resolve(repositoryRoot, artifact.destination);
assertDirectChild(runtimeDirectory, destination, 'Runtime destination');
if (basename(destination) !== basename(artifact.destination)) {
  throw new Error('Runtime destination filename changed during path resolution.');
}
await mkdir(runtimeDirectory, { recursive: true });
const physicalRepository = await realpath(repositoryRoot);
const physicalRuntimeDirectory = await realpath(runtimeDirectory);
const physicalRuntimeRelative = relative(physicalRepository, physicalRuntimeDirectory);
if (
  physicalRuntimeRelative === '..' ||
  physicalRuntimeRelative.startsWith(`..${sep}`) ||
  isAbsolute(physicalRuntimeRelative) ||
  physicalRuntimeRelative.replaceAll('\\', '/') !== 'vendor/runtime'
) {
  throw new Error('The reviewed runtime directory resolves outside the repository or through an unexpected link.');
}

const installedState = await inspectInstalled(destination);
if (installedState === 'valid') {
  console.log('Pinned WebLLM model library is already installed and verified.');
  process.exit(0);
}

const source = new URL(artifact.url);
if (source.protocol !== 'https:') throw new Error('Runtime downloads require HTTPS.');
const response = await fetch(source, { redirect: 'error' });
if (!response.ok) throw new Error(`Runtime download failed with status ${response.status}.`);
const declaredHeader = response.headers.get('content-length');
if (declaredHeader !== null) {
  const declared = Number(declaredHeader);
  if (!/^\d+$/u.test(declaredHeader) || !Number.isSafeInteger(declared) || declared !== artifact.bytes) {
    throw new Error(`Unexpected declared runtime size: ${declaredHeader}`);
  }
}
const bytes = new Uint8Array(await response.arrayBuffer());
verify(bytes);

const nonce = randomUUID();
const temporary = join(runtimeDirectory, `.${basename(destination)}.${nonce}.partial`);
const quarantine = join(runtimeDirectory, `.${basename(destination)}.${nonce}.invalid`);
const failedReplacement = join(runtimeDirectory, `.${basename(destination)}.${nonce}.failed`);
for (const [path, label] of [
  [temporary, 'Temporary runtime'],
  [quarantine, 'Quarantined runtime'],
  [failedReplacement, 'Failed replacement'],
]) {
  assertDirectChild(runtimeDirectory, path, label);
}

await writeVerifiedTemporary(temporary, bytes);
let originalQuarantined = false;
let replacementInstalled = false;

try {
  if (installedState === 'invalid') {
    await rename(destination, quarantine);
    originalQuarantined = true;
  }
  await rename(temporary, destination);
  replacementInstalled = true;
  verify(await readFile(destination));
} catch (installError) {
  const recoveryErrors = [];
  if (originalQuarantined) {
    try {
      if (replacementInstalled && (await exists(destination))) {
        await rename(destination, failedReplacement);
      }
      await rename(quarantine, destination);
      originalQuarantined = false;
      if (await exists(failedReplacement)) {
        await rm(failedReplacement);
      }
    } catch (recoveryError) {
      recoveryErrors.push(recoveryError);
    }
  } else if (replacementInstalled) {
    try {
      await rm(destination);
    } catch (recoveryError) {
      recoveryErrors.push(recoveryError);
    }
  }
  await rm(temporary, { force: true }).catch((cleanupError) => recoveryErrors.push(cleanupError));
  if (recoveryErrors.length > 0) {
    throw new AggregateError(
      [installError, ...recoveryErrors],
      `Runtime installation failed and automatic recovery was incomplete. Recovery files remain inside ${runtimeDirectory}.`,
    );
  }
  throw installError;
}

if (originalQuarantined) {
  await rm(quarantine).catch((error) => {
    console.warn(`Installed the verified runtime, but could not remove quarantined invalid data at ${quarantine}: ${error.message}`);
  });
}
console.log(`Installed verified runtime asset: ${artifact.destination}`);
