import { describe, expect, it } from 'vitest';

import {
  approvalBindingForDisclosure,
  createDisclosure,
  detectSensitiveData,
  redactSensitiveData,
  rehydrateText,
} from '../src/index.js';

describe('sensitive-data handling', () => {
  it('detects, merges, redacts, and only rehydrates exact request placeholders', () => {
    const text = 'Contact demo@example.test with card 4242 4242 4242 4242.';
    const detections = detectSensitiveData(text);
    expect(detections.map((item) => item.category)).toEqual(
      expect.arrayContaining(['email', 'payment-card']),
    );
    const redacted = redactSensitiveData(text, detections);
    expect(redacted.sanitizedText).not.toContain('demo@example.test');
    expect(redacted.sanitizedText).not.toContain('4242 4242 4242 4242');
    const known = redacted.entries[0]?.placeholder;
    expect(known).toBeDefined();
    const response = `${known} [[BCX_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_9_bbbbbbbbbbbbbbbb]]`;
    const restored = rehydrateText(response, redacted.replacementMap);
    expect(restored.unresolvedPlaceholders).toHaveLength(1);
    expect(restored.text).toContain('[[BCX_aaaaaaaa');
  });

  it('rejects ordinary insecure remote endpoints', async () => {
    await expect(
      createDisclosure({
        disclosureId: 'disclosure-1',
        endpoint: 'http://remote.example/respond',
        modelLabel: 'model-1',
        sanitizedPayload: { input: 'safe' },
        sourceRevisions: [],
        detectedCategories: [],
        limitations: ['Synthetic test.'],
        policyVersion: 'policy-1',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('fails closed instead of dropping later restricted spans at the detection cap', () => {
    const header = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
    const footer = ['-----END', 'PRIVATE KEY-----'].join(' ');
    const crowded = `${Array.from({ length: 8 }, (_, index) => `demo${index}@example.test`).join(' ')}\n${header}\nSYNTHETIC_ONLY\n${footer}`;
    expect(() => detectSensitiveData(crowded, { maxDetections: 1 })).toThrowError(
      expect.objectContaining({ code: 'SENSITIVE_DATA_BLOCKED' }),
    );
  });

  it('binds the exact canonical payload into the disclosure', async () => {
    const disclosure = await createDisclosure({
      disclosureId: 'disclosure-1',
      endpoint: 'https://gateway.example/respond',
      modelLabel: 'model-1',
      sanitizedPayload: { z: 2, a: 'safe' },
      sourceRevisions: [{ sourceId: 'source-1', revision: 'r1' }],
      detectedCategories: ['email'],
      limitations: ['Detection is not a guarantee of anonymity.'],
      policyVersion: 'policy-1',
      now: 1_000,
    });
    expect(disclosure.serializedPayload).toBe('{"a":"safe","z":2}');
    expect(approvalBindingForDisclosure(disclosure).payloadFingerprint).toBe(
      disclosure.payloadFingerprint,
    );
  });

  it('rejects conflicting revisions for the same source', async () => {
    await expect(
      createDisclosure({
        disclosureId: 'disclosure-conflict',
        endpoint: 'https://gateway.example/respond',
        modelLabel: 'model-1',
        sanitizedPayload: { input: 'safe' },
        sourceRevisions: [
          { sourceId: 'source-1', revision: 'r1' },
          { sourceId: 'source-1', revision: 'r2' },
        ],
        detectedCategories: [],
        limitations: ['Synthetic test.'],
        policyVersion: 'policy-1',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
