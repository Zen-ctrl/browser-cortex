# React workflow review example

This example demonstrates a reviewed deterministic CSV workflow in React. It validates a finite five-step plan, previews the exact non-US rows, fingerprints the plan and inputs, requests one-use approval, and dispatches through the workflow interpreter.

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm dev:example:workflow
```

Open the printed Vite URL and follow the screen from **Validate with workflow package** to **Approve exact plan** and **Run approved workflow**.

All rows are synthetic. There is no model, provider, account, or network request in the workflow. The example illustrates the separation between plan data, validation, preview, approval, and execution. It is not a general code runner.

Relevant package: `@browser-cortex/workflows`.
