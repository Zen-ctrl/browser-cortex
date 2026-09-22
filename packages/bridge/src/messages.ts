import {
  IdentifierSchema,
  JsonValueSchema,
  LIMITS,
  assertJsonValue,
  canonicalize,
  createSafeError,
  parseVersioned,
  type JsonValue,
} from '@browser-cortex/contracts';
import { z } from 'zod';

export const BridgeMessageTypeSchema = z.enum([
  'page.capture-selection',
  'page.describe-tools',
  'page.request-source-search',
  'page.request-action-preview',
  'bridge.cancel',
]);
export type BridgeMessageType = z.infer<typeof BridgeMessageTypeSchema>;

export const BridgeToolVersionSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/u, 'Tool version contains unsupported characters.');

const SessionIdSchema = z.string().regex(/^ses_[a-f0-9]{64}$/u);
const SourceIdsSchema = z
  .array(IdentifierSchema)
  .min(1)
  .max(LIMITS.sourceIds)
  .refine((sourceIds) => new Set(sourceIds).size === sourceIds.length, {
    message: 'Source identifiers must be unique.',
  });

const ParameterObjectSchema = z.record(
  z.string().min(1).max(LIMITS.identifierCharacters),
  JsonValueSchema,
);

export const PageToolDescriptionSchema = z.strictObject({
  name: IdentifierSchema,
  version: BridgeToolVersionSchema,
  description: z.string().min(1).max(1_024),
  inputSchema: JsonValueSchema,
  outputSchema: JsonValueSchema,
  claimedEffect: z.enum(['read', 'local-write', 'external-write']).optional(),
});
export type PageToolDescription = z.infer<typeof PageToolDescriptionSchema>;

const CommonEnvelopeShape = {
  schemaVersion: z.literal(1),
  requestId: IdentifierSchema,
  sessionId: SessionIdSchema,
  documentId: IdentifierSchema,
} as const;

export const CaptureSelectionMessageSchema = z.strictObject({
  ...CommonEnvelopeShape,
  messageType: z.literal('page.capture-selection'),
  payload: z.strictObject({
    selectedText: z.string().min(1).max(LIMITS.selectedPageCharacters),
  }),
});

export const DescribeToolsMessageSchema = z.strictObject({
  ...CommonEnvelopeShape,
  messageType: z.literal('page.describe-tools'),
  payload: z
    .strictObject({
      tools: z.array(PageToolDescriptionSchema).min(1).max(32),
    })
    .refine(
      ({ tools }) => new Set(tools.map((tool) => `${tool.name}\u0000${tool.version}`)).size === tools.length,
      { message: 'Tool descriptions must be unique by name and version.' },
    ),
});

export const SourceSearchMessageSchema = z.strictObject({
  ...CommonEnvelopeShape,
  messageType: z.literal('page.request-source-search'),
  payload: z.strictObject({
    workspaceId: IdentifierSchema,
    sourceIds: SourceIdsSchema,
    query: z.string().min(1).max(LIMITS.taskInstructionCharacters),
    limit: z.number().int().positive().max(100),
  }),
});

export const ActionPreviewMessageSchema = z.strictObject({
  ...CommonEnvelopeShape,
  messageType: z.literal('page.request-action-preview'),
  payload: z.strictObject({
    toolName: IdentifierSchema,
    toolVersion: BridgeToolVersionSchema,
    parameters: ParameterObjectSchema,
  }),
});

export const CancelMessageSchema = z.strictObject({
  ...CommonEnvelopeShape,
  messageType: z.literal('bridge.cancel'),
  payload: z.strictObject({
    targetRequestId: IdentifierSchema,
  }),
});

export const BridgeMessageSchema = z.discriminatedUnion('messageType', [
  CaptureSelectionMessageSchema,
  DescribeToolsMessageSchema,
  SourceSearchMessageSchema,
  ActionPreviewMessageSchema,
  CancelMessageSchema,
]);

export type CaptureSelectionMessage = z.infer<typeof CaptureSelectionMessageSchema>;
export type DescribeToolsMessage = z.infer<typeof DescribeToolsMessageSchema>;
export type SourceSearchMessage = z.infer<typeof SourceSearchMessageSchema>;
export type ActionPreviewMessage = z.infer<typeof ActionPreviewMessageSchema>;
export type CancelMessage = z.infer<typeof CancelMessageSchema>;
export type BridgeMessage = z.infer<typeof BridgeMessageSchema>;

export interface BrowserSenderIdentity {
  readonly tabId: number;
  readonly frameId: number;
  readonly origin: string;
  readonly documentId: string;
  readonly extensionId?: string;
}

const AUTHORITY_KEYS = new Set([
  'approved',
  'approval',
  'approvalhandle',
  'grant',
  'grants',
  'capabilitygrant',
  'istrusted',
  'onlinepolicy',
  'permissiongranted',
  'trustedinstructions',
]);

function normalizedAuthorityKey(key: string): string {
  return key.replace(/[-_]/gu, '').toLocaleLowerCase('en-US');
}

function containsAuthorityClaim(value: JsonValue, depth = 0): boolean {
  if (depth > LIMITS.jsonDepth || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => containsAuthorityClaim(item, depth + 1));
  for (const [key, child] of Object.entries(value)) {
    if (
      AUTHORITY_KEYS.has(normalizedAuthorityKey(key)) ||
      containsAuthorityClaim(child, depth + 1)
    ) {
      return true;
    }
  }
  return false;
}

export function parseBridgeMessage(input: unknown): BridgeMessage {
  let rawPayload: JsonValue | undefined;
  try {
    if (typeof input === 'object' && input !== null && 'payload' in input) {
      const payload = (input as { readonly payload?: unknown }).payload;
      assertJsonValue(payload);
      rawPayload = payload;
    }
  } catch (error) {
    throw createSafeError('INVALID_INPUT', { cause: error });
  }
  if (rawPayload !== undefined && containsAuthorityClaim(rawPayload)) {
    throw createSafeError('PERMISSION_DENIED');
  }
  const message = parseVersioned(BridgeMessageSchema, input);
  try {
    canonicalize(message, { maxBytes: LIMITS.extensionMessageBytes });
  } catch (error) {
    throw createSafeError('PAYLOAD_TOO_LARGE', { cause: error });
  }
  return message;
}
