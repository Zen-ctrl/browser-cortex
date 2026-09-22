# Release outputs

`pnpm package:extension` writes the deterministic developer extension ZIP and its SHA-256 file here. `pnpm sbom` writes a CycloneDX 1.6 production dependency inventory. Generated release outputs are intentionally ignored by Git and may be attached to a matching GitHub release only after verification and public-data review.

After the acceptance and real-model reports are bound to the clean release commit, `pnpm release:public` creates the sanitized upload set in `release/public-assets`. It refuses a dirty tree or mismatched report, archive, provenance, or commit.

The extension archive is developer distribution. It is not evidence of a Chrome Web Store review or publication. Public assets must not contain home paths, personal contact details, machine names, credentials, private prompts, or unnecessarily identifying host metadata.
