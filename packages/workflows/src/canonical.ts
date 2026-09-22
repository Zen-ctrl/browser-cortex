const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function canonicalize(value: unknown, depth = 0): string {
  if (depth > 32) throw new Error("Value exceeds the canonicalization depth limit.");
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite numbers cannot be canonicalized.");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item, depth + 1)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    for (const [key] of entries) if (FORBIDDEN_KEYS.has(key)) throw new Error("Unsafe object key.");
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item, depth + 1)}`).join(",")}}`;
  }
  throw new Error("Unsupported value in canonical serialization.");
}

export async function fingerprint(value: unknown, cryptoProvider: Crypto = globalThis.crypto): Promise<string> {
  if (!cryptoProvider?.subtle) throw new Error("Web Crypto is required for fingerprints.");
  const bytes = new TextEncoder().encode(canonicalize(value));
  const digest = new Uint8Array(await cryptoProvider.subtle.digest("SHA-256", bytes));
  return [...digest].map((item) => item.toString(16).padStart(2, "0")).join("");
}

export function assertSafeKey(value: string): void {
  if (FORBIDDEN_KEYS.has(value)) throw new Error(`Unsafe key: ${value}`);
}
