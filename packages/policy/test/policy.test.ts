import { describe, expect, it } from 'vitest';

import type { ApprovalBinding, CapabilityGrant } from '@browser-cortex/contracts';
import { ApprovalStore, GrantStore } from '../src/index.js';

describe('default-deny grants', () => {
  const grant: CapabilityGrant = {
    schemaVersion: 1,
    grantId: 'grant-1',
    subject: 'subject-1',
    originatingApplication: 'https://example.test',
    workspaceId: 'workspace-1',
    operation: 'source.read',
    sourceIds: ['source-1'],
    toolVersion: '1.0.0',
    issuedAt: 1_000,
    expiresAt: 2_000,
    usageLimit: 1,
    revoked: false,
  };

  it('requires every scoped field and consumes bounded use', () => {
    const store = new GrantStore();
    store.add(grant);
    const request = {
      subject: 'subject-1',
      originatingApplication: 'https://example.test',
      workspaceId: 'workspace-1',
      operation: 'source.read',
      sourceIds: ['source-1'],
      toolVersion: '1.0.0',
    };
    expect(store.authorize('grant-1', request, { now: 1_500 })).toMatchObject({ allowed: true });
    expect(store.authorize('grant-1', request, { now: 1_500 })).toEqual({
      allowed: false,
      reason: 'GRANT_EXHAUSTED',
    });
  });

  it('does not let a similar source expand authority', () => {
    const store = new GrantStore();
    store.add(grant);
    expect(
      store.authorize(
        'grant-1',
        {
          subject: 'subject-1',
          originatingApplication: 'https://example.test',
          workspaceId: 'workspace-1',
          operation: 'source.read',
          sourceIds: ['source-2'],
          toolVersion: '1.0.0',
        },
        { now: 1_500 },
      ),
    ).toEqual({ allowed: false, reason: 'SOURCE_SCOPE_MISMATCH' });
  });

  it('keeps stored scope immutable and rejects invalid clocks', () => {
    const store = new GrantStore();
    const added = store.add(grant);
    expect(Object.isFrozen(added.sourceIds)).toBe(true);
    expect(() => (added.sourceIds as string[]).push('source-2')).toThrow();
    expect(store.get('grant-1')?.sourceIds).toEqual(['source-1']);
    expect(
      store.authorize(
        'grant-1',
        {
          subject: 'subject-1',
          originatingApplication: 'https://example.test',
          workspaceId: 'workspace-1',
          operation: 'source.read',
          sourceIds: ['source-1'],
          toolVersion: '1.0.0',
        },
        { now: Number.NaN },
      ),
    ).toEqual({ allowed: false, reason: 'INVALID_TIME' });
  });
});

describe('opaque approval binding', () => {
  const binding: ApprovalBinding = {
    schemaVersion: 1,
    purpose: 'online-disclosure',
    payloadFingerprint: `sha256:${'a'.repeat(64)}`,
    endpoint: 'https://gateway.example/v1/respond',
    method: 'POST',
    model: 'model-1',
    sourceRevisions: [{ sourceId: 'source-1', revision: 'r1' }],
    policyVersion: 'policy-1',
  };

  it('is one-use and invalidated by any destination change', async () => {
    const approvals = new ApprovalStore();
    const handle = await approvals.issue(binding, { now: 1_000, lifetimeMs: 1_000 });
    await expect(
      approvals.consume(handle, { ...binding, endpoint: 'https://other.example/v1/respond' }, 1_500),
    ).resolves.toEqual({ approved: false, reason: 'BINDING_MISMATCH' });
    await expect(approvals.consume(handle, binding, 1_500)).resolves.toEqual({
      approved: true,
      usesRemaining: 0,
    });
    await expect(approvals.consume(handle, binding, 1_500)).resolves.toEqual({
      approved: false,
      reason: 'UNKNOWN_HANDLE',
    });
  });

  it('fails closed and consumes the handle when given a non-finite clock', async () => {
    const approvals = new ApprovalStore();
    const handle = await approvals.issue(binding, { now: 1_000, lifetimeMs: 1_000 });
    await expect(approvals.consume(handle, binding, Number.NaN)).resolves.toEqual({
      approved: false,
      reason: 'EXPIRED',
    });
    await expect(approvals.consume(handle, binding, 1_500)).resolves.toEqual({
      approved: false,
      reason: 'UNKNOWN_HANDLE',
    });
  });
});
