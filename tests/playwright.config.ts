import { defineConfig, devices } from '@playwright/test';

const ci = process.env.CI === 'true';

function testPort(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!/^\d{4,5}$/u.test(value)) throw new Error(`${name} must be an integer port from 1024 through 65535.`);
  const port = Number(value);
  if (port < 1024 || port > 65_535) throw new Error(`${name} must be an integer port from 1024 through 65535.`);
  return port;
}

const workbenchPort = testPort(process.env.BROWSER_CORTEX_E2E_WORKBENCH_PORT, 4173, 'BROWSER_CORTEX_E2E_WORKBENCH_PORT');
const workbenchOrigin = `http://127.0.0.1:${workbenchPort}`;

export default defineConfig({
  testDir: './e2e',
  outputDir: '../test-results/playwright',
  fullyParallel: false,
  workers: 1,
  retries: ci ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [
    ['line'],
    ['json', { outputFile: 'test-results/playwright-results.json' }],
  ],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: workbenchOrigin,
    serviceWorkers: 'allow',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
  },
  webServer: [
    {
      command: `pnpm --filter @browser-cortex/workbench preview --host 127.0.0.1 --port ${workbenchPort}`,
      url: workbenchOrigin,
      reuseExistingServer: !ci,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @browser-cortex/demo-site preview --host 127.0.0.1 --port 4174',
      url: 'http://127.0.0.1:4174',
      reuseExistingServer: !ci,
      timeout: 60_000,
    },
  ],
  projects: [
    { name: 'workbench', testMatch: /workbench\.spec\.ts/u },
    { name: 'extension', testMatch: /extension(?:-product)?\.spec\.ts/u },
  ],
});
