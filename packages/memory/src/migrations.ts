import { decryptPersistedRecord, decryptRecord, encryptRecord } from "./crypto.js";
import { randomId, sha256, utf8 } from "./encoding.js";
import type {
  EncryptedRecord,
  LegacyEncryptedRecord,
  LegacyVaultHeader,
  PersistedPrivateMemoryRecord,
  PrivateMemoryRecord,
  VaultHeader,
  VaultMigrationBackup,
  VaultMigrationCommit,
  VaultMigrationState,
} from "./types.js";
import { LEGACY_MEMORY_SCHEMA_VERSION, MEMORY_SCHEMA_VERSION } from "./types.js";
import {
  validateEncryptedRecord,
  validatePersistedHeader,
  validatePersistedEncryptedRecord,
  validatePrivateRecord,
} from "./validation.js";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const MIGRATION_STATE_KEYS = new Set([
  "schemaVersion",
  "id",
  "phase",
  "fromVersion",
  "toVersion",
  "startedAt",
  "committedAt",
  "sourceRecordCount",
  "targetRecordCount",
  "sourceDigest",
  "targetDigest",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value));
}

export function validateMigrationState(value: unknown): VaultMigrationState {
  if (
    !isObject(value) ||
    !Object.keys(value).every((key) => MIGRATION_STATE_KEYS.has(key)) ||
    value.schemaVersion !== 1 ||
    typeof value.id !== "string" ||
    value.id.length < 1 ||
    value.id.length > 256 ||
    value.phase !== "committed" ||
    value.fromVersion !== LEGACY_MEMORY_SCHEMA_VERSION ||
    value.toVersion !== MEMORY_SCHEMA_VERSION ||
    !isIsoTimestamp(value.startedAt) ||
    !isIsoTimestamp(value.committedAt) ||
    !Number.isSafeInteger(value.sourceRecordCount) ||
    (value.sourceRecordCount as number) < 0 ||
    !Number.isSafeInteger(value.targetRecordCount) ||
    (value.targetRecordCount as number) < 0 ||
    typeof value.sourceDigest !== "string" ||
    !DIGEST_PATTERN.test(value.sourceDigest) ||
    typeof value.targetDigest !== "string" ||
    !DIGEST_PATTERN.test(value.targetDigest)
  ) {
    throw new Error("Vault migration state is invalid. The encrypted vault was not modified.");
  }
  return value as unknown as VaultMigrationState;
}

export async function encryptedRecordsDigest(
  cryptoProvider: Crypto,
  records: readonly (EncryptedRecord | LegacyEncryptedRecord)[],
): Promise<string> {
  const canonical = [...records]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((record) => [
      record.schemaVersion,
      record.id,
      record.kind,
      record.nonce,
      record.ciphertext,
      record.byteLength,
    ]);
  return sha256(cryptoProvider, utf8(JSON.stringify(canonical)));
}

function expectRecord<TRecord extends PrivateMemoryRecord["kind"]>(
  records: ReadonlyMap<string, PrivateMemoryRecord>,
  id: string,
  kind: TRecord,
  label: string,
): Extract<PrivateMemoryRecord, { kind: TRecord }> {
  const record = records.get(id);
  if (!record || record.kind !== kind) throw new Error(`Vault migration verification failed: ${label} is missing or mismatched.`);
  return record as Extract<PrivateMemoryRecord, { kind: TRecord }>;
}

export function verifyPrivateRecordGraph(records: readonly PrivateMemoryRecord[]): void {
  const byId = new Map<string, PrivateMemoryRecord>();
  for (const record of records) {
    if (byId.has(record.id)) throw new Error("Vault migration verification failed: duplicate private record ID.");
    byId.set(record.id, record);
  }

  for (const record of records) {
    if (record.kind !== "workspace" && record.kind !== "staging") {
      expectRecord(byId, record.workspaceId, "workspace", `${record.kind} workspace`);
    }
    if (record.kind === "document") {
      if (!record.revisionIds.includes(record.currentRevisionId)) {
        throw new Error("Vault migration verification failed: current document revision is not in its revision history.");
      }
      for (const revisionId of record.revisionIds) {
        const revision = expectRecord(byId, revisionId, "revision", "document revision");
        if (revision.documentId !== record.id || revision.workspaceId !== record.workspaceId) {
          throw new Error("Vault migration verification failed: document revision ownership changed.");
        }
      }
    }
    if (record.kind === "revision") {
      const document = expectRecord(byId, record.documentId, "document", "revision document");
      if (document.workspaceId !== record.workspaceId) {
        throw new Error("Vault migration verification failed: revision workspace changed.");
      }
      for (const chunkId of record.chunkIds) {
        const chunk = expectRecord(byId, chunkId, "chunk", "revision chunk");
        if (
          chunk.documentId !== record.documentId ||
          chunk.revisionId !== record.id ||
          chunk.workspaceId !== record.workspaceId
        ) {
          throw new Error("Vault migration verification failed: chunk ownership changed.");
        }
      }
    }
    if (record.kind === "chunk") {
      const revision = expectRecord(byId, record.revisionId, "revision", "chunk revision");
      const document = expectRecord(byId, record.documentId, "document", "chunk document");
      if (
        revision.documentId !== record.documentId ||
        revision.workspaceId !== record.workspaceId ||
        document.workspaceId !== record.workspaceId
      ) {
        throw new Error("Vault migration verification failed: chunk source relationship changed.");
      }
    }
    if (record.kind === "embedding") {
      const chunk = expectRecord(byId, record.chunkId, "chunk", "embedding chunk");
      if (
        chunk.documentId !== record.documentId ||
        chunk.revisionId !== record.revisionId ||
        chunk.workspaceId !== record.workspaceId
      ) {
        throw new Error("Vault migration verification failed: embedding source relationship changed.");
      }
    }
  }
}

function migratePrivateRecord(record: PersistedPrivateMemoryRecord): PrivateMemoryRecord {
  if (record.schemaVersion !== LEGACY_MEMORY_SCHEMA_VERSION) {
    throw new Error("Vault migration received a record outside its declared source schema.");
  }
  return validatePrivateRecord({ ...record, schemaVersion: MEMORY_SCHEMA_VERSION });
}

async function decryptAndValidateCurrent(
  cryptoProvider: Crypto,
  key: CryptoKey,
  records: readonly EncryptedRecord[],
): Promise<PrivateMemoryRecord[]> {
  const decrypted: PrivateMemoryRecord[] = [];
  for (const record of records) {
    validateEncryptedRecord(record);
    decrypted.push(await decryptRecord(cryptoProvider, key, record));
  }
  verifyPrivateRecordGraph(decrypted);
  return decrypted;
}

export async function prepareVaultMigration(args: {
  cryptoProvider: Crypto;
  key: CryptoKey;
  header: LegacyVaultHeader;
  records: readonly LegacyEncryptedRecord[];
  now: Date;
}): Promise<VaultMigrationCommit> {
  const startedAt = args.now.toISOString();
  const plaintext: PersistedPrivateMemoryRecord[] = [];
  for (const record of args.records) {
    validatePersistedEncryptedRecord(record, LEGACY_MEMORY_SCHEMA_VERSION);
    plaintext.push(await decryptPersistedRecord(args.cryptoProvider, args.key, record));
  }
  const migrated = plaintext.map(migratePrivateRecord);
  verifyPrivateRecordGraph(migrated);

  const encrypted: EncryptedRecord[] = [];
  for (const record of migrated) encrypted.push(await encryptRecord(args.cryptoProvider, args.key, record));
  const verified = await decryptAndValidateCurrent(args.cryptoProvider, args.key, encrypted);
  if (
    verified.length !== migrated.length ||
    verified.some((record, index) => JSON.stringify(record) !== JSON.stringify(migrated[index]))
  ) {
    throw new Error("Vault migration verification failed before commit. The previous encrypted vault remains intact.");
  }

  const header: VaultHeader = {
    ...args.header,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    updatedAt: startedAt,
  };
  const state: VaultMigrationState = {
    schemaVersion: 1,
    id: randomId(args.cryptoProvider),
    phase: "committed",
    fromVersion: LEGACY_MEMORY_SCHEMA_VERSION,
    toVersion: MEMORY_SCHEMA_VERSION,
    startedAt,
    committedAt: startedAt,
    sourceRecordCount: args.records.length,
    targetRecordCount: encrypted.length,
    sourceDigest: await encryptedRecordsDigest(args.cryptoProvider, args.records),
    targetDigest: await encryptedRecordsDigest(args.cryptoProvider, encrypted),
  };
  return {
    state,
    sourceHeader: structuredClone(args.header),
    sourceRecords: args.records.map((record) => structuredClone(record)),
    targetHeader: header,
    targetRecords: encrypted,
  };
}

export async function verifyCommittedMigration(args: {
  cryptoProvider: Crypto;
  key: CryptoKey;
  state: VaultMigrationState;
  header: VaultHeader;
  records: readonly EncryptedRecord[];
}): Promise<PrivateMemoryRecord[]> {
  const state = validateMigrationState(args.state);
  if (
    args.header.schemaVersion !== state.toVersion ||
    args.records.length !== state.targetRecordCount ||
    await encryptedRecordsDigest(args.cryptoProvider, args.records) !== state.targetDigest
  ) {
    throw new Error("Committed vault migration does not match its verified target.");
  }
  return decryptAndValidateCurrent(args.cryptoProvider, args.key, args.records);
}

export async function verifyMigrationBackup(args: {
  cryptoProvider: Crypto;
  key: CryptoKey;
  state: VaultMigrationState;
  currentHeader: VaultHeader;
  backup: VaultMigrationBackup;
}): Promise<void> {
  const state = validateMigrationState(args.state);
  const sourceHeader = validatePersistedHeader(args.backup.sourceHeader);
  if (sourceHeader.schemaVersion !== LEGACY_MEMORY_SCHEMA_VERSION) {
    throw new Error("Vault migration backup header is not the declared legacy schema.");
  }
  if (
    sourceHeader.vaultId !== args.currentHeader.vaultId ||
    sourceHeader.createdAt !== args.currentHeader.createdAt ||
    JSON.stringify(sourceHeader.kdf) !== JSON.stringify(args.currentHeader.kdf) ||
    JSON.stringify(sourceHeader.wrapping) !== JSON.stringify(args.currentHeader.wrapping)
  ) {
    throw new Error("Vault migration backup header does not belong to the active verified vault.");
  }
  if (
    args.backup.sourceRecords.length !== state.sourceRecordCount ||
    await encryptedRecordsDigest(args.cryptoProvider, args.backup.sourceRecords) !== state.sourceDigest
  ) {
    throw new Error("Vault migration backup ciphertext does not match its committed digest.");
  }
  const migrated: PrivateMemoryRecord[] = [];
  for (const persisted of args.backup.sourceRecords) {
    validatePersistedEncryptedRecord(persisted, LEGACY_MEMORY_SCHEMA_VERSION);
    migrated.push(migratePrivateRecord(await decryptPersistedRecord(args.cryptoProvider, args.key, persisted)));
  }
  verifyPrivateRecordGraph(migrated);
}
