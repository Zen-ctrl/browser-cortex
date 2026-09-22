import { fromBase64, randomId, toArrayBuffer, toBase64, utf8 } from "./encoding.js";
import type {
  EncryptedRecord,
  MemoryRecordKind,
  PersistedEncryptedRecord,
  PersistedPrivateMemoryRecord,
  PersistedVaultHeader,
  PrivateMemoryRecord,
  SupportedMemorySchemaVersion,
  VaultHeader,
} from "./types.js";
import { LEGACY_MEMORY_SCHEMA_VERSION, MEMORY_SCHEMA_VERSION } from "./types.js";
import { validatePersistedPrivateRecord, validatePrivateRecord } from "./validation.js";

const DATA_KEY_BYTES = 32;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const DEFAULT_PBKDF2_ITERATIONS = 310_000;
const WRAP_AAD = utf8("BrowserCortex:v1:data-key");

function assertPassphrase(passphrase: string): void {
  if (passphrase.length < 12 || passphrase.length > 1_024) {
    throw new Error("Passphrase must contain between 12 and 1024 characters.");
  }
}

function recordAad(schemaVersion: SupportedMemorySchemaVersion, id: string, kind: MemoryRecordKind): Uint8Array {
  return utf8(JSON.stringify({ schemaVersion, id, kind }));
}

async function deriveWrappingKey(
  cryptoProvider: Crypto,
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  assertPassphrase(passphrase);
  const material = await cryptoProvider.subtle.importKey("raw", toArrayBuffer(utf8(passphrase)), "PBKDF2", false, ["deriveKey"]);
  return cryptoProvider.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: toArrayBuffer(salt), iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function createVaultKey(
  cryptoProvider: Crypto,
  passphrase: string,
  now: Date,
): Promise<{ header: VaultHeader; dataKey: CryptoKey; rawDataKey: Uint8Array }> {
  const rawDataKey = cryptoProvider.getRandomValues(new Uint8Array(DATA_KEY_BYTES));
  const salt = cryptoProvider.getRandomValues(new Uint8Array(SALT_BYTES));
  const nonce = cryptoProvider.getRandomValues(new Uint8Array(NONCE_BYTES));
  const wrappingKey = await deriveWrappingKey(cryptoProvider, passphrase, salt, DEFAULT_PBKDF2_ITERATIONS);
  const wrapped = await cryptoProvider.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(nonce), additionalData: toArrayBuffer(WRAP_AAD), tagLength: 128 },
    wrappingKey,
    toArrayBuffer(rawDataKey),
  );
  const dataKey = await cryptoProvider.subtle.importKey("raw", rawDataKey, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  const retainedRawDataKey = rawDataKey.slice();
  rawDataKey.fill(0);
  const timestamp = now.toISOString();
  return {
    dataKey,
    rawDataKey: retainedRawDataKey,
    header: {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      vaultId: randomId(cryptoProvider),
      createdAt: timestamp,
      updatedAt: timestamp,
      kdf: {
        name: "PBKDF2",
        hash: "SHA-256",
        iterations: DEFAULT_PBKDF2_ITERATIONS,
        salt: toBase64(salt),
      },
      wrapping: {
        algorithm: "AES-GCM",
        nonce: toBase64(nonce),
        wrappedDataKey: toBase64(new Uint8Array(wrapped)),
      },
    },
  };
}

export async function unwrapVaultKey(cryptoProvider: Crypto, header: PersistedVaultHeader, passphrase: string): Promise<CryptoKey> {
  if (
    ![LEGACY_MEMORY_SCHEMA_VERSION, MEMORY_SCHEMA_VERSION].includes(header.schemaVersion) ||
    header.kdf.iterations < 100_000
  ) {
    throw new Error("Unsupported or unsafe vault header.");
  }
  const wrappingKey = await deriveWrappingKey(
    cryptoProvider,
    passphrase,
    fromBase64(header.kdf.salt),
    header.kdf.iterations,
  );
  let raw: ArrayBuffer;
  try {
    raw = await cryptoProvider.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(fromBase64(header.wrapping.nonce)),
        additionalData: toArrayBuffer(WRAP_AAD),
        tagLength: 128,
      },
      wrappingKey,
      toArrayBuffer(fromBase64(header.wrapping.wrappedDataKey)),
    );
  } catch {
    throw new Error("The passphrase is incorrect or the vault header is corrupted.");
  }
  const bytes = new Uint8Array(raw);
  const key = await cryptoProvider.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  bytes.fill(0);
  return key;
}

export interface VaultKeyMaterial {
  key: CryptoKey;
  raw: Uint8Array;
}

export async function unwrapVaultKeyMaterial(
  cryptoProvider: Crypto,
  header: PersistedVaultHeader,
  passphrase: string,
): Promise<VaultKeyMaterial> {
  const wrappingKey = await deriveWrappingKey(
    cryptoProvider,
    passphrase,
    fromBase64(header.kdf.salt),
    header.kdf.iterations,
  );
  let rawBuffer: ArrayBuffer;
  try {
    rawBuffer = await cryptoProvider.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(fromBase64(header.wrapping.nonce)),
        additionalData: toArrayBuffer(WRAP_AAD),
        tagLength: 128,
      },
      wrappingKey,
      toArrayBuffer(fromBase64(header.wrapping.wrappedDataKey)),
    );
  } catch {
    throw new Error("The passphrase is incorrect or the vault header is corrupted.");
  }
  const raw = new Uint8Array(rawBuffer);
  const key = await cryptoProvider.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  return { key, raw };
}

export async function rewrapRawVaultKey(
  cryptoProvider: Crypto,
  header: VaultHeader,
  rawDataKey: Uint8Array,
  newPassphrase: string,
  now: Date,
): Promise<VaultHeader> {
  const salt = cryptoProvider.getRandomValues(new Uint8Array(SALT_BYTES));
  const nonce = cryptoProvider.getRandomValues(new Uint8Array(NONCE_BYTES));
  const wrappingKey = await deriveWrappingKey(cryptoProvider, newPassphrase, salt, DEFAULT_PBKDF2_ITERATIONS);
  const wrapped = await cryptoProvider.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(nonce), additionalData: toArrayBuffer(WRAP_AAD), tagLength: 128 },
    wrappingKey,
    toArrayBuffer(rawDataKey),
  );
  return {
    ...header,
    updatedAt: now.toISOString(),
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: DEFAULT_PBKDF2_ITERATIONS, salt: toBase64(salt) },
    wrapping: { algorithm: "AES-GCM", nonce: toBase64(nonce), wrappedDataKey: toBase64(new Uint8Array(wrapped)) },
  };
}

export async function encryptRecord(
  cryptoProvider: Crypto,
  key: CryptoKey,
  record: PrivateMemoryRecord,
): Promise<EncryptedRecord> {
  const nonce = cryptoProvider.getRandomValues(new Uint8Array(NONCE_BYTES));
  const plain = utf8(JSON.stringify(record));
  const cipher = await cryptoProvider.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(nonce),
      additionalData: toArrayBuffer(recordAad(MEMORY_SCHEMA_VERSION, record.id, record.kind)),
      tagLength: 128,
    },
    key,
    toArrayBuffer(plain),
  );
  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    id: record.id,
    kind: record.kind,
    nonce: toBase64(nonce),
    ciphertext: toBase64(new Uint8Array(cipher)),
    byteLength: cipher.byteLength,
  };
}

export async function decryptRecord(
  cryptoProvider: Crypto,
  key: CryptoKey,
  record: EncryptedRecord,
): Promise<PrivateMemoryRecord> {
  if (record.schemaVersion !== MEMORY_SCHEMA_VERSION || record.byteLength < 16) throw new Error("Invalid encrypted record.");
  return await decryptRecordAtVersion(cryptoProvider, key, record, MEMORY_SCHEMA_VERSION) as PrivateMemoryRecord;
}

export async function decryptPersistedRecord(
  cryptoProvider: Crypto,
  key: CryptoKey,
  record: PersistedEncryptedRecord,
): Promise<PersistedPrivateMemoryRecord> {
  if (
    record.schemaVersion !== LEGACY_MEMORY_SCHEMA_VERSION &&
    record.schemaVersion !== MEMORY_SCHEMA_VERSION
  ) {
    throw new Error("Invalid encrypted record.");
  }
  return decryptRecordAtVersion(cryptoProvider, key, record, record.schemaVersion);
}

async function decryptRecordAtVersion(
  cryptoProvider: Crypto,
  key: CryptoKey,
  record: PersistedEncryptedRecord,
  schemaVersion: SupportedMemorySchemaVersion,
): Promise<PersistedPrivateMemoryRecord> {
  if (record.schemaVersion !== schemaVersion || record.byteLength < 16) throw new Error("Invalid encrypted record.");
  let plain: ArrayBuffer;
  try {
    plain = await cryptoProvider.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(fromBase64(record.nonce)),
        additionalData: toArrayBuffer(recordAad(schemaVersion, record.id, record.kind)),
        tagLength: 128,
      },
      key,
      toArrayBuffer(fromBase64(record.ciphertext)),
    );
  } catch {
    throw new Error(`Encrypted ${record.kind} record failed authentication.`);
  }
  const parsed = schemaVersion === MEMORY_SCHEMA_VERSION
    ? validatePrivateRecord(JSON.parse(new TextDecoder().decode(plain)))
    : validatePersistedPrivateRecord(JSON.parse(new TextDecoder().decode(plain)), schemaVersion);
  if (parsed.id !== record.id || parsed.kind !== record.kind) {
    throw new Error("Encrypted record metadata does not match its payload.");
  }
  return parsed;
}
