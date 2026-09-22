# Project history

BrowserCortex was built in three beta milestones and then prepared for open collaboration. This page summarizes the useful technical history without retaining the internal publication diary.

## Foundation

The first milestone established the strict TypeScript workspace, versioned contracts, deterministic router and lifecycle, default-deny policy, privacy helpers, encrypted vault, source-backed retrieval, finite workflows, workbench, model adapter boundaries, synthetic fixtures, and offline behavior.

## Chromium extension

The second milestone added the MV3 extension, explicit selected-content capture, an extension-origin vault, browser-verified document sessions, narrow messages, reviewed synthetic actions, restart-aware state, bounded undo, and demo-only recording and replay.

## Evaluation and release hardening

The third milestone added the optional exact-disclosure gateway path, 600-case deterministic corpus, trusted real-model runner, production browser tests, adversarial security and offline suites, deterministic extension packaging, build provenance, a CycloneDX SBOM, license inventories, release screenshots, and public-data checks.

The vault later gained a transactional encrypted schema v1 to v2 migration with retained-ciphertext rollback and restart recovery. The generation runtime gained immediate cancellation around stalled async streams and fresh-worker recovery after abort or failure.

## Public collaboration preparation

The public source tree removed owner-specific publication machinery and stale build-diary records, added audience-based documentation, sanitized diagnostic defaults, added a public-readiness gate, and separated public evidence from detailed private host diagnostics. The original private development history is not required to use or contribute to the public source.

## Evidence boundary

The beta acceptance suite passed unit, security, offline, extension, browser, packaging, SBOM, and synthetic benchmark gates. Real MiniLM and SmolLM2 adapters executed on a reviewed local environment. MiniLM passed its fixed retrieval probes. SmolLM2 passed streaming, schema, cancellation, recovery, and exact-marker checks but failed the small semantic-correctness and missing-fact-abstention probes. Generation therefore remains experimental.

See [CHANGELOG](../CHANGELOG.md), [Compatibility](compatibility.md), and the GitHub release for version-specific evidence. A source file or test definition is not by itself proof that a real external service, model, browser, or store operation succeeded.
