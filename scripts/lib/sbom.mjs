import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

const NPM_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const NPM_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/u;

function decodeLockKey(rawKey) {
  if (rawKey.startsWith("'") && rawKey.endsWith("'")) {
    return rawKey.slice(1, -1).replaceAll("''", "'");
  }
  if (rawKey.startsWith('"') && rawKey.endsWith('"')) {
    try {
      return JSON.parse(rawKey);
    } catch (error) {
      throw new Error(`pnpm-lock.yaml contains an invalid quoted package key: ${rawKey}`, {
        cause: error,
      });
    }
  }
  return rawKey;
}

function splitLockPackageKey(key) {
  const slash = key.startsWith('@') ? key.indexOf('/') : -1;
  const separator = slash === -1 ? key.indexOf('@') : key.indexOf('@', slash + 1);
  if (separator <= 0 || separator === key.length - 1) return undefined;
  const name = key.slice(0, separator);
  const versionWithContext = key.slice(separator + 1);
  const contextStart = versionWithContext.indexOf('(');
  const version = contextStart === -1 ? versionWithContext : versionWithContext.slice(0, contextStart);
  if (!isNpmPackageName(name) || !isNpmPackageVersion(version)) return undefined;
  return { name, version };
}

function isWorkspaceReference(version) {
  return version.startsWith('link:') || version.startsWith('workspace:');
}

function installedLicense(name, version, value, allowMissing) {
  if (typeof value.path !== 'string' || value.path.length === 0) {
    throw new Error(`pnpm did not report an installed path for ${name}@${version}.`);
  }
  let packageDirectory;
  try {
    packageDirectory = realpathSync(value.path);
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return undefined;
    throw new Error(`Installed production package path cannot be resolved: ${name}@${version}.`, {
      cause: error,
    });
  }
  const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'));
  if (manifest.name !== name || manifest.version !== version) {
    throw new Error(`Installed package metadata does not match pnpm inventory for ${name}@${version}.`);
  }
  const license = manifest.license;
  if (
    typeof license !== 'string' ||
    license.length < 1 ||
    license.length > 256 ||
    /^(?:UNLICENSED|SEE LICENSE IN)/iu.test(license)
  ) {
    throw new Error(`Installed production package has no usable declared license: ${name}@${version}.`);
  }
  return { expression: license, packageDirectory };
}

export function isNpmPackageName(value) {
  return typeof value === 'string' && NPM_NAME_PATTERN.test(value);
}

export function isNpmPackageVersion(value) {
  return (
    typeof value === 'string' &&
    !/^(?:unknown|null|undefined)$/iu.test(value) &&
    !isWorkspaceReference(value) &&
    NPM_VERSION_PATTERN.test(value)
  );
}

function encodePurlPart(value) {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) =>
    `%${character.codePointAt(0).toString(16).toUpperCase()}`,
  );
}

export function npmPurl(name, version) {
  if (!isNpmPackageName(name)) throw new Error(`Invalid npm package name: ${String(name)}`);
  if (!isNpmPackageVersion(version)) {
    throw new Error(`Invalid or unknown npm package version for ${name}: ${String(version)}`);
  }
  if (name.startsWith('@')) {
    const slash = name.indexOf('/');
    return `pkg:npm/${encodePurlPart(name.slice(0, slash))}/${encodePurlPart(name.slice(slash + 1))}@${encodePurlPart(version)}`;
  }
  return `pkg:npm/${encodePurlPart(name)}@${encodePurlPart(version)}`;
}

export function parseLockedNpmCoordinates(lockfile) {
  if (typeof lockfile !== 'string') throw new Error('pnpm-lock.yaml content must be text.');
  const coordinates = new Set();
  let inPackages = false;
  let foundPackages = false;

  for (const line of lockfile.split(/\r?\n/u)) {
    if (!inPackages) {
      if (/^packages:\s*$/u.test(line)) {
        inPackages = true;
        foundPackages = true;
      }
      continue;
    }
    if (/^[^\s#]/u.test(line)) break;
    const match = /^ {2}(\S.*):\s*$/u.exec(line);
    if (!match) continue;
    const coordinate = splitLockPackageKey(decodeLockKey(match[1]));
    if (coordinate) coordinates.add(`${coordinate.name}@${coordinate.version}`);
  }

  if (!foundPackages || coordinates.size === 0) {
    throw new Error('pnpm-lock.yaml has no readable packages inventory.');
  }
  return coordinates;
}

export function parseOptionalLockedNpmCoordinates(lockfile) {
  if (typeof lockfile !== 'string') throw new Error('pnpm-lock.yaml content must be text.');
  const optionalByCoordinate = new Map();
  let inSnapshots = false;
  let foundSnapshots = false;
  let current;

  function finishCurrent() {
    const completed = current;
    current = undefined;
    if (!completed?.coordinate) return;
    const existing = optionalByCoordinate.get(completed.coordinate);
    optionalByCoordinate.set(
      completed.coordinate,
      existing === undefined ? completed.optional : existing && completed.optional,
    );
  }

  for (const line of lockfile.split(/\r?\n/u)) {
    if (!inSnapshots) {
      if (/^snapshots:\s*$/u.test(line)) {
        inSnapshots = true;
        foundSnapshots = true;
      }
      continue;
    }
    if (/^[^\s#]/u.test(line)) {
      finishCurrent();
      break;
    }
    const entry = /^ {2}(\S.*?):(?:\s+\{\})?\s*$/u.exec(line);
    if (entry) {
      finishCurrent();
      const coordinate = splitLockPackageKey(decodeLockKey(entry[1]));
      current = {
        coordinate: coordinate ? `${coordinate.name}@${coordinate.version}` : undefined,
        optional: false,
      };
      continue;
    }
    if (current && /^ {4}optional:\s+true\s*$/u.test(line)) current.optional = true;
  }
  if (inSnapshots) finishCurrent();

  if (!foundSnapshots) throw new Error('pnpm-lock.yaml has no readable snapshots inventory.');
  return new Set(
    [...optionalByCoordinate]
      .filter(([, optional]) => optional)
      .map(([coordinate]) => coordinate),
  );
}

export function listInstalledProductionProjects() {
  const raw = execFileSync(
    'pnpm',
    ['list', '--recursive', '--json', '--depth', 'Infinity', '--prod'],
    {
      encoding: 'utf8',
      windowsHide: true,
      shell: process.platform === 'win32',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const projects = JSON.parse(raw);
  if (!Array.isArray(projects)) throw new Error('pnpm production dependency inventory is not an array.');
  return projects;
}

export function collectProductionComponents(projects, lockedCoordinates, optionalLockedCoordinates) {
  if (!Array.isArray(projects)) throw new Error('Production project inventory must be an array.');
  if (!(lockedCoordinates instanceof Set)) throw new Error('Locked dependency inventory must be a Set.');
  if (!(optionalLockedCoordinates instanceof Set)) {
    throw new Error('Optional locked dependency inventory must be a Set.');
  }
  const components = new Map();
  const workspaceNames = new Set();
  let visits = 0;

  for (const project of projects) {
    if (!project || typeof project !== 'object' || Array.isArray(project)) {
      throw new Error('pnpm returned a malformed production project entry.');
    }
    if (typeof project.name !== 'string' || !isNpmPackageName(project.name)) {
      throw new Error(`pnpm returned a production project with an invalid package name: ${String(project.name)}`);
    }
    workspaceNames.add(project.name);
  }

  function addDependency(name, value, scope = 'required') {
    visits += 1;
    if (visits > 250_000) throw new Error('Production dependency inventory exceeds the reviewed traversal bound.');
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`pnpm returned malformed dependency metadata for ${name}.`);
    }
    const version = value.version;
    if (typeof version !== 'string' || version.length === 0) {
      throw new Error(`pnpm returned an unknown dependency version for ${name}.`);
    }

    if (isWorkspaceReference(version)) {
      if (!workspaceNames.has(name)) {
        throw new Error(`pnpm returned a non-workspace dependency with an unversioned link: ${name}`);
      }
    } else {
      const purl = npmPurl(name, version);
      const coordinate = `${name}@${version}`;
      if (!lockedCoordinates.has(coordinate)) {
        throw new Error(`Production dependency is not reconciled with pnpm-lock.yaml: ${coordinate}`);
      }
      const optionalOnly = optionalLockedCoordinates.has(coordinate);
      const license = installedLicense(name, version, value, optionalOnly);
      // pnpm can inventory platform-specific optional packages using synthetic
      // paths even when they were not installed on the current host. They are
      // not production components here, and their children are not traversed.
      if (!license) return;
      const effectiveScope = optionalOnly ? 'optional' : scope;
      const existing = components.get(purl);
      if (!existing) {
        components.set(purl, {
          type: 'library',
          'bom-ref': purl,
          name,
          version,
          scope: effectiveScope,
          purl,
          licenses: [{ expression: license.expression }],
        });
      } else if (existing.licenses?.[0]?.expression !== license.expression) {
        throw new Error(`Installed production package license metadata is inconsistent: ${coordinate}`);
      } else if (existing.scope === 'optional' && effectiveScope === 'required') {
        existing.scope = 'required';
      }
    }

    for (const [childName, child] of Object.entries(value.dependencies ?? {})) {
      addDependency(childName, child, scope);
    }
    for (const [childName, child] of Object.entries(value.optionalDependencies ?? {})) {
      addDependency(childName, child, 'optional');
    }
  }

  for (const project of projects) {
    for (const [name, dependency] of Object.entries(project.dependencies ?? {})) {
      addDependency(name, dependency);
    }
    for (const [name, dependency] of Object.entries(project.optionalDependencies ?? {})) {
      addDependency(name, dependency, 'optional');
    }
  }

  return [...components.values()].sort((left, right) => left['bom-ref'].localeCompare(right['bom-ref']));
}
