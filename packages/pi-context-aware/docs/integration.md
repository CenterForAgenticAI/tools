This page is for extension authors who need the typed cross-extension service contract.

## Cross-extension integration

Other Pi extensions can import the protocol-v1 contract from
`@centerforagenticai/pi-context-aware/context-service` and discover the session-scoped service over
Pi's shared `pi.events` bus. It returns typed point-in-time pressure/lineage
snapshots and metadata-only artifact references, and can request the same
seeded compaction/handoff pipeline used by `context_compact`.

See [context-service.md](context-service.md) for discovery, request/response
shapes, lifecycle events, bounds, non-interactive behavior, cancellation,
conflict handling, provenance, and versioning.

The model-facing pressure action line, historical `[ctx ...]` markers,
status text, prompt cache blocks, and `Prior transcript:` lines are **not** an
integration API. Consumers must not parse them.

## Fabric foreground check

In pi-fabric's full code mode the model sees only `fabric_exec` and the tools
listed in `foreground.tools` in `fabric.json`. `context_compact` and
`load_skill` work only as direct model calls, so after an agent turn
pi-context-aware asks Fabric where they are reachable
(`pi-fabric:tool-placement:v1`). When Fabric reports full code mode and a tool
reachable only inside `fabric_exec`, it offers once per session, and only with
a UI, to add the tool to `foreground.tools`. It edits the trusted project's
`.pi/fabric.json` when that file sets `foreground`, otherwise
`<agent dir>/fabric.json`, and raises `maxTools` up to Fabric's limit of 8
when needed. Then run `/fabric reload`. "Don't ask again" records the tool in
`<agent dir>/fabric-foreground-declined.json`. `load_skill` is checked only
while this extension registers it.

The code is `src/platform/fabric-foreground.ts`, a verbatim copy of
pi-question's `src/adapters/fabric-foreground.ts`. Change both together. The
copies share one registry on `globalThis`, so a session gets one offer for
every tool.
