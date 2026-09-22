# Developer-owned online gateway

This optional example keeps an upstream credential on a loopback server and exposes one bounded BrowserCortex endpoint. It is not required by the SDK or workbench and must not be deployed as an open proxy.

## Quick start in simulation mode

Simulation exercises the gateway contract without contacting a provider. Set an unpredictable local session value, keep it outside source control, then start the server from the repository root.

PowerShell:

```powershell
$env:BROWSER_CORTEX_GATEWAY_SESSION = '<replace-with-at-least-32-random-characters>'
$env:BROWSER_CORTEX_DEMO_MODE = 'simulated'
pnpm dev:gateway
```

macOS or Linux:

```bash
export BROWSER_CORTEX_GATEWAY_SESSION='<replace-with-at-least-32-random-characters>'
export BROWSER_CORTEX_DEMO_MODE='simulated'
pnpm dev:gateway
```

The gateway prints its loopback address, fixed model, fixed destination, and allowed origins. In the workbench Privacy page, choose ask-before-online, configure the printed values, create an exact disclosure, inspect it, and approve it once.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `BROWSER_CORTEX_GATEWAY_SESSION` | Yes | At least 32 characters; authenticates the local workbench to the gateway |
| `BROWSER_CORTEX_DEMO_MODE` | Simulation only | Set to `simulated`; disables upstream transport |
| `BROWSER_CORTEX_UPSTREAM_URL` | Live test only | One fixed authorized HTTPS provider endpoint |
| `BROWSER_CORTEX_UPSTREAM_MODEL` | Live test only | One fixed provider model label |
| `BROWSER_CORTEX_UPSTREAM_API_KEY` | Live test only | Provider credential held only by the server process |
| `BROWSER_CORTEX_ALLOWED_ORIGINS` | Optional | Comma-separated explicit workbench origins |
| `BROWSER_CORTEX_GATEWAY_PORT` | Optional | Loopback listener port |

Do not paste real values into issues, screenshots, shell history you plan to share, `.env` files in this repository, or frontend code. A live provider test requires your own authorized account and remains outside the project's default setup.

For a clearly labeled local simulation, set an unpredictable `BROWSER_CORTEX_GATEWAY_SESSION` value of at least 32 characters and set `BROWSER_CORTEX_DEMO_MODE=simulated`. The fixed model is `simulated-endpoint` and the fixed disclosed destination is `simulated://browser-cortex/local`.

For a live authorized test, also set one fixed HTTPS `BROWSER_CORTEX_UPSTREAM_URL`, `BROWSER_CORTEX_UPSTREAM_MODEL`, and `BROWSER_CORTEX_UPSTREAM_API_KEY` in the server environment. The upstream URL may not contain credentials, a query, or a fragment. Never place the upstream key or gateway session credential in frontend source or Git.

## Bound disclosure

Every `/v1/assist` body is strict and includes:

- `schemaVersion`: `1`
- `requestId`: a UUID
- `model`: exactly the server's fixed model
- `payload`: the disclosed, bounded text
- `destination`: exactly the fixed destination printed at startup
- `nonce`: 22 to 128 URL-safe random characters
- `expiresAt`: an epoch-millisecond expiry no more than five minutes ahead
- `disclosureFingerprint`: lowercase SHA-256 hex of the canonical disclosure

The canonical disclosure is `JSON.stringify` of a newly constructed object whose keys are in exactly this order: `schemaVersion`, `requestId`, `model`, `payload`, `destination`, `nonce`, `expiresAt`. Do not hash the received object directly because caller key order is not a binding.

```js
const disclosure = {
  schemaVersion: 1,
  requestId: crypto.randomUUID(),
  model: 'simulated-endpoint',
  payload: 'Only this reviewed text is sent.',
  destination: 'simulated://browser-cortex/local',
  nonce: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(24))),
  expiresAt: Date.now() + 60_000,
};

const canonical = JSON.stringify({
  schemaVersion: disclosure.schemaVersion,
  requestId: disclosure.requestId,
  model: disclosure.model,
  payload: disclosure.payload,
  destination: disclosure.destination,
  nonce: disclosure.nonce,
  expiresAt: disclosure.expiresAt,
});
const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
const disclosureFingerprint = [...new Uint8Array(digest)]
  .map((byte) => byte.toString(16).padStart(2, '0'))
  .join('');

function bytesToBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}
```

The server recomputes and timing-safely compares this fingerprint, checks model and destination, enforces expiry, and consumes each nonce once before upstream work begins. Failed upstream work is not retried with the same disclosure.

The server also binds to loopback, checks Host and Origin, requires a bearer session credential, caps requests and streamed upstream responses, rejects redirects, and never accepts a caller-supplied upstream target. Loopback is not authentication.

The default allowed workbench origins are `http://127.0.0.1:4173` and `http://localhost:4173`, matching the reviewed Vite preview port. Override `BROWSER_CORTEX_ALLOWED_ORIGINS` explicitly for another development origin.

Successful responses use the strict broker envelope and contain no extra fields:

```json
{"schemaVersion":1,"model":"simulated-endpoint","output":"Simulated endpoint received 42 sanitized characters."}
```

The `mode` and request ID are written only to the gateway's safe metadata log. The disclosed request body itself is the exact body approved by the workbench egress broker.

## Adversarial verification

From the repository root, `pnpm exec vitest run --config vitest.config.ts tests/security/developer-gateway.test.ts` exercises the gateway over a real loopback HTTP listener. The fixtures cover Origin and Host denial, exact bearer authentication, one-use nonces, fixed model and destination enforcement, the fixed upstream request, redirect rejection, request and response size limits, timeout-driven upstream abort, and scrubbed completion logging.

The tests use synthetic credentials and an injected upstream transport. They do not contact or stand in for an authorized live provider test.
