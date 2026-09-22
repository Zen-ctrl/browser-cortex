# Release process

BrowserCortex publishes public source and developer extension artifacts. It does not currently publish npm packages, submit to a browser store, or operate a public model gateway.

Release work is maintainer-only because it changes tags, public assets, and repository settings.

## Required gates

1. Start from a clean `main` commit and a frozen lockfile install.
2. Run `pnpm verify:acceptance` and retain the actual result.
3. Run the pinned Gitleaks scanner over reachable history, index, worktree, release outputs, and archives.
4. Run `pnpm verify:real-model` only on a trusted local device after reviewing the downloads.
5. Rebuild the trusted release from a clean checkout and verify deterministic archive identity.
6. Run `pnpm release:public` to sanitize public evidence. Preserve compatibility-class facts and results, but remove home paths, machine names, account identifiers, exact host fingerprints, private prompts, credentials, and run-specific local identifiers.
7. Package the extension, checksum, build provenance, compatibility record, CycloneDX SBOM, benchmark summaries, screenshots, licenses, notices, and final limitations report.
8. Create a draft prerelease, download every asset, and compare its SHA-256 with the staged source.
9. Publish only after CI succeeds on the exact tag commit and public-data review passes.

## Public evidence rules

- A simulated runtime proves a contract only, not real inference.
- Schema validity is not semantic correctness.
- A successful request is not proof that an external action was confirmed.
- Report environment classes needed to understand compatibility, not a unique personal-host inventory.
- Use synthetic inputs and reserved domains.
- Never attach raw browser profiles, vault exports, model prompts containing private data, environment files, or unsanitized logs.

## Extension distribution

The ZIP is a developer-mode unpacked extension until a browser store separately reviews and signs it. Release notes and compatibility metadata must say `browserStoreApproved: false` until that external event actually occurs.

## Hosted services

Repository visibility does not authorize a hosted gateway, domain purchase, paid service, analytics, or automatic deployment. Any future hosted demo must have an explicit owner, documented data boundary, public privacy statement, and separate deployment review.
