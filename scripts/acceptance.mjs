import { execFileSync } from 'node:child_process';

const tasks = [
  ['doctor', 'environment preflight'],
  ['lint', 'static and TypeScript boundaries'],
  ['test', 'unit, security, extension-contract, and offline regressions'],
  ['build', 'production applications and packaged runtime staging'],
  ['test:e2e', 'production workbench and unpacked-extension browser boundaries'],
  ['bench:local', 'measured deterministic local benchmark corpus'],
  ['package:extension', 'deterministic developer extension archive'],
  ['sbom', 'CycloneDX production dependency inventory'],
  ['verify:release', 'release boundary, model manifest, copy, attribution, and repository hygiene'],
];

for (const [script, description] of tasks) {
  console.log(`Acceptance: ${description}.`);
  execFileSync('pnpm', [script], {
    cwd: process.cwd(),
    stdio: 'inherit',
    windowsHide: true,
    shell: process.platform === 'win32',
  });
}

console.log('BrowserCortex aggregate acceptance passed. Real-model inference remains a separate trusted-runner gate.');
