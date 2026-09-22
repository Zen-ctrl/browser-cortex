import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = process.cwd();
const ignored = new Set(['.git', 'node_modules', 'dist', 'coverage', 'release']);
const patterns = [/co-authored-by:\s*(?:chatgpt|codex|assistant|bot)/iu, /generated\s+by\s+(?:chatgpt|codex|ai)/iu];
const violations = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (/\.(?:md|txt|json|ya?ml)$/u.test(entry.name)) {
      const text = await readFile(path, 'utf8');
      if (patterns.some((pattern) => pattern.test(text))) violations.push(relative(root, path));
    }
  }
}

await walk(root);
try {
  const messages = execFileSync('git', ['log', '--format=%B'], { encoding: 'utf8' });
  if (patterns.some((pattern) => pattern.test(messages))) violations.push('Git commit messages');
} catch {
  // An empty new repository has no commit log yet.
}

if (violations.length) {
  console.error(`Unwanted automated attribution found in: ${violations.join(', ')}`);
  process.exit(1);
}
console.log('Attribution check passed.');

