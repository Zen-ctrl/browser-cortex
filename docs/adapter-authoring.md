# Runtime adapter authoring

A runtime adapter advertises only tested capabilities and implements explicit load, run, abort, unload, and dispose behavior. Embedding and generation are separate interfaces so applications can avoid a generation dependency.

Adapters must:

- validate every public request and cap input, output, and message sizes;
- report immutable model and runtime identifiers where available;
- accept `AbortSignal` and prevent late events from reaching another request;
- return stable safe error codes without prompt or secret content;
- keep model output separate from execution authority;
- document cache ownership and cleanup;
- expose progress for user-initiated installation;
- report unavailable capabilities rather than silently choosing an online route.

Extension builds must package executable runtime files locally and work under the production extension CSP. Remote weights can be treated as reviewed data only after consent and integrity validation supported by the runtime's registry.

