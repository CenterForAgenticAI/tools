# Architecture and pending-work service

For contributors and integrators: how the daemon, the extension, and the store divide the work, and the read-only pending-work service other extensions can query.

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
