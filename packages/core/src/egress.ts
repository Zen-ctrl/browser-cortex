import {
  DisclosureSchema,
  LIMITS,
  OnlineProviderResponseSchema,
  createSafeError,
  parseVersioned,
  sha256Text,
  toSafeError,
  utf8ByteLength,
  type Disclosure,
  type OnlineProviderResponse,
  type SourceRevision,
} from '@browser-cortex/contracts';
import { ApprovalStore } from '@browser-cortex/policy';
import { approvalBindingForDisclosure } from '@browser-cortex/privacy';

export interface OnlineTransportRequest {
  readonly url: string;
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
  readonly redirect: 'error';
}

export interface OnlineTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | Uint8Array | AsyncIterable<Uint8Array>;
  readonly finalUrl: string;
}

export interface OnlineTransport {
  send(request: OnlineTransportRequest): Promise<OnlineTransportResponse>;
}

export interface EgressBrokerOptions {
  readonly approvalStore: ApprovalStore;
  readonly transport: OnlineTransport;
  readonly validateApprovalContext: (
    context: Readonly<{
      sourceRevisions: readonly SourceRevision[];
      policyVersion: string;
      endpoint: string;
      modelLabel: string;
    }>,
  ) => boolean | Promise<boolean>;
  readonly onlineEnabled?: boolean;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export interface ApprovedOnlineRequest {
  readonly disclosure: Disclosure;
  readonly approvalHandle: string;
  readonly signal?: AbortSignal;
}

function readHeader(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) return value;
  }
  return undefined;
}

async function readBoundedBody(
  body: OnlineTransportResponse['body'],
  maximum: number,
  signal: AbortSignal,
): Promise<string> {
  if (typeof body === 'string') {
    if (utf8ByteLength(body) > maximum) throw createSafeError('RESPONSE_REJECTED');
    return body;
  }
  if (body instanceof Uint8Array) {
    if (body.byteLength > maximum) throw createSafeError('RESPONSE_REJECTED');
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch (error) {
      throw createSafeError('RESPONSE_REJECTED', { cause: error });
    }
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of body) {
    if (signal.aborted) throw createSafeError('CANCELLED');
    if (!(chunk instanceof Uint8Array)) throw createSafeError('RESPONSE_REJECTED');
    byteLength += chunk.byteLength;
    if (byteLength > maximum) throw createSafeError('RESPONSE_REJECTED');
    chunks.push(chunk);
  }
  const combined = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(combined);
  } catch (error) {
    throw createSafeError('RESPONSE_REJECTED', { cause: error });
  }
}

function linkedAbortController(external: AbortSignal | undefined): {
  readonly controller: AbortController;
  readonly cleanup: () => void;
} {
  const controller = new AbortController();
  const abort = (): void => controller.abort(external?.reason);
  if (external?.aborted) abort();
  else external?.addEventListener('abort', abort, { once: true });
  return {
    controller,
    cleanup: () => external?.removeEventListener('abort', abort),
  };
}

export class EgressBroker {
  readonly #approvals: ApprovalStore;
  readonly #transport: OnlineTransport;
  readonly #onlineEnabled: boolean;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #validateApprovalContext: EgressBrokerOptions['validateApprovalContext'];

  public constructor(options: EgressBrokerOptions) {
    this.#approvals = options.approvalStore;
    this.#transport = options.transport;
    this.#onlineEnabled = options.onlineEnabled ?? false;
    this.#timeoutMs = Math.min(options.timeoutMs ?? LIMITS.onlineRequestTimeoutMs, LIMITS.onlineRequestTimeoutMs);
    this.#maxResponseBytes = Math.min(
      options.maxResponseBytes ?? LIMITS.generatedOutputBytes,
      LIMITS.generatedOutputBytes,
    );
    if (typeof options.validateApprovalContext !== 'function') throw createSafeError('INVALID_INPUT');
    this.#validateApprovalContext = options.validateApprovalContext;
    if (this.#timeoutMs <= 0 || this.#maxResponseBytes <= 0) throw createSafeError('INVALID_INPUT');
  }

  public async sendApproved(input: ApprovedOnlineRequest): Promise<OnlineProviderResponse> {
    if (!this.#onlineEnabled) throw createSafeError('ONLINE_DISABLED');
    if (input.signal?.aborted) throw createSafeError('CANCELLED');
    const disclosure = parseVersioned(DisclosureSchema, input.disclosure);
    if (Date.now() >= disclosure.expiresAt) throw createSafeError('APPROVAL_EXPIRED');
    const actualFingerprint = await sha256Text(disclosure.serializedPayload);
    if (actualFingerprint !== disclosure.payloadFingerprint) throw createSafeError('APPROVAL_INVALID');
    const approval = await this.#approvals.consume(
      input.approvalHandle,
      approvalBindingForDisclosure(disclosure),
    );
    if (!approval.approved) {
      throw createSafeError(approval.reason === 'EXPIRED' ? 'APPROVAL_EXPIRED' : 'APPROVAL_INVALID');
    }
    const revisions = Object.freeze(
      disclosure.sourceRevisions.map((source) => Object.freeze({ ...source })),
    );
    let current = false;
    try {
      current = await this.#validateApprovalContext(Object.freeze({
        sourceRevisions: revisions,
        policyVersion: disclosure.policyVersion,
        endpoint: disclosure.endpoint,
        modelLabel: disclosure.modelLabel,
      }));
    } catch (error) {
      throw createSafeError('APPROVAL_INVALID', { cause: error });
    }
    if (!current) throw createSafeError('APPROVAL_INVALID');
    if (Date.now() >= disclosure.expiresAt) throw createSafeError('APPROVAL_EXPIRED');
    if (input.signal?.aborted) throw createSafeError('CANCELLED');

    const { controller, cleanup } = linkedAbortController(input.signal);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort('timeout');
    }, this.#timeoutMs);

    try {
      const work = async (): Promise<OnlineProviderResponse> => {
        const response = await this.#transport.send({
          url: disclosure.endpoint,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: disclosure.serializedPayload,
          signal: controller.signal,
          redirect: 'error',
        });
        if (response.finalUrl !== disclosure.endpoint) throw createSafeError('RESPONSE_REJECTED');
        if (response.status < 200 || response.status >= 300) throw createSafeError('TRANSPORT_FAILED');
        const contentType = readHeader(response.headers, 'content-type')
          ?.split(';', 1)[0]
          ?.trim()
          .toLowerCase();
        if (contentType !== 'application/json') throw createSafeError('RESPONSE_REJECTED');
        const body = await readBoundedBody(response.body, this.#maxResponseBytes, controller.signal);
        let decoded: unknown;
        try {
          decoded = JSON.parse(body) as unknown;
        } catch (error) {
          throw createSafeError('RESPONSE_REJECTED', { cause: error });
        }
        return parseVersioned(OnlineProviderResponseSchema, decoded);
      };
      const aborted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => reject(createSafeError(timedOut ? 'TIMEOUT' : 'CANCELLED')),
          { once: true },
        );
      });
      return await Promise.race([work(), aborted]);
    } catch (error) {
      if (timedOut) throw createSafeError('TIMEOUT', { cause: error });
      if (input.signal?.aborted) throw createSafeError('CANCELLED', { cause: error });
      throw toSafeError(error, 'TRANSPORT_FAILED');
    } finally {
      clearTimeout(timeout);
      cleanup();
    }
  }
}
