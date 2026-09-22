import {
  CapabilityGrantSchema,
  createSafeError,
  parseVersioned,
  type CapabilityGrant,
} from '@browser-cortex/contracts';

export interface CapabilityRequest {
  readonly subject: string;
  readonly originatingApplication: string;
  readonly workspaceId: string;
  readonly operation: string;
  readonly sourceIds: readonly string[];
  readonly toolVersion?: string;
  readonly parameterFingerprint?: string;
  readonly recipient?: string;
}

export type CapabilityDenialReason =
  | 'GRANT_NOT_FOUND'
  | 'GRANT_REVOKED'
  | 'GRANT_NOT_YET_ACTIVE'
  | 'GRANT_EXPIRED'
  | 'GRANT_EXHAUSTED'
  | 'INVALID_TIME'
  | 'INVALID_USAGE'
  | 'SUBJECT_MISMATCH'
  | 'APPLICATION_MISMATCH'
  | 'WORKSPACE_MISMATCH'
  | 'OPERATION_MISMATCH'
  | 'SOURCE_SCOPE_MISMATCH'
  | 'TOOL_VERSION_MISMATCH'
  | 'PARAMETER_MISMATCH'
  | 'RECIPIENT_MISMATCH';

export type CapabilityDecision =
  | { readonly allowed: true; readonly grantId: string; readonly usesRemaining: number }
  | { readonly allowed: false; readonly reason: CapabilityDenialReason };

function exactOptionalMatch(left: string | undefined, right: string | undefined): boolean {
  return left === right;
}

function isTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function immutableGrant(input: CapabilityGrant): CapabilityGrant {
  const sourceIds = [...input.sourceIds];
  Object.freeze(sourceIds);
  return Object.freeze({
    ...input,
    sourceIds,
  });
}

function sourceScopeAllows(grant: CapabilityGrant, requestedSourceIds: readonly string[]): boolean {
  const explicit = new Set(grant.sourceIds);
  return requestedSourceIds.every((sourceId) => {
    if (explicit.has(sourceId)) {
      return true;
    }
    return grant.sourceNamespace !== undefined && sourceId.startsWith(`${grant.sourceNamespace}:`);
  });
}

export function evaluateCapability(
  grantInput: CapabilityGrant,
  request: CapabilityRequest,
  usageCount = 0,
  now = Date.now(),
): CapabilityDecision {
  const grant = parseVersioned(CapabilityGrantSchema, grantInput);
  if (!isTimestamp(now)) return { allowed: false, reason: 'INVALID_TIME' };
  if (!Number.isSafeInteger(usageCount) || usageCount < 0) {
    return { allowed: false, reason: 'INVALID_USAGE' };
  }
  if (grant.revoked) return { allowed: false, reason: 'GRANT_REVOKED' };
  if (now < grant.issuedAt) return { allowed: false, reason: 'GRANT_NOT_YET_ACTIVE' };
  if (now >= grant.expiresAt) return { allowed: false, reason: 'GRANT_EXPIRED' };
  if (usageCount >= grant.usageLimit) return { allowed: false, reason: 'GRANT_EXHAUSTED' };
  if (grant.subject !== request.subject) return { allowed: false, reason: 'SUBJECT_MISMATCH' };
  if (grant.originatingApplication !== request.originatingApplication) {
    return { allowed: false, reason: 'APPLICATION_MISMATCH' };
  }
  if (grant.workspaceId !== request.workspaceId) return { allowed: false, reason: 'WORKSPACE_MISMATCH' };
  if (grant.operation !== request.operation) return { allowed: false, reason: 'OPERATION_MISMATCH' };
  if (!sourceScopeAllows(grant, request.sourceIds)) {
    return { allowed: false, reason: 'SOURCE_SCOPE_MISMATCH' };
  }
  if (!exactOptionalMatch(grant.toolVersion, request.toolVersion)) {
    return { allowed: false, reason: 'TOOL_VERSION_MISMATCH' };
  }
  if (!exactOptionalMatch(grant.parameterFingerprint, request.parameterFingerprint)) {
    return { allowed: false, reason: 'PARAMETER_MISMATCH' };
  }
  if (!exactOptionalMatch(grant.recipient, request.recipient)) {
    return { allowed: false, reason: 'RECIPIENT_MISMATCH' };
  }
  return {
    allowed: true,
    grantId: grant.grantId,
    usesRemaining: grant.usageLimit - usageCount - 1,
  };
}

export class GrantStore {
  readonly #grants = new Map<string, CapabilityGrant>();
  readonly #usage = new Map<string, number>();

  public add(input: unknown): CapabilityGrant {
    const grant = immutableGrant(parseVersioned(CapabilityGrantSchema, input));
    if (this.#grants.has(grant.grantId)) {
      throw createSafeError('INVALID_INPUT');
    }
    this.#grants.set(grant.grantId, grant);
    this.#usage.set(grant.grantId, 0);
    return grant;
  }

  public revoke(grantId: string): boolean {
    const grant = this.#grants.get(grantId);
    if (grant === undefined) return false;
    this.#grants.set(grantId, immutableGrant({ ...grant, revoked: true }));
    return true;
  }

  public remove(grantId: string): boolean {
    this.#usage.delete(grantId);
    return this.#grants.delete(grantId);
  }

  public authorize(
    grantId: string,
    request: CapabilityRequest,
    options: { readonly consume?: boolean; readonly now?: number } = {},
  ): CapabilityDecision {
    const grant = this.#grants.get(grantId);
    if (grant === undefined) return { allowed: false, reason: 'GRANT_NOT_FOUND' };
    const usageCount = this.#usage.get(grantId) ?? 0;
    const decision = evaluateCapability(grant, request, usageCount, options.now ?? Date.now());
    if (decision.allowed && (options.consume ?? true)) {
      this.#usage.set(grantId, usageCount + 1);
    }
    return decision;
  }

  public findAndAuthorize(
    request: CapabilityRequest,
    options: { readonly consume?: boolean; readonly now?: number } = {},
  ): CapabilityDecision {
    let lastReason: CapabilityDenialReason = 'GRANT_NOT_FOUND';
    for (const grant of this.#grants.values()) {
      const decision = this.authorize(grant.grantId, request, options);
      if (decision.allowed) return decision;
      lastReason = decision.reason;
    }
    return { allowed: false, reason: lastReason };
  }

  public get(grantId: string): CapabilityGrant | undefined {
    return this.#grants.get(grantId);
  }
}
