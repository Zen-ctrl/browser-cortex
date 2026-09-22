import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

function pnpm(args, cwd) {
  execFileSync('pnpm', args, {
    cwd,
    stdio: 'inherit',
    windowsHide: true,
    shell: process.platform === 'win32',
  });
}

const root = await realpath(process.cwd());
if (await realpath(git(['rev-parse', '--show-toplevel'], root)) !== root) {
  throw new Error('Trusted release rebuilding must run from the dedicated repository root.');
}
if (git(['status', '--porcelain=v1', '--untracked-files=all'], root)) {
  throw new Error('Trusted release rebuilding requires a clean tracked and untracked source tree.');
}
const head = git(['rev-parse', 'HEAD'], root);
const temporaryParent = await realpath(tmpdir());
const temporaryContainer = await mkdtemp(join(temporaryParent, 'browser-cortex-release-'));
if (dirname(temporaryContainer) !== temporaryParent) {
  throw new Error('Temporary trusted-release worktree escaped the system temporary directory.');
}
const temporaryRoot = join(temporaryContainer, 'checkout');

let worktreeRegistered = false;
try {
  git(['worktree', 'add', '--detach', temporaryRoot, head], root);
  worktreeRegistered = true;

  const reportDirectory = join(temporaryRoot, 'benchmarks', 'reports', 'real-model');
  await mkdir(reportDirectory, { recursive: true });
  for (const name of ['latest.json', 'latest.md']) {
    await copyFile(
      join(root, 'benchmarks', 'reports', 'real-model', name),
      join(reportDirectory, name),
    );
  }

  pnpm(['install', '--frozen-lockfile'], temporaryRoot);
  pnpm(['build'], temporaryRoot);
  pnpm(['package:extension'], temporaryRoot);
  pnpm(['sbom'], temporaryRoot);
  pnpm(['verify:trusted-release'], temporaryRoot);

  const packageManifest = JSON.parse(await readFile(join(temporaryRoot, 'package.json'), 'utf8'));
  const archiveName = `browser-cortex-extension-v${packageManifest.version}.zip`;
  const releaseFiles = [
    archiveName,
    `${archiveName}.sha256`,
    'compatibility.json',
    'build-provenance.json',
    'sbom.cdx.json',
  ];
  await mkdir(join(root, 'release'), { recursive: true });
  for (const name of releaseFiles) {
    await copyFile(join(temporaryRoot, 'release', name), join(root, 'release', name));
  }
  await mkdir(join(root, 'release', 'extension-notices'), { recursive: true });
  for (const name of ['LICENSE.txt', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_LICENSES.txt']) {
    await copyFile(
      join(temporaryRoot, 'release', 'extension-notices', name),
      join(root, 'release', 'extension-notices', name),
    );
  }
  console.log(`Rebuilt and verified the report-bound release from fresh worktree commit ${head}.`);
} finally {
  if (worktreeRegistered) {
    const removal = spawnSync('git', ['worktree', 'remove', '--force', temporaryRoot], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (removal.status !== 0) {
      console.error(`Temporary Git worktree cleanup requires attention: ${(removal.stderr || removal.stdout).trim()}`);
    }
  }
  if (resolve(temporaryContainer).startsWith(`${temporaryParent}${process.platform === 'win32' ? '\\' : '/'}`)) {
    await rm(temporaryContainer, { recursive: true, force: true });
    if (worktreeRegistered) {
      spawnSync('git', ['worktree', 'prune', '--expire', 'now'], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
      });
    }
  }
}
