import { LIMITS } from './limits.js';

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

export interface CanonicalizeLimits {
  readonly maxDepth?: number;
  readonly maxEntries?: number;
  readonly maxStringCharacters?: number;
  readonly maxBytes?: number;
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const encoder = new TextEncoder();

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function assertJsonValue(
  value: unknown,
  limits: CanonicalizeLimits = {},
): asserts value is JsonValue {
  const maxDepth = limits.maxDepth ?? LIMITS.jsonDepth;
  const maxEntries = limits.maxEntries ?? LIMITS.jsonEntries;
  const maxStringCharacters = limits.maxStringCharacters ?? LIMITS.jsonStringCharacters;
  const seen = new Set<object>();
  let entries = 0;

  const visit = (candidate: unknown, depth: number): void => {
    if (depth > maxDepth) {
      throw new TypeError('JSON input exceeds the maximum nesting depth.');
    }
    if (candidate === null || typeof candidate === 'boolean') {
      return;
    }
    if (typeof candidate === 'string') {
      if (candidate.length > maxStringCharacters) {
        throw new TypeError('JSON string exceeds the maximum length.');
      }
      return;
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) {
        throw new TypeError('JSON numbers must be finite.');
      }
      return;
    }
    if (typeof candidate !== 'object') {
      throw new TypeError('Value is not JSON serializable.');
    }
    if (seen.has(candidate)) {
      throw new TypeError('Cyclic values are not JSON serializable.');
    }
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      entries += candidate.length;
      if (entries > maxEntries) {
        throw new TypeError('JSON input exceeds the maximum entry count.');
      }
      for (const item of candidate) {
        visit(item, depth + 1);
      }
    } else {
      if (!isPlainObject(candidate)) {
        throw new TypeError('Only plain objects are accepted as JSON objects.');
      }
      const keys = Object.keys(candidate);
      entries += keys.length;
      if (entries > maxEntries) {
        throw new TypeError('JSON input exceeds the maximum entry count.');
      }
      for (const key of keys) {
        if (FORBIDDEN_KEYS.has(key)) {
          throw new TypeError(`Unsafe JSON key: ${key}.`);
        }
        if (key.length > maxStringCharacters) {
          throw new TypeError('JSON object key exceeds the maximum length.');
        }
        visit(candidate[key], depth + 1);
      }
    }
    seen.delete(candidate);
  };

  visit(value, 0);
}

export function canonicalize(value: unknown, limits: CanonicalizeLimits = {}): string {
  assertJsonValue(value, limits);

  const serialize = (candidate: JsonValue): string => {
    if (candidate === null || typeof candidate !== 'object') {
      return JSON.stringify(candidate);
    }
    if (Array.isArray(candidate)) {
      return `[${candidate.map((item) => serialize(item)).join(',')}]`;
    }
    const keys = Object.keys(candidate).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${serialize(candidate[key] as JsonValue)}`)
      .join(',')}}`;
  };

  const serialized = serialize(value);
  const byteLength = encoder.encode(serialized).byteLength;
  if (byteLength > (limits.maxBytes ?? LIMITS.canonicalBytes)) {
    throw new TypeError('Canonical JSON exceeds the maximum byte length.');
  }
  return serialized;
}

function bytesToHex(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, '0');
  }
  return result;
}

export async function sha256Text(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(value));
  return `sha256:${bytesToHex(new Uint8Array(digest))}`;
}

export async function sha256Fingerprint(
  value: unknown,
  limits?: CanonicalizeLimits,
): Promise<string> {
  return sha256Text(canonicalize(value, limits));
}

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}
