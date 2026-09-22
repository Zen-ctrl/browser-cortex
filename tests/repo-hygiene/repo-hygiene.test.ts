import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';

const checker = resolve(process.cwd(), 'scripts/check-repo-hygiene.mjs');
const roots: string[] = [];

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'browser-cortex-hygiene-'));
  roots.push(root);
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: root, windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'Synthetic Fixture'], { cwd: root, windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: root, windowsHide: true });
  await writeFile(join(root, 'README.md'), '# Synthetic hygiene fixture\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: root, windowsHide: true });
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root, windowsHide: true });
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

describe('repository hygiene fixtures', () => {
  it('finds a staged credential even when the working-tree copy is clean', async () => {
    const root = await repository();
    const credentialName = ['api', 'key'].join('_');
    await writeFile(join(root, 'config.ts'), `export const ${credentialName} = "${'SYNTHETIC'.padEnd(24, 'X')}";\n`, 'utf8');
    execFileSync('git', ['add', 'config.ts'], { cwd: root, windowsHide: true });
    await writeFile(join(root, 'config.ts'), 'export const mode = "local";\n', 'utf8');

    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('config.ts: possible credential assignment in staged index');
  });

  it('finds an ignored but force-tracked secret path', async () => {
    const root = await repository();
    await writeFile(join(root, '.gitignore'), '.env*\n', 'utf8');
    await writeFile(join(root, '.env.production'), 'SYNTHETIC_ONLY=true\n', 'utf8');
    execFileSync('git', ['add', '.gitignore'], { cwd: root, windowsHide: true });
    execFileSync('git', ['add', '--force', '.env.production'], { cwd: root, windowsHide: true });

    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('.env.production: forbidden tracked or staged path');
  });

  it('rejects forbidden files inside a release ZIP and accepts a clean synthetic repository', async () => {
    const root = await repository();
    await mkdir(join(root, 'release'));
    const archive = new JSZip();
    archive.file('.env.production', 'SYNTHETIC_ONLY=true\n');
    await writeFile(join(root, 'release', 'candidate.zip'), await archive.generateAsync({ type: 'nodebuffer' }));
    const rejected = run(root);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('forbidden archive entry');

    await rm(join(root, 'release'), { recursive: true, force: true });
    const accepted = run(root);
    expect(accepted.status).toBe(0);
    expect(accepted.stdout).toContain('Repository hygiene check passed');
  });
});
