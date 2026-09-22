import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const ignored = new Set(['.git', 'node_modules', 'dist', 'coverage', 'release']);
const violations = [];
const forbidden = [
  { pattern: /\beval\s*\(/u, label: 'dynamic eval' },
  { pattern: /\bnew\s+Function\s*\(/u, label: 'dynamic Function' },
  { pattern: new RegExp(['dangerouslySet', 'InnerHTML'].join(''), 'u'), label: 'unsafe HTML rendering' }
];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (['.ts', '.tsx', '.js', '.mjs'].includes(extname(entry.name))) {
      const text = await readFile(path, 'utf8');
      for (const rule of forbidden) {
        if (rule.pattern.test(text)) violations.push(`${relative(root, path)}: ${rule.label}`);
      }
    }
  }
}

await walk(root);
if (violations.length) {
  console.error(violations.join('\n'));
  process.exit(1);
}
const typecheck = spawnSync('pnpm', ['typecheck'], { stdio: 'inherit', shell: process.platform === 'win32' });
if (typecheck.status !== 0) process.exit(typecheck.status ?? 1);
console.log('Static lint and boundary checks passed.');
