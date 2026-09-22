import { describe, expect, it, vi } from 'vitest';

import { canonicalize, type Disclosure } from '@browser-cortex/contracts';
import { EgressBroker, type OnlineTransport } from '@browser-cortex/core';
import { ApprovalStore } from '@browser-cortex/policy';
import {
  approvalBindingForDisclosure,
  createDisclosure,
  detectSensitiveData,
  redactSensitiveData,
  rehydrateText,
} from '@browser-cortex/privacy';

import {
  MALICIOUS_HTML,
  PROTOTYPE_POLLUTION_PAYLOAD,
  SYNTHETIC_SECRET,
  UNKNOWN_PLACEHOLDER,
} from '../fixtures/adversarial.js';

async function disclosureFor(payload: Record<string, string>, id: string): Promise<Disclosure> {
  return createDisclosure({
    disclosureId: id,
    endpoint: 'https://gateway.example.invalid/v1/respond',
    modelLabel: 'synthetic-model-1',
    sanitizedPayload: payload,
    sourceRevisions: [{ sourceId: 'source-demo-1', revision: 'revision-1' }],
    detectedCategories: [],
    limitations: ['Synthetic security fixture.'],
    policyVersion: 'policy-1',
  });
}

function successfulTransport(capturedBodies: string[]): OnlineTransport {
  return {
    send: vi.fn(async (request: Parameters<OnlineTransport['send']>[0]) => {
      capturedBodies.push(request.body);
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 1, output: 'Synthetic response.' }),
        finalUrl: request.url,
      };
    }),
  };
}

describe('approval and egress boundaries', () => {
  it('rejects forged approval handles without invoking transport', async () => {
    const disclosure = await disclosureFor({ input: 'safe' }, 'disclosure-forged');
    const transport = successfulTransport([]);
    const broker = new EgressBroker({
      approvalStore: new ApprovalStore(),
      transport,
      onlineEnabled: true,
      validateApprovalContext: () => true,
    });

    await expect(
      broker.sendApproved({
        disclosure,
        approvalHandle: `apv_${'0'.repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('invalidates approval when the final payload changes', async () => {
    const original = await disclosureFor({ input: 'original' }, 'disclosure-original');
    const changed = await disclosureFor({ input: 'changed' }, 'disclosure-changed');
    const approvals = new ApprovalStore();
    const approvalHandle = await approvals.issue(approvalBindingForDisclosure(original));
    const transport = successfulTransport([]);
    const broker = new EgressBroker({
      approvalStore: approvals,
      transport,
      onlineEnabled: true,
      validateApprovalContext: (context) =>
        context.policyVersion === 'policy-1' &&
        context.sourceRevisions.length === 1 &&
        context.sourceRevisions[0]?.sourceId === 'source-demo-1' &&
        context.sourceRevisions[0]?.revision === 'revision-1',
    });

    await expect(broker.sendApproved({ disclosure: changed, approvalHandle })).rejects.toMatchObject({
      code: 'APPROVAL_INVALID',
    });
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('keeps a planted secret out of the exact outgoing bytes', async () => {
    const sourceText = `Synthetic record contains ${SYNTHETIC_SECRET}.`;
    const detections = detectSensitiveData(sourceText, { customTerms: [SYNTHETIC_SECRET] });
    const redaction = redactSensitiveData(sourceText, detections);
    const disclosure = await createDisclosure({
      disclosureId: 'disclosure-redacted',
      endpoint: 'https://gateway.example.invalid/v1/respond',
      modelLabel: 'synthetic-model-1',
      sanitizedPayload: { input: redaction.sanitizedText },
      sourceRevisions: [{ sourceId: 'source-demo-1', revision: 'revision-1' }],
      detectedCategories: detections.map((item) => item.category),
      limitations: ['Synthetic security fixture.'],
      policyVersion: 'policy-1',
    });
    const approvals = new ApprovalStore();
    const approvalHandle = await approvals.issue(approvalBindingForDisclosure(disclosure));
    const capturedBodies: string[] = [];
    const transport = successfulTransport(capturedBodies);
    const broker = new EgressBroker({
      approvalStore: approvals,
      transport,
      onlineEnabled: true,
      validateApprovalContext: () => true,
    });

    await broker.sendApproved({ disclosure, approvalHandle });
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0]).not.toContain(SYNTHETIC_SECRET);
    expect(capturedBodies[0]).toBe(disclosure.serializedPayload);
  });

  it('blocks a revoked or changed source revision before transport', async () => {
    const disclosure = await disclosureFor({ input: 'safe' }, 'disclosure-revoked-source');
    const approvals = new ApprovalStore();
    const approvalHandle = await approvals.issue(approvalBindingForDisclosure(disclosure));
    const transport = successfulTransport([]);
    const broker = new EgressBroker({
      approvalStore: approvals,
      transport,
      onlineEnabled: true,
      validateApprovalContext: () => false,
    });
    await expect(broker.sendApproved({ disclosure, approvalHandle })).rejects.toMatchObject({
      code: 'APPROVAL_INVALID',
    });
    expect(transport.send).not.toHaveBeenCalled();
  });
});

describe('hostile data remains inert', () => {
  it('rejects prototype-polluting JSON during canonicalization', () => {
    expect(() => canonicalize(PROTOTYPE_POLLUTION_PAYLOAD)).toThrow();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('returns malicious HTML and unknown placeholders only as text', () => {
    const result = rehydrateText(`${MALICIOUS_HTML} ${UNKNOWN_PLACEHOLDER}`, new Map());
    expect(result.text).toContain(MALICIOUS_HTML);
    expect(result.text).toContain(UNKNOWN_PLACEHOLDER);
    expect(result.unresolvedPlaceholders).toEqual([UNKNOWN_PLACEHOLDER]);
    expect((globalThis as { __synthetic_attack__?: boolean }).__synthetic_attack__).toBeUndefined();
  });
});
