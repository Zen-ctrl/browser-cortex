# Security boundary review

This is a source and regression review, not a formal third-party security audit.

## Reviewed boundaries

- Authority remains in deterministic grant, approval, and execution brokers rather than model or page text.
- Extension sessions bind to browser-verified document context and expire on navigation or replacement.
- Online disclosures bind exact bytes, endpoint, destination, model, sources, and policy, and are one-use.
- Vault lock clears decrypted application state and cancels pending private work.
- Storage migration retains authenticated ciphertext for rollback and verifies the reopened migrated vault.
- Workflow operations are finite, typed, capability-derived, timeout-bound, and unable to execute generated code.
- Potentially ambiguous non-idempotent writes are not retried automatically or reported as confirmed success.
- The example gateway enforces authentication, fixed destinations, Origin and Host restrictions, size limits, timeouts, bounded redirects, and scrubbed logging.
- Extension executable code and model-library WASM are packaged locally under the reviewed CSP.
- Release tooling binds source and archive provenance, inventories dependencies, checks licenses, scans secrets, and checks public-data hygiene.

## Remediated high findings

| Finding | Resolution | Regression focus |
| --- | --- | --- |
| Auto-lock could leave rendered plaintext or active private work reachable | Lock events cancel scheduled/runtime work, clear private view state and session secrets, and remount private pages | Lock during retrieval, model work, workflow review, disclosure review, and citation display |
| Workflow step timeouts were descriptive | Real deadline races now stop the run and discard late results | Pure steps, keyed writes, non-idempotent writes, cancellation, and late resolution |
| Interrupted writes could be retried or described too confidently | Durable pre-dispatch markers, stable idempotency keys, and `outcome-unknown` handling separate safe recovery from unsafe retry | Restart before, during, and after dispatch plus timeout boundaries |

No critical issue was reported in the source-review pass. Passing tests reduce known risk but do not prove the absence of vulnerabilities.

## Release-blocking classes

Any reproduced unauthorized disclosure, arbitrary code execution, unapproved write, stale approval acceptance, plaintext private persistence, silent online fallback, remote executable extension code, or automatic retry of an ambiguous non-idempotent write blocks a release.

## Residual limitations

- Encryption at rest cannot protect an unlocked vault from malicious same-origin code or a compromised browser, extension, or operating system.
- Browser storage can be evicted, and browser APIs cannot prove physical memory zeroization.
- A visited page can perform its own network requests. BrowserCortex controls only BrowserCortex transports.
- Sensitive-data detection can miss identifying context and cannot guarantee anonymity.
- Runtime-managed model caches have weaker independent byte-integrity evidence than packaged executable assets.
- Model correctness is separate from successful loading and schema validity.
- The optional gateway is reference code, not a hosted public service, and no general provider compatibility is claimed.

Report a suspected vulnerability using [SECURITY.md](../SECURITY.md).
