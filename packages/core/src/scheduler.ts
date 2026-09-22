import { LIMITS, createSafeError, toSafeError, utf8ByteLength } from '@browser-cortex/contracts';

export type ScheduledTaskKind = 'generation' | 'embedding';

export interface ScheduledTask<T> {
  readonly requestId: string;
  readonly kind: ScheduledTaskKind;
  readonly serializedInput: string;
  readonly signal?: AbortSignal;
  readonly run: (signal: AbortSignal) => Promise<T>;
}

interface QueueEntry<T> {
  readonly task: ScheduledTask<T>;
  readonly controller: AbortController;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
  readonly removeAbortListener: () => void;
}

export interface SchedulerSnapshot {
  readonly activeRequestId?: string;
  readonly queuedRequestIds: readonly string[];
  readonly disposed: boolean;
}

/**
 * A host-side scheduler for a single local inference worker. Generation is
 * interactive and is ordered ahead of queued embedding work. It never retries
 * failed jobs and never changes a local request into an online request.
 */
export class BoundedRuntimeScheduler {
  readonly #queue: QueueEntry<unknown>[] = [];
  readonly #requestIds = new Set<string>();
  readonly #maximumQueued: number;
  #active: QueueEntry<unknown> | undefined;
  #disposed = false;

  public constructor(options: { readonly maximumQueued?: number } = {}) {
    const maximumQueued = options.maximumQueued ?? 32;
    if (!Number.isSafeInteger(maximumQueued) || maximumQueued < 1 || maximumQueued > 256) {
      throw createSafeError('INVALID_INPUT');
    }
    this.#maximumQueued = maximumQueued;
  }

  public schedule<T>(task: ScheduledTask<T>): Promise<T> {
    if (this.#disposed) return Promise.reject(createSafeError('DISPOSED'));
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(task.requestId)) {
      return Promise.reject(createSafeError('INVALID_INPUT'));
    }
    if (utf8ByteLength(task.serializedInput) > LIMITS.extensionMessageBytes) {
      return Promise.reject(createSafeError('PAYLOAD_TOO_LARGE'));
    }
    if (this.#requestIds.has(task.requestId)) {
      return Promise.reject(createSafeError('DUPLICATE_REQUEST'));
    }
    if (this.#queue.length >= this.#maximumQueued) {
      return Promise.reject(createSafeError('OUT_OF_MEMORY'));
    }
    if (task.signal?.aborted) return Promise.reject(createSafeError('CANCELLED'));

    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      const abort = (): void => void this.cancel(task.requestId);
      task.signal?.addEventListener('abort', abort, { once: true });
      const entry: QueueEntry<T> = {
        task,
        controller,
        resolve,
        reject,
        removeAbortListener: () => task.signal?.removeEventListener('abort', abort),
      };
      this.#requestIds.add(task.requestId);
      const generationIndex = task.kind === 'generation'
        ? this.#queue.findIndex((queued) => queued.task.kind === 'embedding')
        : -1;
      if (generationIndex >= 0) this.#queue.splice(generationIndex, 0, entry as QueueEntry<unknown>);
      else this.#queue.push(entry as QueueEntry<unknown>);
      void this.#drain();
    });
  }

  public cancel(requestId: string): boolean {
    if (this.#active?.task.requestId === requestId) {
      this.#active.controller.abort('cancelled');
      return true;
    }
    const index = this.#queue.findIndex((entry) => entry.task.requestId === requestId);
    if (index < 0) return false;
    const [entry] = this.#queue.splice(index, 1);
    if (entry === undefined) return false;
    entry.controller.abort('cancelled');
    entry.removeAbortListener();
    this.#requestIds.delete(requestId);
    entry.reject(createSafeError('CANCELLED'));
    return true;
  }

  public snapshot(): SchedulerSnapshot {
    const activeRequestId = this.#active?.task.requestId;
    return Object.freeze({
      ...(activeRequestId === undefined ? {} : { activeRequestId }),
      queuedRequestIds: Object.freeze(this.#queue.map((entry) => entry.task.requestId)),
      disposed: this.#disposed,
    });
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#active?.controller.abort('disposed');
    for (const entry of this.#queue.splice(0)) {
      entry.controller.abort('disposed');
      entry.removeAbortListener();
      this.#requestIds.delete(entry.task.requestId);
      entry.reject(createSafeError('DISPOSED'));
    }
  }

  async #drain(): Promise<void> {
    if (this.#active !== undefined || this.#disposed) return;
    const entry = this.#queue.shift();
    if (entry === undefined) return;
    this.#active = entry;
    try {
      if (entry.controller.signal.aborted) throw createSafeError('CANCELLED');
      const value = await entry.task.run(entry.controller.signal);
      if (entry.controller.signal.aborted) throw createSafeError('CANCELLED');
      entry.resolve(value);
    } catch (error) {
      entry.reject(
        entry.controller.signal.aborted
          ? createSafeError(this.#disposed ? 'DISPOSED' : 'CANCELLED', { cause: error })
          : toSafeError(error, 'INVALID_MODEL_OUTPUT'),
      );
    } finally {
      entry.removeAbortListener();
      this.#requestIds.delete(entry.task.requestId);
      this.#active = undefined;
      void this.#drain();
    }
  }
}
