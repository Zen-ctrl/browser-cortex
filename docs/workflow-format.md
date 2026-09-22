# Workflow format

BrowserCortex workflows are finite JSON programs interpreted by trusted operations. They never contain JavaScript, shell commands, arbitrary functions, recursive calls, or unbounded loops.

A workflow includes a schema version, ID, semantic version, name, typed input and output descriptions, origin scope, capabilities, source dependencies, tool-version dependencies, limits, and ordered steps. A step has a stable ID, one known operation, bounded input references, optional output name, timeout, failure policy, and validation rules.

The initial operations are `source.select`, `csv.parse`, `rows.filter`, `rows.sort`, `rows.project`, `rows.aggregate`, `records.compare`, `memory.search`, `text.extract`, `draft.create`, `preview.show`, `approval.require`, `tool.invoke`, and `file.export`.

Validation performs six passes:

1. Parse and validate the versioned schema.
2. Resolve types and backward-only references.
3. Resolve source and trusted tool dependencies.
4. Derive capabilities and effect risk from trusted operation definitions.
5. Enforce step, row, time, output, and nesting limits.
6. Produce a canonical plan fingerprint and preview.

Currency uses safe integer minor units or canonical decimal strings. A monetary aggregate declares a currency guard with an ISO-style three-letter currency field and a currency output; mixed currencies stop the operation instead of being silently combined. Aggregate results remain numbers only when they are safe integers; fractional or larger exact results are canonical decimal strings instead of rounded binary floats. Sorts use a fixed `en` primitive collation by default, exact Decimal comparison with `mode: "decimal"`, or canonical `YYYY-MM-DD` calendar comparison with `mode: "iso-date"`. Date-like values are rejected unless the date mode is declared. CSV export protects formula-like cells and reports escapes. An embedded `approval.require` step requests approval from the broker; it never approves itself.
