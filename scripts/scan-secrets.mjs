import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

const requiredVersion = '8.30.1';
const root = realpathSync(process.cwd());
const reviewedBinaries = JSON.parse(readFileSync(join(root, 'scripts', 'gitleaks-binaries.json'), 'utf8'));

function invoke(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

function runCapture(command, args) {
  const result = invoke(command, args);
  if (result.status !== 0) {
    throw new Error(`${command} failed while preparing the secret scan: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

const gitRoot = realpathSync(runCapture('git', ['rev-parse', '--show-toplevel']).trim());
if (root !== gitRoot) throw new Error('Secret scanning must run from the dedicated repository root.');

const localBinary = join(root, '.tools', 'gitleaks', process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks');
const platformKey = `${process.platform}-${process.arch}`;
const reviewedBinary = reviewedBinaries.binaries?.[platformKey];
if (
  reviewedBinaries.schemaVersion !== 1 ||
  reviewedBinaries.version !== requiredVersion ||
  typeof reviewedBinary?.bytes !== 'number' ||
  typeof reviewedBinary?.sha256 !== 'string'
) {
  throw new Error(`Gitleaks ${requiredVersion} has no reviewed binary identity for ${platformKey}.`);
}
let scannerInfo;
try {
  scannerInfo = lstatSync(localBinary);
} catch (error) {
  if (error?.code === 'ENOENT') {
    throw new Error(`Publication requires the reviewed Gitleaks ${requiredVersion} binary at .tools/gitleaks/${process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks'}.`);
  }
  throw error;
}
if (!scannerInfo.isFile() || scannerInfo.isSymbolicLink() || scannerInfo.size !== reviewedBinary.bytes) {
  throw new Error('The local Gitleaks executable is not the reviewed regular file.');
}
const scannerHash = createHash('sha256').update(readFileSync(localBinary)).digest('hex');
if (scannerHash !== reviewedBinary.sha256) {
  throw new Error('The local Gitleaks executable hash differs from the reviewed upstream release binary.');
}
const versionResult = invoke(localBinary, ['version']);
if (versionResult.status !== 0 || versionResult.stdout.trim() !== requiredVersion) {
  throw new Error(`The reviewed Gitleaks executable did not report version ${requiredVersion}.`);
}
const scanner = localBinary;

const common = [
  '--config', join(root, '.gitleaks.toml'),
  '--no-banner',
  '--no-color',
  '--redact=100',
  '--max-target-megabytes=64',
  '--timeout=300',
];
const scans = [
  ['git', root, '--log-opts=--all', ...common],
  ['git', root, '--staged', ...common],
  ['dir', join(root, 'release'), '--max-archive-depth=2', ...common],
];
for (const args of scans) {
  const result = invoke(scanner, args, { stdio: 'inherit', encoding: undefined });
  if (result.status !== 0) throw new Error(`Gitleaks ${args[0]} scan failed with exit code ${String(result.status)}.`);
}
console.log(`Gitleaks ${requiredVersion} found no secrets in reachable history, the index, or release outputs and archives.`);
