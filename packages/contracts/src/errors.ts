export const ERROR_CODES = [
  'GPU_UNAVAILABLE',
  'MODEL_NOT_INSTALLED',
  'MODEL_INTEGRITY_FAILED',
  'MODEL_INCOMPATIBLE',
  'OUT_OF_MEMORY',
  'STORAGE_FULL',
  'VAULT_LOCKED',
  'PERMISSION_DENIED',
  'SOURCE_REVOKED',
  'SENSITIVE_DATA_BLOCKED',
  'STALE_DOCUMENT',
  'INVALID_MODEL_OUTPUT',
  'UNSUPPORTED_TASK',
  'ONLINE_DISABLED',
  'DISCLOSURE_REQUIRED',
  'APPROVAL_EXPIRED',
  'APPROVAL_INVALID',
  'POSTCONDITION_FAILED',
  'OUTCOME_UNKNOWN',
  'CANCELLED',
  'INVALID_INPUT',
  'INVALID_SCHEMA_VERSION',
  'PAYLOAD_TOO_LARGE',
  'RESPONSE_REJECTED',
  'TRANSPORT_FAILED',
  'TIMEOUT',
  'ALREADY_INITIALIZED',
  'NOT_INITIALIZED',
  'DISPOSED',
  'DUPLICATE_REQUEST',
  'SESSION_EXPIRED',
  'SESSION_REVOKED',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface SafeErrorShape {
  readonly schemaVersion: 1;
  readonly code: ErrorCode;
  readonly message: string;
  readonly recoverable: boolean;
  readonly retryHint?: string;
}

export class CortexError extends Error {
  public readonly schemaVersion = 1 as const;
  public readonly code: ErrorCode;
  public readonly recoverable: boolean;
  public readonly retryHint?: string;

  public constructor(
    code: ErrorCode,
    message: string,
    options: { readonly recoverable?: boolean; readonly retryHint?: string; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CortexError';
    this.code = code;
    this.recoverable = options.recoverable ?? false;
    if (options.retryHint !== undefined) {
      this.retryHint = options.retryHint;
    }
  }

  public toJSON(): SafeErrorShape {
    return {
      schemaVersion: 1,
      code: this.code,
      message: this.message,
      recoverable: this.recoverable,
      ...(this.retryHint === undefined ? {} : { retryHint: this.retryHint }),
    };
  }
}

const DEFAULT_MESSAGES: Readonly<Record<ErrorCode, string>> = Object.freeze({
  GPU_UNAVAILABLE: 'Local acceleration is unavailable on this device.',
  MODEL_NOT_INSTALLED: 'The required local model is not installed.',
  MODEL_INTEGRITY_FAILED: 'The local model files did not pass integrity verification.',
  MODEL_INCOMPATIBLE: 'The installed model is not compatible with this runtime.',
  OUT_OF_MEMORY: 'The task could not continue within available memory.',
  STORAGE_FULL: 'There is not enough local storage to complete this operation.',
  VAULT_LOCKED: 'Unlock the local vault before accessing private data.',
  PERMISSION_DENIED: 'The requested operation is not permitted.',
  SOURCE_REVOKED: 'A required source is no longer available to this request.',
  SENSITIVE_DATA_BLOCKED: 'Sensitive-data review could not safely complete.',
  STALE_DOCUMENT: 'The page or document changed before the request completed.',
  INVALID_MODEL_OUTPUT: 'The local model returned an invalid result.',
  UNSUPPORTED_TASK: 'This task is outside the currently supported scope.',
  ONLINE_DISABLED: 'Online processing is disabled.',
  DISCLOSURE_REQUIRED: 'Review and approve the outgoing information before it is sent.',
  APPROVAL_EXPIRED: 'The approval expired before it could be used.',
  APPROVAL_INVALID: 'The approval does not match the current request.',
  POSTCONDITION_FAILED: 'The requested operation did not meet its required final checks.',
  OUTCOME_UNKNOWN: 'The operation may have happened, but its final result could not be confirmed.',
  CANCELLED: 'The operation was cancelled.',
  INVALID_INPUT: 'The request is invalid.',
  INVALID_SCHEMA_VERSION: 'The data uses an unsupported schema version.',
  PAYLOAD_TOO_LARGE: 'The request exceeds a configured size limit.',
  RESPONSE_REJECTED: 'The remote response was rejected by local validation.',
  TRANSPORT_FAILED: 'The approved online request could not be completed.',
  TIMEOUT: 'The operation exceeded its time limit.',
  ALREADY_INITIALIZED: 'The instance is already initialized.',
  NOT_INITIALIZED: 'Initialize the instance before using it.',
  DISPOSED: 'The instance has already been disposed.',
  DUPLICATE_REQUEST: 'The request identifier has already been used.',
  SESSION_EXPIRED: 'The trusted session has expired.',
  SESSION_REVOKED: 'The trusted session is no longer valid.',
});

export function createSafeError(
  code: ErrorCode,
  options: { readonly recoverable?: boolean; readonly retryHint?: string; readonly cause?: unknown } = {},
): CortexError {
  return new CortexError(code, DEFAULT_MESSAGES[code], options);
}

export function toSafeError(error: unknown, fallback: ErrorCode = 'INVALID_INPUT'): CortexError {
  if (error instanceof CortexError) {
    return createSafeError(error.code, { recoverable: error.recoverable, cause: error });
  }
  return createSafeError(fallback, { cause: error });
}
