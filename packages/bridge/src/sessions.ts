import {
  IdentifierSchema,
  LIMITS,
  createSafeError,
  parseVersioned,
} from '@browser-cortex/contracts';

import {
  BridgeMessageTypeSchema,
  BridgeToolVersionSchema,
  parseBridgeMessage,
  type ActionPreviewMessage,
  type BridgeMessage,
  type BridgeMessageType,
  type BrowserSenderIdentity,
  type DescribeToolsMessage,
  type SourceSearchMessage,
} from './messages.js';

export interface SourceSearchSessionScopeInput {
  readonly workspaceId: string;
  readonly allowedSourceIds: readonly string[];
  readonly maxResults?: number;
}

export interface AllowedToolScopeInput {
  readonly name: string;
  readonly version: string;
  readonly allowedActionParameterKeys: readonly string[];
}

export interface ToolSessionScopeInput {
  readonly allowedTools: readonly AllowedToolScopeInput[];
}

interface SourceSearchSessionScope {
  readonly workspaceId: string;
  readonly allowedSourceIds: ReadonlySet<string>;
  readonly maxResults: number;
}

interface AllowedToolScope {
  readonly name: string;
  readonly version: string;
  readonly allowedActionParameterKeys: ReadonlySet<string>;
}

interface ToolSessionScope {
  readonly allowedTools: ReadonlyMap<string, AllowedToolScope>;
}

interface SessionRecord {
  readonly sessionId: string;
  readonly tabId: number;
  readonly frameId: number;
  readonly origin: string;
  readonly documentId: string;
  readonly extensionId?: string;
  readonly allowedMessageTypes: ReadonlySet<BridgeMessageType>;
  readonly sourceSearchScope?: SourceSearchSessionScope;
  readonly toolScope?: ToolSessionScope;
  readonly createdAt: number;
  readonly inactivityMs: number;
  readonly maxRequests: number;
  readonly seenRequestIds: Set<string>;
  lastUsedAt: number;
  requestCount: number;
  revoked: boolean;
}

export interface CreateSessionInput extends BrowserSenderIdentity {
  readonly allowedMessageTypes: readonly BridgeMessageType[];
  readonly sourceSearchScope?: SourceSearchSessionScopeInput;
  readonly toolScope?: ToolSessionScopeInput;
  readonly now?: number;
  readonly inactivityMs?: number;
  readonly maxRequests?: number;
}

export interface ExtensionSession {
  readonly sessionId: string;
  readonly origin: string;
  readonly documentId: string;
  readonly expiresAfterInactivityMs: number;
}

function randomSessionId(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let token = '';
  for (const byte of bytes) token += byte.toString(16).padStart(2, '0');
  return `ses_${token}`;
}

function normalizedOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch (error) {
    throw createSafeError('INVALID_INPUT', { cause: error });
  }
  if (url.origin === 'null' || url.username !== '' || url.password !== '') {
    throw createSafeError('INVALID_INPUT');
  }
  return url.origin;
}

function validateSenderNumbers(sender: BrowserSenderIdentity): void {
  if (!Number.isSafeInteger(sender.tabId) || sender.tabId < 0) throw createSafeError('INVALID_INPUT');
  if (!Number.isSafeInteger(sender.frameId) || sender.frameId < 0) throw createSafeError('INVALID_INPUT');
  parseVersioned(IdentifierSchema, sender.documentId);
  if (sender.extensionId !== undefined) parseVersioned(IdentifierSchema, sender.extensionId);
}

function isTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function toolKey(name: string, version: string): string {
  return `${name}\u0000${version}`;
}

function normalizeSourceSearchScope(
  input: SourceSearchSessionScopeInput | undefined,
  required: boolean,
): SourceSearchSessionScope | undefined {
  if (input === undefined) {
    if (required) throw createSafeError('INVALID_INPUT');
    return undefined;
  }
  if (!required) throw createSafeError('INVALID_INPUT');
  const workspaceId = parseVersioned(IdentifierSchema, input.workspaceId);
  if (input.allowedSourceIds.length === 0 || input.allowedSourceIds.length > LIMITS.sourceIds) {
    throw createSafeError('INVALID_INPUT');
  }
  const allowedSourceIds = input.allowedSourceIds.map((sourceId) =>
    parseVersioned(IdentifierSchema, sourceId),
  );
  if (new Set(allowedSourceIds).size !== allowedSourceIds.length) {
    throw createSafeError('INVALID_INPUT');
  }
  const maxResults = input.maxResults ?? 20;
  if (!Number.isSafeInteger(maxResults) || maxResults <= 0 || maxResults > 100) {
    throw createSafeError('INVALID_INPUT');
  }
  return Object.freeze({
    workspaceId,
    allowedSourceIds: new Set(allowedSourceIds),
    maxResults,
  });
}

function normalizeToolScope(
  input: ToolSessionScopeInput | undefined,
  required: boolean,
): ToolSessionScope | undefined {
  if (input === undefined) {
    if (required) throw createSafeError('INVALID_INPUT');
    return undefined;
  }
  if (!required || input.allowedTools.length === 0 || input.allowedTools.length > 32) {
    throw createSafeError('INVALID_INPUT');
  }
  const allowedTools = new Map<string, AllowedToolScope>();
  for (const tool of input.allowedTools) {
    const name = parseVersioned(IdentifierSchema, tool.name);
    const version = parseVersioned(BridgeToolVersionSchema, tool.version);
    if (tool.allowedActionParameterKeys.length > 64) throw createSafeError('INVALID_INPUT');
    const keys = tool.allowedActionParameterKeys.map((key) =>
      parseVersioned(IdentifierSchema, key),
    );
    if (new Set(keys).size !== keys.length) throw createSafeError('INVALID_INPUT');
    const key = toolKey(name, version);
    if (allowedTools.has(key)) throw createSafeError('INVALID_INPUT');
    allowedTools.set(
      key,
      Object.freeze({
        name,
        version,
        allowedActionParameterKeys: new Set(keys),
      }),
    );
  }
  return Object.freeze({ allowedTools });
}

function authorizeSourceSearch(record: SessionRecord, message: SourceSearchMessage): void {
  const scope = record.sourceSearchScope;
  if (
    scope === undefined ||
    message.payload.workspaceId !== scope.workspaceId ||
    message.payload.limit > scope.maxResults ||
    !message.payload.sourceIds.every((sourceId) => scope.allowedSourceIds.has(sourceId))
  ) {
    throw createSafeError('PERMISSION_DENIED');
  }
}

function authorizeToolDescriptions(record: SessionRecord, message: DescribeToolsMessage): void {
  const scope = record.toolScope;
  if (
    scope === undefined ||
    !message.payload.tools.every((tool) => scope.allowedTools.has(toolKey(tool.name, tool.version)))
  ) {
    throw createSafeError('PERMISSION_DENIED');
  }
}

function authorizeActionPreview(record: SessionRecord, message: ActionPreviewMessage): void {
  const scope = record.toolScope?.allowedTools.get(
    toolKey(message.payload.toolName, message.payload.toolVersion),
  );
  if (
    scope === undefined ||
    !Object.keys(message.payload.parameters).every((key) =>
      scope.allowedActionParameterKeys.has(key),
    )
  ) {
    throw createSafeError('PERMISSION_DENIED');
  }
}

function authorizeMessageScope(record: SessionRecord, message: BridgeMessage): void {
  switch (message.messageType) {
    case 'page.capture-selection':
      return;
    case 'page.request-source-search':
      authorizeSourceSearch(record, message);
      return;
    case 'page.describe-tools':
      authorizeToolDescriptions(record, message);
      return;
    case 'page.request-action-preview':
      authorizeActionPreview(record, message);
      return;
    case 'bridge.cancel':
      if (!record.seenRequestIds.has(message.payload.targetRequestId)) {
        throw createSafeError('PERMISSION_DENIED');
      }
      return;
  }
}

export class ExtensionSessionRegistry {
  readonly #sessions = new Map<string, SessionRecord>();

  public create(input: CreateSessionInput): ExtensionSession {
    validateSenderNumbers(input);
    const documentId = parseVersioned(IdentifierSchema, input.documentId);
    const inactivityMs = input.inactivityMs ?? LIMITS.sessionInactivityMs;
    const maxRequests = input.maxRequests ?? LIMITS.bridgeSessionRequests;
    if (!Number.isSafeInteger(inactivityMs) || inactivityMs <= 0 || inactivityMs > LIMITS.sessionInactivityMs) {
      throw createSafeError('INVALID_INPUT');
    }
    if (!Number.isSafeInteger(maxRequests) || maxRequests <= 0 || maxRequests > LIMITS.bridgeSessionRequests) {
      throw createSafeError('INVALID_INPUT');
    }
    const allowedMessageTypes = new Set(
      input.allowedMessageTypes.map((messageType) =>
        parseVersioned(BridgeMessageTypeSchema, messageType),
      ),
    );
    if (allowedMessageTypes.size === 0) throw createSafeError('INVALID_INPUT');
    const sourceSearchScope = normalizeSourceSearchScope(
      input.sourceSearchScope,
      allowedMessageTypes.has('page.request-source-search'),
    );
    const toolScope = normalizeToolScope(
      input.toolScope,
      allowedMessageTypes.has('page.describe-tools') ||
        allowedMessageTypes.has('page.request-action-preview'),
    );
    let sessionId: string;
    do sessionId = randomSessionId(); while (this.#sessions.has(sessionId));
    const now = input.now ?? Date.now();
    if (!isTimestamp(now)) throw createSafeError('INVALID_INPUT');
    const origin = normalizedOrigin(input.origin);
    this.#sessions.set(sessionId, {
      sessionId,
      tabId: input.tabId,
      frameId: input.frameId,
      origin,
      documentId,
      ...(input.extensionId === undefined ? {} : { extensionId: input.extensionId }),
      allowedMessageTypes,
      ...(sourceSearchScope === undefined ? {} : { sourceSearchScope }),
      ...(toolScope === undefined ? {} : { toolScope }),
      createdAt: now,
      lastUsedAt: now,
      inactivityMs,
      maxRequests,
      requestCount: 0,
      seenRequestIds: new Set(),
      revoked: false,
    });
    return Object.freeze({
      sessionId,
      origin,
      documentId,
      expiresAfterInactivityMs: inactivityMs,
    });
  }

  public authorize(message: BridgeMessage, sender: BrowserSenderIdentity, now = Date.now()): void {
    validateSenderNumbers(sender);
    const record = this.#sessions.get(message.sessionId);
    if (record === undefined || record.revoked) throw createSafeError('SESSION_REVOKED');
    if (!isTimestamp(now)) {
      this.#sessions.delete(record.sessionId);
      throw createSafeError('SESSION_EXPIRED');
    }
    if (now < record.createdAt || now - record.lastUsedAt >= record.inactivityMs) {
      this.#sessions.delete(record.sessionId);
      throw createSafeError('SESSION_EXPIRED');
    }
    if (
      record.tabId !== sender.tabId ||
      record.frameId !== sender.frameId ||
      record.origin !== normalizedOrigin(sender.origin) ||
      record.documentId !== sender.documentId ||
      record.documentId !== message.documentId ||
      record.extensionId !== sender.extensionId
    ) {
      throw createSafeError('STALE_DOCUMENT');
    }
    if (!record.allowedMessageTypes.has(message.messageType)) throw createSafeError('PERMISSION_DENIED');
    if (record.requestCount >= record.maxRequests) {
      this.#sessions.delete(record.sessionId);
      throw createSafeError('SESSION_EXPIRED');
    }
    if (record.seenRequestIds.has(message.requestId)) throw createSafeError('DUPLICATE_REQUEST');
    authorizeMessageScope(record, message);
    record.seenRequestIds.add(message.requestId);
    record.requestCount += 1;
    record.lastUsedAt = now;
  }

  public revoke(sessionId: string): boolean {
    const record = this.#sessions.get(sessionId);
    if (record === undefined) return false;
    record.revoked = true;
    this.#sessions.delete(sessionId);
    return true;
  }

  public invalidateDocument(tabId: number, frameId: number, currentDocumentId: string): number {
    let removed = 0;
    for (const [sessionId, record] of this.#sessions) {
      if (record.tabId === tabId && record.frameId === frameId && record.documentId !== currentDocumentId) {
        this.#sessions.delete(sessionId);
        removed += 1;
      }
    }
    return removed;
  }

  public purgeExpired(now = Date.now()): number {
    if (!isTimestamp(now)) throw createSafeError('INVALID_INPUT');
    let removed = 0;
    for (const [sessionId, record] of this.#sessions) {
      if (record.revoked || now < record.createdAt || now - record.lastUsedAt >= record.inactivityMs) {
        this.#sessions.delete(sessionId);
        removed += 1;
      }
    }
    return removed;
  }

  public get size(): number {
    return this.#sessions.size;
  }
}

export function validateBridgeMessage(
  input: unknown,
  sender: BrowserSenderIdentity,
  sessions: ExtensionSessionRegistry,
  now = Date.now(),
): BridgeMessage {
  const message = parseBridgeMessage(input);
  sessions.authorize(message, sender, now);
  return message;
}
