import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sharpLibvipsCoordinates } from './lib/distribution-boundaries.mjs';
import { npmPurl, parseLockedNpmCoordinates } from './lib/sbom.mjs';

const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const outputDirectory = resolve(root, 'release', 'extension-notices');
const maximumLicenseBytes = 2 * 1024 * 1024;
const fallbackByCoordinate = new Map([
  ['onnxruntime-common@1.30.0', 'third_party/licenses/onnxruntime-MIT.txt'],
  ['onnxruntime-common@1.31.0-dev.20260911-2a43ec07e', 'third_party/licenses/onnxruntime-MIT.txt'],
  ['onnxruntime-node@1.30.0', 'third_party/licenses/onnxruntime-MIT.txt'],
  ['onnxruntime-web@1.31.0-dev.20260914-8d85527a0', 'third_party/licenses/onnxruntime-MIT.txt'],
]);
const excludedFromDistribution = new Map([
  ...sharpLibvipsCoordinates().map((coordinate) => [
    coordinate,
    'Installed as a platform-specific optional dependency of the Node image stack, but native libvips binaries are not present in the browser extension. Release verification rejects native shared libraries and Node addons.',
  ]),
  [
    'guid-typescript@1.0.9',
    'Installed transitively by ONNX Runtime, but its WebGL-only implementation is not present in the reviewed WebGPU extension output. Release verification rejects its known source signatures.',
  ],
]);

function pnpmLicenses() {
  const raw = execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
  });
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('pnpm returned an invalid production license inventory.');
  return parsed;
}

function repositoryUrl(manifest) {
  const value = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  if (typeof value !== 'string' || value.length === 0) return manifest.homepage ?? 'not declared';
  return value.replace(/^git\+/u, '').replace(/^git:\/\//u, 'https://').replace(/\.git$/u, '');
}

async function licenseFiles(packageDirectory) {
  const entries = await readdir(packageDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /^(?:licen[sc]e|copying|notice)(?:[-._].*|$)/iu.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function licenseText(coordinate, packageDirectory) {
  const names = await licenseFiles(packageDirectory);
  const fallback = fallbackByCoordinate.get(coordinate);
  if (names.length === 0 && excludedFromDistribution.has(coordinate)) return [];
  const sources = names.length > 0
    ? names.map((name) => join(packageDirectory, name))
    : fallback
      ? [resolve(root, fallback)]
      : [];
  if (sources.length === 0) {
    throw new Error(`Installed production package has no bundled license/notice file or reviewed fallback: ${coordinate}`);
  }
  const sections = [];
  for (const source of sources) {
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximumLicenseBytes) {
      throw new Error(`License input is not a bounded regular file: ${source}`);
    }
    const bytes = await readFile(source);
    if (bytes.includes(0)) throw new Error(`License input is not text: ${source}`);
    sections.push({ name: basename(source), text: bytes.toString('utf8').replace(/\s+$/u, '') });
  }
  return sections;
}

const lockfile = await readFile(resolve(root, 'pnpm-lock.yaml'), 'utf8');
const lockedCoordinates = parseLockedNpmCoordinates(lockfile);
const packages = new Map();
for (const [groupLicense, entries] of Object.entries(pnpmLicenses())) {
  if (!Array.isArray(entries)) throw new Error(`pnpm license group ${groupLicense} is malformed.`);
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.paths)) throw new Error('pnpm returned malformed license metadata.');
    for (const rawPath of entry.paths) {
      if (typeof rawPath !== 'string') throw new Error('pnpm returned an invalid installed package path.');
      const packageDirectory = await realpath(rawPath);
      const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));
      if (manifest.name !== entry.name || typeof manifest.version !== 'string') {
        throw new Error(`Installed package identity differs from the pnpm license inventory at ${packageDirectory}.`);
      }
      const coordinate = `${manifest.name}@${manifest.version}`;
      if (!lockedCoordinates.has(coordinate)) throw new Error(`Licensed production package is absent from pnpm-lock.yaml: ${coordinate}`);
      if (manifest.license !== groupLicense || entry.license !== groupLicense) {
        throw new Error(`License metadata is inconsistent for ${coordinate}.`);
      }
      const purl = npmPurl(manifest.name, manifest.version);
      const candidate = {
        name: manifest.name,
        version: manifest.version,
        license: groupLicense,
        repository: repositoryUrl(manifest),
        distributionNote: excludedFromDistribution.get(coordinate) ?? null,
        licenseSections: await licenseText(coordinate, packageDirectory),
      };
      const existing = packages.get(purl);
      if (existing && JSON.stringify(existing) !== JSON.stringify(candidate)) {
        throw new Error(`Installed package license files are inconsistent across paths: ${coordinate}`);
      }
      packages.set(purl, candidate);
    }
  }
}
if (packages.size < 10) throw new Error('Production license inventory is unexpectedly small.');

const records = [...packages.entries()].sort(([left], [right]) => left.localeCompare(right));
const bundle = [
  'BrowserCortex third-party production license bundle',
  '',
  'This file is generated from the exact installed production dependency inventory.',
  'Package versions are reconciled with pnpm-lock.yaml. It does not change any upstream license.',
  '',
];
for (const [purl, record] of records) {
  bundle.push(
    '='.repeat(80),
    `${record.name}@${record.version}`,
    `Package URL: ${purl}`,
    `Declared license: ${record.license}`,
    `Repository/homepage: ${record.repository}`,
    '',
  );
  for (const section of record.licenseSections) {
    bundle.push(`--- ${section.name} ---`, '', section.text, '');
  }
  if (record.distributionNote) {
    bundle.push('Distribution status: not included in the extension artifact.', record.distributionNote, '');
  }
}

const registry = JSON.parse(await readFile(resolve(root, 'models', 'registry.json'), 'utf8'));
const generationModel = registry.models?.find((model) => model.taskCapabilities?.includes('generation'));
const modelLibrary = generationModel?.artifacts?.find((artifact) => artifact.kind === 'executable-model-library');
if (
  typeof modelLibrary?.path !== 'string' ||
  typeof modelLibrary.sha256 !== 'string' ||
  typeof modelLibrary.license?.identifier !== 'string' ||
  typeof modelLibrary.license.buildProvenance !== 'string'
) {
  throw new Error('Executable model-library notice metadata is incomplete.');
}
const modelLibraryNotice = (await readFile(resolve(root, 'third_party', 'licenses', 'model-library-NOTICE.txt'), 'utf8')).replace(/\s+$/u, '');
const apacheLicense = (await readFile(resolve(root, 'LICENSE'), 'utf8')).replace(/\s+$/u, '');
bundle.push(
  '='.repeat(80),
  `Bundled executable model library: ${basename(modelLibrary.path)}`,
  `SHA-256: ${modelLibrary.sha256}`,
  `Declared license: ${modelLibrary.license.identifier}`,
  `Build provenance: ${modelLibrary.license.buildProvenance}`,
  '',
  '--- model-library-NOTICE.txt ---',
  '',
  modelLibraryNotice,
  '',
  '--- Apache-2.0.txt ---',
  '',
  apacheLicense,
  '',
);

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(join(outputDirectory, 'LICENSE.txt'), await readFile(resolve(root, 'LICENSE'))),
  writeFile(join(outputDirectory, 'THIRD_PARTY_NOTICES.md'), await readFile(resolve(root, 'THIRD_PARTY_NOTICES.md'))),
  writeFile(join(outputDirectory, 'THIRD_PARTY_LICENSES.txt'), `${bundle.join('\n')}\n`, 'utf8'),
]);
console.log(`Prepared extension license payload for ${packages.size} lockfile-reconciled production packages.`);
