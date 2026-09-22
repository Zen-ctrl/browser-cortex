# BrowserCortex

[![CI](https://github.com/Zen-ctrl/browser-cortex/actions/workflows/ci.yml/badge.svg)](https://github.com/Zen-ctrl/browser-cortex/actions/workflows/ci.yml)
[![Security boundaries](https://github.com/Zen-ctrl/browser-cortex/actions/workflows/security.yml/badge.svg)](https://github.com/Zen-ctrl/browser-cortex/actions/workflows/security.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-public%20beta-orange.svg)](CHANGELOG.md)

BrowserCortex is a local-first browser intelligence toolkit. It helps you save selected information in an encrypted local vault, search it with citations, and run small reviewed workflows without silently sending your data to a cloud service.

It includes a web workbench, a Chromium extension, reusable TypeScript packages, real local-model adapters, and runnable examples. Models propose content; deterministic policy and approval code decide what is allowed to happen.

> BrowserCortex is a developer beta. The encrypted search and deterministic workflow foundations are the strongest parts today. Small-model generation works on supported hardware, but its quality is experimental and its output must be independently checked.

## What can I do with it?

- Save text, Markdown, CSV, or JSON that you deliberately choose.
- Search saved material locally and see which source supports each result.
- Run bounded data workflows with a preview before any export or external action.
- Capture selected page content through a least-privilege Chromium extension.
- Add local embedding or generation models only after reviewing the download.
- Build your own local-first tool from the packages in this monorepo.
- Optionally connect a developer-operated online gateway after an exact payload review.

There is no required account, hosted database, telemetry service, or silent online fallback.

## Choose your path

| I want to... | Start here |
| --- | --- |
| Try the workbench with a safe example | [Plain-language getting started guide](docs/getting-started.md) |
| Install the extension from a release | [Extension walkthrough](docs/getting-started.md#install-the-chromium-extension) |
| Understand privacy and what can leave my device | [Privacy guide](docs/privacy.md) |
| Build with the TypeScript packages | [Technical guide](docs/technical-guide.md) |
| Find a package or public entry point | [Package map](docs/packages.md) |
| Add a workflow or runtime adapter | [Workflow format](docs/workflow-format.md) and [adapter guide](docs/adapter-authoring.md) |
| Contribute a fix or feature | [Contributing guide](CONTRIBUTING.md) |
| Get help | [Support guide](SUPPORT.md) |

The [documentation index](docs/README.md) organizes every guide by audience.

## Five-minute source setup

You need Node.js 22 or newer, pnpm 10.15.0, Git, and a current Chromium browser.

```bash
git clone https://github.com/Zen-ctrl/browser-cortex.git
cd browser-cortex
corepack enable
pnpm install --frozen-lockfile
pnpm doctor
pnpm dev
```

Open the local address printed by Vite. Create a throwaway vault with a passphrase you can remember, load a synthetic example, and try lexical search before installing a model. No model is downloaded at startup.

For a complete click-by-click walkthrough, including deletion and extension setup, read [Getting started](docs/getting-started.md).

## Install the Chromium extension

The release ZIP is a developer-mode extension, not a Chrome Web Store listing.

1. Download `browser-cortex-extension-v0.3.0-beta.1.zip` and its `.sha256` file from the [latest beta release](https://github.com/Zen-ctrl/browser-cortex/releases/tag/v0.3.0-beta.1).
2. Verify the checksum using the commands in the [getting started guide](docs/getting-started.md#verify-the-download).
3. Extract the ZIP.
4. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the extracted directory.

The extension asks for no broad default website access. Model-host access is requested only when you review and approve a model installation.

## Screenshots

These images come from production-build browser tests using labeled synthetic data.

| Local workbench | Permissioned extension |
| --- | --- |
| ![BrowserCortex workbench showing an encrypted synthetic source and a cited local search result.](https://github.com/Zen-ctrl/browser-cortex/releases/download/v0.3.0-beta.1/workbench-overview.png) | ![BrowserCortex extension panel showing an encrypted synthetic capture and local search.](https://github.com/Zen-ctrl/browser-cortex/releases/download/v0.3.0-beta.1/extension-panel.png) |

## How the safety model works

BrowserCortex separates information from authority:

1. Page text, imported documents, workflows, and model responses are untrusted data.
2. Deterministic code checks schemas, limits, source grants, and capabilities.
3. Retrieval is limited to sources that the current workspace may use.
4. A write, export, or online request receives an exact review before approval.
5. Changing the payload, destination, source revision, model, tool, or policy invalidates that approval.
6. The execution broker verifies postconditions and records a scrubbed or encrypted receipt.

Encryption at rest does not protect an unlocked vault from malicious same-origin code, a compromised browser, or a compromised operating system. Sensitive-data detection can help, but it cannot guarantee anonymity. Read the [threat model](docs/threat-model.md) before using sensitive material.

## Local models and current evidence

The beta pins:

- embeddings: `Xenova/all-MiniLM-L6-v2` at revision `751bff37182d3f1213fa05d7196b954e230abad9`;
- generation: `SmolLM2-360M-Instruct-q4f16_1-MLC` at revision `3a622fd89e0216e8bb10c410c007c786baa8a033`.

The real adapters loaded and ran on the recorded beta test environment. MiniLM retrieved the expected item in 3/3 fixed probes. SmolLM2 passed streaming, schema, cancellation, recovery, and exact-marker checks, but scored 0/2 on the small semantic probe and 0/1 on missing-fact abstention. That is why generation is labeled experimental rather than presented as generally reliable.

See [model installation](docs/model-installation.md), [browser support](docs/browser-support.md), and [compatibility](docs/compatibility.md) for the measured boundary.

## Repository map

```text
apps/          Workbench, extension, and synthetic demo site
packages/      Reusable contracts, policy, privacy, memory, workflow, runtime, UI, and bridge packages
examples/      Small integration examples
docs/          User, developer, privacy, architecture, and release documentation
benchmarks/    Synthetic corpus plus local and real-model runners
tests/         Security, offline, extension, browser, and repository-hygiene coverage
models/        Reviewed model registry and licensing metadata
scripts/       Build, verification, packaging, SBOM, and public-readiness tools
research/      Explicitly experimental prototypes and notes
```

Workspace packages are source components of this repository. They are not currently published to npm and their APIs may change during beta.

## Verification

For an ordinary contribution:

```bash
pnpm check
pnpm build
```

For the complete local acceptance suite:

```bash
pnpm verify:acceptance
```

The hardware and network dependent model run is separate and opt-in:

```bash
pnpm verify:real-model
```

Do not run the real-model command unless you have reviewed its model downloads and are prepared to use a headed local Chrome profile. See [Contributing](CONTRIBUTING.md) for the test matrix.

## Known limits

- A lost vault passphrase has no recovery service.
- Browser storage may be evicted by the browser or operating system.
- Generation requires a compatible WebGPU environment and may be unavailable.
- Only the bundled synthetic demo is approved for extension recording and replay claims.
- Firefox, Safari, mobile browsers, private modes, enterprise policies, and low-memory devices are unsupported or unverified unless the compatibility guide says otherwise.
- The optional gateway is a developer example, not a hosted public proxy.
- There is no browser-store submission, npm package release, or hosted production application.

## Community and licensing

Issues and pull requests are welcome. Use synthetic reproduction data, explain the security and privacy impact of a change, and list only tests that actually ran. Start with [CONTRIBUTING.md](CONTRIBUTING.md), [SUPPORT.md](SUPPORT.md), and [SECURITY.md](SECURITY.md).

BrowserCortex source is licensed under [Apache-2.0](LICENSE). Models and dependencies retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the [model registry](models/registry.json).
