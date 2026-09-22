# Threat model

## In scope

- Prompt injection in pages and imported documents.
- Malicious or misleading tool descriptions.
- Forged, stale, replayed, cross-frame, and wrong-origin messages.
- Cross-workspace data access and stale source grants.
- Plaintext persistence, logs, and unintended online fallback.
- Malformed workflows, prototype-polluting keys, and resource exhaustion.
- Model or runtime artifact substitution.
- Duplicate effects after interruption and unsafe rendered output.

## Boundaries

The extension origin owns cross-site grants and trusted approval UI. An embedding application owns its same-origin SDK state. Visited pages, retrieved text, model output, imported workflows, and external endpoint responses are untrusted. Model distribution hosts provide revision-pinned data assets, while executable extension runtime files are packaged locally.

## Not fully solved

BrowserCortex cannot defend against a compromised operating system, browser, signing account, malicious same-origin host application, or a provider retaining a payload that the user approved. It cannot guarantee that redacted content is anonymous. Vault lifecycle and mutation serialization is per open vault object; two tabs or processes opening the same storage namespace do not yet share a storage-level lock or compare-and-swap protocol.
