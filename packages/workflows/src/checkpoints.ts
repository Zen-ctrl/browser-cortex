import type { CheckpointStore, RunCheckpoint } from "./types.js";

/** Test and temporary-session store. Persistent hosts should encrypt checkpoints in the vault. */
export class MemoryCheckpointStore implements CheckpointStore {
  readonly #checkpoints = new Map<string, RunCheckpoint>();

  async load(runId: string): Promise<RunCheckpoint | undefined> {
    const value = this.#checkpoints.get(runId);
    return value ? structuredClone(value) : undefined;
  }

  async save(checkpoint: RunCheckpoint): Promise<void> {
    this.#checkpoints.set(checkpoint.runId, structuredClone(checkpoint));
  }

  async delete(runId: string): Promise<void> {
    this.#checkpoints.delete(runId);
  }
}
