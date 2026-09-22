import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

export const BUILD_PROVENANCE_PATH = 'release/build-provenance.json';
export const BUILD_APPLICATIONS = Object.freeze({
  workbench: 'apps/workbench/dist',
  extension: 'apps/extension/dist',
  demo: 'apps/demo-site/dist',
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function git(args, root) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

function pnpmVersion(root) {
  return execFileSync('pnpm', ['--version'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    shell: process.platform === 'win32',
  }).trim();
}

export function sourceState(root = process.cwd()) {
  const status = git(['status', '--porcelain=v1', '--untracked-files=all'], root);
  return {
    commit: git(['rev-parse', 'HEAD'], root),
    tree: git(['rev-parse', 'HEAD^{tree}'], root),
    clean: status.length === 0,
  };
}

export function assertCleanSource(root = process.cwd()) {
  const source = sourceState(root);
  if (!source.clean) {
    throw new Error('Trusted build and model evidence require a clean tracked and untracked source tree.');
  }
  return source;
}

async function artifactFiles(directory, root = directory, output = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await artifactFiles(path, root, output);
    else if (entry.isFile()) {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Build output is not a regular file: ${path}`);
      const bytes = await readFile(path);
      output.push({
        path: relative(root, path).replaceAll('\\', '/'),
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
      });
    } else {
      throw new Error(`Build output contains an unsupported filesystem entry: ${path}`);
    }
  }
  return output;
}

async function applicationRecord(directory) {
  const files = await artifactFiles(directory);
  const totalBytes = files.reduce((total, file) => total + file.bytes, 0);
  return {
    directory: directory.replaceAll('\\', '/'),
    fileCount: files.length,
    totalBytes,
    digest: sha256(JSON.stringify(files)),
    files,
  };
}

export async function createBuildProvenance(root = process.cwd()) {
  const applications = {};
  for (const [name, directory] of Object.entries(BUILD_APPLICATIONS)) {
    applications[name] = await applicationRecord(join(root, directory));
    applications[name].directory = directory;
  }
  const lockfile = await readFile(join(root, 'pnpm-lock.yaml'));
  return {
    schemaVersion: 1,
    source: sourceState(root),
    toolchain: {
      node: process.version,
      pnpm: pnpmVersion(root),
      platform: process.platform,
      architecture: process.arch,
    },
    packageLockSha256: sha256(lockfile),
    applications,
  };
}

export async function verifyBuildProvenance(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Build provenance is malformed.');
  const expected = await createBuildProvenance(options.root ?? process.cwd());
  if (options.requireClean !== false && !expected.source.clean) {
    throw new Error('Release verification requires a clean tracked and untracked source tree.');
  }
  if (JSON.stringify(input) !== JSON.stringify(expected)) {
    throw new Error('Build provenance does not match the current source commit, lockfile, or application outputs. Run pnpm build.');
  }
  return expected;
}

export function buildProvenanceSha256(bytes) {
  return sha256(bytes);
}
