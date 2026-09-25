# `delegateFromCli()` — CLI-callable dispatch surface

## What this is

`delegateFromCli` is a free-standing Node entrypoint for `pi-delegate`
that lets a CLI process — graft's `graft tick` verb is the canonical
case, but any scripted Node tool fits — dispatch one or more
direct-mode subagent workers **without a live pi session**.

It wraps the existing `pumpDirectWorkers` runner with the minimal
runtime state that pump needs (an `AuthStorage`, a `ModelRegistry`, a
base cwd, an optional model override) and translates the resulting
`RunResult[]` into a CLI-friendly shape with the pi-runtime
abstractions stripped out.

The entrypoint is **purely additive**. The default extension export
(`function (pi: ExtensionAPI) { ... }`) and the `delegate` tool it
registers are unchanged.

## When to use it

Use `delegateFromCli` when:

- You're writing a Node CLI that needs to spin up subagents and you
  cannot rely on pi being the host process.
- You want a deterministic, sync-only return shape with per-run
  status, output, and (optionally) a graft commit-SHA trailer
  extracted from the worker's reply.
- You're scripting batch dispatch in CI / smoke tests / build hooks.

Use the in-pi `delegate` tool (`function (pi: ExtensionAPI)`) when:

- You're inside a pi session.
- You need supervised mode (multi-turn supervisor ↔ worker dialogue).
- You need ordered runs (`after`-layered entries with per-step
  `{previous}` substitution) or a saved chain.
- You need dispatch mode (return now, notify on completion via
  `pi.sendMessage`).

The CLI surface deliberately covers **direct mode only**. Supervised
and chain modes are pi-runtime-coupled today and would require
synthesizing additional ambient state (custom-message wake-up, slash
commands, transcript overlay) that no headless caller has any use
for. If you need supervised round-tripping in a CLI, file a
follow-up: `delegateFromCliSupervised()`.

## Quickstart

```ts
import { delegateFromCli } from "@centerforagenticai/pi-delegate";

const result = await delegateFromCli({
  tasks: [
    {
      name: "scout",
      agent: "scout",          // agent-name string; resolved via discovery
      task: "Scan src/ and report any unhandled errors.",
    },
  ],
  cwd: process.cwd(),
});

if (result.anyFailed) {
  for (const worker of result.forks) {
    if (worker.status !== "completed") {
      console.error(`[${worker.name}] ${worker.status}: ${worker.error}`);
    }
  }
  process.exit(1);
}

console.log(result.combinedContent);
```

## API

```ts
function delegateFromCli(opts: CliDelegateOptions): Promise<CliDelegateResult>;

interface CliDelegateOptions {
  tasks: CliDelegateTaskInput[];     // 1+ direct-mode worker inputs (parallel)
  concurrency?: number;              // default: tasks.length
  worktree?: boolean;                // ephemeral git worktree per worker
  cwd?: string;                      // default: process.cwd()
  signal?: AbortSignal;              // cancellation
  agentDir?: string;                 // default: getAgentDir()
  agentScope?: "user" | "project" | "both";   // default: "both"
  authStorage?: AuthStorage;         // default: AuthStorage.create()
  modelRegistry?: ModelRegistry;     // default: ModelRegistry.create()
  mainModel?: { provider: string; id: string };
  onUpdate?: (snap: CliDelegateSnapshot) => void;
  extractCommit?: boolean;           // default: true (graft trailer parsing)
}

interface CliDelegateTaskInput {
  name?: string;                     // defaults to agent.name
  agent: string | AgentConfig;       // name or fully-resolved config
  task: string;
  cwd?: string;                      // mutually exclusive with worktree
  artifact?: string | false;         // canonical basename; published from a private v2 attempt
  reads?: Array<string | WorkerArtifactReference> | false; // ordinary files or exact retained snapshots
  progress?: boolean;                // append to <chainDir>/progress.md
  interactive?: boolean;             // CLI default: false
  env?: Record<string, string | null>; // worker environment patch; null unsets
}

interface CliDelegateSnapshot {
  runId: string;
  forks: CliDelegateRunSnapshot[];   // `forks` is a retained compatibility field
}

interface CliDelegateRunSnapshot {
  name: string;
  agent: string;
  status: "pending" | "running" | "completed" | "failed" | "aborted" | "paused";
  workerSessionFile?: string;
  recoveredOutput?: boolean;
  usage?: { promptTokens; completionTokens; totalTokens; cost? };
}

interface CliDelegateResult {
  forks: CliDelegateRunResult[];     // `forks` is a retained compatibility field
  anyFailed: boolean;
  combinedContent: string;           // markdown, level-2 headings per task
  worktreeDiffs?: Array<...>;        // present iff worktree: true
  runId: string;
}

interface CliDelegateRunResult {
  name: string;
  agent: string;
  status: "completed" | "failed" | "aborted" | "paused";
  output: string;                    // worker's final assistant text
  workerSessionFile?: string;
  recoveredOutput?: boolean;
  outputFile?: { absolutePath: string; bytes: number };
  artifactRef?: WorkerArtifactReference;
  artifactError?:
    | { kind: "storage-busy"; message: string; retryable: true }
    | { kind: "artifact-unavailable"; message: string; retryable: false };
  error?: string;
  policyRefusals?: Array<...>;
  mutationReport?: <...>;
  promptRepairs?: Array<...>;
  commit: string | null;             // extracted from Graft-Commit: trailer
  usage?: { promptTokens; completionTokens; totalTokens; cost? };
}
```

Deprecated aliases remain exported for source compatibility:

```ts
/** @deprecated Use CliDelegateRunSnapshot. */
type CliDelegateForkSnapshot = CliDelegateRunSnapshot;

/** @deprecated Use CliDelegateRunResult. */
type CliDelegateForkResult = Omit<CliDelegateRunResult, "outputFile"> & {
  outputFile?: { absolutePath: string };
};
```

`CliDelegateRunResult.outputFile` remains the canonical compatible bytes-bearing
shape and points to the immutable retained payload. `artifactRef` identifies that
exact v2 snapshot, producer, digest, and filesystem identity. The deprecated
`CliDelegateForkResult` alias intentionally accepts the older path-only
`{ absolutePath: string }` shape. Runtime results use a closed named-field
projection, so unknown reference or result properties never cross the CLI
boundary. Failed, aborted, and timed-out producers expose no reference.

## Behavioural details

### Sync only

`delegateFromCli` always runs in sync mode — the call resolves once
every worker reaches a terminal state. There is no dispatch / fire-and-forget
mode; CLI consumers wrap the call in their own detached promise if
they need that.

### Stub `pi: ExtensionAPI`

Internally, the entrypoint synthesizes a minimal stub satisfying the
`ExtensionAPI` type. The stub is **never invoked** during a sync
direct dispatch — `pumpDirectWorkers` and `runDirectWorker` only
reference `pi` in the dispatch-mode branch (which we don't enter).

Defensively, every "real" method on the stub (`registerTool`,
`registerCommand`, `sendMessage`, `sendUserMessage`, `exec`, etc.)
throws with a descriptive error if it IS called. A `Proxy` covers
unknown method access. So an upstream regression — code path that
starts to invoke `pi.foo()` from inside the pump — surfaces as a
loud throw rather than a silent no-op.

`pi.events.emit` is a no-op (no subscribers in CLI mode);
`pi.events.on` returns a noop unsubscribe.

### Auth / model resolution

By default:

- `AuthStorage.create(<agentDir>/auth.json)` reads pi's persisted
  credentials (and falls through to env vars like `ANTHROPIC_API_KEY`
  per pi-ai's standard headless behaviour).
- `ModelRegistry.create(authStorage)` builds the registry from the
  user's models config.

Pass explicit `authStorage` / `modelRegistry` for tests (e.g. with a
scripted mock provider) or sandboxed runs.

`mainModel` is the worker's last-resort fallback — agents with their
own `model:` or `fallbackModels:` use those first.

### Project trust (issue #12)

The in-pi `delegate` tool uses Pi's native `ctx.isProjectTrusted()` decision.
CLI mode has no Pi trust context, so it enforces the gate **statically**:
invoking a *discovered* project-local agent throws before any session is created
unless the call passes `trustProject: true`. Project agent and chain files share
the lowest-to-highest-precedence order `<repo>/.agents/` <
`<repo>/.agents/agents/` < `<repo>/.pi/agents/`; later definitions win on
duplicate names.

**Why.** A repo can ship arbitrary agent definitions (system prompts,
tool surfaces) in any of these locations. Without the gate, cloning an
untrusted repo and running a delegate CLI command in it executed
whatever the repo shipped — a prompt-injection / social-engineering
vector (a malicious README telling the user to run a CLI command).

**The trust ladder:** builtin / user / package agents are always allowed.
Project agents require native Pi trust in the extension, or the explicit
`trustProject` capability in the headless library API. pi-delegate does not
maintain a second trust store.

Caller-constructed `AgentConfig` **objects** are never gated — they
come from the calling program, not from repo files. Pass
`agentScope: "user"` to skip project-local discovery entirely if your
consumer wants to lock down agent provenance.

### Cancellation

`opts.signal` cancels all in-flight workers (cancelReason: "user") and
rejects with an `AbortError`. A pre-aborted signal short-circuits
before dispatch.

### Error model

The function:

- **Resolves** with `CliDelegateResult` even when individual workers
  fail. `result.anyFailed === true` + `result.forks[i].status !==
  "completed"` is how the consumer detects worker failure.
- **Rejects** only on:
  - Validation errors (missing/empty `tasks`, unknown agent names,
    worktree + per-task cwd conflict).
  - Cancellation (`AbortError`).
  - Catastrophic internal errors (worktree teardown failure, etc.).

### Graft commit extraction

By default, each worker's collapsed output is scanned for a graft
trailer block of the form:

```
Graft-Spec: 0099-some-spec
Graft-Task: implement
Graft-Commit: <sha>
```

The extracted SHA is normalised to lowercase and surfaced as
`result.forks[i].commit`. The matcher tolerates leading whitespace, code
fences, and `> ` quoting; SHAs are 7-40 hex chars. No trailer →
`commit: null`.

Pass `extractCommit: false` to suppress the scan entirely (callers
who want to do their own grep, or who don't use the graft
convention).

### Worktree mode

`worktree: true` creates an ephemeral git worktree per worker. Same
mechanics as the in-pi tool. Incompatible with per-task `cwd:`. The
returned `worktreeDiffs` capture the unified diff text plus stat info.
Successful captures are followed by cleanup. If capture fails, the entry
contains `captureFailed: true` and the preserved `worktreePath`; the worktree
and branch remain available for manual recovery and must not be assumed reaped.

The shape includes `branch`, `patchPath`, `diffStat`, counts, and the optional
failure fields above. See the `CliDelegateResult.worktreeDiffs` type for the
full shape. Each entry's `forkName` field is retained for compatibility; new
prose should call the associated item a worker or run.

## Migration from a pre-0.1 dynamic-import shim

A pre-0.1 CLI shim may have used a runtime fallback when `pi-delegate`
didn't expose a callable named export. With `delegateFromCli` available,
the shim collapses to a thin translation layer:

```ts
import { delegateFromCli } from "@centerforagenticai/pi-delegate";

export async function dispatch(opts) {
  const result = await delegateFromCli({
    tasks: opts.agents.map((a) => ({
      name: a.name,
      agent: a.agent,
      task: a.task,
      cwd: a.cwd,
    })),
    concurrency: opts.concurrency,
    worktree: opts.worktree,
    cwd: opts.cwd,
    signal: opts.signal,
  });
  return {
    forks: result.forks,
    anyFailed: result.anyFailed,
  };
}
```

No dynamic imports, no fallback stub.
