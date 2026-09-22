import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const checker = resolve(process.cwd(), 'scripts/check-public-readiness.mjs');
const roots: string[] = [];
const required = [
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'SUPPORT.md',
  'CODE_OF_CONDUCT.md',
  'LICENSE',
  'docs/README.md',
  'docs/getting-started.md',
  'docs/technical-guide.md',
  'docs/troubleshooting.md',
  'docs/packages.md',
  '.github/ISSUE_TEMPLATE/config.yml',
];

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'browser-cortex-public-readiness-'));
  roots.push(root);
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: root, windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'Synthetic Fixture'], { cwd: root, windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: root, windowsHide: true });
  for (const path of required) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), path === 'LICENSE' ? 'Synthetic license fixture\n' : `# ${path}\n`, 'utf8');
  }
  return root;
}

function run(root: string) {
  return spawnSync(process.execPath, [checker], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('public-readiness fixtures', () => {
  it('accepts reserved synthetic identifiers and required collaboration documents', async () => {
    const root = await repository();
    await writeFile(join(root, 'docs', 'safe.md'), 'Contact fixture@example.test. See [README](../README.md).\n', 'utf8');
    const result = run(root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Public-readiness check passed');
  });

  it('rejects home paths, personal email, and outdated visibility instructions', async () => {
    const root = await repository();
    const unsafePath = ['C:', 'Users', 'named-person', 'project'].join('\\');
    const unsafeEmail = ['real.person', 'ordinary-domain.org'].join('@');
    const staleInstruction = ['This repository', 'is private.'].join(' ');
    await writeFile(
      join(root, 'docs', 'unsafe.md'),
      `Local copy: ${unsafePath}. Contact ${unsafeEmail}. ${staleInstruction}\n`,
      'utf8',
    );
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('local home-directory path');
    expect(result.stderr).toContain('non-reserved email address');
    expect(result.stderr).toContain('stale private-repository instructions');
  });

  it('scans ignored-style public release evidence for host fingerprints', async () => {
    const root = await repository();
    const directory = join(root, 'release', 'public-assets');
    await mkdir(directory, { recursive: true });
    const fingerprintKey = ['cpu', 'Model'].join('');
    await writeFile(join(directory, 'evidence.json'), `${JSON.stringify({ [fingerprintKey]: 'Synthetic processor' })}\n`, 'utf8');
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unnecessary public host fingerprint');
  });
});
