# Compatibility record

This public record describes the supported beta boundary without publishing an identifying host fingerprint.

## Toolchain

| Component | Reviewed version |
| --- | --- |
| Node.js | 24.19.0 for the release build; 22+ supported for development |
| pnpm | 10.15.0 |
| TypeScript | 5.9.3 |
| Vite | 7.3.6 |
| Playwright | 1.63.0 |
| WebLLM | 0.2.85 |
| Transformers.js | 4.3.0 |
| Extension manifest | MV3, minimum Chrome 116 |

CI builds and browser tests run on GitHub-hosted Linux with Playwright Chromium. The trusted real-model beta run used headed Chrome 153 on Windows 11, Transformers.js on WASM, and WebLLM on a discrete NVIDIA WebGPU adapter. Exact personal-host specifications are deliberately omitted from the public record.

## Generation model

- Runtime registry ID: `SmolLM2-360M-Instruct-q4f16_1-MLC`.
- MLC model revision: `3a622fd89e0216e8bb10c410c007c786baa8a033`.
- Base model: `HuggingFaceTB/SmolLM2-360M-Instruct`.
- Base revision: `a10cc1512eabd3dde888204e902eca88bddb4951`.
- Base license metadata: Apache-2.0.
- Packaged model-library upstream revision: `025bcaf3780fa8254f5e5efd3bfea0a5397248f4`.
- Packaged model-library SHA-256: `5c20098605780550c40e9c64d288dd6e369707a08d4133037156019b064ad41b`.
- Reviewed quantized weight shards: 203,614,080 bytes, excluding tokenizer, configuration, and browser overhead.

The fixed beta run proved real adapter load, streaming, exact-marker output, structured schema validity, in-flight cancellation, and fresh-worker recovery. Its small semantic probe scored 0/2 and missing-fact abstention scored 0/1. Generation is therefore experimental.

## Embedding model

- Model: `Xenova/all-MiniLM-L6-v2`.
- Revision: `751bff37182d3f1213fa05d7196b954e230abad9`.
- License metadata: Apache-2.0.
- Reviewed quantized ONNX artifact: 22,972,370 bytes.
- Quantized ONNX SHA-256: `afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1`.

The fixed beta run produced valid 384-dimensional vectors and selected the expected source for 3/3 synthetic retrieval probes.

## Integrity boundary

The generation model-library WASM is packaged and hash checked. Model weights, tokenizer files, configuration, and compiled browser caches remain runtime-managed data downloaded after consent. The registry pins their reviewed identities and known bytes, but the adapters do not claim an independent byte-for-byte audit of every remote cache entry.

Model discovery, successful loading, correct schema, semantic correctness, source support, and safe authority are separate checks.
