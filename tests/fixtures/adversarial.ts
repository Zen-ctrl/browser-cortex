import type { BrowserSenderIdentity } from '@browser-cortex/bridge';
import type { TaskRequest } from '@browser-cortex/contracts';

export const SYNTHETIC_SECRET = 'PLANTED-SECRET-VALUE-91';

export const SYNTHETIC_SENDER: BrowserSenderIdentity = Object.freeze({
  tabId: 17,
  frameId: 0,
  origin: 'https://demo.example.invalid',
  documentId: 'document-demo-1',
  extensionId: 'extension-demo-1',
});

export const LOCAL_ONLY_REQUEST: TaskRequest = Object.freeze({
  schemaVersion: 1,
  requestId: 'request-local-only-1',
  task: 'summarize',
  input: 'Summarize only the selected synthetic note.',
  sourceIds: ['source-demo-1'],
  workspaceId: 'workspace-demo-1',
  onlinePolicy: 'deny',
});

export const MALICIOUS_HTML =
  '<img src=x onerror="globalThis.__synthetic_attack__=true"><script>throw new Error("unsafe")</script>';

export const UNKNOWN_PLACEHOLDER =
  '[[BCX_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_99_bbbbbbbbbbbbbbbb]]';

export const PROTOTYPE_POLLUTION_PAYLOAD = JSON.parse(
  '{"safe":"value","__proto__":{"polluted":true}}',
) as unknown;
