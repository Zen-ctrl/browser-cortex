import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const workspaceSourceAliases = Object.fromEntries(
  [
    'bridge',
    'contracts',
    'core',
    'memory',
    'policy',
    'privacy',
    'runtime-transformers',
    'runtime-webllm',
    'testkit',
    'ui',
    'workflows'
  ].map((packageName) => [
    `@browser-cortex/${packageName}`,
    fileURLToPath(new URL(`./packages/${packageName}/src/index.ts`, import.meta.url))
  ])
);

export default defineConfig({
  resolve: {
    // Root-level integration tests are not package dependencies, so pnpm does
    // not create root node_modules links for workspace packages. Resolve their
    // public entry points directly without broadening Vitest's test discovery.
    alias: workspaceSourceAliases
  },
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'tests/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary']
    },
    testTimeout: 20_000
  }
});
