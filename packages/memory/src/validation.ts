import type {
  EncryptedRecord,
  EncryptedVaultExport,
  LegacyEncryptedRecord,
  LegacyEncryptedVaultExport,
  LegacyVaultHeader,
  PersistedEncryptedRecord,
  PersistedEncryptedVaultExport,
  PersistedPrivateMemoryRecord,
  PersistedVaultHeader,
  PrivateMemoryRecord,
  SupportedMemorySchemaVersion,
  VaultHeader,
} from "./types.js";
import { LEGACY_MEMORY_SCHEMA_VERSION, MEMORY_SCHEMA_VERSION } from "./types.js";

const MAX_EXPORT_RECORDS = 100_000;
const MAX_CIPHERTEXT_CHARACTERS = 30 * 1024 * 1024;
const MAX_EXPORT_CIPHERTEXT_CHARACTERS = 256 * 1024 * 1024;
const MAX_PBKDF2_ITERATIONS = 2_000_000;
const RECORD_KINDS = new Set([
  "workspace",
  "document",
  "revision",
  "chunk",
  "embedding",
  "grant",
  "workflow",
  "receipt",
  "derived",
  "staging",
]);
const HEADER_KEYS = new Set(["schemaVersion", "vaultId", "createdAt", "updatedAt", "kdf", "wrapping"]);
const KDF_KEYS = new Set(["name", "hash", "iterations", "salt"]);
const WRAPPING_KEYS = new Set(["algorithm", "nonce", "wrappedDataKey"]);
const ENCRYPTED_RECORD_KEYS = new Set(["schemaVersion", "id", "kind", "nonce", "ciphertext", "byteLength"]);
const EXPORT_KEYS = new Set(["format", "schemaVersion", "exportedAt", "header", "records"]);

function canonicalBase64(value: string, encodedBytes: number): boolean {
  const expectedCharacters = Math.ceil(encodedBytes / 3) * 4;
  const padding = encodedBytes % 3 === 1 ? "==" : encodedBytes % 3 === 2 ? "=" : "";
  const payload = value.slice(0, expectedCharacters - padding.length);
  return (
    value.length === expectedCharacters &&
    payload.length > 0 &&
    /^[A-Za-z0-9+/]+$/u.test(payload) &&
    value.slice(payload.length) === padding
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function string(value: unknown, label: string, max = 24_000_000): asserts value is string {
  if (typeof value !== "string" || value.length > max) throw new Error(`${label} is invalid.`);
}

function strings(value: unknown, label: string, maxItems = 100_000): asserts value is string[] {
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} is invalid.`);
  }
}

function timestamp(value: unknown, label: string): asserts value is string {
  string(value, label, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} is invalid.`);
  }
}

function validatePrivateRecordAtVersion(
  value: unknown,
  expectedVersion: SupportedMemorySchemaVersion,
): PersistedPrivateMemoryRecord {
  if (!isObject(value) || value.schemaVersion !== expectedVersion) throw new Error("Private record schema is invalid.");
  string(value.id, "Private record ID", 256);
  string(value.kind, "Private record kind", 32);
  switch (value.kind) {
    case "workspace":
      string(value.name, "Workspace name", 256);
      timestamp(value.createdAt, "Workspace timestamp");
      timestamp(value.updatedAt, "Workspace timestamp");
      if (value.retentionUntil !== undefined) timestamp(value.retentionUntil, "Workspace retention");
      break;
    case "document":
      string(value.workspaceId, "Document workspace", 256);
      string(value.title, "Document title", 512);
      strings(value.revisionIds, "Document revisions");
      string(value.currentRevisionId, "Current revision", 256);
      if (value.retentionUntil !== undefined) timestamp(value.retentionUntil, "Document retention");
      break;
    case "revision":
      string(value.documentId, "Revision document", 256);
      string(value.workspaceId, "Revision workspace", 256);
      string(value.fingerprint, "Revision fingerprint", 128);
      string(value.originalText, "Revision text");
      strings(value.chunkIds, "Revision chunks");
      if (!Number.isSafeInteger(value.byteLength) || (value.byteLength as number) < 0) throw new Error("Revision byte length is invalid.");
      break;
    case "chunk":
      string(value.documentId, "Chunk document", 256);
      string(value.revisionId, "Chunk revision", 256);
      string(value.workspaceId, "Chunk workspace", 256);
      string(value.text, "Chunk text", 100_000);
      strings(value.tokenTerms, "Chunk terms", 4_000);
      if (![value.index, value.startOffset, value.endOffset].every((item) => Number.isSafeInteger(item) && (item as number) >= 0)) {
        throw new Error("Chunk offsets are invalid.");
      }
      if (value.retentionUntil !== undefined) timestamp(value.retentionUntil, "Chunk retention");
      break;
    case "embedding":
      string(value.chunkId, "Embedding chunk", 256);
      string(value.documentId, "Embedding document", 256);
      string(value.revisionId, "Embedding revision", 256);
      string(value.workspaceId, "Embedding workspace", 256);
      string(value.modelId, "Embedding model", 512);
      string(value.modelRevision, "Embedding model revision", 256);
      if (!Array.isArray(value.vector) || value.vector.length < 1 || value.vector.length > 65_536 || !value.vector.every(Number.isFinite)) {
        throw new Error("Embedding vector is invalid.");
      }
      if (value.dimensions !== value.vector.length) throw new Error("Embedding dimensions do not match the vector.");
      break;
    case "grant":
      string(value.workspaceId, "Grant workspace", 256);
      strings(value.sourceIds, "Grant sources", 1_000);
      string(value.recipient, "Grant recipient", 512);
      timestamp(value.expiresAt, "Grant expiry");
      if (value.revokedAt !== undefined) timestamp(value.revokedAt, "Grant revocation");
      break;
    case "derived":
    case "workflow":
    case "receipt":
      string(value.workspaceId, "Derived workspace", 256);
      strings(value.sourceIds, "Derived sources", 1_000);
      JSON.stringify(value.value);
      if (value.kind === "receipt" && value.retentionUntil !== undefined) timestamp(value.retentionUntil, "Receipt retention");
      break;
    case "staging":
      strings(value.recordIds, "Staged record IDs");
      if (!['ingest', 'import', 'migration'].includes(String(value.operation))) throw new Error("Staging operation is invalid.");
      break;
    default:
      throw new Error("Private record kind is unsupported.");
  }
  return value as unknown as PersistedPrivateMemoryRecord;
}

export function validatePrivateRecord(value: unknown): PrivateMemoryRecord {
  return validatePrivateRecordAtVersion(value, MEMORY_SCHEMA_VERSION) as PrivateMemoryRecord;
}

export function validatePersistedPrivateRecord(
  value: unknown,
  expectedVersion: SupportedMemorySchemaVersion,
): PersistedPrivateMemoryRecord {
  return validatePrivateRecordAtVersion(value, expectedVersion);
}

function validateHeaderAtVersion(value: unknown, expectedVersion: SupportedMemorySchemaVersion): PersistedVaultHeader {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, HEADER_KEYS) ||
    value.schemaVersion !== expectedVersion ||
    typeof value.vaultId !== "string" ||
    value.vaultId.length < 1 ||
    value.vaultId.length > 256
  ) {
    throw new Error("Invalid vault header.");
  }
  const kdf = value.kdf;
  const wrapping = value.wrapping;
  if (
    !isObject(kdf) ||
    !hasOnlyKeys(kdf, KDF_KEYS) ||
    kdf.name !== "PBKDF2" ||
    kdf.hash !== "SHA-256" ||
    typeof kdf.iterations !== "number" ||
    !Number.isSafeInteger(kdf.iterations) ||
    kdf.iterations < 100_000 ||
    kdf.iterations > MAX_PBKDF2_ITERATIONS ||
    typeof kdf.salt !== "string" ||
    !canonicalBase64(kdf.salt, 16) ||
    !isObject(wrapping) ||
    !hasOnlyKeys(wrapping, WRAPPING_KEYS) ||
    wrapping.algorithm !== "AES-GCM" ||
    typeof wrapping.nonce !== "string" ||
    !canonicalBase64(wrapping.nonce, 12) ||
    typeof wrapping.wrappedDataKey !== "string" ||
    !canonicalBase64(wrapping.wrappedDataKey, 48) ||
    typeof value.createdAt !== "string" ||
    value.createdAt.length > 64 ||
    typeof value.updatedAt !== "string" ||
    value.updatedAt.length > 64
  ) {
    throw new Error("Invalid vault key-wrapping metadata.");
  }
  return value as unknown as PersistedVaultHeader;
}

export function validateHeader(value: unknown): VaultHeader {
  return validateHeaderAtVersion(value, MEMORY_SCHEMA_VERSION) as VaultHeader;
}

export function validatePersistedHeader(value: unknown): PersistedVaultHeader {
  if (!isObject(value)) throw new Error("Invalid vault header.");
  if (value.schemaVersion === LEGACY_MEMORY_SCHEMA_VERSION) {
    return validateHeaderAtVersion(value, LEGACY_MEMORY_SCHEMA_VERSION) as LegacyVaultHeader;
  }
  if (value.schemaVersion === MEMORY_SCHEMA_VERSION) return validateHeader(value);
  throw new Error(`Vault schema ${String(value.schemaVersion)} is not supported. Preserve the vault and use a compatible BrowserCortex version to export it.`);
}

function validateEncryptedRecordAtVersion(
  value: unknown,
  expectedVersion: SupportedMemorySchemaVersion,
): PersistedEncryptedRecord {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ENCRYPTED_RECORD_KEYS) ||
    value.schemaVersion !== expectedVersion ||
    typeof value.id !== "string" ||
    value.id.length < 1 ||
    value.id.length > 256 ||
    typeof value.kind !== "string" ||
    !RECORD_KINDS.has(value.kind) ||
    typeof value.nonce !== "string" ||
    !canonicalBase64(value.nonce, 12) ||
    typeof value.ciphertext !== "string" ||
    value.ciphertext.length > MAX_CIPHERTEXT_CHARACTERS ||
    typeof value.byteLength !== "number" ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength < 16 ||
    !canonicalBase64(value.ciphertext, value.byteLength)
  ) {
    throw new Error("Invalid encrypted vault record.");
  }
  return value as unknown as PersistedEncryptedRecord;
}

export function validateEncryptedRecord(value: unknown): EncryptedRecord {
  return validateEncryptedRecordAtVersion(value, MEMORY_SCHEMA_VERSION) as EncryptedRecord;
}

export function validatePersistedEncryptedRecord(
  value: unknown,
  expectedVersion: typeof LEGACY_MEMORY_SCHEMA_VERSION,
): LegacyEncryptedRecord;
export function validatePersistedEncryptedRecord(
  value: unknown,
  expectedVersion: typeof MEMORY_SCHEMA_VERSION,
): EncryptedRecord;
export function validatePersistedEncryptedRecord(
  value: unknown,
  expectedVersion: SupportedMemorySchemaVersion,
): PersistedEncryptedRecord {
  return validateEncryptedRecordAtVersion(value, expectedVersion);
}

export function validateVaultExport(value: unknown): EncryptedVaultExport {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, EXPORT_KEYS) ||
    value.format !== "browser-cortex-encrypted-vault" ||
    value.schemaVersion !== MEMORY_SCHEMA_VERSION ||
    typeof value.exportedAt !== "string" ||
    value.exportedAt.length > 64 ||
    !Array.isArray(value.records) ||
    value.records.length > MAX_EXPORT_RECORDS
  ) {
    throw new Error("Unsupported encrypted vault export.");
  }
  const header = validateHeader(value.header);
  const records = value.records.map(validateEncryptedRecord);
  const aggregateCharacters = records.reduce((total, record) => {
    const next = total + record.ciphertext.length;
    if (next > MAX_EXPORT_CIPHERTEXT_CHARACTERS) throw new Error("Encrypted vault export exceeds the aggregate size limit.");
    return next;
  }, 0);
  if (!Number.isSafeInteger(aggregateCharacters)) throw new Error("Encrypted vault export size is invalid.");
  if (new Set(records.map((record) => record.id)).size !== records.length) throw new Error("Vault export has duplicate record IDs.");
  return {
    format: "browser-cortex-encrypted-vault",
    schemaVersion: MEMORY_SCHEMA_VERSION,
    exportedAt: value.exportedAt,
    header,
    records,
  };
}

export function validateVaultExportForImport(value: unknown): PersistedEncryptedVaultExport {
  if (!isObject(value) || value.schemaVersion === MEMORY_SCHEMA_VERSION) return validateVaultExport(value);
  if (
    !hasOnlyKeys(value, EXPORT_KEYS) ||
    value.format !== "browser-cortex-encrypted-vault" ||
    value.schemaVersion !== LEGACY_MEMORY_SCHEMA_VERSION ||
    typeof value.exportedAt !== "string" ||
    value.exportedAt.length > 64 ||
    !Array.isArray(value.records) ||
    value.records.length > MAX_EXPORT_RECORDS
  ) {
    throw new Error("Unsupported encrypted vault export.");
  }
  const header = validateHeaderAtVersion(value.header, LEGACY_MEMORY_SCHEMA_VERSION) as LegacyVaultHeader;
  const records = value.records.map((record) => (
    validateEncryptedRecordAtVersion(record, LEGACY_MEMORY_SCHEMA_VERSION) as LegacyEncryptedRecord
  ));
  const aggregateCharacters = records.reduce((total, record) => {
    const next = total + record.ciphertext.length;
    if (next > MAX_EXPORT_CIPHERTEXT_CHARACTERS) throw new Error("Encrypted vault export exceeds the aggregate size limit.");
    return next;
  }, 0);
  if (!Number.isSafeInteger(aggregateCharacters)) throw new Error("Encrypted vault export size is invalid.");
  if (new Set(records.map((record) => record.id)).size !== records.length) throw new Error("Vault export has duplicate record IDs.");
  return {
    format: "browser-cortex-encrypted-vault",
    schemaVersion: LEGACY_MEMORY_SCHEMA_VERSION,
    exportedAt: value.exportedAt,
    header,
    records,
  } satisfies LegacyEncryptedVaultExport;
}
