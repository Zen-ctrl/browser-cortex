import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

interface RegistryModel {
  taskCapabilities?: string[];
  artifacts?: Array<{ kind?: string; path?: string; local?: boolean }>;
}

const projectDirectory = dirname(fileURLToPath(import.meta.url));
const registry = JSON.parse(readFileSync(resolve(projectDirectory, '../../models/registry.json'), 'utf8')) as { models?: RegistryModel[] };
const generation = registry.models?.find((model) => model.taskCapabilities?.includes('generation'));
const executable = generation?.artifacts?.find((artifact) => artifact.kind === 'executable-model-library');
if (!executable?.local || !executable.path) throw new Error('The model registry has no local generation executable.');
const LOCAL_RUNTIME = `runtime/${basename(executable.path)}`;

function appShellServiceWorker(): Plugin {
  return {
    name: 'browser-cortex-app-shell-service-worker',
    apply: 'build',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const generated = Object.values(bundle)
          .map((entry) => entry.fileName)
          .filter((fileName) => fileName === 'index.html' || /^assets\/.+\.(?:css|js)$/u.test(fileName))
          .sort();
        if (!generated.includes('index.html') || !generated.some((file) => file.endsWith('.css')) || !generated.some((file) => file.endsWith('.js'))) {
          this.error('The production app shell is missing a reviewed HTML, CSS, or JavaScript asset.');
        }
        if (!generated.some((file) => /generation-worker.+\.js$/u.test(file))) {
          this.error('The production app shell is missing the dedicated generation worker.');
        }
        const precache = ['/', '/index.html', ...generated.filter((file) => file !== 'index.html').map((file) => `/${file}`), `/${LOCAL_RUNTIME}`];
        const version = createHash('sha256').update(JSON.stringify(precache)).digest('hex').slice(0, 16);
        const source = `const CACHE_PREFIX = 'browser-cortex-shell-';
const CACHE_NAME = CACHE_PREFIX + '${version}';
const PRECACHE = Object.freeze(${JSON.stringify(precache)});
const PRECACHE_SET = new Set(PRECACHE);
const PRIVATE_OR_REMOTE_PATH = /\\/(?:api|v1|inference|gateway|private|vault)(?:\\/|$)/u;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE.map((path) => new Request(path, { cache: 'reload', credentials: 'same-origin' })))))
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') void self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || PRIVATE_OR_REMOTE_PATH.test(url.pathname)) return;
  if (PRECACHE_SET.has(url.pathname)) {
    event.respondWith(caches.open(CACHE_NAME).then(async (cache) => (await cache.match(url.pathname)) ?? fetch(request)));
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => {
      const cachedShell = await (await caches.open(CACHE_NAME)).match('/index.html');
      return cachedShell ?? Response.error();
    }));
  }
});
`;
        this.emitFile({ type: 'asset', fileName: 'service-worker.js', source });
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), appShellServiceWorker()],
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  server: {
    port: 4173,
    strictPort: true,
  },
});
