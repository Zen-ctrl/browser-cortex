# Technical guide

BrowserCortex is a pnpm TypeScript monorepo for local-first browser tools. The architecture treats language models as optional untrusted components and gives authority only to deterministic host code.

Workspace packages are internal source packages during beta. They are not published to npm and may change before a stable release.

## System shape

```text
explicit user request
        |
        v
versioned contracts and source labels
        |
        v
deterministic policy and capability checks
        |
        +---------------------------+
        |                           |
        v                           v
bounded local retrieval       route selection
                                    |
                  +-----------------+-----------------+
                  |                 |                 |
                  v                 v                 v
          deterministic code   local model     approved gateway
                  |                 |                 |
                  +-----------------+-----------------+
                                    |
                                    v
                       schema and source validation
                                    |
                                    v
                    trusted preview and exact approval
                                    |
                                    v
                       capability-checking execution
                                    |
                                    v
                    postconditions and encrypted receipt
```

Page text, imported documents, workflow descriptions, tool metadata, and model output remain data throughout this flow. None of them can create a grant, approve a payload, install a model, enable a transport, or invoke an effect directly.

## Repository layers

| Layer | Location | Responsibility |
| --- | --- | --- |
| Contracts | `packages/contracts` | Versioned schemas, limits, canonical JSON, safe error shapes, runtime interfaces |
| Authority | `packages/policy`, `packages/privacy` | Grants, one-use approvals, detection, redaction, exact disclosure |
| Data | `packages/memory` | Encryption, vault lifecycle, ingestion, revisions, retrieval, migration, transfer |
| Planning and execution | `packages/workflows`, `packages/core` | Finite workflow validation, routing, scheduling, structured output, egress |
| Model adapters | `packages/runtime-transformers`, `packages/runtime-webllm` | Lazy embedding and generation runtimes with explicit lifecycle and cancellation |
| Browser boundary | `packages/bridge`, `apps/extension` | Narrow document-bound sessions, strict messages, MV3 panel/background/content roles |
| Presentation | `packages/ui`, `apps/workbench` | Shared UI primitives and the local workbench |
| Evidence | `tests`, `benchmarks`, `scripts` | Adversarial tests, browser flows, measured reports, packaging, provenance, SBOM |

See [Package map](packages.md) for every package and public entry point.

## Lifecycle and side effects

Constructors and imports do not install models or open network connections. Hosts explicitly initialize and dispose runtime owners. The core lifecycle is:

1. create an instance with trusted route and executor adapters;
2. call `initialize()`;
3. build a proposal from a bounded request;
4. inspect its route and reason codes;
5. obtain any required grant or exact approval outside model output;
6. execute with an `AbortSignal`;
7. inspect postconditions and receipts;
8. call `dispose()`.

The [SDK guide](sdk.md) contains a runnable core example. Every asynchronous boundary accepts or propagates cancellation where the underlying runtime supports it. A timeout or abort does not imply that an external non-idempotent action failed; ambiguous outcomes are reported as unknown and are not retried automatically.

## Encrypted memory

The memory package stores a passphrase-wrapped random data key. Records are independently authenticated and encrypted. Source text, revisions, chunks, derived vectors, grants, saved workflows, and detailed receipts share a vault identity but keep explicit record types and dependencies.

Import flow:

1. enforce file, byte, row, field, and nesting limits before expensive work;
2. normalize a supported text, Markdown, CSV, or JSON input;
3. create a source revision and labeled chunks;
4. optionally compute embeddings through the selected adapter;
5. encrypt records before storage;
6. invalidate dependent derived data when a source changes or is deleted.

Retrieval always filters by current source grants before ranking. Lexical ranking works without a model. Hybrid ranking combines lexical and embedding scores only when compatible vectors exist. A result carries source and revision provenance; it is a suggestion, not automatically a fact.

The schema v1 to v2 migration uses an authenticated retained-ciphertext backup, verifies the reopened migrated vault, and restores the prior data on a failed boundary. Future unknown schemas stop rather than guessing. Vault-operation serialization is per open vault instance; separate tabs are not yet coordinated by a storage-level lock.

## Deterministic workflows

A workflow is versioned JSON interpreted through a fixed operation registry. It cannot contain JavaScript, shell commands, arbitrary functions, recursive calls, or unbounded loops.

Validation parses the schema, resolves backward-only references, checks trusted dependencies, derives capabilities from operation definitions, enforces limits, and produces a canonical plan fingerprint. Arithmetic that needs exactness uses safe integer minor units or canonical decimal strings. Date comparisons require an explicit ISO-date mode. CSV export escapes formula-like cells.

Effects are separated from preparation:

```text
compile -> validate -> dry run -> exact preview -> one-use approval -> dispatch -> postcondition
```

Changing source revisions, arguments, tool versions, policy, target, or output bytes changes the approval binding. See [Workflow format](workflow-format.md).

## Model runtimes

The Transformers adapter supplies pinned MiniLM embeddings on the reviewed WASM path. The WebLLM adapter supplies pinned SmolLM2 generation through a dedicated worker and packaged model-library WASM. Model weights and tokenizer/configuration data are downloaded only after consent and remain in runtime-managed browser caches.

Discovery, download, load, inference, output quality, cancellation, and cleanup are distinct states. A model ID in a registry is not proof that a browser can run it. A loaded model is not proof that an answer is correct.

Generation streams through a manually controlled async iterator so an abort can win immediately even if the underlying iterator stalls. An aborted or failed worker is invalidated before recovery. Structured output is parsed and checked independently from semantic source support.

Review [Model installation](model-installation.md), the [model registry](../models/registry.json), and [Adapter authoring](adapter-authoring.md) before changing a runtime.

## Extension trust boundary

The MV3 extension has three roles:

- the content script exposes only narrow page facts and synthetic-demo actions;
- the background service worker validates messages and browser-owned tab/frame/document context;
- the visible side panel owns private UI, the extension-origin vault, approvals, and optional inference.

Sessions bind to browser-verified document identity and expire on navigation or replacement. A visited page cannot enumerate the vault. The extension requests no broad default host permission. Optional model-host permission is requested after installation review. Executable extension code is packaged locally under a strict CSP; only reviewed model data may be fetched after consent.

Recording and replay are limited to the bundled synthetic demo contract. Drift stops replay rather than broadening selectors or guessing.

## Optional online boundary

Online routing is denied by default and is never a fallback for local failure. A host must explicitly configure a fixed gateway, select ask-before-online policy, build an exact disclosure, and consume a one-use approval bound to the payload and destination.

The example gateway accepts a bounded BrowserCortex envelope, validates authentication plus Origin and Host, uses one fixed upstream configured by the operator, rejects unsafe redirects, caps requests and responses, applies timeouts, and scrubs logs. It is reference code, not a hosted proxy. No live provider compatibility claim exists without an operator's authorized synthetic test.

## Errors and observability

External boundaries return stable safe error codes rather than raw provider, storage, or model internals. User-visible activity summaries omit prompts, source text, credentials, provider bodies, and encrypted payloads. Detailed workflow receipts are encrypted when the vault is available.

Do not log raw imported content, passphrases, bearer values, replacement maps, model prompts containing private data, or full storage exports. Public diagnostics should use synthetic data and omit home paths, machine names, account identifiers, and exact host fingerprints.

## Adding a capability

1. Define or extend a versioned contract.
2. Decide which deterministic component owns authority.
3. Add explicit size, time, row, output, and recursion limits.
4. Add negative and adversarial fixtures before UI wiring.
5. Add a known operation or adapter rather than evaluating generated code.
6. Bind grants and approvals to every dependency that could change meaning.
7. Propagate cancellation and define ambiguous external outcomes.
8. Update privacy, threat, permissions, and compatibility documentation.
9. Add a decision record when the trust model changes.

## Verification levels

```bash
# Fast contributor gate
pnpm check
pnpm build

# Full deterministic and browser acceptance
pnpm verify:acceptance

# Explicit hardware/network-dependent adapter evidence
pnpm verify:real-model
```

CI runs the aggregate acceptance suite with synthetic fixtures. Trusted real-model evidence stays separate because a shared runner or simulated adapter does not prove local WebGPU execution. Release reports must bind their source commit and artifact hashes and must be sanitized before public upload.
