import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  collectProductionComponents,
  listInstalledProductionProjects,
  npmPurl,
  parseLockedNpmCoordinates,
  parseOptionalLockedNpmCoordinates,
} from './lib/sbom.mjs';

const packageManifest = JSON.parse(await readFile('package.json', 'utf8'));
const lockfile = await readFile('pnpm-lock.yaml', 'utf8');
const lockedCoordinates = parseLockedNpmCoordinates(lockfile);
const optionalLockedCoordinates = parseOptionalLockedNpmCoordinates(lockfile);
const components = collectProductionComponents(
  listInstalledProductionProjects(),
  lockedCoordinates,
  optionalLockedCoordinates,
);
const registry = JSON.parse(await readFile('models/registry.json', 'utf8'));
const generationModel = registry.models?.find((model) => model.taskCapabilities?.includes('generation'));
const modelLibrary = generationModel?.artifacts?.find((artifact) => artifact.kind === 'executable-model-library');
if (
  typeof generationModel?.license?.identifier !== 'string' ||
  typeof modelLibrary?.path !== 'string' ||
  typeof modelLibrary?.upstreamRevision !== 'string' ||
  typeof modelLibrary?.license?.identifier !== 'string' ||
  typeof modelLibrary.license.buildProvenance !== 'string' ||
  !Array.isArray(modelLibrary.license.sources) ||
  modelLibrary.license.sources.length < 2 ||
  modelLibrary.license.sources.some((source) =>
    typeof source?.repository !== 'string' ||
    typeof source.revision !== 'string' ||
    typeof source.license !== 'string' ||
    typeof source.notice !== 'string'
  ) ||
  typeof modelLibrary?.sha256 !== 'string' ||
  !Number.isSafeInteger(modelLibrary?.bytes)
) {
  throw new Error('The model registry does not contain complete executable provenance for the SBOM.');
}
const modelLibraryReference = `urn:browser-cortex:model-library:sha256:${modelLibrary.sha256}`;
components.push({
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
});
components.sort((left, right) => left['bom-ref'].localeCompare(right['bom-ref']));
const rootPurl = npmPurl(packageManifest.name, packageManifest.version);
if (typeof packageManifest.license !== 'string' || packageManifest.license.length === 0) {
  throw new Error('The root package must declare a license before generating an SBOM.');
}

const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: {
      type: 'application',
      'bom-ref': rootPurl,
      name: packageManifest.name,
      version: packageManifest.version,
      licenses: [{ license: { id: packageManifest.license } }],
      purl: rootPurl,
    },
    tools: { components: [{ type: 'application', name: 'BrowserCortex SBOM generator', version: '1' }] },
    properties: [
      {
        name: 'browser-cortex:pnpm-lock-sha256',
        value: createHash('sha256').update(lockfile).digest('hex'),
      },
    ],
  },
  components,
};

await mkdir('release', { recursive: true });
await writeFile('release/sbom.cdx.json', `${JSON.stringify(sbom, null, 2)}\n`, 'utf8');
console.log(`Generated CycloneDX 1.6 SBOM with ${sbom.components.length} production components.`);
