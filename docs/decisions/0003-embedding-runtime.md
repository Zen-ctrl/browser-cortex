# ADR 0003: Transformers.js embedding adapter

Status: experimental pending the final real-model run.

Use `@huggingface/transformers` 4.3.0 for feature extraction behind a dedicated lazy adapter. The adapter requests mean pooling and normalized finite vectors, records the model reference and vector dimensions, and supports a verified WASM path before optional WebGPU acceleration.

Lexical retrieval remains available without a model. This keeps local search useful when an embedding model is absent or unsupported.

