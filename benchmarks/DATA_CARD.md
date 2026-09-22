# BrowserCortex synthetic evaluation corpus

The generator in `fixtures/generate.ts` creates 600 deterministic cases: 100 retrieval, 150 extraction, 100 routing, 100 workflow, 100 privacy, and 50 adversarial cases.

All cases are synthetic and use reserved demonstration identifiers. They are not copied from browser history, customer files, messages, or private work material. Every record carries a category, deterministic ID, expected result, held-out group, and `synthetic: true` marker.

The corpus checks contracts and bounded product behavior. It does not establish general model quality, universal sensitive-data detection, or safety on arbitrary websites. The trusted real-model runner also carries a deliberately small, fixed synthetic regression set for actual MiniLM retrieval plus SmolLM2 extraction and missing-fact abstention. Its pass status gates real execution, a calibrated deterministic marker, exact output schema, cancellation and recovery, and embedding retrieval. SmolLM2 semantic correctness and missing-fact abstention are measured and reported rather than used as release pass criteria. Real-model reports must record the exact model revision, runtime, browser, operating system, hardware, storage estimate, raw latency samples, and observed result. Simulated runtime output is never real inference evidence.

Prompt-development and held-out use should be separated by `heldOutGroup`. A report must state which groups were used during development. Difficult or failing cases must not be removed without a documented reason.
