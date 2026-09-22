import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { EgressBroker, type OnlineTransport, type OnlineTransportResponse } from '@browser-cortex/core';
import { ApprovalStore } from '@browser-cortex/policy';
import { approvalBindingForDisclosure, createDisclosure } from '@browser-cortex/privacy';

async function runResponse(response: OnlineTransportResponse): Promise<unknown> {
  const disclosure = await createDisclosure({
    disclosureId: 'disclosure-response',
    endpoint: 'https://gateway.example.invalid/v1/respond',
    modelLabel: 'synthetic-model-1',
    sanitizedPayload: { input: 'safe' },
    sourceRevisions: [],
    detectedCategories: [],
    limitations: ['Synthetic security fixture.'],
    policyVersion: 'policy-1',
  });
  const approvals = new ApprovalStore();
  const approvalHandle = await approvals.issue(approvalBindingForDisclosure(disclosure));
  const transport: OnlineTransport = {
    send: vi.fn(async () => response),
  };
  return new EgressBroker({
    approvalStore: approvals,
    transport,
    onlineEnabled: true,
    validateApprovalContext: () => true,
  }).sendApproved({
    disclosure,
    approvalHandle,
  });
}

describe('online responses are bounded untrusted data', () => {
  it('rejects HTML content types', async () => {
    await expect(
      runResponse({
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: '<script>throw new Error("unsafe")</script>',
        finalUrl: 'https://gateway.example.invalid/v1/respond',
      }),
    ).rejects.toMatchObject({ code: 'RESPONSE_REJECTED' });
  });

  it('rejects unexpected response tool instructions', async () => {
    const fixturePath = fileURLToPath(
      new URL('../fixtures/malicious-online-response.json', import.meta.url),
    );
    const body = readFileSync(fixturePath, 'utf8');
    await expect(
      runResponse({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body,
        finalUrl: 'https://gateway.example.invalid/v1/respond',
      }),
    ).rejects.toBeDefined();
  });

  it('rejects redirected destinations', async () => {
    await expect(
      runResponse({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 1, output: 'safe' }),
        finalUrl: 'https://redirected.example.invalid/v1/respond',
      }),
    ).rejects.toMatchObject({ code: 'RESPONSE_REJECTED' });
  });

  it('rejects oversized streamed bodies', async () => {
    async function* excessiveBody(): AsyncIterable<Uint8Array> {
      yield new Uint8Array(600_000);
      yield new Uint8Array(600_000);
    }
    await expect(
      runResponse({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: excessiveBody(),
        finalUrl: 'https://gateway.example.invalid/v1/respond',
      }),
    ).rejects.toMatchObject({ code: 'RESPONSE_REJECTED' });
  });
});
