# Delegate activity ticker

The activity ticker maintains two deliberately separate projections of immediate
delegate work: aggregate liveness in Pi's normal interactive footer, and
per-run activity headlines in the below-editor widget. The footer uses extension
status key `01-delegate-activity`; the existing `00-delegate-usage` key remains
an independent status and sorts before it. Both are additive extension status
entries composed with Pi's existing footer: neither replaces Pi's footer or the
other status.

When the ASCII fallback is active, the footer remains aggregate-only, regardless
of run count:

```text
1 delegate live
3 delegates live
```

By default, Nerd Font mode adds stable, readable run-mode counts without adding
per-run headlines:

```text
5 delegates live ·  1 supervised delegate ·  2 direct delegates ·  1 chain delegate ·   1 background direct delegate
```

The icons supplement text; they never carry meaning alone. Their meanings are:

| Icon and label | Meaning |
| --- | --- |
| ` direct` | One worker without a supervisor; the slash-command default. |
| ` supervised` | A private supervisor can iterate with the worker. |
| ` chain` | A saved sequential worker pipeline. |
| ` background` | Returns immediately and wakes the session later; the slash-command default. |
| ` unknown` | Fallback for incomplete or future run metadata. |

Here, background means an in-process dispatch recorded with the legacy
`detached: true` state field. Detached cross-process driver children remain outside
this footer's scope.

Elapsed wall-clock time never rotates through run identities. Detailed
identities and state for every live run stay in the below-editor widget and the
transcript overlay's persistent `live N:` summary. The widget uses concise `S`
and `W` labels when the supervisor and worker both have useful phases. It omits
the routine passive `S waiting for worker` state, and omits `W waiting for S`
while another concrete phase is visible, so those relationship facts cannot
crowd out the activity headline. The widget renders that bounded headline on a
separate indented line below the run's status, so narrow terminals do not hide
it behind identity, phase, and usage fields. Direct workers and chain steps show
only the worker actor. Queued user guidance is an additional `U guidance queued`
fact and never overwrites the supervisor phase.
Terminal status is labelled as run lifecycle rather than being attributed to
both actors without evidence. A deterministic or semantic headline remains
a bounded fallback, while prompt, guidance, escalation, control-tool, and
terminal facts take precedence. The compact rolling token/cost chip sums the
supervisor clone (when present), worker, cache, and ticker usage attributed to
that run.

At 56 through 99 columns, actor labels and the run identity stay ahead of
rounds, message counts, and optional activity detail. The headline keeps its own
width-safe line at every per-run tier. Narrower terminals use one width-safe
`◆N active` aggregate with a labelled representative live phase; when that
aggregate represents one run, its headline can appear on an indented second
line. Terminal-only and mixed live/terminal aggregates keep their counts
truthful.
The footer reports only currently live runs. Terminal outcomes are not repeated
there; the below-editor widget owns the outcome summary. The widget keeps
`completed` rows for 10 seconds, `aborted` rows for 30 seconds, and `failed` rows
for 5 minutes. Live and `paused` rows do not expire through this policy. After a
row retires, one current-session summary retains succeeded, failed, and aborted
terminal run totals. The summary is width-safe, uses compact labels when needed,
and may include `/delegate-inspector` at wide widths. Ambient retirement only hides
the row: results, transcripts, usage, costs, diagnostics, and durable history
remain available through `delegate_control` action `status` and
`/delegate-inspector`.

Set `PI_DELEGATE_ASCII=1` or use `TERM=dumb` for ASCII widget glyphs. Headlines
and actor labels use ANSI/Unicode-safe display-width handling. The short-lived
actor projection retains only phase labels and bounded tool names made
from letters, digits, dots, underscores, and hyphens; it never copies the local
headline's command/path metadata, prompt or
guidance bodies, escalation payloads, answers, tool-call ids, results, or model
reasoning. Escalation labels come only from the worker's blocked state and
explicit supervisor controls. The widget does not guess who holds a request from
request data; an operator hold reported outside the actor stream therefore
remains `W awaiting escalation` after the explicit forwarding phase.

## Defaults and model consent

In eligible interactive foreground sessions, the deterministic activity ticker
is enabled by default. It derives concrete factual text from local runtime
state, such as `running npm test`, `reading src/runtime.ts`, or `searching for
activity`, and keeps the settled target instead of degrading to a generic
`working` or `using <tool>` label. Lifecycle text such as `awaiting escalation`,
`completed`, `failed`, `aborted`, or `paused` remains authoritative. This mode
does not need a model.

Model-generated headlines are opt-in:

- Omit `activityTicker.model` (the default) for **zero ticker model lookups,
  zero ticker provider calls, zero ticker-model cost, and zero provider-bound
  ticker egress**.
- Set an explicit `provider/model` reference, such as
  `"anthropic/claude-haiku-4-5"`, to fix the request destination to that model.
- Set the model to `"auto"` to select only the built-in
  `anthropic/claude-haiku-4-5` destination. If Haiku is unavailable, the ticker
  retains deterministic headlines and does not select another model.
- Set `activityTicker.enabled` to `false` to disable both deterministic display
  and semantic summaries completely.

Enabling semantic summaries can incur provider token and cache usage and cost.
An unavailable model or authentication failure does not silently reroute an
explicit `provider/model` selection.

## Configuration

Configure the ticker in
`~/.pi/agent/config/pi-delegate/config.json` (or the sibling
`config.local.json` overlay):

```json
{
  "footerIcons": "nerd-font",
  "activityTicker": {
    "enabled": true,
    "model": "anthropic/claude-haiku-4-5",
    "minSummaryIntervalMs": 15000,
    "debounceMs": 2000,
    "maxConcurrentSummaries": 2,
    "summaryTimeoutMs": 10000,
    "terminalRetentionMs": 5000,
    "maxHeadlineChars": 100,
    "maxInputChars": 4000
  }
}
```

Remove `model` from that example for the default deterministic-only mode. Nerd
Font indicators are enabled by default.

`footerIcons` sets the icons for every delegate surface: the footer, the
below-editor widget, and the transcript overlay. It takes three values.

| Value | Use it when |
| --- | --- |
| `"nerd-font"` (default) | Your terminal font is patched with Nerd Font glyphs. |
| `"unicode"` | Your font is not patched but does cover common symbols. This is what the overlay drew before the setting reached it. |
| `"ascii"` | Plain text only. |

pi-delegate cannot detect whether the active terminal font contains Nerd Font
glyphs. Set `"unicode"` or `"ascii"` yourself to avoid replacement boxes when it
does not. `PI_DELEGATE_ASCII=1` and `TERM=dumb` force `"ascii"` whatever is
configured.

`footerIcons` is a top-level field. The remaining fields in this table belong
inside `activityTicker`.

| Field | Default | Meaning |
| --- | ---: | --- |
| `footerIcons` | `"nerd-font"` | Icons for the footer, the widget, and the transcript overlay. `"nerd-font"` adds run-mode counts and row badges; `"unicode"` and `"ascii"` drop both and keep the historical footer layout. Invalid values, `PI_DELEGATE_ASCII=1`, and `TERM=dumb` fall back to `"ascii"`. |
| `enabled` | `true` | Enables the complete deterministic and optional semantic ticker in eligible interactive foreground sessions. `false` disables it. |
| `model` | omitted | Omission guarantees no ticker model lookup, provider call, ticker-model cost, or provider-bound ticker egress. Accepts an explicit non-empty `provider/model` reference or literal `"auto"`, which selects only `anthropic/claude-haiku-4-5` and fails closed when unavailable. |
| `minSummaryIntervalMs` | `15000` | Minimum interval between semantic-summary request starts for one run. It is not a periodic status refresh. |
| `debounceMs` | `2000` | Quiet period used to coalesce activity bursts before a summary is queued. Concrete local status changes render immediately; semantic work waits for the larger of this debounce and the remaining cooldown. |
| `maxConcurrentSummaries` | `2` | Process-wide concurrency cap for ticker summaries. Each run also has a one-request single-flight limit. |
| `summaryTimeoutMs` | `10000` | Bounded timeout for each ticker summary request. |
| `rotateIntervalMs` | `4000` | Deprecated compatibility field. Accepted but ignored; the footer no longer rotates. |
| `terminalRetentionMs` | `5000` | Activity-ticker headline cleanup grace for truthful terminal text. It does not configure ambient widget row retention. `0` clears immediately. |
| `maxHeadlineChars` | `100` | Maximum accepted/generated per-run headline length before widget-width truncation. |
| `maxInputChars` | `4000` | Hard character bound on the serialized allowlisted provider facts. |

All cadence, concurrency, timeout, and size fields must be positive safe
integers. `terminalRetentionMs` is the exception: it is a non-negative safe
integer so `0` can request immediate cleanup. Invalid values are reported only
through pi-delegate's diagnostics channel and fall back to the defaults above;
configuration loading does not block delegation.

## Privacy boundary for semantic headlines

A semantic ticker call sends a fixed system instruction plus a bounded
JSON-serialized facts payload constructed by an allowlist reducer, followed by a
fixed role reminder line. The provider-bound fact classes are:

- a bounded capsule of the delegated task: its opening statement of purpose only,
  skipping metadata lines, headings, and rules, capped at 200 characters;
- the bounded prior generated headline, when one exists;
- bounded **incremental assistant prose** since the accepted transcript cursor;
- tool **names** only, excluding the supervised loop's known control tools;
- the current lifecycle state; and
- structured error facts only: a `hasError` boolean and, when available, an
  error class.

The ticker does **not** send:

- thinking/reasoning entries;
- user or system transcript prose;
- raw tool-call text, including command, argument, path, query, and URL values
  sourced from it;
- tool metadata values, including command, path, query, and URL fields;
- any tool-result body (successful or failed);
- free-form runtime error messages; or
- the full transcript.

These are structural source-field exclusions, not content redaction. The
allowlisted task, prior headline, and assistant prose are normalized and
truncated, but they are not scrubbed for commands, paths, queries, URLs,
secrets, or similar strings they may themselves contain. Omit `model` and use
deterministic-only mode when provider egress of those prose fields is not
acceptable.

For legacy tool-call entries, only a validated tool identifier may be parsed;
arguments remain excluded. `maxInputChars` bounds the serialized string by
slicing it at the configured character limit, so the provider may receive a
JSON-serialized prefix rather than a complete valid JSON value. Fields are
serialized in order of how badly the headline needs them — lifecycle and error
facts, tool names, prior headline, assistant prose, then the task capsule — so a
long transcript truncates the least informative field rather than the activity
being described. The role reminder is appended after that slice and is therefore
never truncated.

## Scheduling, failures, and lifecycle truth

Owned runtime registration, transcript, state, and completion events refresh the
deterministic text immediately. Semantic work is debounced and cooled down per
run. The 15-second setting is a minimum interval between request starts, not a
polling loop: concrete local status changes do not wait for a model response.
Requests are reserved for useful quiet phase boundaries or new assistant prose.
An active worker/direct tool keeps the semantic path quiet and supplies the
immediate deterministic headline. A supervised control tool such as
`wait_for_worker` is coordination rather than worker activity: it does not
invalidate an accepted headline, block a pending summary, enter the provider
tool-name list, or trigger a summary when it settles. Its supervisor phase can
still appear separately when that phase carries useful information.
Bursts are coalesced, each run has at most one request in flight, and the
process-wide concurrent summary cap is enforced across ticker controllers. One
dirty follow-up can be scheduled after an active request. Timeouts, cancellation,
and generation checks prevent an older response from replacing newer activity.

Lifecycle truth always wins over model prose. In particular,
`awaiting-escalation`, `paused`, `failed`, `aborted`, and `completed` replace any
older generated headline. Terminal text remains only for
`terminalRetentionMs` (5 seconds by default), then the status is cleared.

Model selection, authentication, completion, parsing/output, timeout,
cancellation, empty-text, and stale-response failures retain the deterministic
factual fallback. They do not add an error to the agent conversation and do not
change delegate completion, wakes, collapse, steering, or cancellation.

A response is also rejected when it is not a headline about the run. Two
acceptance guards apply:

- **Generic restatement.** When a concrete local tool target is already settled,
  a response that only restates the lifecycle or the bare tool name cannot hide
  it.
- **Role violation.** A response written in the first person, one that declines
  or answers the described task, one that speaks about the summarizer's own
  access or capabilities, or one shaped as multiple lines, bold text, or a
  bullet/numbered item is discarded. This guard needs no settled local fact to
  fall back on, because such a response is never a truthful description of the
  run: the summarizer has no tools, so an incapacity claim can only be about
  itself while the run it describes is usually working normally.

Both guards keep the deterministic headline, settle the reserved usage exactly
once, and surface nothing to the operator. The bias is toward rejection: a false
rejection costs one refresh and the next transcript event retries, whereas a
false acceptance persists untrue text in the activity history.

The ticker publishes accepted per-run display headlines to an ephemeral,
in-process UI store for the widget, and records each changed visible status in a
separate durable activity history on the run record. History is
redacted, timestamped, deduplicated, and capped at the latest 10 entries. The
`delegate:activity-status` event refreshes the inspector without appending a
transcript message or feeding the status back into summary scheduling. The
history is written to `run-state.json` and hydrated with live and recently
completed runs after reload. Publisher ownership prevents a disposed
predecessor controller from clearing a successor session's newer headline.

On session replacement or shutdown (`reload`, `new`, `resume`, `fork`, or
`quit`), the controller unsubscribes, stops timers, aborts pending requests, and
clears its status before the foreground runtime is aborted. A predecessor
controller cannot clear a successor session's status.

## Scope: immediate foreground work only

The v1 ticker renders only runs for which the current process is the owner. It
covers immediate foreground-owned supervised `agents`, direct `tasks`, and
`chain` steps because all three use the same normalized runtime events. The
inspector can show the durable activity timeline for live and recently
completed runs after reload, while the ticker itself remains a lossy immediate
foreground projection.

It is inert in non-interactive, headless, print, JSON, and delegate-child
contexts: those contexts do not render activity or issue ticker model requests.
Foreign runs hydrated from another live process are also excluded. Descendant
and detached cross-process activity, including detached driver children,
is intentionally out of scope for v1; do not treat their absence as inactivity.

## Usage and cost accounting

Accepted ticker model usage is recorded separately at every supported level:
live run state, final run results, and durable delegate usage metadata.
The distinct fields are:

- `tickerInput`
- `tickerOutput`
- `tickerCacheRead`
- `tickerCacheWrite`
- `tickerCost`

Aggregate delegate input, output, cache, total-token, and cost values include
that ticker usage exactly once. Consequently `00-delegate-usage` includes ticker
spend in its aggregate footer totals while durable metadata retains the ticker
breakdown for attribution. Deterministic-only operation leaves all ticker usage
and ticker cost counters at zero/absent.

## Footer versus authoritative inspection and control

The footer projection is intentionally lossy: it shows aggregate live counts and,
in Nerd Font mode, stable run-mode counts. It never shows terminal outcomes, a
run identity, or an activity headline. It can still be truncated at narrow
widths. It is not a transcript,
audit log, completion result, liveness guarantee, or control plane.

Use the authoritative surfaces when detail or action matters:

- Open the transcript inspector with `Option-O` / `Alt+O`, the configured
  fallback shortcut, or `/delegate-inspector`.
- Use `delegate_control` action `status` to inspect current/recent run and run state.
- Use the inspector or `delegate_control` action `steer` to guide an explicit supervised run's copied supervisor `fork`, or use an authenticated detached `driver`'s control route. Direct workers, chain steps, and unknown in-process shapes reject steering.
- Use the inspector or `delegate_control` action `cancel` to cancel work; authenticated detached drivers require their authenticated control route.
The transcript inspector and runtime state remain authoritative even when a
semantic headline is enabled, missing, stale, or unavailable. The inspector
keeps a persistent summary of all live runs and the latest bounded activity
history for the selected run, including history hydrated after reload;
when historical selection is preserved while work is live elsewhere, its
header says so and `l` jumps to/cycles through live runs.

## Test coverage map (`REQ-ACTIVITY-TESTS`)

The required shape coverage stays in
`tests/integration/ticker-shapes.test.ts`:

- `observes a supervised agents run only through normalized runtime events and makes no omitted-model calls`
- `observes a direct worker batch only through normalized runtime events and makes no omitted-model calls`
- `observes a chain run only through normalized runtime events and makes no omitted-model calls`

Each test uses a deterministic `FakeClock`, injects a structured local tool
name and target through the production runtime update seam, and checks the
concrete local history before any clock advance. It also checks normalized
register/update/transcript/completion events, the separate
`delegate:activity-status` event, terminal `completed` history, bounded and
timestamped `source` values, no synthetic transcript message, and zero ticker
provider calls.

The existing focused tests cover the remaining ticker boundaries:

- `tests/unit/actor-activity.test.ts` — ownership-safe phase publication, coalesced session events, parallel tools, supervisor controls, and privacy bounds.
- `tests/unit/status-widget-activity.test.ts` — concise actor phases, passive-wait suppression, prompt and escalation overrides, terminal and mixed aggregates, ASCII glyphs, privacy, and exact 55/56/99/100 width boundaries.
- `tests/unit/activity-ticker.test.ts` — `records concrete local tool activity and preserves the settled target`, supervised control-tool filtering, provider privacy/opt-in, prompt/guidance invalidation, quiet-boundary scheduling, and the minimum 15,000ms between request starts.
- `tests/unit/runtime.test.ts` — `stores bounded consecutive-deduplicated history and emits a separate event`, `persists and hydrates activity history independently of transcript entries`, and `persists and hydrates only the latest ten changed statuses`.
- `tests/unit/transcript-overlay.test.ts` — `reopens over hydrated live and recent-completed history with consecutive entries` and `refreshes on delegate:activity-status without changing autoclose or transcript state`.
