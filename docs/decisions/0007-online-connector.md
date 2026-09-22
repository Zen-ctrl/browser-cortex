# ADR 0007: Optional developer-owned online connector

Status: accepted as optional and disabled by default.

The browser SDK never stores a provider credential. One egress broker accepts an opaque trusted approval bound to the exact payload, endpoint, model, source revisions, and policy version. The example server fixes its upstream URL and model, requires authentication, restricts Origin and Host, caps data, refuses redirects, and scrubs logs.

Firebase and a hosted database are unnecessary. Loopback alone is not authentication. No public gateway deployment is part of this build.

