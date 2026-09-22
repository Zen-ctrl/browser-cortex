import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type {
  EncryptedRecord,
  LegacyEncryptedRecord,
  LegacyVaultHeader,
  MemoryStorageAdapter,
  PersistedEncryptedRecord,
  PersistedVaultHeader,
  VaultHeader,
  VaultMigrationBackup,
  VaultMigrationCommit,
  VaultMigrationState,
} from "./types.js";

interface MemoryDatabase extends DBSchema {
  meta: {
    key: string;
    value: PersistedVaultHeader;
  };
  records: {
    key: string;
    value: PersistedEncryptedRecord;
    indexes: { kind: string };
  };
  migration: {
    key: string;
    value: VaultMigrationState | LegacyVaultHeader;
  };
  migrationRecords: {
    key: string;
    value: LegacyEncryptedRecord;
  };
}

const HEADER_KEY = "vault-header";
const MIGRATION_STATE_KEY = "state";
const MIGRATION_SOURCE_HEADER_KEY = "source-header";

function recordsMatch(
  left: readonly PersistedEncryptedRecord[],
  right: readonly PersistedEncryptedRecord[],
): boolean {
  if (left.length !== right.length) return false;
  const canonical = (records: readonly PersistedEncryptedRecord[]): string => JSON.stringify(
    [...records].sort((a, b) => a.id.localeCompare(b.id)),
  );
  return canonical(left) === canonical(right);
}

function validNamespace(namespace: string): string {
  const value = namespace.trim();
  if (value.length < 1 || value.length > 128 || !/^[a-zA-Z0-9._-]+$/u.test(value)) {
    throw new Error("Memory namespace must contain 1 to 128 safe characters.");
  }
  return value;
}

export class IndexedDbMemoryStorage implements MemoryStorageAdapter {
  readonly #databaseName: string;
  #database: Promise<IDBPDatabase<MemoryDatabase>> | undefined;

  constructor(namespace: string) {
    this.#databaseName = `browser-cortex-vault-${validNamespace(namespace)}`;
  }

  async #db(): Promise<IDBPDatabase<MemoryDatabase>> {
    this.#database ??= openDB<MemoryDatabase>(this.#databaseName, 2, {
      upgrade(database) {
        if (!database.objectStoreNames.contains("meta")) database.createObjectStore("meta");
        if (!database.objectStoreNames.contains("records")) {
          const records = database.createObjectStore("records", { keyPath: "id" });
          records.createIndex("kind", "kind", { unique: false });
        }
        if (!database.objectStoreNames.contains("migration")) database.createObjectStore("migration");
        if (!database.objectStoreNames.contains("migrationRecords")) {
          database.createObjectStore("migrationRecords", { keyPath: "id" });
        }
      },
      blocked() {
        throw new Error("Vault upgrade is blocked by another open BrowserCortex tab.");
      },
      blocking: () => {
        // Closing lets another context complete a version upgrade without risking split schemas.
        void this.close();
      },
    });
    return this.#database;
  }

  async getHeader(): Promise<PersistedVaultHeader | undefined> {
    return (await this.#db()).get("meta", HEADER_KEY);
  }

  async setHeader(header: VaultHeader): Promise<void> {
    await (await this.#db()).put("meta", header, HEADER_KEY);
  }

  async listRecords(): Promise<PersistedEncryptedRecord[]> {
    return (await this.#db()).getAll("records");
  }

  async getRecord(id: string): Promise<PersistedEncryptedRecord | undefined> {
    return (await this.#db()).get("records", id);
  }

  async putRecords(records: readonly EncryptedRecord[]): Promise<void> {
    if (records.length === 0) return;
    const transaction = (await this.#db()).transaction("records", "readwrite", { durability: "strict" });
    await Promise.all([...records.map((record) => transaction.store.put(record)), transaction.done]);
  }

  async deleteRecords(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const transaction = (await this.#db()).transaction("records", "readwrite", { durability: "strict" });
    await Promise.all([...ids.map((id) => transaction.store.delete(id)), transaction.done]);
  }

  async replaceAll(header: VaultHeader, records: readonly EncryptedRecord[]): Promise<void> {
    const database = await this.#db();
    const transaction = database.transaction(["meta", "records", "migration", "migrationRecords"], "readwrite", { durability: "strict" });
    await transaction.objectStore("records").clear();
    await transaction.objectStore("meta").put(header, HEADER_KEY);
    for (const record of records) await transaction.objectStore("records").put(record);
    await transaction.objectStore("migration").clear();
    await transaction.objectStore("migrationRecords").clear();
    await transaction.done;
  }

  async getMigrationState(): Promise<VaultMigrationState | undefined> {
    const value = await (await this.#db()).get("migration", MIGRATION_STATE_KEY);
    return value as VaultMigrationState | undefined;
  }

  async getMigrationBackup(migrationId: string): Promise<VaultMigrationBackup | undefined> {
    const database = await this.#db();
    const transaction = database.transaction(["migration", "migrationRecords"], "readonly");
    const [state, sourceHeader, sourceRecords] = await Promise.all([
      transaction.objectStore("migration").get(MIGRATION_STATE_KEY),
      transaction.objectStore("migration").get(MIGRATION_SOURCE_HEADER_KEY),
      transaction.objectStore("migrationRecords").getAll(),
      transaction.done,
    ]);
    if (!state || !("id" in state) || state.id !== migrationId || !sourceHeader || !("vaultId" in sourceHeader)) {
      return undefined;
    }
    return { sourceHeader, sourceRecords };
  }

  async commitMigration(migration: VaultMigrationCommit): Promise<void> {
    const database = await this.#db();
    const transaction = database.transaction(["meta", "records", "migration", "migrationRecords"], "readwrite", { durability: "strict" });
    const meta = transaction.objectStore("meta");
    const records = transaction.objectStore("records");
    const migrationMeta = transaction.objectStore("migration");
    const backupRecords = transaction.objectStore("migrationRecords");
    const [activeHeader, activeRecords, existingState] = await Promise.all([
      meta.get(HEADER_KEY),
      records.getAll(),
      migrationMeta.get(MIGRATION_STATE_KEY),
    ]);
    if (
      existingState !== undefined ||
      JSON.stringify(activeHeader) !== JSON.stringify(migration.sourceHeader) ||
      !recordsMatch(activeRecords, migration.sourceRecords)
    ) {
      transaction.abort();
      throw new Error("Vault changed while its migration was being prepared. The previous encrypted data remains active.");
    }
    await backupRecords.clear();
    for (const record of activeRecords) await backupRecords.put(record as LegacyEncryptedRecord);
    await migrationMeta.put(migration.sourceHeader, MIGRATION_SOURCE_HEADER_KEY);
    await migrationMeta.put(migration.state, MIGRATION_STATE_KEY);
    await records.clear();
    for (const record of migration.targetRecords) await records.put(record);
    await meta.put(migration.targetHeader, HEADER_KEY);
    await transaction.done;
  }

  async rollbackMigration(migrationId: string, verifiedBackup: VaultMigrationBackup): Promise<void> {
    const database = await this.#db();
    const transaction = database.transaction(["meta", "records", "migration", "migrationRecords"], "readwrite", { durability: "strict" });
    const migrationMeta = transaction.objectStore("migration");
    const state = await migrationMeta.get(MIGRATION_STATE_KEY);
    const sourceHeader = await migrationMeta.get(MIGRATION_SOURCE_HEADER_KEY);
    const sourceRecords = await transaction.objectStore("migrationRecords").getAll();
    if (
      !state ||
      !("id" in state) ||
      state.id !== migrationId ||
      !sourceHeader ||
      !("vaultId" in sourceHeader) ||
      sourceRecords.length !== state.sourceRecordCount ||
      JSON.stringify(sourceHeader) !== JSON.stringify(verifiedBackup.sourceHeader) ||
      !recordsMatch(sourceRecords, verifiedBackup.sourceRecords)
    ) {
      transaction.abort();
      throw new Error("Vault migration backup is unavailable; the active encrypted data was left untouched.");
    }
    const records = transaction.objectStore("records");
    await records.clear();
    for (const record of sourceRecords) await records.put(record);
    await transaction.objectStore("meta").put(sourceHeader, HEADER_KEY);
    await migrationMeta.clear();
    await transaction.objectStore("migrationRecords").clear();
    await transaction.done;
  }

  async finalizeMigration(migrationId: string): Promise<void> {
    const database = await this.#db();
    const transaction = database.transaction(["migration", "migrationRecords"], "readwrite", { durability: "strict" });
    const migrationMeta = transaction.objectStore("migration");
    const state = await migrationMeta.get(MIGRATION_STATE_KEY);
    if (!state || !("id" in state) || state.id !== migrationId) {
      transaction.abort();
      throw new Error("Vault migration state changed before finalization.");
    }
    await migrationMeta.clear();
    await transaction.objectStore("migrationRecords").clear();
    await transaction.done;
  }

  async clear(): Promise<void> {
    const database = await this.#db();
    const transaction = database.transaction(["meta", "records", "migration", "migrationRecords"], "readwrite", { durability: "strict" });
    await Promise.all([
      transaction.objectStore("meta").clear(),
      transaction.objectStore("records").clear(),
      transaction.objectStore("migration").clear(),
      transaction.objectStore("migrationRecords").clear(),
      transaction.done,
    ]);
  }

  async close(): Promise<void> {
    if (!this.#database) return;
    (await this.#database).close();
    this.#database = undefined;
  }
}

/** Explicit test adapter. Production callers use IndexedDbMemoryStorage by default. */
export class InMemoryMemoryStorage implements MemoryStorageAdapter {
  #header: PersistedVaultHeader | undefined;
  #records = new Map<string, PersistedEncryptedRecord>();
  #migrationState: VaultMigrationState | undefined;
  #migrationSourceHeader: LegacyVaultHeader | undefined;
  #migrationSourceRecords = new Map<string, LegacyEncryptedRecord>();

  async getHeader(): Promise<PersistedVaultHeader | undefined> {
    return this.#header ? structuredClone(this.#header) : undefined;
  }

  async setHeader(header: VaultHeader): Promise<void> {
    this.#header = structuredClone(header);
  }

  async listRecords(): Promise<PersistedEncryptedRecord[]> {
    return [...this.#records.values()].map((record) => structuredClone(record));
  }

  async getRecord(id: string): Promise<PersistedEncryptedRecord | undefined> {
    const record = this.#records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async putRecords(records: readonly EncryptedRecord[]): Promise<void> {
    for (const record of records) this.#records.set(record.id, structuredClone(record));
  }

  async deleteRecords(ids: readonly string[]): Promise<void> {
    for (const id of ids) this.#records.delete(id);
  }

  async replaceAll(header: VaultHeader, records: readonly EncryptedRecord[]): Promise<void> {
    this.#header = structuredClone(header);
    this.#records.clear();
    for (const record of records) this.#records.set(record.id, structuredClone(record));
    this.#migrationState = undefined;
    this.#migrationSourceHeader = undefined;
    this.#migrationSourceRecords.clear();
  }

  async getMigrationState(): Promise<VaultMigrationState | undefined> {
    return this.#migrationState ? structuredClone(this.#migrationState) : undefined;
  }

  async getMigrationBackup(migrationId: string): Promise<VaultMigrationBackup | undefined> {
    if (!this.#migrationState || this.#migrationState.id !== migrationId || !this.#migrationSourceHeader) return undefined;
    return {
      sourceHeader: structuredClone(this.#migrationSourceHeader),
      sourceRecords: [...this.#migrationSourceRecords.values()].map((record) => structuredClone(record)),
    };
  }

  async commitMigration(migration: VaultMigrationCommit): Promise<void> {
    if (
      this.#migrationState ||
      JSON.stringify(this.#header) !== JSON.stringify(migration.sourceHeader) ||
      !recordsMatch([...this.#records.values()], migration.sourceRecords)
    ) {
      throw new Error("Vault changed while its migration was being prepared. The previous encrypted data remains active.");
    }
    const sourceHeader = structuredClone(migration.sourceHeader);
    const sourceRecords = new Map(migration.sourceRecords.map((record) => [record.id, structuredClone(record)]));
    const targetHeader = structuredClone(migration.targetHeader);
    const targetRecords = new Map(migration.targetRecords.map((record) => [record.id, structuredClone(record)]));
    const state = structuredClone(migration.state);
    this.#migrationSourceHeader = sourceHeader;
    this.#migrationSourceRecords = sourceRecords;
    this.#migrationState = state;
    this.#header = targetHeader;
    this.#records = targetRecords;
  }

  async rollbackMigration(migrationId: string, verifiedBackup: VaultMigrationBackup): Promise<void> {
    if (
      !this.#migrationState ||
      this.#migrationState.id !== migrationId ||
      !this.#migrationSourceHeader ||
      this.#migrationSourceRecords.size !== this.#migrationState.sourceRecordCount ||
      JSON.stringify(this.#migrationSourceHeader) !== JSON.stringify(verifiedBackup.sourceHeader) ||
      !recordsMatch([...this.#migrationSourceRecords.values()], verifiedBackup.sourceRecords)
    ) {
      throw new Error("Vault migration backup is unavailable; the active encrypted data was left untouched.");
    }
    const restoredHeader = structuredClone(this.#migrationSourceHeader);
    const restoredRecords = new Map(
      [...this.#migrationSourceRecords.values()].map((record) => [record.id, structuredClone(record)]),
    );
    this.#header = restoredHeader;
    this.#records = restoredRecords;
    this.#migrationState = undefined;
    this.#migrationSourceHeader = undefined;
    this.#migrationSourceRecords.clear();
  }

  async finalizeMigration(migrationId: string): Promise<void> {
    if (!this.#migrationState || this.#migrationState.id !== migrationId) {
      throw new Error("Vault migration state changed before finalization.");
    }
    this.#migrationState = undefined;
    this.#migrationSourceHeader = undefined;
    this.#migrationSourceRecords.clear();
  }

  async clear(): Promise<void> {
    this.#header = undefined;
    this.#records.clear();
    this.#migrationState = undefined;
    this.#migrationSourceHeader = undefined;
    this.#migrationSourceRecords.clear();
  }

  async close(): Promise<void> {}
}
