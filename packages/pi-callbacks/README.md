# pi-callbacks

Persistent reminders, polling checks, background script callbacks, and token-based external callback hooks for Pi.

## Install

```sh
pi install npm:@centerforagenticai/pi-callbacks
```

## What it solves

When an agent needs to “wait for something,” ad-hoc sleeps, polling loops, and background scripts often fail to re-enter the agent context when the condition happens. `pi-callbacks` gives the agent explicit mechanisms that can inject a message later and optionally trigger a new agent turn.

## Architecture

`pi-callbacks` uses a **single central daemon per user/machine**:

- The daemon owns the stable local callback endpoint: `http://127.0.0.1:47837/callback`.
- Every Pi session that loads the extension ensures the daemon is running.
- Jobs and delivery events live in `~/.pi/agent/callbacks/jobs.json`.
- The daemon performs timers, polling, background scripts, and external token callbacks.
- On startup and hourly, the daemon prunes bounded history: active jobs and jobs
  with pending deliveries are always preserved, while terminal job history is
  kept for seven days (up to 100 jobs) and delivered-event history for one day
  (up to 100 events). Writes use compact JSON to reduce routine file size and a
  SQLite-backed cross-process lock so cleanup cannot overwrite a concurrent job
  or delivery update.
- Pi sessions do not run HTTP servers. They publish presence heartbeats, atomically
  claim delivery events routed to them, and inject only those claimed events.
- Store schema v1 is migrated to v2 in memory on read; the next mutation persists
  the migrated store, including session-presence state.

This keeps external hooks stable: scripts can call the same endpoint regardless of which Pi session created the token.

## Pending-work service

Other Pi extensions can discover the current session's pending callback work over Pi's event bus. The versioned service exposes exactly three fields:

- `count` — non-terminal (`pending` or `running`) jobs owned by the current session.
- `nextDueAt` — the earliest due time across reminders and polls, as an ISO 8601 string. It is absent when no timed job has a due time.
- `openEndedCount` — active scripts and token callbacks with no due time.

`nextDueAt` is a hint about the scheduler's current intent, not a promise about when a callback will fire. The service reads fresh store state on every query. It does not expose job details, history, cancellation, or control.

## Capabilities

- `callbacks` LLM tool
  - `action: "remind"` — notify in a duration (`5m`, `30s`, `1h`)
  - `action: "poll"` — run a shell command, fetch a URL, or watch a named source repeatedly until it reaches a verdict
  - `action: "script"` — queue a background shell command for the daemon and wake Pi on process exit
  - `action: "callback"` — mint a token + local HTTP/CLI hook for external scripts to call back
  - `action: "list" | "info" | "cancel" | "delete"`
  - poll controls: `maxRuns` and `pushEachResult`
  - routing controls: `target` and, for an explicit target, `targetSession`
- Slash commands
  - `/callbacks` — lists active jobs owned by the exact current session
  - `/callbacks --all` — lists active jobs across all sessions
  - `/callbacks --history` — includes retained terminal history for the current session; combine it with `--all` for global history (`/callbacks all` remains a current-session history alias)
  - `/remind-in <duration> <message>`
  - `/callback-token [message]`
  - `/callback-cancel <id-or-token>`
  - `/callback-delete <id-or-token>`
- Persistent state in `~/.pi/agent/callbacks/jobs.json`
- Central callback endpoint at `http://127.0.0.1:47837/callback`
- CLI helper: `pi-callbacks callback --token <token> --message "done"`
- Custom `pi-callbacks` message renderer for expandable callback details
- Live jobs widget below the editor, refreshed every 10 seconds while current-session jobs are active; it shows bounded per-job status and collapses when idle. It clears with `undefined` when idle
- Composed footer status line for active work or abnormal daemon/delivery state; healthy idle sessions are silent
- Scheduler-aware daemon health: `pi-callbacks status` reports the last scheduler tick, overdue poll count, and oldest overdue poll age. `/health` returns HTTP 503 and `ok: false` when the scheduler is stale, has a current reconciliation failure, or leaves a poll overdue beyond the staleness window.

## Daemon CLI

```bash
pi-callbacks start    # start daemon if needed and print endpoint
pi-callbacks status   # health + scheduler status + pid + endpoint
pi-callbacks endpoint # print callback endpoint
pi-callbacks daemon   # foreground daemon process
```

The extension starts the daemon automatically on session start and before creating jobs.

## Poll conditions

Polls can watch a named source as well as a command or URL. The first source is a GitLab CI pipeline, identified by its host, project path, and pipeline number:

```json
{
  "action": "poll",
  "source": {
    "kind": "gitlab_pipeline",
    "host": "gitlab.com",
    "project": "group/project",
    "pipelineId": 12345
  },
  "condition": "contains:success",
  "interval": "30s",
  "message": "Release pipeline finished"
}
```

The daemon shells out to `glab`, which must be installed and logged in for the requested GitLab host. Authentication stays in `glab`'s own configuration; no token is accepted or persisted in a poll job. Job results expose the source's normalised status in the widget. Terminal statuses are `success`, `failed`, `canceled`, `skipped`, and `manual`; other statuses keep the poll waiting. A missing `glab`, authentication failure, transport error, timeout, or invalid response is a monitoring failure, not a pipeline verdict.

The tool accepts condition strings:

- `contains:text`
- `not_contains:text`
- `regex:pattern`
- `exit:0`
- `status:200`
- `any`
- `always`

A bare condition string is treated as `contains:<string>`. Poll jobs default to
`pushEachResult: true`, so every condition-check result is delivered to the
agent, including non-matches and command/URL/source monitoring failures. The deployed daemon uses
a fixed 30-second timeout for each command, URL, or named-source poll; `pollTimeoutMs` is only
a `CallbackDaemonOptions` override for embedding and tests, not a CLI or config
setting. This makes waits visible:
the agent can decide whether to keep waiting, change the condition, cancel the
job, or report a failed pipeline/build.

Use `maxRuns` to fail a poll after a bounded number of attempts. Set
`pushEachResult: false` only when the initializing agent intentionally wants the
conversation to stay quiet until the condition matches or `maxRuns` is
exhausted. A wrong or unsatisfiable condition is a real, expected failure mode;
quiet polls with no `maxRuns` receive a periodic status check-in instead of
waiting silently. Check-ins are not condition matches, do not complete or fail
the job, include the latest bounded non-match summary, and point to
`callbacks action="info" id=<job-id>` for the recorded history.

## Periodic check-ins

Pending or running `poll` (when `pushEachResult: false`), `script`, and passive
`callback` jobs receive a check-in every 30 minutes by default. The interval is
measured from creation or the most recent delivery to that job, whichever is
later. A check-in resets that timer and is an advisory delivery independent of
the job's `triggerTurn` setting. Polls with `pushEachResult: true` already
report each result and are exempt; `maxRuns` still controls when a poll fails,
and terminal jobs receive no further check-ins. Reminder jobs are exempt because
their `dueAt` is a definite terminal schedule.

Configure the interval and whether check-ins trigger an agent turn in
`~/.pi/agent/callbacks/config.json` (use `null` to disable them):

```json
{
  "version": 1,
  "defaultTarget": "latest-active-cwd",
  "checkInIntervalMs": 1800000,
  "checkInTriggerTurn": true,
  "sleepReminderMinSeconds": 10
}
```

Invalid check-in settings fail closed with a configuration error. The bash sleep reminder is an advisory message, not a block: it defaults to direct literal sleeps of at least 10 seconds, and `null` disables it. Any positive literal sleep in a recognized `while`, `until`, `for`, or `select` loop also triggers the reminder regardless of duration. It sends at most once per session or compaction window. Use `callbacks` instead of keeping a foreground bash command asleep.

Invalid sleep reminder settings also fail closed with a configuration error. Check-ins use
the job's configured delivery target. An origin-targeted job still ends with its
origin session, so use `latest-active`, `latest-active-cwd`, or `session` when a
long wait must outlive that session. Check-ins use the same interval while the
scheduler is degraded instead of going silent. A degraded check-in leads with a
plain scheduler-stalled warning, says the job's counters cannot be trusted as
evidence of progress, and includes the last successful tick age, overdue-poll
count, and any pending scheduler error. Its recorded `details.schedulerDegraded`
flag distinguishes it programmatically from a healthy `check-in` event. The
kind stays `check-in` because degradation is a scheduler-health variant of the
same advisory delivery, not a condition result; consumers can branch on the
flag without adding another delivery route. Both variants remain advisory
notices, not condition matches, and do not change job status; inspect
`pi-callbacks status` or `/health` for the current health signal.

## Delivery modes

- `custom` (default): injects a custom `pi-callbacks` message and triggers a turn by default.
- `user`: injects a user message.
- `notify-only`: only shows a UI notification.

Delivery mode controls **how** a callback is injected. Delivery target controls
**where** it goes.

## Delivery targets

Each new job records its origin session and a target:

- `origin` (default): only the exact session that created the job. An active
  origin-targeted job does not survive when that origin session ends (except a
  resource reload); it is discarded rather than redirected, and the loss is
  reported by `callbacks list`.
- `latest-active`: whichever live Pi session was active most recently. Jobs using
  this target survive origin-session shutdown.
- `latest-active-cwd`: the most recently active live session whose cwd matches
  the job's origin cwd. Jobs using this target also survive origin-session
  shutdown.
- `session`: a dedicated session selected by exact session ID or session-file
  path; set the selector with `targetSession`.
- `desktop`: a macOS desktop notification delivered by the daemon. This target
  does not inject a Pi conversation message and is rejected on non-macOS hosts.

For example:

```json
{
  "action": "remind",
  "delay": "10m",
  "message": "Check the deploy",
  "target": "latest-active-cwd"
}
```

An explicit dedicated session uses both fields:

```json
{
  "action": "callback",
  "message": "Release pipeline finished",
  "target": "session",
  "targetSession": "/absolute/path/to/session.jsonl"
}
```

Set the package-wide default for newly created jobs in
`~/.pi/agent/callbacks/config.json` (or under `PI_CALLBACKS_DIR` when that test or
runtime override is set):

```json
{
  "version": 1,
  "defaultTarget": "latest-active-cwd"
}
```

`defaultTarget` accepts any target name above. An explicit session can be
written as `"session:<session-id-or-absolute-file-path>"` or as
`{"kind":"session","session":"<selector>"}`. Per-job `target` values override
the package default. Configuration is read when a job is created, so changing it
does not retarget existing jobs. Invalid configuration fails closed with a
configuration error rather than silently changing the delivery destination. The
check-in settings are also read by the daemon on reconciliation.

Delivery is a two-step handoff: the daemon appends a delivery event to the
shared store, then a target resolver selects a live session and that session
claims the event with a short lease before injecting it. This prevents two Pi
sessions from consuming the same event. The extension drains once on session
start and then on an interval, and it also rebinds its delivery loop when session
lifecycle events such as compaction, tree navigation, user input, or agent turns
provide a fresh extension context. If a stale session context is detected, the
claim is released and the loop pauses instead of marking the event delivered;
the next fresh context restarts the loop and flushes the backlog. `/callbacks`
and `callbacks action="info"` surface pending delivery events so "job completed
but message not delivered" is visible. Empty delivery polls stay on the read
path and do not acquire the cross-process SQLite writer lock. If a background
claim or heartbeat still encounters transient SQLite contention, the extension
reports `store busy` and retries with bounded exponential backoff instead of
letting the timer error terminate Pi. Non-contention store errors remain visible.

Origin-targeted active jobs follow their origin session's lifecycle. A graceful
session close (`quit`, `new`, `resume`, or `fork`) removes them immediately,
including undelivered origin events. A resource reload preserves them so the
replacement extension runtime can resume delivery. A dead host PID is removed
after the two-minute heartbeat grace. An ended in-process runtime can share a
still-live parent PID, so PID liveness alone is not authoritative: after its
heartbeat expires, the daemon marks that presence stale and requires a second
uninterrupted two-minute grace before removal. A resumed heartbeat clears the
marker, protecting laptop sleep and temporary event-loop suspension. Jobs
targeted anywhere other than `origin` survive origin shutdown and remain
available for their redirected destination.

## External callback example

```bash
TOKEN="pi_cb_..."
pi-callbacks callback --token "$TOKEN" --message "tests passed"
```

or:

```bash
curl -sS -X POST http://127.0.0.1:47837/callback \
  -H 'content-type: application/json' \
  --data '{"token":"pi_cb_...","message":"done","status":"success"}'
```

For background scripts launched through `callbacks action=script`, the daemon provides `PI_CALLBACK_TOKEN` and `PI_CALLBACK_JOB_ID` in the process environment.

## Development quality baseline

This package is tested on Node 22. Use a clean dependency install before CI-equivalent checks:

```bash
npm ci
npm run check
```

The aggregate `check` script runs the blocking local baseline:

- `npm run lint` — ESLint flat config for JavaScript and TypeScript using `eslint`, `@eslint/js`, and `typescript-eslint` recommended rules.
- `npm run typecheck` — TypeScript checks for package source and tests.
- `npm run test:coverage` — the same `node:test` suite that `npm test` runs, under source-inclusive V8 coverage via `c8` with text, lcov, and Cobertura reports. It covers deterministic testing of utility parsing/matching, isolated store state, daemon reminder/poll/script/external-callback behavior, CLI callback posting against a local test server, and extension command registration/list/cancel/delete behavior. The include set covers `index.ts`, `bin/**/*.ts`, and all `src/**/*.ts` files (including type-only source files). Blocking floors are set to the measured baseline with all source files included: 57% statements, 57% lines, 64% branches, and 61% functions.
- `npm run build` — emits the package to `dist/` with TypeScript import extensions rewritten for runnable JavaScript.
- `npm run package:smoke` — creates an npm tarball in a temp directory, verifies required package entries and Pi manifest/bin metadata, extracts it, and smoke-runs the packed CLI help.

`npm test` runs the same suite without coverage instrumentation. Use it as the
fast local loop; `check` deliberately does not call it, because
`test:coverage` already executes the same files. `lint` and `typecheck` keep
their caches under `node_modules/.cache/`, so `npm ci` in CI always starts cold.

Coverage artifacts are written to `coverage/`:

- `coverage/lcov.info`
- `coverage/lcov-report/`
- `coverage/cobertura-coverage.xml`

### Optional git hooks

Tracked hooks live in `.githooks/` but are never installed automatically. To opt in for the repository (the setting is shared by its linked worktrees):

```bash
npm run hooks:install
```

The installer is idempotent: it marks the tracked hooks executable and sets repository-local `core.hooksPath` to `.githooks`. Git stores that local setting in the shared repository config, so one installation covers all linked worktrees. The pre-commit hook runs lint and typecheck; the pre-push hook runs the blocking coverage suite.

## License

MIT. See [LICENSE](LICENSE).
