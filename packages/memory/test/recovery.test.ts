import { describe, expect, it } from "vitest";
import {
  createEncryptedMemory,
  LEGACY_MEMORY_SCHEMA_VERSION,
  MEMORY_SCHEMA_VERSION,
} from "../src/index.js";
import type {
  EncryptedRecord,
  LegacyEncryptedRecord,
  LegacyEncryptedVaultExport,
  LegacyVaultHeader,
  MemoryStorageAdapter,
  PersistedEncryptedRecord,
  PersistedVaultHeader,
  VaultHeader,
  VaultMigrationBackup,
  VaultMigrationCommit,
  VaultMigrationState,
} from "../src/index.js";

const PASSPHRASE = "migration fixture passphrase";
const TIMESTAMP = "2026-09-22T12:00:00.000Z";

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function legacyFixture(): Promise<{
  header: LegacyVaultHeader;
  records: LegacyEncryptedRecord[];
  workspaceId: string;
  archive: LegacyEncryptedVaultExport;
}> {
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const wrappingNonce = crypto.getRandomValues(new Uint8Array(12));
  const passphraseKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(PASSPHRASE), "PBKDF2", false, ["deriveKey"]);
  const wrappingKey = await crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 },
    passphraseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const wrapped = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: wrappingNonce,
      additionalData: new TextEncoder().encode("BrowserCortex:v1:data-key"),
      tagLength: 128,
    },
    wrappingKey,
    rawKey,
  );
  const dataKey = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  rawKey.fill(0);
  const workspaceId = "legacy-workspace";
  const plaintext = [
    {
      schemaVersion: LEGACY_MEMORY_SCHEMA_VERSION,
      kind: "workspace",
      id: workspaceId,
      name: "Legacy workspace",
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      sensitivity: "internal",
    },
    {
      schemaVersion: LEGACY_MEMORY_SCHEMA_VERSION,
      kind: "document",
      id: "legacy-document",
      workspaceId,
      title: "Legacy delivery note",
      mediaType: "text/plain",
      revisionIds: ["legacy-revision"],
      currentRevisionId: "legacy-revision",
      sensitivity: "internal",
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    },
    {
      schemaVersion: LEGACY_MEMORY_SCHEMA_VERSION,
      kind: "revision",
      id: "legacy-revision",
      documentId: "legacy-document",
      workspaceId,
      fingerprint: "a".repeat(64),
      mediaType: "text/plain",
      originalText: "The legacy delivery date is October 8.",
      byteLength: 38,
      chunkIds: ["legacy-chunk"],
      createdAt: TIMESTAMP,
    },
    {
      schemaVersion: LEGACY_MEMORY_SCHEMA_VERSION,
      kind: "chunk",
      id: "legacy-chunk",
      documentId: "legacy-document",
      revisionId: "legacy-revision",
      workspaceId,
      index: 0,
      text: "The legacy delivery date is October 8.",
      startOffset: 0,
      endOffset: 38,
      tokenTerms: ["legacy", "delivery", "date", "october"],
      sensitivity: "internal",
    },
  ] as const;
  const records: LegacyEncryptedRecord[] = [];
  for (const record of plaintext) {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: new TextEncoder().encode(JSON.stringify({
          schemaVersion: LEGACY_MEMORY_SCHEMA_VERSION,
          id: record.id,
          kind: record.kind,
        })),
        tagLength: 128,
      },
      dataKey,
      new TextEncoder().encode(JSON.stringify(record)),
    );
    records.push({
      schemaVersion: LEGACY_MEMORY_SCHEMA_VERSION,
      id: record.id,
      kind: record.kind,
      nonce: base64(nonce),
      ciphertext: base64(new Uint8Array(cipher)),
      byteLength: cipher.byteLength,
    });
  }
  const header: LegacyVaultHeader = {
    schemaVersion: LEGACY_MEMORY_SCHEMA_VERSION,
    vaultId: "legacy-vault",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: 100_000, salt: base64(salt) },
    wrapping: { algorithm: "AES-GCM", nonce: base64(wrappingNonce), wrappedDataKey: base64(new Uint8Array(wrapped)) },
  };
  return {
    header,
    records,
    workspaceId,
    archive: { format: "browser-cortex-encrypted-vault", schemaVersion: 1, exportedAt: TIMESTAMP, header, records },
  };
}

type Fault = "before-commit" | "after-commit" | "before-finalize";

class MigrationHarnessStorage implements MemoryStorageAdapter {
  header: PersistedVaultHeader;
  records: PersistedEncryptedRecord[];
  state?: VaultMigrationState;
  sourceHeader?: LegacyVaultHeader;
  sourceRecords: LegacyEncryptedRecord[] = [];
  fault?: Fault;
  rollbackCalls = 0;

  constructor(header: LegacyVaultHeader, records: readonly LegacyEncryptedRecord[]) {
    this.header = structuredClone(header);
    this.records = records.map((record) => structuredClone(record));
  }

  async getHeader(): Promise<PersistedVaultHeader | undefined> { return structuredClone(this.header); }
  async setHeader(header: VaultHeader): Promise<void> { this.header = structuredClone(header); }
  async listRecords(): Promise<PersistedEncryptedRecord[]> { return this.records.map((record) => structuredClone(record)); }
  async getRecord(id: string): Promise<PersistedEncryptedRecord | undefined> {
    const record = this.records.find((candidate) => candidate.id === id);
    return record ? structuredClone(record) : undefined;
  }
  async putRecords(records: readonly EncryptedRecord[]): Promise<void> {
    const replacements = new Map(records.map((record) => [record.id, structuredClone(record)]));
    this.records = this.records.filter((record) => !replacements.has(record.id));
    this.records.push(...replacements.values());
  }
  async deleteRecords(ids: readonly string[]): Promise<void> {
    const removed = new Set(ids);
    this.records = this.records.filter((record) => !removed.has(record.id));
  }
  async replaceAll(header: VaultHeader, records: readonly EncryptedRecord[]): Promise<void> {
    this.header = structuredClone(header);
    this.records = records.map((record) => structuredClone(record));
    this.state = undefined;
    this.sourceHeader = undefined;
    this.sourceRecords = [];
  }
  async getMigrationState(): Promise<VaultMigrationState | undefined> { return this.state ? structuredClone(this.state) : undefined; }
  async getMigrationBackup(migrationId: string): Promise<VaultMigrationBackup | undefined> {
    if (!this.state || this.state.id !== migrationId || !this.sourceHeader) return undefined;
    return {
      sourceHeader: structuredClone(this.sourceHeader),
      sourceRecords: this.sourceRecords.map((record) => structuredClone(record)),
    };
  }
  async commitMigration(migration: VaultMigrationCommit): Promise<void> {
    if (this.fault === "before-commit") {
      this.fault = undefined;
      throw new Error("synthetic crash before migration commit");
    }
    this.sourceHeader = structuredClone(migration.sourceHeader);
    this.sourceRecords = migration.sourceRecords.map((record) => structuredClone(record));
    this.state = structuredClone(migration.state);
    this.header = structuredClone(migration.targetHeader);
    this.records = migration.targetRecords.map((record) => structuredClone(record));
    if (this.fault === "after-commit") {
      this.fault = undefined;
      throw new Error("synthetic crash after atomic migration commit");
    }
  }
  async rollbackMigration(migrationId: string, verifiedBackup: VaultMigrationBackup): Promise<void> {
    this.rollbackCalls += 1;
    if (
      !this.state ||
      this.state.id !== migrationId ||
      !this.sourceHeader ||
      this.sourceRecords.length !== this.state.sourceRecordCount ||
      JSON.stringify(this.sourceHeader) !== JSON.stringify(verifiedBackup.sourceHeader) ||
      JSON.stringify(this.sourceRecords) !== JSON.stringify(verifiedBackup.sourceRecords)
    ) {
      throw new Error("missing or changed migration backup");
    }
    this.header = structuredClone(this.sourceHeader);
    this.records = this.sourceRecords.map((record) => structuredClone(record));
    this.state = undefined;
    this.sourceHeader = undefined;
    this.sourceRecords = [];
  }
  async finalizeMigration(migrationId: string): Promise<void> {
    if (!this.state || this.state.id !== migrationId) throw new Error("missing migration state");
    if (this.fault === "before-finalize") {
      this.fault = undefined;
      throw new Error("synthetic crash before migration finalization");
    }
    this.state = undefined;
    this.sourceHeader = undefined;
    this.sourceRecords = [];
  }
  async clear(): Promise<void> { this.records = []; }
  async close(): Promise<void> {}
}

describe("vault schema migration and crash recovery", () => {
  it("migrates v1 ciphertext to v2, verifies relationships, and preserves search", async () => {
    const fixture = await legacyFixture();
    const storage = new MigrationHarnessStorage(fixture.header, fixture.records);
    const vault = createEncryptedMemory({ namespace: "migration-success", storage, autoLockMs: 0 });

    await vault.initialize();
    await vault.unlock(PASSPHRASE);

    expect(storage.header.schemaVersion).toBe(MEMORY_SCHEMA_VERSION);
    expect(storage.records.every((record) => record.schemaVersion === MEMORY_SCHEMA_VERSION)).toBe(true);
    expect(storage.state).toBeUndefined();
    expect(storage.sourceRecords).toEqual([]);
    expect(await vault.search({ workspaceId: fixture.workspaceId, query: "delivery October" })).toHaveLength(1);
  });

  it("keeps v1 active if preparation cannot commit and retries finalization without discarding a verified v2 target", async () => {
    const fixture = await legacyFixture();
    const storage = new MigrationHarnessStorage(fixture.header, fixture.records);
    storage.fault = "before-commit";
    const first = createEncryptedMemory({ namespace: "migration-before-commit", storage, autoLockMs: 0 });
    await expect(first.unlock(PASSPHRASE)).rejects.toThrow("before migration commit");
    expect(storage.header.schemaVersion).toBe(LEGACY_MEMORY_SCHEMA_VERSION);
    expect(storage.records).toEqual(fixture.records);

    storage.fault = "before-finalize";
    const second = createEncryptedMemory({ namespace: "migration-before-finalize", storage, autoLockMs: 0 });
    await expect(second.unlock(PASSPHRASE)).rejects.toThrow("finalization");
    expect(storage.header.schemaVersion).toBe(MEMORY_SCHEMA_VERSION);
    expect(storage.records.every((record) => record.schemaVersion === MEMORY_SCHEMA_VERSION)).toBe(true);
    expect(storage.state).toBeDefined();
    expect(storage.sourceRecords).toEqual(fixture.records);
    expect(storage.rollbackCalls).toBe(0);

    const retry = createEncryptedMemory({ namespace: "migration-before-finalize", storage, autoLockMs: 0 });
    await retry.unlock(PASSPHRASE);
    expect(storage.header.schemaVersion).toBe(MEMORY_SCHEMA_VERSION);
    expect(storage.state).toBeUndefined();
    expect(storage.sourceRecords).toEqual([]);
    expect(await retry.search({ workspaceId: fixture.workspaceId, query: "delivery October" })).toHaveLength(1);
  });

  it("resumes a verified atomic commit after a crash and removes the backup only afterward", async () => {
    const fixture = await legacyFixture();
    const storage = new MigrationHarnessStorage(fixture.header, fixture.records);
    storage.fault = "after-commit";
    const interrupted = createEncryptedMemory({ namespace: "migration-after-commit", storage, autoLockMs: 0 });
    await expect(interrupted.unlock(PASSPHRASE)).rejects.toThrow("after atomic migration commit");
    expect(storage.header.schemaVersion).toBe(MEMORY_SCHEMA_VERSION);
    expect(storage.state).toBeDefined();
    expect(storage.sourceRecords).toEqual(fixture.records);

    const restarted = createEncryptedMemory({ namespace: "migration-after-commit", storage, autoLockMs: 0 });
    await restarted.unlock(PASSPHRASE);
    expect(storage.state).toBeUndefined();
    expect(storage.sourceRecords).toEqual([]);
    expect(await restarted.search({ workspaceId: fixture.workspaceId, query: "legacy date" })).toHaveLength(1);
  });

  it("rolls back a corrupted committed target and imports a valid v1 archive without exposing plaintext", async () => {
    const fixture = await legacyFixture();
    const storage = new MigrationHarnessStorage(fixture.header, fixture.records);
    storage.fault = "after-commit";
    const interrupted = createEncryptedMemory({ namespace: "migration-corruption", storage, autoLockMs: 0 });
    await expect(interrupted.unlock(PASSPHRASE)).rejects.toThrow();
    const target = storage.records[0];
    if (!target) throw new Error("Expected a committed target record.");
    target.ciphertext = `${target.ciphertext.slice(0, -4)}AAAA`;

    const restarted = createEncryptedMemory({ namespace: "migration-corruption", storage, autoLockMs: 0 });
    await expect(restarted.unlock(PASSPHRASE)).rejects.toThrow("schema 1 was restored");
    expect(storage.header.schemaVersion).toBe(LEGACY_MEMORY_SCHEMA_VERSION);
    expect(storage.records).toEqual(fixture.records);

    const imported = createEncryptedMemory({ namespace: "legacy-import", storage: new MigrationHarnessStorage(fixture.header, fixture.records), autoLockMs: 0 });
    await imported.importEncrypted(fixture.archive, PASSPHRASE);
    expect(await imported.search({ workspaceId: fixture.workspaceId, query: "October" })).toHaveLength(1);
  });

  it("does not replace the active v2 target when both it and the retained backup fail verification", async () => {
    const fixture = await legacyFixture();
    const storage = new MigrationHarnessStorage(fixture.header, fixture.records);
    storage.fault = "after-commit";
    const interrupted = createEncryptedMemory({ namespace: "migration-double-corruption", storage, autoLockMs: 0 });
    await expect(interrupted.unlock(PASSPHRASE)).rejects.toThrow("after atomic migration commit");
    const activeRecord = storage.records[0];
    const backupRecord = storage.sourceRecords[0];
    if (!activeRecord || !backupRecord) throw new Error("Expected active and backup migration records.");
    activeRecord.ciphertext = `${activeRecord.ciphertext[0] === "A" ? "B" : "A"}${activeRecord.ciphertext.slice(1)}`;
    backupRecord.ciphertext = `${backupRecord.ciphertext[0] === "A" ? "B" : "A"}${backupRecord.ciphertext.slice(1)}`;
    const activeHeaderBeforeRecovery = structuredClone(storage.header);
    const activeRecordsBeforeRecovery = structuredClone(storage.records);
    const stateBeforeRecovery = structuredClone(storage.state);

    const restarted = createEncryptedMemory({ namespace: "migration-double-corruption", storage, autoLockMs: 0 });
    await expect(restarted.unlock(PASSPHRASE)).rejects.toThrow();
    expect(storage.header).toEqual(activeHeaderBeforeRecovery);
    expect(storage.records).toEqual(activeRecordsBeforeRecovery);
    expect(storage.state).toEqual(stateBeforeRecovery);
    expect(storage.rollbackCalls).toBe(0);
  });

  it("rejects a future persisted schema without changing its ciphertext", async () => {
    const fixture = await legacyFixture();
    const storage = new MigrationHarnessStorage(fixture.header, fixture.records);
    storage.header = { ...fixture.header, schemaVersion: 99 } as unknown as PersistedVaultHeader;
    const before = structuredClone(storage.records);
    const vault = createEncryptedMemory({ namespace: "future-schema", storage, autoLockMs: 0 });

    await expect(vault.initialize()).rejects.toThrow("not supported");
    expect(storage.records).toEqual(before);
    expect(storage.state).toBeUndefined();
  });
});
