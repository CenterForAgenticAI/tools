# pi-daemon reference

This page is for client authors and operators who need the CLI, client API, session model, storage, exports, and operational limits.

## Start the daemon

```sh
npx pi-daemon start
npx pi-daemon status
npx pi-daemon list
```

`start` launches a detached daemon unless one is already available. Use `start --foreground` under a process supervisor or while debugging:

```sh
npx pi-daemon start --foreground
```

Stop it cleanly with:

```sh
npx pi-daemon stop
```

All CLI output is one JSON object per line. A command exits non-zero for an unhealthy, busy, incompatible, or failed result.

### CLI commands

| Command | Purpose |
| --- | --- |
| `pi-daemon start [--foreground]` | Start the singleton for the selected state directory. |
| `pi-daemon stop [--grace-ms N]` | Stop accepting work, let claimed work settle until the deadline, and shut down. |
| `pi-daemon status` | Report daemon health and session counts. Returns exit 1 while work is active. |
| `pi-daemon list [--phase PHASE] [--cwd PATH]` | List registered sessions. Repeat `--phase` to select more than one observed phase. |
| `pi-daemon open (--path PATH \| --session-id ID) [--cwd PATH] [--name NAME]` | Register an existing pi session without waking it. |
| `pi-daemon wake SESSION` | Attach temporarily and create the session's in-memory runtime. |
| `pi-daemon sleep SESSION` | Attach temporarily and dispose a settled runtime. This fails while work or a conflicting lease prevents sleep. |

The CLI is an operational client. Creating a new session, submitting prompts, streaming, steering, and answering UI requests use the client library or the protocol directly.

## Use the client library

`connectDaemon()` connects over the local socket and auto-spawns the daemon by default. The following example creates an asleep session, attaches to its stream, wakes it, acquires the driver lease, and submits one prompt:

```ts
import { randomUUID } from "node:crypto";

import { connectDaemon } from "@centerforagenticai/pi-daemon/client";

const client = await connectDaemon({
  client: { name: "readme-example", version: "1.0.0" },
});

const sessionId = randomUUID();
const created = await client.request("create", {
  cwd: process.cwd(),
  name: "readme example",
  sessionId,
  sleepAfterMs: 60_000,
});

const attachment = await client.attach(sessionId, { live: true });
let generation = created.session.generation;

if (created.session.runtime === "asleep") {
  const woke = await attachment.wake(generation, { reason: "submit prompt" });
  generation = woke.session.generation;
}

const lease = await attachment.acquireLease(generation, { ttlMs: 300_000 });

try {
  const submission = await lease.prompt({
    idempotencyKey: randomUUID(),
    text: "Summarize this repository.",
    whenBusy: "reject",
  });
  console.log(submission);

  for await (const frame of attachment) {
    if (frame.kind === "entry") {
      // Acknowledge only after processing. Pass a cursorStore to attach() to persist it.
      await attachment.acknowledge(frame);
    }

    if (frame.kind === "gap") {
      console.warn("live output was incomplete; committed catch-up will follow", frame);
    }

    if (frame.kind === "daemon" && frame.name === "prompt") {
      console.log("prompt finished", frame.data);
      break;
    }
  }
} finally {
  await lease.release().catch(() => undefined);
  await attachment.detach().catch(() => undefined);
  client.close();
}
```

A production driver should heartbeat its lease before `expiresAt`, store every processed `entry` cursor, reconnect after transport loss, and treat `gap`, `cursor_off_branch`, `stale_generation`, and `external_writer` as explicit recovery states.

After an uncertain prompt response, keep the original `sessionId` and `idempotencyKey` and call:

```ts
const status = await client.promptStatus(sessionId, { idempotencyKey });
```

Do not automatically resubmit when the result is `pending` or `unknown`. `unknown` means that no matching claim is available in the index; it does not prove that provider work never started.

## Session and authority model

A **session** is one durable pi conversation tree. An awake session has an in-memory `AgentSession`; an asleep session keeps its file, registry state, and replay support but cannot be driven until a client wakes it.

Each attachment is either a watcher or the holder of the session's time-limited driver lease:

| Action | Watcher | Driver lease required |
| --- | ---: | ---: |
| List, inspect, attach, replay, and query prompt status | Yes | No |
| Wake | Yes | No |
| Steer or queue a follow-up during an active run | Yes | No |
| Prompt, abort, or answer an extension UI request | No | Yes |
| Explicit sleep or external-writer recovery | Only when no lease exists | Yes, when a lease exists |

Every runtime mutation carries the generation observed by the client. A wake, restart, or host replacement advances the generation so a stale client cannot mutate the new runtime.

## History and streaming

A durable cursor has the shape `{ entryId, epoch }` and points only to a committed entry on the active branch. `entry` frames advance the cursor. Within-turn `event` frames, including token and tool updates, are not durable and do not advance it.

Each reader has a bounded live queue. If it falls behind, the daemon emits a `gap` with a safe resume cursor and catches up from committed history. A cursor from an abandoned branch reports `cursor_off_branch` and a fork point rather than pretending it belongs to the active branch.

Important daemon transitions are written as non-model-visible `pi-daemon/*` custom entries in the same pi session file. The local SQLite registry is an operational index, not a second transcript or event log.

## Configuration and local files

| Variable | Meaning | Default |
| --- | --- | --- |
| `PI_DAEMON_SOCKET` | Absolute path to the Unix socket. | `$XDG_RUNTIME_DIR/pi-daemon/pi-daemon.sock`, otherwise `~/.local/state/pi-daemon/run/pi-daemon.sock` |
| `PI_DAEMON_STATE_DIR` | Registry, singleton lock, and diagnostic log directory. | `$XDG_STATE_HOME/pi-daemon`, otherwise `~/.local/state/pi-daemon` |
| `PI_DAEMON_AGENT_DIR` | pi agent configuration and session root. | `~/.pi/agent` |

The state directory contains:

- `registry.sqlite3`: rebuildable session, lease, and prompt indexes;
- `daemon.lock`: the singleton ownership record;
- `log/pi-daemon.jsonl`: bounded structured diagnostics that omit prompt, model, tool, credential, and environment content.

The socket parent directory is mode `0700` and the socket is mode `0600`. Filesystem ownership authenticates the local operating-system account. This is a single-user local transport, not a remote or multi-user security boundary.

Each registered session file also has a sibling `.pi-daemon.lock`. Do not open a daemon-hosted file in interactive pi: interactive pi does not honor this lock, and an outside write causes the daemon to fence that session as `external_writer` until an attached authorized client runs `recover`.

## Package exports

| Import | Contents |
| --- | --- |
| `@centerforagenticai/pi-daemon` | Daemon embedding, host, registry, state, stream, and lifecycle APIs, including `runDaemon()`. |
| `@centerforagenticai/pi-daemon/client` | `connectDaemon()`, auto-spawn support, typed requests, attachments, leases, cursor hooks, and async stream iteration. |
| `@centerforagenticai/pi-daemon/protocol` | Protocol types, constants, runtime validators, and the canonical JSON Schema object. |
| `@centerforagenticai/pi-daemon/testing` | Deterministic provider helpers for conformance tests. |
| `@centerforagenticai/pi-daemon/protocol/protocol-1.0.schema.json` | The published draft-2020-12 JSON Schema for non-TypeScript clients. |

The protocol uses LF-delimited UTF-8 JSON frames:

```text
{t:"req",id,op,session?,params}
{t:"res",id,ok,result|error}
{t:"ev",session,kind,...}
```

The first request must be `hello` with a compatible protocol version. Supported operations are `hello`, `list`, `open`, `create`, `attach`, `detach`, `replay`, `prompt`, `prompt_status`, `steer`, `follow_up`, `abort`, `lease`, `ui_answer`, `sleep`, `wake`, `recover`, `status`, and `shutdown`.

Use the exported validators instead of accepting untrusted frames by shape alone. Non-TypeScript clients can load the published JSON Schema.

## Operational limits

- The daemon intentionally does not host sessions through `pi --mode rpc`.
- Remote TCP or WebSocket transport, token authentication, and multi-user authorization are not implemented.
- Several sessions may be awake in one process. Extensions share ES-module state, `cwd`, environment variables, listeners, timers, and other process-global resources. Run only extensions you trust to share that process.
- Live token and tool updates can be lost; committed entries and explicit daemon custom entries are the durable contract.
- For a brand-new session file, pi 0.87.1 may dispatch the first prompt before its claim reaches the JSONL file. A normal crash can retain a pending SQLite row, but file-only crash recovery is guaranteed only after the session file has materialized. Never infer that `unknown` means the first prompt did not run.
- The daemon exact-pins its pi SDK version because it observes internal persistence seams. Do not bypass the compatibility stamp when updating the SDK.
