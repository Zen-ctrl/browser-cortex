# Packaged WebLLM runtime asset

`SmolLM2-360M-Instruct-q4f16_1_cs1k-webgpu.wasm` is the model-specific executable WebAssembly library used with `@mlc-ai/web-llm` 0.2.85 and its `v0_2_84/base` runtime registry.

- Upstream repository: `mlc-ai/binary-mlc-llm-libs`
- Upstream commit: `025bcaf3780fa8254f5e5efd3bfea0a5397248f4`
- Exact bytes: `5708562`
- SHA-256: `5c20098605780550c40e9c64d288dd6e369707a08d4133037156019b064ad41b`
- Related source projects: WebLLM and MLC LLM, Apache-2.0

Run `pnpm runtime:fetch` to retrieve and verify the pinned artifact. The build stages it into the workbench and extension so production extension inference never fetches executable runtime code from a remote host. Model weights remain separate data and require an explicit user installation action.
