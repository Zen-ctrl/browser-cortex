import {
  createMessage,
  type BrokerResponse,
  type MessageEnvelope,
} from '../shared/messages';

function parseResponse(value: unknown): BrokerResponse {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || typeof (value as Record<string, unknown>).ok !== 'boolean'
  ) {
    throw new Error('The extension broker returned an invalid response.');
  }
  return value as BrokerResponse;
}

export async function sendBroker(
  type: MessageEnvelope['type'],
  payload: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = parseResponse(await chrome.runtime.sendMessage(createMessage(type, payload)));
  if (!response.ok) throw new Error(response.error?.message ?? 'The extension broker rejected the request.');
  return response.data ?? {};
}
