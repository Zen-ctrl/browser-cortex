const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export const utf8 = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);
export const text = (value: Uint8Array<ArrayBufferLike>): string => new TextDecoder("utf-8", { fatal: true }).decode(value);

/**
 * Return an owned ArrayBuffer for Web Crypto boundaries.
 *
 * TypeScript 5.9 correctly models a general Uint8Array as potentially backed by
 * SharedArrayBuffer, while SubtleCrypto accepts only BufferSource. Copying here
 * keeps those API boundaries explicit and also prevents a caller from mutating
 * the bytes while an asynchronous cryptographic operation is pending.
 */
export function toArrayBuffer(value: Uint8Array<ArrayBufferLike>): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

export function toBase64(value: Uint8Array): string {
  let result = "";
  for (let offset = 0; offset < value.length; offset += 3) {
    const a = value[offset] ?? 0;
    const b = value[offset + 1] ?? 0;
    const c = value[offset + 2] ?? 0;
    const triple = (a << 16) | (b << 8) | c;
    result += BASE64_ALPHABET[(triple >>> 18) & 63];
    result += BASE64_ALPHABET[(triple >>> 12) & 63];
    result += offset + 1 < value.length ? BASE64_ALPHABET[(triple >>> 6) & 63] : "=";
    result += offset + 2 < value.length ? BASE64_ALPHABET[triple & 63] : "=";
  }
  return result;
}

export function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  if (value.length === 0 || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/u.test(value)) {
    throw new Error("Invalid base64 value.");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const result = new Uint8Array((value.length / 4) * 3 - padding);
  let output = 0;
  for (let offset = 0; offset < value.length; offset += 4) {
    const chars = value.slice(offset, offset + 4);
    const values = [...chars].map((char) => (char === "=" ? 0 : BASE64_ALPHABET.indexOf(char)));
    if (values.some((item) => item < 0)) throw new Error("Invalid base64 value.");
    const triple = ((values[0] ?? 0) << 18) | ((values[1] ?? 0) << 12) | ((values[2] ?? 0) << 6) | (values[3] ?? 0);
    if (output < result.length) result[output++] = (triple >>> 16) & 255;
    if (output < result.length) result[output++] = (triple >>> 8) & 255;
    if (output < result.length) result[output++] = triple & 255;
  }
  return result;
}

export function randomId(cryptoProvider: Crypto): string {
  if (typeof cryptoProvider.randomUUID === "function") return cryptoProvider.randomUUID();
  const bytes = cryptoProvider.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((item) => item.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function sha256(cryptoProvider: Crypto, value: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await cryptoProvider.subtle.digest("SHA-256", toArrayBuffer(value)));
  return [...digest].map((item) => item.toString(16).padStart(2, "0")).join("");
}
