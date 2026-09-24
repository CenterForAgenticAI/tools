---
name: pi-callbacks
description: Use pi-callbacks when the user or agent needs to wait for something, schedule reminders, watch for a condition, run background work that wakes the agent on completion, or mint token-based callback hooks for external scripts.
---

# pi-callbacks

Use `callbacks` instead of ad-hoc sleeps, background polling scripts, or detached shell jobs when a future event should re-enter the Pi conversation.

`pi-callbacks` is backed by a central per-user daemon. Pi sessions create jobs in shared state; the daemon runs timers/polls/scripts and appends delivery events; live sessions claim only delivery events routed to them and inject those events into context.

## Query pending work from another extension

Discover the versioned `callbacks:service:v1:discover` service through Pi's event bus. Its `pendingWorkSummary()` result has exactly three fields:

- `count`: non-terminal (`pending` or `running`) jobs owned by the current session.
- `nextDueAt`: the earliest reminder or poll due time as an ISO 8601 string, absent when no timed job has one.
- `openEndedCount`: active scripts and token callbacks that have no due time.

The service reads fresh state on every query. `nextDueAt` is a hint, not a promise that the callback will fire at that time. The service does not provide job details, history, cancellation, or control.

## When to use

Reach for `callbacks` when:

- The user says “wait until…”, “check every…”, “remind me…”, or “tell me when…”.
- A long-running command should wake the agent when it finishes.
- A deploy/CI/server/script can call a hook when ready.
- Polling is needed and the agent should be able to inspect each condition-check result, including non-matches or command/URL/source monitoring failures.
- You need to see/cancel pending waits later.

Avoid hand-rolled `while sleep ...` polling loops unless the user explicitly asks for a foreground blocking command. When a bash tool call contains a direct literal `sleep` of at least 10 seconds, pi-callbacks may show one advisory reminder to use `callbacks` instead. A positive literal sleep inside a recognized `while`, `until`, `for`, or `select` loop also receives the reminder, even when it is shorter. The reminder never blocks or changes the bash call and is limited to once per session or compaction window.

Configure this advisory in `~/.pi/agent/callbacks/config.json` with `sleepReminderMinSeconds`: use a positive number of seconds to set the direct-sleep threshold, or `null` to disable it. The default is `10`. Unknown, dynamic, quoted, or non-positive durations are ignored.

## Common patterns

### Reminder

```json
{
  "action": "remind",
  "delay": "5m",
  "message": "Ask the user whether the migration finished."
}
```

### Poll a shell command

```json
{
  "action": "poll",
  "interval": "15s",
  "command": "curl -sf http://localhost:3000/health",
  "condition": "exit:0",
  "message": "The local dev server is healthy. Continue the smoke test."
}
```

### Poll a URL

```json
{
  "action": "poll",
  "interval": "30s",
  "url": "https://example.test/status",
  "condition": "status:200",
  "message": "The status endpoint is responding."
}
```

### Background script

```json
{
  "action": "script",
  "command": "npm run build",
  "message": "The build command completed; inspect its output and continue."
}
```

The daemon-launched process receives `PI_CALLBACK_TOKEN` and `PI_CALLBACK_JOB_ID`. If the process can explicitly signal milestones, pass the token to `pi-callbacks callback --token "$PI_CALLBACK_TOKEN" --message "..."`.

### External callback token

```json
{
  "action": "callback",
  "message": "External deploy finished; inspect the result and continue."
}
```

Give the returned `curl` or `pi-callbacks` CLI command to the external script/system. The endpoint is stable: `http://127.0.0.1:47837/callback`.

## Choosing a delivery target

Omit `target` for the package default (normally `origin`). Choose deliberately
when a wait must outlive this conversation:

- `origin`: return only to the exact creating session. An active
  origin-targeted job does not survive when that session closes (except a
  resource reload); it is discarded rather than redirected, and
  `action: "list"` reports the loss so you can re-arm it deliberately.
- `latest-active`: route to the most recently active live Pi session. Jobs using
  this target survive origin-session shutdown.
- `latest-active-cwd`: route to the most recently active live session in the
  origin cwd. Jobs using this target also survive origin-session shutdown.
- `session`: route to an exact session ID or session-file path supplied as
  `targetSession`.
- `desktop`: show a macOS desktop notification instead of injecting a Pi message.

Example of a job that survives its origin session:

```json
{
  "action": "poll",
  "interval": "30s",
  "url": "https://example.test/status",
  "condition": "status:200",
  "message": "The deployment is ready.",
  "target": "latest-active-cwd"
}
```

Example of an explicit destination:

```json
{
  "action": "callback",
  "message": "Dedicated release session should continue.",
  "target": "session",
  "targetSession": "/absolute/path/to/session.jsonl"
}
```

The package default for new jobs lives in
`~/.pi/agent/callbacks/config.json`, for example:

```json
{"version":1,"defaultTarget":"latest-active"}
```

Per-job targets override this value. Config changes do not retarget existing
jobs. Desktop targeting is macOS-only.

## Named poll sources

A poll can watch a named source instead of a shell command or URL. The first source is a GitLab CI pipeline, identified by host, project path, and pipeline number:

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
  "interval": "30s"
}
```

`glab` must be installed and logged in for the requested GitLab host. The daemon shells out to `glab`; credentials remain in `glab`'s stored configuration and are never put in the persisted job. The adapter exposes a normalised source status to the generic jobs widget. `success`, `failed`, `canceled`, `skipped`, and `manual` are terminal statuses; unknown statuses such as `running` and `pending` keep waiting. Missing `glab`, authentication or transport errors, timeouts, and invalid output are monitoring failures, never pipeline verdicts.

## Conditions

- `contains:text`
- `not_contains:text`
- `regex:pattern`
- `exit:0`
- `status:200`
- `any`
- `always`

Bare strings mean `contains:<that string>`.

## Operational discipline

- The dedicated jobs widget appears below the editor while this session owns active callback jobs. It refreshes every 10 seconds and clears when idle. It lists up to three compact per-job lines; a fourth job replaces the last line with a `… and N more active` summary, so it never exceeds three lines. It carries no count header, because the footer status already reads `callbacks: N active` whenever the widget has content. Each line is responsive: a wide terminal shows `id — label · status: … · kind: …`, a narrower one drops `status:` first because the widget lists only non-terminal jobs, and a narrower one still drops `kind:` too, keeping the id and label longest. TUI mode recomputes the tier on every render, so widening the terminal restores detail; RPC mode is never told a width and always receives full detail as plain string lines, because RPC ignores component factories. Both modes clear with `undefined` when idle. Use `/callbacks` or `action: "list"` for full detail.
- The composed footer status line stays silent when the daemon is healthy and this session has no active jobs or pending deliveries. It shows only a bounded active-work summary or abnormal state such as `callbacks: daemon down` or `callbacks: delivery paused`; inspect `/callbacks` for poll timing and the latest poll result.
- Use `action: "list"` or `/callbacks` to inspect active jobs owned by the exact current session. The listing includes per-job timing: reminder due time, or poll interval, next run, and run count/budget.
- Use `/callbacks --all` (or tool input `allSessions: true`) for cross-session inspection. Use `/callbacks --history` (or `includeCompleted: true`) for retained terminal history; combine both flags for global history. `/callbacks all` remains a current-session history alias.
- `/callbacks` also surfaces pending delivery events. Treat a completed job with pending deliveries as a delivery-path problem, not as proof that the agent saw the callback.
- Origin-targeted active jobs are removed immediately when their session closes gracefully, except during resource reload. A dead host PID is removed after the two-minute heartbeat grace. Ended in-process sessions under a still-live parent PID use two-phase expiry: one stale-marking grace plus a second removal grace, and a resumed heartbeat clears the marker. Redirected targets survive origin shutdown.
- If delivery ever pauses because Pi replaced a stale session context, the next fresh lifecycle event (user input, compaction/tree event, or agent turn) should rebind the delivery loop and flush the backlog.
- Transient callback-store contention appears as `store busy` and retries with bounded backoff; it must not terminate Pi. Persistent or non-lock store failures still require investigation.
- Use `action: "cancel"` or `/callback-cancel <id>` when a wait is no longer relevant.
- Prefer `delivery: "custom"` unless the callback should look exactly like a user prompt.
- Use `triggerTurn: false` for informational callbacks that should not wake the model.
- Poll jobs default to `pushEachResult: true`: every condition-check result is delivered to the agent so it can decide whether to keep waiting, adjust the condition, cancel the job, or report failure.
- For intentionally quiet checks, set `pushEachResult: false`; then only a condition match or `maxRuns` exhaustion enters context immediately. A wrong or unsatisfiable condition is a real, expected failure mode, not an anti-pattern; a quiet poll with no `maxRuns` receives a periodic check-in so it cannot wait silently.
- Pending or running quiet polls, scripts, and passive token callbacks receive a status check-in every 30 minutes by default. Check-ins are not condition matches, do not change job status, include bounded poll history, and point to `callbacks action="info" id=<job-id>` for the full recorded history. `maxRuns` still fails a poll after its attempt budget; polls with `pushEachResult: true` and reminders are exempt, and terminal jobs receive no further check-ins.
- Configure `checkInIntervalMs` (positive milliseconds or `null` to disable), `checkInTriggerTurn`, and `sleepReminderMinSeconds` (positive seconds or `null` to disable) in `~/.pi/agent/callbacks/config.json`. Check-ins reset their own timer and use the job target. Origin-targeted jobs still follow origin lifecycle, so use a redirected target for waits that must outlive the creating session. Invalid settings fail closed with a configuration error.
- Check-ins remain on the configured interval while the scheduler health signal is degraded instead of going silent. A degraded check-in leads with a scheduler-stalled warning, says the job's counters cannot be trusted as evidence of progress, and includes the last successful tick age, overdue-poll count, and any pending scheduler error. Its recorded `details.schedulerDegraded` flag distinguishes it programmatically from a healthy `check-in` event. The kind stays `check-in` because degradation is a scheduler-health variant of the same advisory delivery, not a condition result. Both variants remain advisory notices, not condition matches, and do not change job status. `pi-callbacks status` includes scheduler heartbeat and overdue-poll details; `/health` returns `ok: false` (HTTP 503) when the scheduler is stale, reconciliation is failing, or a poll remains overdue beyond the three-second scheduler staleness window.
- If `pi-callbacks status` is unhealthy after an upgrade from the older per-session server, reload/restart old Pi sessions so they release port 47837, then run `pi-callbacks start`.
