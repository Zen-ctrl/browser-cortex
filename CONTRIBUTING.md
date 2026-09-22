# Contributing

BrowserCortex welcomes focused issues, documentation improvements, tests, and code changes that preserve its local-first and default-deny boundaries.

## Before you start

For a small bug or documentation change, open a pull request directly. For a new capability, storage change, runtime, integration, or trust-boundary change, open an issue first so the intended authority and privacy model can be discussed before implementation.

Use only synthetic data. Never attach or commit user documents, everyday browser profiles, credentials, private prompts, model weights, machine-specific diagnostics, personal contact details, or absolute home paths.

## Development setup

Requirements:

- Node.js 22 or newer;
- pnpm 10.15.0 through Corepack;
- Git;
- a current Chromium browser for browser tests;
- at least 8 GiB of free disk space for dependencies, browsers, and optional model caches.

```bash
git clone https://github.com/Zen-ctrl/browser-cortex.git
cd browser-cortex
corepack enable
pnpm install --frozen-lockfile
pnpm doctor
pnpm check
pnpm build
```

`pnpm doctor` is local-only. Its output omits usernames, account identities, absolute paths, OS build numbers, and exact disk capacity, so it is safer to include in a public support request.

## Test matrix

| Change | Minimum checks |
| --- | --- |
| Documentation only | `pnpm check:copy`, `pnpm check:public` |
| Package or application code | `pnpm check`, `pnpm build` |
| Policy, privacy, gateway, storage, or extension boundary | Above plus `pnpm test:security`, `pnpm test:offline`, or `pnpm test:extension` as applicable |
| Browser UI or extension behavior | Above plus `pnpm test:e2e` |
| Release-boundary change | `pnpm verify:acceptance` |
| Local-model runtime change | Focused tests plus an explicitly consented `pnpm verify:real-model` run on suitable hardware |

The real-model run downloads reviewed model data and opens a headed isolated Chrome profile. It is not required for ordinary documentation, deterministic package, or UI contributions. Never substitute a simulated runtime while claiming that a real model ran.

## Engineering rules

- Use strict TypeScript and runtime validation at every external boundary.
- Keep policy, permissions, arithmetic, validation, and execution deterministic.
- Treat page text, imported documents, workflow files, tool descriptions, and model output as untrusted data.
- Keep online processing disabled by default. A local failure must never trigger online fallback.
- Keep extension executable code packaged locally. Do not add remote scripts or dynamic code evaluation.
- Keep workflows finite and declarative. Do not turn workflow data into JavaScript or shell commands.
- Propagate cancellation and report ambiguous external outcomes honestly.
- Pin reviewed model and runtime revisions and preserve third-party notices.
- Add or update a decision record for changes to cryptography, storage, permissions, online egress, extension hosting, model execution, or workflow semantics.
- Keep authored project copy free of Unicode U+2014.

## Pull requests

Create a small branch or isolated worktree. A pull request should explain:

1. the user-visible or contract change;
2. why the change belongs in BrowserCortex;
3. tests actually run and their results;
4. security, privacy, storage, permission, network, model, and supply-chain impact;
5. known limitations or unverified hardware-dependent behavior.

Use ordinary descriptive commits and genuine attribution. Do not add automated coauthor trailers, generated-by footers, invented contributors, or artificial signatures.

Maintainers may ask for a smaller change, synthetic fixture, decision record, or additional negative test when a proposal expands authority or data access.

## Documentation

Write for the least experienced reader who can reasonably perform the task. Define unfamiliar terms, give a safe example, state what leaves the device, and separate observed evidence from expectation. Update the [documentation index](docs/README.md) when adding a new guide.

## Releases

Release credentials, tags, public assets, browser-store work, and hosted services are maintainer-only operations. A pull request may improve release tooling, but contributors should not need publication credentials.
