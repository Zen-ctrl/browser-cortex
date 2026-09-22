# Offline behavior

The application shell, deterministic workflow tools, encrypted vault, and lexical search can operate without internet access after the static application is loaded. A local model works offline only after its complete runtime and data assets have been installed and verified.

A first offline run with no installed model reports `MODEL_NOT_INSTALLED`. A partial cache is not treated as an installation. Browser storage can be evicted, private mode can behave differently, and a service-worker cache is not a durable backup.

BrowserCortex never changes an online policy from `deny` after a local failure. It either uses a supported local route, offers a deterministic alternative, or reports that the requested task is unavailable.

The application shell does not cache private prompts, documents, or online responses as unencrypted HTTP responses. Encrypted vault records remain in their origin-scoped IndexedDB store.

