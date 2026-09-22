# Third-party notices

BrowserCortex source is licensed under Apache-2.0. Dependencies, model data, and executable model libraries retain their own licenses and notices.

The developer extension contains JavaScript derived from the production dependency graph. Its build generates `THIRD_PARTY_LICENSES.txt` from the exact installed, lockfile-reconciled production packages. The bundle preserves each available package license or notice file, declared license expression, package version, and source metadata. Packages that omit a license file from their npm archive use exact-version reviewed fallback notices kept under `third_party/licenses/`; each fallback is identified in the generated bundle. `guid-typescript@1.0.9` declares ISC but publishes no authentic notice, so its WebGL-only implementation is blocked from the WebGPU extension output and is listed as installed but not distributed.

The platform packages `@img/sharp-libvips-*` at version `1.3.3` declare `LGPL-3.0-or-later` but omit a standalone, conventionally named license or notice file from their npm archives. They are installed as optional dependencies of the Node image stack and are not distributed in the browser extension. The generated bundle identifies them as excluded, a lockfile regression requires every platform coordinate to remain covered, and release verification rejects native shared libraries and Node addons from the extension.

The extension also contains one WebLLM executable model library:

- file: `SmolLM2-360M-Instruct-q4f16_1_cs1k-webgpu.wasm`;
- source repository: `mlc-ai/binary-mlc-llm-libs`;
- immutable source revision: `025bcaf3780fa8254f5e5efd3bfea0a5397248f4`;
- SHA-256: `5c20098605780550c40e9c64d288dd6e369707a08d4133037156019b064ad41b`;
- reviewed executable license basis: the binary repository has no independent license file, but its upstream build pull request identifies Apache TVM commit `bc1a904ec1ad89454ee6577d66cde1268b8f6bc8` and MLC-LLM commit `2008fe8343e1f40ef89ee57b9287aebcf1b86c98` as the exact compiler sources; both revisions declare Apache-2.0 and their notices are retained in `third_party/licenses/model-library-NOTICE.txt`;
- reviewed model license basis: Apache-2.0 from the immutable SmolLM2 base-model revision recorded in `models/registry.json`.

Model weights are not stored in Git or in the extension ZIP. After explicit consent, the runtime downloads the pinned conversion repository data into browser-managed storage. The base model and conversion metadata are inventoried in `models/registry.json` and `models/licenses/README.md`; those files describe the conversion repository's missing independent license field without treating it as a new license grant.

The production workbench also bundles `ort-wasm-simd-threaded.asyncify.wasm` from lockfile-pinned `onnxruntime-web@1.31.0-dev.20260914-8d85527a0` for local MiniLM inference. The reviewed file is 26,861,777 bytes with SHA-256 `49871f5a4409519797e127440868a6d1923339d9185907f301a5b2a1d90af082`, built from ONNX Runtime commit `8d85527a010e294a26b274749f74294b2a32cec5` and distributed under MIT. Build verification rejects any other workbench WASM executable.

The CycloneDX SBOM records installed production package license expressions and a separate hashed component for the bundled executable model library. The lockfile remains the authoritative dependency resolution record.
