import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import JSZip from 'jszip';

import {
  BUILD_PROVENANCE_PATH,
  buildProvenanceSha256,
  verifyBuildProvenance,
} from './lib/build-provenance.mjs';
import { assertExtensionManifest } from './lib/extension-manifest.mjs';

const source = 'apps/extension/dist';
const packageManifest = JSON.parse(await readFile('package.json', 'utf8'));
const extensionPackageManifest = JSON.parse(await readFile('apps/extension/package.json', 'utf8'));
const buildProvenanceBytes = await readFile(BUILD_PROVENANCE_PATH).catch(() => {
  throw new Error('Build provenance is missing. Run pnpm build before packaging.');
});
const buildProvenance = JSON.parse(buildProvenanceBytes.toString('utf8'));
await verifyBuildProvenance(buildProvenance);
const modelRegistry = JSON.parse(await readFile('models/registry.json', 'utf8'));
const generationModel = modelRegistry.models?.find((model) => model.taskCapabilities?.includes('generation'));
const modelLibrary = generationModel?.artifacts?.find((artifact) => artifact.kind === 'executable-model-library');
if (
  typeof generationModel?.runtimeModelId !== 'string' ||
  typeof generationModel.revision !== 'string' ||
  typeof modelLibrary?.sha256 !== 'string'
) {
  throw new Error('The reviewed generation model metadata is incomplete.');
}
if (typeof packageManifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(packageManifest.version)) {
  throw new Error('The package version is not safe for a release filename.');
}
if (extensionPackageManifest.version !== packageManifest.version) {
  throw new Error('The extension package version differs from the root release version.');
}
const destination = `release/browser-cortex-extension-v${packageManifest.version}.zip`;
const fixedDate = new Date('2026-09-21T00:00:00.000Z');
const zip = new JSZip();
const packagedFiles = [];

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile()) {
      const name = relative(source, path).replaceAll('\\', '/');
      packagedFiles.push(name);
      zip.file(name, await readFile(path), {
        date: fixedDate,
        createFolders: false,
        unixPermissions: 0o100644,
      });
    } else {
      throw new Error(`Extension output contains an unsupported filesystem entry: ${path}`);
    }
  }
}

await collect(source);
await mkdir('release', { recursive: true });
const bytes = await zip.generateAsync({
  type: 'nodebuffer',
  platform: 'UNIX',
  compression: 'DEFLATE',
  compressionOptions: { level: 9 },
});
await writeFile(destination, bytes);
const sha256 = createHash('sha256').update(bytes).digest('hex');
await writeFile(`${destination}.sha256`, `${sha256}  ${destination.split('/').at(-1)}\n`, 'utf8');
const extensionManifest = JSON.parse(await readFile(`${source}/manifest.json`, 'utf8'));
assertExtensionManifest(extensionManifest, packageManifest.version);
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
let realModelEvidence = null;
try {
  const reportBytes = await readFile('benchmarks/reports/real-model/latest.json');
  const report = JSON.parse(reportBytes.toString('utf8'));
  if (
    report.schemaVersion === 3 &&
    report.status === 'passed' &&
    report.runner?.sourceCommit === commit &&
    report.evidence?.scope === 'adapter-runtime' &&
    typeof report.evidence?.invocationId === 'string' &&
    report.evidence?.archive?.filename === destination.split('/').at(-1) &&
    report.evidence?.archive?.bytes === bytes.byteLength &&
    report.evidence?.archive?.sha256 === sha256 &&
    report.evidence?.buildProvenance?.filename === BUILD_PROVENANCE_PATH &&
    report.evidence?.buildProvenance?.sha256 === buildProvenanceSha256(buildProvenanceBytes) &&
    report.evidence?.buildProvenance?.sourceTree === buildProvenance.source.tree &&
    report.evidence?.buildProvenance?.extensionDigest === buildProvenance.applications.extension.digest
  ) {
    realModelEvidence = {
      filename: 'benchmarks/reports/real-model/latest.json',
      reportSchemaVersion: report.schemaVersion,
      sha256: createHash('sha256').update(reportBytes).digest('hex'),
      sourceCommit: commit,
      observedAt: report.observedAt,
      scope: report.evidence.scope,
      invocationId: report.evidence.invocationId,
      archiveSha256: report.evidence.archive.sha256,
      buildProvenanceSha256: report.evidence.buildProvenance.sha256,
      extensionDigest: report.evidence.buildProvenance.extensionDigest,
    };
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
const compatibility = {
  schemaVersion: 1,
  product: 'BrowserCortex',
  version: packageManifest.version,
  commit,
  distribution: 'developer-unpacked-extension',
  browserStoreApproved: false,
  manifestVersion: extensionManifest.manifest_version,
  extensionVersion: extensionManifest.version,
  extensionVersionName: extensionManifest.version_name,
  minimumChromeVersion: extensionManifest.minimum_chrome_version,
  packagedFileCount: packagedFiles.length,
  archive: {
    filename: destination.split('/').at(-1),
    bytes: bytes.byteLength,
    sha256,
  },
  buildProvenance: {
    filename: BUILD_PROVENANCE_PATH,
    sha256: buildProvenanceSha256(buildProvenanceBytes),
    sourceTree: buildProvenance.source.tree,
    extensionDigest: buildProvenance.applications.extension.digest,
  },
  generationModel: {
    id: generationModel.runtimeModelId,
    revision: generationModel.revision,
    modelLibrarySha256: modelLibrary.sha256,
  },
  realModelEvidence,
};
await writeFile('release/compatibility.json', `${JSON.stringify(compatibility, null, 2)}\n`, 'utf8');
console.log(`${destination} ${bytes.byteLength} bytes sha256:${sha256}`);
