This page is for extension authors who need the typed cross-extension service contract.

## Cross-extension integration

Other Pi extensions can import the protocol-v1 contract from
`@centerforagenticai/pi-context-aware/context-service` and discover the session-scoped service over
Pi's shared `pi.events` bus. It returns typed point-in-time pressure/lineage
snapshots and metadata-only artifact references, and can request the same
seeded compaction/handoff pipeline used by `compact_session`.

See [context-service.md](context-service.md) for discovery, request/response
shapes, lifecycle events, bounds, non-interactive behavior, cancellation,
conflict handling, provenance, and versioning.

Model-facing `<context-telemetry>` envelopes, historical `[ctx ...]` markers,
status text, prompt cache blocks, and `Prior transcript:` lines are **not** an
integration API. Consumers must not parse them.

