import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const projectDirectory = dirname(fileURLToPath(import.meta.url));
const releaseNoticeDirectory = resolve(projectDirectory, '../../release/extension-notices');

function packageReleaseNotices(): Plugin {
  return {
    name: 'package-reviewed-release-notices',
    apply: 'build',
    generateBundle() {
      for (const name of ['LICENSE.txt', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_LICENSES.txt']) {
        this.emitFile({
          type: 'asset',
          fileName: name,
          source: readFileSync(resolve(releaseNoticeDirectory, name)),
        });
      }
    },
  };
}

function assertClassicContentScript(): Plugin {
  return {
    name: 'assert-classic-content-script',
    apply: 'build',
    generateBundle(_options, bundle) {
      const content = bundle['assets/content.js'];
      if (!content || content.type !== 'chunk') this.error('The extension build did not emit assets/content.js.');
      if (content.imports.length > 0 || content.dynamicImports.length > 0 || /^\s*(?:import|export)\s/mu.test(content.code)) {
        this.error('assets/content.js must be a self-contained classic-compatible script for chrome.scripting.executeScript.');
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), packageReleaseNotices(), assertClassicContentScript()],
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      input: {
        panel: resolve(projectDirectory, 'panel.html'),
        options: resolve(projectDirectory, 'options.html'),
        background: resolve(projectDirectory, 'src/background/index.ts'),
        content: resolve(projectDirectory, 'src/content/index.ts'),
      },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
