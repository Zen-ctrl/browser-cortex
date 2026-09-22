import { describe, expect, it, vi } from "vitest";
import { createEncryptedMemory, InMemoryMemoryStorage } from "../src/index.js";
import type { EncryptedRecord, MemoryStorageAdapter, VaultHeader } from "../src/index.js";

class InterruptedRevisionStorage implements MemoryStorageAdapter {
  readonly #inner = new InMemoryMemoryStorage();
  #interruptCommit = false;
  #stagingWritten = false;
  #cleanupInterrupted = false;

  interruptNextRevision(): void {
    this.#interruptCommit = true;
  }

  getHeader(): Promise<VaultHeader | undefined> {
    return this.#inner.getHeader();
  }

  setHeader(header: VaultHeader): Promise<void> {
    return this.#inner.setHeader(header);
  }

  listRecords(): Promise<EncryptedRecord[]> {
    return this.#inner.listRecords();
  }

  getRecord(id: string): Promise<EncryptedRecord | undefined> {
    return this.#inner.getRecord(id);
  }

  async putRecords(records: readonly EncryptedRecord[]): Promise<void> {
    if (this.#interruptCommit && records.some((record) => record.kind === "staging")) {
      this.#stagingWritten = true;
      await this.#inner.putRecords(records);
      return;
    }
    if (this.#interruptCommit && this.#stagingWritten) {
      throw new Error("simulated process interruption");
    }
    await this.#inner.putRecords(records);
  }

  async deleteRecords(ids: readonly string[]): Promise<void> {
    if (this.#interruptCommit && this.#stagingWritten && !this.#cleanupInterrupted) {
      this.#cleanupInterrupted = true;
      this.#interruptCommit = false;
      throw new Error("simulated interruption before cleanup");
    }
    await this.#inner.deleteRecords(ids);
  }

  replaceAll(header: VaultHeader, records: readonly EncryptedRecord[]): Promise<void> {
    return this.#inner.replaceAll(header, records);
  }

  clear(): Promise<void> {
    return this.#inner.clear();
  }

  close(): Promise<void> {
    return this.#inner.close();
  }
}

class BlockingPutStorage implements MemoryStorageAdapter {
  readonly #inner = new InMemoryMemoryStorage();
  #blockedWrite?: { started: () => void; release: Promise<void> };
  replaceAllCalls = 0;

  blockNextPut(): { started: Promise<void>; release: () => void } {
    let markStarted = (): void => undefined;
    let release = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#blockedWrite = { started: markStarted, release: released };
    return { started, release };
  }

  getHeader(): Promise<VaultHeader | undefined> {
    return this.#inner.getHeader();
  }

  setHeader(header: VaultHeader): Promise<void> {
    return this.#inner.setHeader(header);
  }

  listRecords(): Promise<EncryptedRecord[]> {
    return this.#inner.listRecords();
  }

  getRecord(id: string): Promise<EncryptedRecord | undefined> {
    return this.#inner.getRecord(id);
  }

  async putRecords(records: readonly EncryptedRecord[]): Promise<void> {
    const blocked = this.#blockedWrite;
    if (blocked) {
      this.#blockedWrite = undefined;
      blocked.started();
      await blocked.release;
    }
    await this.#inner.putRecords(records);
  }

  deleteRecords(ids: readonly string[]): Promise<void> {
    return this.#inner.deleteRecords(ids);
  }

  async replaceAll(header: VaultHeader, records: readonly EncryptedRecord[]): Promise<void> {
    this.replaceAllCalls += 1;
    await this.#inner.replaceAll(header, records);
  }

  clear(): Promise<void> {
    return this.#inner.clear();
  }

  close(): Promise<void> {
    return this.#inner.close();
  }
}

class QuotaFailureStorage implements MemoryStorageAdapter {
  readonly #inner = new InMemoryMemoryStorage();
  #failNextPut = false;

  failNextPut(): void { this.#failNextPut = true; }
  getHeader(): Promise<VaultHeader | undefined> { return this.#inner.getHeader(); }
  setHeader(header: VaultHeader): Promise<void> { return this.#inner.setHeader(header); }
  listRecords(): Promise<EncryptedRecord[]> { return this.#inner.listRecords(); }
  getRecord(id: string): Promise<EncryptedRecord | undefined> { return this.#inner.getRecord(id); }
  async putRecords(records: readonly EncryptedRecord[]): Promise<void> {
    if (this.#failNextPut) {
      this.#failNextPut = false;
      throw new DOMException("synthetic quota exceeded", "QuotaExceededError");
    }
    await this.#inner.putRecords(records);
  }
  deleteRecords(ids: readonly string[]): Promise<void> { return this.#inner.deleteRecords(ids); }
  replaceAll(header: VaultHeader, records: readonly EncryptedRecord[]): Promise<void> { return this.#inner.replaceAll(header, records); }
  clear(): Promise<void> { return this.#inner.clear(); }
  close(): Promise<void> { return this.#inner.close(); }
}

describe("encrypted memory vertical slice", () => {
  it("enforces encrypted source retention and invalidates dependent authority", async () => {
    let now = new Date("2026-09-21T00:00:00.000Z");
    const vault = createEncryptedMemory({
      namespace: "retention-enforcement", storage: new InMemoryMemoryStorage(), autoLockMs: 0, now: () => now,
    });
    await vault.create("retention synthetic passphrase");
    const workspace = await vault.createWorkspace("Retention workspace");
    const source = await vault.ingest({
      workspaceId: workspace.id, title: "Expiring note", mediaType: "text/plain", content: "Synthetic expiring content.",
      retentionUntil: "2026-09-22T00:00:00.000Z",
    });
    await vault.saveWorkflow({ workspaceId: workspace.id, sourceIds: [source.documentId], value: { id: "dependent" } });
    now = new Date("2026-09-23T00:00:00.000Z");

    await expect(vault.purgeExpired()).resolves.toBeGreaterThan(0);
    expect(vault.listDocuments(workspace.id)).toEqual([]);
    expect(vault.listWorkflows(workspace.id)).toEqual([]);
  });

  it("purges encrypted detailed receipts after the seven-day default", async () => {
    let now = new Date("2026-09-21T00:00:00.000Z");
    const vault = createEncryptedMemory({
      namespace: "receipt-retention", storage: new InMemoryMemoryStorage(), autoLockMs: 0, now: () => now,
    });
    await vault.create("receipt retention synthetic passphrase");
    const workspace = await vault.createWorkspace("Receipt retention workspace");
    const receipt = await vault.saveReceipt({ workspaceId: workspace.id, sourceIds: [], value: { state: "succeeded" } });
    expect(receipt.retentionUntil).toBe("2026-09-28T00:00:00.000Z");
    now = new Date("2026-09-29T00:00:00.000Z");

    await vault.purgeExpired();
    expect(vault.listReceipts(workspace.id)).toEqual([]);
  });

  it("surfaces quota failures without reporting or retaining a partial write", async () => {
    const storage = new QuotaFailureStorage();
    const vault = createEncryptedMemory({ namespace: "quota-failure", storage, autoLockMs: 0 });
    await vault.create("quota failure synthetic passphrase");
    storage.failNextPut();

    await expect(vault.createWorkspace("Must not partially persist")).rejects.toMatchObject({ name: "QuotaExceededError" });
    expect(vault.listWorkspaces()).toEqual([]);
    expect(await storage.listRecords()).toEqual([]);

    await expect(vault.createWorkspace("Retry after explicit failure")).resolves.toMatchObject({ name: "Retry after explicit failure" });
    expect(vault.listWorkspaces()).toHaveLength(1);
  });

  it("encrypts, locks, transfers, searches, and invalidates a source", async () => {
    const storage = new InMemoryMemoryStorage();
    const vault = createEncryptedMemory({ namespace: "test-vault", storage, autoLockMs: 0 });
    await vault.create("correct horse battery staple");
    const workspace = await vault.createWorkspace("Synthetic workspace");
    const ingested = await vault.ingest({
      workspaceId: workspace.id,
      title: "Delivery note",
      mediaType: "text/plain",
      content: "The delivery date changed to October 8.",
    });
    expect((await vault.search({ workspaceId: workspace.id, query: "delivery October" }))[0]?.revisionId).toBe(ingested.revisionId);
    expect(JSON.stringify(await storage.listRecords())).not.toContain("delivery date");

    const archive = await vault.exportEncrypted();
    vault.lock();
    await expect(vault.search({ workspaceId: workspace.id, query: "delivery" })).rejects.toThrow("locked");

    const restored = createEncryptedMemory({ namespace: "restored-vault", storage: new InMemoryMemoryStorage(), autoLockMs: 0 });
    await restored.importEncrypted(archive, "correct horse battery staple");
    expect(await restored.search({ workspaceId: workspace.id, query: "October" })).toHaveLength(1);
    await restored.deleteSource(ingested.documentId);
    expect(await restored.search({ workspaceId: workspace.id, query: "October" })).toHaveLength(0);
  });

  it("preserves the previous document revision during interrupted-ingest recovery", async () => {
    const storage = new InterruptedRevisionStorage();
    const passphrase = "correct horse battery staple";
    const vault = createEncryptedMemory({ namespace: "interrupted-revision", storage, autoLockMs: 0 });
    await vault.create(passphrase);
    const workspace = await vault.createWorkspace("Synthetic workspace");
    const original = await vault.ingest({
      workspaceId: workspace.id,
      title: "Delivery note",
      mediaType: "text/plain",
      content: "The original delivery date is October 8.",
    });

    storage.interruptNextRevision();
    await expect(vault.ingest({
      workspaceId: workspace.id,
      documentId: original.documentId,
      title: "Delivery note",
      mediaType: "text/plain",
      content: "The replacement delivery date is October 10.",
    })).rejects.toThrow("cleanup");

    const restarted = createEncryptedMemory({ namespace: "interrupted-revision", storage, autoLockMs: 0 });
    await restarted.initialize();
    await restarted.unlock(passphrase);
    expect(restarted.listDocuments(workspace.id)[0]?.currentRevisionId).toBe(original.revisionId);
    expect(await restarted.search({ workspaceId: workspace.id, query: "original October" })).toHaveLength(1);
    expect(await restarted.search({ workspaceId: workspace.id, query: "replacement" })).toHaveLength(0);
  });

  it("rejects excessive KDF work and unrecognized cleartext archive fields", async () => {
    const source = createEncryptedMemory({ namespace: "source-bounds", storage: new InMemoryMemoryStorage(), autoLockMs: 0 });
    await source.create("correct horse battery staple");
    await source.createWorkspace("Archive boundary");
    const archive = await source.exportEncrypted();
    const originalIterations = archive.header.kdf.iterations;
    archive.header.kdf.iterations = 2_000_001;
    const target = createEncryptedMemory({ namespace: "target-bounds", storage: new InMemoryMemoryStorage(), autoLockMs: 0 });

    await expect(target.importEncrypted(archive, "correct horse battery staple")).rejects.toThrow("key-wrapping metadata");
    archive.header.kdf.iterations = originalIterations;
    const record = archive.records[0];
    if (!record) throw new Error("Expected the synthetic archive to contain one encrypted record.");
    Object.assign(record, { plaintext: "must never be persisted" });
    await expect(target.importEncrypted(archive, "correct horse battery staple")).rejects.toThrow("Invalid encrypted vault record");
  });

  it("serializes an import behind an in-flight write so vault keys cannot be mixed", async () => {
    const importedPassphrase = "imported synthetic passphrase";
    const source = createEncryptedMemory({ namespace: "serialized-source", storage: new InMemoryMemoryStorage(), autoLockMs: 0 });
    await source.create(importedPassphrase);
    await source.createWorkspace("Imported workspace");
    const archive = await source.exportEncrypted();

    const storage = new BlockingPutStorage();
    const target = createEncryptedMemory({ namespace: "serialized-target", storage, autoLockMs: 0 });
    await target.create("original synthetic passphrase");
    const replaceAllCallsBeforeImport = storage.replaceAllCalls;
    const blocked = storage.blockNextPut();
    const pendingWrite = target.createWorkspace("Original pending workspace");
    await blocked.started;

    const pendingImport = target.importEncrypted(archive, importedPassphrase);
    await Promise.resolve();
    await Promise.resolve();
    expect(storage.replaceAllCalls).toBe(replaceAllCallsBeforeImport);

    blocked.release();
    await pendingWrite;
    await pendingImport;
    expect(storage.replaceAllCalls).toBe(replaceAllCallsBeforeImport + 1);
    expect(target.listWorkspaces().map((workspace) => workspace.name)).toEqual(["Imported workspace"]);

    target.lock();
    await target.unlock(importedPassphrase);
    expect(target.listWorkspaces().map((workspace) => workspace.name)).toEqual(["Imported workspace"]);
  });

  it("invalidates an in-flight ingest when the vault locks", async () => {
    let markEmbeddingStarted = (): void => undefined;
    let releaseEmbedding = (): void => undefined;
    const embeddingStarted = new Promise<void>((resolve) => {
      markEmbeddingStarted = resolve;
    });
    const embeddingReleased = new Promise<void>((resolve) => {
      releaseEmbedding = resolve;
    });
    const passphrase = "epoch synthetic passphrase";
    const vault = createEncryptedMemory({
      namespace: "epoch-lock",
      storage: new InMemoryMemoryStorage(),
      autoLockMs: 0,
      embeddingProvider: {
        modelId: "synthetic/embedding",
        modelRevision: "1".repeat(40),
        async embed(texts) {
          markEmbeddingStarted();
          await embeddingReleased;
          return texts.map(() => [1, 0]);
        },
      },
    });
    await vault.create(passphrase);
    const workspace = await vault.createWorkspace("Epoch workspace");
    const pendingIngest = vault.ingest({
      workspaceId: workspace.id,
      title: "Pending document",
      mediaType: "text/plain",
      content: "This synthetic document must not commit after a lock transition.",
    });
    await embeddingStarted;

    vault.lock();
    releaseEmbedding();
    await expect(pendingIngest).rejects.toThrow("Vault state changed");
    await vault.unlock(passphrase);
    expect(vault.listDocuments(workspace.id)).toEqual([]);
  });

  it("lists encrypted grants, workflow plans, and receipts without exposing them while locked", async () => {
    const vault = createEncryptedMemory({ namespace: "workbench-artifacts", storage: new InMemoryMemoryStorage(), autoLockMs: 0 });
    await vault.create("artifact synthetic passphrase");
    const workspace = await vault.createWorkspace("Artifact workspace");
    const grant = await vault.saveGrant({
      workspaceId: workspace.id,
      sourceIds: ["synthetic-source"],
      recipient: "workbench",
      origin: "http://127.0.0.1:4173",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const workflow = await vault.saveWorkflow({
      workspaceId: workspace.id,
      sourceIds: [],
      value: { id: "synthetic-workflow", version: "1.0.0" },
    });
    const receipt = await vault.saveReceipt({
      workspaceId: workspace.id,
      sourceIds: [],
      value: { state: "succeeded", detail: "synthetic" },
    });

    expect(vault.listGrants(workspace.id)).toEqual([grant]);
    expect(vault.listWorkflows(workspace.id)).toEqual([workflow]);
    expect(vault.listReceipts(workspace.id)).toEqual([receipt]);
    vault.lock();
    expect(() => vault.listWorkflows(workspace.id)).toThrow("locked");
  });

  it("revokes source authority and removes encrypted derivatives that depended on it", async () => {
    const vault = createEncryptedMemory({ namespace: "grant-invalidation", storage: new InMemoryMemoryStorage(), autoLockMs: 0 });
    await vault.create("grant invalidation synthetic passphrase");
    const workspace = await vault.createWorkspace("Grant invalidation workspace");
    const sourceId = "synthetic-source";
    const grant = await vault.saveGrant({
      workspaceId: workspace.id,
      sourceIds: [sourceId],
      recipient: "workbench",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await vault.saveDerived({
      workspaceId: workspace.id,
      sourceIds: [sourceId],
      sourceRevisionIds: ["synthetic-revision"],
      value: { answer: "synthetic" },
    });
    await vault.saveWorkflow({ workspaceId: workspace.id, sourceIds: [sourceId], value: { id: "dependent-plan" } });
    await vault.saveReceipt({ workspaceId: workspace.id, sourceIds: [sourceId], value: { state: "succeeded" } });

    await vault.revokeGrant(grant.id);

    expect(vault.listGrants(workspace.id, true)[0]?.revokedAt).toBeDefined();
    expect(vault.listDerived(workspace.id)).toEqual([]);
    expect(vault.listWorkflows(workspace.id)).toEqual([]);
    expect(vault.listReceipts(workspace.id)).toEqual([]);
  });

  it("announces automatic locking only after key material is cleared", async () => {
    vi.useFakeTimers();
    try {
      const observations: string[] = [];
      let keyWasClearedBeforeNotification = false;
      let vault: ReturnType<typeof createEncryptedMemory>;
      vault = createEncryptedMemory({
        namespace: "auto-lock-notification",
        storage: new InMemoryMemoryStorage(),
        autoLockMs: 50,
        onLock(reason) {
          observations.push(reason);
          try { vault.listWorkspaces(); } catch { keyWasClearedBeforeNotification = true; }
        },
      });
      await vault.create("auto lock synthetic passphrase");
      await vi.advanceTimersByTimeAsync(51);
      expect(observations).toEqual(["auto"]);
      expect(keyWasClearedBeforeNotification).toBe(true);
      expect((await vault.status()).state).toBe("locked");
    } finally {
      vi.useRealTimers();
    }
  });
});
