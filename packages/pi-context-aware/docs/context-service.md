# Context-aware cross-extension service (protocol v1)

`context-aware` publishes a small typed service for other Pi extensions that need context pressure, session lineage, context-cache references, or a bounded compact-and-continue operation.

The authoritative implementation remains context-aware. Consumers must not implement their own summarizer, seed rewriter, transcript parser, or compaction coordinator.

## Import and discovery

The public contract is exported as `@centerforagenticai/pi-context-aware/context-service`:

```ts
import {
  CONTEXT_AWARE_HANDOFF_STATE_EVENT,
  discoverContextAwareServiceV1,
  supportsContextAwareArtifactPromotionV1,
  type ContextAwareHandoffLifecycleEventV1,
} from "@centerforagenticai/pi-context-aware/context-service";

pi.on("session_start", (_event, _ctx) => {
  const service = discoverContextAwareServiceV1(
    pi.events,
    "my-extension@1",
  );
  if (!service) return; // context-aware is absent or has not started yet

  const snapshot = service.getSnapshot();
  // snapshot.protocolVersion === 1
});
```

Discovery is synchronous over Pi's process-local `pi.events` bus. Discover lazily when the service is needed, or from a `session_start` handler that runs after context-aware. A discovered service is valid only for the current session runtime; discard it on `session_shutdown` and rediscover after reload, resume, fork, or session replacement.

Consumers that import the bare package subpath must make `@centerforagenticai/pi-context-aware` resolvable from their package (for example, as a local/file dependency during development). Pi packages have separate module roots.

## Worker round-boundary compaction channel

A host that drives delegated worker rounds must use the durable session-record
channel `context-aware.worker-compaction.v1`, not this process-local service.
Context-aware appends the channel as a session custom entry only when
`sessionRole` is `worker`; foreground sessions never emit it.

An `advised` entry means the proactive threshold has been crossed. A `required`
entry means generation reserve is unsafe or the reply stopped on `length`.
Context-aware writes the advisory during the worker turn without aborting,
compacting, or starting another agent run. The host may read it after harvesting
the complete reply and compact only at a round boundary. It must pass the
entry's `instructions` to `session.compact()` verbatim. After compaction,
context-aware appends `satisfied` with the discharged `satisfiedRevision`.
Revisions are positive and monotonic per session.

The v1 payload allows unknown additive fields. Malformed entries are ignored.
`instructions` is at most 4,000 characters, and the whole JSON payload is at
most 8,192 bytes. Repeated same-state pressure is coalesced until the usage
fraction rises by at least one percentage point. These entries remain readable
when the worker runs detached or does not share a `pi.events` instance with its
host.

## Snapshot API

```ts
const snapshot = service.getSnapshot();
```

`ContextAwareSnapshotV1` returns:

- exact known `tokens`, `contextWindow`, `fraction`, and `headroom`, or explicit `null` values with `band: "UNKNOWN"`;
- pressure `band` (`OK`, `WARN`, `URGENT`) and phase-boundary guidance (`not-advised`, `advised`, `required`, `unknown`);
- a current session reference plus parent/prior-session lineage references;
- additive `session.compactions` boundary metadata for the current leaf branch. Each item has a one-based `ordinal`, nullable boundary identifiers/timestamp/token metadata, and a normalized nullable `priorTranscriptPath`. Malformed or missing fields become `null`, and older protocol-v1 producers may omit this field. The producer derives this list from the current branch, not by scanning the transcript file;
- metadata-only context-cache artifact references;
- the current compaction coordinator state (`idle`, `queued`, or `running`);
- optional proactive lifecycle state (`idle`, `pending`, `generating`, `queued`, `compacting`, `cooldown`, `failed`, or `cancelled`), including a run ID, trigger count, cancellation stage, cooldown deadline, and last failure when known;
- effective seed rewrite, ambiguity, compaction-model, and proactive-compaction modes. The proactive configuration includes a steady-state stall threshold and a first-output grace period for reasoning models: thinking/tool-call stream events reset liveness without becoming seed text, text output starts the steady-state threshold, and an absolute five-minute ceiling remains in force. Current producers also include `commitDrainTimeoutMs`, how long a prepared compaction waits for an in-flight agent run to end before the commit is abandoned and queued again; this additive protocol-v1 leaf may be absent from older producers.
- provider/protocol/session provenance.

The proactive-compaction snapshot is the same resolved representation used by runtime checks and status commands:

```json
{
  "effectiveMode": {
    "proactiveCompaction": {
      "enabled": true,
      "thresholdFraction": 0.78,
      "outputReserveTokens": 16384,
      "preparationStallTimeoutMs": 30000,
      "preparationFirstOutputGraceMs": 90000,
      "commitDrainTimeoutMs": 10000,
      "source": "mixed",
      "sources": {
        "enabled": "cli",
        "thresholdFraction": "cli",
        "outputReserveTokens": "global",
        "preparationStallTimeoutMs": "project",
        "preparationFirstOutputGraceMs": "global",
        "commitDrainTimeoutMs": "default"
      }
    }
  }
}
```

Each `sources` value is `default`, `global`, `project`, `cli`, `session`, or `host`, matching the six configuration layers. `source` repeats that layer when all three values agree and is `mixed` when they do not. When a requested CLI value cannot be applied, the object retains the effective non-CLI values and sources and adds a `diagnostic` string. The proactive-compaction field was added compatibly to protocol v1: consumers should tolerate its absence from snapshots produced by older context-aware versions. The newer `commitDrainTimeoutMs` leaf and its provenance entry are optional for the same reason; consumers must use the documented default or their own fallback when an older producer omits them.

The top-level proactive lifecycle is separate from effective configuration. It reports work owned by context-aware itself without changing the existing `compaction.state` union:

```json
{
  "proactiveCompaction": {
    "state": "generating",
    "trigger": "generation-reserve",
    "coalescedTriggers": 2,
    "updatedAt": "2026-08-10T20:00:00.000Z",
    "lastFailure": {
      "stage": "seed-generation",
      "message": "Previous seed request timed out",
      "at": "2026-08-10T19:55:00.000Z"
    }
  }
}
```

This top-level field is also an additive protocol-v1 field and may be absent from older producers. A failure remains visible while a static safety handoff is queued or compacting. Consumers should treat it as a point-in-time diagnostic, not as a second handoff coordinator.

`session.lineage` continues to mean parent and prior-session references. A compaction path that differs from the current session file is retained as a genuine prior-session lineage reference; a path equal to the current session file remains only in `session.compactions`.

Session and artifact references contain stable identifiers and local file URIs/paths, not transcript or artifact contents. New cache artifacts receive an immutable opaque ID. Legacy manifest entries receive a deterministic ID derived internally from their canonical cache location, so repeated snapshots are stable without rewriting old manifests.

Call `getSnapshot()` again when fresh pressure or artifact state is required. Snapshots are immutable point-in-time values; the service does not mutate an earlier snapshot.

## Explicit context-cache artifact promotion

A coordinator may explicitly copy one workspace artifact into the durable context
cache. This is an additive capability: an older protocol-v1 producer may omit
`promoteArtifact` while remaining discoverable. Consumers can detect support
without assuming the method exists:

```ts
const service = discoverContextAwareServiceV1(pi.events, "my-extension@1");
if (supportsContextAwareArtifactPromotionV1(service)) {
  // The promotion capability is available.
}
```

```ts
const result = service.promoteArtifact({
  sourcePath: "/tmp/pi-workspace/<worktree-hash>/artifacts/plan.md",
  file: "plan.md",
  description: "Approved implementation plan",
});

if (result.status === "promoted") {
  // result.artifact is the metadata-only context-cache reference.
}
```

`sourcePath` must be an absolute path to a regular file within one of two roots:
the publishing session's `ctx.cwd`, or that session's prepared pi-delegate
artifacts directory. The service derives the pi-delegate directory itself. It
does not accept a root, flag, marker, or manifest from the caller.

The derivation matches pi-delegate. First, the service runs
`git -C <ctx.cwd> rev-parse --show-toplevel`. It resolves and canonicalizes that
Git worktree path, or `ctx.cwd` when Git does not return a worktree. If the
canonical path does not exist, it uses the resolved path. It then computes the
full SHA-256 hex digest of the canonical path and forms
`<path.resolve(os.tmpdir())>/pi-workspace/<hash>/artifacts`. Before trusting that
external directory, the service reads
`<path.resolve(os.tmpdir())>/pi-workspace/<hash>/.worktree-path`. The sidecar
must be a regular non-symlink file whose canonicalized path equals the current
session's canonical worktree path. The service opens this file without
following a final symlink and binds its contents to the opened file identity.
A missing, malformed, redirected, or mismatched sidecar disables the external
root; `ctx.cwd` remains available. After deriving the textual path exactly as
pi-delegate does, the service resolves the artifacts root before comparing it
with the resolved source; this remains correct when `os.tmpdir()` itself is
reached through a symlink. The `pi-workspace`, hash, and `artifacts` descendants
must be real directories with stable identities. A symlink at any of those
descendants disables the external root. Another worktree's hash and sidecar
cannot authorize a source for this session.

The service opens the source without following its final symlink, then resolves
the trusted roots and source path and compares the opened descriptor's file
identity with the named path. This binds the containment check to the file that
will be read, even if a parent directory is swapped after the initial path
preflight. `file` is a single safe cache filename with an extension; the
reserved manifest name `_manifest.json` is refused in any case variant, so it
can never alias the manifest on a case-insensitive filesystem. Promotion is
create-only: an existing tracked, untracked, or symlinked destination is
refused, and the caller is responsible for choosing a fresh safe name before
retrying. The cache is a UTF-8 text store, so promotion accepts only valid UTF-8:
a source with malformed bytes is rejected before any staged, published, or
manifest state is created, rather than being decoded lossily. Valid UTF-8,
including a leading byte-order mark, is preserved byte-for-byte. The service
stages the complete source bytes in an owner-only temporary file in the cache
directory, then publishes that staged file with an atomic hard-link operation
that refuses an existing destination; the temporary file is removed after
publication or failure. A destination that appears after preflight is therefore
never truncated, and the final name never exposes partial bytes. The service
reads the source file, writes it to the active cache scope, and returns the
resulting `ContextAwareArtifactReferenceV1`. Promotion requests may contain only
`sourcePath`, `file`, and optional `description`; unknown properties are
rejected. The service copies those named fields into cache metadata. The new
cache entry receives its stable artifact ID and creator from service-owned
manifest metadata.

Promotion is one-way and explicit. Nothing is promoted automatically by
snapshots, compaction, or cache listing. If context-aware is absent,
`discoverContextAwareServiceV1` returns `undefined`; a coordinator should skip
the promotion and record a diagnostic rather than treating that as an error.

A present service returns a typed `status: "failed"` result for invalid input,
a disabled cache, an unavailable source, or a storage failure. A source that
passes preflight but is absent or no longer a regular file when promotion opens
it is reported as `SOURCE_UNAVAILABLE`, not a generic storage failure.

## Seeded handoff operation

Protocol v1 handoffs are deliberately non-interactive:

```ts
const receipt = await service.requestHandoff({
  requestId: crypto.randomUUID(),
  purpose: "Move from planning to implementation",
  nextPhaseSeed: "Implement the approved typed service and run npm run check.",
  summaryFocus: "Preserve issue #2 acceptance criteria and exact test commands.",
  rewriteSeed: true,
  ambiguityMode: "cautious-proceed",
  interactionMode: "non-interactive",
  bounds: {
    maxSeedCharacters: 12_000,
    maxSummaryFocusCharacters: 8_000,
  },
});
```

The operation uses the same `prepareSeedForCompaction` and compaction runner as `compact_session`:

1. validate the explicit purpose, seed, mode, and character bounds;
2. reject immediately when a compaction is already queued or running;
3. run context-aware's existing seed rewrite/ambiguity policy and enforce the expanded-seed bound;
4. recheck and atomically reserve the per-session compaction coordinator (concurrent requests may prepare in parallel, but exactly one can reserve and compact);
5. queue until `agent_settled` when an agent run is active, or start immediately when idle;
6. invoke the existing `ctx.compact()` path, including transcript/cache metadata augmentation;
7. let Pi drain input queued during compaction, then send the expanded
   next-phase seed exactly once through the existing follow-up path.

A successful call returns a `queued` or `running` receipt after scheduling; it does **not** wait for compaction to finish (which would deadlock callers running inside an active agent turn). The receipt includes the run ID, expanded bounded seed, effective modes, session reference, request purpose, timestamps, and protocol provenance suitable for an execution-recipe record.

Subscribe before requesting if terminal lifecycle state is needed:

```ts
const off = pi.events.on(CONTEXT_AWARE_HANDOFF_STATE_EVENT, (raw) => {
  const event = raw as ContextAwareHandoffLifecycleEventV1;
  if (event.requestId !== requestId) return;
  // queued | running | completed | failed | cancelled
  if (["completed", "failed", "cancelled"].includes(event.state)) off();
});
```

Events are ephemeral and process-local. Correlate them by `requestId` and `runId`; persist any recipe record the consumer needs.

## Bounds, interaction, errors, and cancellation

- `purpose`, `requestId`, and `nextPhaseSeed` are required.
- Default bounds are 12,000 seed characters and 8,000 summary-focus characters. Hard protocol limits are 50,000 and 20,000 respectively. The bound is checked both before and after seed expansion.
- Protocol v1 accepts only `interactionMode: "non-interactive"`.
- The service never opens an editor, approval prompt, or clarification message. If effective `user-approve` or ambiguity policy needs user input, the operation returns `INTERACTION_REQUIRED`.
- Validation, bounds, preparation, service availability, coordinator conflict, and synchronous launch errors are represented as typed `status: "failed"` results. A session that is too small to compact is the normal `status: "nothing-to-compact"` result and is not a failure. Its message is `Nothing to compact (session too small); the conversation is unchanged.`
- At most one handoff/compaction may be queued or running per session. A conflicting request returns `COMPACTION_CONFLICT` with the active run reference.
- `cancelHandoff(runId)` cancels a queued request and emits `cancelled`. Once `ctx.compact()` is running, Pi exposes no operation-scoped cancellation handle, so cancellation returns `too-late` rather than calling broad `ctx.abort()`.
- Session shutdown cancels queued service handoffs, aborts in-progress preparation, unregisters discovery, and marks an already-running service handoff failed because Pi cannot transfer its operation handle into the replacement runtime. Late callbacks from that stale runtime are suppressed and cannot send the old seed.
- Asynchronous compaction failures emit a terminal `failed` lifecycle event and retain the existing context-aware recovery behavior while the runtime remains active.

## What is not an integration API

Model-facing `<context-telemetry>` envelopes, historical `[ctx ...]` markers, status-bar text, `<context-cache>` prompt blocks, and `Prior transcript:` summary lines are presentation/recovery guidance. Their text and formatting may change. **Do not parse them.** Use this typed service for cross-extension integration.

## Versioning

All public shapes carry `protocolVersion: 1`, and discovery uses the namespaced `context-aware:service:v1:discover` channel. Breaking changes require a new protocol version and channel; v1 shapes must not be silently reinterpreted.
