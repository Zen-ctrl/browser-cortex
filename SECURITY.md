# Security policy

## Supported versions

| Version | Security fixes |
| --- | --- |
| Current beta on `main` | Yes, best effort |
| Older beta tags | Only when a fix can be backported safely |
| Unreleased forks and modified builds | No maintainer support commitment |

There is no stable support window or response-time guarantee during beta.

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/Zen-ctrl/browser-cortex/security/advisories/new). Do not open a public issue for a vulnerability that could expose data, credentials, another person, or a working exploit.

Include the affected commit, browser and operating-system family, model and runtime revision when relevant, synthetic reproduction steps, expected boundary, actual result, and whether data left the device or an external action may have occurred. Remove home paths, machine names, account identifiers, real documents, private prompts, and credentials.

If private vulnerability reporting is temporarily unavailable, do not publish the details. Open a minimal public issue stating that the private reporting route is unavailable without including exploit or private-data information.

## High-priority boundaries

- unauthorized online egress or silent cloud fallback;
- wrong-origin, stale, changed-payload, or reusable approval;
- plaintext private storage or failed deletion boundaries;
- arbitrary code execution from workflow or model data;
- forged extension messages or cross-document grant reuse;
- duplicate non-idempotent actions or falsely reported success;
- remote executable extension code;
- release artifacts containing credentials or private user data.

## Scope and limits

BrowserCortex cannot protect an unlocked vault from malicious same-origin application code, a compromised browser or extension, a compromised operating system, or an approved provider retaining an approved payload. Sensitive-data detection can miss identifying context. Browser storage and runtime-managed model caches can be evicted outside the application's control.

Read the [threat model](docs/threat-model.md) and [security review](docs/security-review.md) for details.
