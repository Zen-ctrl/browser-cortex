import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import ts from 'typescript';

import { parseLockedNpmCoordinates } from './lib/sbom.mjs';

const registry = JSON.parse(await readFile('models/registry.json', 'utf8'));
const lockfile = await readFile('pnpm-lock.yaml', 'utf8');
const lockedCoordinates = parseLockedNpmCoordinates(lockfile);
const shaPattern = /^[a-f0-9]{64}$/u;
const revisionPattern = /^[a-f0-9]{40}$/u;
const safeRelativePath = /^(?![A-Za-z]:)(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/u;
const runtimePackages = new Map([
  ['@browser-cortex/runtime-transformers', 'packages/runtime-transformers/package.json'],
  ['@browser-cortex/runtime-webllm', 'packages/runtime-webllm/package.json'],
]);

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function lockedPackageIntegrity(coordinate) {
  const lines = lockfile.split(/\r?\n/u);
  const packageLine = `  ${coordinate}:`;
  const start = lines.indexOf(packageLine);
  if (start < 0) throw new Error(`${coordinate} is absent from the lockfile package inventory.`);
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^ {2}\S/u.test(line)) break;
    const match = /^ {4}resolution: \{integrity: ([^}]+)\}\s*$/u.exec(line);
    if (match) return match[1];
  }
  throw new Error(`${coordinate} has no lockfile integrity value.`);
}

function propertyName(node, sourceFile) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  throw new Error(`Unsupported computed model metadata key in ${sourceFile.fileName}.`);
}

function literalValue(node, sourceFile) {
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) {
    return literalValue(node.expression, sourceFile);
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text.replaceAll('_', ''));
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map((item) => literalValue(item, sourceFile));
  if (ts.isObjectLiteralExpression(node)) {
    const value = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) throw new Error(`Unsupported model metadata syntax in ${sourceFile.fileName}.`);
      value[propertyName(property.name, sourceFile)] = literalValue(property.initializer, sourceFile);
    }
    return value;
  }
  throw new Error(`Model metadata in ${sourceFile.fileName} must contain literals only.`);
}

async function exportedObject(path, name) {
  const text = await readFile(path, 'utf8');
  const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) {
        return literalValue(declaration.initializer, sourceFile);
      }
    }
  }
  throw new Error(`Missing ${name} in ${path}.`);
}

if (registry.schemaVersion !== 1 || !Array.isArray(registry.models) || registry.models.length < 2) {
  throw new Error('Model registry must contain generation and embedding candidates.');
}

const defaults = object(registry.defaults, 'Model defaults');
const ids = new Set();
const tasks = new Set();

for (const model of registry.models) {
  const id = nonEmptyString(model.id, 'Model ID');
  if (ids.has(id)) throw new Error(`Duplicate model ID ${id}.`);
  ids.add(id);
  nonEmptyString(model.displayName, `${id} display name`);
  nonEmptyString(model.upstreamOwner, `${id} upstream owner`);
  nonEmptyString(model.sourceModel, `${id} source model`);
  const revision = nonEmptyString(model.revision, `${id} revision`);
  if (!revisionPattern.test(revision)) throw new Error(`${id} revision is not an immutable commit SHA.`);
  if (model.sourceRevision !== undefined && !revisionPattern.test(nonEmptyString(model.sourceRevision, `${id} source revision`))) {
    throw new Error(`${id} source revision is not an immutable commit SHA.`);
  }
  if (!Array.isArray(model.taskCapabilities) || model.taskCapabilities.length === 0 || model.taskCapabilities.some((item) => typeof item !== 'string')) {
    throw new Error(`${id} task capabilities are invalid.`);
  }
  for (const capability of model.taskCapabilities) tasks.add(capability);
  if (model.taskCapabilities.includes('generation')) {
    nonEmptyString(model.runtimeModelId, `${id} runtime model ID`);
    nonEmptyString(model.conversionRepository, `${id} conversion repository`);
  }

  const license = object(model.license, `${id} license`);
  nonEmptyString(license.identifier, `${id} license identifier`);
  const licenseSource = nonEmptyString(license.source, `${id} license source`);
  if (!licenseSource.startsWith('https://')) throw new Error(`${id} license source must be HTTPS.`);

  const runtime = object(model.runtime, `${id} runtime`);
  const adapter = nonEmptyString(runtime.adapter, `${id} runtime adapter`);
  const runtimePackage = nonEmptyString(runtime.package, `${id} runtime package`);
  const runtimeVersion = nonEmptyString(runtime.version, `${id} runtime version`);
  if (!Array.isArray(runtime.executionModes) || runtime.executionModes.length === 0) throw new Error(`${id} execution modes are missing.`);
  const adapterManifestPath = runtimePackages.get(adapter);
  if (!adapterManifestPath) throw new Error(`${id} uses an unreviewed runtime adapter.`);
  const adapterManifest = object(JSON.parse(await readFile(adapterManifestPath, 'utf8')), `${id} adapter manifest`);
  const adapterDependencies = object(adapterManifest.dependencies, `${id} adapter dependencies`);
  if (adapterManifest.name !== adapter || adapterDependencies[runtimePackage] !== runtimeVersion) {
    throw new Error(`${id} runtime metadata does not match its workspace adapter dependency.`);
  }

  if (!Array.isArray(model.artifacts) || model.artifacts.length === 0) throw new Error(`${id} artifacts must be a non-empty array.`);
  let weightShardBytes = 0;
  const weightShardOrdinals = new Set();
  for (const [index, artifact] of model.artifacts.entries()) {
    const label = `${id} artifact ${index}`;
    nonEmptyString(artifact.kind, `${label} kind`);
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1) throw new Error(`${label} byte count is invalid.`);
    if (typeof artifact.sha256 !== 'string' || !shaPattern.test(artifact.sha256)) throw new Error(`${label} SHA-256 is invalid.`);
    const path = nonEmptyString(artifact.path, `${label} path`);
    if (!safeRelativePath.test(path)) throw new Error(`${label} path is not a safe relative path.`);
    const packagedDependency = artifact.packagedDependency === true;
    if (artifact.url !== undefined) {
      const url = new URL(nonEmptyString(artifact.url, `${label} URL`));
      if (url.protocol !== 'https:' || !url.pathname.includes(revision)) throw new Error(`${label} URL is not pinned to the model revision.`);
    } else if (artifact.local !== true && !packagedDependency && typeof model.conversionRepository !== 'string') {
      throw new Error(`${label} has no pinned remote repository context.`);
    }
    if (typeof artifact.executable !== 'boolean') throw new Error(`${label} executable classification is missing.`);
    if (artifact.executable && artifact.local !== true && !packagedDependency) {
      throw new Error(`${label} executable code must be vendored or supplied by a reviewed locked dependency.`);
    }
    if (packagedDependency) {
      if (!artifact.executable || artifact.local !== false || artifact.kind !== 'runtime-executable') {
        throw new Error(`${label} packaged dependency classification is invalid.`);
      }
      const packageName = nonEmptyString(artifact.package, `${label} package`);
      const packageVersion = nonEmptyString(artifact.packageVersion, `${label} package version`);
      const coordinate = `${packageName}@${packageVersion}`;
      if (!lockedCoordinates.has(coordinate)) throw new Error(`${label} package is not pinned in pnpm-lock.yaml.`);
      const integrity = nonEmptyString(artifact.packageIntegrity, `${label} package integrity`);
      if (!integrity.startsWith('sha512-') || lockedPackageIntegrity(coordinate) !== integrity) {
        throw new Error(`${label} package integrity does not match pnpm-lock.yaml.`);
      }
      if (!/^[A-Za-z0-9._-]+$/u.test(nonEmptyString(artifact.outputName, `${label} output name`))) {
        throw new Error(`${label} output name is invalid.`);
      }
    }
    if (artifact.executable) {
      const artifactLicense = object(artifact.license, `${label} license`);
      nonEmptyString(artifactLicense.identifier, `${label} license identifier`);
      const buildProvenance = nonEmptyString(artifactLicense.buildProvenance, `${label} license build provenance`);
      if (!buildProvenance.startsWith('https://')) throw new Error(`${label} license build provenance must use HTTPS.`);
      if (!Array.isArray(artifactLicense.sources) || artifactLicense.sources.length < 1) {
        throw new Error(`${label} executable license must identify every reviewed compiler source.`);
      }
      for (const [sourceIndex, sourceValue] of artifactLicense.sources.entries()) {
        const source = object(sourceValue, `${label} license source ${sourceIndex}`);
        for (const key of ['repository', 'license', 'notice']) {
          if (!nonEmptyString(source[key], `${label} license source ${sourceIndex} ${key}`).startsWith('https://')) {
            throw new Error(`${label} license source ${sourceIndex} ${key} must use HTTPS.`);
          }
        }
        if (!revisionPattern.test(nonEmptyString(source.revision, `${label} license source ${sourceIndex} revision`))) {
          throw new Error(`${label} license source ${sourceIndex} revision is not an immutable commit SHA.`);
        }
      }
      nonEmptyString(artifactLicense.basis, `${label} license basis`);
    }
    if (artifact.kind === 'weight-shard') {
      if (!Number.isSafeInteger(artifact.ordinal) || artifact.ordinal < 0 || weightShardOrdinals.has(artifact.ordinal)) {
        throw new Error(`${label} shard ordinal is invalid or duplicated.`);
      }
      weightShardOrdinals.add(artifact.ordinal);
      weightShardBytes += artifact.bytes;
    }
    if (artifact.sri !== undefined) {
      const expectedSri = `sha256-${Buffer.from(artifact.sha256, 'hex').toString('base64')}`;
      if (artifact.sri !== expectedSri) throw new Error(`${label} SRI does not match its SHA-256.`);
    }
    if (artifact.upstreamRevision !== undefined && !revisionPattern.test(nonEmptyString(artifact.upstreamRevision, `${label} upstream revision`))) {
      throw new Error(`${label} upstream revision is not an immutable commit SHA.`);
    }
    if (artifact.local === true) {
      const bytes = await readFile(path);
      if (bytes.byteLength !== artifact.bytes) throw new Error(`${label} vendored byte count does not match.`);
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== artifact.sha256) throw new Error(`${label} vendored SHA-256 does not match.`);
    }
  }
  if (weightShardOrdinals.size > 0) {
    if (model.weightBytes !== weightShardBytes || [...weightShardOrdinals].some((ordinal) => ordinal >= weightShardOrdinals.size)) {
      throw new Error(`${id} aggregate weight bytes or shard ordinals do not match its artifacts.`);
    }
  }

  if (!Array.isArray(model.knownLimitations) || model.knownLimitations.length === 0) throw new Error(`${id} known limitations are missing.`);
}

for (const task of ['embedding', 'generation']) {
  const defaultId = defaults[task];
  if (defaultId !== null && typeof defaultId !== 'string') throw new Error(`${task} default must be a model ID or null.`);
  if (typeof defaultId === 'string') {
    const model = registry.models.find((candidate) => candidate.id === defaultId);
    if (!model || !model.taskCapabilities.includes(task)) throw new Error(`${task} default does not resolve to a matching model.`);
    if (model.installation?.integrityEnforced !== true) {
      throw new Error(`${task} default cannot be enabled until runtime installation enforces every artifact hash.`);
    }
  }
}

if (!tasks.has('embedding') || !tasks.has('generation')) {
  throw new Error('Registry must include both embedding and generation candidates.');
}

const embedding = registry.models.find((model) => model.taskCapabilities.includes('embedding'));
const generation = registry.models.find((model) => model.taskCapabilities.includes('generation'));
const embeddingArtifact = embedding?.artifacts.find((artifact) => artifact.kind === 'model-data');
const modelLibrary = generation?.artifacts.find((artifact) => artifact.kind === 'executable-model-library');
if (!embedding || !embeddingArtifact || !generation || !modelLibrary) throw new Error('Reviewed runtime model artifacts are missing.');
nonEmptyString(generation.runtimeModelId, 'Generation runtime model ID');
const expectedEmbedding = {
  modelId: embedding.sourceModel,
  revision: embedding.revision,
  license: embedding.license.identifier,
  quantizedOnnx: { bytes: embeddingArtifact.bytes, sha256: embeddingArtifact.sha256 },
};
const modelLibraryFilename = basename(modelLibrary.path);
const expectedGeneration = {
  modelId: generation.runtimeModelId,
  modelRepository: generation.conversionRepository,
  modelRevision: generation.revision,
  sourceModel: generation.sourceModel,
  sourceRevision: generation.sourceRevision,
  license: generation.license.identifier,
  weightBytes: generation.weightBytes,
  modelLibrary: {
    filename: modelLibraryFilename,
    packagedPath: `/runtime/${modelLibraryFilename}`,
    upstreamRevision: modelLibrary.upstreamRevision,
    webLlmConfigVersion: generation.runtime.prebuiltConfigVersion,
    bytes: modelLibrary.bytes,
    sha256: modelLibrary.sha256,
    sri: modelLibrary.sri,
  },
};
const runtimeEmbedding = await exportedObject('packages/runtime-transformers/src/index.ts', 'VERIFIED_MINILM_MODEL');
const runtimeGeneration = await exportedObject('packages/runtime-webllm/src/index.ts', 'VERIFIED_SMOLLM2_MODEL');
if (JSON.stringify(runtimeEmbedding) !== JSON.stringify(expectedEmbedding)) {
  throw new Error('Embedding runtime constants drifted from the reviewed model registry.');
}
if (JSON.stringify(runtimeGeneration) !== JSON.stringify(expectedGeneration)) {
  throw new Error('Generation runtime constants drifted from the reviewed model registry.');
}

console.log(`Verified ${registry.models.length} model registry candidates, runtime constants, and vendored executable integrity.`);
