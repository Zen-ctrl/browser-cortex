# SDK guide

The SDK composes independent memory, runtime, policy, workflow, and transport adapters. Importing deterministic code does not initialize a model or open a network connection.

```ts
import { createCortex } from '@browser-cortex/core';

const cortex = createCortex({
  // A host application computes this environment from trusted policy,
  // grants, source revisions, and runtime state. Source text is never policy.
  routeEnvironment: () => ({
    policyVersion: 'example-v1',
    policyAllowed: true,
    deterministicTasks: ['transform'],
    local: { available: false, supportedTasks: [] },
    online: {
      configured: false,
      explicitlyRequested: false,
      approvedForSources: false,
      supportedTasks: [],
    },
  }),
  deterministicExecutors: {
    transform: async (request, signal) => {
      signal.throwIfAborted();
      return { reviewedInput: request.input };
    },
  },
});

await cortex.initialize();

const controller = new AbortController();
const proposal = await cortex.propose({
  schemaVersion: 1,
  requestId: crypto.randomUUID(),
  task: 'transform',
  input: 'Show non-US orders and prepare a reviewed export.',
  sourceIds: ['synthetic-orders-v1'],
  workspaceId: 'demo-workspace',
  onlinePolicy: 'deny'
}, controller.signal);

console.log(proposal.route.reasonCodes);
const result = await cortex.execute(proposal, controller.signal);
console.log(result.output);
await cortex.dispose();
```

`createCortex` is side-effect free and returns a new lifecycle object. Call `initialize` explicitly; core initialization itself downloads no model and opens no transport. Vault unlock, model installation, model load, proposal, approval, execution, cancellation, and disposal remain separate calls. Use `GrantStore` and `evaluateCapability` from `@browser-cortex/policy` in trusted host code before setting `policyAllowed`; neither model output nor page content can create authority. The extension bridge is also a separate adapter. Applications must continue to handle missing, denied, disconnected, or locked extension states.

The in-page SDK cannot protect data from hostile same-origin application code. Cross-site memory belongs in the extension's separate trusted origin and is exposed only through narrow operations.
