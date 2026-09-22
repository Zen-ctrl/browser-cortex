import {
  ApprovalBindingSchema,
  DisclosureSchema,
  LIMITS,
  canonicalize,
  createSafeError,
  parseVersioned,
  sha256Text,
  utf8ByteLength,
  type ApprovalBinding,
  type Disclosure,
  type JsonValue,
  type SourceRevision,
} from '@browser-cortex/contracts';

import type { SensitiveCategory } from './detectors.js';

export interface DisclosureInput {
  readonly disclosureId: string;
  readonly endpoint: string;
  readonly modelLabel: string;
  readonly sanitizedPayload: JsonValue;
  readonly sourceRevisions: readonly SourceRevision[];
  readonly detectedCategories: readonly SensitiveCategory[];
  readonly limitations: readonly string[];
  readonly policyVersion: string;
  readonly now?: number;
  readonly lifetimeMs?: number;
}

function validateEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw createSafeError('INVALID_INPUT');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw createSafeError('INVALID_INPUT');
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '') {
    throw createSafeError('INVALID_INPUT');
  }
  return url;
}

function normalizedSourceRevisions(input: readonly SourceRevision[]): SourceRevision[] {
  const sources = new Map<string, SourceRevision>();
  for (const source of input) {
    const existing = sources.get(source.sourceId);
    if (existing !== undefined && existing.revision !== source.revision) {
      throw createSafeError('INVALID_INPUT');
    }
    sources.set(source.sourceId, { sourceId: source.sourceId, revision: source.revision });
  }
  return [...sources.values()].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}

export async function createDisclosure(input: DisclosureInput): Promise<Disclosure> {
  const endpoint = validateEndpoint(input.endpoint).toString();
  const endpointOrigin = new URL(endpoint).origin;
  const serializedPayload = canonicalize(input.sanitizedPayload, { maxBytes: LIMITS.canonicalBytes });
  const payloadByteLength = utf8ByteLength(serializedPayload);
  const payloadFingerprint = await sha256Text(serializedPayload);
  const now = input.now ?? Date.now();
  const lifetimeMs = input.lifetimeMs ?? LIMITS.approvalLifetimeMs;
  if (!Number.isSafeInteger(now) || now < 0) throw createSafeError('INVALID_INPUT');
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0 || lifetimeMs > LIMITS.approvalLifetimeMs) {
    throw createSafeError('INVALID_INPUT');
  }
  if (now + lifetimeMs > Number.MAX_SAFE_INTEGER) throw createSafeError('INVALID_INPUT');
  return parseVersioned(DisclosureSchema, {
    schemaVersion: 1,
    disclosureId: input.disclosureId,
    endpoint,
    endpointOrigin,
    method: 'POST',
    modelLabel: input.modelLabel,
    serializedPayload,
    payloadByteLength,
    payloadFingerprint,
    sourceRevisions: normalizedSourceRevisions(input.sourceRevisions),
    detectedCategories: [...new Set(input.detectedCategories)].sort(),
    limitations: input.limitations,
    policyVersion: input.policyVersion,
    expiresAt: now + lifetimeMs,
  });
}

export function approvalBindingForDisclosure(disclosure: Disclosure): ApprovalBinding {
  const parsed = parseVersioned(DisclosureSchema, disclosure);
  return parseVersioned(ApprovalBindingSchema, {
    schemaVersion: 1,
    purpose: 'online-disclosure',
    payloadFingerprint: parsed.payloadFingerprint,
    endpoint: parsed.endpoint,
    method: parsed.method,
    model: parsed.modelLabel,
    sourceRevisions: parsed.sourceRevisions,
    policyVersion: parsed.policyVersion,
  });
}
