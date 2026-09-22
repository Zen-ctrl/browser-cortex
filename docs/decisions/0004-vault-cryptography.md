# ADR 0004: Encrypted vault format

Status: accepted for beta implementation, independent security audit not claimed.

Each vault has a random 256-bit data key. Records use AES-256-GCM with a new 96-bit random nonce and authenticated metadata containing the format version, vault ID, record ID, record type, and revision. A passphrase-derived key wraps the data key. The browser implementation uses Web Crypto PBKDF2 with SHA-256 and a per-vault 128-bit salt. The iteration count is versioned and must be benchmarked before a stable release.

The wrapped key, KDF parameters, random IDs, record sizes, and migration metadata may remain clear. Documents, chunks, embeddings, titles, sensitive URLs, workflows, grants, and detailed receipts are ciphertext. Passphrases and unwrapped keys are never persisted intentionally.

AES-GCM and PBKDF2 are established primitives, but protocol mistakes remain possible. Encryption at rest does not defend an unlocked vault against same-origin script, browser compromise, operating-system compromise, screenshots, or deliberate exports. Browser and operating-system memory copies cannot be promised to be physically zeroed.

The beta vault serializes asynchronous lifecycle and mutation operations within one `EncryptedMemoryVault` instance and uses an epoch to reject stale completions after lock or key changes. IndexedDB namespaces do not yet provide a BrowserCortex cross-tab/process writer lock. Hosts must avoid concurrent independent instances for the same namespace; storage-level coordination is future format work.

Argon2id was considered, but it requires an additional audited WASM implementation in the extension. A later format version can add it after compatibility and CSP review.
