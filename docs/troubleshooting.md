# Troubleshooting

## `pnpm` is missing or the version is wrong

BrowserCortex expects Node.js 22 or newer and pnpm 10.15.0.

```bash
node --version
corepack enable
corepack prepare pnpm@10.15.0 --activate
pnpm --version
```

Run `pnpm doctor` again. Its report is designed for public support requests and omits account names, absolute paths, exact OS builds, and exact disk capacity.

## Installation fails

Use the lockfile exactly:

```bash
pnpm install --frozen-lockfile
```

Do not delete the lockfile or switch package managers. If native optional packages fail on an unsupported platform, include the platform family, Node version, pnpm version, and the smallest relevant error excerpt in an issue. Remove home paths and account names first.

## A development port is already in use

Stop the older Vite process or use the URL printed by the new process. The synthetic extension demo must use its reviewed port 4174. If port 4173 is already used by an unrelated local app, choose another workbench test port:

```powershell
$env:BROWSER_CORTEX_E2E_WORKBENCH_PORT = '4273'
pnpm test:e2e
```

```bash
BROWSER_CORTEX_E2E_WORKBENCH_PORT=4273 pnpm test:e2e
```

## The workbench opens but search is unavailable

Lexical search needs an unlocked vault and at least one imported source. Open **Memory**, create or unlock the vault, import a supported file, enter a query, and choose **Search encrypted memory**.

Semantic ranking applies only to imports created while the compatible embedding adapter is loaded. Existing lexical records are not silently rewritten.

## I lost the vault passphrase

There is no recovery server or maintainer override. Preserve any encrypted export and browser profile if you may remember the passphrase later. Deleting the vault is permanent for that browser origin. Do not send a real vault export to an issue or maintainer.

## The vault is in recovery mode

Stop and preserve the browser profile before destructive cleanup. Use **Retry vault inspection** first. An unreadable header cannot be exported as a verified archive. If reporting a bug, reproduce with a synthetic vault whenever possible.

## WebGPU is unavailable

Use reduced mode. Encrypted memory, lexical search, privacy checks, and deterministic workflows still work. Generation requires a compatible WebGPU implementation; the presence of `navigator.gpu` alone does not prove that the pinned model can load.

Check the browser's GPU diagnostics, update the browser and graphics driver through trusted vendor channels, then retry with no unrelated GPU-heavy applications. Do not disable browser security features to make a model run.

## A model download or load fails

1. Confirm that you approved the exact model and host disclosure.
2. Confirm enough browser storage is available.
3. Keep the panel or workbench visible while the documented runtime owns the task.
4. Cancel, unload, and retry once.
5. Use the cache review UI before deleting runtime-managed caches.

A failure never triggers an online fallback. Model weights and tokenizer/configuration files are managed by the browser runtime and can be larger than the reviewed headline bytes.

## The extension does not appear or reload

Build first:

```bash
pnpm build
```

In `chrome://extensions`, remove an obsolete unpacked copy, choose **Load unpacked**, and select `apps/extension/dist`. After a rebuild, choose the extension's reload button. Refresh the test page because document-bound sessions intentionally expire on navigation or extension replacement.

## Capture or replay is denied

General websites are not supported for action recording. Only the bundled synthetic demo contract is eligible. Start it with `pnpm dev:demo`, open the printed loopback URL, then create a fresh reviewed context in the extension panel.

Drift, a changed document, a replaced frame, an expired grant, or a changed action argument stops execution. That is expected safety behavior.

## Browser tests fail

Install the reviewed browser runtime:

```bash
pnpm exec playwright install chromium
pnpm test:e2e
```

On Linux CI-like systems, Playwright may need operating-system dependencies. Use `pnpm exec playwright install --with-deps chromium` only on a machine where you are authorized to install them.

## Windows reports a path-length problem

Clone near the top of a drive into a short directory name. Do not move only part of the monorepo because workspace links depend on the root layout.

## Offline behavior is surprising

An installed application shell, unlocked vault, deterministic workflow, and cached model can work without the network. A first dependency install, first browser install, or uncached model installation cannot. Read [Offline behavior](offline.md) for the exact boundary.

## I need more help

Use the route in [SUPPORT.md](../SUPPORT.md). Share synthetic reproduction data and the smallest useful output. Never share credentials, private documents, a browser profile, a vault export, a model prompt containing personal data, or an unsanitized diagnostics bundle.
