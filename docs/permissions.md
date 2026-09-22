# Permissions and approvals

BrowserCortex uses default-deny capabilities. A capability identifies the subject, workspace, source or tool, operation, parameter restrictions, recipient, tool version, expiry, usage limit, and revocation state. A read grant is never an online-disclosure grant, and a local draft grant is never permission to publish.

The Chromium extension owns cross-site approval UI. Page dialogs, page text, imported workflows, model output, and messages containing `approved: true` cannot authorize a privileged action. The SDK requires an embedding application to supply a trusted review surface and cannot protect data from that application's own same-origin code.

Approval handles are opaque, short-lived, and bound to a canonical fingerprint of the exact parameters, destination, model, source revisions, and policy version. A change invalidates the approval. Non-idempotent work that times out is recorded as `outcome-unknown` and is not retried automatically.

Default action approvals expire after five minutes and are one-use. Extension document grants also end after navigation, document replacement, explicit revocation, or 30 minutes of inactivity.

