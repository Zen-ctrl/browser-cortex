import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  isForbiddenNativeExtensionFile,
  sharpLibvipsCoordinates,
} from '../../scripts/lib/distribution-boundaries.mjs';
import { parseLockedNpmCoordinates } from '../../scripts/lib/sbom.mjs';

describe('extension distribution boundaries', () => {
  it('classifies every locked sharp-libvips platform package as non-distributed', async () => {
    const lockfile = await readFile(resolve(process.cwd(), 'pnpm-lock.yaml'), 'utf8');
    const locked = [...parseLockedNpmCoordinates(lockfile)]
      .filter((coordinate) => coordinate.startsWith('@img/sharp-libvips-'))
      .sort();

    expect(sharpLibvipsCoordinates().sort()).toEqual(locked);
  });

  it('rejects native executables while allowing browser runtime assets', () => {
    for (const name of [
      'sharp.node',
      'libvips.dll',
      'libvips.dylib',
      'libvips.so',
      'libvips-cpp.so.8.18.6',
      'helper.exe',
    ]) {
      expect(isForbiddenNativeExtensionFile(`assets/${name}`)).toBe(true);
    }
    for (const name of ['assets/content.js', 'runtime/model.wasm', 'assets/panel.css']) {
      expect(isForbiddenNativeExtensionFile(name)).toBe(false);
    }
  });
});
