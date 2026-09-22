export const MEMORY_SCHEMA_VERSION = 2 as const;
export const LEGACY_MEMORY_SCHEMA_VERSION = 1 as const;
export const DEFAULT_MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_JSON_DEPTH = 32;
export const DEFAULT_MAX_CHUNKS = 10_000;

export type Sensitivity = "public" | "internal" | "sensitive" | "restricted";
export type ImportMediaType = "text/plain" | "text/markdown" | "text/csv" | "application/json";

export interface VaultHeader {
  schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  vaultId: string;
  createdAt: string;
  updatedAt: string;
  kdf: {
    name: "PBKDF2";
    hash: "SHA-256";
    iterations: number;
    salt: string;
  };
  wrapping: {
    algorithm: "AES-GCM";
    nonce: string;
    wrappedDataKey: string;
  };
}

export type SupportedMemorySchemaVersion = typeof LEGACY_MEMORY_SCHEMA_VERSION | typeof MEMORY_SCHEMA_VERSION;

export interface LegacyVaultHeader extends Omit<VaultHeader, "schemaVersion"> {
  schemaVersion: typeof LEGACY_MEMORY_SCHEMA_VERSION;
}

export type PersistedVaultHeader = VaultHeader | LegacyVaultHeader;

export type MemoryRecordKind =
  | "workspace"
  | "document"
  | "revision"
  | "chunk"
  | "embedding"
  | "grant"
  | "workflow"
  | "receipt"
  | "derived"
  | "staging";

export interface EncryptedRecord {
  schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  id: string;
  kind: MemoryRecordKind;
  nonce: string;
  ciphertext: string;
  byteLength: number;
}

export interface LegacyEncryptedRecord extends Omit<EncryptedRecord, "schemaVersion"> {
  schemaVersion: typeof LEGACY_MEMORY_SCHEMA_VERSION;
}

export type PersistedEncryptedRecord = EncryptedRecord | LegacyEncryptedRecord;

export interface WorkspaceRecord {
  schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  kind: "workspace";
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  sensitivity: Sensitivity;
  retentionUntil?: string;
  deletedAt?: string;
}

export interface DocumentRecord {
  schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  kind: "document";
  id: string;
  workspaceId: string;
  title: string;
  mediaType: ImportMediaType;
  revisionIds: string[];
  currentRevisionId: string;
  sourceOrigin?: string;
  sourceUrl?: string;
  sensitivity: Sensitivity;
  createdAt: string;
  updatedAt: string;
  retentionUntil?: string;
  deletedAt?: string;
}

export interface DocumentRevisionRecord {
  schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  kind: "revision";
  id: string;
  documentId: string;
  workspaceId: string;
  fingerprint: string;
  mediaType: ImportMediaType;
  originalText: string;
  byteLength: number;
  chunkIds: string[];
  createdAt: string;
}

export interface ChunkRecord {
  schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  kind: "chunk";
  id: string;
  documentId: string;
  revisionId: string;
  workspaceId: string;
  index: number;
  text: string;
  startOffset: number;
  endOffset: number;
  tokenTerms: string[];
  sensitivity: Sensitivity;
  sourceOrigin?: string;
  retentionUntil?: string;
}

export interface EmbeddingRecord {
  schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  kind: "embedding";
  id: string;
  chunkId: string;
  documentId: string;
  revisionId: string;
  workspaceId: string;
  modelId: string;
  modelRevision: string;
  dimensions: number;
  vector: number[];
  createdAt: string;
}

export interface SourceGrantRecord {
  schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  kind: "grant";
  id: string;
  workspaceId: string;
  sourceIds: string[];
  recipient: string;
  origin?: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt?: string;
}

export interface DerivedRecord {
  schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  kind: "derived";
  id: string;
  workspaceId: string;
  sourceIds: string[];
  sourceRevisionIds: string[];
  value: unknown;
  createdAt: string;
}

export interface StoredWorkflowRecord {
  schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  kind: "workflow";
  id: string;
  workspaceId: string;
  sourceIds: string[];
  value: unknown;
  createdAt: string;
}

export interface StoredReceiptRecord {
  schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  kind: "receipt";
  id: string;
  workspaceId: string;
  sourceIds: string[];
  value: unknown;
  createdAt: string;
  retentionUntil?: string;
}

export interface StagingRecord {
  schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  kind: "staging";
  id: string;
  operation: "ingest" | "import" | "migration";
  recordIds: string[];
  createdAt: string;
}

export type PrivateMemoryRecord =
  | WorkspaceRecord
  | DocumentRecord
  | DocumentRevisionRecord
  | ChunkRecord
  | EmbeddingRecord
  | SourceGrantRecord
  | DerivedRecord
  | StoredWorkflowRecord
  | StoredReceiptRecord
  | StagingRecord
  ;

export type PersistedPrivateMemoryRecord = PrivateMemoryRecord extends infer TRecord
  ? TRecord extends { schemaVersion: typeof MEMORY_SCHEMA_VERSION }
    ? Omit<TRecord, "schemaVersion"> & { schemaVersion: SupportedMemorySchemaVersion }
    : never
  : never;

export interface ImportSource {
  workspaceId: string;
  title: string;
  mediaType: ImportMediaType;
  content: string | Uint8Array;
  documentId?: string;
  sourceOrigin?: string;
  sourceUrl?: string;
  sensitivity?: Sensitivity;
  retentionUntil?: string;
}

export interface IngestResult {
  documentId: string;
  revisionId: string;
  chunkCount: number;
  byteLength: number;
  fingerprint: string;
  deduplicated: boolean;
  warnings: string[];
}

export interface EmbeddingProvider {
  readonly modelId: string;
  readonly modelRevision: string;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<readonly (readonly number[])[]>;
}

export interface SearchAuthorization {
  allowedSourceIds?: readonly string[];
  deniedSourceIds?: readonly string[];
  allowedSensitivities?: readonly Sensitivity[];
  recipient?: string;
  origin?: string;
  now?: Date;
}

export interface SearchRequest {
  workspaceId: string;
  query: string;
  limit?: number;
  authorization?: SearchAuthorization;
  embeddingProvider?: EmbeddingProvider;
  signal?: AbortSignal;
}

export interface SearchResult {
  documentId: string;
  revisionId: string;
  chunkId: string;
  title: string;
  text: string;
  startOffset: number;
  endOffset: number;
  lexicalScore: number;
  vectorScore?: number;
  combinedScore: number;
}

export interface VaultStatus {
  state: "missing" | "locked" | "unlocked";
  vaultId?: string;
  recordCount: number;
  encryptedBytes: number;
  lastUnlockedAt?: string;
}

export interface EncryptedVaultExport {
  format: "browser-cortex-encrypted-vault";
  schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  exportedAt: string;
  header: VaultHeader;
  records: EncryptedRecord[];
}

export interface LegacyEncryptedVaultExport extends Omit<EncryptedVaultExport, "schemaVersion" | "header" | "records"> {
  schemaVersion: typeof LEGACY_MEMORY_SCHEMA_VERSION;
  header: LegacyVaultHeader;
  records: LegacyEncryptedRecord[];
}

export type PersistedEncryptedVaultExport = EncryptedVaultExport | LegacyEncryptedVaultExport;

export interface VaultMigrationState {
  schemaVersion: 1;
  id: string;
  phase: "committed";
  fromVersion: typeof LEGACY_MEMORY_SCHEMA_VERSION;
  toVersion: typeof MEMORY_SCHEMA_VERSION;
  startedAt: string;
  committedAt: string;
  sourceRecordCount: number;
  targetRecordCount: number;
  sourceDigest: string;
  targetDigest: string;
}

export interface VaultMigrationCommit {
  state: VaultMigrationState;
  sourceHeader: LegacyVaultHeader;
  sourceRecords: readonly LegacyEncryptedRecord[];
  targetHeader: VaultHeader;
  targetRecords: readonly EncryptedRecord[];
}

export interface VaultMigrationBackup {
  sourceHeader: LegacyVaultHeader;
  sourceRecords: readonly LegacyEncryptedRecord[];
}

export interface MemoryStorageAdapter {
  getHeader(): Promise<PersistedVaultHeader | undefined>;
  setHeader(header: VaultHeader): Promise<void>;
  listRecords(): Promise<PersistedEncryptedRecord[]>;
  getRecord(id: string): Promise<PersistedEncryptedRecord | undefined>;
  putRecords(records: readonly EncryptedRecord[]): Promise<void>;
  deleteRecords(ids: readonly string[]): Promise<void>;
  replaceAll(header: VaultHeader, records: readonly EncryptedRecord[]): Promise<void>;
  getMigrationState?(): Promise<VaultMigrationState | undefined>;
  getMigrationBackup?(migrationId: string): Promise<VaultMigrationBackup | undefined>;
  commitMigration?(migration: VaultMigrationCommit): Promise<void>;
  rollbackMigration?(migrationId: string, verifiedBackup: VaultMigrationBackup): Promise<void>;
  finalizeMigration?(migrationId: string): Promise<void>;
  clear(): Promise<void>;
  close(): Promise<void>;
}

export interface EncryptedMemoryOptions {
  namespace: string;
  storage?: MemoryStorageAdapter;
  crypto?: Crypto;
  now?: () => Date;
  autoLockMs?: number;
  onLock?: (reason: VaultLockReason) => void;
  maxDocumentBytes?: number;
  maxChunks?: number;
  embeddingProvider?: EmbeddingProvider;
}

export type VaultLockReason = "manual" | "auto" | "delete" | "dispose";
