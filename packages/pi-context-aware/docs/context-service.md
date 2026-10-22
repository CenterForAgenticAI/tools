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
fraction rises by at least one percentage point. An `advised` or `required`
entry may carry `turnEntryId`, the id of the assistant entry whose turn end
observed the pressure. Context-aware writes at most one advisory per
`turnEntryId`, so a turn end that pi-durable repeats after a resume adds
nothing. Readers may ignore the field. These entries remain readable
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

## Session modes

`ContextAwareServiceV1.modes` is an additive capability. Check it with `supportsContextAwareModesV1`; older protocol-v1 producers remain valid without it.

A mode is owned by an unforgeable handle, not by the display-only `owner` string. Keep the returned handle in the defining extension and use it for transitions:

```ts
const service = discoverContextAwareServiceV1(pi.events, "my-extension");
if (supportsContextAwareModesV1(service)) {
	const result = service.modes.defineMode({
		id: "review",
		owner: "my-extension",
		transition: "Review mode is active.",
		blockedTools: ["bash"],
		guard: (toolName, input) => toolName === "edit" && input.path === "protected.txt"
			? { block: true, reason: "protected path" }
			: undefined,
		commandAllowed: (name) => name === "review-status",
	});
	if (result.status === "ok") await result.handle.enter();
}
```

Definitions copy only the named fields, enforce bounds, and retain callbacks only in process memory. Unknown fields are not persisted or included in transition messages. A duplicate id is refused. `handle.commandAllowed(name)` is advisory only: it reports whether the handle is the effective available mode and never intercepts commands.

Each accepted enter or exit appends one `context-aware/mode@2` state entry and sends one `context-aware/mode-transition@1` custom message with `triggerTurn: false`. State entries contain only the active layers (layer name, rank, `pinned`, `scope: "run"`) and each layer's id, instance id, owner label, `suggestedBy` and timestamps, plus a random `transitionId` that the message's `details` repeat. They contain no definition, transition text, callback, or caller-owned field. The system prompt and active tool list are unchanged.

Modes sit on layers, and one mode is active per layer; see [Layers](#layers). `/mode` lists the active layers, `/mode exit` leaves the highest-ranked layer that is not pinned, and `/mode exit <layer>` leaves the named layer. The active mode is shown in the qualified footer status `caair.context-aware/mode` and in the indicator widget described in [Mode indicator](#mode-indicator).

Modes replay from the active session branch after resume, fork, replacement, and tree navigation. A replayed mode is unavailable until its owner defines the same id, owner label, layer, rank and pin again; redefinition re-arms it without adding a transition. An orphan does not block tools and can always be cleared with `/mode exit <layer>`, even on a pinned layer. A run-scoped mode is not restored. Replay also reads the older `context-aware/mode@1` entry: its current mode lands on the `default` layer.

Each enter gets a random `instanceId`, shown on the snapshot and its `outer`. Use it, not `enteredAt`, to tell one enter from another: `enteredAt` has millisecond precision, so an exit and re-enter can share it. Entering a mode on one layer keeps every other layer's `instanceId`, and replay keeps the persisted one. An entry written before `instanceId` existed gets a stable `legacy-` id, derived from the session entry id of the first state entry of that enter on the branch, so every replay gives the same value; such an entry with no session entry id is refused. Replay also refuses a state entry that reuses an `instanceId` that ended earlier on the branch, gives one `instanceId` to a different enter, or puts one `instanceId` on two layers, and falls back to the last accepted entry, as it does for a malformed field. Transition text is recovered only from the message whose `details.transitionId` matches the accepted state entry, so the message of a refused entry is never resent, and a message Pi delivers at the end of a turn, after later state entries, is still found. For an entry written before `transitionId` existed, replay reads messages without one between that entry and the next state entry. Check `supportsContextAwareModeInstanceIdsV1(service)` to learn, with no mode active, that the producer sets `instanceId`; older producers omit it. Compaction sends one message through the existing successful-compaction owner. It joins every active layer's transition, lowest rank first, without repeating a text two layers share.

Model suggestions use the built-in `suggest_mode { mode, action, reason }` tool, or the API form `handle.enter({ suggestedBy: "model", confirm: true })`. Confirmation uses `ctx.ui.confirm` when UI is available, then the process-local confirmer installed with `modes.setSuggestionConfirmer`. Declines, missing confirmation, missing confirmers, and stale asynchronous confirmations leave state, entries, and messages unchanged. Set `modes.suggestTool` to `false`, or use `--context-aware-modes-suggest-tool=off`, to hide the model suggestion declaration.

A mode guard runs once in the extension-lifetime `tool_call` handler. It covers foreground calls and nested `pi.*` calls because Fabric emits the same preflight event. Declarative blocks and throwing guards fail closed; unavailable orphan definitions do not block. Guard reasons are bounded and thrown error contents are not exposed.

### Layers

A mode sits on a layer. One mode is active per layer, and the modes on different layers are active together: pi-stack, for example, holds a role, a stage such as Build, and a reviewer stance at once. Name the layer and its rank in the definition. Check `supportsContextAwareModeLayersV1(service)` first; an older runtime ignores `layer`.

```ts
if (supportsContextAwareModeLayersV1(service)) {
	const build = service.modes.defineMode({
		id: "build",
		owner: "my-extension",
		transition: "Build stage is active.",
		blockedTools: [],
		layer: { name: "stage", rank: 1 },
	});
	if (build.status === "ok") await build.handle.enter();
	service.modes.setTrail("plan › build › review");
}
```

- `name` is 1 to 64 characters. `default` is reserved: a definition without `layer` sits on the `default` layer at rank 0, so two such modes replace each other instead of nesting.
- `rank` is an integer from -1000000 to 1000000. Layers are ordered by rank, then by name. The runtime knows no layer names.
- Every definition on one layer must name the same rank and `pinned`; another is refused with `INVALID_REQUEST`.
- Entering a mode on a layer that holds one replaces it with one state entry and one transition message. The other layers keep their modes and `instanceId`s.
- A tool call must pass every active layer. See [Tool policies](#tool-policies).
- `layers()` returns every active layer's snapshot, lowest rank first, each with `layer`, `rank`, `pinned` and `runScoped`. `current()` returns the highest-ranked one, with the next layer down as `outer`.
- `setTrail(text)` shows a short step trail after the chips in the indicator; `setTrail(undefined)` clears it. It is at most 64 characters with no control or format characters, is never persisted, and any extension may replace it.

**Run-scoped entry.** `handle.enter({ until: signal })` enters the mode for one run. When the signal aborts, the mode leaves its layer with one entry and one exit message, unless another mode has replaced it there. A run-scoped mode is not restored on resume. An already-aborted signal is refused with `RUN_ENDED`.

**Pinned layer.** A definition with `layer.pinned: true` is entered only through its handle, in a new session (start reason `startup` or `new`, no user or assistant message on the branch) before its first agent run, and only when no pinned mode was replayed. Every later enter or exit on that layer is refused with `PINNED_LAYER`, as are run-scoped entry (`INVALID_REQUEST`) and model suggestions. Bare `/mode exit` skips it. Resume restores it. Once its definition is gone, only the user can clear it, with `/mode exit <layer>`.

### Mode indicator

While a mode is active, the runtime draws a one-line widget below the editor under the key `caair.context-aware/mode-indicator`. It shows one solid chip per active layer in its mode's color, lowest rank first, with ` ⚑` on a pinned layer; then the owner labels, `[model-confirmed]` when a mode was entered on the model's suggestion, the step trail set with `setTrail`, and a rule in the top layer's color to the edge of the terminal. A replayed mode is drawn muted with `(unavailable)` until its owner defines it again. The widget clears when the last mode exits and at shutdown. The footer status stays as the short text form.

Set the color and text with the optional `ui` field. Check `supportsContextAwareModeUiV1(service)` first; an older runtime ignores `ui`.

```ts
if (supportsContextAwareModeUiV1(service)) {
	service.modes.defineMode({
		id: "review",
		owner: "my-extension",
		transition: "Review mode is active.",
		blockedTools: [],
		ui: { color: "warning", label: "Review" },
	});
}
```

- `color` is a theme token from `CONTEXT_AWARE_MODE_COLOR_TOKENS_V1` (`accent`, `success`, `warning`, `error`, `muted`, `borderAccent`, `mdHeading`, `mdLink`, `toolTitle`, `bashMode`), or a fixed `#rrggbb` color. Tokens follow the user's theme; a fixed color is mapped to the terminal's color mode. The default is `accent`.
- `label` replaces the mode id in the widget. It is 1 to 32 characters with no control, format, or line-separator characters. The footer status, `/mode`, and the transition message still use the id.
- Any other `ui` value makes `defineMode` return `INVALID_REQUEST`. The runtime copies only `color` and `label`, keeps them in process memory, and shows them on the snapshot's `ui` while the mode is available. State entries never contain them.

### Tool policies

`blockedTools` names the tools a mode refuses, so a tool nobody listed still runs. A mode that must not change files cannot name every tool that writes. Give it a `toolPolicy` instead: it lists the tools that may run, and every other tool is refused (fail closed).

Check `supportsContextAwareModeToolPoliciesV1(service)` before you rely on a policy. A runtime without the `modes.toolPolicies` flag ignores `toolPolicy`, so the mode would block nothing beyond `blockedTools`.

```ts
let revising = false;
if (supportsContextAwareModeToolPoliciesV1(service)) {
	const result = service.modes.defineMode({
		id: "review",
		owner: "my-extension",
		transition: "Review mode is active. Source files are read-only.",
		blockedTools: [],
		toolPolicy: {
			allowedTools: ["read", "grep", "find", "ls", "bash", "suggest_mode"],
			readOnlyShell: true,
			lifted: () => revising,
		},
	});
}
```

- `allowedTools`: at most 64 names, trimmed, each non-empty and at most 128 characters, like `blockedTools`. An empty list refuses every tool, including `suggest_mode`; `/mode exit` is a command and still works.
- `readOnlyShell`: when `true`, `bash` runs only if its `command` passes the read-only shell check below, even when `allowedTools` lists `bash`. When `false` or absent, `bash` follows `allowedTools` like any other tool. It never admits `bash` that `allowedTools` omits.
- `lifted`: called at most once per tool call. While it returns `true` the policy does nothing for that call. A throw or any value other than `true` counts as not lifted. Use it to let the owner run a write step, such as a revise run, without leaving the mode.

An invalid policy (a non-array `allowedTools`, too many or invalid names, a non-boolean `readOnlyShell`, or a non-function `lifted`) refuses the definition with `INVALID_REQUEST`. The runtime copies only these three fields into its own definition and never keeps the caller's object, so changing the object after `defineMode` changes nothing.

Each tool call is checked in this order: `blockedTools`, then the policy, then `guard`. A tool in `blockedTools` is refused even if `allowedTools` lists it. The guard sees only calls the policy let through, and it still runs while the policy is lifted. A refusal reason is fixed text naming the tool and the mode; it never repeats the command or other input. With several layers active, a call must pass every layer: all `blockedTools` lists first, then every policy, then every guard, and the first refusal wins. A layer's `lifted` lifts only that layer's policy. An unavailable orphan mode enforces nothing until its owner defines it again.

#### What the policy sees

The policy sees every tool call Pi emits a `tool_call` event for: foreground calls, calls a `fabric_exec` program makes through Pi tools, and captured extension tools, because Fabric emits a `tool_call` preflight for each of them. It does not see work a Fabric provider does without a Pi tool call, such as a child agent started with `agents.run`, or anything a process started earlier keeps doing. List `fabric_exec` in `allowedTools` only if those paths are acceptable for the mode.

#### The read-only shell check

The check is a narrow allow-list, not a sandbox. It accepts one simple command and refuses anything it does not understand:

- The command is a string of at most 1,000 characters on one line. It may contain only ASCII letters, digits, spaces, tabs and `% + , - . / : = @ ^ _`. Every other character is refused, so there is no `;`, `&`, `|`, redirection, `$`, backquote, parenthesis, brace, backslash, `!`, glob character, `~`, `#`, quote, control character or non-ASCII text. Words are split on spaces and tabs only.
- The first word is one of `git`, `rg`, `fd`, `ls`, `cat`, `head`, `tail`, `wc`, `pwd`, `stat`, `file`, with no path, `env` or variable assignment before it.
- Each program has a short list of options. Any other word that starts with `-` is refused, wherever it appears, including after `--`. Words that do not start with `-` (paths, patterns, revisions) are allowed, except after `git branch`. Options must be written exactly as listed: no long-option abbreviations and, except for `ls`, no clusters such as `-ni`.
- An option that takes a value accepts it attached (`-n5`) or as the next word (`-n 5`), except `git diff -U`, which takes it attached only. A count is digits only. Any other value must not start with `-`.

| Command | Allowed options |
| --- | --- |
| `git` (before the subcommand) | `--no-pager` |
| `git status` | `-s`, `--short`, `-b`, `--branch`, `--porcelain` |
| `git diff` | `--stat`, `--name-only`, `--name-status`, `--cached`, `--staged`, `-U<count>`, `--` |
| `git log` | `--oneline`, `-n <count>`, `--max-count=<count>`, `--stat`, `--name-only`, `--name-status`, `-p`, `--graph`, `--decorate`, `--` |
| `git show` | `--stat`, `--name-only`, `--name-status`, `--oneline`, `-p`, `--` |
| `git blame` | `-L <range>`, `-w`, `--` |
| `git rev-parse` | `--abbrev-ref`, `--short`, `--show-toplevel`, `--verify` |
| `git ls-files` | `-m`, `-o`, `--others`, `--exclude-standard`, `--cached` |
| `git branch` | `--list`, `-a`, `-r`, `-v`, `--show-current`, and nothing else |
| `git grep` | `-n`, `-i`, `-l`, `-w`, `-e <pattern>`, `--` |
| `rg` | `-n`, `-i`, `-S`, `-w`, `-l`, `-c`, `-F`, `-e <pattern>`, `-t <type>`, `-A <count>`, `-B <count>`, `-C <count>`, `--hidden`, `--no-ignore`, `--` |
| `fd` | `-t f`, `-t d`, `-t l`, `-e <ext>`, `-d <count>`, `-H`, `-I`, `--` |
| `file` | `-b`, `-L` |
| `ls` | `-l`, `-a`, `-A`, `-h`, `-1`, `-R`, or a cluster of only these letters such as `-la` |
| `cat` | `-n` |
| `head`, `tail` | `-n <count>`, `-c <count>` |
| `wc` | `-l`, `-w`, `-c` |
| `stat`, `pwd` | none |

So `git log --format=...`, `--pretty`, `--show-signature` (which run gpg), `file -S`, `-z` (which run a decompressor), `file -p` (which changes a file's times), `fd -l`, `-x`, `-X` (which run other programs), `rg --pre`, `git diff --output` and `tail -f` are all refused. The lists are deliberately short; a useful option that is not listed is refused too.

The check sees only the command text. It cannot see:

- configuration that makes an allowed program run another one or change its behaviour: git's `core.pager`, `pager.<command>`, `diff.external`, textconv and diff drivers named in `.gitattributes`, `core.fsmonitor`, `log.showSignature` (which runs gpg for `git log` and `git show`), `format.pretty`, or an rg config file named by `RIPGREP_CONFIG_PATH`;
- environment variables such as `GIT_EXTERNAL_DIFF`, `GIT_PAGER`, `PAGER`, `GIT_DIR` and other `GIT_*` variables, or `RIPGREP_CONFIG_PATH`;
- small writes an allowed program makes on its own, such as `git status` refreshing `.git/index`;
- which files a command reads: paths are not confined to the project, so `cat /etc/passwd` passes;
- programs that block or print without end, such as `cat /dev/zero`.

A mode that must also guard against these should not allow `bash`.

## Context policy

`ContextAwareServiceV1.policy` is an additive, read-only capability. Check it with `supportsContextAwarePolicyV1`; older protocol-v1 producers remain valid without it.

```ts
import {
	CONTEXT_AWARE_POLICY_CHANGED_EVENT,
	discoverContextAwareServiceV1,
	supportsContextAwarePolicyV1,
	type ContextAwarePolicyChangedEventV1,
} from "@centerforagenticai/pi-context-aware/context-service";

const service = discoverContextAwareServiceV1(pi.events, "my-extension");
if (supportsContextAwarePolicyV1(service)) {
	const policy = service.policy.current();
	// policy.value === "summaries"; policy.source is the layer it came from.
	// policy.ladder holds the thresholds; policy.bands holds the WARN and URGENT edges.
}

pi.events.on(CONTEXT_AWARE_POLICY_CHANGED_EVENT, (data) => {
	const event = data as ContextAwarePolicyChangedEventV1;
	// event.reason is "command", "branch" or "session-entry"; event.previous and event.current are snapshots.
});
```

`policy.current()` reads the current branch each time it is called. It returns:

- `value`: the context policy. This release has one value, `summaries`.
- `source`: the layer that supplied the value (`default`, `global`, `project`, `session`, or `host`).
- `ladder`: the pressure-ladder thresholds `foldNudgeStartFraction`, `foldNudgeEndFraction`, `seededCompactionFraction`, and `recoverableHideFraction`, with each one's layer in `ladderSources`.
- `bands`: `warnFraction` and `urgentFraction`, the edges the telemetry bands use. `contextAwarePressureBandEdgesV1(ladder)` is the same mapping as a function.
- `diagnostic`: present when an unsupported value was ignored or the ladder fell back to its defaults.

`context-aware:policy:v1:changed` fires when the resolved policy differs from the last one this session saw: after `/context-policy` records a value (`command`), after `/tree` moves to a branch with a different policy (`branch`), and at the next turn end after another writer appended a policy entry (`session-entry`). Starting or resuming a session does not fire it; call `policy.current()` instead.

The capability cannot change the policy, and readers may ignore it. The policy is not a mode: `/mode` and the modes capability never change it. See [`contextPolicy`](configuration.md#contextpolicy) for how a user sets it.

## What is not an integration API

Model-facing `<context-telemetry>` envelopes, historical `[ctx ...]` markers, status-bar text, `<context-cache>` prompt blocks, and `Prior transcript:` summary lines are presentation/recovery guidance. Their text and formatting may change. **Do not parse them.** Use this typed service for cross-extension integration.

## Versioning

All public shapes carry `protocolVersion: 1`, and discovery uses the namespaced `context-aware:service:v1:discover` channel. Breaking changes require a new protocol version and channel; v1 shapes must not be silently reinterpreted.
