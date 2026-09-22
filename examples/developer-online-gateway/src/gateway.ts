import { createHash, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import { z } from 'zod';

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_UPSTREAM_BYTES = 1024 * 1024;
const MAX_DISCLOSURE_LIFETIME_MS = 5 * 60 * 1000;
const MAX_REPLAY_ENTRIES = 2_048;
const MAX_UPSTREAM_TIMEOUT_MS = 55_000;
const SIMULATED_DESTINATION = 'simulated://browser-cortex/local';
const SIMULATED_MODEL = 'simulated-endpoint';

const requestSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: z.string().uuid(),
    model: z.string().min(1).max(100),
    payload: z.string().min(1).max(48_000),
    destination: z.string().min(1).max(2_048),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{22,128}$/u),
    expiresAt: z.number().int().positive(),
    disclosureFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

type AssistRequest = z.infer<typeof requestSchema>;
type UnsignedAssistRequest = Omit<AssistRequest, 'disclosureFingerprint'>;

export interface GatewayConfiguration {
  readonly sessionSecret: string;
  readonly allowedOrigins: readonly string[];
  readonly allowedHost: string;
  readonly simulated: boolean;
  readonly upstreamUrl?: string | undefined;
  readonly upstreamKey?: string | undefined;
  readonly configuredModel?: string | undefined;
}

export interface GatewayDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly upstreamTimeoutMs?: number;
  readonly log?: (entry: string) => void;
}

export interface GatewayRuntime {
  readonly server: Server;
  readonly expectedDestination: string;
  readonly expectedModel: string;
}

function normalizeLiveDestination(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:') throw new Error('The live upstream must use HTTPS.');
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('The fixed upstream URL cannot contain credentials, a query, or a fragment.');
  }
  return parsed.toString();
}

function canonicalDisclosure(body: UnsignedAssistRequest): string {
  return JSON.stringify({
    schemaVersion: body.schemaVersion,
    requestId: body.requestId,
    model: body.model,
    payload: body.payload,
    destination: body.destination,
    nonce: body.nonce,
    expiresAt: body.expiresAt,
  });
}

export function disclosureFingerprint(body: UnsignedAssistRequest): string {
  return createHash('sha256').update(canonicalDisclosure(body), 'utf8').digest('hex');
}

function send(
  response: ServerResponse,
  status: number,
  body: unknown,
  allowedOrigins: ReadonlySet<string>,
  origin?: string,
): void {
  response.statusCode = status;
  if (origin && allowedOrigins.has(origin)) response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Vary', 'Origin');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(JSON.stringify(body));
}

function authentic(request: IncomingMessage, sessionSecret: string): boolean {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string' || !/^Bearer [^\s]+$/u.test(authorization)) return false;
  const left = Buffer.from(authorization.slice('Bearer '.length));
  const right = Buffer.from(sessionSecret);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) {
      request.resume();
      throw new Error('REQUEST_TOO_LARGE');
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Error('INVALID_JSON');
  }
}

function validFingerprint(body: AssistRequest): boolean {
  const expected = Buffer.from(disclosureFingerprint(body), 'hex');
  const provided = Buffer.from(body.disclosureFingerprint, 'hex');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function consumeDisclosure(
  body: AssistRequest,
  now: number,
  usedNonces: Map<string, number>,
): 'ok' | 'expired' | 'lifetime' | 'replay' | 'capacity' {
  for (const [nonce, expiresAt] of usedNonces) {
    if (expiresAt <= now) usedNonces.delete(nonce);
  }
  if (body.expiresAt <= now) return 'expired';
  if (body.expiresAt > now + MAX_DISCLOSURE_LIFETIME_MS) return 'lifetime';
  if (usedNonces.has(body.nonce)) return 'replay';
  if (usedNonces.size >= MAX_REPLAY_ENTRIES) return 'capacity';
  usedNonces.set(body.nonce, body.expiresAt);
  return 'ok';
}

async function boundedResponseText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPSTREAM_BYTES) {
    throw new Error('UPSTREAM_TOO_LARGE');
  }
  if (!response.body) throw new Error('UPSTREAM_INVALID_RESPONSE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > MAX_UPSTREAM_BYTES) {
      await reader.cancel('response limit exceeded');
      throw new Error('UPSTREAM_TOO_LARGE');
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function createGatewayServer(
  configuration: GatewayConfiguration,
  dependencies: GatewayDependencies = {},
): GatewayRuntime {
  if (configuration.sessionSecret.length < 32) {
    throw new Error('BROWSER_CORTEX_GATEWAY_SESSION must be an unpredictable value of at least 32 characters.');
  }
  if (!configuration.allowedHost) throw new Error('The allowed Host must be explicit.');
  if (!configuration.simulated && (
    !configuration.upstreamUrl ||
    !configuration.upstreamKey ||
    !configuration.configuredModel
  )) {
    throw new Error('Configure one fixed upstream URL, key, and model, or explicitly use simulated demo mode.');
  }

  const allowedOrigins = new Set(configuration.allowedOrigins);
  const expectedDestination = configuration.simulated
    ? SIMULATED_DESTINATION
    : normalizeLiveDestination(configuration.upstreamUrl ?? '');
  const expectedModel = configuration.simulated ? SIMULATED_MODEL : configuration.configuredModel ?? '';
  const fetchUpstream = dependencies.fetch ?? globalThis.fetch;
  const currentTime = dependencies.now ?? Date.now;
  const log = dependencies.log ?? ((entry: string) => console.info(entry));
  const upstreamTimeoutMs = dependencies.upstreamTimeoutMs ?? MAX_UPSTREAM_TIMEOUT_MS;
  const usedNonces = new Map<string, number>();

  if (
    !Number.isSafeInteger(upstreamTimeoutMs) ||
    upstreamTimeoutMs < 1 ||
    upstreamTimeoutMs > MAX_UPSTREAM_TIMEOUT_MS
  ) {
    throw new Error('Invalid upstream timeout.');
  }

  async function callUpstream(payload: string): Promise<string> {
    if (configuration.simulated) return `Simulated endpoint received ${payload.length} sanitized characters.`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), upstreamTimeoutMs);
    try {
      const response = await fetchUpstream(expectedDestination, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${configuration.upstreamKey ?? ''}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: expectedModel,
          messages: [{ role: 'user', content: payload }],
          max_tokens: 512,
        }),
      });
      if (response.redirected || response.url !== expectedDestination) {
        throw new Error('UPSTREAM_REDIRECTED');
      }
      if (!response.ok) throw new Error(`UPSTREAM_${response.status}`);
      const text = await boundedResponseText(response);
      let json: { choices?: Array<{ message?: { content?: unknown } }> };
      try {
        json = JSON.parse(text) as typeof json;
      } catch {
        throw new Error('UPSTREAM_INVALID_RESPONSE');
      }
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.length > 48_000) {
        throw new Error('UPSTREAM_INVALID_RESPONSE');
      }
      return content;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('UPSTREAM_')) throw error;
      throw new Error(controller.signal.aborted ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE');
    } finally {
      clearTimeout(timeout);
    }
  }

  const server = createServer(async (request, response) => {
    const origin = request.headers.origin;
    if (
      request.headers.host !== configuration.allowedHost ||
      !origin ||
      !allowedOrigins.has(origin)
    ) {
      send(response, 403, { error: 'ORIGIN_DENIED' }, allowedOrigins);
      return;
    }
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
      response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      response.setHeader('Vary', 'Origin');
      response.statusCode = 204;
      response.end();
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/assist') {
      send(response, 404, { error: 'NOT_FOUND' }, allowedOrigins, origin);
      return;
    }
    if (!authentic(request, configuration.sessionSecret)) {
      send(response, 401, { error: 'AUTHENTICATION_REQUIRED' }, allowedOrigins, origin);
      return;
    }
    if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      send(response, 415, { error: 'JSON_REQUIRED' }, allowedOrigins, origin);
      return;
    }

    try {
      const body = requestSchema.parse(await readBody(request));
      if (body.model !== expectedModel) {
        send(response, 400, { error: 'MODEL_NOT_ALLOWED' }, allowedOrigins, origin);
        return;
      }
      if (body.destination !== expectedDestination) {
        send(response, 400, { error: 'DESTINATION_NOT_ALLOWED' }, allowedOrigins, origin);
        return;
      }
      if (!validFingerprint(body)) {
        send(response, 400, { error: 'DISCLOSURE_MISMATCH' }, allowedOrigins, origin);
        return;
      }
      const disclosure = consumeDisclosure(body, currentTime(), usedNonces);
      if (disclosure !== 'ok') {
        const status = disclosure === 'replay' ? 409 : disclosure === 'capacity' ? 503 : 400;
        send(
          response,
          status,
          { error: `DISCLOSURE_${disclosure.toUpperCase()}` },
          allowedOrigins,
          origin,
        );
        return;
      }

      const output = await callUpstream(body.payload);
      send(response, 200, {
        schemaVersion: 1,
        model: expectedModel,
        output,
      }, allowedOrigins, origin);
      log(JSON.stringify({
        requestId: body.requestId,
        mode: configuration.simulated ? 'simulated' : 'live',
        status: 'completed',
      }));
    } catch (error) {
      const rawCode = error instanceof Error ? error.message : '';
      const code = rawCode.startsWith('UPSTREAM_') || [
        'REQUEST_TOO_LARGE',
        'INVALID_JSON',
      ].includes(rawCode) ? rawCode : 'INVALID_REQUEST';
      const status = code === 'REQUEST_TOO_LARGE' ? 413 : code.startsWith('UPSTREAM_') ? 502 : 400;
      send(response, status, { error: code }, allowedOrigins, origin);
    }
  });

  server.requestTimeout = 60_000;
  server.headersTimeout = 10_000;
  return { server, expectedDestination, expectedModel };
}
