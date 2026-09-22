import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  collectProductionComponents,
  parseOptionalLockedNpmCoordinates,
} from '../../scripts/lib/sbom.mjs';

const temporaryDirectories: string[] = [];

function temporaryPackage(name: string, version: string, license: string) {
  const directory = mkdtempSync(join(tmpdir(), 'browser-cortex-sbom-'));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version, license }));
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('production SBOM inventory', () => {
  it('only classifies a coordinate as optional when every lock snapshot is optional', () => {
    const optional = parseOptionalLockedNpmCoordinates(`
lockfileVersion: '9.0'
snapshots:
  platform-only@1.0.0(peer@1.0.0):
    optional: true
  platform-only@1.0.0(peer@2.0.0):
    optional: true
  mixed@2.0.0(peer@1.0.0):
    optional: true
  mixed@2.0.0(peer@2.0.0): {}
`);

    expect(optional).toEqual(new Set(['platform-only@1.0.0']));
  });

  it('skips an absent lock-optional package without traversing its synthetic children', () => {
    const projects = [
      {
        name: 'test-workspace',
        dependencies: {
          'platform-only': {
            version: '1.0.0',
            path: join(tmpdir(), 'browser-cortex-missing-platform-package'),
            dependencies: {
              'synthetic-child': { version: '2.0.0' },
            },
          },
        },
      },
    ];

    expect(
      collectProductionComponents(
        projects,
        new Set(['platform-only@1.0.0', 'synthetic-child@2.0.0']),
        new Set(['platform-only@1.0.0']),
      ),
    ).toEqual([]);
  });

  it('still fails closed for absent required packages and unusable installed licenses', () => {
    const missingPath = join(tmpdir(), 'browser-cortex-missing-required-package');
    const requiredProjects = [
      {
        name: 'test-workspace',
        dependencies: {
          required: { version: '1.0.0', path: missingPath },
        },
      },
    ];
    expect(() =>
      collectProductionComponents(requiredProjects, new Set(['required@1.0.0']), new Set()),
    ).toThrow(/path cannot be resolved/u);

    const optionalPath = temporaryPackage('platform-only', '1.0.0', 'UNLICENSED');
    const installedOptionalProjects = [
      {
        name: 'test-workspace',
        dependencies: {
          'platform-only': { version: '1.0.0', path: optionalPath },
        },
      },
    ];
    expect(() =>
      collectProductionComponents(
        installedOptionalProjects,
        new Set(['platform-only@1.0.0']),
        new Set(['platform-only@1.0.0']),
      ),
    ).toThrow(/no usable declared license/u);
  });
});
