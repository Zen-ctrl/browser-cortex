import { createSafeError, type ErrorCode } from '@browser-cortex/contracts';

export type LocalCapabilityMode = 'full' | 'reduced' | 'failed' | 'disposed';

export interface RecoverySnapshot {
  readonly mode: LocalCapabilityMode;
  readonly generationAvailable: boolean;
  readonly deterministicToolsAvailable: boolean;
  readonly reason?: ErrorCode;
  readonly workerGeneration: number;
}

const REDUCED_MODE_ERRORS = new Set<ErrorCode>([
  'GPU_UNAVAILABLE',
  'MODEL_NOT_INSTALLED',
  'MODEL_INCOMPATIBLE',
  'MODEL_INTEGRITY_FAILED',
  'OUT_OF_MEMORY',
  'STORAGE_FULL',
]);

/** Tracks local runtime recovery without ever selecting an online fallback. */
export class LocalRecoveryController {
  #mode: LocalCapabilityMode = 'reduced';
  #reason: ErrorCode | undefined = 'MODEL_NOT_INSTALLED';
  #workerGeneration = 0;

  public ready(): RecoverySnapshot {
    if (this.#mode === 'disposed') throw createSafeError('DISPOSED');
    this.#mode = 'full';
    this.#reason = undefined;
    return this.snapshot();
  }

  public failed(code: ErrorCode): RecoverySnapshot {
    if (this.#mode === 'disposed') throw createSafeError('DISPOSED');
    this.#mode = REDUCED_MODE_ERRORS.has(code) ? 'reduced' : 'failed';
    this.#reason = code;
    this.#workerGeneration += 1;
    return this.snapshot();
  }

  public dispose(): RecoverySnapshot {
    this.#mode = 'disposed';
    this.#reason = 'DISPOSED';
    return this.snapshot();
  }

  public snapshot(): RecoverySnapshot {
    const reason = this.#mode === 'full' ? undefined : this.#reason;
    return Object.freeze({
      mode: this.#mode,
      generationAvailable: this.#mode === 'full',
      deterministicToolsAvailable: this.#mode !== 'disposed',
      ...(reason === undefined ? {} : { reason }),
      workerGeneration: this.#workerGeneration,
    });
  }
}
