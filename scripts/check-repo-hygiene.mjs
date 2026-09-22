import { execFileSync } from 'node:child_process';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import JSZip from 'jszip';

const root = await realpath(resolve(process.cwd()));
const gitRoot = await realpath(execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
  windowsHide: true,
}).trim());
if (gitRoot !== root) throw new Error('Repository hygiene must run from the dedicated repository root.');

const forbiddenPaths = /(?:^|\/)(?:\.env(?:\.[^\/]*)?|browser-profiles?|user-data|models\/weights|models\/cache|runtime-data|user-exports?|diagnostics\/private)(?:\/|$)/iu;
const forbiddenReleasePaths = /(?:^|\/)(?:\.env(?:\.[^\/]*)?|browser-profiles?|user-data|models\/weights|models\/cache|runtime-data|user-exports?|diagnostics\/private|node_modules|\.git)(?:\/|$)/iu;
const forbiddenReleaseExtensions = /\.(?:map|pem|key|p12|pfx|safetensors|gguf|bin)$/iu;
const likelyTextExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.json', '.md', '.txt', '.yml', '.yaml', '.html', '.css', '.csv']);
const maxTrackedBytes = 25 * 1024 * 1024;
const maxScannedTextBytes = 64 * 1024 * 1024;
const maxReleaseArchiveBytes = 64 * 1024 * 1024;
const privateKeyBoundary = (kind) => ['-----', kind, ' ', '(?:RSA |EC |OPENSSH )?', 'PRIVATE KEY-----'].join('');
const secretRules = [
  {
    label: 'private key material',
    pattern: new RegExp(`${privateKeyBoundary('BEGIN')}\\s+[A-Za-z0-9+/=\\r\\n]{32,}\\s+${privateKeyBoundary('END')}`, 'u'),
  },
  { label: 'credential assignment', pattern: /(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["'][A-Za-z0-9_\-]{20,}["']/iu },
  { label: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/u },
  { label: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/u },
];
const violations = [];

function normalizeRepositoryPath(value) {
  const normalized = value.replaceAll('\\', '/');
  if (
    normalized.length === 0 ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.includes('\0')
  ) {
    throw new Error(`Git returned an unsafe repository path: ${JSON.stringify(value)}`);
  }
  return normalized;
}

function listedFiles(args) {
  const output = execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return output.split('\0').filter(Boolean).map(normalizeRepositoryPath);
}

function likelyText(path, bytes) {
  if (bytes.byteLength > maxScannedTextBytes) return false;
  if (likelyTextExtensions.has(extname(path).toLocaleLowerCase('en-US'))) return true;
  return !bytes.subarray(0, Math.min(bytes.byteLength, 8_192)).includes(0);
}

function scanSecrets(path, bytes, label) {
  if (!likelyText(path, bytes)) return;
  const text = bytes.toString('utf8');
  for (const rule of secretRules) {
    if (rule.pattern.test(text)) violations.push(`${path}: possible ${rule.label} in ${label}`);
  }
}

function assertSafePath(path, label, pattern = forbiddenPaths) {
  if (pattern.test(path)) violations.push(`${path}: forbidden ${label} path`);
}

function indexBytes(path) {
  try {
    return execFileSync('git', ['-C', root, 'show', `:${path}`], {
      encoding: 'buffer',
      windowsHide: true,
      maxBuffer: maxTrackedBytes + 1024,
    });
  } catch (error) {
    const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
    if (status === 128) return undefined;
    throw error;
  }
}

const tracked = listedFiles(['ls-files', '-z']);
const staged = new Set(listedFiles(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']));
for (const path of tracked) {
  assertSafePath(path, 'tracked or staged');
  const physicalPath = resolve(root, ...path.split('/'));
  const relativePath = relative(root, physicalPath);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    violations.push(`${path}: resolves outside the repository`);
    continue;
  }
  try {
    const info = await lstat(physicalPath);
    if (info.isSymbolicLink()) violations.push(`${path}: tracked symbolic links are not accepted by the release policy`);
    else if (!info.isFile()) violations.push(`${path}: tracked entry is not a regular file`);
    else {
      if (info.size > maxTrackedBytes) violations.push(`${path}: tracked file exceeds 25 MiB`);
      scanSecrets(path, await readFile(physicalPath), 'working tree');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const indexed = indexBytes(path);
  if (indexed) {
    if (indexed.byteLength > maxTrackedBytes) violations.push(`${path}: indexed file exceeds 25 MiB`);
    scanSecrets(path, indexed, staged.has(path) ? 'staged index' : 'Git index');
  }
}

async function scanZip(archiveName, bytes) {
  if (bytes.byteLength > maxReleaseArchiveBytes) {
    violations.push(`release/${archiveName}: archive exceeds 64 MiB`);
    return;
  }
  let archive;
  try {
    archive = await JSZip.loadAsync(bytes, { checkCRC32: true, createFolders: false });
  } catch {
    violations.push(`release/${archiveName}: unreadable ZIP archive`);
    return;
  }
  const names = Object.keys(archive.files);
  if (names.length > 10_000) violations.push(`release/${archiveName}: archive contains too many entries`);
  for (const rawName of names) {
    const entry = archive.files[rawName];
    if (entry?.unsafeOriginalName && entry.unsafeOriginalName !== rawName) {
      violations.push(`release/${archiveName}:${rawName}: ZIP entry was sanitized from an unsafe path`);
    }
    const name = normalizeRepositoryPath(rawName);
    if (!entry || entry.dir) continue;
    assertSafePath(name, `archive entry in ${archiveName}`, forbiddenReleasePaths);
    if (forbiddenReleaseExtensions.test(name)) {
      violations.push(`release/${archiveName}:${name}: forbidden archive file type`);
    }
    const entryBytes = await entry.async('nodebuffer');
    scanSecrets(name, entryBytes, `release archive ${archiveName}`);
  }
}

async function walkRelease(directory, base = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const name = relative(base, path).replaceAll('\\', '/');
    if (entry.isDirectory()) await walkRelease(path, base);
    else if (entry.isSymbolicLink()) violations.push(`release/${name}: release symbolic links are forbidden`);
    else if (entry.isFile()) {
      assertSafePath(name, 'release', forbiddenReleasePaths);
      if (forbiddenReleaseExtensions.test(name)) violations.push(`release/${name}: forbidden release file type`);
      const bytes = await readFile(path);
      scanSecrets(`release/${name}`, bytes, 'release output');
      if (name.endsWith('.zip')) await scanZip(name, bytes);
    }
  }
}

try {
  await walkRelease(join(root, 'release'));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

if (violations.length) {
  console.error([...new Set(violations)].sort().join('\n'));
  process.exit(1);
}
console.log(`Repository hygiene check passed for ${tracked.length} tracked/indexed files and available release outputs.`);
