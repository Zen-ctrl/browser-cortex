import { describe, expect, it } from 'vitest';

import {
  ExtensionSessionRegistry,
  parseBridgeMessage,
  validateBridgeMessage,
} from '@browser-cortex/bridge';

import {
  PROTOTYPE_POLLUTION_PAYLOAD,
  SYNTHETIC_SENDER,
} from '../fixtures/adversarial.js';

function message(
  sessionId: string,
  requestId: string,
  payload: unknown = { selectedText: 'Synthetic text.' },
) {
  return {
    schemaVersion: 1,
    requestId,
    messageType: 'page.capture-selection',
    sessionId,
    documentId: SYNTHETIC_SENDER.documentId,
    payload,
  };
}

describe('extension message trust boundary', () => {
  it('rejects page-supplied approval claims', () => {
    const sessions = new ExtensionSessionRegistry();
    const session = sessions.create({
      ...SYNTHETIC_SENDER,
      allowedMessageTypes: ['page.request-action-preview'],
      toolScope: {
        allowedTools: [
          {
            name: 'demo.ticket.update',
            version: '1.0.0',
            allowedActionParameterKeys: ['ticketId'],
          },
        ],
      },
    });
    expect(() =>
      validateBridgeMessage(
        {
          schemaVersion: 1,
          requestId: 'request-forged-approval',
          messageType: 'page.request-action-preview',
          sessionId: session.sessionId,
          documentId: SYNTHETIC_SENDER.documentId,
          payload: {
            toolName: 'demo.ticket.update',
            toolVersion: '1.0.0',
            parameters: { ticketId: 'ticket-1', nested: { approved: true } },
          },
        },
        SYNTHETIC_SENDER,
        sessions,
      ),
    ).toThrow();
  });

  it('rejects stale document identity, wrong frames, and replay', () => {
    const sessions = new ExtensionSessionRegistry();
    const session = sessions.create({
      ...SYNTHETIC_SENDER,
      allowedMessageTypes: ['page.capture-selection'],
      now: 10_000,
    });
    expect(() =>
      validateBridgeMessage(
        message(session.sessionId, 'request-wrong-frame'),
        { ...SYNTHETIC_SENDER, frameId: 1 },
        sessions,
        10_001,
      ),
    ).toThrow();
    const valid = message(session.sessionId, 'request-once');
    expect(validateBridgeMessage(valid, SYNTHETIC_SENDER, sessions, 10_002)).toBeDefined();
    expect(() => validateBridgeMessage(valid, SYNTHETIC_SENDER, sessions, 10_003)).toThrow();
    expect(sessions.invalidateDocument(17, 0, 'document-demo-2')).toBe(1);
    expect(() =>
      validateBridgeMessage(
        message(session.sessionId, 'request-after-navigation'),
        SYNTHETIC_SENDER,
        sessions,
        10_004,
      ),
    ).toThrow();
  });

  it('rejects prototype keys and oversized control messages', () => {
    expect(() =>
      parseBridgeMessage({
        schemaVersion: 1,
        requestId: 'request-prototype',
        messageType: 'page.capture-selection',
        sessionId: `ses_${'a'.repeat(64)}`,
        documentId: SYNTHETIC_SENDER.documentId,
        payload: PROTOTYPE_POLLUTION_PAYLOAD,
      }),
    ).toThrow();
    expect(() =>
      parseBridgeMessage({
        schemaVersion: 1,
        requestId: 'request-oversized',
        messageType: 'page.capture-selection',
        sessionId: `ses_${'a'.repeat(64)}`,
        documentId: SYNTHETIC_SENDER.documentId,
        payload: { selectedText: 'x'.repeat(70_000) },
      }),
    ).toThrow();
  });

  it('does not let page content expand workspace or source authority', () => {
    const sessions = new ExtensionSessionRegistry();
    const session = sessions.create({
      ...SYNTHETIC_SENDER,
      allowedMessageTypes: ['page.request-source-search'],
      sourceSearchScope: {
        workspaceId: 'workspace-demo-1',
        allowedSourceIds: ['source-demo-1'],
        maxResults: 5,
      },
      now: 10_000,
    });
    const base = {
      schemaVersion: 1,
      messageType: 'page.request-source-search',
      sessionId: session.sessionId,
      documentId: SYNTHETIC_SENDER.documentId,
    } as const;
    expect(
      validateBridgeMessage(
        {
          ...base,
          requestId: 'request-search-allowed',
          payload: {
            workspaceId: 'workspace-demo-1',
            sourceIds: ['source-demo-1'],
            query: 'Find the synthetic quantity.',
            limit: 5,
          },
        },
        SYNTHETIC_SENDER,
        sessions,
        10_001,
      ),
    ).toMatchObject({ messageType: 'page.request-source-search' });
    expect(() =>
      validateBridgeMessage(
        {
          ...base,
          requestId: 'request-search-forged-workspace',
          payload: {
            workspaceId: 'workspace-other',
            sourceIds: ['source-demo-1'],
            query: 'Search everything.',
            limit: 5,
          },
        },
        SYNTHETIC_SENDER,
        sessions,
        10_002,
      ),
    ).toThrowError(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
    expect(() =>
      validateBridgeMessage(
        {
          ...base,
          requestId: 'request-search-forged-source',
          payload: {
            workspaceId: 'workspace-demo-1',
            sourceIds: ['source-private-other'],
            query: 'Search everything.',
            limit: 5,
          },
        },
        SYNTHETIC_SENDER,
        sessions,
        10_003,
      ),
    ).toThrowError(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
  });
});
