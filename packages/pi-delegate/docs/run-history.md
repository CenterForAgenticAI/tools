# Run history

`pi-delegate` records one JSON object per run entry in
`<agentDir>/extensions/pi-delegate/runs.jsonl`. `recordRun` creates the parent
directories, stamps the current schema version, and appends the row. History
recording is best effort and must not crash a run.

## What a row records

A `RunHistoryEntry` records:

- timestamps: `ts`, `tsSec`, `startedAt`, `finishedAt`, and `durationMs`;
- identity: `runId`, `ownerSessionId`, `rootRunId`, `forkName`, `displayLabel`,
  `agent`, and `agentSource`. `forkName` is the addressing key; `displayLabel`
  is the derived, non-addressing label the widget showed at the time, and is
  absent on rows written before it existed;
- model and execution context: `workerModel`, `attemptedModels`,
  `workerThinking`, `summaryModel`, `cwd`, and `workerSessionFile`;
- terminal result data: `status`, `cancelReason`, `errorMessage`, `errorKind`,
  and `refusalModels`;
- completion data: `roundsUsed`, `maxRounds`, `collapseMode`,
  `supervisorFinishKind`, and `summaryFallbackReason`;
- usage counters and any `usage.diagnostics`; and
- `taskPreview`, limited to the first 200 characters of the task.

Rows describe individual runs (run entries). They do not yet provide a complete launch
record for execution shape or mode, `sync`, `clone_mode`, or batch identity.
That completeness work belongs with the first consumer expected in #58.

## Retry metadata

New rows may include `attempt` and the exact local `retryOf` reference. Missing
fields in legacy rows mean attempt 1. Attempts remain append-only and retain
independent outcome, cancellation, timing, session, usage, and cost evidence;
aggregation never merges retries. Raw predecessor fork names are trusted local
history data and are not copied into privacy-bounded status, result, or
completion-wake projections. A failed or aborted attempt without a valid
successor remains visible and retained; linking suppresses only its ambient
widget row, never its history or result. Synthetic early failures use the same
bounded error provenance in the result, runtime snapshot, and history, without
inventing a worker session file.

## Terminal statuses

Rows use these terminal statuses:

```text
completed
failed
aborted
paused
```

`paused` means the supervisor was forced to finish at `max_rounds`. It is a
terminal status, but it is not a failure. `cancelReason` is recorded for
`aborted` rows and is not used to turn `paused` into `failed`.

## Schema versions and legacy rows

New rows carry `version: 2`. Older version-1 rows may omit `version`; they remain
readable, and `aggregateRunHistory` treats an absent version as version 1. The
aggregator supports versions 1 and 2 and skips unknown versions rather than
guessing at their shape.

## Usage provenance and diagnostics

The usage rollup record has a schema `version` and explicit provenance for cache
fields:

- `aggregate-includes-ticker` means aggregate cache fields already include
  ticker usage.
- `split-excludes-ticker` means supervisor/worker cache fields exclude ticker
  usage; add the ticker fields to obtain the aggregate.

`normalizeUsageCounters` accepts only numeric, finite, non-negative supplied
values. Missing fields contribute zero. Rejected values do not enter totals and
produce a per-field diagnostic with reason `not-a-number`, `non-finite`, or
`negative`. Per-run usage keeps those diagnostics in `usage.diagnostics`, which
is persisted in the history row.

`aggregateRunHistory` exists and is tested, but it has no production consumer
yet. Nothing in production reads `runs.jsonl`; the first consumer is expected
in #58.
