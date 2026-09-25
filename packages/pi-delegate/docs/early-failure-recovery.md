# Early worker-failure notification and recovery

Background delegate calls send one aggregate `delegate:complete` wake when all
runs settle. Early failure wakes are **on by default** for background dispatches:
set `notifyOnFailure: false` on a call or in `config.json` to opt out. When
enabled, you receive a `delegate:fork-failed` wake at the first terminal failure
for each worker, while healthy siblings continue to run normally.

## What counts as a deliverable

A resolved worker turn is not automatically a deliverable. The direct runner and
the supervised worker channel use the same classifier from
`src/harvest-outcome.ts`. It returns one of three outcomes:

- `substantive` — non-empty assistant text that is not short, single-block
  lifecycle chatter. A longer answer is retained because losing a real answer is
  worse than showing an old lifecycle banner.
- `failure` — the terminal assistant message reports an explicit provider or
  assistant failure, such as an `errorMessage` or `stopReason: "error"`.
- `missing` — no assistant message, empty assistant content, or only
  cancellation/lifecycle chatter. Its reason is `no-assistant`, `empty`, or
  `cancellation-only`.

`missing` is now a terminal failure even when the provider supplied no error
text. Direct workers and the supervised private session use the existing
`delegate:fork-failed` wake and recovery descriptor for this failure when a
descriptor is available. The
caller-visible failure uses `No substantive assistant output recovered` as its
error. A chain step still enters the failure path and emits the bounded wake
when early failure wakes are enabled, but has no recovery descriptor because
later steps may depend on its output.

If an earlier assistant message contains genuine substantive text, the
classifier can salvage it when the later terminal messages do not. The harvest
method is then `salvage`; text from the terminal assistant message is recorded
as `terminal`. Chain output-file writes, progress updates, and propagation to
`{previous}` happen only after a validated substantive result completes
successfully. A failed harvest does not create a false completion artifact or
advance the chain.

## Bounded failure payload

The custom message details contain only bounded operational metadata:

```ts
{
  runId: string,
  mode: "direct" | "supervised" | "chain",
  forkName: string,
  status: "failed",
  reason?: string,       // categorical: "fork-failed" (general failure), "provider-capacity" (the provider had no quota or rate-limit headroom left), "model-refusal", "no-model-alternative" (retryable provider failure with no distinct model alternative), "fork-crashed", "fork-setup-failed"
  siblingStates?: Array<{ forkName: string, status: string }>,
  recoveryAvailable?: boolean,
  recovery?: { available: boolean, contextAvailable?: boolean, strategy: "resume" | "fresh" }
}
```

Identifiers are validated and UTF-8 byte-capped. No free-form failure text,
task, prompt, transcript, path, URL, environment value, or worker output is
included in this early wake. Repeated failure
updates for one `runId`/`forkName` are idempotently suppressed. A failed wake
never consumes or replaces the aggregate completion wake.

## Selective recovery

Call:

```ts
delegate_control({action: "recover", runId, forkName, strategy: "auto" })
// Optional: include guidance for the recovery child
delegate_control({action: "recover", runId, forkName, strategy: "resume", message: "Focus on the auth module" })
```

Recovery dispatches an **independent child run** with its own `runId` and
completion wake. The original batch and all healthy siblings finish normally
and emit their normal aggregate. The original aggregate is never delayed,
mutated, or suppressed.

**Eligibility requirements:**
- The run must be owned by the current process and have an in-memory recovery
  descriptor for the requested worker.
- The current foreground session must still be the session that dispatched the
  original run. Recovery fails closed after session replacement.
- The worker run must be in terminal `failed` state.
- Recovery is allowed even after the original aggregate has completed, as long as
  the same live extension instance and dispatching foreground session still own
  the in-memory descriptor.
- Hydrated, reloaded, or replacement-session runs do not have usable descriptor
  authority and must fail closed (see issue #77 for cross-session recovery).

**Recovery descriptors are always captured** for accepted direct and supervised
runs, regardless of `notifyOnFailure`. Setting `notifyOnFailure: false` suppresses
the early wake notification only — recovery is still available after reading the
aggregate result.

**Idempotency:** Concurrent calls for the same `runId`/`forkName` converge on
exactly one child launch. The in-memory `pendingLaunch` promise is shared. The
first concurrent call incorporates the `message` parameter; later concurrent
calls see the already-launched outcome.

### Strategies

- **`auto`** (default): tries `resume` if prior-attempt context is safely
  available, otherwise falls back to an exact `fresh` redispatch. Guidance alone
  never fabricates prior-attempt state.
- **`resume`**: launches a new child seeded with a provenance-safe prior-attempt
  snapshot. The snapshot can represent only a categorical failure kind, whether
  partial output existed, and at most 20 categorical tool-call/tool-result facts.
  It cannot represent error/output/assistant/user text, tool names, arguments,
  results, paths, URLs, or environment values. This is
  a **new independent child run** — NOT a continuation of the disposed supervisor
  session. Fails closed when no safe useful context is available.
- **`fresh`**: launches a new child with the exact original invocation
  configuration and no prior context.

The `message` parameter adds optional redacted, UTF-8-byte-bounded user guidance to
the recovery task. It is kept separate from prior-attempt state and does not
turn a fresh recovery into a resume. Generic credential-pattern redaction on
this explicitly supplied guidance is defense in depth, not a secrecy guarantee;
the categorical prior-attempt snapshot does not depend on regex redaction.

### Preserved configuration

The recovery child faithfully preserves all original user-facing invocation
settings, including:
- **Direct:** agent, task, cwd, output/reads/progress, interactive, env,
  model/thinking/fallbacks/skills, escalation
- **Supervised:** agent, task, effective name (including duplicate suffixes), cwd, interactive, env,
  model/thinking/fallbacks/skills, escalation, clone_mode, max_rounds,
  collapse_mode, summary_model, supervisor_instructions, snippet_last_n, and
  timeout settings
- **Top-level:** the effective worktree, agent_scope, and `notifyOnFailure`
  settings (including explicit `false`). Descriptors are captured regardless,
  so an opted-out recovery child remains recoverable after its aggregate. The
  child rechecks whether Pi currently trusts the project; that decision is not
  an invocation setting and is never copied into the descriptor.

**Semantics that cannot be preserved:**
- **Ephemeral worktree filesystem contents:** a recovery with `worktree: true`
  creates a NEW clean worktree — it does not restore the original auto-worktree's
  state.
- **Agent definition file changes:** if an agent's definition file changed after
  the original dispatch, the recovery uses the current file.

A halted chain step is not recoverable: later steps depend on its output.

## Default-on behavior and opt-out

Early failure wakes are enabled by default (`notifyOnFailure: true`). To opt
out for a specific call, pass `notifyOnFailure: false`:

```ts
delegate({
  runs: [{ agent: "scout", task: "..." }],
  notifyOnFailure: false  // opt out: aggregate-only behavior
})
```

Or configure it in `config.json`:
```json
{ "notifyOnFailure": false }
```

When opted out, no `delegate:fork-failed` wake is emitted. Recovery descriptors
are still captured — `delegate_control` action `recover` remains available after reading the
aggregate result via the `delegate:complete` wake.

## Failure and crash paths

Dispatch pumps convert unexpected per-worker exceptions into a failed result and
continue joining sibling promises. This prevents an early crash from rejecting
the whole fan-out. The persisted run result remains available through
`delegate_control` action `result`.

Sequential dependency means step-level independent recovery is not supported —
the chain must be re-dispatched from the appropriate step.

The durable pending-wake path is owner-scoped and filesystem-protected. A stale
foreground context retries through the live replacement sink when safe,
otherwise writes a `0600` pending record. Any wake crossing a replacement or
durable boundary explicitly reports recovery as unavailable and invalidates that
worker run's live descriptor authority; recovery capability does not cross the boundary.

A `sync:false` in-process run that dies with its runtime never reaches the
pending-wake path: hydrate terminalizes it as an aborted orphan
(`cancelReason: "shutdown"`) and there is no pump left to send its wake. The
next `session_start` of the owning session delivers the standard
`delegate:complete` wake only after every fork is terminal and the exact result
payload is available. Background recovery accepts the supported `direct`,
`supervised`, and `chain` shapes. A valid empty result array still reports the
terminal failure. The header remains `failed: aborted: delegate runtime was
reloaded or ended before completion`, and `details.forks` carries the restored
entries. A missing, unreadable, locked, corrupt, generation-mismatched,
or future-version sidecar remains retryable and cannot create an outputless wake
or acknowledgement stamp. The durable `orphanWakeSurfacedAt` stamp is written
after the send, so the trade-off is the same as the sync orphan handoff (#34):
a duplicate wake is preferred over a lost one (#523).

## Retry replacement is separate

`retryOf: { runId, forkName }` is a fresh ordinary dispatch for a failed or
aborted predecessor. It does not resume a transcript or grant control over the
predecessor. The caller supplies a corrected task and exact `forkName`; task
similarity and display labels are never used. `delegate_recover` remains the
independent in-memory recovery/resumption mechanism. Chain steps, saved chains,
and detached `driver` runs do not accept `retryOf`.
