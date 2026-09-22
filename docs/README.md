# BrowserCortex documentation

Choose the shortest path that matches what you want to do.

## Use BrowserCortex

- [Getting started](getting-started.md): plain-language workbench and extension walkthrough.
- [Troubleshooting](troubleshooting.md): setup, browser, model, vault, and extension problems.
- [Privacy](privacy.md): what stays local, what can use the network, and what the protections do not cover.
- [Permissions](permissions.md): grants, approvals, and why pages or models cannot approve themselves.
- [Offline behavior](offline.md): expected behavior without a network connection.
- [Model installation](model-installation.md): consent, downloads, storage, integrity, and cleanup.
- [Browser support](browser-support.md): measured and unverified environments.
- [Compatibility](compatibility.md): pinned runtimes, model revisions, and evidence boundaries.

## Build with BrowserCortex

- [Technical guide](technical-guide.md): architecture, data flow, package relationships, lifecycle, and extension boundaries.
- [Package map](packages.md): what each workspace package owns and where to find its public entry point.
- [SDK guide](sdk.md): create and use the core lifecycle.
- [Workflow format](workflow-format.md): finite operations, validation, capabilities, and approval.
- [Adapter authoring](adapter-authoring.md): add a local or optional online runtime safely.
- [Architecture](architecture.md): concise trust-flow reference.
- [Threat model](threat-model.md): assets, adversaries, controls, and residual risk.
- [Security review](security-review.md): reviewed boundaries and release-blocking failure classes.

## Understand project decisions

The [decision records](decisions/) explain package management, generation, embeddings, vault cryptography, extension hosting, workflows, and online connectors. [Project history](project-history.md) summarizes the beta milestones without the internal build diary. [Roadmap](roadmap.md) separates supported beta work from research.

## Contribute or get help

- [Contributing](../CONTRIBUTING.md)
- [Support](../SUPPORT.md)
- [Security policy](../SECURITY.md)
- [Code of conduct](../CODE_OF_CONDUCT.md)
- [Release process](release.md)

## Documentation conventions

Examples use synthetic data and reserved domains. A guide says explicitly when a command downloads dependencies, browser binaries, or model data. Claims marked measured refer only to the linked environment; an available API or successful mock is not treated as proof that a real browser model ran.
