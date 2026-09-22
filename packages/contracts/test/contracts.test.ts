import { describe, expect, it } from 'vitest';

import {
  CortexError,
  canonicalize,
  createSafeError,
  parseTaskRequest,
  parseWorkflowDefinition,
  parseWorkflowReceipt,
  sha256Fingerprint,
  toSafeError,
} from '../src/index.js';

describe('versioned contracts', () => {
  const validRequest = {
    schemaVersion: 1,
    requestId: 'request-1',
    task: 'search',
    input: 'Find the delivery note.',
    sourceIds: ['source-1'],
    workspaceId: 'workspace-1',
    onlinePolicy: 'deny',
  } as const;

  it('rejects unknown fields and unsupported versions with stable errors', () => {
    expect(() => parseTaskRequest({ ...validRequest, approved: true })).toThrowError(CortexError);
    try {
      parseTaskRequest({ ...validRequest, schemaVersion: 2 });
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_SCHEMA_VERSION' });
    }
  });

  it('does not serialize causes into safe errors', () => {
    const error = createSafeError('INVALID_INPUT', { cause: new Error('planted-secret') });
    expect(JSON.stringify(error)).not.toContain('planted-secret');
  });

  it('replaces caller-controlled CortexError copy with the stable safe message', () => {
    const unsafe = new CortexError('INVALID_INPUT', 'planted-secret', {
      retryHint: 'send planted-secret elsewhere',
    });
    const safe = toSafeError(unsafe);
    expect(safe.message).toBe('The request is invalid.');
    expect(safe.retryHint).toBeUndefined();
    expect(JSON.stringify(safe)).not.toContain('planted-secret');
  });
});

describe('canonical fingerprints', () => {
  it('sorts object keys and creates a stable digest', async () => {
    expect(canonicalize({ z: 1, a: ['x', true] })).toBe('{"a":["x",true],"z":1}');
    await expect(sha256Fingerprint({ b: 2, a: 1 })).resolves.toBe(
      await sha256Fingerprint({ a: 1, b: 2 }),
    );
  });

  it('rejects unsafe object keys and non-finite values', () => {
    expect(() => canonicalize(JSON.parse('{"__proto__":{"polluted":true}}'))).toThrow();
    expect(() => canonicalize({ value: Number.POSITIVE_INFINITY })).toThrow();
  });
});

describe('workflow and receipt boundary contracts', () => {
  const workflow = {
    schemaVersion: 1,
    id: 'workflow-1',
    version: '1.0.0',
    name: 'Synthetic export',
    inputSchema: { csv: 'string' },
    requiredCapabilities: ['input:read'],
    sourceDependencies: [{ sourceId: 'source-1', revision: 'revision-1' }],
    toolDependencies: [],
    limits: { maxRows: 100, maxSteps: 2, maxDurationMs: 5_000 },
    steps: [{ id: 'parse', op: 'csv.parse', input: { ref: 'input.csv' }, output: 'rows' }],
  } as const;

  it('accepts strict versioned workflow and receipt boundaries', () => {
    expect(parseWorkflowDefinition(workflow).id).toBe('workflow-1');
    expect(parseWorkflowReceipt({
      schemaVersion: 1,
      receiptId: 'receipt-1',
      runId: 'run-1',
      workflowId: 'workflow-1',
      workflowVersion: '1.0.0',
      planFingerprint: 'a'.repeat(64),
      state: 'succeeded',
      sourceRevisions: [{ sourceId: 'source-1', revision: 'revision-1' }],
      steps: [{
        stepId: 'parse', operation: 'csv.parse', state: 'succeeded',
        startedAt: '2026-09-21T00:00:00.000Z', endedAt: '2026-09-21T00:00:00.001Z',
      }],
      startedAt: '2026-09-21T00:00:00.000Z',
      endedAt: '2026-09-21T00:00:00.001Z',
    }).state).toBe('succeeded');
  });

  it('rejects unknown fields, versions, and excessive nesting', () => {
    expect(() => parseWorkflowDefinition({ ...workflow, approved: true })).toThrowError(CortexError);
    expect(() => parseWorkflowDefinition({ ...workflow, schemaVersion: 2 })).toThrowError(CortexError);
    let nested: unknown = null;
    for (let index = 0; index < 40; index += 1) nested = [nested];
    expect(() => parseWorkflowDefinition({ ...workflow, steps: [{ ...workflow.steps[0], input: nested }] })).toThrowError(CortexError);
  });
});
