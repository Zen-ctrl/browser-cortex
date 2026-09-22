import { execFileSync } from 'node:child_process';

function run(command, args) {
  execFileSync(command, args, {
    stdio: 'inherit',
    windowsHide: true,
    shell: process.platform === 'win32',
  });
}

run('tsc', ['-b', '--pretty', 'false']);

for (const project of [
  'apps/workbench',
  'apps/extension',
  'apps/demo-site',
  'examples/vanilla-local-search',
  'examples/react-workflow-review',
  'examples/developer-online-gateway',
]) {
  run('tsc', ['-p', `${project}/tsconfig.json`, '--noEmit', '--pretty', 'false']);
}

run('tsc', ['-p', 'benchmarks/runners/real-model/tsconfig.json', '--noEmit', '--pretty', 'false']);

console.log('All library, application, extension, demo, example, and real-model harness TypeScript projects passed.');
