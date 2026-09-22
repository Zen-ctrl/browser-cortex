import { canonicalize, fingerprint } from "./canonical.js";
import type { ApprovalBinding, ApprovalHandle } from "./types.js";

export interface ApprovalBrokerOptions {
  review(binding: ApprovalBinding, opaqueHandleId: string): Promise<boolean> | boolean;
  now?: () => Date;
  crypto?: Crypto;
  maximumLifetimeMs?: number;
}

function randomHandle(cryptoProvider: Crypto): string {
  if (typeof cryptoProvider.randomUUID === "function") return cryptoProvider.randomUUID();
  const bytes = cryptoProvider.getRandomValues(new Uint8Array(24));
  return [...bytes].map((item) => item.toString(16).padStart(2, "0")).join("");
}

export class ApprovalBroker {
  readonly #review: ApprovalBrokerOptions["review"];
  readonly #now: () => Date;
  readonly #crypto: Crypto;
  readonly #maximumLifetimeMs: number;
  readonly #handles = new Map<string, ApprovalHandle>();

  constructor(options: ApprovalBrokerOptions) {
    this.#review = options.review;
    this.#now = options.now ?? (() => new Date());
    this.#crypto = options.crypto ?? globalThis.crypto;
    this.#maximumLifetimeMs = options.maximumLifetimeMs ?? 5 * 60 * 1_000;
    if (!this.#crypto?.subtle) throw new Error("Web Crypto is required for approval binding.");
  }

  async request(binding: Omit<ApprovalBinding, "expiresAt">, lifetimeMs = this.#maximumLifetimeMs): Promise<ApprovalHandle> {
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > this.#maximumLifetimeMs) throw new Error("Approval lifetime is invalid.");
    const complete: ApprovalBinding = { ...binding, expiresAt: new Date(this.#now().getTime() + lifetimeMs).toISOString() };
    const id = randomHandle(this.#crypto);
    const handle: ApprovalHandle = { id, binding: complete, approved: false, consumed: false };
    this.#handles.set(id, handle);
    const approved = await this.#review(structuredClone(complete), id);
    const current = this.#handles.get(id);
    if (!current) throw new Error("Approval expired during review.");
    current.approved = approved === true;
    return structuredClone(current);
  }

  async consume(id: string, expected: Omit<ApprovalBinding, "expiresAt">): Promise<void> {
    const handle = this.#handles.get(id);
    if (!handle || !handle.approved || handle.consumed) throw new Error("Approval is missing, denied, or already consumed.");
    if (Date.parse(handle.binding.expiresAt) <= this.#now().getTime()) {
      this.#handles.delete(id);
      throw new Error("Approval expired.");
    }
    const { expiresAt: _expiresAt, ...actualBinding } = handle.binding;
    const [actualFingerprint, expectedFingerprint] = await Promise.all([
      fingerprint(actualBinding, this.#crypto),
      fingerprint(expected, this.#crypto),
    ]);
    if (actualFingerprint !== expectedFingerprint) throw new Error("Approval does not match current arguments.");
    handle.consumed = true;
    this.#handles.delete(id);
  }

  revoke(id: string): void {
    this.#handles.delete(id);
  }

  clear(): void {
    this.#handles.clear();
  }

  describe(id: string): string | undefined {
    const handle = this.#handles.get(id);
    return handle ? canonicalize(handle.binding) : undefined;
  }
}
