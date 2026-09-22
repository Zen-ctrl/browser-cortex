import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const copyChecker = resolve(process.cwd(), 'scripts/check-copy.mjs');
const attributionChecker = resolve(process.cwd(), 'scripts/check-attribution.mjs');
const roots: string[] = [];

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'browser-cortex-authorship-'));
  roots.push(root);
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: root, windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'Synthetic Fixture'], { cwd: root, windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: root, windowsHide: true });
  await writeFile(join(root, 'README.md'), '# Synthetic fixture\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: root, windowsHide: true });
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root, windowsHide: true });
  return root;
}

function run(script: string, root: string) {
  return spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('authored-copy and attribution fixtures', () => {
  it('rejects the forbidden prose code point and accepts clean copy', async () => {
    const root = await repository();
    await writeFile(join(root, 'COPY.md'), `left${String.fromCodePoint(0x2014)}right\n`, 'utf8');
    const rejected = run(copyChecker, root);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('COPY.md');

    await writeFile(join(root, 'COPY.md'), 'left - right\n', 'utf8');
    const accepted = run(copyChecker, root);
    expect(accepted.status).toBe(0);
  });

  it('rejects an automated-attribution commit while accepting ordinary authorship', async () => {
    const root = await repository();
    await writeFile(join(root, 'CHANGE.md'), 'Synthetic change.\n', 'utf8');
    execFileSync('git', ['add', 'CHANGE.md'], { cwd: root, windowsHide: true });
    const unwantedMessage = ['Generated', 'by', 'Codex'].join(' ');
    execFileSync('git', ['commit', '--quiet', '-m', unwantedMessage], { cwd: root, windowsHide: true });

    const rejected = run(attributionChecker, root);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('Git commit messages');
  });
});
