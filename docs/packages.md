# Package map

All workspace packages are unpublished source packages during beta. Their manifests use npm's `private` publication guard to prevent accidental registry releases. Import examples use their intended package names inside this monorepo, but nothing here is currently published to npm.

| Package | Public entry point | Owns | Does not own |
| --- | --- | --- | --- |
| `@browser-cortex/contracts` | `packages/contracts/src/index.ts` | Schemas, limits, canonical JSON, runtime contracts, safe errors | Policy decisions or side effects |
| `@browser-cortex/policy` | `packages/policy/src/index.ts` | Source grants, capability evaluation, one-use approval handles | UI prompts or model reasoning |
| `@browser-cortex/privacy` | `packages/privacy/src/index.ts` | Sensitive-data findings, redaction maps, disclosure construction | A guarantee of anonymity |
| `@browser-cortex/memory` | `packages/memory/src/index.ts` | Vault crypto, storage, migrations, ingest, revisions, retrieval, transfer | Cross-tab coordination or model authority |
| `@browser-cortex/workflows` | `packages/workflows/src/index.ts` | Finite workflow schema, compiler, validator, interpreter, operations, checkpoints, reuse | Arbitrary code or unrestricted automation |
| `@browser-cortex/core` | `packages/core/src/index.ts` | Lifecycle, routing, scheduling, recovery, structured output, egress broker | Browser UI or persistent storage implementation |
| `@browser-cortex/runtime-transformers` | `packages/runtime-transformers/src/index.ts` | Pinned Transformers.js embedding adapter | Permission or source-support decisions |
| `@browser-cortex/runtime-webllm` | `packages/runtime-webllm/src/index.ts` | Pinned WebLLM worker adapter, streaming, cancellation, cache invalidation | Trusting generated content |
| `@browser-cortex/bridge` | `packages/bridge/src/index.ts` | Narrow extension messages and document-bound sessions | Page-granted authority |
| `@browser-cortex/ui` | `packages/ui/src/index.ts` | Shared accessible React primitives and styles | Product state or policy |
| `@browser-cortex/testkit` | `packages/testkit/src/index.ts` | Synthetic fixtures, deterministic helpers, simulated runtimes, corpus support | Real-model evidence |

## Application packages

| Application | Command | Purpose |
| --- | --- | --- |
| Workbench | `pnpm dev` | Local browser UI for memory, workflows, models, privacy, and settings |
| Synthetic demo | `pnpm dev:demo` | Safe page fixture for explicit extension capture and reviewed actions |
| Chromium extension | `pnpm build`, then load `apps/extension/dist` | MV3 side panel, extension vault, strict bridge, and demo-only recording |

## Examples

| Example | Command | Demonstrates |
| --- | --- | --- |
| Vanilla local search | `pnpm dev:example:search` | SDK lifecycle, encrypted memory, and optional embeddings without React |
| React workflow review | `pnpm dev:example:workflow` | Compile, validate, preview, approve, and download a deterministic CSV result |
| Developer online gateway | `pnpm dev:gateway` | Authenticated fixed-upstream boundary with bounded requests and scrubbed logs |

Read a package's `src/index.ts` before importing it. Internal files are not compatibility promises. Add a public export intentionally and cover it with package tests when extending the API.
