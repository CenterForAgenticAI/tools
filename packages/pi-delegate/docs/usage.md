# Using pi-delegate

This guide is for Pi users who need the complete delegation, control, recovery, and transcript-inspector behavior.

> **Current package note:** The package also ships the `publisher` builtin agent and the `delegate-only` skill and `/delegate-only` command. The sections moved from the previous README remain verbatim below; the README [Surface](../README.md#surface) table is the current registration summary.

A pi extension that runs work on parallel specialist subagents and **collapses**
each run into one completion result. A `supervised` run additionally **forks the
main agent** into a private multi-turn conversation with its worker. By default
the initial tool call returns a dispatch envelope immediately and the collapsed
result arrives later in an automatic completion wake. Use `await: true` only for
an explicit foreground dependency barrier.

Code-owned consumers can use the constructable programmatic client for one-shot
`dispatch()`, status/harvest, steer, and cancel over the same production handlers.
`dispatch()` is canonical; `direct()` and `managed()` are deprecated aliases.
It writes stable receipt/result envelopes with execution provenance; see
[Programmatic runtime API](runtime-api.md).

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
  [`docs/delegate-tool-api.md`](delegate-tool-api.md) for which is which.


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
- The footer **activity ticker** shows aggregate liveness counts for immediate foreground-owned runs under `01-delegate-activity`, separate from the `00-delegate-usage` token/cost status. Per-run activity stays in the status widget. See [Activity ticker](activity-ticker.md).

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
any slot is escalation-enabled. See [Delegate escalation](escalation.md)
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
   in the footer. See [Activity ticker](activity-ticker.md) for privacy
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
[`docs/write-confinement.md`](write-confinement.md).

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
