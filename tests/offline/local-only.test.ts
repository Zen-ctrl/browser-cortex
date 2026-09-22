import { describe, expect, it, vi } from 'vitest';

import { EgressBroker, createCortex, type OnlineTransport } from '@browser-cortex/core';
import { ApprovalStore } from '@browser-cortex/policy';
import { approvalBindingForDisclosure, createDisclosure } from '@browser-cortex/privacy';

import { LOCAL_ONLY_REQUEST } from '../fixtures/adversarial.js';

describe('local-only behavior', () => {
  it('does not select online when the request denies it', async () => {
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
    const proposal = await cortex.propose(LOCAL_ONLY_REQUEST);
    expect(proposal.route).toMatchObject({
      route: 'unavailable',
      reasonCodes: ['ONLINE_POLICY_DENY'],
    });
    await cortex.dispose();
  });

  it('keeps transport disabled even when a valid approval exists', async () => {
    const disclosure = await createDisclosure({
      disclosureId: 'disclosure-offline',
      endpoint: 'https://gateway.example.invalid/v1/respond',
      modelLabel: 'synthetic-model-1',
      sanitizedPayload: { input: 'safe' },
      sourceRevisions: [],
      detectedCategories: [],
      limitations: ['Synthetic offline fixture.'],
      policyVersion: 'policy-1',
    });
    const approvals = new ApprovalStore();
    const approvalHandle = await approvals.issue(approvalBindingForDisclosure(disclosure));
    const send = vi.fn(async (_request: Parameters<OnlineTransport['send']>[0]) => {
      throw new Error('Transport must remain unused in local-only mode.');
    });
    const broker = new EgressBroker({
      approvalStore: approvals,
      transport: { send },
      validateApprovalContext: () => false,
    });

    await expect(broker.sendApproved({ disclosure, approvalHandle })).rejects.toMatchObject({
      code: 'ONLINE_DISABLED',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('does not silently escalate after a local runtime failure', async () => {
    const cortex = createCortex({
      routeEnvironment: () => ({
        policyVersion: 'policy-1',
        policyAllowed: true,
        localFailure: true,
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
    const proposal = await cortex.propose({ ...LOCAL_ONLY_REQUEST, onlinePolicy: 'ask' });
    expect(proposal.route).toMatchObject({
      route: 'unavailable',
      reasonCodes: ['LOCAL_EXECUTION_FAILED'],
    });
    await cortex.dispose();
  });
});
