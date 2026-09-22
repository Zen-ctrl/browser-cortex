export { EncryptedMemoryVault, createEncryptedMemory } from "./vault.js";
export { IndexedDbMemoryStorage, InMemoryMemoryStorage } from "./storage.js";
export { decodeAndValidateImport, createChunks, tokenize } from "./ingest.js";
export { retrieve, type RetrievalSnapshot } from "./retrieval.js";
export {
  encryptedRecordsDigest,
  prepareVaultMigration,
  validateMigrationState,
  verifyCommittedMigration,
  verifyMigrationBackup,
  verifyPrivateRecordGraph,
} from "./migrations.js";
export {
  validateVaultExport,
  validateVaultExportForImport,
  validateHeader,
  validatePersistedHeader,
  validatePrivateRecord,
} from "./validation.js";
export type {
  ChunkRecord,
  DerivedRecord,
  DocumentRecord,
  DocumentRevisionRecord,
  EmbeddingProvider,
  EmbeddingRecord,
  EncryptedMemoryOptions,
  EncryptedRecord,
  EncryptedVaultExport,
  ImportMediaType,
  ImportSource,
  IngestResult,
  MemoryRecordKind,
  MemoryStorageAdapter,
  LegacyEncryptedRecord,
  LegacyEncryptedVaultExport,
  LegacyVaultHeader,
  PersistedEncryptedRecord,
  PersistedEncryptedVaultExport,
  PersistedVaultHeader,
  SearchAuthorization,
  SearchRequest,
  SearchResult,
  Sensitivity,
  SourceGrantRecord,
  StoredReceiptRecord,
  StoredWorkflowRecord,
  VaultHeader,
  VaultLockReason,
  VaultMigrationCommit,
  VaultMigrationBackup,
  VaultMigrationState,
  VaultStatus,
  WorkspaceRecord,
} from "./types.js";
export {
  DEFAULT_MAX_CHUNKS,
  DEFAULT_MAX_DOCUMENT_BYTES,
  DEFAULT_MAX_JSON_DEPTH,
  LEGACY_MEMORY_SCHEMA_VERSION,
  MEMORY_SCHEMA_VERSION,
} from "./types.js";
