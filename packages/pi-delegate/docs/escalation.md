# Delegate escalation

Escalation lets a worker raise a structured request up its chain of
accountability instead of guessing. It is intended for choices outside the
worker's authority, conditions that make progress impossible, and defects in
the task or plan itself.

Escalation is opt-in. Enabling it adds raise tools to the worker and resolution
or pass-through tools to a supervised fork's supervisor. Every request is
written to durable state before delivery is attempted, so wakes are hints rather
than the source of truth.

## Blocking invariant

A pending escalation holds **only the raiser**:

- the raise tool call remains suspended until a canonical outcome exists; in
  supervised mode the worker channel reports `awaiting-escalation` (direct mode
  has no supervisor channel, but holds the same raise call);
- that wait consumes no model tokens;
- supervisors, root agents, and other hops do not remain in a model turn while
  the request is pending; and
- the pending request, mailbox, route, and trace live in durable state.

A hop wakes briefly to resolve or pass the request, then goes back to sleep. In
supervised mode, the fork supervisor process remains alive-idle while the
hold-open worker is pending, but it does not burn model tokens. The v1
`hold-open` strategy still depends on process liveness: shutdown cancels and
cleans up the request rather than transparently resuming it in a new process.

## Raise tools

Enabled workers receive three kind-specific tools. Option selections and
recommendations use zero-based indices.

| Kind | Tool schema | Use it when |
| --- | --- | --- |
| Decision | `escalate_decision({header, category, body?, options, recommended?, multi?})` | A bounded choice blocks safe progress and the choice is beyond the worker's authority. `category` is required: use `implementation` for reversible implementation-local choices, `scope-product` for material scope/product/UX changes, or `security-permission` for security or permission questions. `options` contains 2–5 non-empty strings or `{label: string}` objects. `recommended` must index one of those options. `multi: true` permits more than one selected result. |
| Blocker | `escalate_blocker({cause, description, unblock?, options?})` | The worker cannot proceed. `cause` is any non-empty string; the well-known values are `env-missing`, `input-missing`, `external-failure`, `upstream-pending`, and `decision-needed`. Optional `options` contains 1–5 non-empty strings or `{label: string}` objects. |
| Amendment | `escalate_amendment({target, change, rationale})` | The task, plan, spec, or model itself needs an exact change. `target` is an opaque reference, not an ownership lookup. |

All three kinds resolve through the same outcome shape: one option index, or
multiple indices only for a multi-select decision, plus an optional audit `note`.
Every request appends `Other — custom instruction` after the raiser's (or
kind-specific default) options. Selecting that option is exclusive and requires
a non-empty `customInstruction` string; the canonical outcome then carries
`customInstruction` as its own field, distinct from `note`. Empty or cancelled
custom input leaves the request pending. When the raiser does not supply blocker
options, pi-delegate synthesizes:

1. `Fixed — retry`
2. `Skip this part`
3. `Abort task`

Amendments always use:

1. `Approve`
2. `Approve with modifications (see note)`
3. `Reject`

The persisted synthetic option is identified structurally as
`{label: "Other — custom instruction", custom: true}`. Resolvers and downstream
consumers must use `custom: true`, not the label or the option's position; a
raiser-supplied option may legitimately use the same label. Requests written
before this marker existed are handled fail-closed for custom resolution: a
`customInstruction` value is rejected with an instruction to upgrade/re-raise
the request. Their options remain index-addressable because an unmarked option
cannot safely be distinguished from a genuine option; no option is treated as
custom without the structural marker.

Terminal outcomes written by this version include `outcomeVersion: 1`.
Readers accept unversioned outcomes for backward compatibility and reject an
outcome with an unknown version with an actionable upgrade error. An
already-deployed pre-version reader cannot
be made to inspect this new field: it ignores unknown fields and would still
accept a `status: "resolved"` outcome while dropping `customInstruction`.
Using an unknown status value for custom outcomes was investigated, but that
reader rejects the record as non-terminal and `awaitOutcome` keeps polling
instead of failing cleanly, so the design was rejected as an operational hang.
This limitation applies only to old readers; future outcome versions are
protected by the version check.

### Generic `ask` compatibility in workers

Foreground/main interactive `ask` behavior is unchanged. A worker has no user
prompt surface, so an extension-registered `ask` is replaced only inside the
worker session. In an escalation-enabled slot, the compatibility adapter routes
bounded ask-shaped calls to `escalate_decision` while preserving the question,
2–5 options, zero-based recommendation, category, and multiselect flag. The
adapter requires an explicit category and fails closed for malformed or
unrepresentable payloads; it never infers `implementation` for a product,
design, security, or permission decision. Cancellation is propagated rather than
converted into an answer.

The enabled adapter advertises the canonical shape in its own schema — required
`question`, `category`, and 2–5 `options` — so the provider can validate the call
instead of every malformed payload costing a round trip. A `prepareArguments`
shim coerces the older ask dialects first: `header`/`prompt`, `context`,
`choices`, `recommendedIndex`, `multiple`, and a single-entry `questions[]`
payload, which is exactly one bounded decision. A multi-question ask cannot be
preserved and is rejected with instructions to raise the blocking question
first. Coercion only renames and reshapes; it never invents a category, an
option set, or an answer.

A routed decision must not let expiry select the worker's own recommendation, so
`useDefault` is replaced with `noDefaultError`. An explicitly configured `cancel`
or `noDefaultError` already carries no default and states an operator intent, so
it is preserved. Each routed request also records `origin: "ask"` on the durable
request — surfaced through `delegate_escalation` action `list` — so an operator can tell a
translated ask from a first-class `escalate_decision`. Provenance is deliberately
outside the dedupe content hash, so the same question dedupes identically
whichever path raised it. In an escalation-disabled slot, the shim returns a structured error that
tells the worker to stop and report the unresolved question upward; it never
names an escalation tool that is absent from a disabled slot.

Replacement is by tool name and applies to `interactive: true` worker entries as well.
That is deliberate: a routed worker UI context forwards only `confirm`,
`select`, and `input` to the delegate overlay, so an ask implementation built on
`custom` (including the current one) silently resolves to no selection there.
Routing an ask-shaped question through escalation keeps one auditable answer
path for every worker rather than two with different fidelity.

Detached driver children load the deny shim before consumer extensions when
`ask` is explicitly exposed, so a same-named consumer tool cannot win
registration ordering. The shim resolves as a sibling of the runner, preferring
the compiled `.js` and falling back to the TypeScript source that a source-loaded
checkout exposes; Pi loads extensions through jiti, so a `.ts` entry is a real
child `-e` target and, unlike a `dist/` fallback, can never be a stale build. The
same resolution covers the thinking-policy bridge. `resolveDelegateSelfPath()`
keeps `.js`-only resolution on purpose: swapping the child's whole delegate
extension to a source entry is a larger behavioral change, and its unresolvable
case is an existing documented degradation. If neither sibling exists, `ask` is
dropped from the child's `--tools` filter with a warning instead of failing the
dispatch; an ask-only allowlist still fails closed, because omitting `--tools`
entirely would widen the child to Pi's defaults.

An `ask` entry in a worker allowlist is reconciled against what the loader
actually registered. `ask` is accepted as an allowlist name but provided by an
extension, so a surface can name it while nothing registers it; Pi's allowlist is
name-only, which would otherwise leave an `ask`-only worker with no tools at all.
That case fails closed, and a mixed allowlist reports a diagnostic and continues.

A timeout or cancellation is returned to the worker as a normal narrated tool
result so the configured terminal policy can take effect; it is not presented
as a tool execution failure.

## Chain routing

The raiser is never a holder in its own chain. The candidate chains shipped in
v1 are:

- **Supervised (`mode: "supervised"`) dispatch:** fork supervisor → root originator → user.
  The fork supervisor is always a stop, even when it declares no authority.
  Root authority comes from the resolved global escalation configuration.
- **Solo runs and saved chain steps:** root originator → user.
  With the built-in global configuration, the silent root is filtered and this
  degenerates to user only.

Except for the supervised fork supervisor, a candidate is retained only when it
has authority for the request or opts into `intermediate: true`. Silent hops are
skipped, the user is appended unless an internal caller explicitly disables it,
and the user is never filtered. The filtered chain is frozen when the request
is raised; later topology changes do not rewrite it.

### Authority matrix

`authorityDecides(authority, kind, category)` applies the following matrix:

| Request | Authority that may resolve |
| --- | --- |
| Decision, category `implementation` | `decision: "implementation"` or `decision: "all"` |
| Decision, category `scope-product` | `decision: "all"` |
| Decision, category `security-permission` | `decision: "all"` |
| Decision, unclassified (category absent) | `decision: "all"` only |
| Blocker | `blocker: "all"` |
| Amendment | `amendment: "all"` |

`none` never resolves. An intermediate stop may annotate and pass a request but
does not gain resolution authority. `authority.tags` is carried in the schema
but is reserved and never matched in v1.

Worker-raised decisions must now provide a category. Older or lower-level callers
may still omit it, but unclassified decisions remain unclassified rather than
being silently downgraded to `implementation`; consequently, only
`decision: "all"` authority may resolve them. Raise-time routing and resolve-time
authority checks use this same conservative rule.

### Per-hop liveness

Every non-final stop gets an auto-pass deadline. An explicit `hopTimeoutMs`
wins; otherwise the deadline is one tenth of the request's remaining time with
a 30-second floor, capped by the request deadline. When that deadline expires,
maintenance forwards the request one hop and appends an `auto-passed` trace
entry. A dead hop can delay a request but cannot strand it.

The final user hop never auto-passes. The request-level timeout still applies
there and may write the configured terminal default.

## Resolving or passing at a supervisor

An enabled supervised fork clone receives two hop verbs:

- `resolve_escalation({requestId?, selected, customInstruction?, note?})` selects a zero-based index
  or array of indices. Select the option carrying `custom: true`
  exclusively when supplying `customInstruction`; it must be non-empty. `note`
  remains an optional audit field. `requestId` may be omitted only when exactly
  one request is pending in that supervisor's mailbox. Resolution is rejected
  unless the holder's declared authority covers the request.
- `escalate({requestIds?, context?, recommendation?})` means “not mine; pass
  up.” Omitting `requestIds` passes every pending request in that mailbox.
  Context and recommendation are appended to the durable trace.

Forwarding preserves the request ID and the raiser's reply endpoint. Only the
holder index, destination mailbox, deadline, and trace change.

## Originator and operator surfaces

The root session exposes three recovery tools over canonical durable state:

| Tool | Purpose |
| --- | --- |
| `delegate_escalation({action: "list", rootRunId?, requestIds?})` | List pending requests across roots, optionally constrained to one root and/or request IDs. It can show requests held below the root, at the root, or by the user. |
| `delegate_escalation({action: "resolve", rootRunId?, requestId, selected, customInstruction?, note?, onBehalfOfUser?})` | Resolve one root- or user-held request through its mailbox lease. A custom instruction must select the option carrying `custom: true` exclusively and is returned in the distinct `customInstruction` outcome field; `note` remains audit metadata. A root-held request is authority-gated. A user-held request requires an answer the operator actually chose and explicit `onBehalfOfUser: true`. |
| `delegate_escalation({action: "pass_up", rootRunId?, requestIds?, context?, recommendation?})` | Pass root-held requests to the next stop, normally the user. Omitting request IDs passes all root-held requests in scope. |

`rootRunId` may be omitted when lookup is unambiguous. A root-agent resolution
records `resolvedBy: "originator-agent"`. It records `resolvedBy: "user"` only
for a user-held request with explicit `onBehalfOfUser: true`; the agent must not
infer an operator answer.

### Native UI adapter

When the current holder is the user and the owning root has a live interactive
foreground session, pi-delegate drains the request through Pi's native select
prompt. The native prompt and agent-mediated surfaces arbitrate through the
same mailbox lease, preventing duplicate concurrent asks across surfaces. A
single-select request presents its resolution options; multi-select decisions
present bounded option combinations, with the option carrying `custom: true` as
an exclusive choice. Choosing it opens a text input; the entered text is stored
as `customInstruction`, not as the audit `note`.

Choosing `Dismiss — decide later`, closing the prompt, returning no answer, or
cancelling/emptying the custom text input releases the lease and leaves the
durable request pending. Dismissal does not select a default or resolve the
worker.

## Configuration

The binding configuration shape is one `escalation` block:

```jsonc
{
  "escalation": {
    "mode": "off",
    "authority": {
      "decision": "none",
      "blocker": "none",
      "amendment": "none",
      "tags": []
    },
    "intermediate": false,
    "hopTimeoutMs": null,
    "timeoutMs": 1800000,
    "timeoutBehavior": "useDefault",
    "holdStrategy": "hold-open"
  }
}
```

| Field | Accepted values | Built-in default | Meaning |
| --- | --- | --- | --- |
| `mode` | `"off"` or `"local"` | `"off"` | Enables local chain escalation for the slot only when resolved to `local`. No dispatch shape enables escalation implicitly. |
| `authority.decision` | `"none"`, `"implementation"`, or `"all"` | `"none"` | Decision categories this hop may resolve. |
| `authority.blocker` | `"none"` or `"all"` | `"none"` | Whether this hop may resolve blockers. |
| `authority.amendment` | `"none"` or `"all"` | `"none"` | Whether this hop may resolve amendments. |
| `authority.tags` | string array | `[]` | Reserved schema data; not used for matching in v1. |
| `intermediate` | boolean | `false` | Keep this candidate as an annotate-and-pass stop even without authority. The supervised fork supervisor is already always a stop. |
| `hopTimeoutMs` | positive integer or `null` | `null` | Per-hop auto-pass delay. `null` derives the deadline from the remaining request timeout. |
| `timeoutMs` | positive integer or per-kind map | `1800000` | Base request timeout. A scalar applies to every kind; a partial `{decision, blocker, amendment}` map overrides named kinds. Blockers use twice their configured base. |
| `timeoutBehavior` | `"useDefault"`, `"noDefaultError"`, `"cancel"`, or a partial per-kind map | `"useDefault"` | Terminal behavior. Kind defaults are described below. |
| `holdStrategy` | `"hold-open"`; `"park"` is schema-reserved | `"hold-open"` | How the raiser waits. `park` is not implemented and is rejected before use. |

Resolution is field-wise with precedence **invocation > agent frontmatter >
global config > built-ins**. Authority and per-kind maps are deep-merged rather
than replaced wholesale. A higher layer may therefore override one field while
inheriting the rest. Enablement remains strictly opt-in: an applicable layer
must explicitly supply `mode: "local"`; merely declaring authority does not
enable a slot.

The shorthand values `"off"` and `"local"` stand for `{mode: ...}` on
invocation slots and in agent frontmatter. The global config file uses the
object block.

### Per-slot shorthand

```js
delegate({
  runs: [{
    name: "release-check",
    agent: "reviewer",
    task: "Check the release and raise anything unsafe.",
    escalation: "local",
  }],
})
```

The same optional slot field is accepted on any solo or supervised run entry and
on saved chain steps. A `driver` entry has no slot-level escalation field.

### Agent frontmatter

```yaml
---
name: careful-implementer
description: Implements bounded changes and forwards authority questions
escalation:
  mode: local
  authority:
    decision: implementation
    blocker: none
    amendment: none
  hopTimeoutMs: 120000
---
```

Hand-authored frontmatter accepts the nested block and tolerantly warns and
drops malformed fields. Agent management currently round-trips only the flat
`escalation: off|local` shorthand; nested escalation YAML must be maintained in
the agent file directly.

### Global config

This example keeps workers opt-in at their agent or invocation layer while
declaring what the root originator may decide:

```jsonc
{
  "escalation": {
    "mode": "off",
    "authority": {
      "decision": "all",
      "blocker": "all",
      "amendment": "none"
    },
    "timeoutMs": {
      "decision": 1800000,
      "blocker": 1800000,
      "amendment": 1800000
    }
  }
}
```

Setting global `mode` to `local` is an explicit operator choice that enables
slots which do not override it. Set a higher-precedence slot or agent layer to
`off` to opt that slot back out.

## Timeout defaults

With the built-in `useDefault` behavior:

- **decision:** times out after the configured base and selects the raiser's
  `recommended` index when present. Without a recommendation, the timeout is
  terminal but carries no invented selection;
- **blocker:** uses a deadline at twice the configured base and terminal
  behavior `cancel`; and
- **amendment:** uses the configured base and selects `Reject` (index `2`).

Explicit per-kind `noDefaultError` or `cancel` values override those default
behaviors.

## Await guard

Escalation relies on background delivery. Before dispatch, pi-delegate rejects
`await: true` when **any** slot resolves to escalation-enabled. The deprecated
`sync: true` alias is checked the same way. The error lists every offending
slot and gives both remedies: remove `await:true` so the run stays in the
background, or set escalation to `"off"` for every listed slot.

This check occurs before workers are dispatched; mixed batches cannot partly
start and then fail the invariant.

## Prompt guidance

Every enabled worker receives an injected escalation contract, including after
a supervised worker restart. It says to decide reversible,
implementation-local choices supported by task and repository evidence, and to
forward material scope/product changes, conflicting requirements, security,
permissions, compatibility or migration risk, destructive or irreversible
actions, external side effects, and meaningful cost. It distinguishes decision,
blocker, and amendment raises. If the task explicitly requires escalation for a
class of choice or condition, the worker must use the matching tool rather than
guess. The guidance also explains that only the raise tool call is suspended,
without model-token burn, and that the eventual narrated result is authoritative.

An enabled supervisor clone receives matching guidance: resolve only inside its
declared authority and only with enough request context to choose safely;
otherwise use `escalate` with useful context and a recommendation. It must not
poll, sleep, keep a model turn open, guess an operator choice, or resolve a
beyond-authority request.

Root guidance treats pending wakes as hints and re-reads canonical state through
`delegate_escalation` action `list`. The root resolves only within its declared authority,
uses `delegate_escalation` action `pass_up` to pass anything else upward, and sets
`onBehalfOfUser: true` only after the operator actually chose.

## Delivery, maintenance, and cleanup

The durable layout is rooted by delegation run:

```text
<agentDir>/extensions/pi-delegate/event-bus/<rootRunId>/escalations/
  requests/<requestId>.json
  results/<requestId>.json
  mailboxes/<holderId>/<requestId>.json
```

Delivery re-reads canonical holder state before acting:

- a user-held request in a live interactive foreground session uses the native
  UI adapter by default;
- with `nativeEscalationUi: false` in
  `<agentDir>/config/pi-delegate/config.json`, an external operator surface owns
  user-held answers. The request is not prompted natively and does not wake the
  root agent, so the host has the only answer surface. It stays pending in the
  durable feed for the host escalation API. The final user hop never
  auto-passes, so nothing forwards it back to the agent; the request timeout
  still settles it;
- a live, same-process supervisor or agent hop receives a `followUp` steer;
- a root holder, or a user holder without native UI when
  `nativeEscalationUi` is not `false`, wakes the root agent with a triggered
  message so it can use the originator tools; and
- an unavailable mid-level cross-process hop is not misrouted to the root. Its
  durable request remains pending for later maintenance or auto-pass.

The foreground maintenance service scans roots, replays owner-scoped wake
hints, advances expired hop and request deadlines with `advanceEscalations`,
and retries durable delivery. Deadline scheduling also continues while a raise
tool is held open.

Terminal cleanup is root-run scoped. Completing a nested run does not purge its
root's sibling requests; completing, aborting, or shutting down the root cancels
pending outcomes, removes wakes, and purges that root's escalation namespace.
Retired `decisions/` state is purged across event-bus roots at startup and again
during root cleanup; it is not migrated.

## Demo

Run the deterministic narrated walkthrough from the repository checkout:

```bash
npx tsx scripts/escalation-demo.ts
```

The script creates temporary state and narrates a depth-three chain: a silent
ancestor is skipped, the fork supervisor claims and manually forwards a
decision with annotations, an intermediate misses its deadline and is
auto-passed to the user, the user resolves while a duplicate write loses, the
raiser resumes from `awaiting-escalation`, an amendment times out to Reject,
and terminal cleanup removes both current and legacy namespaces.

## Defaults and rollout

Supervised background escalation is **opt-in at launch**. The proposed
default-on flip is deliberately deferred pending real-world shakeout after the
main release on **2026-07-23**. Direct workers remain opt-in indefinitely because
their first possible non-user stop is the root originator rather than a fork
supervisor.

## Explicitly deferred

The following are designed seams, not shipped behavior:

- `park` hold strategy (checkpoint and terminate the raiser, then redispatch it
  after resolution);
- one unified raise-side `escalate({kind, ...})` sugar tool;
- remote or Pi Session Server transport;
- routing amendments to artifact owners (`target` remains opaque and amendments
  follow the ordinary chain); and
- root-agent-raised escalations directly to the operator. The schema can
  represent raiser = root with chain `[user]`, but the durable root `ask`
  surface is post-v1.
