import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { assertExtensionManifest } from '../../scripts/lib/extension-manifest.mjs';

const candidates = [
  'apps/extension/manifest.json',
  'apps/extension/public/manifest.json',
  'apps/extension/src/manifest.json',
].map((path) => resolve(process.cwd(), path));
const manifestPath = candidates.find((path) => existsSync(path));

interface ExtensionManifest {
  readonly manifest_version?: unknown;
  readonly permissions?: unknown;
  readonly host_permissions?: unknown;
  readonly content_security_policy?: unknown;
  readonly background?: { readonly service_worker?: unknown };
  readonly content_scripts?: ReadonlyArray<{ readonly js?: unknown; readonly matches?: unknown }>;
  readonly web_accessible_resources?: ReadonlyArray<{ readonly resources?: unknown }>;
}

function loadManifest(): ExtensionManifest {
  if (manifestPath === undefined) throw new Error('Extension manifest source is not present.');
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as ExtensionManifest;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new TypeError('Expected an array of strings in the extension manifest.');
  }
  return value as string[];
}

function expectPackagedPath(path: string): void {
  expect(path).not.toMatch(/^(?:https?:)?\/\//iu);
  expect(path).not.toContain('..');
}

describe('extension manifest policy', () => {
  it('uses Manifest V3 and least-privilege installed permissions', () => {
    const manifest = loadManifest();
    const packageVersion = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')).version as string;
    expect(() => assertExtensionManifest(manifest, packageVersion)).not.toThrow();
    expect(manifest.manifest_version).toBe(3);
    const permissions = stringArray(manifest.permissions ?? []);
    for (const forbidden of [
      'history',
      'cookies',
      'debugger',
      'desktopCapture',
      'clipboardRead',
      'nativeMessaging',
    ]) {
      expect(permissions).not.toContain(forbidden);
    }
    expect(stringArray(manifest.host_permissions ?? [])).not.toContain('<all_urls>');
    for (const contentScript of manifest.content_scripts ?? []) {
      expect(stringArray(contentScript.matches ?? [])).not.toContain('<all_urls>');
    }
  });

  it('disallows remote or dynamically evaluated extension code', () => {
    const manifest = loadManifest();
    const extensionPages =
      typeof manifest.content_security_policy === 'object' &&
      manifest.content_security_policy !== null &&
      'extension_pages' in manifest.content_security_policy
        ? String((manifest.content_security_policy as { extension_pages: unknown }).extension_pages)
        : String(manifest.content_security_policy ?? '');
    const scriptSource = extensionPages.split(';').find((directive) => directive.trim().startsWith('script-src')) ?? '';
    expect(scriptSource.trim()).toBe("script-src 'self' 'wasm-unsafe-eval'");
    expect(extensionPages).not.toMatch(/['"]unsafe-eval['"]|unsafe-inline/iu);

    expect(typeof manifest.background?.service_worker).toBe('string');
    expectPackagedPath(String(manifest.background?.service_worker));
    for (const contentScript of manifest.content_scripts ?? []) {
      for (const path of stringArray(contentScript.js ?? [])) expectPackagedPath(path);
    }
    for (const resourceGroup of manifest.web_accessible_resources ?? []) {
      for (const path of stringArray(resourceGroup.resources ?? [])) expectPackagedPath(path);
    }
  });

  it('rejects any privilege outside the exact reviewed manifest', () => {
    const manifest = loadManifest();
    const packageVersion = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')).version as string;
    const broadened = {
      ...manifest,
      permissions: [...stringArray(manifest.permissions ?? []), 'tabs'],
      host_permissions: ['https://*/*'],
    };
    expect(() => assertExtensionManifest(broadened, packageVersion)).toThrow(
      'exact reviewed least-privilege release policy',
    );
  });
});
