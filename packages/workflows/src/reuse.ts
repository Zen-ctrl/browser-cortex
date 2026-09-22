import { fingerprint } from "./canonical.js";
import type { ReuseDependencies, WorkflowDefinition } from "./types.js";
import { validateWorkflow } from "./validation.js";

interface CachedWorkflow {
  workflow: WorkflowDefinition;
  dependencyFingerprint: string;
  storedAt: string;
}

export class WorkflowReuseCache {
  readonly #entries = new Map<string, CachedWorkflow>();
  readonly #crypto: Crypto;
  readonly #now: () => Date;

  constructor(options: { crypto?: Crypto; now?: () => Date } = {}) {
    this.#crypto = options.crypto ?? globalThis.crypto;
    this.#now = options.now ?? (() => new Date());
  }

  async put(workflowInput: unknown, dependencies: ReuseDependencies): Promise<void> {
    const workflow = validateWorkflow(workflowInput).workflow;
    const dependencyFingerprint = await fingerprint(dependencies, this.#crypto);
    this.#entries.set(`${workflow.id}@${workflow.version}`, {
      workflow: structuredClone(workflow),
      dependencyFingerprint,
      storedAt: this.#now().toISOString(),
    });
  }

  async getExact(workflowId: string, version: string, dependencies: ReuseDependencies): Promise<WorkflowDefinition | undefined> {
    const entry = this.#entries.get(`${workflowId}@${version}`);
    if (!entry) return undefined;
    const currentFingerprint = await fingerprint(dependencies, this.#crypto);
    if (currentFingerprint !== entry.dependencyFingerprint) return undefined;
    return structuredClone(entry.workflow);
  }

  suggestByInputFields(fields: readonly string[]): { id: string; version: string; name: string; storedAt: string }[] {
    const expected = [...fields].sort().join("\u0000");
    return [...this.#entries.values()]
      .filter((entry) => Object.keys(entry.workflow.inputSchema).sort().join("\u0000") === expected)
      .map((entry) => ({ id: entry.workflow.id, version: entry.workflow.version, name: entry.workflow.name, storedAt: entry.storedAt }));
  }

  invalidate(workflowId: string): void {
    for (const key of this.#entries.keys()) if (key.startsWith(`${workflowId}@`)) this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }
}
