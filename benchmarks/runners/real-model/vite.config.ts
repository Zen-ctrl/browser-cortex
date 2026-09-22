import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(directory, '../../..');

export default defineConfig({
  root: directory,
  publicDir: resolve(repositoryRoot, 'vendor'),
  server: {
    host: '127.0.0.1',
    port: 4180,
    strictPort: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
      'Cache-Control': 'no-store',
    },
  },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    outDir: resolve(repositoryRoot, 'test-results/real-model-harness'),
    emptyOutDir: true,
  },
});
