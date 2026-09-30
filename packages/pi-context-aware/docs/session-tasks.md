This page is for users and extension authors working with durable session task lists.

## Session task list

A session given six tasks used to finish task one, drift, and report success while five were never attempted — because the only record of "six tasks" was transcript text that summarisation later threw away.

The task list fixes that the way focus fixes a single objective: every change is written to the transcript as a full snapshot, the list is rebuilt by replay, and the current list is rendered into the prompt on every turn. Nothing depends on an earlier message surviving compaction.

### Statuses

`pending`, `active`, `done`, `blocked`, `deferred`. `blocked` and `deferred` both need a written reason.

They read alike but answer different questions, and both questions are answered mechanically rather than from prose:

- everything `done` or `deferred` means the list **is finished**;
- anything `blocked` means the list **is stuck** and something has to escalate.

### Structure

Sub-tasks go exactly one level deep. A parent's status is **derived** from its children and cannot be set:

- any child blocked → parent blocked;
- else any child active → parent active;
- else all children done or deferred → parent done;
- else pending.

Derivation is what stops a parent claiming `done` while three children sit pending. Deeper nesting with settable parents is a work graph, and pi-work owns that.

Ordering is the list's own order. There are no dependency edges: `add` takes `after`/`before`, `reorder` takes the full sequence, and "blocked until t3 lands" belongs in the note as prose.

### Opaque task references

A task may carry an optional `ref` value. It is opaque data: context-aware carries and displays it but does not interpret its meaning, reconcile by it, or require it to be unique. A `ref` must be a non-empty value of at most 32 characters matching `^[A-Za-z0-9][A-Za-z0-9._-]*$`. Task IDs remain separate from refs, including owner-side and worker-local delegation IDs.

Structured task snapshots and version-1 seeds preserve valid refs, and delegated task rows expose them to consumers. Aggregate progress events remain aggregate-only and never include a ref. Markdown export and seed degradation retain the existing checklist syntax and intentionally omit refs rather than inventing provider-specific metadata.

Changing a ref is a task edit. Agent-origin tasks may be edited by the agent; user- and spec-origin tasks retain their origin lock, while the user can still change them.

### Who may change what

`origin` decides. It mirrors the pinned-objective rule focus already has: an agent may report progress on work it was given, but may not quietly rewrite or delete it.

| origin | agent may retitle or remove | agent may change status |
|---|---|---|
| `user` (you typed it) | no | yes |
| `spec` (seeded by a dispatch) | no | yes |
| `agent` | yes | yes |

### The tool

`session_tasks` takes batched actions, because a model laying out six tasks should not spend six tool calls. When pi-fabric makes registered extension tools callable only through its active `fabric_exec` tool, the injected task and focus guidance uses the reachable forms `extensions.session_tasks(...)` and `extensions.session_focus(...)`. Context-aware accepts that path only when Pi attributes `fabric_exec` to the `pi-fabric` package and, when `PI_FABRIC_TOOL_ALLOWLIST` is set, the requested extension tool appears in its valid JSON string array; a malformed allowlist fails closed. Without either the native active tool or that authorized pi-fabric executor path, context-aware omits tool-call guidance and automatic task continuation remains unavailable.

| action | what it does |
|---|---|
| `plan` | replaces the whole list; accepts tasks with `title`, optional `status`, `note`, `ref`, and one level of `subtasks`; the normal way to start |
| `add` | one task with optional `ref`, optionally under a `parent` or `after`/`before` a sibling |
| `update` | takes an **array** of `{id, status?, title?, note?, ref?}` |
| `remove` | agent-origin tasks only |
| `reorder` | the full id sequence |
| `list` | rarely needed; the list is in the prompt already |

### Commands

```
/tasks                      show the list
/tasks add <title>          appends, origin=user
/tasks done <id>
/tasks block <id> <reason>
/tasks defer <id> <reason>
/tasks reopen <id>          clears a reason that no longer applies
/tasks clear
/tasks export [path]        markdown checklist; prints when no path is given
/tasks import <path>        replaces the list from a markdown checklist
/tasks on|off
```

### Where it shows

The focus widget grows a second line rather than a second widget appearing, because the above-editor budget is two lines per feature and focus had already spent it:

```
🎯 Ship the task-list feature · active
☑ 3/7 · ▸ wire the replay projection · ⚠ 1 blocked
```

The second line appears only when a list exists.

### Automatic continuation

At Pi's `agent_settled` boundary, a foreground session with `pending` or `active` work may receive up to two extension-generated turns for the current task-list revision. The first asks the agent to reconcile completed work, record each status change with `session_tasks`, and continue. If the agent settles without changing the list, one final corrective turn tells the agent—not the user—to update the list, keep working, or mark the task blocked and ask one precise question. A further unchanged settle stops quietly and records only a debug diagnostic. Finished and blocked-only lists stay silent. New user input resets the bound.

Worker sessions never self-prompt; their supervisor owns the next instruction. The continuation is stored as extension-generated state with machine-readable provenance, not as user-authored text.

`seedAuthorityGuard` applies before each generated turn. Its default `warn`
mode replaces a refused reminder with the fixed, title-free reconciliation
prompt described above, so a conservative fixed-rule classification cannot
leave an authorized workflow idle. `enforce` suppresses the turn. `off` sends
the ordinary reminder without running the check.

Before either turn, context-aware gives queued user input priority and checks whether the session is waiting on a running `pi-delegate` worker. Busy work suppresses the turn without consuming it, so the same stage remains available after that work finishes. An unreadable or unowned delegate signal fails closed and reports the reason once rather than starting a competing agent turn. Pending `pi-callbacks` jobs are deliberately not treated as busy because recurring polls and far-future reminders would suppress continuation indefinitely.

An aborted turn stops automatic continuation until the user speaks again, not merely for the settle that follows it. Pressing Esc means stop, so a single-settle suppression would let the next settle restart the work the user just interrupted. The abort is read from the session branch on each settle rather than held in a flag, because Pi resumes a session by more paths than the `input` event covers — `AgentSession.steer()` and `followUp()`, and the RPC `steer` and `follow_up` commands, queue a user message directly without emitting it — and a flag missed by one of them would leave continuation silently disabled for the rest of the session. What lifts the suppression is the user, not merely a later turn: a follow-up the extension had already queued when Esc was pressed can still run, so the scan starts at the abort and looks for a literal user message after it. Extension deliveries are separated structurally rather than by their text. A `pi.sendMessage` delivery persists as a `custom_message` entry, so only a plain `message` entry can be the user at all. `pi.sendUserMessage` is the harder case, because it produces a message shaped exactly like typed input: the check-in, the compaction seed, the two compaction recovery paths, and interrupted-prompt recovery all use it. Each records a `context-aware.extension-delivery.v1` marker immediately before sending, and each marker claims exactly one following user message, in order — so a marker can never disqualify a later message the user did write. Seed provenance recorded after the abort is kept as a fallback, for a host without `appendEntry` and for a delivery whose marker was lost; scoping it to that window stops a user message repeating an earlier seed's wording from being mistaken for a replay of it. A delivery that records no marker and has no provenance resumes continuation one turn early, which is the recoverable direction; discarding a real user message would leave the session silently stopped, which is the failure this exists to prevent. Suppression consumes neither bounded stage, so both the continuation and the corrective turn remain available for that revision. A session whose branch cannot be read reports an unanswered abort, matching the fail-closed treatment of the idle predicate and the delegate busy probe on the same handler.

### Talking to pi-delegate

Neither package imports the other. context-aware publishes a versioned wire contract; pi-delegate accepts the caller-facing `checklist` field on supervised slots, direct calls and slots, and detached `orchestrate`. `tasks` remains the selector for parallel-direct dispatch, so it is not reused for the checklist field.

Supervised and direct in-process workers can receive a durable pre-turn seed when the loaded worker runtime owns `session_tasks`. If no runtime claimant exists, the checklist degrades to markdown appended to the worker's task text instead; the seeded and markdown paths are mutually exclusive. Detached `orchestrate` always uses markdown because the local foreground process does not own the detached driver's worker `SessionManager`.

Inline sequential and parallel chain-step schemas deliberately do not expose `checklist`; this documents only that shipped schema boundary and makes no broader chain claim.

The contract is built to survive being wrong: unknown and newer fields are ignored rather than rejected, one malformed task cannot discard a dispatched plan, and a status sent without its required reason is downgraded rather than refused. The seed payload and the progress payload are versioned separately so each side can move on its own.

For a durable seeded checklist, progress travels at `fields.tasks` on an ordinary `updated` bus event. This retains the existing event validator and latest-`updated` bounded coalescing. The existing status row shows bounded checklist counts (`{done, total, active, blocked}`), and the final `taskLedger` exposes a mechanical `complete` / `gap` / `stuck` outcome, counts, and unfinished entries. Markdown-only degradation still shows the plan, but does not itself guarantee structured progress or a `taskLedger`.

Task state remains an agent claim, not acceptance evidence: a checked or `done` task, and the mechanical ledger outcome, do not prove that acceptance criteria passed.

### What it is not

The list is not a tracker. Owner, estimates, timestamps, priority, tags and percent-complete are all deliberately absent: each one is a request that will arrive, and each one turns a checklist into something else.

It is also not the authority on whether work is really done. A task marked `done` is a claim by an agent, not evidence.

## Session restart notice

When Pi restarts or switches sessions, context-aware classifies the session history and keeps a pending hidden telemetry notice when entries exist. At the first agent turn, it measures the away gap and sends the notice when it meets `restartNotice.minAwayMs`. The notice asks the agent to re-check volatile state such as background jobs, dev servers, tmux sessions, and shell state. Set `restartNotice.enabled` to `false` or adjust `restartNotice.minAwayMs` to change this behavior.

