# Vanilla local search example

This browser example shows the encrypted memory API without React. It creates a local vault and workspace, imports either three labeled synthetic notes or a selected `.txt`/`.md` file, and performs source-backed lexical search. An optional reviewed MiniLM download adds embeddings for new imports and hybrid ranking.

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm dev:example:search
```

Open the printed Vite URL. Use a throwaway passphrase of at least 12 characters, choose **Create vault**, then choose **Load synthetic notes**. Search for `revised delivery date` and inspect the cited passage.

No online fallback exists. The optional embedding button has a review step before download and exposes cancellation. Installing the model does not retroactively embed existing records; unlock the vault and import again after the runtime is ready.

The example accepts only `.txt` and `.md` files up to the shared 20 MiB document limit. Do not use private data while learning or filing issues.

Relevant packages:

- `@browser-cortex/memory`
- `@browser-cortex/core`
- `@browser-cortex/runtime-transformers`
