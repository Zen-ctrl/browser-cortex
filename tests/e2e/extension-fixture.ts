import { cp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const E2E_HOSTS = [
  'http://127.0.0.1:4173/*',
  'http://127.0.0.1:4174/*',
] as const;

export async function prepareExtensionFixture(profile: string): Promise<string> {
  const source = resolve(process.cwd(), 'apps/extension/dist');
  const destination = join(profile, 'extension-under-test');
  await cp(source, destination, { recursive: true });

  // Product access comes from a toolbar/side-panel activeTab gesture. Headless
  // Chromium cannot reproduce that grant, so this disposable copy receives only
  // the two local E2E origins. Production dist JavaScript remains byte-for-byte
  // unchanged, and the release manifest is verified by the manifest policy suite.
  const manifestPath = join(destination, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.host_permissions = [...E2E_HOSTS];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return destination;
}
