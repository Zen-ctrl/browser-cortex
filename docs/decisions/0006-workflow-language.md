# ADR 0006: Finite declarative workflows

Status: accepted.

Use versioned JSON with a finite operation vocabulary and typed expression AST. Perform independent schema, reference, dependency, capability, resource, and fingerprint passes before execution. The interpreter dispatches only packaged trusted implementations.

Generated JavaScript, dynamic functions, shell commands, arbitrary URL fetches, remote schema references, recursion, and unbounded loops are excluded. A less flexible language makes workflows inspectable and lets deterministic validation own security boundaries.

