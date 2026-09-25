# Worker heartbeat (Commit B.2 + B.3)

Supervisor-observable liveness for the subagent worker session, plus a bounded
auto-cancel escalation and supervisor-initiated diagnostic / recovery tools.
Lets a slow-but-progressing worker stay alive while still guaranteeing that a
truly-hung worker cannot burn the run forever.

> **Terminology:** in this legacy heartbeat document, “auto-escalation” means
> automatic worker abort after repeated silence. It does **not** create or route
> a structured delegate decision, blocker, or amendment; those use the opt-in
> escalation system documented in [`escalation.md`](escalation.md).

## Why

Before B.2, `message_subagent` was a single un-interruptible `await
workerSession.prompt(text)`. A worker that blocked on an `rg` over a giant
tree, a long-running `pytest`, or a provider-side stall would hang the
supervisor's turn indefinitely. The only escape was a hard external cancel
(Commit A). That is a blunt instrument — it kills the worker mid-work and
loses partial results — and it requires a human at the keyboard.

The heartbeat turns the `message_subagent` call into a *soft* timeout: after
`heartbeatIntervalMs` of worker silence the tool returns a status payload
instead of blocking forever. The supervisor model sees the status, decides
whether to keep waiting (`wait_for_worker`) or give up (`finish_delegation`),
and stays in control. When consecutive silence reaches
`maxConsecutiveHeartbeats`, the channel sends one best-effort wind-down steer
and remains live for `heartbeatGraceIntervals` more intervals. Only silence at
or beyond `maxConsecutiveHeartbeats + heartbeatGraceIntervals` causes the
channel to auto-escalate and abort the worker on the supervisor's behalf — a
bounded, model-observable safety net that sits *between* "supervisor
cooperates" and "operator hard-cancels".

### Direct-worker silence bound

Direct workers have no clone supervisor and therefore emit no heartbeat payload.
An addressable direct run still uses the same actor-activity signal and descendant
probe as its liveness clock. Each observed worker event, including repeated token
or tool updates, moves its silence deadline. Activity from a live descendant does
the same, so a parent waiting on useful child work is not treated as stalled.

With default configuration, 15 minutes of silence sends one best-effort wind-down
steer. Continued silence for `windDownGraceMs` (90 seconds by default) hard-aborts
the run with `cancelReason: "heartbeat"`. Activity during that grace period
cancels the pending hard abort and starts a fresh silence window. This guard is
activity-based and does not change the `perForkMaxDurationMs: 0` default: an active
direct worker can run indefinitely. A low-level programmatic call with no `runId`
cannot attach the activity observer and keeps the previous behavior instead of
throwing.

The direct bound currently uses the built-in heartbeat interval and consecutive
count (`180000 × 5`). The `heartbeatIntervalMs` and
`maxConsecutiveHeartbeats` configuration fields continue to tune supervised
channels only.

## State machine

```
               send()
 idle  ────────────────────▶  running  ───▶  reply    ───▶ idle
  │                           │  │   notify-activity resets timer
  │                           │  │
  │           heartbeat timer fires, n < max
  │                           ▼
  │                       running  ───▶  heartbeat  ───▶ running
  │                           │                          (supervisor re-awaits
  │                           │                           via wait_for_worker)
  │           heartbeat timer fires, n == max
  │                           ▼
  │                 wind-down steer (once)
  │                           │
  │       heartbeat timer fires, n < max + grace
  │                           ▼
  │                       heartbeat ───▶ running
  │                           │
  │       heartbeat timer fires, n >= max + grace
  │                           ▼
  │                       aborted ◀──── channel.abort("heartbeat")
  │                           │
  │           external cancel (user / timeout / shutdown)
  │                           ▼
  └─────────▶              aborted
```

Only `kind:"reply"` returns the channel to `idle` and clears the inflight
prompt. `kind:"heartbeat"` keeps the inflight live so the next `awaitReply()`
re-races with a fresh timer. `kind:"aborted"` is terminal.

## Tool surface

All six tools live on the **clone** (supervisor) session; the worker is
unchanged. The bottom three were added in Commit B.3.

| Tool                  | Increments `roundsUsed`? | Purpose                                                                                    |
| --------------------- | :----------------------: | ------------------------------------------------------------------------------------------ |
| `message_subagent`    | yes                      | Send a prompt; race inflight vs heartbeat.                                                 |
| `wait_for_worker`     | **no**                   | Re-await the existing inflight prompt after a heartbeat.                                   |
| `inspect_worker`      | **no**                   | Read-only snapshot of channel state (state, silence, active tool, recent tail). Safe any time — including from `aborted`. |
| `cancel_worker`       | **no**                   | Terminal. Abort the worker on the supervisor's initiative; must be followed by `finish_delegation`. |
| `restart_worker`      | yes                      | Abort + fresh worker session with the same agent/model, then send `newMessage`. Valid from **any** state. |
| `finish_delegation`   | no                       | Collapse the supervised session (unchanged from B.1).                                                    |

Calling `message_subagent` or `wait_for_worker` on an **aborted** channel
returns a specific "worker is aborted — restart_worker or finish_delegation"
tool result (not the generic `idle` / `busy` payloads). Calling
`message_subagent` while `workerChannel.isBusy() === true` returns a
"busy — use `wait_for_worker`" tool result instead of starting a second
prompt (the clone agent loop can't pipeline prompts to one worker session).

## Heartbeat payload shape

Tool result returned to the supervisor when `kind === "heartbeat"`:

```
Worker still running — no reply yet (heartbeat 2/5).
Silent for 6.0s since last transcript activity.
Active tool call: bash — go test ./...
Recent worker activity (last 3):
  - toolCall[bash]: bash: pwd
  - toolResult[bash]: ~/project
  - toolCall[bash]: bash: go test ./...
Decide: call `wait_for_worker` to keep waiting, or `finish_delegation` if you have enough to answer.
```

Tool result `details`:

```ts
{
  kind: "heartbeat",
  round: 1,                         // ← message_subagent round counter
  workerSessionFile: "...jsonl",
  consecutiveHeartbeats: 2,         // ← this heartbeat's 1-indexed count
  maxConsecutiveHeartbeats: 5,
  silentMs: 6000,
  activeToolCall: { name, preview, id, startedAt } | undefined,
}
```

`kind: "aborted"` uses the same structure plus `reason: CancelReason`. For
heartbeat-driven aborts the reason is `"heartbeat"`; Commit A's external
cancels surface as `"user" | "timeout" | "supervisor" | "shutdown"`.

## Supervisor decision tree

Baked into the clone system prompt so the model picks sensibly:

```
on tool result from message_subagent / wait_for_worker / restart_worker:
  if result.kind == "reply":
    ← read result.text, continue normally
  elif result.kind == "heartbeat":
    if tail clearly shows progress that just hasn't landed yet:
      → wait_for_worker()
    elif tail is ambiguous:
      → inspect_worker()  # fresh snapshot, then decide
    elif worker is stuck + task is worth another attempt:
      → restart_worker({ newMessage: "try X instead" })  # counts as a round
    elif worker is stuck + we have enough partial info:
      → cancel_worker({ reason }) → finish_delegation({ summary: ... })
    else:  # already have enough to answer
      → finish_delegation({ ... })
  elif result.kind == "aborted":
    → restart_worker({ newMessage }) if recovery is worth it
    → else finish_delegation({ summary: "worker aborted (reason=...)" })
```

`wait_for_worker`, `inspect_worker`, and `cancel_worker` do **not** consume a
round. `message_subagent` and `restart_worker` each increment `roundsUsed` by
exactly one.

## Auto-escalation rationale

At `consecutiveHeartbeats === maxConsecutiveHeartbeats` the channel sends one
best-effort wind-down steer and keeps the inflight prompt alive. It calls
`abort("heartbeat")` only when the count reaches
`maxConsecutiveHeartbeats + heartbeatGraceIntervals`; with the default grace
of 2, `maxConsecutiveHeartbeats: 5` aborts on heartbeat 7, not heartbeat 5.
The next `awaitReply` settles with `kind: "aborted", reason: "heartbeat"`.
**The worker run is stamped `status: "aborted", cancelReason: "heartbeat"`
even if the supervisor then cooperatively calls `finish_delegation`**, so the
exit status distinguishes "worker ran away and we killed it" from
"supervisor chose to stop".

This sits alongside the optional Commit A `perForkMaxDurationMs` timeout in the
safety stack. The absolute policy is disabled by default after issue #57; it
remains available as an operator ceiling, or as a per-agent or per-entry budget
on a solo or supervised run (#287). Heartbeat payloads and supervisor tools remain
supervised-only; direct runs use the activity-based silence bound described above.
They do different jobs:

| Mechanism                    | Trigger                                   | Who sees it                  |
| ---------------------------- | ----------------------------------------- | ---------------------------- |
| supervised heartbeat (B.2)   | silence, bounded by consecutive count     | supervisor model             |
| direct silence bound         | 15 minutes without actor or descendant activity, then wind-down grace | runtime / operator |
| `perForkMaxDurationMs` (A)   | optional wall-clock cap regardless of progress (`0` default) | runtime / operator |
| user cancel shortcut (A)     | keybinding                                | operator                     |

Heartbeats remain the default liveness protection. With the defaults, the
soft wind-down is sent after `3min × 5 = 15min` of silence and hard abort occurs
after `3min × (5 + 2) = 21min` if the worker still does not reply. Setting
the internal per-run `heartbeatGraceIntervals` override to `0` makes the
soft and hard thresholds coincide. An absolute wall-clock cap is opt-in; when
configured it is the belt to the heartbeat's suspenders and cannot be relaxed
by a worker or invocation.

### Restart semantics (B.3)

`restart_worker({newMessage})` is the recovery tool for "worker is stuck but
the task is still worth attempting." Behaviour:

- **Counts as one round.** Rejected with a `max-rounds` tool result when
  `roundsUsed >= maxRounds`; the counter does NOT increment on rejection.
- **Preserves agent identity.** Same `AgentConfig` — same model, thinking
  level, tool allowlist, resource loader, skills, extensions. No way to
  swap agent mid-run.
- **Fresh session file + heartbeat state.** A new `SessionManager` instance
  is built per session, so the new worker gets its own jsonl at
  `sessions/forks/<ts>_<uuid>.jsonl`. The `workerHeartbeatAborted` /
  `workerCancelled` flags are reset, `fctx.sessionRefs.worker` is reassigned
  (critical for runtime `cancelOneFork`), and `result.workerSessionFile` is
  updated. The old transcript subscription is detached before the new one
  is attached so no stray activity events can cross-talk.
- **No memory of prior rounds for the worker itself.** The new worker
  session starts from scratch — the supervisor must re-state anything
  the new worker needs (hence `newMessage`, not just `continue`).
- **Transcript merging across restarts.** `result.priorWorkerSessions`
  captures a snapshot of each retired session's messages (session file,
  full messages array, retirement timestamp, and the `newMessage` that
  triggered the restart). `result.transcript` interleaves those snapshots
  with the final session's messages, separated by synthetic
  `worker:system` boundary entries of the form `--- worker session
  retired; restart_worker called with: <newMessage> ---`. Downstream
  consumers that filter transcript entries by role must treat `system`
  as a valid role (it was already exported by `src/summarize.ts`).
  Run-history (`runs.jsonl`) still records only the **final**
  `workerSessionFile`; the per-session forensics belong on `ForkResult`,
  not in the rolling history log.
- **Valid from the aborted state.** This is the whole point — a worker
  that got auto-cancelled (heartbeat) or explicitly cancelled
  (`cancel_worker`) can still be recovered via `restart_worker`.

### Cancel semantics (B.3)

`cancel_worker({reason?})` is the "stop without retrying" tool. Behaviour:

- **Does not count as a round** (it's a state change, not a delegation turn).
- **Terminal w.r.t. that worker session.** The next `message_subagent` /
  `wait_for_worker` call on the dead channel returns a specific aborted
  tool result pointing at `restart_worker` or `finish_delegation`.
- **Stamps the run's terminal status.** The collapse path has a short-
  circuit parallel to the heartbeat auto-escalation: `status="aborted"` +
  `cancelReason="supervisor"` + `error="Cancelled by supervisor: <reason>"`
  are preserved even if the supervisor then calls
  `finish_delegation({final_output})`.

### Inspect semantics (B.3)

`inspect_worker` is read-only. It reuses the heartbeat ring buffer (no
second buffer), so the tail it shows is exactly the same as what the most
recent heartbeat would have surfaced. Safe to call from any channel state,
including `aborted` — the last-known active tool call and tail are still
available. No rate-limiting is applied in B.3.

## Config + per-run overrides

### Global (`~/.pi/agent/config/pi-delegate/config.json`)

```jsonc
{
  "heartbeatIntervalMs": 180000,      // 3 min; 0 disables; 1..29999 clamped to 30_000
  "maxConsecutiveHeartbeats": 5,      // send one wind-down steer at this count
  "heartbeatTailLines": 5             // ring buffer size for recent activity in heartbeat payload
}
```

Absent fields fall back to `DEFAULT_HEARTBEAT_INTERVAL_MS` (180_000),
`DEFAULT_MAX_CONSECUTIVE_HEARTBEATS` (5), `DEFAULT_HEARTBEAT_TAIL_LINES` (5).
These fields configure supervised channels. Direct runs use the built-in interval
and count for their 15-minute silence bound.

### Per-run (on the `delegate` tool schema)

```ts
delegate({
  runs: [{
    agent: "reviewer",
    task: "...",
    mode: "supervised",
    heartbeat_interval_ms: 600_000,        // override: 10 min for long work
    max_consecutive_heartbeats: 3,         // override: escalate sooner
  }],
})
```

Per-run values shadow config defaults. `heartbeatTailLines` is **not**
per-run exposable — all entries in a run share the same tail depth. The runner
also accepts the internal `heartbeatGraceIntervals` override for tests and
runtime policy wiring; it defaults to `2`, counts extra silent intervals after
the one-shot wind-down steer, and is not a global `config.json` field.

### Clamping

Values `>0` but below `30_000ms` are clamped to `30_000ms` with a
one-time console warning. The minimum exists so supervisor prompts don't
thrash on sub-30s cadence. Tests drive sub-second intervals via the
internal `FORK_DELEGATE_TEST_SHORT_HEARTBEAT=1` env var.

## Config (B.3 additions)

```jsonc
{
  "inspectTailLines": 10   // reserved; must be >= 1. Currently the
                           // inspect_worker tool reuses heartbeatTailLines.
}
```

`inspectTailLines` is parsed + validated (default
`DEFAULT_INSPECT_TAIL_LINES = 10`, rejects `0`), but until per-inspect tail
sizing is wired up the inspect tool just emits the heartbeat ring buffer
verbatim. This keeps the data path single-sourced: there's no second ring
buffer and no divergence between "what a heartbeat showed you" and "what
an inspect would have shown you at the same instant."

## Test scenarios

### Unit (`tests/unit/worker-channel.test.ts`, `describe('WorkerChannel heartbeat')`)

- heartbeat fires after interval of silence
- `consecutiveHeartbeats` increments across successive `awaitReply()` calls
- `notifyActivity` resets `lastActivityAt` and the consecutive counter
- `activeToolCall` tracked from `toolCall`, cleared by matching `toolResult`
- `recentTail` bounded to `heartbeatTailLines`
- wind-down at max, then hard auto-escalation at max + grace → `kind:"aborted" reason:"heartbeat"` + session aborted
- `heartbeatIntervalMs === 0` disables heartbeat (B.1 passthrough)
- `heartbeatIntervalMs` below 30_000 clamps + warns once (module-level flag)
- wait-then-reply: after a heartbeat, reply before next heartbeat resolves as `reply`
- `notifyActivity` during an in-flight wait reschedules the timer

### Integration (`tests/integration/fork-runner.test.ts`, `describe('runFork heartbeat')`)

- **A** — slow worker w/ regular progress (`sleep 0.1` × 3): zero heartbeats, `kind:"reply"`.
- **B** — hung worker (`sleep 0.7`): supervisor sees ≥1 heartbeat via
  `wait_for_worker`, then the reply lands; supervised run completes cleanly.
- **C** — real hang (`sleep $marker`, max=3, grace=0): the soft wind-down
  and hard auto-escalation coincide, `workerSession.abort()` kills the bash
  child (Commit A's `isAlive` pattern confirms the PID is dead), and the worker run
  status is `aborted` with `cancelReason: "heartbeat"`.
- **D** — (B.3) `inspect_worker` during a heartbeat: the snapshot names the
  active `bash` tool; `roundsUsed` remains `1` (inspect does not bump).
- **E** — (B.3) `cancel_worker({reason})` after a heartbeat: sleep child
  dies; worker run status `aborted` + `cancelReason="supervisor"`; `error`
  contains the supplied reason even though `finish_delegation` runs with
  `final_output`.
- **F** — (B.3) `restart_worker({newMessage})` recovery: first worker's
  sleep child is killed, new `workerSessionFile` differs from the first,
  `fctx.sessionRefs.worker` points at the new session, `roundsUsed === 2`,
  supervised run completes.
- **G** — (B.3) `restart_worker` bounded by `maxRounds`: the third restart
  is rejected with a `max-rounds` tool result before incrementing the
  counter; supervised run finishes with `roundsUsed === 2`.

All integration scenarios use `heartbeat_interval_ms: 300` via the
`FORK_DELEGATE_TEST_SHORT_HEARTBEAT=1` escape hatch; none waits a real three
minutes.
