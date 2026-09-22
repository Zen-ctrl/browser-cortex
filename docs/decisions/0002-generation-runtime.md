# ADR 0002: WebLLM generation adapter

Status: experimental pending the final real-model run.

Use `@mlc-ai/web-llm` 0.2.85 behind a lazy adapter. Model candidates come from the installed package's prebuilt registry rather than an invented Hugging Face identifier. A user chooses installation after reviewing runtime metadata. WebGPU generation remains unavailable in reduced mode.

The extension bundles WebLLM executable code and WASM with its production output. Model weights remain separately installed data. Alternatives included direct ONNX generation and a hosted model. The former increases conversion and compatibility work; the latter violates local-first and default-off requirements.

