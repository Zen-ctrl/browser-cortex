import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

const root = resolve(process.cwd());
const requiredFiles = [
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
const textExtensions = new Set(['.css', '.html', '.js', '.json', '.md', '.mjs', '.ts', '.tsx', '.txt', '.yaml', '.yml']);
const thirdPartyPrefixes = ['third_party/', 'vendor/'];
const allowedEmailDomains = ['example.com', 'example.invalid', 'example.test', 'users.noreply.github.com'];
const privateOnlyPatterns = [
  /\b(?:this|the) repository is private\b/iu,
  /\b(?:uses|is|remains) a private GitHub repository\b/iu,
  /\bprivate GitHub (?:repository|release|beta)\b/iu,
  /\brequired visibility\s*\|\s*private\b/iu,
  /\bmust remain private\b/iu,
  /\bdo not make (?:it|the repository) public\b/iu,
  /\bprivate-only\b/iu,
  /\bpublish:private\b/iu,
  /\bpublish-private-repository\b/iu,
];
const homePathPatterns = [
  /\b[A-Za-z]:[\\/]Users[\\/][^\\/\s"'`<>]+/u,
  /\/(?:Users|home)\/[^/\s"'`<>]+/u,
];
const publicEvidenceFingerprintPatterns = [
  /"(?:cpuModel|deviceMemoryGiB|hardwareConcurrency|invocationId|quotaBytes|reportedAverageCpuMHz|totalMemoryBytes|webglRenderer)"\s*:/u,
  /\b(?:AMD Ryzen|GeForce RTX|Radeon RX|Intel\(R\).*CPU)\b/iu,
];
const violations = [];

function gitFiles() {
  return execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8',
    windowsHide: true,
  }).split('\0').filter(Boolean).map((path) => path.replaceAll('\\', '/'));
}

function isThirdParty(path) {
  return path === 'LICENSE' || path === 'THIRD_PARTY_NOTICES.md' || thirdPartyPrefixes.some((prefix) => path.startsWith(prefix));
}

function scanPublicText(path, text) {
  for (const pattern of homePathPatterns) {
    if (pattern.test(text)) violations.push(`${path}: contains a local home-directory path`);
  }
  if (path !== 'scripts/check-public-readiness.mjs') {
    for (const pattern of privateOnlyPatterns) {
      if (pattern.test(text)) violations.push(`${path}: contains stale private-repository instructions`);
    }
  }
  if (!isThirdParty(path)) {
    for (const match of text.matchAll(/\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/giu)) {
      const domain = match[1].toLocaleLowerCase('en-US');
      if (!allowedEmailDomains.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`))) {
        violations.push(`${path}: contains a non-reserved email address`);
      }
    }
  }
}

function scanPublicEvidence(path, text) {
  scanPublicText(path, text);
  for (const pattern of publicEvidenceFingerprintPatterns) {
    if (pattern.test(text)) violations.push(`${path}: contains an unnecessary public host fingerprint`);
  }
}

async function verifyMarkdownLinks(path, text) {
  const base = dirname(resolve(root, path));
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)) {
    let target = match[1].trim();
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    target = target.split(/\s+["']/u, 1)[0];
    if (!target || target.startsWith('#') || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(target)) continue;
    const withoutFragment = target.split('#', 1)[0];
    if (!withoutFragment) continue;
    let decoded;
    try {
      decoded = decodeURIComponent(withoutFragment);
    } catch {
      violations.push(`${path}: contains an invalid encoded Markdown link ${JSON.stringify(target)}`);
      continue;
    }
    const absolute = resolve(base, decoded);
    const relative = absolute.slice(root.length + (absolute === root ? 0 : 1));
    if (absolute !== root && (!absolute.startsWith(`${root}${sep}`) || relative.startsWith(`..${sep}`))) {
      violations.push(`${path}: Markdown link escapes the repository: ${target}`);
      continue;
    }
    try {
      await stat(absolute);
    } catch {
      violations.push(`${path}: Markdown link target does not exist: ${target}`);
    }
  }
}

const tracked = gitFiles();
for (const required of requiredFiles) {
  if (!tracked.includes(required)) violations.push(`${required}: required public collaboration file is not tracked`);
}

for (const path of tracked) {
  if (!textExtensions.has(extname(path).toLocaleLowerCase('en-US')) && path !== 'LICENSE') continue;
  const physicalPath = resolve(root, ...path.split('/'));
  let bytes;
  try {
    bytes = await readFile(physicalPath);
  } catch (error) {
    if (error?.code === 'ENOENT') continue;
    throw error;
  }
  if (bytes.byteLength > 4 * 1024 * 1024 || bytes.subarray(0, Math.min(bytes.byteLength, 8_192)).includes(0)) continue;
  const text = bytes.toString('utf8');
  scanPublicText(path, text);
  if (path.endsWith('.md')) await verifyMarkdownLinks(path, text);
}

async function scanPublicAssets(directory, base = directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await scanPublicAssets(path, base);
      continue;
    }
    if (!entry.isFile() || (!textExtensions.has(extname(entry.name).toLocaleLowerCase('en-US')) && entry.name !== 'LICENSE')) continue;
    const bytes = await readFile(path);
    if (bytes.byteLength > 4 * 1024 * 1024 || bytes.subarray(0, Math.min(bytes.byteLength, 8_192)).includes(0)) continue;
    scanPublicEvidence(`release/public-assets/${relative(base, path).replaceAll('\\', '/')}`, bytes.toString('utf8'));
  }
}

await scanPublicAssets(join(root, 'release', 'public-assets'));

if (violations.length) {
  console.error([...new Set(violations)].sort().join('\n'));
  process.exit(1);
}

console.log(`Public-readiness check passed for ${tracked.length} source files, required community documents, public-safe identifiers, local Markdown links, and available public release assets.`);
