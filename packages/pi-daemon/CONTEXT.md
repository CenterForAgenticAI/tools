# pi-daemon context and vocabulary

pi-daemon uses pi's word **session** for durable agent history and keeps runtime, transport, and authority terms separate. Use these definitions in code, schemas, issues, logs, and user-facing text. Use **session** consistently for pi conversation history.

## Core identity

### Session

One pi conversation history stored as an append-only JSONL tree. Its stable public ID comes from the pi session header, and pi-daemon binds that ID to one canonical file path and cwd. Pi documents the JSONL tree at `docs/session-format.md:1-4,174-185,306-318` and exposes ID/file on `AgentSession` at `dist/core/agent-session.d.ts:332-337`.

### Runtime

The in-memory objects that can execute one session now: `AgentSession`, `SessionManager`, resource loader, UI bridge, subscriptions, and host queue. This generic term does not mean the SDK class `AgentSessionRuntime`; that class is a separate replacement API (`dist/core/agent-session-runtime.d.ts:44-93`).

### Awake / asleep

- **Awake:** the daemon currently owns one fully bound runtime for the session. Several sessions may be awake concurrently in the same daemon process.
- **Asleep:** history and registry state exist for the session, but no `AgentSession` exists for it. Replay and status still work. Driving requires wake.

Sleep is not failure, process exit, or history deletion.

## Observable state

### Phase

The session's derived work condition: `idle`, `working`, `blocked`, `failed`, or `gone`. Phase is independent of runtime state. `runtime: awake|asleep` says whether executable objects exist; `phase` keeps the last derived work condition when the runtime sleeps.

- **Idle:** fully settled, with no continuation or pending question. It may be the retained phase of an asleep session.
- **Working:** accepted work may still turn, call tools, retry, compact, or continue.
- **Blocked:** running work is waiting for a daemon-routed UI answer.
- **Failed:** the host needs attention before it can proceed.
- **Gone:** a materialized file is missing or no longer matches its registered identity.

`asleep` is a runtime state, not an internal phase. Sleeping retains the last phase; sleep does not rewrite it to `idle`. Fleet views use `observedPhase`: `failed` and `gone` take precedence, then an absent healthy runtime reports `asleep`, otherwise it reports the internal phase. Normal agent-run settlement begins only at pi's `agent_settled`, defined as no remaining retry, compaction, or queued continuation (`dist/core/extensions/types.d.ts:550-562`).

### Attention

A small derived signal telling an observer whether action may be needed: `none`, `question`, `failed`, or `interrupted`. It is not a prompt, severity, lease, or guarantee that a person must act.

### Pending question

An unresolved `select`, `confirm`, `input`, or `editor` request from an extension, identified by a server-generated correlation ID. Its presence makes an awake running session blocked. The answer stays in memory and is never written to fleet state.

### Generation

A monotonic number that identifies the current host incarnation and fences stale mutations. It changes on daemon restart, host disposal, wake, or replacement. A stale generation cannot prompt, answer UI, alter a lease, sleep, wake, or recover.

### Sequence

A monotonic number assigned once to each session-broker live source frame within one generation, before fan-out. Overlapping live readers see the same sequence. Replay and reader-local control frames use replay index or control fields instead. Sequence is not durable and resets with generation.

## History and replay

### Cursor

`{entryId, epoch}` naming the last committed entry a reader processed on an active branch. It resumes durable replay. It never points to a transient event or sequence.

### Epoch

A monotonic number for the session's active branch, projected only from a committed `pi-daemon/epoch`. That entry proves a daemon-controlled fork, switch/rewind, restore move, or tree navigation. An unaccounted external file/leaf/branch discontinuity is `external_writer` failure rather than an epoch transition. Generation fences a host; epoch fences a history path.

### Gap

An explicit stream frame saying bounded live delivery lost a sequence interval. It includes the last committed resume cursor and demotes that reader to catch-up. A gap does not claim the missing transient data can be rebuilt.

### Entry frame

`kind:"entry"`. It carries one committed pi `SessionEntry`, its durable cursor, and replay/live origin. It may carry a native pi entry or a `pi-daemon/*` custom entry. Consumers may persist its cursor.

### Event frame

`kind:"event"`. It carries one best-effort within-turn SDK event such as a message delta or tool-execution update. It is not in the pi file, is not replayable, and never advances a cursor. Pi persists finalized messages at `message_end`, not update/tool progress (`dist/core/agent-session.js:383-425,501-555`).

### Daemon frame

`kind:"daemon"`. It carries immediate daemon control or derived state such as phase, lease, prompt outcome, replay boundary, sleep/wake, restore, or keepalive. A durable transition also has a custom entry; its live projection carries that entry's ID as `sourceEntryId` so reducers can deduplicate. The daemon frame itself is not another durable log.

### UI-request frame

`kind:"ui_request"`. It carries a correlated extension question that the current driver may answer. It is separate from `event` so clients cannot miss its authority and answer-shape rules.

### Error frame

`kind:"error"`. It reports an asynchronous stream failure that has no request ID. Request failures use correlated `t:"res", ok:false` frames instead.

### Custom entry

A pi session entry with `type:"custom"`, a namespaced `customType`, and small structured data. pi-daemon uses only `pi-daemon/*` names. Pi excludes custom entries from model context (`dist/core/session-manager.d.ts:59-73`; `docs/session-format.md:263-271`). Do not confuse this with `CustomMessageEntry`, which is model-visible (`dist/core/session-manager.d.ts:85-103`).

## Authority and clients

### Lease

A time-limited, heartbeat-renewed grant of driver authority for one session. It is bound to session, attachment, generation, and holder. Release, expiry, disconnect, or takeover ends it.

### Driver

The attached client holding the active lease. It may prompt, abort, and answer UI. When a lease exists, only its driver may explicitly sleep or recover an external-writer failure. Driver authority is not required to wake, and an attached client may explicitly sleep or recover when no lease exists. “Driver” names authority, not a process type or UI.

### Watcher

An attached client without a driver lease. Any number may list, inspect, replay, stream, and query prompt status. By fixed policy, any attached client may also wake, steer, or follow up; it may explicitly sleep or recover an external-writer failure only when no lease is held. Those exceptions do not make it the driver.

### Attribution

Server-derived actor identity plus an optional sanitized live display label, kept separate from model-visible content. Only server-assigned actor/connection IDs are durable; labels are not. Attribution helps people see who submitted, steered, or queued a follow-up, carries no authority, and cannot be forged by writing label-like text in a message.

### Roster

The daemon's list of clients attached to one session: each client's actor ID, grant subject when present, role (watcher or driver), and any pending control request. Online, idle, and typing status is not part of it. Proposed in [ADR 0007](docs/adr/0007-host-owned-workspaces.md).

### Workspace

A host application's grouping of sessions, a working directory, an environment, and members. The host owns it. The daemon stores only an opaque `workspaceId` on each session and never interprets it. Proposed in [ADR 0007](docs/adr/0007-host-owned-workspaces.md).

## Lifecycle and storage

### Wake

Create and fully bind a runtime for a known sleeping session, reusing its identity/history and returning a new generation. Concurrent wakes for the same sleeping generation collapse into one operation; wakes for different sessions allocate independent hosts and may remain awake together. Any attached client may wake; wake is never lease-gated.

### Operator-trust concurrency

The policy that permits several in-process sessions to remain awake while the operator accepts their shared Node process state. Extensions can share ES-module state, cwd, environment, listeners, and timers; this policy is not a process-isolation claim. O1 daemon-owned worker processes are the future hardening path.

### Sleep

Dispose a fully settled runtime after every activity/generation gate passes, while retaining session file, registry row, watchers, and any eligible lease. Explicit sleep requires the current driver only when a lease exists; with no lease, any attached client may request it. Idle auto-sleep is daemon policy and is never lease-gated. Sleep never aborts work.

### Recover

Return a registered `external_writer` failure to usable idle/asleep state without waking it. Subject to the same conditional current-lease rule as explicit sleep, the daemon re-acquires the sidecar, proves file size and leaf are stable across a short window, rebuilds indexes from the pi file, and appends only failed external-writer outcomes for claims still pending.

### Registry

The daemon's small local `node:sqlite` database for session lookup, generations, epochs, one lease, and indexes of prompt claims/outcomes and lifecycle state. Every durable row is rebuildable by scanning registered pi JSONL files and `pi-daemon/*` entries. It is operational state, not transcript or event history; pi's JSONL is the sole durable history.

### Idempotency key

A caller-chosen opaque value that identifies one prompt submission within one session. Once the daemon appends a `pi-daemon/prompt-claim`, equal key and canonical payload return the indexed pending or terminal result; reusing it with different content is an error. Once committed to the pi file, the key supports file-only index rebuild. SDK 0.99.2 still delays that commit for a new file's first prompt until first assistant output (verified by `test/prompt-claim-ordering.test.ts`); an ordinary crash may retain a pending database row but cannot promise file-only recovery in that window (O10). Callers must not place credentials in the key. A known, received pre-claim refusal, including `busy`, permits re-evaluating its key. After uncertain delivery, retain the original `sessionId` and idempotency key, then query prompt status. Do not automatically resubmit a `pending` or `unknown` result: `unknown` means no matching indexed claim is available, not that provider work never started. See the [client recovery guidance](docs/reference.md#use-the-client-library).

### Settlement

The terminal daemon outcome for a claimed prompt. A prompt that starts an agent run settles at `agent_settled`, after pi guarantees that no retry, compaction, or queued continuation remains and the committed cursor is known. A command handled without starting an agent run settles immediately after its `prompt()` promise and queued persistence effects finish. The daemon records `settled`, `aborted`, `failed`, or `rejected` in `pi-daemon/prompt-outcome`; settlement survives caller restart and does not mean every transient event was delivered. If `external_writer` fences writes first, the claim remains pending with that reason until `recover` appends its failed outcome.

## Naming rule

Use `sessionId`, `sessionFile`, `runtime`, `phase`, `attention`, `generation`, `epoch`, `cursor`, `leaseId`, `attachmentId`, `clientId`, `questionId`, `promptId`, and `idempotencyKey` exactly at API/custom-entry boundaries. Avoid aliases that merge durable history with live execution or observation with authority.
