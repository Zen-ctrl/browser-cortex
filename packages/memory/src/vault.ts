import {
  createVaultKey,
  decryptRecord,
  encryptRecord,
  rewrapRawVaultKey,
  unwrapVaultKeyMaterial,
  type VaultKeyMaterial,
} from "./crypto.js";
import { randomId } from "./encoding.js";
import { createChunks, decodeAndValidateImport, fingerprintImport } from "./ingest.js";
import {
  prepareVaultMigration,
  validateMigrationState,
  verifyCommittedMigration,
  verifyMigrationBackup,
} from "./migrations.js";
import { retrieve } from "./retrieval.js";
import { IndexedDbMemoryStorage } from "./storage.js";
import type {
  ChunkRecord,
  DerivedRecord,
  DocumentRecord,
  DocumentRevisionRecord,
  EmbeddingRecord,
  EncryptedMemoryOptions,
  EncryptedRecord,
  EncryptedVaultExport,
  ImportSource,
  IngestResult,
  MemoryStorageAdapter,
  PersistedVaultHeader,
  PrivateMemoryRecord,
  SearchRequest,
  SearchResult,
  SourceGrantRecord,
  StoredReceiptRecord,
  StoredWorkflowRecord,
  StagingRecord,
  VaultHeader,
  VaultMigrationState,
  VaultStatus,
  WorkspaceRecord,
} from "./types.js";
import {
  DEFAULT_MAX_CHUNKS,
  DEFAULT_MAX_DOCUMENT_BYTES,
  LEGACY_MEMORY_SCHEMA_VERSION,
  MEMORY_SCHEMA_VERSION,
} from "./types.js";
import {
  validateEncryptedRecord,
  validateHeader,
  validatePersistedEncryptedRecord,
  validatePersistedHeader,
  validateVaultExportForImport,
} from "./validation.js";

const DEFAULT_AUTO_LOCK_MS = 15 * 60 * 1_000;
const EMBEDDING_BATCH_SIZE = 32;

function getCrypto(provided: Crypto | undefined): Crypto {
  const value = provided ?? globalThis.crypto;
  if (!value?.subtle) throw new Error("Web Crypto is required for encrypted memory.");
  return value;
}

function sanitizedSourceUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    throw new Error("Source URL is invalid.");
  }
}

function isRecordKind<TKind extends PrivateMemoryRecord["kind"]>(
  record: PrivateMemoryRecord,
  kind: TKind,
): record is Extract<PrivateMemoryRecord, { kind: TKind }> {
  return record.kind === kind;
}

export class EncryptedMemoryVault {
  readonly #crypto: Crypto;
  readonly #storage: MemoryStorageAdapter;
  readonly #now: () => Date;
  readonly #autoLockMs: number;
  readonly #maxDocumentBytes: number;
  readonly #maxChunks: number;
  readonly #defaultEmbeddingProvider: EncryptedMemoryOptions["embeddingProvider"];
  readonly #onLock: EncryptedMemoryOptions["onLock"];
  readonly #records = new Map<string, PrivateMemoryRecord>();
  #header: PersistedVaultHeader | undefined;
  #keyMaterial: VaultKeyMaterial | undefined;
  #lastUnlockedAt: string | undefined;
  #autoLockTimer: ReturnType<typeof setTimeout> | undefined;
  #operationTail: Promise<void> = Promise.resolve();
  #epoch = 0;

  constructor(options: EncryptedMemoryOptions) {
    if (!options.namespace) throw new Error("A memory namespace is required.");
    this.#crypto = getCrypto(options.crypto);
    this.#storage = options.storage ?? new IndexedDbMemoryStorage(options.namespace);
    this.#now = options.now ?? (() => new Date());
    this.#autoLockMs = options.autoLockMs ?? DEFAULT_AUTO_LOCK_MS;
    this.#maxDocumentBytes = options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
    this.#maxChunks = options.maxChunks ?? DEFAULT_MAX_CHUNKS;
    this.#defaultEmbeddingProvider = options.embeddingProvider;
    this.#onLock = options.onLock;
    if (!Number.isSafeInteger(this.#autoLockMs) || this.#autoLockMs < 0) throw new Error("autoLockMs must be a non-negative integer.");
  }

  initialize(): Promise<VaultStatus> {
    return this.#runExclusive((epoch) => this.#initialize(epoch));
  }

  async #initialize(epoch: number): Promise<VaultStatus> {
    const header = await this.#storage.getHeader();
    this.#assertEpoch(epoch);
    this.#header = header === undefined ? undefined : validatePersistedHeader(header);
    return this.#status(epoch);
  }

  status(): Promise<VaultStatus> {
    return this.#runExclusive((epoch) => this.#status(epoch));
  }

  async #status(epoch: number): Promise<VaultStatus> {
    const storedHeader = this.#header ?? (await this.#storage.getHeader());
    this.#assertEpoch(epoch);
    const header = storedHeader === undefined ? undefined : validatePersistedHeader(storedHeader);
    this.#header = header;
    const encrypted = header ? await this.#storage.listRecords() : [];
    this.#assertEpoch(epoch);
    const base = {
      state: (header ? (this.#keyMaterial ? "unlocked" : "locked") : "missing") as VaultStatus["state"],
      recordCount: encrypted.length,
      encryptedBytes: encrypted.reduce((sum, record) => sum + record.byteLength, 0),
    };
    const withId = header ? { ...base, vaultId: header.vaultId } : base;
    return this.#lastUnlockedAt ? { ...withId, lastUnlockedAt: this.#lastUnlockedAt } : withId;
  }

  create(passphrase: string): Promise<void> {
    return this.#runExclusive((epoch) => this.#create(passphrase, epoch));
  }

  async #create(passphrase: string, epoch: number): Promise<void> {
    if ((await this.#storage.getHeader()) !== undefined) throw new Error("A vault already exists in this namespace.");
    this.#assertEpoch(epoch);
    const created = await createVaultKey(this.#crypto, passphrase, this.#now());
    try {
      this.#assertEpoch(epoch);
      await this.#storage.replaceAll(created.header, []);
      this.#assertEpoch(epoch);
    } catch (error) {
      created.rawDataKey.fill(0);
      throw error;
    }
    this.#header = created.header;
    this.#keyMaterial = { key: created.dataKey, raw: created.rawDataKey };
    this.#records.clear();
    this.#lastUnlockedAt = this.#now().toISOString();
    this.#advanceEpoch();
    this.#touch();
  }

  unlock(passphrase: string): Promise<void> {
    return this.#runExclusive((epoch) => this.#unlock(passphrase, epoch));
  }

  async #unlock(passphrase: string, epoch: number): Promise<void> {
    const storedHeader = this.#header ?? (await this.#storage.getHeader());
    this.#assertEpoch(epoch);
    const header = storedHeader === undefined ? undefined : validatePersistedHeader(storedHeader);
    if (!header) throw new Error("No vault exists in this namespace.");
    const material = await unwrapVaultKeyMaterial(this.#crypto, header, passphrase);
    try {
      const migrated = await this.#loadOrMigrateRecords(header, material.key, epoch);
      this.#assertEpoch(epoch);
      this.#header = migrated.header;
      this.#keyMaterial?.raw.fill(0);
      this.#keyMaterial = material;
      this.#records.clear();
      for (const record of migrated.records) this.#records.set(record.id, record);
      await this.#recoverStaging(epoch);
      await this.#purgeExpired(this.#now(), epoch);
      this.#lastUnlockedAt = this.#now().toISOString();
      this.#advanceEpoch();
      this.#touch();
    } catch (error) {
      if (this.#keyMaterial === material) this.#clearUnlockedState();
      material.raw.fill(0);
      throw error;
    }
  }

  async #loadOrMigrateRecords(
    header: PersistedVaultHeader,
    key: CryptoKey,
    epoch: number,
  ): Promise<{ header: VaultHeader; records: PrivateMemoryRecord[] }> {
    const pendingStateRaw = await this.#storage.getMigrationState?.();
    this.#assertEpoch(epoch);
    if (pendingStateRaw !== undefined) {
      const state = validateMigrationState(pendingStateRaw);
      const getMigrationBackup = this.#storage.getMigrationBackup;
      const finalizeMigration = this.#storage.finalizeMigration;
      if (
        header.schemaVersion !== MEMORY_SCHEMA_VERSION ||
        !getMigrationBackup ||
        !this.#storage.rollbackMigration ||
        !finalizeMigration
      ) {
        throw new Error("Vault migration recovery metadata is inconsistent. The encrypted backup was preserved for recovery.");
      }
      let records: PrivateMemoryRecord[];
      try {
        const persisted = await this.#storage.listRecords();
        this.#assertEpoch(epoch);
        const current = persisted.map((record) => validateEncryptedRecord(record));
        records = await verifyCommittedMigration({
          cryptoProvider: this.#crypto,
          key,
          state,
          header,
          records: current,
        });
        this.#assertEpoch(epoch);
      } catch (error) {
        try {
          await this.#restoreVerifiedMigrationBackup(state, key, header, epoch);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "Vault migration verification failed and automatic rollback could not be confirmed. Preserve this browser profile and use the encrypted backup recovery path.",
          );
        }
        throw new Error(
          `Vault migration verification failed; schema ${state.fromVersion} was restored without silent deletion. Reopen with a compatible BrowserCortex version to export the vault.`,
          { cause: error },
        );
      }
      try {
        await finalizeMigration.call(this.#storage, state.id);
        this.#assertEpoch(epoch);
      } catch (error) {
        throw new Error(
          "Vault migration target was verified, but backup finalization was not confirmed. The verified v2 vault remains intact; retry unlock to complete or confirm cleanup.",
          { cause: error },
        );
      }
      return { header, records };
    }

    const persisted = await this.#storage.listRecords();
    this.#assertEpoch(epoch);
    if (header.schemaVersion === MEMORY_SCHEMA_VERSION) {
      const encrypted = persisted.map((record) => validateEncryptedRecord(record));
      const records: PrivateMemoryRecord[] = [];
      for (const record of encrypted) records.push(await decryptRecord(this.#crypto, key, record));
      return { header, records };
    }

    const activeSchemaVersion: number = header.schemaVersion;
    if (activeSchemaVersion !== LEGACY_MEMORY_SCHEMA_VERSION) {
      throw new Error(`Vault schema ${String(activeSchemaVersion)} is not supported. The encrypted vault was left untouched.`);
    }
    const commitMigration = this.#storage.commitMigration;
    const getMigrationBackup = this.#storage.getMigrationBackup;
    const finalizeMigration = this.#storage.finalizeMigration;
    if (!commitMigration || !getMigrationBackup || !this.#storage.rollbackMigration || !finalizeMigration) {
      throw new Error(
        `Vault schema ${header.schemaVersion} requires a transactional migration adapter. The encrypted vault remains readable by a compatible previous BrowserCortex version for export.`,
      );
    }
    const legacyRecords = persisted.map((record) => (
      validatePersistedEncryptedRecord(record, LEGACY_MEMORY_SCHEMA_VERSION)
    ));
    const prepared = await prepareVaultMigration({
      cryptoProvider: this.#crypto,
      key,
      header,
      records: legacyRecords,
      now: this.#now(),
    });
    this.#assertEpoch(epoch);
    try {
      await commitMigration.call(this.#storage, prepared);
    } catch (error) {
      // A storage adapter can report failure after an atomic commit becomes durable.
      // Refresh the active header so a retry on this same vault object can resume
      // the retained migration state instead of requiring a process restart.
      const activeHeader = await this.#storage.getHeader();
      this.#header = activeHeader === undefined ? undefined : validatePersistedHeader(activeHeader);
      throw error;
    }
    this.#assertEpoch(epoch);
    let committedHeader: VaultHeader;
    let records: PrivateMemoryRecord[];
    try {
      committedHeader = validateHeader(await this.#storage.getHeader());
      this.#header = committedHeader;
      const committedRecords = (await this.#storage.listRecords()).map((record) => validateEncryptedRecord(record));
      records = await verifyCommittedMigration({
        cryptoProvider: this.#crypto,
        key,
        state: prepared.state,
        header: committedHeader,
        records: committedRecords,
      });
      this.#assertEpoch(epoch);
    } catch (error) {
      try {
        const activeHeader = await this.#storage.getHeader();
        const currentHeader = validateHeader(activeHeader);
        await this.#restoreVerifiedMigrationBackup(prepared.state, key, currentHeader, epoch);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Vault migration commit could not be verified and automatic rollback could not be confirmed. Preserve this browser profile and use the encrypted backup recovery path.",
        );
      }
      throw new Error(
        `Vault migration failed after commit verification; schema ${prepared.state.fromVersion} was restored without silent deletion. Reopen with a compatible BrowserCortex version to export the vault.`,
        { cause: error },
      );
    }
    try {
      await finalizeMigration.call(this.#storage, prepared.state.id);
      this.#assertEpoch(epoch);
    } catch (error) {
      throw new Error(
        "Vault migration target was verified, but backup finalization was not confirmed. The verified v2 vault remains intact; retry unlock to complete or confirm cleanup.",
        { cause: error },
      );
    }
    return { header: committedHeader, records };
  }

  async #restoreVerifiedMigrationBackup(
    state: VaultMigrationState,
    key: CryptoKey,
    currentHeader: VaultHeader,
    epoch: number,
  ): Promise<void> {
    const getMigrationBackup = this.#storage.getMigrationBackup;
    const rollbackMigration = this.#storage.rollbackMigration;
    if (!getMigrationBackup || !rollbackMigration) {
      throw new Error("Vault migration recovery adapter is unavailable. The active ciphertext was left untouched.");
    }
    const backup = await getMigrationBackup.call(this.#storage, state.id);
    this.#assertEpoch(epoch);
    if (!backup) throw new Error("Vault migration backup is missing. The active ciphertext was left untouched.");
    await verifyMigrationBackup({
      cryptoProvider: this.#crypto,
      key,
      state,
      currentHeader,
      backup,
    });
    this.#assertEpoch(epoch);
    await rollbackMigration.call(this.#storage, state.id, backup);
    this.#assertEpoch(epoch);
    const restoredHeader = await this.#storage.getHeader();
    this.#assertEpoch(epoch);
    this.#header = restoredHeader === undefined ? undefined : validatePersistedHeader(restoredHeader);
  }

  lock(reason: "manual" | "auto" | "delete" | "dispose" = "manual"): void {
    const wasUnlocked = this.#keyMaterial !== undefined;
    this.#advanceEpoch();
    this.#clearUnlockedState();
    if (wasUnlocked) {
      try {
        this.#onLock?.(reason);
      } catch {
        // Host notification failures cannot prevent key erasure.
      }
    }
  }

  changePassphrase(newPassphrase: string): Promise<void> {
    return this.#runExclusive((epoch) => this.#changePassphrase(newPassphrase, epoch));
  }

  async #changePassphrase(newPassphrase: string, epoch: number): Promise<void> {
    const material = this.#requireMaterial();
    const header = this.#requireHeader();
    const raw = material.raw.slice();
    const updated = await rewrapRawVaultKey(this.#crypto, header, raw, newPassphrase, this.#now()).finally(() => raw.fill(0));
    this.#assertEpoch(epoch);
    await this.#storage.setHeader(updated);
    this.#header = updated;
    this.#touch();
  }

  createWorkspace(name: string, sensitivity: WorkspaceRecord["sensitivity"] = "internal"): Promise<WorkspaceRecord> {
    return this.#runExclusive((epoch) => this.#createWorkspace(name, sensitivity, epoch));
  }

  async #createWorkspace(name: string, sensitivity: WorkspaceRecord["sensitivity"], epoch: number): Promise<WorkspaceRecord> {
    this.#requireMaterial();
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 256) throw new Error("Workspace name is invalid.");
    const timestamp = this.#now().toISOString();
    const workspace: WorkspaceRecord = {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      kind: "workspace",
      id: randomId(this.#crypto),
      name: trimmed,
      sensitivity,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.#save([workspace], epoch);
    return workspace;
  }

  listWorkspaces(): WorkspaceRecord[] {
    this.#requireMaterial();
    this.#touch();
    return [...this.#records.values()].filter((record): record is WorkspaceRecord => isRecordKind(record, "workspace") && !record.deletedAt);
  }

  listDocuments(workspaceId: string): DocumentRecord[] {
    this.#requireMaterial();
    this.#touch();
    return [...this.#records.values()].filter(
      (record): record is DocumentRecord => isRecordKind(record, "document") && record.workspaceId === workspaceId && !record.deletedAt,
    );
  }

  getRevision(revisionId: string): DocumentRevisionRecord | undefined {
    this.#requireMaterial();
    this.#touch();
    const record = this.#records.get(revisionId);
    return record && isRecordKind(record, "revision") ? record : undefined;
  }

  listGrants(workspaceId: string, includeRevoked = false): SourceGrantRecord[] {
    this.#requireMaterial();
    this.#touch();
    return [...this.#records.values()].filter(
      (record): record is SourceGrantRecord =>
        isRecordKind(record, "grant") &&
        record.workspaceId === workspaceId &&
        (includeRevoked || record.revokedAt === undefined),
    );
  }

  listDerived(workspaceId: string): DerivedRecord[] {
    this.#requireMaterial();
    this.#touch();
    return [...this.#records.values()].filter(
      (record): record is DerivedRecord => isRecordKind(record, "derived") && record.workspaceId === workspaceId,
    );
  }

  listWorkflows(workspaceId: string): StoredWorkflowRecord[] {
    this.#requireMaterial();
    this.#touch();
    return [...this.#records.values()].filter(
      (record): record is StoredWorkflowRecord => isRecordKind(record, "workflow") && record.workspaceId === workspaceId,
    );
  }

  listReceipts(workspaceId: string): StoredReceiptRecord[] {
    this.#requireMaterial();
    this.#touch();
    return [...this.#records.values()].filter(
      (record): record is StoredReceiptRecord => isRecordKind(record, "receipt") && record.workspaceId === workspaceId,
    );
  }

  purgeExpired(): Promise<number> {
    return this.#runExclusive((epoch) => this.#purgeExpired(this.#now(), epoch));
  }

  async #purgeExpired(referenceTime: Date, epoch: number): Promise<number> {
    this.#requireMaterial();
    const cutoff = referenceTime.getTime();
    if (!Number.isFinite(cutoff)) throw new Error("Retention reference time is invalid.");
    let removed = 0;
    const expired = (value: string | undefined): boolean => value !== undefined && Date.parse(value) <= cutoff;

    const expiredWorkspaces = [...this.#records.values()]
      .filter((record): record is WorkspaceRecord => isRecordKind(record, "workspace") && expired(record.retentionUntil))
      .map((record) => record.id);
    for (const id of expiredWorkspaces) removed += await this.#deleteWorkspace(id, epoch);

    const expiredDocuments = [...this.#records.values()]
      .filter((record): record is DocumentRecord => isRecordKind(record, "document") && expired(record.retentionUntil))
      .map((record) => record.id);
    for (const id of expiredDocuments) removed += await this.#deleteSource(id, epoch);

    const expiredGrants = [...this.#records.values()]
      .filter((record): record is SourceGrantRecord => isRecordKind(record, "grant") && Date.parse(record.expiresAt) <= cutoff);
    for (const grant of expiredGrants) {
      const affectedSources = new Set(grant.sourceIds);
      const ids = [...this.#records.values()]
        .filter((record) => record.id === grant.id || (
          (isRecordKind(record, "derived") || record.kind === "workflow" || record.kind === "receipt") &&
          record.sourceIds.some((sourceId) => affectedSources.has(sourceId))
        ))
        .map((record) => record.id);
      await this.#deleteByIds(ids, epoch);
      removed += ids.length;
    }
    const expiredReceipts = [...this.#records.values()]
      .filter((record): record is StoredReceiptRecord => isRecordKind(record, "receipt") && expired(record.retentionUntil))
      .map((record) => record.id);
    await this.#deleteByIds(expiredReceipts, epoch);
    removed += expiredReceipts.length;
    return removed;
  }

  ingest(source: ImportSource, signal?: AbortSignal): Promise<IngestResult> {
    return this.#runExclusive((epoch) => this.#ingest(source, signal, epoch));
  }

  async #ingest(source: ImportSource, signal: AbortSignal | undefined, epoch: number): Promise<IngestResult> {
    this.#requireMaterial();
    this.#assertEpoch(epoch);
    this.#assertNotAborted(signal);
    const workspace = this.#records.get(source.workspaceId);
    if (!workspace || !isRecordKind(workspace, "workspace") || workspace.deletedAt) throw new Error("Workspace does not exist or is deleted.");
    const decoded = decodeAndValidateImport(source, this.#maxDocumentBytes);
    const fingerprint = await fingerprintImport(this.#crypto, source.mediaType, decoded.normalized);
    const existing = source.documentId ? this.#records.get(source.documentId) : undefined;
    const existingDocument = existing && isRecordKind(existing, "document") ? existing : undefined;
    if (existing && (!existingDocument || existingDocument.workspaceId !== source.workspaceId || existingDocument.deletedAt)) {
      throw new Error("The target document is unavailable in this workspace.");
    }
    const currentRevision = existingDocument ? this.#records.get(existingDocument.currentRevisionId) : undefined;
    if (
      existingDocument &&
      currentRevision &&
      isRecordKind(currentRevision, "revision") &&
      currentRevision.fingerprint === fingerprint
    ) {
      return {
        documentId: existingDocument.id,
        revisionId: currentRevision.id,
        chunkCount: currentRevision.chunkIds.length,
        byteLength: currentRevision.byteLength,
        fingerprint,
        deduplicated: true,
        warnings: decoded.warnings,
      };
    }
    const documentId = existingDocument?.id ?? source.documentId ?? randomId(this.#crypto);
    const revisionId = randomId(this.#crypto);
    const sensitivity = source.sensitivity ?? workspace.sensitivity;
    const chunks = createChunks({
      text: decoded.normalized,
      workspaceId: source.workspaceId,
      documentId,
      revisionId,
      sensitivity,
      makeId: () => randomId(this.#crypto),
      maxChunks: this.#maxChunks,
      ...(source.sourceOrigin === undefined ? {} : { sourceOrigin: source.sourceOrigin }),
      ...(source.retentionUntil === undefined ? {} : { retentionUntil: source.retentionUntil }),
    });
    const timestamp = this.#now().toISOString();
    const revision: DocumentRevisionRecord = {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      kind: "revision",
      id: revisionId,
      documentId,
      workspaceId: source.workspaceId,
      fingerprint,
      mediaType: source.mediaType,
      originalText: decoded.normalized,
      byteLength: decoded.byteLength,
      chunkIds: chunks.map((chunk) => chunk.id),
      createdAt: timestamp,
    };
    const sourceUrl = sanitizedSourceUrl(source.sourceUrl);
    const documentBase: DocumentRecord = {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      kind: "document",
      id: documentId,
      workspaceId: source.workspaceId,
      title: source.title.trim(),
      mediaType: source.mediaType,
      revisionIds: [...(existingDocument?.revisionIds ?? []), revisionId],
      currentRevisionId: revisionId,
      sensitivity,
      createdAt: existingDocument?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    const withOrigin = source.sourceOrigin === undefined ? documentBase : { ...documentBase, sourceOrigin: source.sourceOrigin };
    const withUrl = sourceUrl === undefined ? withOrigin : { ...withOrigin, sourceUrl };
    const document = source.retentionUntil === undefined ? withUrl : { ...withUrl, retentionUntil: source.retentionUntil };
    const embeddings = await this.#embedChunks(chunks, signal, epoch);
    // Existing documents predate this transaction and must never be rollback targets.
    // The document update and all new records are committed by the same storage transaction,
    // so the new record IDs are sufficient to determine whether the staged write completed.
    const stagedIds = [
      ...(existingDocument ? [] : [document.id]),
      revision.id,
      ...chunks.map((chunk) => chunk.id),
      ...embeddings.map((item) => item.id),
    ];
    const staging: StagingRecord = {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      kind: "staging",
      id: randomId(this.#crypto),
      operation: "ingest",
      recordIds: stagedIds,
      createdAt: timestamp,
    };
    await this.#save([staging], epoch);
    try {
      this.#assertEpoch(epoch);
      this.#assertNotAborted(signal);
      await this.#save([document, revision, ...chunks, ...embeddings], epoch);
      await this.#deleteByIds([staging.id], epoch);
    } catch (error) {
      const newRecordIds = [revision.id, ...chunks.map((chunk) => chunk.id), ...embeddings.map((item) => item.id), staging.id];
      if (!existingDocument) newRecordIds.push(document.id);
      if (this.#epoch === epoch) {
        await this.#deleteByIds(newRecordIds, epoch);
        if (existingDocument) await this.#save([existingDocument], epoch);
      }
      throw error;
    }
    return {
      documentId,
      revisionId,
      chunkCount: chunks.length,
      byteLength: decoded.byteLength,
      fingerprint,
      deduplicated: false,
      warnings: decoded.warnings,
    };
  }

  search(request: SearchRequest): Promise<SearchResult[]> {
    return this.#runExclusive((epoch) => this.#search(request, epoch));
  }

  async #search(request: SearchRequest, epoch: number): Promise<SearchResult[]> {
    this.#requireMaterial();
    await this.#purgeExpired(this.#now(), epoch);
    this.#touch();
    const documents = new Map(
      [...this.#records.values()]
        .filter((record): record is DocumentRecord => isRecordKind(record, "document"))
        .map((document) => [document.id, document]),
    );
    const embeddingProvider = request.embeddingProvider ?? this.#defaultEmbeddingProvider;
    const results = await retrieve(
      {
        chunks: [...this.#records.values()].filter((record): record is ChunkRecord => isRecordKind(record, "chunk")),
        embeddings: [...this.#records.values()].filter((record): record is EmbeddingRecord => isRecordKind(record, "embedding")),
        grants: [...this.#records.values()].filter((record): record is SourceGrantRecord => isRecordKind(record, "grant")),
        documents,
      },
      {
        workspaceId: request.workspaceId,
        query: request.query,
        limit: request.limit ?? 8,
        ...(request.authorization === undefined ? {} : { authorization: request.authorization }),
        ...(embeddingProvider === undefined ? {} : { embeddingProvider }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      },
    );
    this.#assertEpoch(epoch);
    return results;
  }

  saveGrant(grant: Omit<SourceGrantRecord, "schemaVersion" | "kind" | "id" | "issuedAt">): Promise<SourceGrantRecord> {
    return this.#runExclusive((epoch) => this.#saveGrant(grant, epoch));
  }

  async #saveGrant(grant: Omit<SourceGrantRecord, "schemaVersion" | "kind" | "id" | "issuedAt">, epoch: number): Promise<SourceGrantRecord> {
    const record: SourceGrantRecord = {
      ...grant,
      schemaVersion: MEMORY_SCHEMA_VERSION,
      kind: "grant",
      id: randomId(this.#crypto),
      issuedAt: this.#now().toISOString(),
    };
    await this.#save([record], epoch);
    return record;
  }

  revokeGrant(grantId: string): Promise<void> {
    return this.#runExclusive((epoch) => this.#revokeGrant(grantId, epoch));
  }

  async #revokeGrant(grantId: string, epoch: number): Promise<void> {
    this.#requireMaterial();
    const existing = this.#records.get(grantId);
    if (!existing || !isRecordKind(existing, "grant")) throw new Error("Grant does not exist.");
    await this.#save([{ ...existing, revokedAt: this.#now().toISOString() }], epoch);
    const affectedSources = new Set(existing.sourceIds);
    const dependentIds = [...this.#records.values()]
      .filter((record) => (
        (isRecordKind(record, "derived") || record.kind === "workflow" || record.kind === "receipt") &&
        record.sourceIds.some((sourceId) => affectedSources.has(sourceId))
      ))
      .map((record) => record.id);
    await this.#deleteByIds(dependentIds, epoch);
  }

  saveDerived(record: Omit<DerivedRecord, "schemaVersion" | "kind" | "id" | "createdAt">): Promise<DerivedRecord> {
    return this.#runExclusive((epoch) => this.#saveDerived(record, epoch));
  }

  saveWorkflow(record: Omit<StoredWorkflowRecord, "schemaVersion" | "kind" | "id" | "createdAt">): Promise<StoredWorkflowRecord> {
    return this.#runExclusive((epoch) => this.#saveWorkflow(record, epoch));
  }

  saveReceipt(record: Omit<StoredReceiptRecord, "schemaVersion" | "kind" | "id" | "createdAt">): Promise<StoredReceiptRecord> {
    return this.#runExclusive((epoch) => this.#saveReceipt(record, epoch));
  }

  async #saveWorkflow(
    record: Omit<StoredWorkflowRecord, "schemaVersion" | "kind" | "id" | "createdAt">,
    epoch: number,
  ): Promise<StoredWorkflowRecord> {
    const value: StoredWorkflowRecord = {
      ...record,
      schemaVersion: MEMORY_SCHEMA_VERSION,
      kind: "workflow",
      id: randomId(this.#crypto),
      createdAt: this.#now().toISOString(),
    };
    await this.#save([value], epoch);
    return value;
  }

  async #saveReceipt(
    record: Omit<StoredReceiptRecord, "schemaVersion" | "kind" | "id" | "createdAt">,
    epoch: number,
  ): Promise<StoredReceiptRecord> {
    const createdAt = this.#now();
    const value: StoredReceiptRecord = {
      ...record,
      schemaVersion: MEMORY_SCHEMA_VERSION,
      kind: "receipt",
      id: randomId(this.#crypto),
      createdAt: createdAt.toISOString(),
      retentionUntil: record.retentionUntil ?? new Date(createdAt.getTime() + 7 * 86_400_000).toISOString(),
    };
    await this.#save([value], epoch);
    return value;
  }

  async #saveDerived(record: Omit<DerivedRecord, "schemaVersion" | "kind" | "id" | "createdAt">, epoch: number): Promise<DerivedRecord> {
    const value: DerivedRecord = {
      ...record,
      schemaVersion: MEMORY_SCHEMA_VERSION,
      kind: "derived",
      id: randomId(this.#crypto),
      createdAt: this.#now().toISOString(),
    };
    await this.#save([value], epoch);
    return value;
  }

  deleteSource(documentId: string): Promise<number> {
    return this.#runExclusive((epoch) => this.#deleteSource(documentId, epoch));
  }

  async #deleteSource(documentId: string, epoch: number): Promise<number> {
    this.#requireMaterial();
    const document = this.#records.get(documentId);
    if (!document || !isRecordKind(document, "document")) return 0;
    const revisionIds = new Set(document.revisionIds);
    const chunkIds = new Set(
      [...this.#records.values()]
        .filter((record): record is ChunkRecord => isRecordKind(record, "chunk") && record.documentId === documentId)
        .map((record) => record.id),
    );
    const ids = [...this.#records.values()]
      .filter((record) => {
        if (record.id === documentId || revisionIds.has(record.id) || chunkIds.has(record.id)) return true;
        if (isRecordKind(record, "embedding")) return record.documentId === documentId || chunkIds.has(record.chunkId);
        if (isRecordKind(record, "derived") || record.kind === "workflow" || record.kind === "receipt") {
          return record.sourceIds.includes(documentId);
        }
        if (isRecordKind(record, "grant")) return record.sourceIds.includes(documentId);
        return false;
      })
      .map((record) => record.id);
    await this.#deleteByIds(ids, epoch);
    return ids.length;
  }

  deleteWorkspace(workspaceId: string): Promise<number> {
    return this.#runExclusive((epoch) => this.#deleteWorkspace(workspaceId, epoch));
  }

  async #deleteWorkspace(workspaceId: string, epoch: number): Promise<number> {
    this.#requireMaterial();
    const ids = [...this.#records.values()]
      .filter((record) => record.id === workspaceId || ("workspaceId" in record && record.workspaceId === workspaceId))
      .map((record) => record.id);
    await this.#deleteByIds(ids, epoch);
    return ids.length;
  }

  exportEncrypted(): Promise<EncryptedVaultExport> {
    return this.#runExclusive((epoch) => this.#exportEncrypted(epoch));
  }

  async #exportEncrypted(epoch: number): Promise<EncryptedVaultExport> {
    this.#requireMaterial();
    await this.#purgeExpired(this.#now(), epoch);
    this.#touch();
    const header = structuredClone(this.#requireHeader());
    const records = (await this.#storage.listRecords()).map((record) => validateEncryptedRecord(record));
    this.#assertEpoch(epoch);
    return {
      format: "browser-cortex-encrypted-vault",
      schemaVersion: MEMORY_SCHEMA_VERSION,
      exportedAt: this.#now().toISOString(),
      header,
      records,
    };
  }

  importEncrypted(input: unknown, passphrase: string): Promise<void> {
    return this.#runExclusive((epoch) => this.#importEncrypted(input, passphrase, epoch));
  }

  async #importEncrypted(input: unknown, passphrase: string, epoch: number): Promise<void> {
    const archive = validateVaultExportForImport(input);
    const material = await unwrapVaultKeyMaterial(this.#crypto, archive.header, passphrase);
    let replacementHeader: VaultHeader;
    let replacementRecords: EncryptedRecord[];
    let decrypted: PrivateMemoryRecord[];
    try {
      if (archive.schemaVersion === LEGACY_MEMORY_SCHEMA_VERSION) {
        const prepared = await prepareVaultMigration({
          cryptoProvider: this.#crypto,
          key: material.key,
          header: archive.header,
          records: archive.records,
          now: this.#now(),
        });
        replacementHeader = prepared.targetHeader;
        replacementRecords = [...prepared.targetRecords];
        decrypted = await verifyCommittedMigration({
          cryptoProvider: this.#crypto,
          key: material.key,
          state: prepared.state,
          header: replacementHeader,
          records: replacementRecords,
        });
      } else {
        replacementHeader = archive.header;
        replacementRecords = archive.records;
        decrypted = [];
        // Decrypt sequentially so an accepted archive cannot multiply its bounded size
        // into one promise and plaintext allocation per record at the same time.
        for (const record of archive.records) decrypted.push(await decryptRecord(this.#crypto, material.key, record));
      }
    } catch (error) {
      material.raw.fill(0);
      throw error;
    }
    let replaced = false;
    try {
      this.#assertEpoch(epoch);
      await this.#storage.replaceAll(replacementHeader, replacementRecords);
      replaced = true;
      this.#assertEpoch(epoch);
      this.#clearUnlockedState();
      this.#header = replacementHeader;
      this.#keyMaterial = material;
      this.#records.clear();
      for (const record of decrypted) this.#records.set(record.id, record);
      await this.#recoverStaging(epoch);
      this.#lastUnlockedAt = this.#now().toISOString();
      this.#advanceEpoch();
      this.#touch();
    } catch (error) {
      if (replaced) this.#header = replacementHeader;
      if (this.#keyMaterial === material) this.#clearUnlockedState();
      material.raw.fill(0);
      throw error;
    }
  }

  deleteVault(): Promise<void> {
    return this.#runExclusive((epoch) => this.#deleteVault(epoch));
  }

  async #deleteVault(epoch: number): Promise<void> {
    this.#assertEpoch(epoch);
    this.lock("delete");
    await this.#storage.clear();
    this.#header = undefined;
    this.#lastUnlockedAt = undefined;
  }

  dispose(): Promise<void> {
    return this.#runExclusive((epoch) => this.#dispose(epoch));
  }

  async #dispose(epoch: number): Promise<void> {
    this.#assertEpoch(epoch);
    this.lock("dispose");
    await this.#storage.close();
  }

  async #embedChunks(chunks: readonly ChunkRecord[], signal: AbortSignal | undefined, epoch: number): Promise<EmbeddingRecord[]> {
    const provider = this.#defaultEmbeddingProvider;
    if (!provider || chunks.length === 0) return [];
    const records: EmbeddingRecord[] = [];
    for (let offset = 0; offset < chunks.length; offset += EMBEDDING_BATCH_SIZE) {
      this.#assertNotAborted(signal);
      const batch = chunks.slice(offset, offset + EMBEDDING_BATCH_SIZE);
      const vectors = await provider.embed(batch.map((chunk) => chunk.text), signal);
      this.#assertEpoch(epoch);
      if (vectors.length !== batch.length) throw new Error("Embedding provider returned an unexpected vector count.");
      for (let index = 0; index < batch.length; index += 1) {
        const chunk = batch[index];
        const vector = vectors[index];
        if (!chunk || !vector || vector.length === 0 || !vector.every(Number.isFinite)) {
          throw new Error("Embedding provider returned an invalid vector.");
        }
        records.push({
          schemaVersion: MEMORY_SCHEMA_VERSION,
          kind: "embedding",
          id: randomId(this.#crypto),
          chunkId: chunk.id,
          documentId: chunk.documentId,
          revisionId: chunk.revisionId,
          workspaceId: chunk.workspaceId,
          modelId: provider.modelId,
          modelRevision: provider.modelRevision,
          dimensions: vector.length,
          vector: [...vector],
          createdAt: this.#now().toISOString(),
        });
      }
    }
    return records;
  }

  async #save(records: readonly PrivateMemoryRecord[], epoch: number): Promise<void> {
    this.#assertEpoch(epoch);
    const material = this.#requireMaterial();
    const encrypted = await Promise.all(records.map((record) => encryptRecord(this.#crypto, material.key, record)));
    this.#assertEpoch(epoch);
    await this.#storage.putRecords(encrypted);
    this.#assertEpoch(epoch);
    for (const record of records) this.#records.set(record.id, record);
    this.#touch();
  }

  async #deleteByIds(ids: readonly string[], epoch: number): Promise<void> {
    this.#assertEpoch(epoch);
    await this.#storage.deleteRecords(ids);
    this.#assertEpoch(epoch);
    for (const id of ids) this.#records.delete(id);
    this.#touch();
  }

  async #recoverStaging(epoch: number): Promise<void> {
    const stages = [...this.#records.values()].filter((record): record is StagingRecord => isRecordKind(record, "staging"));
    for (const stage of stages) {
      const complete = stage.recordIds.every((id) => this.#records.has(id));
      await this.#deleteByIds(complete ? [stage.id] : [...stage.recordIds, stage.id], epoch);
    }
  }

  #requireHeader(): VaultHeader {
    if (!this.#header) throw new Error("Vault is not initialized.");
    if (this.#header.schemaVersion !== MEMORY_SCHEMA_VERSION) {
      throw new Error("Vault migration must complete before the unlocked vault can be modified.");
    }
    return this.#header;
  }

  #requireMaterial(): VaultKeyMaterial {
    if (!this.#keyMaterial) throw new Error("Vault is locked.");
    return this.#keyMaterial;
  }

  #assertNotAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Operation cancelled.", "AbortError");
  }

  #assertEpoch(expected: number): void {
    if (expected !== this.#epoch) {
      throw new DOMException("Vault state changed while the operation was pending.", "AbortError");
    }
  }

  #advanceEpoch(): void {
    this.#epoch += 1;
  }

  #clearUnlockedState(): void {
    if (this.#autoLockTimer) clearTimeout(this.#autoLockTimer);
    this.#autoLockTimer = undefined;
    this.#keyMaterial?.raw.fill(0);
    this.#keyMaterial = undefined;
    this.#records.clear();
  }

  #runExclusive<T>(operation: (epoch: number) => Promise<T>): Promise<T> {
    const requestedEpoch = this.#epoch;
    const running = this.#operationTail.then(() => {
      this.#assertEpoch(requestedEpoch);
      return operation(requestedEpoch);
    });
    this.#operationTail = running.then(
      () => undefined,
      () => undefined,
    );
    return running;
  }

  #touch(): void {
    if (!this.#keyMaterial || this.#autoLockMs === 0) return;
    if (this.#autoLockTimer) clearTimeout(this.#autoLockTimer);
    this.#autoLockTimer = setTimeout(() => this.lock("auto"), this.#autoLockMs);
  }
}

export function createEncryptedMemory(options: EncryptedMemoryOptions): EncryptedMemoryVault {
  return new EncryptedMemoryVault(options);
}
