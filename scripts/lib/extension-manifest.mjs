const DESCRIPTION = 'Review selected page content with local models, scoped memory, and explicit permissions.';
const OPTIONAL_MODEL_HOSTS = Object.freeze([
  'https://huggingface.co/*',
  'https://*.huggingface.co/*',
  'https://cdn-lfs.huggingface.co/*',
  'https://*.xethub.hf.co/*',
  'https://*.hf.co/*',
]);
const EXTENSION_CSP = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self'; connect-src 'self' https://huggingface.co https://*.huggingface.co https://cdn-lfs.huggingface.co https://*.xethub.hf.co https://*.hf.co";

export function chromeVersionForPackage(packageVersion) {
  if (typeof packageVersion !== 'string') throw new Error('The package version is missing.');
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[A-Za-z][A-Za-z0-9-]*\.(0|[1-9]\d*))?$/u.exec(packageVersion);
  if (!match) throw new Error(`The package version cannot be represented as a reviewed Chrome beta version: ${packageVersion}`);
  const parts = match.slice(1, 4).map(Number);
  if (match[4] !== undefined) parts.push(Number(match[4]));
  if (parts.some((value) => !Number.isSafeInteger(value) || value > 65_535)) {
    throw new Error('The package version exceeds Chrome extension version limits.');
  }
  return parts.join('.');
}

export function expectedExtensionManifest(packageVersion) {
  return {
    manifest_version: 3,
    name: 'BrowserCortex',
    version: chromeVersionForPackage(packageVersion),
    version_name: packageVersion,
    description: DESCRIPTION,
    minimum_chrome_version: '116',
    permissions: ['activeTab', 'scripting', 'storage', 'sidePanel'],
    optional_host_permissions: [...OPTIONAL_MODEL_HOSTS],
    background: {
      service_worker: 'assets/background.js',
      type: 'module',
    },
    action: {
      default_title: 'Open BrowserCortex',
    },
    side_panel: {
      default_path: 'panel.html',
    },
    options_page: 'options.html',
    content_security_policy: {
      extension_pages: EXTENSION_CSP,
    },
  };
}

export function assertExtensionManifest(manifest, packageVersion) {
  const expected = expectedExtensionManifest(packageVersion);
  if (JSON.stringify(manifest) !== JSON.stringify(expected)) {
    throw new Error('Extension manifest differs from the exact reviewed least-privilege release policy.');
  }
  return expected;
}
