export const MESSAGE_SCHEMA_VERSION = 1 as const;

export type PanelMessageType =
  | 'panel.status'
  | 'capture.selection'
  | 'capture.visible-content'
  | 'grant.review'
  | 'grant.create'
  | 'grant.status'
  | 'grant.revoke'
  | 'demo.read'
  | 'demo.action.preview'
  | 'demo.action.execute'
  | 'recording.start'
  | 'recording.stop'
  | 'recording.status'
  | 'recording.discard'
  | 'recording.compile'
  | 'workflow.replay.preview';

export type ContentMessageType =
  | 'content.ping'
  | 'content.capture-selection'
  | 'content.capture-visible'
  | 'content.recording-start'
  | 'content.recording-stop'
  | 'content.recording-bind'
  | 'content.recording-event'
  | 'content.integration-bind'
  | 'content.integration-inspect'
  | 'content.integration-write';

export interface MessageEnvelope {
  schemaVersion: typeof MESSAGE_SCHEMA_VERSION;
  requestId: string;
  type: PanelMessageType | ContentMessageType;
  sessionId?: string;
  payload: Record<string, unknown>;
}

const allowedTypes = new Set<MessageEnvelope['type']>([
  'panel.status', 'capture.selection', 'capture.visible-content',
  'grant.review', 'grant.create', 'grant.status', 'grant.revoke',
  'demo.read', 'demo.action.preview', 'demo.action.execute',
  'recording.start', 'recording.stop', 'recording.status', 'recording.discard', 'recording.compile',
  'workflow.replay.preview',
  'content.ping', 'content.capture-selection', 'content.capture-visible',
  'content.recording-start', 'content.recording-stop', 'content.recording-bind', 'content.recording-event',
  'content.integration-bind', 'content.integration-inspect', 'content.integration-write',
]);

export function createMessage(type: MessageEnvelope['type'], payload: Record<string, unknown> = {}, sessionId?: string): MessageEnvelope {
  return {
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    requestId: crypto.randomUUID(),
    type,
    payload,
    ...(sessionId ? { sessionId } : {}),
  };
}

export function isMessageEnvelope(value: unknown): value is MessageEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => !['schemaVersion', 'requestId', 'type', 'sessionId', 'payload'].includes(key))) return false;
  let payloadLength = Number.POSITIVE_INFINITY;
  try { payloadLength = JSON.stringify(record.payload).length; } catch { return false; }
  return record.schemaVersion === MESSAGE_SCHEMA_VERSION
    && typeof record.requestId === 'string'
    && record.requestId.length > 0
    && record.requestId.length <= 128
    && typeof record.type === 'string'
    && allowedTypes.has(record.type as MessageEnvelope['type'])
    && (record.sessionId === undefined || (typeof record.sessionId === 'string' && record.sessionId.length <= 128))
    && typeof record.payload === 'object'
    && record.payload !== null
    && !Array.isArray(record.payload)
    && payloadLength <= 64 * 1024;
}

export interface BrokerResponse {
  ok: boolean;
  requestId: string;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}

export function safeError(requestId: string, code: string, message: string): BrokerResponse {
  return { ok: false, requestId, error: { code, message } };
}
