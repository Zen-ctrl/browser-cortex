# BrowserCortex model registry

Model weights are not stored in this repository. `registry.json` records immutable upstream revisions, license metadata, reviewed byte counts, and executable-runtime facts for the beta adapters.

The reviewed beta choices are:

- `Xenova/all-MiniLM-L6-v2` for embeddings;
- `SmolLM2-360M-Instruct-q4f16_1-MLC` for bounded generation.

They are defaults only for the documented beta adapters, not claims that they are the best model for every browser or task. Installation is a separate explicit user action. The interface discloses task, hosts, immutable revision, known bytes, license, device, and storage behavior before download.

The WebLLM package can advertise a remote `model_lib`. BrowserCortex replaces it with the exact reviewed packaged WASM path and verifies those vendored executable bytes before worker initialization. Model weights remain data and may be downloaded after consent.

The Transformers adapter pins the MiniLM revision, but the runtime owns its browser cache. Do not claim that runtime-managed remote cache bytes were independently verified unless an installation path actually inspects them.

Model discovery, download, successful loading, vector or schema validity, semantic correctness, source support, and safe authority are separate checks. The beta SmolLM2 runtime passed execution and cancellation checks but failed its small semantic-quality probes, so its output remains experimental and untrusted.

Source-code licensing does not automatically license model artifacts. Review the base model, conversion repository, runtime, and packaged compiler notices separately before changing the registry.
