# Real-model trusted runner

This harness is the separate, hardware-backed verification path for the pinned embedding and generation adapters. It is not part of pull-request CI because untrusted fork code must not receive access to a maintainer browser or GPU.

Run it from the repository root:

```sh
pnpm verify:real-model
```

The trusted runner opens the installed stable Google Chrome `chrome` channel headfully in a fresh isolated profile under the operating-system temporary directory; channel and headless overrides are intentionally not accepted. A same-origin put, match, and delete preflight verifies CacheStorage before model work begins. The runner presents the model hosts, immutable revisions, licenses, and reviewed byte counts before the automation activates the explicit consent button. Inputs are synthetic. The page runs a true empty-profile cold load followed by same-profile warm embedding retrieval and WebGPU generation. Each phase records 20 inference samples and nearest-rank p50/p95 latency. It then runs three embedding retrieval probes, two generation probes, an in-flight generation cancellation after the first token, and an exact-marker recovery. Stage and five-sample progress is emitted to the runner console, and the complete browser phase has a 45-minute bound before writing:

- `benchmarks/reports/real-model/latest.json`
- `benchmarks/reports/real-model/latest.md`

The version 3 JSON envelope records the browser, operating system, CPU, browser-visible memory and GPU data, runtime and model revisions, before/after origin storage estimates and cache inventories, raw latency samples, recomputed percentiles, actual outputs, cancellation observations, and any failure. A passed report gates real adapter execution, calibrated deterministic marker reproduction, generation schema validity, cancellation and recovery, and embedding retrieval. Generation semantic correctness and missing-fact abstention are report-only measurements, not release pass criteria. It also carries a unique invocation ID and names the exact extension ZIP, production build manifest, source tree, and hashes that it accompanies. Reports older than 24 hours are rejected by the trusted-release gate. The gate recomputes probe results and percentiles from raw observations rather than accepting summary flags. A missing browser capability is reported as unverified or failed; it is never replaced with a mock result.

The evidence scope is `adapter-runtime`: the harness runs the production MiniLM and SmolLM2 adapters in a fresh Chrome profile and binds that observation to the candidate package. The separate extension E2E suite covers the packaged MV3 panel, service worker, content-script, CSP, and lifecycle integration. The adapter report does not claim that model inference itself happened inside the extension service worker. Its fixed synthetic probes are regression checks, not a general quality, safety, factuality, or privacy evaluation. Cancellation evidence covers in-flight generation and post-cancel recovery only; embedding and installation cancellation remain outside this run.

Model data is fetched from the pinned Hugging Face revisions after consent. The WebLLM executable model library is served from the verified vendored file. The temporary profile retains model data only long enough to measure the warm pass and is removed after Chrome closes. It never opens or copies the user's normal browser profile, workbench vault, or extension vault. Browser storage values are origin estimates, not a byte-exact asset audit. GPU memory, process memory, energy, network cost, and monetary savings are not measured.
