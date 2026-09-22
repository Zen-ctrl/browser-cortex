# Browser and model support

Support is evidence-based. An API appearing in a browser is not enough to prove that storage, workers, CSP, model loading, inference, and cancellation work together.

| Environment | Workbench | Extension | Embeddings | Generation | Evidence boundary |
| --- | --- | --- | --- | --- | --- |
| Chrome 153 on Windows 11 | Beta tested | MV3 browser flows tested | Real adapter run on WASM | Real adapter run on NVIDIA WebGPU | One sanitized local test class plus production E2E |
| Playwright Chromium on GitHub-hosted Linux | Production build and E2E | Unpacked extension E2E | Contract/simulated tests | Contract/simulated tests | CI, not real-model evidence |
| Other Chromium 116+ | Expected beta target | Manifest minimum | Unverified per device | Unverified per device | Community reports welcome |
| Firefox | Unverified | Unsupported MV3 target | Unverified | Unverified | Not claimed |
| Safari | Unverified | Unsupported MV3 target | Unverified | Unverified | Not claimed |
| Mobile browsers | Unverified | Unsupported | Unverified | Unverified | Not claimed |

The real-model evidence was intentionally sanitized for public release. It preserves browser family/version, operating-system family, runtime class, device class, model revisions, output, timing, cancellation, and quality results while omitting exact CPU, GPU device identifier, memory capacity, OS build, storage quota, local paths, and run-specific identifiers.

Reduced mode keeps deterministic transforms, privacy checks, workflows, and lexical search available. Generation is reported unavailable when a compatible WebGPU runtime cannot be acquired. CPU or WASM embeddings are used only when the selected Transformers.js model and current browser support that path.

A community compatibility report should include the BrowserCortex commit, browser name and version, operating-system family, broad hardware class, model/runtime revision, cold or warm state, exact stage that failed, and synthetic reproduction. Remove machine names, account identifiers, home paths, exact storage inventories, and private prompts.
