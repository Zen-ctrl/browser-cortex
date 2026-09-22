import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import JSZip from 'jszip';
import {
  collectProductionComponents,
  listInstalledProductionProjects,
  npmPurl,
  parseLockedNpmCoordinates,
  parseOptionalLockedNpmCoordinates,
} from './lib/sbom.mjs';
import {
  BUILD_PROVENANCE_PATH,
  buildProvenanceSha256,
  verifyBuildProvenance,
} from './lib/build-provenance.mjs';
import { isForbiddenNativeExtensionFile } from './lib/distribution-boundaries.mjs';
import { assertExtensionManifest } from './lib/extension-manifest.mjs';

function run(script) {
  execFileSync('pnpm', [script], {
    stdio: 'inherit',
    windowsHide: true,
    shell: process.platform === 'win32',
  });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function collect(directory, root = directory, output = new Map()) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path, root, output);
    else if (entry.isFile()) output.set(relative(root, path).replaceAll('\\', '/'), await readFile(path));
    else throw new Error(`Release input contains an unsupported filesystem entry: ${path}`);
  }
  return output;
}

run('check:copy');
run('check:attribution');
run('check:public');
run('check:repo-hygiene');
run('verify:models');

const packageManifest = JSON.parse(await readFile('package.json', 'utf8'));
const extensionPackageManifest = JSON.parse(await readFile('apps/extension/package.json', 'utf8'));
if (extensionPackageManifest.version !== packageManifest.version) {
  throw new Error('The extension package version differs from the root release version.');
}
const buildProvenanceBytes = await readFile(BUILD_PROVENANCE_PATH).catch(() => {
  throw new Error('Build provenance is missing. Run pnpm build before release verification.');
});
const buildProvenance = JSON.parse(buildProvenanceBytes.toString('utf8'));
await verifyBuildProvenance(buildProvenance);
const modelRegistry = JSON.parse(await readFile('models/registry.json', 'utf8'));
const generationModel = modelRegistry.models?.find((model) => model.taskCapabilities?.includes('generation'));
const modelLibrary = generationModel?.artifacts?.find((artifact) => artifact.kind === 'executable-model-library');
if (
  typeof generationModel?.runtimeModelId !== 'string' ||
  typeof generationModel.revision !== 'string' ||
  typeof generationModel.license?.identifier !== 'string' ||
  typeof modelLibrary?.path !== 'string' ||
  typeof modelLibrary.upstreamRevision !== 'string' ||
  typeof modelLibrary.license?.identifier !== 'string' ||
  typeof modelLibrary.license.buildProvenance !== 'string' ||
  !Array.isArray(modelLibrary.license.sources) ||
  modelLibrary.license.sources.length < 2 ||
  modelLibrary.license.sources.some((source) =>
    typeof source?.repository !== 'string' ||
    typeof source.revision !== 'string' ||
    typeof source.license !== 'string' ||
    typeof source.notice !== 'string'
  ) ||
  typeof modelLibrary.sha256 !== 'string' ||
  !Number.isSafeInteger(modelLibrary.bytes)
) {
  throw new Error('Reviewed generation model metadata is incomplete.');
}
const manifest = JSON.parse(await readFile('apps/extension/dist/manifest.json', 'utf8'));
assertExtensionManifest(manifest, packageManifest.version);

const distFiles = await collect('apps/extension/dist');
if (distFiles.size < 5) throw new Error('Packaged extension output is unexpectedly small.');
// A nil UUID is also part of Zod's UUID validator, so require the other exact
// guid-typescript literals before treating it as evidence of that implementation.
const guidTypescriptImplementationSignatures = [
  'Invalid argument; `value` has no value.',
  'emptyguid',
  '00000000-0000-0000-0000-000000000000',
];
let unpackedBytes = 0;
for (const [name, bytes] of distFiles) {
  unpackedBytes += bytes.byteLength;
  if (/\.(?:map|ts|tsx|pem|key|p12|pfx)$/iu.test(name) || /(?:^|\/)\.env(?:\.|$)/iu.test(name)) {
    throw new Error(`Development or secret-bearing file entered extension output: ${name}`);
  }
  if (isForbiddenNativeExtensionFile(name)) {
    throw new Error(`Native executable entered browser extension output: ${name}`);
  }
  if (name.endsWith('.js')) {
    const text = bytes.toString('utf8');
    if (
      text.includes('guid-typescript/dist/guid.js') ||
      guidTypescriptImplementationSignatures.every((signature) => text.includes(signature))
    ) {
      throw new Error('Extension output includes the blocked guid-typescript implementation without an authentic upstream notice.');
    }
  }
}
if (unpackedBytes > 50 * 1024 * 1024) throw new Error('Unpacked extension exceeds the reviewed 50 MiB release budget.');
for (const name of ['LICENSE.txt', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_LICENSES.txt']) {
  const packaged = distFiles.get(name);
  const reviewed = await readFile(`release/extension-notices/${name}`);
  if (!packaged || sha256(packaged) !== sha256(reviewed)) {
    throw new Error(`Packaged extension is missing the exact reviewed release notice: ${name}`);
  }
}
const runtimeName = `runtime/${basename(modelLibrary.path)}`;
const wasmFiles = [...distFiles.keys()].filter((name) => name.endsWith('.wasm')).sort();
if (JSON.stringify(wasmFiles) !== JSON.stringify([runtimeName])) {
  throw new Error('Packaged extension contains an unreviewed WASM executable.');
}
const packagedRuntime = distFiles.get(runtimeName);
if (!packagedRuntime || packagedRuntime.byteLength !== modelLibrary.bytes || sha256(packagedRuntime) !== modelLibrary.sha256) {
  throw new Error('Packaged extension runtime executable is missing or does not match the reviewed registry.');
}
if (![...distFiles.keys()].some((name) => /(?:^|\/)generation-worker[^/]*\.js$/u.test(name))) {
  throw new Error('Packaged extension generation worker is missing.');
}

const contentScript = distFiles.get('assets/content.js');
if (!contentScript) throw new Error('Production content script is missing.');
const contentText = contentScript.toString('utf8');
if (/(?:^|[;}]\s*)import\s*(?:\(|[\s{*])/mu.test(contentText)) {
  throw new Error('Injected content script depends on module loading and cannot run as a classic executeScript file.');
}

const archiveName = `browser-cortex-extension-v${packageManifest.version}.zip`;
const archivePath = `release/${archiveName}`;
const archiveBytes = await readFile(archivePath);
const expectedHashLine = (await readFile(`${archivePath}.sha256`, 'utf8')).trim();
const actualHash = sha256(archiveBytes);
if (expectedHashLine !== `${actualHash}  ${archiveName}`) throw new Error('Extension archive hash file does not match the actual ZIP.');
const regeneratedZip = new JSZip();
const fixedArchiveDate = new Date('2026-09-21T00:00:00.000Z');
for (const [name, bytes] of [...distFiles.entries()].sort(([left], [right]) => left.localeCompare(right))) {
  regeneratedZip.file(name, bytes, {
    date: fixedArchiveDate,
    createFolders: false,
    unixPermissions: 0o100644,
  });
}
const regeneratedArchive = await regeneratedZip.generateAsync({
  type: 'nodebuffer',
  platform: 'UNIX',
  compression: 'DEFLATE',
  compressionOptions: { level: 9 },
});
if (!archiveBytes.equals(regeneratedArchive)) {
  throw new Error('Extension archive is not the exact deterministic encoding of the provenance-verified dist output.');
}
const zip = await JSZip.loadAsync(archiveBytes, { checkCRC32: true });
const zipFiles = new Map();
for (const [name, entry] of Object.entries(zip.files)) {
  if (
    entry.unsafeOriginalName !== undefined &&
    entry.unsafeOriginalName !== name
  ) {
    throw new Error(`Extension archive contains a sanitized unsafe path: ${entry.unsafeOriginalName}`);
  }
  if (
    name.includes('\\') ||
    name.includes('\0') ||
    name.startsWith('/') ||
    /^[A-Za-z]:/u.test(name) ||
    name.split('/').some((segment) => segment === '.' || segment === '..' || segment.length === 0)
  ) {
    throw new Error(`Extension archive contains an unsafe entry name: ${JSON.stringify(name)}`);
  }
  if (entry.dir) throw new Error(`Extension archive contains an unnecessary directory entry: ${name}`);
  zipFiles.set(name, await entry.async('nodebuffer'));
}
if (JSON.stringify([...zipFiles.keys()].sort()) !== JSON.stringify([...distFiles.keys()].sort())) {
  throw new Error('Extension archive file list does not exactly match production output.');
}
for (const [name, bytes] of distFiles) {
  const archived = zipFiles.get(name);
  if (!archived || sha256(archived) !== sha256(bytes)) throw new Error(`Extension archive content mismatch: ${name}`);
}
const archivedRuntime = zipFiles.get(runtimeName);
if (!archivedRuntime || archivedRuntime.byteLength !== modelLibrary.bytes || sha256(archivedRuntime) !== modelLibrary.sha256) {
  throw new Error('Extension archive contains a missing or corrupt generation executable.');
}

const compatibility = JSON.parse(await readFile('release/compatibility.json', 'utf8'));
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
if (
  compatibility.schemaVersion !== 1 ||
  compatibility.product !== 'BrowserCortex' ||
  compatibility.commit !== head ||
  compatibility.version !== packageManifest.version ||
  compatibility.distribution !== 'developer-unpacked-extension' ||
  compatibility.browserStoreApproved !== false ||
  compatibility.manifestVersion !== manifest.manifest_version ||
  compatibility.extensionVersion !== manifest.version ||
  compatibility.extensionVersionName !== manifest.version_name ||
  compatibility.minimumChromeVersion !== manifest.minimum_chrome_version ||
  compatibility.packagedFileCount !== distFiles.size ||
  compatibility.archive?.filename !== archiveName ||
  compatibility.archive?.sha256 !== actualHash ||
  compatibility.archive?.bytes !== archiveBytes.byteLength ||
  compatibility.buildProvenance?.filename !== BUILD_PROVENANCE_PATH ||
  compatibility.buildProvenance?.sha256 !== buildProvenanceSha256(buildProvenanceBytes) ||
  compatibility.buildProvenance?.sourceTree !== buildProvenance.source.tree ||
  compatibility.buildProvenance?.extensionDigest !== buildProvenance.applications.extension.digest ||
  compatibility.generationModel?.id !== generationModel.runtimeModelId ||
  compatibility.generationModel?.revision !== generationModel.revision ||
  compatibility.generationModel?.modelLibrarySha256 !== modelLibrary.sha256
) {
  throw new Error('Compatibility metadata is missing or does not match the built release and commit.');
}

const sbom = JSON.parse(await readFile('release/sbom.cdx.json', 'utf8'));
const uuidSerial = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const timestamp = sbom.metadata?.timestamp;
const rootPurl = npmPurl(packageManifest.name, packageManifest.version);
const rootComponent = sbom.metadata?.component;
if (
  sbom.bomFormat !== 'CycloneDX' ||
  sbom.specVersion !== '1.6' ||
  !uuidSerial.test(sbom.serialNumber) ||
  !Number.isSafeInteger(sbom.version) ||
  sbom.version < 1 ||
  typeof timestamp !== 'string' ||
  Number.isNaN(Date.parse(timestamp)) ||
  new Date(timestamp).toISOString() !== timestamp ||
  rootComponent?.type !== 'application' ||
  rootComponent?.['bom-ref'] !== rootPurl ||
  rootComponent?.name !== packageManifest.name ||
  rootComponent?.version !== packageManifest.version ||
  rootComponent?.purl !== rootPurl ||
  rootComponent?.licenses?.[0]?.license?.id !== packageManifest.license ||
  !Array.isArray(sbom.metadata?.tools?.components) ||
  sbom.metadata.tools.components.length === 0 ||
  sbom.metadata.tools.components.some(
    (tool) =>
      !tool ||
      typeof tool !== 'object' ||
      tool.type !== 'application' ||
      typeof tool.name !== 'string' ||
      typeof tool.version !== 'string',
  ) ||
  !Array.isArray(sbom.metadata?.properties) ||
  !Array.isArray(sbom.components) ||
  sbom.components.length < 5
) {
  throw new Error('CycloneDX SBOM is missing required release metadata or does not describe the production build.');
}

const lockfile = await readFile('pnpm-lock.yaml', 'utf8');
const lockHash = sha256(lockfile);
const lockProperties = (sbom.metadata.properties ?? []).filter(
  (property) => property?.name === 'browser-cortex:pnpm-lock-sha256',
);
if (lockProperties.length !== 1 || lockProperties[0].value !== lockHash) {
  throw new Error('CycloneDX SBOM is not bound to the current pnpm lockfile.');
}
const lockedCoordinates = parseLockedNpmCoordinates(lockfile);
const optionalLockedCoordinates = parseOptionalLockedNpmCoordinates(lockfile);
const expectedComponents = collectProductionComponents(
  listInstalledProductionProjects(),
  lockedCoordinates,
  optionalLockedCoordinates,
);
const modelLibraryReference = `urn:browser-cortex:model-library:sha256:${modelLibrary.sha256}`;
const expectedModelComponent = {
  type: 'file',
  'bom-ref': modelLibraryReference,
  name: basename(modelLibrary.path),
  version: modelLibrary.upstreamRevision,
  scope: 'required',
  hashes: [{ alg: 'SHA-256', content: modelLibrary.sha256 }],
  licenses: [{ license: { id: modelLibrary.license.identifier } }],
  externalReferences: [
    {
      type: 'distribution',
      url: `https://github.com/mlc-ai/binary-mlc-llm-libs/raw/${modelLibrary.upstreamRevision}/web-llm-models/v0_2_84/base/${basename(modelLibrary.path)}`,
    },
    { type: 'build-meta', url: modelLibrary.license.buildProvenance },
    ...modelLibrary.license.sources.flatMap((source) => [
      { type: 'license', url: source.license },
      { type: 'other', url: source.notice },
    ]),
    { type: 'model-card', url: generationModel.license.source },
  ],
  properties: [
    { name: 'browser-cortex:bytes', value: String(modelLibrary.bytes) },
    { name: 'browser-cortex:source-repository', value: 'https://github.com/mlc-ai/binary-mlc-llm-libs' },
    { name: 'browser-cortex:upstream-revision', value: modelLibrary.upstreamRevision },
    ...modelLibrary.license.sources.flatMap((source, index) => [
      { name: `browser-cortex:compiler-source-${index}-repository`, value: source.repository },
      { name: `browser-cortex:compiler-source-${index}-revision`, value: source.revision },
    ]),
    { name: 'browser-cortex:model-license-source', value: generationModel.license.source },
  ],
};
expectedComponents.push(expectedModelComponent);
expectedComponents.sort((left, right) => left['bom-ref'].localeCompare(right['bom-ref']));
if (expectedComponents.length !== sbom.components.length) {
  throw new Error('CycloneDX SBOM does not contain the complete installed production dependency inventory.');
}
const expectedByReference = new Map(
  expectedComponents.map((component) => [component['bom-ref'], component]),
);
const references = new Set([rootComponent['bom-ref']]);
for (const component of sbom.components) {
  if (!component || typeof component !== 'object' || Array.isArray(component)) {
    throw new Error('CycloneDX SBOM contains a malformed component.');
  }
  if (component['bom-ref'] === modelLibraryReference) {
    if (JSON.stringify(component) !== JSON.stringify(expectedModelComponent)) {
      throw new Error('CycloneDX SBOM executable model-library component is incomplete or stale.');
    }
    if (references.has(component['bom-ref'])) {
      throw new Error(`CycloneDX SBOM contains a duplicate component reference: ${component['bom-ref']}`);
    }
    references.add(component['bom-ref']);
    continue;
  }
  const expectedPurl = npmPurl(component.name, component.version);
  if (
    component.type !== 'library' ||
    component.purl !== expectedPurl ||
    component['bom-ref'] !== expectedPurl ||
    !['required', 'optional'].includes(component.scope) ||
    !Array.isArray(component.licenses) ||
    component.licenses.length !== 1 ||
    typeof component.licenses[0]?.expression !== 'string'
  ) {
    throw new Error(`CycloneDX SBOM contains invalid npm component metadata: ${String(component.name)}`);
  }
  if (references.has(component['bom-ref'])) {
    throw new Error(`CycloneDX SBOM contains a duplicate component reference: ${component['bom-ref']}`);
  }
  references.add(component['bom-ref']);
  if (!lockedCoordinates.has(`${component.name}@${component.version}`)) {
    throw new Error(`CycloneDX SBOM component is absent from pnpm-lock.yaml: ${component.name}@${component.version}`);
  }
  const expected = expectedByReference.get(component['bom-ref']);
  if (!expected || JSON.stringify(expected) !== JSON.stringify(component)) {
    throw new Error(`CycloneDX SBOM component is not an installed production dependency: ${component['bom-ref']}`);
  }
}
if (
  JSON.stringify(sbom.components.map((component) => component['bom-ref'])) !==
  JSON.stringify(expectedComponents.map((component) => component['bom-ref']))
) {
  throw new Error('CycloneDX SBOM components are not in canonical lockfile-reconciled order.');
}

const archiveInfo = await stat(archivePath);
console.log(`Release boundary verification passed for ${distFiles.size} files, ${archiveInfo.size} archive bytes, and ${sbom.components.length} SBOM components.`);
