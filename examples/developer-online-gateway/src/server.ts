import { createGatewayServer } from './gateway.js';

const bindAddress = '127.0.0.1';
const port = Number.parseInt(process.env.BROWSER_CORTEX_GATEWAY_PORT ?? '8787', 10);

if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
  throw new Error('Invalid gateway port.');
}

const simulated = process.env.BROWSER_CORTEX_DEMO_MODE === 'simulated';
const { server, expectedDestination, expectedModel } = createGatewayServer({
  sessionSecret: process.env.BROWSER_CORTEX_GATEWAY_SESSION ?? '',
  allowedOrigins: (process.env.BROWSER_CORTEX_ALLOWED_ORIGINS ?? 'http://127.0.0.1:4173,http://localhost:4173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  allowedHost: process.env.BROWSER_CORTEX_ALLOWED_HOST ?? `127.0.0.1:${port}`,
  simulated,
  upstreamUrl: process.env.BROWSER_CORTEX_UPSTREAM_URL,
  upstreamKey: process.env.BROWSER_CORTEX_UPSTREAM_API_KEY,
  configuredModel: process.env.BROWSER_CORTEX_UPSTREAM_MODEL,
});

server.listen(port, bindAddress, () => {
  console.log(`BrowserCortex gateway listening on http://${bindAddress}:${port}`);
  console.log(simulated ? 'Mode: simulated' : 'Mode: live fixed upstream');
  console.log(`Disclosure destination: ${expectedDestination}`);
  console.log(`Disclosure model: ${expectedModel}`);
});
