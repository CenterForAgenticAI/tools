# Poll conditions and check-ins

For agents and operators: what a poll can watch, how conditions match, and how long waits report back.

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
