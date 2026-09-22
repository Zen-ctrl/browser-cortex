import { describe, expect, it } from 'vitest';

import {
  DEMO_INTEGRATION_ID,
  DEMO_INTEGRATION_VERSION,
  DEMO_RECORD_ID,
  compareDemoRecords,
  compileDemoRecording,
  parseCompiledDemoWorkflow,
  parseDemoSnapshot,
  type CompletedDemoRecording,
} from '../../apps/extension/src/shared/demo-contract';

const declarations = [
  {
    name: 'demo.records.read',
    version: DEMO_INTEGRATION_VERSION,
    effect: 'read',
    implementationId: 'northline-demo-record-reader',
  },
  {
    name: 'demo.ticket.status.set',
    version: DEMO_INTEGRATION_VERSION,
    effect: 'local-write',
    implementationId: 'northline-demo-ticket-status',
  },
] as const;

function snapshot() {
  return {
    integrationId: DEMO_INTEGRATION_ID,
    integrationVersion: DEMO_INTEGRATION_VERSION,
    pageIdentity: 'http://127.0.0.1:4174/',
    recordId: DEMO_RECORD_ID,
    currentStatus: 'Needs review',
    availableStatuses: ['Needs review', 'Approved', 'On hold'],
    purchaseOrder: {
      reference: DEMO_RECORD_ID,
      supplier: 'Atlas Synthetic Supply',
      quantity: 120,
      unitPriceMinor: 350,
      currency: 'USD',
      requestedDelivery: '2026-10-14',
    },
    invoice: {
      reference: DEMO_RECORD_ID,
      invoice: 'INV-DEMO-2048',
      supplier: 'Atlas Synthetic Supply',
      quantity: 125,
      unitPriceMinor: 350,
      currency: 'USD',
      requestedDelivery: '2026-10-14',
    },
    declarations,
  };
}

function recording(): CompletedDemoRecording {
  return {
    id: 'recording:test',
    origin: 'http://127.0.0.1:4174',
    sourceDocumentId: 'document-test',
    createdAt: 1_000,
    expiresAt: 61_000,
    events: [
      {
        operation: 'demo.ticket.status.set',
        recordId: DEMO_RECORD_ID,
        field: 'status',
        from: 'Needs review',
        to: 'Approved',
        integrationVersion: DEMO_INTEGRATION_VERSION,
        receivedAt: 1_100,
      },
      {
        operation: 'demo.ticket.status.set',
        recordId: DEMO_RECORD_ID,
        field: 'status',
        from: 'Approved',
        to: 'On hold',
        integrationVersion: DEMO_INTEGRATION_VERSION,
        receivedAt: 1_200,
      },
    ],
  };
}

describe('packaged demo integration contract', () => {
  it('computes the synthetic comparison in deterministic extension code', () => {
    const parsed = parseDemoSnapshot(snapshot());
    expect(compareDemoRecords(parsed)).toMatchObject({
      recordId: DEMO_RECORD_ID,
      quantityDifference: 5,
      monetaryDifferenceMinor: 1_750,
      currencyMismatch: false,
      supplierMatch: true,
      deliveryMatch: true,
    });
  });

  it('blocks a page declaration that lies about the reviewed write effect', () => {
    const forged = {
      ...snapshot(),
      declarations: [
        declarations[0],
        { ...declarations[1], effect: 'read' },
      ],
    };
    expect(() => parseDemoSnapshot(forged)).toThrow(/declarations/iu);
  });

  it('normalizes a semantic recording into one typed bounded workflow', async () => {
    const compiled = await compileDemoRecording(recording(), 'nextStatus');
    expect(compiled.eventCount).toBe(2);
    expect(compiled.replay.expectedCurrentStatus).toBe('Needs review');
    expect(compiled.variables[0]).toMatchObject({ name: 'nextStatus', defaultValue: 'On hold' });
    expect(compiled.workflow.steps.map((step) => step.op)).toEqual([
      'preview.show',
      'approval.require',
      'tool.invoke',
    ]);
    await expect(parseCompiledDemoWorkflow(compiled)).resolves.toMatchObject({
      planFingerprint: compiled.planFingerprint,
    });
  });

  it('rejects workflow tool drift even if saved JSON is otherwise well formed', async () => {
    const compiled = await compileDemoRecording(recording());
    const tampered = structuredClone(compiled);
    const write = tampered.workflow.steps[2];
    if (write) write.tool = { name: 'page.claimed.write', version: '1.0.0' };
    await expect(parseCompiledDemoWorkflow(tampered)).rejects.toThrow();
  });

  it('rejects review-step drift instead of trusting a recomputed imported plan', async () => {
    const compiled = await compileDemoRecording(recording());
    const tampered = structuredClone(compiled);
    const approval = tampered.workflow.steps[1];
    if (approval) approval.scope = 'page-claimed-approval';
    await expect(parseCompiledDemoWorkflow(tampered)).rejects.toThrow(/finite demo replay template/iu);
  });
});
