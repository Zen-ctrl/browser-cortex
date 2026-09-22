# Getting started

This guide assumes you are comfortable copying commands into a terminal, but it does not assume AI or TypeScript experience.

BrowserCortex is distributed from source and as a developer-mode Chromium extension. There is no hosted account or browser-store installation.

## A few terms first

- **Vault:** encrypted browser storage for sources, grants, workflows, and detailed receipts.
- **Source:** a file or selected page text that you deliberately add.
- **Grant:** temporary permission for one part of the application to use a source.
- **Workflow:** a small, finite set of known data operations, not arbitrary code.
- **Approval:** one-time permission bound to the exact content and destination you reviewed.
- **Local model:** optional model data downloaded into browser-managed storage after consent.

## Install the workbench from source

Install these first:

1. [Git](https://git-scm.com/downloads)
2. [Node.js](https://nodejs.org/) version 22 or newer
3. A current Chromium browser such as Chrome or Edge

Then open a terminal and run:

```bash
git clone https://github.com/Zen-ctrl/browser-cortex.git
cd browser-cortex
corepack enable
pnpm install --frozen-lockfile
pnpm doctor
pnpm dev
```

`pnpm install` downloads JavaScript development dependencies. It does not download the optional AI models. `pnpm doctor` performs local tool checks and intentionally omits account names, home paths, exact OS builds, and exact disk capacity.

Open the local URL printed in the terminal, usually `http://localhost:4173`.

## Complete the first-run screens

1. Read **Nothing leaves by default**, then choose **Continue**.
2. Read the optional-model explanation. Choose **Continue** without installing anything.
3. On **Encrypted vault or temporary mode**, choose **Set up encrypted vault**.
4. Enter a passphrase with at least 12 characters and choose **Create vault**.

The passphrase never goes to a recovery server. If you lose it, the project cannot restore the vault. For a first test, use a throwaway passphrase and synthetic data rather than an important document.

## Add a safe sample and search it

Create a file named `synthetic-note.txt` with this content:

```text
Synthetic delivery note DEMO-18
The revised delivery date is 2026-10-14.
This file contains no real customer information.
```

In the workbench:

1. Open **Memory**.
2. Choose **Import source** and select `synthetic-note.txt`.
3. In **Search query**, enter `revised delivery date`.
4. Choose **Search encrypted memory**.
5. Open the result and confirm that it cites `synthetic-note.txt`.

This first search is lexical and does not need a model. The source text and derived records are encrypted at rest in the browser origin after import.

## Try a reviewed workflow

1. Open **Workflows**.
2. Leave the built-in synthetic CSV and instruction unchanged.
3. Choose **Compile plan**.
4. Inspect the generated finite workflow JSON.
5. Choose **Deterministic dry run** to see receipts without exporting.
6. Choose **Review exact export**.
7. Inspect the filename, row count, SHA-256 value, and every output row.
8. Choose **Approve these exact rows once**.
9. Download the prepared file only if the preview is correct.

Editing the CSV or workflow invalidates the old preview and approval. The workflow language cannot contain JavaScript, shell commands, recursion, or unbounded loops.

## Back up, lock, or delete the vault

On **Memory**, use **Preview export** before downloading an encrypted archive. The archive remains encrypted and still needs its passphrase.

Choose **Lock now** whenever you finish. Locking removes the decrypted key from application state and hides private views.

To remove local data, open **Settings**, choose **Preview vault deletion**, read the deletion boundary, then confirm. Model caches are separate and must be reviewed on **Models**. Browser storage APIs cannot prove physical memory zeroization, and an exported file cannot be remotely revoked.

## Install an optional local model

Open **Models**. Merely opening the page downloads nothing.

Each model card shows its task, immutable revision, source hosts, known reviewed bytes, license, device, and cache limitations. Choose **Review installation**, inspect the disclosure, then confirm only if you accept the network and storage use.

Use MiniLM embeddings to add semantic ranking to new imports. SmolLM2 generation needs compatible WebGPU and remains experimental. A model that loads successfully can still produce a wrong answer, so BrowserCortex keeps source support, schemas, policy, and approvals outside the model.

## Install the Chromium extension

### Verify the download

Download the ZIP and adjacent `.sha256` file from the [beta release](https://github.com/Zen-ctrl/browser-cortex/releases/tag/v0.3.0-beta.1).

On PowerShell:

```powershell
Get-FileHash -Algorithm SHA256 .\browser-cortex-extension-v0.3.0-beta.1.zip
Get-Content .\browser-cortex-extension-v0.3.0-beta.1.zip.sha256
```

On macOS or Linux:

```bash
sha256sum browser-cortex-extension-v0.3.0-beta.1.zip
cat browser-cortex-extension-v0.3.0-beta.1.zip.sha256
```

The two 64-character hashes must match. If they do not, stop and delete the download.

### Load the extension

1. Extract the verified ZIP.
2. Open `chrome://extensions` in Chrome or a compatible Chromium browser.
3. Turn on **Developer mode**.
4. Choose **Load unpacked**.
5. Select the extracted directory containing `manifest.json`.
6. Pin BrowserCortex if you want quick access to its side panel.

To try the documented capture flow safely, start the synthetic demo in another terminal:

```bash
pnpm dev:demo
```

Open the printed demo URL. In the BrowserCortex panel, use **Context** and **Review visible content** before saving anything. Create a separate extension vault, review the capture, and choose **Save reviewed capture**. The page itself cannot browse the vault or approve an action.

## What can use the network?

| Action | Network behavior |
| --- | --- |
| Lexical search, encrypted memory, deterministic workflows | Local only |
| Initial `pnpm install` and browser test setup | Downloads development dependencies |
| Optional model installation | Contacts only the disclosed reviewed model hosts after confirmation |
| Optional online gateway | Sends the exact approved payload to the configured endpoint |
| Local model or workflow failure | Stops visibly; never triggers cloud fallback |

## Next steps

- Read [Privacy](privacy.md) before using non-synthetic information.
- Read [Troubleshooting](troubleshooting.md) if a command, vault, browser, or model step fails.
- Read the [Technical guide](technical-guide.md) if you want to build with the packages.
