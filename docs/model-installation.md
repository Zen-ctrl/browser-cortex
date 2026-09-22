# Model installation

Opening BrowserCortex does not download a model. The Models screen first reads locally packaged runtime metadata, then lists candidates discovered from the installed runtime registry.

Before starting an installation, review:

- model task and identifier;
- model host and upstream owner;
- source license and model card;
- estimated download and storage size when the runtime exposes it;
- execution mode, such as WebGPU generation or WASM embeddings;
- known hardware and quality limits.

The generation adapter uses the WebLLM package and its current prebuilt model registry. The embedding adapter uses Transformers.js and a pinned model reference. Runtime executable JavaScript and WASM for the extension are bundled by the extension build. Model weights are data assets downloaded only after the install action.

Cancel stops the current operation through an `AbortSignal`. Runtime-managed cache entries remain owned by that runtime. Clearing model files is separate from deleting the encrypted personal vault.

Model weights are not covered automatically by this repository's Apache-2.0 source license. Consult each linked model card and license before use or redistribution.

