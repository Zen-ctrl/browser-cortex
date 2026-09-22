# ADR 0005: Panel-owned inference

Status: accepted.

The visible side panel owns the model worker while it is open. The Manifest V3 service worker remains a lightweight permission, session, and message broker whose state can be reconstructed after termination. Closing the panel cancels or pauses local inference and saves a truthful checkpoint.

Artificial keepalive traffic and an offscreen document are not used. A future offscreen host requires a legitimate supported API reason, lifecycle tests, CSP review, and a new decision record.

