# Roadmap

BrowserCortex currently focuses on local search, bounded extraction, deterministic data workflows, explicit page capture, and exact online disclosure. Broader claims require separate evidence.

## Good first contributions

- Reproduce the setup on another supported Chrome or Chromium environment and report compatibility results.
- Add focused examples that use synthetic or public data.
- Improve accessibility, keyboard navigation, and plain-language error messages.
- Expand test fixtures for hostile page content, disclosure review, cancellation, and recovery.

## Near-term engineering

- Harden the offscreen runtime host and extension lifecycle recovery.
- Improve compact-model prompts and deterministic validation around unsupported answers.
- Add measured browser compatibility beyond the currently verified environment.
- Document and test additional vetted online integrations without changing the local-first default.

## Research directions

- A measured compact router and planner distillation on synthetic validated plans.
- A versioned WebMCP compatibility adapter.
- Optional vision or audio tasks with explicit permission and resource budgets.
- Bounded local suggestions that remain subordinate to deterministic policy.

Roadmap items are not production support claims. Permission rules remain deterministic even if a learned component improves routing or planning. Open an issue before beginning a large change so contributors can align on scope.
