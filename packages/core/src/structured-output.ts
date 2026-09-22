import {
  LIMITS,
  assertJsonValue,
  createSafeError,
  type JsonValue,
} from '@browser-cortex/contracts';

export interface StructuredOutputResult<T> {
  readonly value: T;
  readonly repaired: boolean;
}

export interface StructuredOutputOptions<T> {
  readonly validate: (value: JsonValue) => T;
  readonly repair?: (invalidText: string, signal: AbortSignal) => Promise<string>;
  readonly signal?: AbortSignal;
  readonly maxBytes?: number;
}

function parseAndValidate<T>(text: string, options: StructuredOutputOptions<T>): T {
  const maximum = Math.min(options.maxBytes ?? LIMITS.generatedOutputBytes, LIMITS.generatedOutputBytes);
  if (new TextEncoder().encode(text).byteLength > maximum) throw createSafeError('PAYLOAD_TOO_LARGE');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
    assertJsonValue(parsed, { maxBytes: maximum });
    return options.validate(parsed);
  } catch (error) {
    throw createSafeError('INVALID_MODEL_OUTPUT', { cause: error });
  }
}

/** Parse and independently validate model JSON, with at most one explicit repair. */
export async function validateStructuredOutput<T>(
  text: string,
  options: StructuredOutputOptions<T>,
): Promise<StructuredOutputResult<T>> {
  if (options.signal?.aborted) throw createSafeError('CANCELLED');
  const maximum = Math.min(options.maxBytes ?? LIMITS.generatedOutputBytes, LIMITS.generatedOutputBytes);
  if (new TextEncoder().encode(text).byteLength > maximum) throw createSafeError('PAYLOAD_TOO_LARGE');
  try {
    return { value: parseAndValidate(text, options), repaired: false };
  } catch (error) {
    if (options.repair === undefined) throw error;
  }
  const signal = options.signal ?? new AbortController().signal;
  const repairedText = await options.repair(text, signal);
  if (signal.aborted) throw createSafeError('CANCELLED');
  return { value: parseAndValidate(repairedText, options), repaired: true };
}
