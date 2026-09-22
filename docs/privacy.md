# Privacy boundaries

BrowserCortex keeps local mode enabled by default. Documents, embeddings, saved workflows, source titles, sensitive URLs, and detailed receipts are encrypted before persistent storage. The workbench and extension have independent origin-scoped vaults.

Encryption at rest does not protect an unlocked vault from malicious same-origin code, a compromised extension or browser, an infected operating system, screenshots, or information a user exports. Browser storage can be cleared or evicted. Users should keep encrypted exports for important data.

Each vault instance serializes its own lifecycle and write operations and invalidates work that finishes after a lock or key transition. This does not coordinate separate tabs or processes that independently open the same storage namespace; applications should keep one active owner until a storage-level cross-context lock is implemented.

Model installation contacts the disclosed model host. Hosting the application contacts its web host. Optional online inference contacts only a configured endpoint after an exact payload preview is approved. Sensitive-data detection reduces exposure but cannot guarantee anonymity or find every identifying fact.
