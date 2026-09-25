# Active delegate work contract

This document defines the answer to: “Does session `S` still have delegate work
running?” It is the contract for consumers such as the pi-context-aware busy
probe (issue #75). It does not define a unified on-disk index.

## Definition

Active delegate work is the union of two sources:

1. The live in-process producer on the Pi event bus.
2. Live detached-driver markers under
   `resolveOrchestrateActiveOwnerDir(agentDir, S)`:
   `<agentDir>/extensions/pi-delegate/orchestrate/active/<ownerKey(S)>/`.

The event-bus producer replaces full `run-state.json` scans for in-process work.
Detached drivers run in another process, so their marker scan remains separate.
During a mixed-version rollout, consumers may use the legacy run-state reader
only when the live protocol is absent, as described below.

## Live in-process protocol

The synchronous event-bus channel is:

```text
pi-delegate:session-active-work-query:v1
```

A consumer emits one mutable request object:

```ts
{ version: 1, ownerSessionId: string, response?: unknown }
```

The installed producer writes this response before `emit` returns:

```ts
{ version: 1, status: "busy" | "idle" | "unknown" }
```

The statuses mean:

- `busy`: at least one active registration is positively owned by the requested
  session.
- `idle`: no active local registration belongs to that session, and no local
  registration has ambiguous ownership.
- `unknown`: the producer cannot answer safely. This includes ambiguous local
  ownership and every well-formed request for a session other than the exact
  foreground session to which the handler is bound.

Malformed requests receive no response. A missing response means that no
compatible live producer answered. Consumers that must not wrongly report idle
MUST treat `unknown` as fail-closed. They MUST also treat a missing response as
fail-closed unless they deliberately use the legacy fallback during rollout.

The handler is installed only for a real foreground `session_start`, after
runtime hydration and configuration. A reinstall replaces the prior global
listener. Disposing an old handle cannot remove its successor. On
`session_shutdown`, the handler remains available until `abortAllRuns` has made
local terminal transitions durable, and is then removed. Delegate-owned worker
APIs never install this foreground capability.

### Producer inventory and attribution

The producer maintains a process-local set of run IDs admitted by this runtime's
ordinary or retry registration path. It adds an ID only after registration
commits. It removes the ID only after completion, revocation, or abort is
durable. Test reset clears the set. Hydration never adds IDs, so old, terminal,
foreign, and sibling records cannot become active merely because they appear in
the machine-shared history.

A terminal or revoked ID leaves the inventory only when a canonical state-file
replacement succeeds, a completion sidecar succeeds, or no durable store is
configured. Lock timeouts and ordinary write failures retain a fail-closed local
registration until a later successful flush. A skipped write against a newer
state schema is not positive commit evidence.

A supported same-ID replacement can overlap an older generation whose closures
are no longer addressable through the runtime map. The producer retains that ID
as `unknown` after the current generation becomes terminal, until session reset
proves every generation gone. Replacing a root likewise invalidates root-based
attribution for already-active ownerless children; they remain `unknown` rather
than borrowing the replacement root's owner. A positively owned current
generation still reports `busy` while it is active.

For each ID in the set, a valid direct `ownerSessionId` is authoritative. When
the owner is absent, attribution may use one uniquely resolved in-memory root
whose identity is structurally valid and whose `ownerSessionId` is valid. A
missing, malformed, or ownerless root makes ownership ambiguous.
Positively attributable work for another session does not make the queried
session busy. A positive match takes precedence over unrelated ambiguity;
otherwise any ambiguity produces `unknown`.

This live inventory is more precise and cheaper than reading every retained
`run-state.json` row. The state file contains hydrated history from all sessions
and can lag an in-process lifecycle transition under lock contention. The live
producer instead reports only registrations admitted by the module instance
that owns their lifecycle.

## Legacy run-state fallback

A `run-state.json` entry is **LIVE** exactly when both conditions hold:

- `completedAt` is absent or `null`; and
- at least one entry in `run.forks` has a status accepted by the canonical
  `isLiveStatus` predicate in `src/runtime.ts`.

The canonical live statuses are `pending`, `constructing`, `running`, and
`awaiting-escalation`. The canonical terminal statuses are `completed`,
`failed`, `aborted`, and `paused`. Unknown future status values are treated as
live by this fail-closed check.

A live entry is attributable to `S` when:

- `run.ownerSessionId === S`; or
- `ownerSessionId` is absent and `run.rootRunId` resolves to exactly one
  structurally valid retained root whose owner is `S`.

The second rule covers detached child forks in the run-state substrate until
owner attribution is present on every child. Issue #355 tracks persisting
`ownerSessionId` on detached and chain children. A present `ownerSessionId` is
authoritative; a run with a different owner is not attributed through its
`rootRunId`.

If an ownerless live entry's root does not positively resolve to `S` — it has no
retained root, has multiple matching roots, has a root with no authoritative
owner, or has malformed root identity — the entry is **not attributable to `S`**
and MUST NOT be counted as `S`'s active work. `run-state.json` is machine-shared,
so such an entry belongs to another session or is a stale orphan; attributing it
to whichever session happens to be asking lets one ownerless orphan report every
session as busy (and, before this rule, blocked `/delegate-only` on brand-new
sessions — issue #481). An ownerless child counts for `S` only when its retained
root authoritatively resolves to `S`.

This narrowing is scoped to a *well-formed* entry that simply cannot be tied to
the caller. It does not relax the fail-closed reads below: genuinely unreadable
data — a corrupt file, a non-array `runs`, a malformed run entry, or an unknown
fork status — is still treated as active regardless of session, because there the
consumer cannot trust the data at all rather than merely failing to attribute one
clean record. An **absent** file is not fail-closed: a missing substrate means no
work (see the next paragraph), so a brand-new session with no state file reads as
idle.

The run-state file is read tolerantly: unknown or newer fields do not affect
this contract. A missing file means that this fallback substrate has no work. A
malformed file or malformed run entry is an indeterminate read and MUST be
handled fail-closed by a consumer that must not wrongly report idle.

During a mixed-version rollout, a consumer SHOULD query the live protocol first.
A valid `busy`, `idle`, or `unknown` response is authoritative for in-process
work and MUST NOT be replaced by a historical file answer. If no compatible
producer responds, the consumer may call
`hasActiveDelegateWork(agentDir, sessionId)` or apply the run-state rules in
this section for compatibility with an older pi-delegate. This fallback may be
removed after every supported producer version implements the live protocol.

## Detached-marker liveness reconciliation

The detached marker reader is authoritative for marker shape and torn-write
detection:

```ts
readOrchestrateActiveMarkerProcessState(agentDir, ownerSessionId, runId)
```

A marker counts as LIVE only when all of the following are true:

- the reader returns `{ kind: "present", ... }`; and
- `pidAlive(runnerPid)` returns `true`.

A present marker with a dead `runnerPid` is terminal/stale and MUST NOT count as
live. This prevents a crashed detached runner's leftover marker from keeping a
session busy forever.

The following states mean that liveness cannot be ruled out and MUST be treated
as active by a fail-closed consumer:

- `kind === "unknown"`;
- a torn or malformed marker; or
- the runner PID is not yet stamped. The placeholder PID is the fixed-width
  string `"0000000000"`, which reads as `runnerPid === 0` and therefore cannot
  establish liveness.

A missing marker (`kind === "absent"`) means that marker has no active work.
Missing owner directories and `ENOENT` reads likewise mean no work on that
substrate. Other read or directory errors are indeterminate and MUST be treated
as active by a fail-closed consumer.

Unknown or newer marker fields are ignored by the marker reader. Marker files
are owner-partitioned, so a consumer for `S` scans only
`resolveOrchestrateActiveOwnerDir(agentDir, S)`.

## Consumer requirement

A current consumer MUST query the live protocol for in-process work and scan the
owner-partitioned detached-marker directory. It then unions those answers:
`busy` from either source means busy, while `unknown`, an indeterminate marker,
or an unhandled missing-producer case fails closed. Reading only the live
protocol misses detached drivers. Reading only `orchestrate/active` misses
in-process runs. Full `run-state.json` reads are rollout compatibility, not the
current in-process authority.

The first known downstream consumer is pi-context-aware issue #75.
