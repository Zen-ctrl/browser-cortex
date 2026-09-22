import {
  ApprovalBindingSchema,
  LIMITS,
  createSafeError,
  parseVersioned,
  sha256Fingerprint,
  type ApprovalBinding,
  type SourceRevision,
} from '@browser-cortex/contracts';

interface StoredApproval {
  readonly bindingFingerprint: string;
  readonly expiresAt: number;
  readonly issuedAt: number;
  readonly maxUses: number;
  uses: number;
}

export interface ApprovalIssueOptions {
  readonly now?: number;
  readonly lifetimeMs?: number;
  readonly maxUses?: number;
}

export type ApprovalDecision =
  | { readonly approved: true; readonly usesRemaining: number }
  | {
      readonly approved: false;
      readonly reason: 'UNKNOWN_HANDLE' | 'EXPIRED' | 'BINDING_MISMATCH' | 'EXHAUSTED';
    };

function randomHex(bytes: number): string {
  const data = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(data);
  let result = '';
  for (const byte of data) result += byte.toString(16).padStart(2, '0');
  return result;
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function isTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function normalizeSources(sourceRevisions: readonly SourceRevision[]): SourceRevision[] {
  const bySource = new Map<string, SourceRevision>();
  for (const source of sourceRevisions) {
    const existing = bySource.get(source.sourceId);
    if (existing !== undefined && existing.revision !== source.revision) {
      throw createSafeError('INVALID_INPUT');
    }
    bySource.set(source.sourceId, { sourceId: source.sourceId, revision: source.revision });
  }
  return [...bySource.values()].sort((left, right) => {
    const sourceOrder = left.sourceId.localeCompare(right.sourceId);
    return sourceOrder === 0 ? left.revision.localeCompare(right.revision) : sourceOrder;
  });
}

export function normalizeApprovalBinding(input: ApprovalBinding): ApprovalBinding {
  const parsed = parseVersioned(ApprovalBindingSchema, input);
  const endpoint = new URL(parsed.endpoint).toString();
  return parseVersioned(ApprovalBindingSchema, {
    ...parsed,
    endpoint,
    sourceRevisions: normalizeSources(parsed.sourceRevisions),
  });
}

export function createApprovalBinding(input: ApprovalBinding): ApprovalBinding {
  return normalizeApprovalBinding(input);
}

export async function fingerprintApprovalBinding(input: ApprovalBinding): Promise<string> {
  return sha256Fingerprint(normalizeApprovalBinding(input));
}

export class ApprovalStore {
  readonly #records = new Map<string, StoredApproval>();

  public async issue(input: ApprovalBinding, options: ApprovalIssueOptions = {}): Promise<string> {
    const now = options.now ?? Date.now();
    const lifetimeMs = options.lifetimeMs ?? LIMITS.approvalLifetimeMs;
    const maxUses = options.maxUses ?? 1;
    if (!isTimestamp(now)) throw createSafeError('INVALID_INPUT');
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0 || lifetimeMs > LIMITS.approvalLifetimeMs) {
      throw createSafeError('INVALID_INPUT');
    }
    if (!Number.isSafeInteger(maxUses) || maxUses <= 0 || maxUses > LIMITS.approvalUses) {
      throw createSafeError('INVALID_INPUT');
    }
    const bindingFingerprint = await fingerprintApprovalBinding(input);
    let handle: string;
    do {
      handle = `apv_${randomHex(32)}`;
    } while (this.#records.has(handle));
    if (now + lifetimeMs > Number.MAX_SAFE_INTEGER) throw createSafeError('INVALID_INPUT');
    this.#records.set(handle, {
      bindingFingerprint,
      issuedAt: now,
      expiresAt: now + lifetimeMs,
      maxUses,
      uses: 0,
    });
    return handle;
  }

  public async consume(
    handle: string,
    input: ApprovalBinding,
    now = Date.now(),
  ): Promise<ApprovalDecision> {
    if (!/^apv_[a-f0-9]{64}$/u.test(handle)) {
      return { approved: false, reason: 'UNKNOWN_HANDLE' };
    }
    const incomingFingerprint = await fingerprintApprovalBinding(input);
    const record = this.#records.get(handle);
    if (record === undefined) return { approved: false, reason: 'UNKNOWN_HANDLE' };
    if (!isTimestamp(now)) {
      this.#records.delete(handle);
      return { approved: false, reason: 'EXPIRED' };
    }
    if (now < record.issuedAt || now >= record.expiresAt) {
      this.#records.delete(handle);
      return { approved: false, reason: 'EXPIRED' };
    }
    if (record.uses >= record.maxUses) {
      this.#records.delete(handle);
      return { approved: false, reason: 'EXHAUSTED' };
    }
    if (!constantTimeEqual(record.bindingFingerprint, incomingFingerprint)) {
      return { approved: false, reason: 'BINDING_MISMATCH' };
    }
    record.uses += 1;
    const usesRemaining = record.maxUses - record.uses;
    if (usesRemaining === 0) this.#records.delete(handle);
    return { approved: true, usesRemaining };
  }

  public revoke(handle: string): boolean {
    return this.#records.delete(handle);
  }

  public purgeExpired(now = Date.now()): number {
    if (!isTimestamp(now)) throw createSafeError('INVALID_INPUT');
    let removed = 0;
    for (const [handle, record] of this.#records) {
      if (now < record.issuedAt || now >= record.expiresAt) {
        this.#records.delete(handle);
        removed += 1;
      }
    }
    return removed;
  }

  public get size(): number {
    return this.#records.size;
  }
}
