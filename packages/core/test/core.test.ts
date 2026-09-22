import { describe, expect, it, vi } from 'vitest';

import { ApprovalStore } from '@browser-cortex/policy';
import { approvalBindingForDisclosure, createDisclosure } from '@browser-cortex/privacy';
import {
  DeterministicRouter,
  EgressBroker,
  createCortex,
  type OnlineTransport,
} from '../src/index.js';

const baseRequest = {
  schemaVersion: 1,
  requestId: 'request-1',
  task: 'summarize',
  input: 'Summarize the selected note.',
  sourceIds: ['source-1'],
  workspaceId: 'workspace-1',
  onlinePolicy: 'ask',
} as const;

describe('deterministic routing', () => {
  it('never treats online as a fallback after a local failure', () => {
    const decision = new DeterministicRouter().decide(baseRequest, {
      policyVersion: 'policy-1',
      policyAllowed: true,
      local: { available: false, supportedTasks: [] },
      online: {
        configured: true,
        explicitlyRequested: true,
        approvedForSources: true,
        supportedTasks: ['summarize'],
      },
      localFailure: true,
    });
    expect(decision).toMatchObject({ route: 'unavailable', reasonCodes: ['LOCAL_EXECUTION_FAILED'] });
  });

  it('applies a deterministic policy denial before capability selection', () => {
    const decision = new DeterministicRouter().decide(
      { ...baseRequest, task: 'transform' },
      {
        policyVersion: 'policy-1',
        policyAllowed: false,
        policyDenialReason: 'SOURCE_REVOKED',
        local: { available: true, supportedTasks: ['transform'] },
        online: {
          configured: false,
          explicitlyRequested: false,
          approvedForSources: false,
          supportedTasks: [],
        },
      },
    );
    expect(decision.reasonCodes).toEqual(['SOURCE_REVOKED']);
  });
});

describe('SDK lifecycle', () => {
  it('requires explicit initialization without running adapter work during construction', async () => {
    const initialize = vi.fn(async () => undefined);
    const cortex = createCortex({
      initialize,
      routeEnvironment: () => ({
        policyVersion: 'policy-1',
        policyAllowed: true,
        local: { available: false, supportedTasks: [] },
        online: { configured: false, explicitlyRequested: false, approvedForSources: false, supportedTasks: [] },
      }),
    });

    expect(cortex.state).toBe('new');
    expect(initialize).not.toHaveBeenCalled();
    await expect(cortex.propose(baseRequest)).rejects.toMatchObject({ code: 'NOT_INITIALIZED' });
    await cortex.initialize();
    expect(initialize).toHaveBeenCalledOnce();
    expect(cortex.state).toBe('ready');
    await expect(cortex.initialize()).rejects.toMatchObject({ code: 'ALREADY_INITIALIZED' });
    await cortex.dispose();
  });

  it('keeps online execution separate from task proposals', async () => {
    const cortex = createCortex({
      routeEnvironment: () => ({
        policyVersion: 'policy-1',
        policyAllowed: true,
        local: { available: false, supportedTasks: [] },
        online: {
          configured: true,
          explicitlyRequested: true,
          approvedForSources: true,
          supportedTasks: ['summarize'],
        },
      }),
    });
    await cortex.initialize();
    const proposal = await cortex.propose(baseRequest);
    expect(proposal.route.route).toBe('online-model');
    await expect(cortex.execute(proposal)).rejects.toMatchObject({ code: 'DISCLOSURE_REQUIRED' });
    await cortex.dispose();
  });

  it('disposes deterministically while an injected local adapter is initializing', async () => {
    let release!: () => void;
    const started = new Promise<void>((resolve) => { release = resolve; });
    const cortex = createCortex({
      initialize: async () => started,
      routeEnvironment: () => ({
        policyVersion: 'policy-1', policyAllowed: true,
        local: { available: false, supportedTasks: [] },
        online: { configured: false, explicitlyRequested: false, approvedForSources: false, supportedTasks: [] },
      }),
    });
    const initialization = cortex.initialize();
    expect(cortex.state).toBe('initializing');
    await cortex.dispose();
    expect(cortex.state).toBe('disposed');
    release();
    await expect(initialization).rejects.toMatchObject({ code: 'DISPOSED' });
  });
});

describe('egress broker', () => {
  it('sends only the approved bytes through the injected transport', async () => {
    const disclosure = await createDisclosure({
      disclosureId: 'disclosure-1',
      endpoint: 'https://gateway.example/respond',
      modelLabel: 'model-1',
      sanitizedPayload: { input: 'safe payload' },
      sourceRevisions: [{ sourceId: 'source-1', revision: 'r1' }],
      detectedCategories: [],
      limitations: ['Synthetic fixture.'],
      policyVersion: 'policy-1',
    });
    const approvals = new ApprovalStore();
    const handle = await approvals.issue(approvalBindingForDisclosure(disclosure));
    const send = vi.fn(async (request: Parameters<OnlineTransport['send']>[0]) => ({
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ schemaVersion: 1, output: 'safe response' }),
      finalUrl: request.url,
    }));
    const broker = new EgressBroker({
      approvalStore: approvals,
      transport: { send },
      onlineEnabled: true,
      validateApprovalContext: (context) =>
        context.policyVersion === 'policy-1' &&
        context.sourceRevisions.length === 1 &&
        context.sourceRevisions[0]?.sourceId === 'source-1' &&
        context.sourceRevisions[0]?.revision === 'r1',
    });
    await expect(broker.sendApproved({ disclosure, approvalHandle: handle })).resolves.toMatchObject({
      output: 'safe response',
    });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0].body).toBe(disclosure.serializedPayload);
  });

  it('rechecks source revision state immediately before transport', async () => {
    const disclosure = await createDisclosure({
      disclosureId: 'disclosure-revoked',
      endpoint: 'https://gateway.example/respond',
      modelLabel: 'model-1',
      sanitizedPayload: { input: 'safe payload' },
      sourceRevisions: [{ sourceId: 'source-1', revision: 'r1' }],
      detectedCategories: [],
      limitations: ['Synthetic fixture.'],
      policyVersion: 'policy-1',
    });
    const approvals = new ApprovalStore();
    const handle = await approvals.issue(approvalBindingForDisclosure(disclosure));
    const send = vi.fn(async (_request: Parameters<OnlineTransport['send']>[0]) => {
      throw new Error('Transport must not be called for a revoked source.');
    });
    const broker = new EgressBroker({
      approvalStore: approvals,
      transport: { send },
      onlineEnabled: true,
      validateApprovalContext: () => false,
    });
    await expect(broker.sendApproved({ disclosure, approvalHandle: handle })).rejects.toMatchObject({
      code: 'APPROVAL_INVALID',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('does not call transport for a tampered disclosure', async () => {
    const disclosure = await createDisclosure({
      disclosureId: 'disclosure-2',
      endpoint: 'https://gateway.example/respond',
      modelLabel: 'model-1',
      sanitizedPayload: { input: 'safe payload' },
      sourceRevisions: [],
      detectedCategories: [],
      limitations: ['Synthetic fixture.'],
      policyVersion: 'policy-1',
    });
    const approvals = new ApprovalStore();
    const handle = await approvals.issue(approvalBindingForDisclosure(disclosure));
    const send = vi.fn(async (_request: Parameters<OnlineTransport['send']>[0]) => {
      throw new Error('Transport must not be called for a tampered disclosure.');
    });
    const broker = new EgressBroker({
      approvalStore: approvals,
      transport: { send },
      onlineEnabled: true,
      validateApprovalContext: () => true,
    });
    await expect(
      broker.sendApproved({
        disclosure: { ...disclosure, serializedPayload: '{"input":"changed"}' },
        approvalHandle: handle,
      }),
    ).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
    expect(send).not.toHaveBeenCalled();
  });

  it('revalidates policy and prevents concurrent execution of one proposal', async () => {
    let allowed = true;
    const executor = vi.fn(async () => {
      await Promise.resolve();
      return { ok: true };
    });
    const cortex = createCortex({
      routeEnvironment: () => ({
        policyVersion: allowed ? 'policy-1' : 'policy-2',
        policyAllowed: allowed,
        local: { available: false, supportedTasks: [] },
        online: { configured: false, explicitlyRequested: false, approvedForSources: false, supportedTasks: [] },
      }),
      deterministicExecutors: { search: executor },
    });
    await cortex.initialize();
    const request = { ...baseRequest, requestId: 'request-concurrent', task: 'search', onlinePolicy: 'deny' } as const;
    const proposal = await cortex.propose(request);
    const results = await Promise.allSettled([cortex.execute(proposal), cortex.execute(proposal)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(executor).toHaveBeenCalledOnce();

    const second = await cortex.propose({ ...request, requestId: 'request-revoked' });
    allowed = false;
    await expect(cortex.execute(second)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(executor).toHaveBeenCalledOnce();
    await cortex.dispose();
  });

});
