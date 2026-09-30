# Reference: tool, commands, daemon CLI, external callbacks

For anyone calling the tool or scripting against the daemon: every action, command, and CLI subcommand, with examples.

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
