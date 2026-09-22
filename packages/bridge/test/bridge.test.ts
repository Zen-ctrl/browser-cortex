import { describe, expect, it } from 'vitest';

import { ExtensionSessionRegistry, validateBridgeMessage } from '../src/index.js';

const sender = {
  tabId: 7,
  frameId: 0,
  origin: 'https://app.example',
  documentId: 'document-1',
  extensionId: 'extension-1',
} as const;

const toolScope = {
  allowedTools: [
    {
      name: 'demo.ticket.update',
      version: '1.0.0',
      allowedActionParameterKeys: ['ticketId', 'status'],
    },
  ],
} as const;

function actionPayload(parameters: Record<string, unknown> = { ticketId: 'ticket-1' }) {
  return {
    toolName: 'demo.ticket.update',
    toolVersion: '1.0.0',
    parameters,
  };
}

describe('extension bridge sessions', () => {
  it('binds browser sender identity and rejects replay', () => {
    const sessions = new ExtensionSessionRegistry();
    const session = sessions.create({
      ...sender,
      allowedMessageTypes: ['page.capture-selection'],
      now: 1_000,
    });
    const message = {
      schemaVersion: 1,
      requestId: 'request-1',
      messageType: 'page.capture-selection',
      sessionId: session.sessionId,
      documentId: sender.documentId,
      payload: { selectedText: 'Synthetic text.' },
    };
    expect(validateBridgeMessage(message, sender, sessions, 1_001)).toMatchObject({
      requestId: 'request-1',
    });
    try {
      validateBridgeMessage(message, sender, sessions, 1_002);
      throw new Error('Expected replay validation to fail.');
    } catch (error) {
      expect(error).toMatchObject({ code: 'DUPLICATE_REQUEST' });
    }
  });

  it('rejects forged authority and stale documents', () => {
    const sessions = new ExtensionSessionRegistry();
    const session = sessions.create({
      ...sender,
      allowedMessageTypes: ['page.request-action-preview'],
      toolScope,
      now: 1_000,
    });
    try {
      validateBridgeMessage(
        {
          schemaVersion: 1,
          requestId: 'request-2',
          messageType: 'page.request-action-preview',
          sessionId: session.sessionId,
          documentId: sender.documentId,
          payload: { ...actionPayload(), approved: true },
        },
        sender,
        sessions,
        1_001,
      );
      throw new Error('Expected forged approval validation to fail.');
    } catch (error) {
      expect(error).toMatchObject({ code: 'PERMISSION_DENIED' });
    }
    try {
      validateBridgeMessage(
        {
          schemaVersion: 1,
          requestId: 'request-3',
          messageType: 'page.request-action-preview',
          sessionId: session.sessionId,
          documentId: sender.documentId,
          payload: actionPayload(),
        },
        { ...sender, documentId: 'document-2' },
        sessions,
        1_001,
      );
      throw new Error('Expected stale document validation to fail.');
    } catch (error) {
      expect(error).toMatchObject({ code: 'STALE_DOCUMENT' });
    }
  });

  it('fails closed for a non-finite authorization clock', () => {
    const sessions = new ExtensionSessionRegistry();
    const session = sessions.create({
      ...sender,
      allowedMessageTypes: ['page.capture-selection'],
      now: 1_000,
    });
    expect(() =>
      validateBridgeMessage(
        {
          schemaVersion: 1,
          requestId: 'request-invalid-clock',
          messageType: 'page.capture-selection',
          sessionId: session.sessionId,
          documentId: sender.documentId,
          payload: { selectedText: 'Synthetic text.' },
        },
        sender,
        sessions,
        Number.NaN,
      ),
    ).toThrowError(expect.objectContaining({ code: 'SESSION_EXPIRED' }));
    expect(sessions.size).toBe(0);
  });

  it('binds source search to one workspace and an allowlisted source set', () => {
    const sessions = new ExtensionSessionRegistry();
    expect(() =>
      sessions.create({
        ...sender,
        allowedMessageTypes: ['page.request-source-search'],
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));

    const session = sessions.create({
      ...sender,
      allowedMessageTypes: ['page.request-source-search'],
      sourceSearchScope: {
        workspaceId: 'workspace-1',
        allowedSourceIds: ['source-1', 'source-2'],
        maxResults: 10,
      },
      now: 1_000,
    });
    const envelope = {
      schemaVersion: 1,
      messageType: 'page.request-source-search',
      sessionId: session.sessionId,
      documentId: sender.documentId,
    } as const;
    expect(
      validateBridgeMessage(
        {
          ...envelope,
          requestId: 'request-search-valid',
          payload: {
            workspaceId: 'workspace-1',
            sourceIds: ['source-2'],
            query: 'Find the synthetic order.',
            limit: 5,
          },
        },
        sender,
        sessions,
        1_001,
      ),
    ).toMatchObject({ messageType: 'page.request-source-search' });

    for (const [requestId, payload] of [
      [
        'request-search-workspace',
        {
          workspaceId: 'workspace-2',
          sourceIds: ['source-2'],
          query: 'Find the synthetic order.',
          limit: 5,
        },
      ],
      [
        'request-search-source',
        {
          workspaceId: 'workspace-1',
          sourceIds: ['source-3'],
          query: 'Find the synthetic order.',
          limit: 5,
        },
      ],
      [
        'request-search-limit',
        {
          workspaceId: 'workspace-1',
          sourceIds: ['source-1'],
          query: 'Find the synthetic order.',
          limit: 11,
        },
      ],
    ] as const) {
      expect(() =>
        validateBridgeMessage(
          { ...envelope, requestId, payload },
          sender,
          sessions,
          1_002,
        ),
      ).toThrowError(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
    }
  });

  it('scopes tool descriptions, versions, and action parameter keys', () => {
    const sessions = new ExtensionSessionRegistry();
    const session = sessions.create({
      ...sender,
      allowedMessageTypes: ['page.describe-tools', 'page.request-action-preview'],
      toolScope,
      now: 1_000,
    });
    expect(
      validateBridgeMessage(
        {
          schemaVersion: 1,
          requestId: 'request-tools-valid',
          messageType: 'page.describe-tools',
          sessionId: session.sessionId,
          documentId: sender.documentId,
          payload: {
            tools: [
              {
                name: 'demo.ticket.update',
                version: '1.0.0',
                description: 'Preview a synthetic ticket update.',
                inputSchema: { type: 'object' },
                outputSchema: { type: 'object' },
                claimedEffect: 'local-write',
              },
            ],
          },
        },
        sender,
        sessions,
        1_001,
      ),
    ).toMatchObject({ messageType: 'page.describe-tools' });
    expect(() =>
      validateBridgeMessage(
        {
          schemaVersion: 1,
          requestId: 'request-tools-forged-version',
          messageType: 'page.describe-tools',
          sessionId: session.sessionId,
          documentId: sender.documentId,
          payload: {
            tools: [
              {
                name: 'demo.ticket.update',
                version: '2.0.0',
                description: 'Unscoped synthetic tool version.',
                inputSchema: { type: 'object' },
                outputSchema: { type: 'object' },
              },
            ],
          },
        },
        sender,
        sessions,
        1_002,
      ),
    ).toThrowError(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
    expect(
      validateBridgeMessage(
        {
          schemaVersion: 1,
          requestId: 'request-action-valid',
          messageType: 'page.request-action-preview',
          sessionId: session.sessionId,
          documentId: sender.documentId,
          payload: actionPayload({ ticketId: 'ticket-1', status: 'reviewed' }),
        },
        sender,
        sessions,
        1_003,
      ),
    ).toMatchObject({ messageType: 'page.request-action-preview' });
    expect(() =>
      validateBridgeMessage(
        {
          schemaVersion: 1,
          requestId: 'request-action-extra-parameter',
          messageType: 'page.request-action-preview',
          sessionId: session.sessionId,
          documentId: sender.documentId,
          payload: actionPayload({ ticketId: 'ticket-1', publish: true }),
        },
        sender,
        sessions,
        1_004,
      ),
    ).toThrowError(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
  });

  it('uses strict payload schemas and scopes cancellation to prior session requests', () => {
    const sessions = new ExtensionSessionRegistry();
    const session = sessions.create({
      ...sender,
      allowedMessageTypes: ['page.capture-selection', 'bridge.cancel'],
      now: 1_000,
    });
    expect(() =>
      validateBridgeMessage(
        {
          schemaVersion: 1,
          requestId: 'request-capture-extra',
          messageType: 'page.capture-selection',
          sessionId: session.sessionId,
          documentId: sender.documentId,
          payload: { selectedText: 'Synthetic text.', workspaceId: 'workspace-forged' },
        },
        sender,
        sessions,
        1_001,
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
    validateBridgeMessage(
      {
        schemaVersion: 1,
        requestId: 'request-capture-target',
        messageType: 'page.capture-selection',
        sessionId: session.sessionId,
        documentId: sender.documentId,
        payload: { selectedText: 'Synthetic text.' },
      },
      sender,
      sessions,
      1_002,
    );
    expect(
      validateBridgeMessage(
        {
          schemaVersion: 1,
          requestId: 'request-cancel-valid',
          messageType: 'bridge.cancel',
          sessionId: session.sessionId,
          documentId: sender.documentId,
          payload: { targetRequestId: 'request-capture-target' },
        },
        sender,
        sessions,
        1_003,
      ),
    ).toMatchObject({ messageType: 'bridge.cancel' });
    expect(() =>
      validateBridgeMessage(
        {
          schemaVersion: 1,
          requestId: 'request-cancel-forged',
          messageType: 'bridge.cancel',
          sessionId: session.sessionId,
          documentId: sender.documentId,
          payload: { targetRequestId: 'request-from-another-session' },
        },
        sender,
        sessions,
        1_004,
      ),
    ).toThrowError(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
  });
});
