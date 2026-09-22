import { type AddressInfo } from 'node:net';
import { request, type OutgoingHttpHeaders } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createGatewayServer,
  disclosureFingerprint,
  type GatewayConfiguration,
  type GatewayDependencies,
} from '../../examples/developer-online-gateway/src/gateway.js';

const SESSION_SECRET = 'synthetic-session-secret-0000000000000000';
const ALLOWED_ORIGIN = 'http://127.0.0.1:4173';
const ALLOWED_HOST = 'gateway.test';
const NOW = 1_800_000_000_000;
const UPSTREAM_URL = 'https://provider.example.test/v1/chat/completions';
const UPSTREAM_MODEL = 'fixed-model-v1';
const UPSTREAM_KEY = 'synthetic-upstream-key-for-tests';
const openServers = new Set<ReturnType<typeof createGatewayServer>['server']>();

const simulatedConfiguration: GatewayConfiguration = {
  sessionSecret: SESSION_SECRET,
  allowedOrigins: [ALLOWED_ORIGIN],
  allowedHost: ALLOWED_HOST,
  simulated: true,
};

const liveConfiguration: GatewayConfiguration = {
  ...simulatedConfiguration,
  simulated: false,
  upstreamUrl: UPSTREAM_URL,
  upstreamKey: UPSTREAM_KEY,
  configuredModel: UPSTREAM_MODEL,
};

interface UnsignedDisclosure {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly model: string;
  readonly payload: string;
  readonly destination: string;
  readonly nonce: string;
  readonly expiresAt: number;
}

function disclosure(overrides: Partial<UnsignedDisclosure> = {}): UnsignedDisclosure & {
  readonly disclosureFingerprint: string;
} {
  const unsigned: UnsignedDisclosure = {
    schemaVersion: 1,
    requestId: '11111111-1111-4111-8111-111111111111',
    model: 'simulated-endpoint',
    payload: 'Only reviewed synthetic text.',
    destination: 'simulated://browser-cortex/local',
    nonce: 'synthetic_nonce_0000000000000001',
    expiresAt: NOW + 60_000,
    ...overrides,
  };
  return { ...unsigned, disclosureFingerprint: disclosureFingerprint(unsigned) };
}

async function startGateway(
  configuration: GatewayConfiguration = simulatedConfiguration,
  dependencies: GatewayDependencies = {},
): Promise<number> {
  const runtime = createGatewayServer(configuration, {
    now: () => NOW,
    log: () => undefined,
    ...dependencies,
  });
  await new Promise<void>((resolve, reject) => {
    runtime.server.once('error', reject);
    runtime.server.listen(0, '127.0.0.1', () => resolve());
  });
  openServers.add(runtime.server);
  return (runtime.server.address() as AddressInfo).port;
}

interface RequestOptions {
  readonly body?: string;
  readonly origin?: string | null;
  readonly host?: string;
  readonly authorization?: string | null;
}

async function post(port: number, options: RequestOptions = {}): Promise<{
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: unknown;
}> {
  const body = options.body ?? JSON.stringify(disclosure());
  const headers: OutgoingHttpHeaders = {
    host: options.host ?? ALLOWED_HOST,
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  };
  if (options.origin !== null) headers.origin = options.origin ?? ALLOWED_ORIGIN;
  if (options.authorization !== null) {
    headers.authorization = options.authorization ?? `Bearer ${SESSION_SECRET}`;
  }

  return await new Promise((resolve, reject) => {
    const outgoing = request({
      hostname: '127.0.0.1',
      port,
      path: '/v1/assist',
      method: 'POST',
      headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: text ? JSON.parse(text) as unknown : undefined,
        });
      });
    });
    outgoing.once('error', reject);
    outgoing.end(body);
  });
}

function upstreamResponse(
  content: string,
  options: {
    readonly url?: string;
    readonly redirected?: boolean;
    readonly contentLength?: number;
  } = {},
): Response {
  const response = new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      ...(options.contentLength === undefined
        ? {}
        : { 'content-length': options.contentLength.toString() }),
    },
  });
  Object.defineProperties(response, {
    url: { value: options.url ?? UPSTREAM_URL },
    redirected: { value: options.redirected ?? false },
  });
  return response;
}

afterEach(async () => {
  await Promise.all([...openServers].map(async (server) => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }));
  openServers.clear();
});

describe('developer-owned online gateway boundaries', () => {
  it('rejects missing or untrusted Origin before adding CORS trust', async () => {
    const port = await startGateway();

    const missing = await post(port, { origin: null });
    const untrusted = await post(port, { origin: 'https://attacker.example.test' });

    expect(missing).toMatchObject({ status: 403, body: { error: 'ORIGIN_DENIED' } });
    expect(untrusted).toMatchObject({ status: 403, body: { error: 'ORIGIN_DENIED' } });
    expect(missing.headers['access-control-allow-origin']).toBeUndefined();
    expect(untrusted.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects a mismatched Host even when Origin is allowed', async () => {
    const port = await startGateway();
    const response = await post(port, { host: 'attacker.example.test' });

    expect(response).toMatchObject({ status: 403, body: { error: 'ORIGIN_DENIED' } });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('requires the exact bearer without consuming the disclosure', async () => {
    const port = await startGateway();

    expect(await post(port, { authorization: null })).toMatchObject({
      status: 401,
      body: { error: 'AUTHENTICATION_REQUIRED' },
    });
    expect(await post(port, { authorization: 'Bearer wrong-secret' })).toMatchObject({
      status: 401,
      body: { error: 'AUTHENTICATION_REQUIRED' },
    });
    expect(await post(port, { authorization: `Basic ${SESSION_SECRET}` })).toMatchObject({
      status: 401,
      body: { error: 'AUTHENTICATION_REQUIRED' },
    });
    expect(await post(port)).toMatchObject({ status: 200, body: { schemaVersion: 1 } });
  });

  it('consumes a valid nonce exactly once', async () => {
    const port = await startGateway();
    const body = JSON.stringify(disclosure());

    expect(await post(port, { body })).toMatchObject({ status: 200 });
    expect(await post(port, { body })).toMatchObject({
      status: 409,
      body: { error: 'DISCLOSURE_REPLAY' },
    });
  });

  it('rejects caller-selected models and destinations before upstream fetch', async () => {
    const fetchUpstream = vi.fn<typeof globalThis.fetch>(async () => upstreamResponse('unused'));
    const port = await startGateway(liveConfiguration, { fetch: fetchUpstream });

    const wrongModel = disclosure({
      model: 'caller-selected-model',
      destination: UPSTREAM_URL,
    });
    const wrongDestination = disclosure({
      model: UPSTREAM_MODEL,
      destination: 'https://attacker.example.test/collect',
      nonce: 'synthetic_nonce_0000000000000002',
    });

    expect(await post(port, { body: JSON.stringify(wrongModel) })).toMatchObject({
      status: 400,
      body: { error: 'MODEL_NOT_ALLOWED' },
    });
    expect(await post(port, { body: JSON.stringify(wrongDestination) })).toMatchObject({
      status: 400,
      body: { error: 'DESTINATION_NOT_ALLOWED' },
    });
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it('uses only the configured upstream URL, model, key, and redirect policy', async () => {
    let receivedInput: Parameters<typeof globalThis.fetch>[0] | undefined;
    let receivedInit: Parameters<typeof globalThis.fetch>[1];
    const fetchUpstream: typeof globalThis.fetch = async (input, init) => {
      receivedInput = input;
      receivedInit = init;
      return upstreamResponse('bounded answer');
    };
    const port = await startGateway(liveConfiguration, { fetch: fetchUpstream });
    const requestBody = disclosure({
      model: UPSTREAM_MODEL,
      destination: UPSTREAM_URL,
      payload: 'approved payload only',
    });

    expect(await post(port, { body: JSON.stringify(requestBody) })).toMatchObject({
      status: 200,
      body: { schemaVersion: 1, model: UPSTREAM_MODEL, output: 'bounded answer' },
    });
    expect(String(receivedInput)).toBe(UPSTREAM_URL);
    expect(receivedInit?.method).toBe('POST');
    expect(receivedInit?.redirect).toBe('error');
    expect(receivedInit?.headers).toEqual({
      Authorization: `Bearer ${UPSTREAM_KEY}`,
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(receivedInit?.body))).toEqual({
      model: UPSTREAM_MODEL,
      messages: [{ role: 'user', content: 'approved payload only' }],
      max_tokens: 512,
    });
  });

  it('rejects an upstream response that reports a redirect or changed final URL', async () => {
    const fetchUpstream = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      expect(init?.redirect).toBe('error');
      return upstreamResponse('must not pass', {
        url: 'https://redirected.example.test/v1/chat/completions',
        redirected: true,
      });
    });
    const port = await startGateway(liveConfiguration, { fetch: fetchUpstream });
    const body = disclosure({ model: UPSTREAM_MODEL, destination: UPSTREAM_URL });

    expect(await post(port, { body: JSON.stringify(body) })).toMatchObject({
      status: 502,
      body: { error: 'UPSTREAM_REDIRECTED' },
    });
  });

  it('rejects an oversized request body before parsing it', async () => {
    const port = await startGateway();
    const response = await post(port, { body: `"${'x'.repeat(70 * 1024)}"` });

    expect(response).toMatchObject({ status: 413, body: { error: 'REQUEST_TOO_LARGE' } });
  });

  it('rejects an upstream body whose declared size exceeds the response limit', async () => {
    const fetchUpstream = vi.fn<typeof globalThis.fetch>(async () => upstreamResponse('unused', {
      contentLength: 1024 * 1024 + 1,
    }));
    const port = await startGateway(liveConfiguration, { fetch: fetchUpstream });
    const body = disclosure({ model: UPSTREAM_MODEL, destination: UPSTREAM_URL });

    expect(await post(port, { body: JSON.stringify(body) })).toMatchObject({
      status: 502,
      body: { error: 'UPSTREAM_TOO_LARGE' },
    });
  });

  it('aborts a stalled upstream and reports a bounded timeout error', async () => {
    let observedAbort = false;
    const fetchUpstream: typeof globalThis.fetch = async (_input, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error('missing signal'));
          return;
        }
        signal.addEventListener('abort', () => {
          observedAbort = true;
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      });
    };
    const port = await startGateway(liveConfiguration, {
      fetch: fetchUpstream,
      upstreamTimeoutMs: 10,
    });
    const body = disclosure({ model: UPSTREAM_MODEL, destination: UPSTREAM_URL });

    expect(await post(port, { body: JSON.stringify(body) })).toMatchObject({
      status: 502,
      body: { error: 'UPSTREAM_TIMEOUT' },
    });
    expect(observedAbort).toBe(true);
  });

  it('logs only the request identifier, mode, and completion status', async () => {
    const entries: string[] = [];
    const sensitivePayload = 'private-payload-marker-never-log';
    const port = await startGateway(simulatedConfiguration, { log: (entry) => entries.push(entry) });
    const body = disclosure({ payload: sensitivePayload });

    expect(await post(port, { body: JSON.stringify(body) })).toMatchObject({ status: 200 });
    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0] ?? '')).toEqual({
      requestId: body.requestId,
      mode: 'simulated',
      status: 'completed',
    });
    expect(entries.join('\n')).not.toContain(sensitivePayload);
    expect(entries.join('\n')).not.toContain(SESSION_SECRET);
    expect(entries.join('\n')).not.toContain(UPSTREAM_KEY);
  });
});
