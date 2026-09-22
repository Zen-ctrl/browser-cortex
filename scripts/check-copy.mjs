import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const root = process.cwd();
const ignored = new Set(['.git', 'node_modules', 'dist', 'coverage', 'release']);
const proseExtensions = new Set(['.md', '.html', '.css', '.json', '.ts', '.tsx', '.yml', '.yaml']);
const violations = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (proseExtensions.has(extname(entry.name))) {
      const text = await readFile(path, 'utf8');
      if (text.includes('\u2014')) violations.push(relative(root, path));
    }
  }
}

await walk(root);
if (violations.length) {
  console.error(`Forbidden U+2014 found in: ${violations.join(', ')}`);
  process.exit(1);
}
console.log('Authored copy check passed.');

