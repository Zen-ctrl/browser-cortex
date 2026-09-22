# Architecture

BrowserCortex has three user-facing surfaces: an application-local SDK, a static web workbench, and a Manifest V3 extension. They share versioned contracts, but their vaults and permissions remain separate.

The trusted flow is:

1. Normalize an explicit request and label every source.
2. Apply deterministic policy and permission checks.
3. Retrieve a bounded set of permitted passages.
4. Select deterministic code, an installed local model, or an approved online adapter.
5. Validate all generated output as untrusted data.
6. Show a trusted preview when approval is required.
7. Execute through a capability-checking broker.
8. Verify postconditions and save an encrypted local receipt.

Models do not grant permission. Pages do not approve actions. Imported workflow files do not become code. The online transport is isolated behind one approval-bound broker.

