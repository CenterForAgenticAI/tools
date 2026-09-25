# delegate

A pi extension that runs work on parallel specialist subagents and **collapses**
each run into one completion result. A `supervised` run additionally **forks the
main agent** into a private multi-turn conversation with its worker. By default
the initial tool call returns a dispatch envelope immediately and the collapsed
result arrives later in an automatic completion wake. Use `await: true` only for
an explicit foreground dependency barrier.

Code-owned consumers can use the constructable programmatic client for one-shot
dispatch, status/harvest, steer, and cancel over the same production handlers.
It writes stable receipt/result envelopes with execution provenance; see
[Programmatic runtime API](docs/runtime-api.md).

## Why

Pi already has subagents (see the built-in `subagent` example), but they're
fire-and-forget: the main agent sends a task, gets one reply, done.
`delegate` adds parallel dispatch, ordering, and — when you ask for it —
review-and-iterate loops **without polluting the main thread's history**.

```
main agent: ... tool_use delegate({ runs: [A, B, C] })
                    │
     ┌──────────────┼──────────────┐
     ▼              ▼              ▼
   run A          run B          run C          (in parallel)
  worker A       worker B       worker C
     │              │              │
     ▼              ▼              ▼
  collapse      collapse        collapse
                    │
                    ▼
background default: delegate:complete wake { A: <single answer>, B: ..., C: ... }

await: true:       originating tool_result { A: <single answer>, B: ..., C: ... }
```

Every run collapses to one result. A `mode: "solo"` run (the default) sends the
task to its worker and returns the answer. A `mode: "supervised"` run inserts a
**fork of the main agent itself** (same model, same system prompt) between you
and the worker, which converses with it for up to `rounds` turns before
collapsing. Not a separate supervisor model, not the user. That fork is a
private scratchpad that never enters the main thread.

A `mode: "driver"` run names the agent role that may dispatch nested work. It
runs as a durable session hosted by `pi-daemon`, so the caller may exit after
the daemon accepts the prompt. Detached describes launch lifecycle, not a
second public mode. The legacy top-level `orchestrate: {...}` transport remains
accepted on ingress and is canonicalized to this driver mode; new calls use
`runs: [{ mode: "driver", ... }]`. This decision follows the naming reviews in
#144, #330, and #359.

## What gets registered

### Tools

- `delegate` — the main delegation tool. One dispatch is a list of runs:

  ```js
  delegate({
    runs: [{
      name?,      // addressing key for steer/cancel/recover; auto #N dedup
      agent,      // agent definition name
      task?,      // required unless `after`-gated (then defaults to "{previous}")
      mode?,      // "solo" (default) | "supervised" | "driver"
      after?,     // string[] | "previous" — solo only; orders runs into layers
      count?,     // solo-only fan-out
      rounds?,    // supervised-only: total worker-message budget, including exact first turn
      clone_mode?,// supervised-only: "full" | "snippet" | "task_only"
      task_delivery?, // supervised-only: exact caller task first (default) | supervisor-composed first turn
      model?, cwd?, env?, skills?, thinking?, depth?,
      artifact?, reads?,              // solo/chain-only
      progress?,                   // direct/chain writes; supervised ignores and warns once
      interactive?, worktree?, escalation?, handoff?,
    }],
    task?, await?, concurrency?, failFast?,
    cwd?, model?, thinking?, skills?, env?,
    chain?,       // saved `.chain.md` template, by name
    chainDir?, handoff?,
  })
  ```

  One dispatch is all-solo (optionally `after`-ordered), all-supervised, or
  exactly one `driver` entry; mixed modes reject. Most invalid mode/field
  combinations reject with a pointer-quality error; a few are accepted and do
  nothing. See the mode/field matrix in
  [`docs/delegate-tool-api.md`](docs/delegate-tool-api.md) for which is which.


  A supervised run sends the caller's exact `task` to the worker as its first
  turn by default, then gives the supervisor that completed exchange to review.
  Set `task_delivery: "supervisor-mediated"` only when the supervisor should
  compose the worker's first instruction.
  - `{action: "list"|"get"|"create"|"update"|"delete"|"canonicalize"|"health"}` — manage agent / chain definition files, canonicalize an agent file, or inspect delegate health.
- `delegate_control` — inspect and steer dispatched runs, by `action`:
  - `status` — list active/completed dispatched runs.
  - `result` — re-fetch the collapsed output of a run by `runId`.
  - `prompt_status` — read a daemon driver's durable prompt outcome without a lease.
  - `steer` — guide an explicit supervised run's copied supervisor `fork`, or an
    authenticated detached `driver` through its control route. Direct workers,
    chain steps, and unknown in-process shapes reject steering.
  - `follow_up` — queue a daemon-driver instruction after its current turn.
  - `ui_answer` — answer one correlated daemon-driver extension question.
  - `cancel` — abort one run (or the whole dispatch); authenticated detached
    drivers use their authenticated control route.
  - `recover` — relaunch one failed worker entry or recover an interrupted daemon driver. Foreground-only.
- `delegate_escalation` — handle durable escalations, by `action`: `list`,
  `resolve`, `pass_up`.

Both are **state-gated**: they are registered only once there is something to
control, so a session that never delegates pays nothing for them. The eleven
tool names they replace (`delegate_status`, `delegate_result`,
`delegate_prompt_status`, `delegate_steer`, `delegate_follow_up`,
`delegate_ui_answer`, `delegate_cancel`, `delegate_recover`,
`delegate_escalations`, `delegate_resolve_escalation`, `delegate_escalate`) remain accepted in a `tools:`
allowlist as aliases, and remain the internal invoke keys used by the
programmatic runtime API.

### Skills

The package ships skills under `skills/`. Pi picks them up from the `pi.skills`
manifest entry; agents load them by name.

| Skill | Loaded by | Covers |
| --- | --- | --- |
| `pi-delegate` | any agent using the tools | tool surface, parameters, background wakes, steering, escalation |
| `orchestrate-work` | an orchestrating agent | splitting a job into concurrent lanes, branch-per-lane worktrees, dispatch briefs, serialized integration, nesting |
| `merge-coordinate` | the `integrator` agent | applying finished lane branches or patches onto one branch by squash/merge/cherry-pick, with preflight and refusal rules |
| `authoring-delegate-agents` | any agent writing an agent `.md` file | discovery scopes and precedence, prompt-mode and tool-surface decisions, which fields apply to which shape, and the failure modes that make an agent file vanish |

Attach a skill at dispatch time when the agent doesn't declare it, for example
`{ agent: "worker", skills: ["merge-coordinate"] }`.

The worker-contract skills `implement`, `implement-typescript`,
`implement-python`, `implement-rust`, and `implement-frontend` are **not**
shipped here. Install a package that provides those skills and its associated
`implementer`, `integrator`, `planner`, `reviewer`, and `scout` agents if your
workflow uses those roles.

### Slash commands

pi-delegate registers exactly four slash commands:

- `/delegate` dispatches work or runs a management form.
- `/delegate-cancel` picks or addresses live delegated work to cancel.
- `/delegate-inspector` opens or refocuses the transcript inspector.
- `/delegate-help` shows the same help as bare `/delegate` and `/delegate --help`.

Dispatch grammar:

```text
/delegate TASK [--direct | --fork | --supervised | --chain NAME] [--agent NAME] [--foreground | --fg] [--worktree] [--model MODEL] [--thinking LEVEL] [--skill NAME ...] [--cwd PATH]
```

Cancellation grammar:

```text
/delegate-cancel [RUN_ID [ENTRY]]
```

`RUN_ID` identifies a dispatched batch. `ENTRY` is its canonical run-entry name.
Omit both to pick from live entries and detached drivers. Supply both to cancel
exactly one entry without confirmation. Supply only `RUN_ID` to confirm cancellation
of every live entry in that batch. Picker dismissal leaves every run unchanged.

Syntax notation:

- `TASK` is your work request and must come first. Quote it when its ending looks like an option.
- `[ ... ]` is optional.
- `A | B` means choose one alternative.
- `NAME`, `MODEL`, `LEVEL`, and `PATH` are values you supply.
- Repeating `--skill` adds another skill. `--foreground` and `--fg` mean the same thing.

`/delegate TASK` uses direct mode with the built-in `delegate` worker. It dispatches in the background and explicitly sends `await: false`. Bare `/delegate` shows help. Add `--foreground` or `--fg` only when the current turn must wait for the result.

Mode selectors:

| Selector | Behavior | Runtime presentation |
| --- | --- | --- |
| omitted or `--direct` | Run one worker without a supervisor. This is the default. | ` direct` |
| `--fork` or `--supervised` | Give one worker a private supervisor that can iterate with it. These selectors are equivalent. | ` supervised` |
| `--chain NAME` | Run a saved sequential worker pipeline. | ` chain` |

Background work returns immediately and wakes the session later. Help renders it as ` background`. Incomplete or future run metadata uses ` unknown`. Set `footerIcons` to `"unicode"` for a terminal whose font is not patched with Nerd Font glyphs, or to `"ascii"` for text-only labels; `PI_DELEGATE_ASCII=1` and `TERM=dumb` force `"ascii"`. The setting covers the footer, the widget, and the transcript overlay.

Worker options:

| Option | Behavior |
| --- | --- |
| `--agent NAME` | Select a discovered worker instead of built-in `delegate`. |
| `--worktree` | Give the worker an isolated Git worktree. |
| `--model MODEL` | Override the worker model for this dispatch. |
| `--thinking LEVEL` | Select a supported thinking level. |
| `--skill NAME` | Add one skill; repeat the option to add more. |
| `--cwd PATH` | Set the worker or saved-chain working directory. |
| `--foreground` / `--fg` | Send `await: true`; omission sends `await: false`. |

`--agent` completion proposes discovered workers. `--chain` completion proposes saved chains. A saved chain keeps its authored worker settings, so `--chain NAME` permits only `TASK`, `--cwd`, and foreground control.
`/delegate-cancel` completion proposes unique live run IDs first, then canonical entry names for the selected run.

Management forms must be used alone:

- `/delegate --agents` lists discovered workers.
- `/delegate --chains` lists discovered saved chains.
- `/delegate --health` shows runtime health.
- `/delegate --help` shows command help.

Validation happens before dispatch. Mode selectors are mutually exclusive. `--worktree` conflicts with `--cwd`. Unknown options, missing values, duplicate selectors, unsupported thinking levels, unknown workers or chains, malformed quotes, and options incompatible with `--chain` produce a visible error and start no work. There is no `--bg` because background dispatch is the default.

Examples:

```text
/delegate Review the authentication changes
/delegate "Review text ending in --foreground"
/delegate Review the change --fork --agent reviewer --thinking high --skill code-review
/delegate Summarize the repository --chain discovery-report --cwd /repo --fg
/delegate-cancel
/delegate-cancel RUN_ID ENTRY
/delegate-inspector
```

Inline chain and parallel construction remain available through the `delegate` tool API, not the slash interface.

### Shortcuts and UI

- Shortcut `Option-O` / `Alt+O` toggles the transcript inspector. `Ctrl+Alt+D` remains registered by default as a fallback for terminals where Option is not configured as Meta. Configure that fallback with `overlayShortcut` in `~/.pi/agent/config/pi-delegate/config.json`. Set it to `""` to disable both shortcuts and use `/delegate-inspector`.
- The below-editor **status widget** shows one status line per active run across every active run, with a compact rolling token/cost total and an optional indented activity summary line.
- The footer **activity ticker** shows aggregate liveness counts for immediate foreground-owned runs under `01-delegate-activity`, separate from the `00-delegate-usage` token/cost status. Per-run activity stays in the status widget. See [Activity ticker](docs/activity-ticker.md).

### Retrying a failed run

A fresh ordinary dispatch may declare an exact predecessor:

```json
{
  "runs": [{
    "agent": "reviewer",
    "task": "Retry with the corrected task and cwd.",
    "cwd": "/workspace/project",
    "retryOf": { "runId": "run-123", "forkName": "reviewer" }
  }]
}
```

`retryOf` is also accepted on supervised `runs` entries and parallel-direct
`runs` entries:

```json
{
  "runs": [{
    "name": "reviewer-retry",
    "agent": "reviewer",
    "task": "Review the corrected implementation.",
    "cwd": "/workspace/project",
    "retryOf": { "runId": "run-123", "forkName": "reviewer" }
  }]
}
```

For a parallel-direct batch, put the same field on one `runs` entry. Claims are
validated together, so distinct predecessors can be retried atomically. Only
`failed` or `aborted` predecessors qualify, and `count > 1` is rejected. Use the
exact stored `forkName`; display labels, task text, agent names, and similarity
never match. One predecessor has one direct successor, and longer chains receive
stable `attempt` numbers. Each attempt keeps its own result/history/transcript/session/usage/cost. The
widget alone retires a valid predecessor's ambient row, and only once the
replacement is itself visible in the same session; a replacement running in
another session leaves the predecessor on screen, because it is that operator's
only sign of the lane. Unresolved lanes stay visible, and completed rows retain
the existing ten-second grace. The surviving row carries the attempt number
where the width allows — `attempt 3` on a wide row, `#3` on a compact one — and
is the first chip dropped when it does not.
Cumulative lane totals are shown even when the current attempt has zero usage,
while run/session/global accounting remains attempt-local. Admission refuses a retry
that would exceed the 24-attempt retention-safe chain bound with the structured
`invalid-attempt` reason; public retry projections are separately capped at 32 entries
and report `retryMetadataIncomplete` or `retryMetadataTruncated` when needed.
Unsafe hydrated links are quarantined and fail closed without hiding their rows.
Status, result, synchronous completion, live wakes, and durable redelivery use
the same privacy-safe projection. Chain steps, saved chains, `driver`, and
`delegate_recover` do not use `retryOf`.

## Background dispatch vs awaiting completion

By default, every ordinary `delegate` shape returns **immediately** with a
dispatch envelope containing a `runId` and shape-specific metadata; the work
keeps running in the background and
the main agent continues its turn. When all runs complete, the extension
injects a `custom_message` entry and triggers a new turn, so the main agent
receives the combined output as if it were a user message.

Nested coordinators remain alive while their owned in-process children are
unfinished. A child completion wake starts a fresh harvest window: the
coordinator must return one self-contained synthesis after the wake, and earlier
progress is not spliced into that final result. Cancellation, provider failure,
queued input, and session shutdown retain their normal escape paths; shutdown
aborts unfinished owned children. A failed wake send leaves the coordinator
parked until successful redelivery or cancellation (including its worker deadline);
persisting a wake alone does not authorize harvesting earlier progress.

### Early worker-failure wakes and recovery

A bounded `delegate:fork-failed` wake is emitted as soon as one background run
reaches terminal failure. **This is enabled by default** (`notifyOnFailure: true`).
Set `notifyOnFailure: false` on a call or in
`~/.pi/agent/config/pi-delegate/config.json` to opt out and get aggregate-only
behavior. Healthy siblings continue; this wake never replaces the normal
exactly-once `delegate:complete` aggregate wake. The payload includes the
`runId`, `forkName`, categorical `reason`, sibling statuses, and whether targeted
recovery is available. Failure payloads never include free-form errors, task
text, prompts, transcripts, paths, URLs, environment values, or worker output.

Recovery descriptors are always captured for accepted direct and supervised
runs; `notifyOnFailure: false` only suppresses the early wake — recovery is still
available after the aggregate. When `recoveryAvailable` is true (or after the
aggregate when a descriptor exists), use
`delegate_control({ action: "recover", runId, forkName, strategy: "auto" })`. An optional `message`
provides redacted, bounded guidance without fabricating prior-attempt state.
Recovery dispatches an **independent child run** with its own `runId` and
completion wake — the original batch is never delayed or mutated. `auto` tries
`resume` (new child seeded only with a categorical failure kind, whether partial
output existed, and bounded categorical tool-activity facts) if available,
otherwise falls back to `fresh` (exact original config,
no prior context). `strategy: "resume"` fails closed when no safe context exists;
`strategy: "fresh"` always dispatches an exact redispatch. Recovery preserves
all applicable original user-facing invocation settings, including explicit
false/zero values (agent, task, model, thinking, skills, env, worktree,
agent_scope, `notifyOnFailure`, etc.) — the recovery child gets a new clean
worktree if `worktree: true` was set (original worktree filesystem contents are
not preserved). Recovery descriptors are still captured when the preserved
notification policy is `false`, so a failed recovery remains recoverable after
its aggregate. Recovery is idempotent per run,
does not cancel healthy siblings, and is unavailable for a halted chain step.
Recovery is also supported after the original aggregate has completed while the
original live process and dispatching foreground session still own the in-memory
descriptor. Hydrated, reloaded, replacement-session, and durable pending wakes
fail closed and never advertise live recovery.

Optional recovery guidance is user-supplied, redacted as defense in depth, and
UTF-8-byte-bounded. Generic credential regexes are not treated as a secrecy
boundary; prior-attempt context is safe by categorical construction instead.

Set `await: true` only when the delegate result is a prerequisite for the
originator's next action. This blocks the tool call until all runs finish and
returns the combined output as the current tool result. It also monopolizes the
originating turn, so the normal conversational path cannot accept new run-control
or coordination instructions until completion; specialized UI
controls may still be available. `sync: true` remains a deprecated compatibility
alias. Omitting both `await` and `sync` always dispatches in the background;
conflicting explicit values are rejected.

Dispatch runtime state is also written to
`~/.pi/agent/extensions/pi-delegate/run-state.json`. In an interactive TUI,
typing `/reload` while this process owns live in-process delegate runs is
blocked with a warning; wait for the runs to finish or cancel them through
`/delegate-inspector`, then retry. This guard is intentionally limited to the
interactive `/reload` submission path because Pi does not yet expose a
cancellable pre-reload lifecycle event. Pi also exposes only one cooperative
custom-editor factory slot: pi-delegate wraps the factory already configured
when it installs the guard, but a later editor extension that replaces the slot
without wrapping `getEditorComponent()` can supersede it. Installing the guard
preserves the current editor text, but Pi does not expose editor-history state
to wrappers, so in-memory prompt history may reset. Programmatic `ctx.reload()`
calls and other session replacements (`/new`, `/resume`, `/fork`, or quit) still
abort in-process work. In those cases, `delegate_control(action="status")` hydrates the durable
registry and surfaces the run as an aborted orphan instead of forgetting the run ID or
pretending it is still running. Worker session JSONL paths recorded before the
replacement remain visible for debugging. Detached driver children do
not trigger the guard and survive foreground reload / rotate / compact /
shutdown.

Reasons to pick one or the other:

| Mode         | When to use                                                                                                 |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| background   | Default. Keep the originator responsive for independent work, cancellation, and steering where supported; completion automatically wakes it. |
| `await:true` | Explicit dependency barrier: the next action requires this result and blocking the normal conversational control path is acceptable. |

Daemon drivers are the exception: they reject `await`, return after durable acceptance, and resume through `delegate_control` `prompt_status`/`result`.

## Escalation

Escalation lets an enabled worker raise a structured decision, blocker, or
amendment up its accountability chain instead of guessing. In supervised mode
the fork supervisor gets the first chance to resolve within declared authority
or pass the request upward; silent root hops are skipped, and the user is the
final authority. Direct workers route through the root when it is an authority
or opted-in intermediate, otherwise directly to the user.

Only the raiser's tool call is held, with no model-token burn while it waits;
a supervised worker channel reports `awaiting-escalation`, while direct mode
has no supervisor channel. Other hops sleep with durable state only and wake
briefly to resolve or pass. Interactive user-held requests can use a lease-arbitrated
native prompt; the root agent can list, resolve, or forward durable requests
with `delegate_escalation` and its `list`, `resolve` and `pass_up` actions.

Escalation is strictly opt-in (`mode: "local"`). Because delivery requires a
responsive background chain, preflight rejects `await: true` or `sync: true` if
any slot is escalation-enabled. See [Delegate escalation](docs/escalation.md)
for schemas, authority, routing, configuration, timeout defaults, rollout, and
current limitations.

## Observing running runs

Dispatched runs show up in three complementary places:

1. In eligible interactive foreground sessions, the default-on deterministic
   **activity ticker** appears in Pi's footer under `01-delegate-activity`. It
   always shows aggregate liveness, such as `1 delegate live` or
   `2 delegates live`; it never repeats a run identity, terminal outcome, or
   headline from the widget. Terminal-only state clears the footer, and mixed
   state reports only the currently live count.
   It neither replaces Pi's footer nor changes the separate `00-delegate-usage`
   token/cost status. Generated per-run headlines are opt-in: omitting
   `activityTicker.model` guarantees zero ticker provider calls, zero ticker-model
   cost, and zero provider-bound ticker egress; an explicit `provider/model`
   fixes the destination, while model `"auto"` selects only the built-in
   `anthropic/claude-haiku-4-5` destination and fails closed when it is
   unavailable. Headlines are displayed by the status widget, not duplicated
   in the footer. See [Activity ticker](docs/activity-ticker.md) for privacy
   exclusions, concurrency/timeout defaults, usage attribution, headless/child
   boundaries, and terminal cleanup.
2. A **below-editor status widget** with one status line per active run and an
   optional indented activity summary line beneath it. Supervised status rows
   use short `S` and `W` labels when each actor has useful activity, for example:

   ```text
    ◆ reviewer(review)  W using read 4s · 1/5 · …
      checking dispatch coverage
   ```
   When a run carries a durable task list, the wide layout gives that run's
   existing indented detail-row slot to its bounded task aggregate and current
   title:

   ```text
    ◆ implement(lane-a)  W working · running 4m · 12k/$0.03
      ☑ 2/5 · ▸ Wire the runner
   ```

   A blocked list reads `☑ 2/5 · ⚠ 1 blocked` without relying on color. ASCII
   mode uses `tasks 2/5 | ! 1 blocked`. Compact and narrow layouts keep only the
   count when a detail line does not fit. The title comes only from the bounded
   `taskProgress.active` field; task rows do not carry titles, and the widget
   does not read worker sessions or transcript prose to recover them. A run
   without a durable task list keeps its prior rendering unchanged. Task detail
   uses the same summary indentation and one-detail-row slot as activity, so it
   does not add a third line to a run or create a separate nesting policy.
   The routine `S waiting for worker` state is omitted so it cannot crowd out
   the worker phase, usage, or activity headline. Direct workers and chain steps show
   only `W …`; they never invent a supervisor. Prompt waits identify `confirm`,
   `select`, or `input`, while
   escalation, steering, restart, finish, and terminal outcomes use explicit
   text rather than color alone. Queued guidance appears as a separate
   `U guidance queued` fact without replacing the supervisor's real
   phase. Terminal outcomes stay run-level because runtime state does not
   identify a per-actor terminal cause.
   The rolling usage chip totals supervisor-clone usage (when supervised),
   worker usage, cache tokens, and any activity-ticker usage attributed to that
   run. On narrow terminals the `◆N active` status projection selects one
   labelled live phase without implying that every run shares it and keeps
   terminal-only aggregates distinct. When it represents one run, its bounded
   headline can use an indented second line.
   Actor, prompt, transcript, guidance, escalation, headline, and terminal
   changes request immediate renders; the 10-second refresh only keeps elapsed
   times moving. At every width, actor labels outrank rounds and message counts,
   and rows remain bounded with long names and zero-width layouts. Set
   `PI_DELEGATE_ASCII=1` (or use `TERM=dumb`) for ASCII status glyphs. The
   short-lived actor projection retains only bounded tool names made from
   letters, digits, dots, underscores, and hyphens. It never retains tool
   arguments/results, prompt or guidance bodies,
   escalation payloads, model reasoning, or internal call ids. Existing
   deterministic headlines may still show bounded, redacted local tool metadata
   under the documented activity-ticker privacy boundary. Supervised control
   tools such as `wait_for_worker` do not replace or suspend the worker-focused
   deterministic or model-generated headline. The widget keeps live and paused
   rows visible. Completed rows remain for 10 seconds, aborted rows for 30
   seconds, and failed rows for 5 minutes, then retire from the ambient
   projection. One width-safe current-session summary retains succeeded, failed,
   and aborted terminal run totals after retirement; wide layouts may include
   `/delegate-inspector`, with compact labels and ASCII separators used when space
   or terminal mode requires them. This summary is display-only: results,
   transcripts, worker session references, diagnostics, usage, costs, and durable
   history remain available through `delegate_control` action `status` and
   `/delegate-inspector`.
   The widget self-detaches when no visible rows or retired outcomes remain.
3. A **keyboard-driven explorer overlay** (`Option-O` / `Alt+O`,
   `Ctrl+Alt+D`, or `/delegate-inspector`)
   that opens as a centered modal with two panes: a **run list** on the left and
   a **detail pane** on the right. The list is one inventory of the runs admitted
   by the current visibility mode, grouped by run, with detached drivers under a
   final `detached` group. Runs are ordered by **when `delegate` was called**, oldest
   first, and each run heading carries that time as `HH:MM`. The below-editor
   widget uses the same order. Selecting a row expands that run's summary; `Enter` opens its
   transcript. The summary level shows **every delegate at once**: the selected
   one in full, the rest as short cards carrying health, rounds, consumption,
   and the current activity headline. Moving the selection expands the new
   block and collapses the old, and the expanded block is marked with a gutter
   bar so the cue survives any palette.

   `attention` is the default visibility mode. It shows every in-flight row plus
   terminal `failed`, `aborted`, and `paused` rows that still need notice. A completed
   row with an unresolved worker prompt stays visible too. `live` shows only
   in-flight work. `all` also shows clean completions, including detached
   runs that ended normally or by steering. Press `f` to cycle `attention` → `all` →
   `live` → `attention`; the wide footer names the active mode. The choice survives an
   overlay close/reopen in the same Pi session, while a new session starts at
   `attention`.

   A run whose worker entries have **all completed** recedes to grey — heading, identity,
   and summary card — on the overlay and the below-editor widget alike, so
   finished work stops competing with what is still running. Only a clean
   success recedes: a run holding a `failed`, `aborted`, or `paused` worker entry stays
   at full contrast, because a problem does not matter less for having stopped.
   Status glyphs keep their own colour throughout, so a grey row still says how
   it ended. Below roughly 90 columns the modal drops to a single column and
   steps list → summary → transcript instead, which is also what
   `inspectorLayout: "dock"` renders. One column has no left pane, so the
   **list level draws the run list itself** and `Enter` opens the selected
   run's summary. A registered run with no worker entry shows one
   selectable `constructing` placeholder. `Enter` remains disabled until its first
   worker appears.

   The list is **as dense as it needs to be**. When the inventory is taller
   than the space it has, the blank row between runs and each entry's generated
   activity headline go, which roughly halves its height; the selected row
   keeps its headline, and a row reporting `paused`, `failed`, `aborted`, or
   `awaiting escalation` keeps that, because the status glyph does not
   distinguish those from `running`. When the list still does not fit, the
   **pane divider carries a scrollbar** so a crowded session says how much is
   off screen rather than looking complete.
   Selection scrolling keeps the whole selected row inside the viewport, including
   its second-line activity headline when the final row is at the bottom.

   The header spends two rows on content rather than navigation: **identity**
   (status, agent(task label), model, shape, rounds, elapsed) then **policy**
   (`writes`/`read-only`, worktree branch, skills, clone mode, heartbeat budget).
   The run id, run counter, view name, and run strip are gone — the left column
   already answers them.

The summary pane reports lifecycle and activity facts, health, bounded friction,
rounds, elapsed time, tokens, and cost. These are observed consumption, not
remaining time or an ETA. Heartbeat health applies only to a supervised fork
with an open final worker round and an enabled, effective heartbeat budget. The
fork becomes slow after one effective heartbeat interval and stalled after the
heartbeat interval multiplied by the maximum consecutive heartbeat count.
Terminal lifecycle and blocked states out-rank slow and stalled; an unresolved
worker tool remains moving.

Detached driver runs are **events, not a transcript**. They are still
never fabricated as transcript forks: `Enter` on a detached row opens its status
card, and `Enter` again opens an explicitly-labelled **event log** — timestamped
records of what that process reported, with no speaker headings and no chat
framing. Every field shown passes an allow-list, so a detached agent name and a
control secret never reach the screen. Detached-only and mixed
foreground/detached views use the same canonical status fields, warning wording,
and inspection hints.

A detached driver carrying `handoff.tasks` uses the same structured-seed seam as
in-process workers. After lifecycle registration and final tool selection, the
authoritative child writes `context-aware.tasks.v1` before its first model request
when its active scope contains a usable `session_tasks` claimant. Otherwise it
injects the assignment once as Markdown. These paths are mutually exclusive.
The owner-only detached cfg retains the bounded seed so replacement and recovery
preserve it without duplicating a snapshot in one child session. Detached status,
automatic completion wakes, and `delegate_control(action="result")` expose the
bounded terminal task ledger.

The detail pane also carries a **plan block** when a run has seeded a task
list. It starts in compact mode with the `☑done/total` count, warning-coloured
when anything is blocked, the active task's title, the first blocked reason, and
a status strip with one glyph per top-level task. Press `p` to toggle an
expanded list of every available real task title and status, including nested
steps. The additive version-1 progress fields stay compatible with older
sessions: a legacy row without a title is reported as unavailable rather than
being given an invented name. A new Pi session starts in compact mode.
When every owned run has finished, a **completion banner** reports
`succeeded / failed / aborted` in the footer slot the live count occupies while
work is in flight. The overlay stays open: `autoCloseInspectorOnComplete`
defaults to `false` so a just-arrived result is not dismissed before you read it.

The overlay **takes itself off screen when the main thread takes the keyboard**.
It is a capturing overlay, so a prompt that needs you — an escalation above all
— renders underneath it and holds the keys: without this you would get a
question you cannot see and an inspector that answers nothing, including `q`.
Delegate's own escalation prompts hide the inspector *before* asking and restore
it once you have answered, so a question costs you the prompt and not your
place. Anything else that takes focus hides it with a note saying so; bring it
back with `Option-O`, at the scroll position and selection you left.

It hides rather than closes because resolving its host promise would make pi
dismiss whatever overlay is *topmost*, which on that path is quite likely the
prompt rather than the inspector. **Every** way the inspector goes away — `q`,
`Esc`, `Option-O`, auto-close, reopen, disposal — removes its own stack entry
by identity instead, and nothing resolves that promise. Being focused does not
make it topmost: pi shows an overlay without giving it focus when the overlay
asks not to capture input, so a panel above the inspector can hold no focus at
all.

Markers throughout the overlay follow `footerIcons`, the same setting the footer
and the below-editor widget use: `"nerd-font"` (the default, and the only tier
that gives each speaker its own icon), `"unicode"` for a terminal whose font is
not patched, or `"ascii"`.

| Key            | Action                                                                 |
| -------------- | ---------------------------------------------------------------------- |
| `Enter`        | Open the selected row: summary, then transcript (or event log). At the transcript, expand the node at the top of the viewport |
| `Esc`          | Ascend one level, returning focus to the list; close from the top        |
| `q`            | Close from any viewing level                                             |
| `←` / `→`      | Move focus between the list pane and the detail pane                     |
| `Tab`/`Shift+Tab` | Move focus between panes; `Tab` advances while composing               |
| `l`            | Jump to / cycle through every live run                                  |
| `f`            | Cycle inventory visibility: attention / all / live                     |
| `↑` / `↓`      | Move the list selection, or scroll the detail pane and pause auto-follow |
| `PgUp`/`PgDn`  | Page the list selection, or page-scroll the detail pane                  |
| `Home` / `End` | First/last row; detail-pane top/bottom (`End` resumes follow)            |
| `t`            | Cycle transcript thinking nodes: preview (default) / full / hidden       |
| `g`            | Cycle transcript tool nodes: chip (one-line default) / hidden / expanded |
| `s`            | Compose a message for the selected supervised fork; skip all pending prompts when a prompt banner is active |
| `m`            | Change compose delivery mode before typing (supervised runs only)        |
| `Backspace`    | Delete the previous character while composing                            |
| `x`            | Start cancellation confirmation for the selected live run               |
| `y` / `n`      | Accept / reject the active cancellation or worker-prompt confirmation    |
| `r`            | Manual refresh                                                           |

The left column lists every run entry admitted by the current visibility mode.
Live work appears in all three modes, so it is never hidden behind a selection;
the footer carries an `N live` count and `l` jumps to it. Detached drivers are
deliberately **not** fabricated as transcript forks: the overlay refreshes their
durable active-index/cfg/event-bus/result
projection once per second and shows run state, wall-clock elapsed time, last
event-bus activity, runner/activity PID, a whitelisted phase, and a categorical
terminal reason code. Owner-partitioned active markers are read before bounded
history, so old/foreign cfgs cannot hide a current live run; any remaining
truncation is reported explicitly. Stale durable-terminal markers are reclaimed
without consuming the live-row budget, while abrupt-death markers retain a
fixed-width runner-PID slot for cfg-only crash reconciliation. Event reads use a
bounded tail cached once per root per refresh; independent one-byte categorical
terminal fact sidecars preserve paused/steered semantics outside that tail even
when separate processes write the two facts concurrently. Rounds are labelled
separators inside the transcript carrying their tool and error counts, rather
than a level of their own; opening a transcript starts at the bottom with
auto-follow enabled. A detached-only session therefore gets an explicit
`detached drivers` section instead of the misleading “No delegate runs”
placeholder. The same canonical formatter backs `delegate_control(action="status")`, so those two
surfaces agree; arbitrary event fields, raw terminal errors, prompts, and control
credentials are never rendered or attached to completion/status details (raw
failure detail remains available through `delegate_control(action="result")`). The overlay tails new supervisor/worker messages
automatically while it's at the bottom; scrolling up pauses auto-follow (`○`) and `End` resumes it
(`●`). Ambient terminal rows retire after their fixed display windows, but the
full current-session history and results remain inspectable. The footer activity
ticker is intentionally lossy and immediate-run-only; the transcript
inspector and `delegate_control` remain the
authoritative inspection and control surfaces. Each changed visible headline is
also retained in a bounded, timestamped per-run activity history. The separate
`delegate:activity-status` event refreshes the inspector without inserting a
synthetic transcript message or retriggering ticker scheduling. History survives
runtime persistence and reload for live and recently completed runs. The ticker's
`awaiting-escalation` lifecycle truth reports that the raiser's worker channel is
suspended without model-token burn while its durable request is pending; it does
not imply that any supervisor or root agent is executing. Descendant/detached
cross-process activity is not represented by the v1 ticker.

The structured transcript always keeps conversational nodes visible. Thinking
starts as exactly 150 source characters plus one trailing ellipsis when the
trace is longer, and tool calls start as one-line
chips. Thinking and tool detail are independently adjustable with `t` and `g`,
so inspecting a tool trace does not require changing the whole transcript
projection. The `t` and `g` choices survive overlay close/reopen within
the same Pi session. A new Pi session starts from the configured inspector
defaults instead of sharing the previous session's mutable choices.

Each block of transcript prose carries a **speaker heading** naming who is
talking to whom, and that heading is pinned to the top of the pane while the
block scrolls past, so attribution survives scrolling into the middle of a long
message. The heading reflects the real speaker rather than only the session an
entry was captured from. In a supervised worker session, a `user` message is the
supervisor's instruction and is labelled `supervisor → worker`; in a direct or
chain worker session it is labelled `main thread → worker`, because those shapes
have no supervisor and never invent one.

Long **finished** messages fold to a bounded preview with a `⋯ +N lines`
marker, so one large prompt cannot fill the viewport. The newest message is
never folded, so live streaming output always stays whole. Folding is always on;
`Enter` expands the one message or tool result you select.

### Steering a supervised worker

Explicit supervised runs can be nudged mid-flight through the copied supervisor
`fork`. Authenticated detached drivers support driver-level steering through their
control route. Direct workers and chain steps do not support steering, and unknown
in-process shapes reject it; none advertise compose controls or the otherwise-hidden
`s` and `m` shortcuts. For a supervised fork, steering is available from the LLM
side (via `delegate_control(action="steer")`) or directly from the overlay:

1. Open the overlay (`Option-O` / `Alt+O`, or `Ctrl+Alt+D`), select the supervised entry with
   `↑`/`↓`, or `l` to jump to live work.
2. Press `s` to enter the compose box, type a message, `Enter` to send.
3. Before you start typing, `m` cycles the delivery mode. **The mode chooses the
   recipient, not just the timing**, and the compose box names it:

   | Mode       | Reaches        | When                                          |
   | ---------- | -------------- | --------------------------------------------- |
   | `push`     | the supervisor | interrupts its current turn                   |
   | `followUp` | the supervisor | after its current turn finishes               |
   | `queue`    | the **worker** | verbatim, at the top of the worker's next round |

   Once you're in the compose box, letters type literally — including `m`.

Because the fallback ladder can change the rung a message takes, the
confirmation and the transcript stamp report the recipient the message
*actually* reached (for example `→ worker, queued`), not the one requested.
A successful queue fallback may also carry diagnostics from earlier failed
rungs; the overlay records both the queued delivery and that fallback note. If
the steering call rejects, its wiring is missing, or the selected shape refuses
steering, the transcript instead records **not delivered**, the reason, and the
original message. It never turns that failure into a queued or delivered
success line.

The extension runs a best-effort fallback ladder: `cloneSession.steer()` first
(when the supervisor is streaming) → `cloneSession.sendUserMessage("followUp")`
→ queue onto the fork's `pendingGuidance[]` which the `message_subagent`
clone tool prepends as a `<user-guidance>` block on the supervisor's next
instruction. The overlay transcript shows which rung the message took.

Use steering sparingly — frequent interruptions defeat the purpose of
delegation; prefer waiting for completion unless the supervised session is clearly off-track.

### Cancelling delegated work

Delegated runs can be aborted at any time:

- From the command line: `/delegate-cancel` opens a live-target picker;
  `/delegate-cancel RUN_ID ENTRY` cancels one exact entry immediately; and
  `/delegate-cancel RUN_ID` asks before cancelling the whole batch. Use quotes when
  an entry name contains spaces. All three forms use the same runtime cancellation
  and detached-control routes as `delegate_control`.
- From the overlay: press `x` on the selected run, then `y` to confirm
  (or `n`/`Esc` to back out). The selected run transcript gets a `✖ cancelled by
  user` entry, and the run status becomes `aborted`.
- From the LLM: `delegate_control({ action: "cancel", runId, forkName?, reason? })`.
  Omit `forkName` to cancel every still-running delegated entry in the batch.
- Auto-timeout: set the optional global `perForkMaxDurationMs` in `config.json`
  to enforce an absolute ceiling. It defaults to `0` (disabled), so active
  workers are not killed at the legacy 60-minute wall. `perForkMinDurationMs`
  defaults to `0`; a positive value is a global floor that raises only a
  stated positive selected duration. Resolution selects
  invocation over agent over global, applies the positive ceiling, then applies
  the positive floor only to that stated positive selection. Explicit zero and
  no selected duration remain unlimited when the floor is the only positive
  bound. A positive floor above a positive ceiling is diagnosed and ignored.
  Agent definitions may set `max_duration_ms` / `wind_down_grace_ms`, and any
  solo or supervised run entry may override them. A positive global value remains
  an operator ceiling and cannot be relaxed by a worker. With the default
  `enforceWallClockBudget: false`, caller- and agent-supplied budgets still
  trigger the one-shot wind-down and grace period but do not hard-cancel; set it
  to `true` to enable hard cancellation after grace. Timeout cancellation still
  records `cancelReason: "timeout"` after the existing one-shot wind-down
  steer and grace window. Hard timeouts retain bounded live transcript/tool
  observations and assistant checkpoints in the existing `collapsedContent`
  field; `recoveredOutput` is true only when assistant output exists, and no
  session JSONL is read for salvage.

`Esc` keeps its local UI meaning: it interrupts the current foreground Pi turn,
ascends or closes the inspector, and backs out of an inspector confirmation. A
background delegation no longer owns the main turn after dispatch returns. Use
`/delegate-cancel` when the cancellation target must be explicit and deterministic.

Cancelling aborts the addressed delegated entry: both the supervisor and worker
`AgentSession`s for a supervised fork, or the worker session for a direct worker
or chain step. It resolves any blocking worker-UI prompts with their default
(confirm→false, select/input→undefined). The completion wake-up still fires so
the main agent sees the batch finish.

### Interactive workers

By default, workers run with `ctx.hasUI === false` inside worker tools —
blocking UI prompts from `command-guard` and similar extensions are
auto-denied, matching non-interactive CLI behaviour. Non-interactive direct
workers also apply a separate 30-minute deadline to each inherited extension
tool invocation whose name is not `ask`. An explicitly granted nested call is
bounded by the lesser of 30 minutes and half the positive remaining parent
budget; with no positive remainder it fails before execution and tells the
caller to commit and push before another attempt, or rerun without nesting.
A nested call that started and then hit that cap reports that it started and
may have partially run, so inspect its side effects before retrying.
If that deadline expires, the direct worker fails with a deterministic error and
any later completion or progress from that invocation is ignored.

This deadline does not apply to built-in tools, `ask`, interactive workers, or
supervised workers. It does not disable extension loading, provider
authentication, request routing, or the outer run timeout setting. Opt in
per-run by setting `interactive: true` on the agent entry:

```js
delegate({ runs: [{ agent: "writer", task: "...", interactive: true }] });
```

When enabled, blocking calls inside the worker (command-guard confirms,
extension `select`/`input`) route to the overlay as a **prompt banner**
above the compose box:

```
⚠ worker wants to run: <title>
  approve? [y] yes [n] no [s] skip-all (auto-deny in 60s)
```

`y` approves the top prompt, `n` denies it, `s` denies every queued prompt
*and* flips the worker back to non-interactive for the remainder of its run.
If nobody answers within 60 s the prompt auto-denies.

## Tool parameters

Advertised core, plus the runtime tail that is accepted and strictly validated
but not serialized to the model:

```ts
{
  runs: [
    {
      agent: "reviewer",                    // agent definition name
      task: "review the session store",
      name?: "reviewer-a",                  // addressing key (steer/cancel/recover)
      mode?: "solo" | "supervised" | "driver",        // default "solo"
      after?: ["scout"] | "previous",       // solo-only ordering
      count?: 3,                            // solo-only fan-out
      rounds?: 5,                           // supervised-only round cap
      clone_mode?: "full" | "snippet" | "task_only",  // supervised-only seed mode
      depth?: 1,                            // nested-delegation cap
      model?: "openai/gpt-5",
      thinking?: "high" | false,
      skills?: "code-review" | ["code-review", "librarian"] | false,
      env?: { GRAFT_MAIN_REF?: string | null }, // worker environment patch
      cwd?: "packages/api",                 // per-run cwd (abs or rel to main)
      artifact?: "notes.md", reads?: ["spec.md"], // solo/chain-only
      progress?: true,                         // direct/chain writes; supervised ignores and warns once
      interactive?: true,
      worktree?: false,                     // one fresh git worktree per run
      escalation?: "off" | "local",
      handoff?: { tasks: [...] },        // durable seed when the child has a claimant

      // Runtime tail — accepted and validated, not advertised to the model:
      snippet_last_n?: 10,                  // pairs with clone_mode "snippet"
      collapse_mode?: "final_output" | "summary",
      // Omit for no provider call; pin provider/model, or use "auto" for built-in Haiku 4.5.
      summary_model?: "anthropic/claude-haiku-4-5" | "auto",
      supervisor_instructions?: "be strict about error handling",
      thinkingMin?: "medium" | false,
      thinkingMax?: "high" | false,
      fallbackModels?: ["anthropic/claude-sonnet-4", "openai/gpt-5-mini"],
      confineWrites?: true, writableRoots?: ["/abs/path"], readOnly?: false,
      max_duration_ms?: 90_000, wind_down_grace_ms?: 5_000,
      heartbeat_interval_ms?: 180_000, max_consecutive_heartbeats?: 3,
    },
    // ... up to 6 in parallel
  ],
  task?: "shared task for entries that omit one",
  concurrency?: 4,
  failFast?: false,
  agent_scope?: "user" | "project" | "both", // default: "both"
  worktree?: false,                         // one fresh git worktree per run
  await?: false,                            // true only when the next action requires this result
  sync?: false,                             // deprecated compatibility alias for await
}
```

Invocation-scoped overrides (`model`, `thinking`, `thinkingMin`, `thinkingMax`,
`fallbackModels`, `skill`/`skills`) clone and patch the effective worker
`AgentConfig` for that one call or entry only, after durable
config/`delegate.agentOverrides` have been applied. Pass `false` for any of the
three thinking fields to clear that field for one invocation. They never rewrite agent definition files, global config, or durable
overrides, and sibling entries using the same agent keep their defaults unless
they also specify overrides. On a `mode: "supervised"` entry these overrides
are **worker-only**: the supervisor fork-clone still uses the main agent's
model/system prompt, and `summary_model` remains the only per-call control for
summary collapse. `artifact` and `reads` are solo-run features and reject on a
supervised entry. Each artifact producer writes to a private v2 attempt path. After
clean completion, the runtime validates the candidate and atomically publishes its
exact bytes as an immutable retained snapshot. Results keep
`outputFile: { absolutePath, bytes }` and add a validated `artifactRef`; the final
assistant text remains the handoff. Failed, aborted, or timed-out runs publish no
reference. Exact references can be passed in programmatic `reads`, survive durable
result/wake records, and never fall back to a worktree-wide latest or legacy file.
Snapshots remain available for seven days by default, extended by admitted readers
and durable record pins. `progress` is accepted on a supervised entry but is ignored
with one warning; direct and chain runs keep their existing progress-file behavior.

`env` is supported on every run entry, on saved chain steps, and on a `driver`
entry. It is a map of
string values; `null` removes a variable from the worker's inherited
environment. Invocation values override agent defaults. Delegate-owned
lineage, routing, authentication, and child-control names are ignored even
when supplied. In-process workers use an async-local overlay, so concurrent
workers do not mutate each other's environment; detached children receive the
materialized map through their spawn environment.

Agent frontmatter may also declare `env: { ... }` for a saved default. Changes
to saved definitions are read when the extension discovers agents; restart or
reload the extension after editing a definition that was already loaded.
Saved agent and chain definitions (and `config.json` agent overrides) store
environment values in plaintext. Name-only operational displays are redaction,
not encryption of those files. Never put API keys, tokens, passwords, or other
secrets in durable `env` definitions; use the process environment or a secret
manager instead.

### Git worktree isolation

Set `worktree: true` to spawn one fresh git worktree per worker under the OS
tmpdir. Each worker runs on its own branch, starts from the current HEAD, and
the extension diffs + cleans the worktree when the worker completes. A summary
block listing changed worktrees is appended to the combined content.

Requires a clean git tree in the main cwd. Per-worker `cwd` is **rejected**
when `worktree: true` is set — worktree isolation owns the cwd assignment
for every worker.

Optional setup hook: set `worktreeSetupHook` in `config.json` to an
executable path; it's invoked with a JSON payload on stdin for each newly
created worktree (install deps, copy env files, seed fixtures, etc.).

### Worker write confinement

Every delegate-owned in-process worker confines `write`/`edit` targets to its
assigned cwd/worktree and a unique private scratch directory. An artifact producer
receives only its own `pi-workspace-v2/.../attempts/<id>/scratch` and `output`
leaves; sibling attempts, retained snapshots, quarantine, data parents, and stable
control metadata are not writable roots. Chain directories hold `progress` records
and are not artifact roots. Use per-slot `writableRoots` to widen authority or
`confineWrites: false` to opt out. A slot with `readOnly: true` removes `write` and
`edit` for primary-root paths but may write its private scratch and candidate output
leaves; the primary root and any ancestor roots are excluded. It also rejects
obvious mutating bash commands and reports structured refusals; prose and
`tools: [read, bash]` do not enforce it.
Because that exclusion makes the grant void, combining `readOnly: true` with a
`writableRoots` entry at, inside, or containing the primary root is rejected at
dispatch instead of being silently ignored. A root outside the primary root is
accepted at dispatch but still does not take effect under `readOnly`, so
`artifact:` is the only supported way for a read-only worker to produce a file.
A refused `write`/`edit` also adds a `policy` warning to the run result, so a
worker that claims success for a file it could not write is contradicted by the
result itself.
Case handling probes each filesystem root once and accepts alternate-case paths
only on case-insensitive filesystems. The repository-pollution guard rejects
reserved or declared artifact names and the allowlist path in Git worktrees for
`write`/`edit` and common shell writes. That shell check is **best effort, not a
sandbox**: interpreters, nested shells, unlisted mutators, and arbitrary custom
tools can still write. The authoritative guarantee that reserved files never reach Git belongs in the
host's delivery/CI gate. Direct workers and supervised runs also report git-only
mutation attribution. See
[`docs/write-confinement.md`](docs/write-confinement.md).

## How it actually works

A `mode: "solo"` run spawns one **worker AgentSession** (file-backed under
`~/.pi/agent/sessions/forks/`), sends the task as its first user turn, and
harvests the worker's final assistant text. No supervisor is involved.

A `mode: "driver"` run creates a stable, asleep `pi-daemon` session, attaches
from its durable cursor, wakes it, acquires the driver lease, and submits the
prompt with a durable idempotency key. The launch returns after acceptance;
`prompt_status` and committed-entry replay recover the result after either
caller or daemon restart.

For each `mode: "supervised"` entry, the tool:

1. Spawns a **worker AgentSession** (file-backed under
   `~/.pi/agent/sessions/forks/`) with the agent-definition's tools,
   model, and system prompt after durable config and any invocation-scoped
   worker overrides are applied.
2. Spawns an in-memory **fork-clone AgentSession** whose model and system
   prompt match the main agent's (worker-only overrides do not affect it),
   but whose messages are seeded from the
   main-thread branch (`clone_mode`) and whose tool list is **only**:
   - `message_subagent(text)` — forwards `text` to the worker as its next
     user turn, runs the worker's full agent loop, returns the worker's
     final text.
   - `finish_delegation({ final_output? , summary? })` — ends the supervised session.
3. Sends up to `rounds` messages to the worker. By default the runtime sends the
	caller's exact task as round 1; each supervisor follow-up consumes another
	round. With explicit `task_delivery: "supervisor-mediated"`, every round comes
	from the supervisor. The fork then calls `finish_delegation`.
4. Collapses:
   - `collapse_mode: "final_output"` → returns `finish_delegation`'s payload
     verbatim.
   - `collapse_mode: "summary"` → returns the supervisor's concise summary
     verbatim when `summary_model` is omitted (zero summarizer provider calls),
     or refines it from the full supervisor+worker transcript with an explicit
     `provider/model`. Literal `"auto"` selects only
     `anthropic/claude-haiku-4-5`; if Haiku is unavailable, collapse retains the
     supervisor hint and does not select another model.

Before worktree or fork construction, an accepted supervised dispatch checks
configured models for all summary-collapse runs against the active registry and
session scope. It emits at most one aggregate diagnostic warning when any
configured reference is unavailable. The warning is advisory and does not
change collapse behavior. For a narrow registry, select an available model with
per-run `summary_model`, agent frontmatter `summary_model`, or
`delegateConfig.agentOverrides.<agent>.summaryModel`. The per-run value wins
over the effective agent default; a durable agent override wins over
frontmatter.

5. Returns one result entry per worker inside the current `delegate` tool result when
   `await:true`, or posts them via a `custom_message` wake-up when the default
   background dispatch finishes.

Each worker session is saved as a standalone `.jsonl` with `parentSession` →
the main session, so you can `/resume` into it later to inspect the full
worker-side history. The fork-clone's transcript is stored only in the
tool-call `details` (not persisted to disk by design — that's where the
"sub-conversation collapsed" semantics live).

## Installation

Install the public npm package, then `/reload`:

```bash
pi install npm:@centerforagenticai/pi-delegate
```

For local development, point `packages` in `~/.pi/agent/settings.json` at the
checkout and run `npm install` in that worktree's private `node_modules`.
Never install into a checkout used by live sessions or symlink dependencies from
another worktree: those sessions resolve the Pi SDK from the checkout, and an
install can make their workers fail before they start. Editable source belongs
in the checkout, not under `~/.pi/agent/extensions/`.

The bundled `delegate` and `worker` agents are discovered automatically from
`builtin-agents/` and work out of the box. Install compatible workflow agents
separately if you need the `scout`, `planner`, `reviewer`, `implementer`, or
`integrator` roles.
Web research is host-specific because Pi has no native search/fetch tools; define a user/project/package agent with qualified
`ext:<owner>[#<module>]:<tool>[:<action>]` selectors instead of relying on an upstream
`researcher` profile.

If you want to override those builtins with your own user-scope definitions,
write agent `.md` files into `~/.pi/agent/agents/` (or `~/.agents/`).

## Agent definition frontmatter

This section is the field inventory. For the authoring judgement around it —
which scope to write to, `replace` vs `append`, how to select extension tools,
which fields are inert in which delegation shape, and why an agent file
silently fails to register — load the `authoring-delegate-agents` skill.

Standard pi-subagents fields:

- `name`, `description` (required)
- `tools` (YAML array; entries prefixed `mcp:` are split into MCP direct
  tools; `ext:<owner>[#<module>]:<tool>[:<action>]` selects one registered extension tool and
  `ext:<extension>` selects all tools from that extension; default:
  `read,bash,edit,write` from the host)
- `model` (e.g. `anthropic/claude-haiku-4-5`; default: main agent's model).
  A **bare** id (`gpt-5.6-luna`, no `provider/` prefix) resolves through the
  `unified` logical provider when the catalog has one, so it inherits
  multi-account failover, cooldown, and account priority. An explicit
  `provider/id` pins that one physical route with no failover.
- `fallbackModels` (YAML array of model refs tried in order if `model`
  is unavailable or returns a prompt-time content refusal; a bare entry gets
  the same unified-first resolution as `model`)
- `thinking` (`off` | `minimal` | `low` | `medium` | `high` | `xhigh`)
- `thinkingMin` / `thinkingMax` (optional session-local adaptive-thinking
  bounds from the same level domain; a declared `thinking` must lie within the
  effective range)
- `systemPromptMode` (`append` | `replace`; default `replace`)
- `inheritProjectContext` (default `false`)
- `inheritSkills` (default `false`)
- `skills` (YAML array of skill names)
- `extensions` (YAML array of extension paths; additive to inherited Pi extensions)
- `env` (JSON object of string values or `null`; default environment patch)
- `extensionInclude` (YAML array of portable extension selectors to require)
- `extensionExclude` (YAML array of portable extension selectors to remove)


An optional worker extension can record a repaired opening prompt before fallback. `pi-delegate` reads only the versioned `prompt-repair` record. It shows the refusal and prompt diff in the run transcript and result, then gives the final revised prompt to the next configured fallback model. Replacement sessions are ineligible, so repairs run only on the original selected model. Without a compatible extension, fallback behavior is unchanged.
Snake_case aliases and CSV list values remain readable for legacy files, but are deprecated. Canonical files use camelCase field names and YAML arrays. The management input API is different: `config` for `action: "create"` and `action: "update"` accepts arrays or `false` for list fields; on create, `false` leaves that field absent, and on update, it clears an existing field. CSV strings are rejected there.

### Portable extension policy and exact extension tools

Workers inherit Pi's configured extensions. The legacy `extensions:` field is
unchanged: it **adds** paths and is never an allowlist. Use the optional policy
fields when an agent must name or remove an extension portably:

```yaml
extensions: [/absolute/dev-only/extra-extension.ts]
extensionInclude: [adaptive-thinking]
extensionExclude: [pi-delegate]
tools: [read, bash, ext:adaptive-thinking:set_thinking_effort]
```

`extensionInclude` validates that every selector resolves in the inherited plus
additive discovered set; it does not create an exact/isolation mode.
`extensionExclude` is applied last and wins if the same extension is included
and excluded. Missing or ambiguous selectors fail closed with the discovered
matches in the diagnostic. Explicit empty lists (`extensionInclude: []` and
`extensionExclude: []`) are no-ops.

Portable identities are derived in this order:

1. nearest `package.json` `name` (for example `@acme/adaptive-thinking`);
2. canonical source (`npm:@scope/pkg` or ref-independent
   `git:github.com/org/repo`) when a package name is not unique;
3. `#<package-relative-entrypoint>` when one package provides multiple
   extensions (for example
   `git:github.com/org/repo#extensions/guard.ts`);
4. an absolute resolved path only as a compatibility fallback.

For local checkouts, `package.json.repository.url` is preferred over Git
`remote.origin.url`. SSH and HTTPS Git URLs normalize to the same `.git`- and
ref-free identity. Host aliases are only canonicalized when explicitly mapped;
an origin is an alias, not a trust proof.

Extension loading and tool exposure are separate. Loading an extension makes
its registrations available; an explicit `tools:` list still exposes only the
named builtins and `ext:` selections. Built-in tools are bare names. The
canonical extension grammar is:

```text
ext:<owner>[#<module>]:<tool>[:<action>]
```

After `ext:`, the owner ends at the first `#` or `:`. An optional kebab-case
module id ends at the next `:`. The first colon after the owner or module starts
the tool name. A second colon starts an action grant. Owners and module ids
never contain colons. Prefer a unique package name as the owner:

```yaml
tools: [read, bash, ext:adaptive-thinking:set_thinking_effort]
tools: [read, ext:@centerforagenticai/pi-delegate:delegate_control:status]
tools: [read, ext:@acme/multi-tools#guard-hooks:guard_check]
```

A package declares module ids in its own `package.json` under
`pi-delegate.modules`, for example `{ "guard-hooks": "./extensions/guard.js" }`.
Pi-delegate rejects absolute paths, `..` escapes, missing entrypoints, and
symlinks that resolve outside that package. When a package has several loaded
entrypoints, a package-only selector still resolves if exactly one same-package
entrypoint owns the requested tool. Use `#<module>` when that shortcut is
ambiguous or the tool registers lazily.

During the migration window, the old final-slash form
`ext:<owner>[#<entrypoint-path>]/<tool>[:<action>]` remains accepted silently and
resolves to the same bare tool name. `ext:<owner>` also remains accepted for a
whole-extension compatibility grant. New and serialized agent definitions use
the colon form. The old source-qualified example
`ext:git:github.com/acme/tools#extensions/guard.ts/guard_check` therefore remains
readable but is not the preferred authoring form.

Tool-owner disambiguation does not apply to `extensionInclude` or
`extensionExclude`; those policy selectors keep their portable-identity grammar.

Pi-delegate's own delegate-family tools also accept
`ext:@centerforagenticai/pi-delegate:delegate` and
`ext:@centerforagenticai/pi-delegate:delegate_control:status`. They use the same
nested-delegation policy as bare names: `allowNestedDelegate: true` remains mandatory for a
worker, and a qualified spelling never bypasses depth, action, escalation,
read-only, or write-confinement checks.

Selected extension tools may register lazily during `session_start` or
`before_agent_start`; direct, supervised-inner, and hosted workers make them
available without restarting the worker. `ext:` narrows the model-visible set
live. Loaded but unselected extensions still run their lifecycle handlers, but
their tools remain inactive and are vetoed if called during the first-turn
registration window. This narrows tool access; it is not process isolation and
does not prevent arbitrary side effects from a loaded extension.

A missing `ext:` owner fails worker construction with a
`[tool-selector:OWNER_NOT_FOUND]` diagnostic. It is never skipped, widened to Pi
defaults, or rebound to a same-named tool from another extension. A configured
candidate whose factory fails, or a provider removed by explicit extension
policy, also remains a setup error. Ambiguous selectors fail with
`OWNER_AMBIGUOUS` unless one eager, exact tool owner disambiguates matching
entrypoints as described above. A valid selector whose extension identity resolves
to one loaded entrypoint may name a tool that never registers; the tool remains unavailable
rather than widening the worker or failing early. This includes a package identity with one
matching loaded entrypoint. A `#module` selector preserves the same lazy behavior
when its package has multiple loaded entrypoints. Eager and late same-named ownership is
checked against the selected extension and fails closed. Workers without an explicit tool list
keep Pi's inherited/default behavior, while isolated or no-extension sessions retain a
static registry allowlist. Excluded extension entrypoints are removed before factory
import, so their handlers, commands, renderers, flags, shortcuts, and tools never
register. Use `extensionInclude` when an extension is required; missing or ambiguous
include selectors remain policy errors.

Selector failures always use the envelope `[tool-selector:<CODE>] …`. The codes
are `SELECTOR_MALFORMED`, `OWNER_NOT_FOUND`, `OWNER_AMBIGUOUS`,
`MODULE_UNKNOWN`, `TOOL_UNDECLARED`, and `PROVIDER_MISMATCH`. Every failure is
closed: no selector is passed to Pi's `setActiveTools()` or CLI `--tools` seam,
and no failure falls back to a built-in or default provider.

Pi currently exposes extension ownership for extension registrations, but not
an owning-extension back-reference for separately discovered skills, prompts,
or themes. Consequently `extensionExclude` does **not** attempt brittle
directory-prefix filtering of those resource types; package-level resource
policy needs an upstream Pi ownership API. Also, a hosted CLI worker using an
exact `ext:` selector preflights the selected (never excluded) factories in its
detached host to learn registered tool names before launching the Pi CLI, so
selected factories must tolerate initialization in both processes.

### Session-local adaptive-thinking bounds

A bounded worker can opt into adaptive thinking without broadening its tool
surface or rewriting machine-global settings:

```yaml
---
name: bounded-reviewer
thinking: high
thinkingMin: medium
thinkingMax: high
extensions: [/path/to/adaptive-thinking/index.ts]
tools: [read, bash, ext:adaptive-thinking:set_thinking_effort]
---
```

The worker starts at `thinking`, and compatible adaptive requests are clamped
to `thinkingMin..thinkingMax` independently for each worker session (including
`this_response`, `next_N`, and `until_changed` scopes). The `ext:` selector is
resolved only after that worker's actual extension loader finishes. Direct and
supervised in-process workers resolve against their complete loaded set (which
can include inherited/global extensions as well as agent-declared paths);
detached driver children use `--no-extensions` and resolve against only
their explicit consumer extensions. Extension identity errors and eager
ownership collisions fail closed. A valid exact tool selector may remain
unavailable until a lazy provider registers it; it never broadens the active
set. This prevents Pi's name-only allowlist from activating a same-named tool
from the wrong extension and does not activate unselected tools from the chosen
extension. An explicit allowlist that is empty, malformed, or reduced to no
usable tools fails before session/model construction rather than silently
widening to Pi's default tool surface.

Bounds are durable agent policy, but remain dormant when no adaptive-thinking
provider is loaded. If a loaded extension registers `set_thinking_effort` for a
bounded worker, it must acknowledge pi-delegate's session-local policy protocol
v1 (`pi-delegate:adaptive-thinking-policy` →
`adaptive-thinking:pi-delegate-policy-accepted`); an older or ambiguous provider
fails before model work instead of silently applying global bounds. Detached
driver performs the compatibility preflight in its runner and then
re-verifies the matching ACK and selected tool inside the authoritative Pi RPC
child before accepting input. The policy is stored in the worker session as a
`pi-delegate-thinking-policy` custom entry.
Pi-delegate never rewrites `~/.pi/agent/adaptive-thinking.json` or shared
process-global settings.

Precedence is agent frontmatter, then durable `agentOverrides`, then the current
invocation or chain-slot override. Every effective policy is revalidated after
patching. Agent management and invocation overrides accept `false` to clear
`thinking`, `thinkingMin`, or `thinkingMax`; frontmatter itself uses level
strings or omission.

Delegate extensions (all optional; canonical camelCase names):

- `defaultMaxRounds` — default total worker-message budget; the exact first turn counts
- `stopConditionHint` — natural-language cue included in the fork-clone's prompt
- `collapseMode` — `"final_output"` or `"summary"` default
- `summaryModel` — explicit model ref for summary collapse, or `"auto"` for the built-in `anthropic/claude-haiku-4-5`; omission makes zero summarizer provider calls and returns the supervisor hint verbatim. When the dispatch preflight warns that the effective reference is unavailable in the active registry or session scope, set per-run `summary_model`, agent frontmatter `summary_model`, or `delegateConfig.agentOverrides.<agent>.summaryModel` to an available `provider/model`; the preflight does not choose a fallback.
- `maxSubagentDepth` — recursive delegate depth cap; the default is a
  conservative 2, while a fresh root may explicitly request up to the hard
  ceiling of 16 (ordinary descendants may tighten but never relax the root's
  inherited cap)
- `allowNestedDelegate` — explicit opt-in for a plain worker session to
  receive delegate-family tools, whether that worker is launched directly or
  runs beneath a supervised fork's supervisor clone. Default is `false`:
  delegate tools listed in `tools:` are still stripped unless this is `true`.
- `nestedDelegateAgents` — optional YAML array child-agent allow-list enforced
  when this worker calls `delegate`.

Nested delegation remains **strip-by-default**. To let a direct worker call
delegate, set `allowNestedDelegate: true` and list exact trusted `pi-delegate`
extension selectors in `tools:` (for example
`ext:@centerforagenticai/pi-delegate:delegate` and optionally
`ext:@centerforagenticai/pi-delegate:delegate_control`, or a single action such
as `ext:@centerforagenticai/pi-delegate:delegate_control:status`). Bare
delegate-family
names remain accepted as input aliases but do not authorize a live registration.
If
`allowNestedDelegate: true` is set but `tools:` is absent, the worker keeps the
normal default tool surface (`read`, `bash`, `edit`, `write`) and receives no
delegate tools. When `nestedDelegateAgents` is absent, an opted-in worker may
delegate to any resolved agent; when present, attempts to spawn non-listed
agents fail before the nested run starts. All nested calls still run through the
existing `maxSubagentDepth` / lineage guard. Calls without an explicit root
policy remain capped at 2; a root agent configured for a deliberate deeper
workflow may raise that cap as high as 16.
A genuinely detached driver root retains its established minimum of 3,
including at its deliberate re-root boundary, but it also cannot exceed 16.
The opt-in therefore grants capability within a bounded tree rather than
unbounded fan-out.

Nested workers are intentionally **not** an agent-management surface: when a
delegate-owned worker calls `delegate`, read-only management actions (`list`,
`get`, `health`) are allowed, but `create`, `update`, `delete`, and
`canonicalize` are refused
before any agent/chain file is touched. This prevents an opted-in worker from
persisting a shadow agent or minting a new `allowNestedDelegate` /
`nestedDelegateAgents` policy that the parent did not authorize. The
`nestedDelegateAgents` allow-list is still bare-name only; after a name passes,
delegate resolves it using the normal discovery order. The allow-list does not
pin a source or file path, so avoid same-name overrides for allow-listed agents
unless that override is the intended target.

Unknown frontmatter fields are preserved in `extraFields` rather than
silently dropped.

Discovery searches (in order, later wins on name collisions):

- **Builtin scope**: bundled `builtin-agents/` snapshot containing `delegate` and
  `worker` (lowest priority)
- **Package scope**: Pi-aware packages found through normal cwd/package discovery plus installed roots listed by Pi's settings package manager; configured roots are additive to the normal package walk.
- **User scope**: `~/.pi/agent/agents/` then `~/.agents/`
- **Project scope**: nearest ancestor's `.agents/`, then `.agents/agents/`, then
  `.pi/agents/`. Agent and chain files use this order; later definitions win on
  duplicate names.

When graft and pi-delegate share a live Pi session, graft can synchronously emit
`pi-delegate:agent-capability-query:v1` with mutable request
`{ version: 1, cwd, scope: "both", names: string[] }`. Pi-delegate sets
`response` to `{ version: 1, agents, warnings }`; each requested name receives
an availability record with package/source/file metadata when available. A
builtin `worker` is therefore distinguishable from a package-provided
`graft-worker` by `source` and `packageName` without an extra classifier.

## Configuration

Optional `config.json` at `~/.pi/agent/config/pi-delegate/config.json`:

```json
{
  "worktreeSetupHook": "/abs/path/to/hook.sh",
  "worktreeSetupHookTimeoutMs": 30000,
  "perForkMaxDurationMs": 0,
  "perForkMinDurationMs": 0,
  "skill": { "excludeSections": ["Cancelling"] },
  "globalToolWhitelist": {
    "tools": ["ext:skill:load"],
    "skills": ["implement"]
  },
  "escalation": { "mode": "off" },
  "nativeEscalationUi": true,

  "overlayShortcut": "ctrl+alt+d",
  "inspectorLayout": "full",
  "inspectorThinking": "preview",
  "inspectorToolDetail": "chip",
  "inspectorFoldMessages": true,
  "autoCloseInspectorOnComplete": false,
  "completionNotifyStrategy": "auto",
  "notifyOnFailure": true,
  "activityTicker": {
    "enabled": true,
    "minSummaryIntervalMs": 15000,
    "debounceMs": 2000,
    "maxConcurrentSummaries": 2,
    "summaryTimeoutMs": 10000,
    "terminalRetentionMs": 5000,
    "maxHeadlineChars": 100,
    "maxInputChars": 4000
  },
  "ptmBridge": { "handleRequests": "auto" }
}
```

### Global tool and skill baseline

Despite its historical “Tool” name, the `globalToolWhitelist` first cut includes both tools and skills. The object shape keeps the two resource kinds explicit:

```json
{
  "globalToolWhitelist": {
    "tools": ["read", "ext:skill:load"],
    "skills": ["implement", "test-execution"]
  }
}
```

The global baseline is applied before agent frontmatter and before durable `agentOverrides`. With a configured baseline, non-empty durable `tools` or `skills` lists extend the composed list, an explicit empty list clears it, and omitted fields retain it. Without a baseline, durable lists keep their existing whole-array replacement behavior. If the baseline is the first non-empty tool declaration, the worker also keeps `read`, `bash`, `edit`, and `write`.

Skill inheritance stays intentional. `inheritSkills:false` with no explicit skills uses the non-empty global skill list. `inheritSkills:true` with no explicit skills keeps `skills` absent and exposes the full discovered registry. With explicit skills, both `inheritSkills:false` and `inheritSkills:true` put global skills before agent skills. Invocation `skill:false` remains the final per-call opt-out.

`extensionExclude` can opt one agent out of a provider; the affected global-only `ext:` selector will warn and drop when that provider is absent or excluded. The same selector remains a hard error when agent frontmatter, a durable override, or an invocation also names it. An explicit empty durable `tools` list opts out of all configured global tool entries.

| Field                        | Meaning                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `worktreeSetupHook`          | Executable run once per new worktree after creation. Receives a JSON payload on stdin.                  |
| `worktreeSetupHookTimeoutMs` | Positive integer ms cap for the hook.                                                                   |
| `perForkMaxDurationMs`       | Optional global absolute ceiling for solo and supervised runs (#287). Default `0` (disabled); positive values clamp agent/entry budgets and always hard-enforce after grace. Addressable direct runs still have an activity-based safety bound: 15 minutes without worker or descendant activity sends one wind-down steer, then hard-cancels after `windDownGraceMs`. Values must be safe integer milliseconds up to 2,147,483,647. |
| `enforceWallClockBudget`     | Boolean, default `false`. When `true`, caller- and agent-supplied wall-clock budgets hard-cancel after wind-down grace. A positive `perForkMaxDurationMs` hard-enforces regardless of this setting. |
| `perForkMinDurationMs`       | Optional global absolute floor for solo and supervised runs. Default `0` (disabled); positive values raise only a stated positive selected budget after the ceiling. Explicit zero and no selected budget remain unlimited when the floor is the only bound. A positive floor above a positive ceiling is diagnosed and ignored. Values must be safe integer milliseconds up to 2,147,483,647. |
| `skill.excludeSections`      | Optional array of exact, case-sensitive visible Markdown heading text. Each match removes that heading through the next heading at the same or higher level, including nested subsections. Missing, empty, malformed, or partly unknown values expose the complete bundled skill; malformed and unknown values emit fixed redacted warnings. |
| `globalToolWhitelist`        | Optional `{ tools?: string[], skills?: string[] }` baseline for every discovered agent. See “Global tool and skill baseline” above. |
| `escalation`                 | Global partial escalation policy and root authority. Built-in `mode` is `"off"`; escalation is opt-in and merges field-wise with agent and invocation layers. See [`docs/escalation.md`](docs/escalation.md). |
| `nativeEscalationUi`         | Boolean, default `true`. Set `false` when a host renders user-held escalations in its own operator UI. Pi then neither opens its native dialog nor wakes the root agent for them; the request stays pending in the durable feed for the host escalation API. Non-boolean values are ignored with a warning. See [`docs/escalation.md`](docs/escalation.md). |
| `overlayShortcut`            | Fallback keybinding for opening the transcript overlay, registered in addition to the built-in `alt+o` / Option-O toggle. Default `ctrl+alt+d` (d = delegate). Set to `""` to disable both shortcuts (slash command still works). Avoid `ctrl+shift+letter` defaults because many terminals collapse them to plain `ctrl+letter`. |
| `inspectorLayout`            | Transcript inspector placement: `"full"` (default) centres a near-fullscreen modal; `"dock"` anchors a narrow right-side panel and renders the single-column drill-down. Invalid values fall back to `"full"`. |
| `inspectorThinking`          | Initial thinking detail for each new Pi session: `"hidden"`, `"preview"` (default), or `"full"`. Runtime `t` changes persist only within that session. |
| `inspectorToolDetail`        | Initial tool-call detail for each new Pi session: `"chip"` (default), `"hidden"`, or `"expanded"`. Runtime `g` changes persist only within that session. |
| `inspectorFoldMessages`      | Retained for compatibility and currently inert: long finished messages always fold, and `Enter` expands the one message or tool result you select. |
| `autoCloseInspectorOnComplete` | Close the open overlay when its owned runs transition from live to all-terminal. Default `false`: a centered modal that dismisses itself takes a just-arrived result off the screen, so a completion banner reports the outcome instead and closing stays your decision. Set `true` for the old auto-dismiss. |
| `completionNotifyStrategy`   | `auto` (the default), `custom-message`, and the reserved `synthetic-tool-pair` alias all resolve to the supported `custom-message` wake. The reserved value logs a warning and falls back. |
| `notifyOnFailure`            | Enable/disable early bounded `delegate:fork-failed` wakes for background direct workers, supervised runs, or chain steps. Default `true` (on by default); set `false` to opt out to aggregate-only behavior. Per-call `notifyOnFailure` overrides this setting. The aggregate completion wake is always emitted. |
| `activityTicker`             | Default-on deterministic footer activity in eligible interactive foreground sessions. `enabled: false` disables it; omitted `model` means zero ticker provider calls, cost, and provider-bound egress; explicit `provider/model` pins the destination; model `"auto"` selects only `anthropic/claude-haiku-4-5` and fails closed when unavailable. Cadence, concurrency, timeout, terminal grace, privacy allowlist, and separate ticker cost counters are documented in [`docs/activity-ticker.md`](docs/activity-ticker.md). |
| `ptmBridge.handleRequests`   | pi-prompt-template-model bridge. `auto` (default) listens iff the legacy `~/.pi/agent/extensions/subagent` is absent. `always` always wins. `never` disables. See `docs/prompt-template-bridge.md`. |

Missing file / bad JSON / unreadable file degrade to `{}` with at most one
warning — config loading never blocks a tool call. A `config.local.json`
overlay next to `config.json` is merged on top (overlay wins per key), so
runtime-specific settings stay out of the extension package checkout. On
startup/load, legacy config files under
`~/.pi/agent/extensions/pi-delegate/{config.json,config.local.json}` are moved
to `~/.pi/agent/config/pi-delegate/` when the destination file does not already
exist; if both exist, the new location wins and the legacy file is left for
manual merge/removal.

`skill.excludeSections` is re-read during startup and resource reload. Pi package filters, `autoload`, project trust, and direct/CLI loading remain authoritative; a disabled package skill is not re-enabled by this setting. This setting does not interpolate runtime timeout values into skill prose.

Other knobs: `windDownGraceMs` (global fallback grace window after the
per-run wall-clock budget before hard-cancel; default 90s),
`max_duration_ms` / `wind_down_grace_ms` on agent definitions and on solo or
supervised run entries (invocation > agent > global; `0` explicitly disables
unless a positive global ceiling is configured; a positive floor alone does not
create a deadline for zero or no selected duration), `heartbeatIntervalMs` /
`maxConsecutiveHeartbeats` / `heartbeatTailLines` (see `docs/heartbeat.md`;
`maxConsecutiveHeartbeats` sends a one-shot wind-down steer, and hard abort
follows only after the additional heartbeat grace intervals; these settings tune
supervised channels, while direct runs use the built-in 3min × 5 silence bound),
`cancelForkShortcut` / `cancelForkBypassShortcut` / `cancelConfirmCostUsd` /
`cancelConfirmRuntimeMs` (overlay cancel guards), `intercomBridge` (see
pi-intercom docs).

## Environment variables

| Variable                   | Direction  | Meaning |
| -------------------------- | ---------- | ------- |
| `PI_DELEGATE_CHILD`        | *internal* | Set to `"1"` by pi-delegate on every spawned child pi process (driver hosted agents, worker children). The extension uses it to suppress **foreground-only** startup logic in children — hydrate-and-deliver, pending-wake redelivery, widgets. Do not set it yourself; unsetting it inside a child would make the child misbehave as if it were a foreground session. |
| `PI_DELEGATE_ASCII`        | user       | Set to `"1"` to force the ASCII icon vocabulary on every delegate surface — footer, below-editor widget, and transcript overlay — whatever `footerIcons` is set to. `TERM=dumb` enables the same fallback automatically. |
| `PI_DELEGATE_DEBUG`        | user       | `"1"` echoes the file-routed diagnostics (`<agentDir>/extensions/pi-delegate/event-bus/diagnostics.log`, spec 0017) to `console.warn` and enables raw-RPC-frame verbosity. Detached-child capture is always on; this flag does not gate childlogs. |
| `PI_OFFLINE`               | both       | Honoured by pi itself (suppresses model-catalog updates). pi-delegate **temporarily overlays it as `"1"`** around each worker resource reload so a burst of N parallel workers doesn't trigger N concurrent model-update fetches. The overlay is async-local and never changes the foreground environment. |

Internal lineage/control variables (`PI_DELEGATE_LINEAGE_*`,
`PI_DELEGATE_CONTROL_SECRET`) are spawn-env plumbing with integrity
checks — never set or forward them manually.

### Diagnosing a stalled detached driver run

Detached driver capture is always on. Inspect the per-run childlog at
`<agentDir>/extensions/pi-delegate/orchestrate/logs/<runId>.childlog` (with one
rotated predecessor at `.childlog.1`) while diagnosing a stalled run. The log
contains the runner lifecycle, bounded structured RPC diagnostics, and the
terminal classification (`terminal` and `reason`). `PI_DELEGATE_DEBUG=1` adds
the raw RPC frames and echoes file-routed diagnostics to `console.warn`; it is
not required for the childlog to exist.

Unknown RPC events are rendered as bounded JSON metadata. The fallback
allowlist admits only known-safe root-level scalar fields; all other fields,
including prompts, messages, model output, credentials, and tokens, are omitted
with a marker rather than copied into this log.

## Maintenance scripts

- `npm run compact-state` (`scripts/compact-run-state.ts`) — one-shot
  re-sanitize of `run-state.json` against the current persistence caps,
  for reclaiming disk space after an upgrade without waiting for the next
  dispatched run. Optional arg: an explicit path to a `run-state.json`.
- `npm run smoke` — scripted end-to-end smoke run.
- `npm run release -- X.Y.Z` — source-maintainer helper for creating an exact
  SemVer release commit and matching tag. Public consumers do not need this
  command.

Node support: `engines` declares the runtime floor (`>=22.19`, matching
pi's own requirement); `.nvmrc` pins the version the suite is developed
and routinely tested on (24.x). If you hit an issue on a 22.x runtime
that disappears on 24.x, please report it.

## Security note

`delegate` now defaults to `agent_scope: "both"`, which means project-local
agents are discoverable by default. Project agent and chain files share the
lowest-to-highest-precedence order `.agents/` < `.agents/agents/` <
`.pi/agents/`; later definitions win on duplicate names.
Pi owns project trust. If `ctx.isProjectTrusted()` is false, delegate refuses
every run shape selecting a project agent before dispatch. There is no
delegate-local trust store and no model-controlled bypass. Trust or revoke the
project through Pi's native trust flow.

Builtin, user, and installed-package agents are not project-gated. The
headless `delegateFromCli` surface has no Pi trust context, so discovered
project agents require the explicit programmatic capability
`trustProject: true`; otherwise the CLI refuses them before creating a
session. Caller-constructed `AgentConfig` objects remain caller-owned. See
`docs/cli-delegate.md` § Project trust.

## Testing and quality gates

The repository uses Node's built-in `node --test` runner plus TypeScript, ESLint
flat config, and V8/c8 coverage. The suite runs against **compiled JavaScript**:
`npm run test:compile` transpiles `src/**` and `tests/**` once into `.test-dist/`
and the runner executes that. Every test file gets its own Node process, so
before this the `tsx` loader re-transpiled the whole source graph 166 times per
run — measured at ~430s of the `quality` job's 571s test phase (issue #194). CI uses Node 22.19 and runs the same blocking quality entrypoint
after a clean, lifecycle-script-free `npm ci --ignore-scripts`. The full gate is
`npm run check:ci` — an alias for `npm run quality` — whose `smoke:pack` step
builds the package once before packing with lifecycle scripts disabled. `npm run
check` is now the light local inner-loop gate (lint, both typechecks, and
`test:affected`), not the full gate.

Primary commands:

```bash
cd /path/to/pi-delegate
npm ci --ignore-scripts # clean, lockfile-verified install; CI builds explicitly
npm run check:sdk-config # verify deterministic Pi SDK versions/resolution
npm run lint          # ESLint flat config over TS/JS sources, tests, scripts
npm run typecheck     # tsc -p tsconfig.check.json (source)
npm run typecheck:tests # source + tests TypeScript check
npm run test:compile  # incremental transpile of src/ + tests/ into .test-dist/ (tsc --noCheck); warm re-runs reuse a shared .tsbuildinfo
npm run test:file -- tests/unit/<file>.test.ts # narrow source-level run; paths and globs accepted
npm run test:affected # run only the tests a change reaches (tsx path; skips .test-dist); pass -- <path>... to override the changed set
npm run test:durations # measure each compiled test file for the shard ranking
npm run test:run      # run the already-compiled suite without recompiling
npm test              # test:compile, then unit + integration + end-to-end suites
npm run test:e2e      # Epic #137 acceptance suite only
npm run coverage      # c8/V8 coverage; text + lcov + Cobertura
npm run build         # package build
npm run smoke         # scripted source-level smoke harness
npm run smoke:pack    # build once, then pack/install/import without lifecycle scripts
npm run check         # light local inner-loop gate: lint + typecheck + typecheck:tests + test:affected
npm run check:ci      # full gate (= npm run quality): sdk-config, lint(+budget), typechecks, hooks, coverage, smoke, smoke:pack
```

`lint`, `typecheck`, and `typecheck:tests` keep their caches under
`node_modules/.cache/`, so a repeated run only re-checks what changed. `npm ci`
in CI removes that directory, so CI always starts cold. Each typecheck script
writes its own `.tsbuildinfo`, so the source and test checks never share state.

Both typechecks are merge gates: `static_checks` runs `typecheck` and
`typecheck:tests`, so a type error in a test file fails CI exactly as one in
`src/` does. That was not always true — `typecheck:tests` covered `tests/**`
long before anything enforced it, and the fixture-error count reached 151
before #260 cleared it to zero and added it to the gate. A test asserting
against a shape the production types cannot produce is a test checking fiction,
which is what that backlog turned out to consist of.

One limit worth knowing: `tsconfig.check.json` sets `strict: false`, and
without `strictNullChecks` TypeScript does not narrow a discriminated union by
its tag at all. These gates catch missing required fields, invalid enum
members, and wrong arities; they do not catch null-safety mistakes.
`npm run test:file -- tests/unit/<file>.test.ts` runs one or more paths or globs
straight from TypeScript in well under a second; prefer it over `npm test` while
iterating. Quote globs when your shell would otherwise expand them before npm
receives them, for example `npm run test:file -- 'tests/unit/worker-*.test.ts'`.
This narrow command does not type-check tests; that work belongs to #88. It also
does not replace the broader regression command required before handoff. The
source-level path stays supported deliberately — a test must behave the same
whether it is executing the source tree or the compiled one.

Coverage shards use the measured ranking in `scripts/test-duration-manifest.json`.
After adding, removing, or materially changing a test file, regenerate it with
`npm run test:compile && npm run test:durations`. The generator runs the compiled
suite once and captures Node's per-file durations; it does not start a separate
process for every file.

The two layouts differ in exactly one way that reaches tests: a test module sits
beside `src/*.ts` in one and beside `src/*.js` in the other. Static `import`
specifiers need no care (TypeScript rewrites the extension on emit), but three
things do, and all three go through `tests/helpers/source-under-test.ts`:

- a module URL built as a **string** — `sourceModuleUrl("state-io")` rather than
  `new URL("../../src/state-io.ts", import.meta.url)`, which the compiler cannot
  rewrite;
- Node flags for a **spawned child** — `childLoaderArgs()`, which is empty under
  the compiled layout instead of making each child re-transpile;
- tests that **read the TypeScript source** rather than execute it — `REPO_ROOT`,
  which always points at the committed tree, never the compiled mirror.

`test:compile` uses `tsc --noCheck`: it is a transpile, not a gate. Type
checking stays with `npm run typecheck` and `npm run typecheck:tests`. Because
incremental compilation reuses `.test-dist/` and a shared `.tsbuildinfo`, run
builds and gates serially within a worktree; concurrent jobs can rewrite or
prune files while a suite is reading them. Use separate worktrees for parallel
jobs. The failure mode is misleading: a Node 22 check launched during a
coverage run once left 147 test files unable to load (`Cannot find module
.../.test-dist/src/agents.js`), ran only 1,709 of 4,462 tests, and reported
coverage about ten points below every floor. Discard a clobbered run rather than
comparing it with a clean run.

`.test-dist/` also carries symlinks to the repository entries that compiled code
resolves as siblings of its own location (`builtin-agents`, `skills`, `docs`,
`README.md`, `scripts`), so `src/agents.ts` finds `<self>/../builtin-agents` in
the compiled layout exactly as it does in an installed package.

`tests/e2e/epic-137-acceptance.test.ts` is the 12-scenario Epic #137
acceptance suite. It drives the registered `delegate` tool and checks
caller-visible tool results, wake messages, run-history rows, and bytes on disk.
The shared lifecycle harness lives in `tests/helpers/delegate-harness.ts` so
acceptance tests can reuse the same fake Pi environment without duplicating
setup.

Test files run in parallel by default (`--test-concurrency=4`). Override with
`TEST_CONCURRENCY`; CI serializes test files because its shared runner is
CPU-constrained and concurrency 2 did not improve coverage wall time:

```bash
TEST_CONCURRENCY=1 npm test   # CI's shared-runner setting
TEST_CONCURRENCY=2 npm test   # conservative local parallelism
TEST_CONCURRENCY=8 npm test   # faster, but see below
```

The default is deliberately **4 rather than the core count**. Several tests
assert against real wall-clock budgets (issue #73), so they fail under load
rather than because of a regression. Measured on a 20-core host: concurrency 8
completes in ~32s but failed 2 of 11 full-suite runs (`orchestrate-recovery`'s
10s `persists the bounded rotation…` budget blowing out to 10012ms), whereas
concurrency 4 completes in ~50-60s and passed 14 of 14. Raise the default only
once those tests take an injected clock instead of racing real milliseconds.

Coverage is configured in `.c8rc.json` with `all: true`, `src: ["src"]`,
and `include: ["src/**/*.ts"]` so uncovered source files are counted rather
than only files loaded by tests. Local reports are written under
`coverage/run-*/reports/`; CI keeps the fixed `coverage/` paths for GitLab
artifact collection:

- terminal text (`text`)
- `coverage/run-*/reports/lcov.info` locally; `coverage/lcov.info` in CI
- `coverage/run-*/reports/cobertura-coverage.xml` locally;
  `coverage/cobertura-coverage.xml` in CI

The committed floors are regression guards, not targets: each is the measured
c8 total for all `src/**/*.ts` files rounded **down** to the next whole
percent. That keeps enough tolerance for run-to-run noise while still failing
the build on a real coverage regression.

| Metric | Measured range | Lowest observed | Configured floor |
| ------ | ----------------- | --------------- | ---------------- |
| Statements | 90.44–90.46% | 90.44% | 90% |
| Branches | 81.15–81.21% | 81.15% | 81% |
| Functions | 93.48–93.61% | 93.48% | 93% |
| Lines | 90.44–90.46% | 90.44% | 90% |

### Why the function floor moved from 95 to 93

Running the compiled suite did not stop testing anything; it changed how many
functions c8 can see. Same file, same test, only the layout differs:

| `src/worker-ui.ts` | statements | branches | functions | lines |
| ------------------ | ---------- | -------- | --------- | ----- |
| via tsx (source) | 95.43% | 77.41% | **87.50%** | 95.43% |
| via `.test-dist` | 96.80% | 76.66% | **32.55%** | 96.80% |

Statements and lines went slightly **up**. Only the function count changed, and
it changed because the two layouts disagree about how many functions exist:
87.50% is 7-of-8, while 32.55% is roughly 14-of-43. The extra ~35 are the arrow
functions in `STUB_THEME` and the no-op context from `buildNoUIContext()` —
identity passthroughs that exist for shape compatibility and are never meant to
be invoked. They were always uncovered; c8 simply did not count them against the
tsx emit.

So 93.48% is the more complete measurement, not a regression, and the honest
response is to recalibrate by the rule above rather than to write tests
asserting that `STUB_THEME.bold("x")` returns `"x"`. `worker-ui.ts` is the only
file that shows this pattern.

The statement, branch, and line floors are unchanged.

Measured across four full runs against `main` at `8d6f59f`. Totals move by a few hundredths of a
point between runs, so compare a suspected regression against the range rather
than a single number.

Raise the floors when coverage improves materially; never lower one to land
untested code. If `npm run coverage` trips the threshold check and your change
did not touch `src/`, re-run before adjusting anything: a flaky timing test
that fails under c8 instrumentation (issue #73) also forfeits the lines it
would otherwise have covered.

### CI

`.gitlab-ci.yml` defines a blocking `quality` job on
`node:22.19-bookworm`:

1. print Node/npm versions,
2. run `npm ci --ignore-scripts`,
3. for a release pipeline, verify that the Git tag matches the package version,
4. run the full gate. That gate is `npm run check:ci` (= `npm run quality`),
   whose `smoke:pack` step performs its sole build before packing, installing,
   and importing the tarball. The pipeline splits these steps across sharded
   test-stage jobs (`coverage_partial_0`/`coverage_partial_1`, `quality`,
   `static_checks`, `package_smoke`); `npm run check` is the lighter local gate,
   not this one.

A blocking `sdk_compatibility` matrix also installs the coordinated Pi SDK
triplet at each explicitly supported version (`0.80.6`, `0.83.0`, `0.84.1`,
`0.84.2`, and `0.85.1`) without
writing the lockfile, verifies the installed versions, and runs build,
typecheck, and focused compatibility tests. TypeScript resolves these packages
from local `node_modules`; machine-global declaration paths are forbidden.
`npm run check:sdk-config` enforces exact coordinated development versions,
exact verified peer versions, lockfile alignment, and local resolution.

The quality job always preserves lcov and Cobertura coverage artifacts and
publishes the Cobertura report to GitLab.

When a compiled test fails only in CI, reproduce it with the pinned runtime and
`--init`, which reaps spawned descendants in a container:

```bash
npm run test:compile
docker run --rm --init -v "$PWD":/w -w /w node:22.19-bookworm \
  node --test .test-dist/tests/unit/<file>.test.js
```

If many compiled files fail to load or coverage drops implausibly, first check
for another build or gate running in this worktree. A concurrent compile can
prune `.test-dist/` while the suite reads it; discard that run, remove only its
stale `coverage/run-*` reports, and rerun serially. Compare every coverage
number with a baseline before attributing it to a change. A Node 22 failure can
also expose timer or teardown races hidden by Node 26: an `unref()`'d timeout
lets the event loop drain while a promise is pending. Prefer a timer cleared in
`finally` and settle both sides of races so late failures do not become
unhandled rejections.

### Optional local git hooks

Hooks are tracked under `.githooks/` but are never installed automatically.
Opt in per clone with:

```bash
npm run hooks:install
```

That script verifies it is inside a git worktree, marks the tracked hook
files executable, and sets `core.hooksPath=.githooks` for the current clone.
The hooks run:

- `.githooks/pre-commit`: `npm run --if-present lint` and
  `npm run --if-present typecheck`
- `.githooks/pre-push`: `npm test` (unit + integration)
- `.githooks/post-merge`, `post-rewrite`, `post-checkout`, `post-commit`:
  rebuild `dist/` — see below

The hooks deliberately skip coverage. CI is authoritative: its full gate
(`npm run check:ci`, = `npm run quality`) enforces the `.c8rc.json` floors on
every branch and merge request, so the local pre-push hook stays fast enough to
run on every push.

`core.hooksPath` is all-or-nothing, and it is shared with every linked
worktree — including any that has no `node_modules` for `pre-commit` to lint
with. To take only the `dist/` rebuild and leave `pre-commit`, `pre-push` and
`commit-msg` off:

```bash
sh scripts/install-git-hooks.sh --build-only
```

That writes four small shims into the repository's shared `hooks` directory
instead of setting `core.hooksPath`. It refuses rather than overwrite a hook
it did not write, and refuses while `core.hooksPath` is set, since that would
make the shims dead files. Remove them with a plain `rm`.

#### Rebuilding dist/ after incoming commits

Every pi session on a machine loads pi-delegate as a configured package and
runs the compiled `dist/` of whichever checkout is listed in
`~/.pi/agent/settings.json`. Pulling `main` updates `src/` and leaves `dist/`
on the previous commit, so sessions keep running old code until somebody
remembers to build.

Four hooks close that window by running `npm run build` (about 7 seconds).
They share `.githooks/lib/autobuild.sh`:

| Hook | Fires on |
| --- | --- |
| `post-merge` | `git pull`, `git merge`, and a fast-forward `git pull --rebase` |
| `post-rewrite` | the end of a `git rebase`, and `git commit --amend` |
| `post-checkout` | `git switch` / `git checkout <branch>` |
| `post-commit` | your own commits |

The build is skipped unless the incoming range touched `src/`,
`tsconfig.build.json`, or `package.json`, so a docs-only pull costs nothing.

Four more rules keep it from firing when it should not:

- **Main checkout only.** `core.hooksPath` is shared config, so a hook
  installed in the clone also runs in every linked worktree — none of which pi
  loads. Linked worktrees are skipped unless you set
  `git config pidelegate.autobuild true`.
- **One build per rebase.** A `git pull --rebase` fires `post-checkout`, then
  `post-commit` for every replayed commit, then `post-rewrite`. Everything
  before `post-rewrite` is skipped while the rebase is in progress.
- **One build per commit.** The commit each successful build was made from is
  recorded in `node_modules/.cache/pi-delegate-autobuild.rev`; a second hook
  landing on the same commit does nothing.
- **Never two at once.** A `mkdir` lock in `node_modules/.cache/` keeps two
  `tsc` processes from writing `dist/` together.

Turning it off:

```bash
git config pidelegate.autobuild false   # this clone, permanently
PI_DELEGATE_NO_AUTOBUILD=1 git pull     # one command
```

Worth knowing:

- The hook never runs `npm install`. A dependency change reported as a build
  failure means you need to install by hand — in a private worktree, not a
  checkout other sessions are using.
- A failed build is reported but never fails the git command; `post-checkout`
  in particular propagates its exit status to `git checkout`.
- Already-running pi sessions keep the code they imported. Restart them to
  pick up the new `dist/`.
- `git bisect` rebuilds at every step. Prefix it with
  `PI_DELEGATE_NO_AUTOBUILD=1`.

`npm run test:hooks` exercises all of this against throwaway repositories in
`$TMPDIR` with a stubbed `npm`, and runs as part of `npm run quality`.

## Working with pi-prompt-template-model

If you also use [pi-prompt-template-model](https://github.com/nicobailon/pi-prompt-template-model)
(PTM) — the slash-command runner with `model:` / `skill:` / `loop:` /
`chain:` / `bestOfN:` frontmatter — `pi-delegate` can serve as the
delegation backend whenever a template uses `subagent:`, `parallel:`, or
`bestOfN:`.

```yaml
---
description: Audit the diff in three parallel workers
model: claude-sonnet-4-20250514
subagent: reviewer
inheritContext: true
parallel: 3
worktree: true
---
Audit the diff: $@
```

Running `/audit-diff something` with both extensions installed will:

1. Render the prompt body via PTM (model selection, skill injection,
   `$@` substitution).
2. Hand the delegated batch to `pi-delegate` via the
   `prompt-template:subagent:request` event channel.
3. Run three direct-mode workers on PTM's resolved worker model(s) in their own git worktrees, all visible
   in `pi-delegate`'s transcript overlay (`Option-O` / `Alt+O`, or `Ctrl+Alt+D`). Direct-mode workers
   do not support steering. Explicit supervised runs and authenticated detached drivers use their
   documented steering routes. PTM can still cancel the direct request through its cancellation event.
4. Return a combined response so PTM can continue with its loop / chain /
   compare flow.

### How the bridge picks who handles a request

`pi-delegate` and the legacy `subagent` extension can both answer PTM
events. The `ptmBridge.handleRequests` config controls which one wins:

- `auto` (default): `pi-delegate` listens iff
  `~/.pi/agent/extensions/subagent/agents.{ts,js}` does **not** exist.
  Install `pi-delegate` over the legacy ext by uninstalling `subagent`.
- `always`: `pi-delegate` always answers. Use when both are installed but
  you want `pi-delegate`'s overlay / steering / dispatch.
- `never`: don't touch PTM events. Use to roll back without uninstalling.

When the bridge is active, it sets `PI_SUBAGENT_RUNTIME_ROOT` so PTM's
`discoverAgents` lookup imports `pi-delegate`'s agent registry (no
filesystem games). If you've already exported that env-var manually, the
bridge respects your value.

### Model and context compatibility

- PTM's resolved `model` now drives the worker that `pi-delegate` starts.
  In parallel requests, `tasks[i].model` overrides the request-level
  `model` for that slot.
- PTM model selection is applied as an invocation-scoped clone of the
  agent config. Durable agent files are not mutated.
- Because PTM sends an explicit model and does not describe a fallback
  policy, an unresolvable PTM model fails clearly instead of silently
  falling back to the agent's durable model or the foreground session
  model.
- PTM v1 response fields (`context`, `model`, `messages`,
  `parallelResults`, etc.) are preserved. Additional optional provenance
  fields report requested vs. actual model (`requestedModel`,
  `actualModel`, `attemptedModels`, `modelFallback`) and requested vs.
  effective context (`requestedContext`, `effectiveContext`,
  `contextWarning`).
- `inheritContext: true` arrives from PTM as `context: "fork"`. The Phase 1
  bridge does **not** scrape or serialize the parent session and does not
  silently run the request with fresh context. It rejects the request before
  agent discovery and delegate execution with an actionable compatibility
  error. Responses preserve `requestedContext: "fork"` while omitting
  `effectiveContext` because no worker ran. Bounded producer context seeds are
  deferred to a trusted-producer/focused P1 follow-up.
- The bridge is installed on Pi `session_start` with the live
  `ExtensionContext` and disposed on `session_shutdown`; PTM request cwd is
  passed separately to direct execution, so model registry/auth/session
  lifecycle hooks remain the real Pi context rather than a fabricated stub.

### Phase 1 limits (current shipping behaviour)

- Direct-mode only for supported PTM requests — no supervisor-fork loop yet.
  Each `context: "fresh"` request runs one worker (or N parallel workers)
  without an inner review-and-iterate layer. `context: "fork"` is rejected
  until a bounded parent-context seed contract is implemented.
- Parallel cap is 6. `bestOfN` lineups with > 6 slots fail with a clear
  error; chunking is planned.
- Live progress widget (PTM's above-editor card) shows "running…" but no
  per-tool / token detail. The transcript overlay (`Option-O` / `Alt+O`, or `Ctrl+Alt+D`) has
  the full picture.
- Loop convergence works for `write` / `edit` tool calls (synthesized
  from worker transcript) but not for other tools.

`docs/ptm-support.md` is the support contract: the full matrix of which PTM
fields, protocol versions, and request shapes are accepted or rejected, with
the exact refusal messages. Read it to answer "will my template work?".
`docs/prompt-template-bridge.md` is the design document behind it — rationale,
architecture, and roadmap.

## Replacing pi-subagents

`pi-delegate` is intended to cover the common `pi-subagents` workflows while
adding supervised review-and-iterate forks. Most prompts, skills, and slash
invocations port over with no edits other than the tool name (`subagent` →
`delegate`), but this is not a blanket claim that every pi-subagents field is
accepted or has identical semantics. The caveats below summarize the remaining
follow-up gaps.

### Parameter mapping

Every ordinary `delegate` run shape dispatches in the background by default.
Where an existing pi-subagents caller depends on receiving the final result
before its next action, add `await: true`; changing only the tool name changes
the delivery timing.

| pi-subagents shape                       | pi-delegate equivalent                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `subagent({agent, task})`                | `delegate({runs: [{agent, task}], await: true})` to preserve foreground return; omit `await` for background |
| `subagent({tasks: [...]})`               | `delegate({runs: [...], await: true})` to preserve foreground return; omit `await` for background |
| `subagent({chain: [...]})`               | `delegate({runs: [...], await: true})` with `after: "previous"` on each ordered entry; omit `await` for background |
| `subagent({chain: "saved-chain"})`       | `delegate({chain: "saved-chain", await: true})` to preserve foreground return |
| `subagent({action: "list"})`             | `delegate({action: "list"})`                                                 |
| `subagent({action: "create", config:…})` | `delegate({action: "create", config:…})`                                     |
| `subagent({context: "fresh"})` (default) | `delegate({…})` (direct workers/chain steps seed fresh by default)                  |
| `subagent({context: "fork"})`            | follow-up: direct-worker `seed_from: "branch"` is not implemented |
| `subagent({async: true})`                | `delegate({…})` already dispatches by default; use `delegate({await: false})` when the intent should be explicit |
| `subagent({clarify: true})`              | follow-up: no agent-manager / chain-clarify TUI in pi-delegate yet           |
| `subagent({share: true})`                | follow-up: session sharing is not implemented                                |

### Slash command mapping

pi-delegate does not register pi-subagents slash aliases. Use `/delegate TASK --agent NAME` for one worker, `/delegate TASK --chain NAME` for a saved chain, `/delegate --agents` for discovery, and `/delegate-inspector` for status and transcripts. Use the `delegate` tool API for inline chains and parallel workers.

### Co-installation

Both extensions can run side by side. pi-delegate owns only `/delegate`, `/delegate-cancel`, `/delegate-inspector`, and `/delegate-help`; pi-subagents keeps its own slash names. The `delegate` tool name is also distinct. Each extension has its own runtime registry, so their inspection surfaces show different work.

### Invocation-scoped worker overrides

Worker-slot overrides are intentionally invocation-scoped. `model`, `thinking`,
`fallbackModels`, and `skill`/`skills` apply to the effective worker
`AgentConfig` for only the call/entry where they appear; `skill:false` disables
injected skills for that worker invocation. These fields are supported on every
run entry and on saved chain steps.

For supervised runs, this is **worker-only**: the fork-clone supervisor remains
a clone of the main agent and still uses `clone_mode`, `rounds`,
`supervisor_instructions`, and `summary_model` for the supervision/collapse
loop. If you need a different supervisor model, that is a separate follow-up
design, not the current worker override surface.

The detached driver mode is separate from worker-slot overrides.
The legacy `orchestrate.model` transport field is supported for the hosted driver
process, while `orchestrate.thinking` is deliberately deferred and should not be
passed expecting an effect.

### Remaining follow-up gaps

Do not treat these pi-subagents fields/shapes as drop-in parity yet:

- Direct-worker `context:"fork"` / `seed_from:"branch"` support. Slash `--fork` instead selects supervised execution.
- Dynamic chain fan-out (`expand`/`collect`) and strict `outputSchema` contracts.
- Per-call `acceptance` contracts, review/repair loops, `outputMode`, and structured verification metadata.
- Foreground `timeoutMs` / `maxRuntimeMs` aliases and the `async:true` alias (`delegate` already runs in the background by default; use `await:false` to be explicit).
- `share`, `sessionDir`, `artifacts`, `clarify`, `includeProgress`, and subagent-specific control telemetry knobs.
- Exact `interrupt` / `resume` / `doctor` action compatibility aliases.
- Chain-parallel automatic `worktree:true` parity beyond the currently supported direct/parallel worktree paths.

### Known semantic differences

- **Supervised forks vs subprocess isolation**. pi-delegate runs every
  worker in-process (`AgentSession`), inheriting the parent's process
  state. pi-subagents spawns a `pi` subprocess. In practice this matters
  only if your agent installs/modifies the global Node module cache, mucks
  with `process.env`, or relies on subprocess-level signal handling.
- **mcpDirectTools**. The `tools: mcp:foo` syntax is parsed but the in-
  process API can't host an MCP server. Both supervised and direct mode
  emit a one-time warning when an agent declares mcpDirectTools and skip
  them. Use `extensions:` instead.
- **Direct-worker branch seeding**. Direct workers and chain steps still start fresh.
  `/delegate --fork` selects supervised execution; it does not seed a direct
  worker from the caller's branch.

## Management actions

`delegate({action: ...})` reads and writes agent / chain definition files
on disk without spawning any worker. Mirrors the pi-subagents surface.
Inside delegate-owned nested workers, mutation actions (`create`, `update`,
`delete`) are denied; only read-only management actions remain available.

For foreground management input, `config` list fields use arrays or `false`; on create, `false` leaves a list field absent, and on update, it clears an existing field. CSV strings such as `tools: "read, bash"` are rejected. This does not change on-disk frontmatter parsing: existing agent files with comma-separated `tools`, `skills`, or other list fields remain readable.

`delegate({action: "health"})` or `/delegate --health`
is the read-only operator surface: active/completed **in-process** run counts,
separate active/terminal detached-driver counts, on-disk
substrate sizes (`run-state.json`, `orchestrate/`, `event-bus/`), pending
dispatch wakes / driver results, stale two-phase claims, and the
maintenance-timer status. Use it to spot bloat before it bites.

### Periodic maintenance

Foreground sessions arm an unref'd ~45s interval (never in spawned child
processes, never keeps the event loop alive). Each tick first reconciles any
route-backed detached driver runner whose process identity disappeared
before writing a terminal record, then re-runs the two pending delivery legs —
driver results finished while the parent stayed alive, and dispatch wakes
dropped across a session replacement — so recovery no longer waits for the
next `session_start`.

Abrupt-runner reconciliation uses an owner-only, stale-recoverable per-run
claim. A run with a complete secret-safe launch record may start one replacement
runner, retaining the run ID and authenticated control route. Invocation or
agent environment overrides are never persisted, so those runs fail closed
instead of replaying without their original transport. Replacement after the
`running` phase is whole-attempt replay: task side effects completed before the
crash may run again. It is not mid-turn session resumption.

If replacement is unavailable or also exits, the first reconciler atomically
persists a categorical `runner-exited` failure, publishes it through the normal
pending-result outbox, and removes the secret-bearing route plus active marker.
A prepared-payload phase lets another foreground resume after a reconciler
crash without double-terminalizing or manufacturing a second logical pending
enqueue after publication. Persisted diagnostics contain only bounded
categories/scalars (last whitelisted phase/activity, PID, stderr-capture
presence, and unknown exit/signal sentinels); prompts, control secrets, raw
stderr, and model output are never copied. `delegate_control(action="result", runId)` continues
to read the canonical result after pending delivery consumes the wake copy.

The delivery legs remain idempotent and claim-disciplined, so the timer adds
liveness rather than a polling requirement. The existing sink boundary remains
at-least-once: a process crash after `sendMessage()` acceptance but before
claim consumption can still cause a retry because the sink has no durable
receiver-side deduplication ID. Every ~20th tick (and once at
startup) `sweepOldCompletedRuns` applies a 7-day retention window to completed
runs in `run-state.json` (owner-scoped: a live sibling session's history is
never touched).

```js
// List agents and chains across all scopes
delegate({ action: "list" })

// Get full detail (read-only)
delegate({ action: "get", agent: "scout" })
delegate({ action: "get", chain: "recon-plan" })

// Create a user-scope agent
delegate({
  action: "create",
  config: {
    name: "scout",
    description: "Recon helper",
    systemPrompt: "You are scout. Investigate and report.",
    model: "openai/gpt-5",
    tools: ["read", "bash"],
    skills: ["librarian"],
    scope: "user", // or "project" — defaults to "user"
  },
})

// Update — falsy values clear: `{model: false}` removes the model field.
delegate({
  action: "update",
  agent: "scout",
  config: { model: false, description: "Renamed scout" },
})

// Create a chain template
delegate({
  action: "create",
  config: {
    name: "recon-plan-implement",
    description: "Validated delivery pipeline",
    steps: [
      { agent: "scout", task: "scan {task}", artifact: "context.md" },
      { run: "verify-context", command: "node scripts/verify-context.mjs", timeoutMs: 10_000 },
      { chain: "review-context", task: "review {previous}" },
      { agent: "planner", task: "plan based on {previous}", reads: ["context.md"] },
      { agent: "worker", task: "implement {previous}" },
    ],
  },
})

// Then run it by name:
delegate({ chain: "recon-plan-implement", task: "fix the auth bug" })
```

Files land at:

- User scope: `~/.agents/<name>.md` and `~/.agents/<name>.chain.md`
- Project scope: `<repo>/.pi/agents/<name>.md` and `<repo>/.pi/agents/<name>.chain.md`

The format is YAML frontmatter followed by `## <agent>` sections for worker
steps. A composed step uses `## chain:<saved-chain-name>` and a task body; its
management shape is `{ chain: "saved-chain-name", task?: "..." }`. A native
command stage uses `## run:<label>`, requires `command`, and has no task body:

```md
## run:verify-context
command: node scripts/verify-context.mjs
cwd: tools
env: {"MODE":"strict"}
timeoutMs: 10000
```

The matching management shape is
`{ run: string, command: string, cwd?: string, env?: Record<string, string | null>, timeoutMs?: number }`.
The worker, reference, and run shapes are mutually exclusive. A run stage starts
no LLM. Its `cwd` resolves against the top-level chain working directory,
`timeoutMs` defaults to 60 seconds, and `env` uses the same protected-key
filtering as worker environment overrides. The command receives the absolute
shared chain directory — the `{chain_dir}` — in `PI_DELEGATE_CHAIN_DIR`; command
text does not expand `{task}`, `{previous}`, or `{chain_dir}`. This is the
chain's own coordination directory, distinct from each producer's private v2
artifact attempt. A run stage is not handed another step's retained snapshot
through this variable.

A successful run stage leaves the scoped `{previous}` value unchanged. A
non-zero exit, timeout, cancellation, invalid configuration, unavailable `cwd`,
or process-start failure halts the chain. Standard output and standard error are
sanitized and capped at 8 KiB each for diagnostics. Project-scoped run stages
require project trust. A confined nested caller cannot invoke a run stage because
its separate shell process cannot inherit the caller's write guard.

Saved-chain references resolve recursively with the same user/project scope
precedence as a top-level saved chain. The complete reference graph and every
run stage are preflighted before any worker starts and before a nested caller's
agent allow-list or write-confinement checks. A missing reference, cycle, or
invalid deterministic stage therefore starts no partial pipeline. Composition
expands into the root run: every worker and run stage shares one `chainDir`, and
a reference consumes no extra delegation depth.

Each reference opens a task scope. Its task is evaluated once at that boundary,
so `{task}` stays frozen for every step in the referenced chain. `{previous}` is
local to that chain, advances after each worker, stays unchanged across a
successful run stage, and returns its final value to the parent chain when the
reference completes.

## Calling from a CLI process (no live pi session)

For Node CLIs that need to dispatch subagents but cannot rely on pi being
the host process, `pi-delegate` exports a free-standing
`delegateFromCli()` entrypoint:

```ts
import { delegateFromCli } from "@centerforagenticai/pi-delegate";

const result = await delegateFromCli({
  tasks: [{ name: "scout", agent: "scout", task: "Scan src/" }],
  cwd: process.cwd(),
});
console.log(result.combinedContent);
```

The entrypoint covers **solo runs only** (single + parallel) — supervised and
saved-chain dispatch stays pi-runtime-coupled because it needs the
slash-command overlay, transcript widget, and dispatch wake-up. Its `tasks`
field is this entrypoint's own input shape, not the `delegate` tool's `runs[]`
grammar. Sync-only return shape with per-run status, output, optional graft
commit-SHA trailer extraction, and AbortSignal cancellation.

See [`docs/cli-delegate.md`](docs/cli-delegate.md) for the full API
reference, security notes (project-trust auto-accept), and a migration
example for downstream consumers.

## Caveats / known limitations

- The fork-clone model must exist in your `ModelRegistry` (`ctx.model`). If
  your main model has no configured auth, fork-clone creation fails.
- `clone_mode: "full"` dumps the entire main-thread history into the
  fork-clone — watch costs if the main thread is huge. Use `"snippet"` or
  `"task_only"` for cheap delegations.
- Worker sessions are stored under `~/.pi/agent/sessions/forks/` — a
  discoverable subdir of the main sessions dir (so host/session readers that
  scan `sessions/` can resolve a `workerSessionFile`), kept out of your main
  `/resume` picker (which lists per-cwd sessions) to avoid clutter. Open them
  with `pi --session <path>` or by copying their path.
- Outside the opt-in escalation native prompt and existing overlay controls,
  there is no general mid-fork user-driven supervisor UI. The main agent still
  drives the fork; a `supervisor: "user"` mode is not implemented.
- `completionNotifyStrategy: "synthetic-tool-pair"` is reserved for a future
  pi release that exposes `appendMessage` to extensions. Setting it today
  logs a warning and falls back to `custom-message`.

### Durable worker origin

New direct and supervised worker sessions persist a `delegate.worker-origin`
custom entry before their first turn when both the owning session ID and run ID
are available. Its version-1 data contains `ownerSessionId`, `runId`, `forkName`,
and `agent`. These are exact producer identifiers; nested dispatches refer to
the invoking coordinator. The entry survives operational run-history pruning
because it belongs to the worker transcript. Workers without dispatch identity
omit it; no parent is inferred. Existing transcripts are not backfilled.

Consumers may read this generic record and project their own application
metadata. Application-specific entries and task previews remain consumer-owned.

## License

MIT. See [LICENSE](LICENSE).
