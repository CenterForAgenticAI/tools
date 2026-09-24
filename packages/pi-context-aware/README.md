# context-aware extension

`context-aware` helps Pi sessions manage long-running work without losing the thread. It adds context-budget awareness, safer phase handoffs, live seed rewriting previews, transcript recovery metadata, and prior-session search.

The main workflow is:

1. decide the current phase is ready to compact;
2. provide a short next-phase seed such as `continue with item #3`;
3. let the extension rewrite that shorthand into a self-contained prompt;
4. compact the conversation using the rewritten prompt as summary guidance;
5. after Pi drains any input queued during compaction, automatically start the
   next phase with the rewritten prompt.

This keeps post-compaction sessions from starting with under-specified instructions like “keep going” while still making compaction quick to invoke.

## What it provides

- **Context budget status**: a pressure-only footer item gives the glanceable band and percentage while `/context-status` reports full token usage, headroom, and configuration; agents receive cache-friendly `<context-telemetry>` envelopes for context pressure.
- **Self-contained compaction handoffs**: `/compact-then` and `compact_session` rewrite raw seeds into fresh-session-ready prompts.
- **Live rewrite preview**: while the model rewrites the seed, the UI streams the emerging prompt/question in a compact widget above the editor.
- **Distinct compaction state**: when compaction starts, the rewrite preview clears and the UI switches to a separate “Compressing conversation into handoff summary…” loading state.
- **Generation-safe proactive compaction**: after every completed provider turn—including tool loops—the extension checks both the configured context threshold and usable output headroom, schedules the trigger without awaiting a model from `turn_end`, and starts bounded seed preparation only from Pi's public `agent_settled` idle boundary. A context-constrained output-limit stop is discarded and recovered through one compact-and-retry handoff, keeping the truncated tool call so Pi can answer it with a result of its own instead of leaving that result parentless.
- **Automatic-compaction ownership warnings**: startup reports competing context-aware/Pi owners or a configuration with no automatic owner, while preserving intentional Pi-native-only mode.
- **Context-overflow recovery**: extension-owned seed, compaction, and cache-artifact model calls retry once with a smaller payload; an optional configured model can take a final fallback attempt, with visible diagnostics for each recovery step.
- **Tool-result integrity guard**: every outgoing history is checked against the provider's own pairing rule before the request leaves, on the merged shape the provider actually receives. A tool result that has lost its tool call is repaired—by restoring the call where possible, otherwise by dropping that one result—and reported once, so a malformed history costs a retry instead of the session.
- **Transcript recovery**: compaction summaries include a `Prior transcript: ~/.pi/agent/sessions/...` line so later agents can recover full pre-compaction context if needed.
- **Seed metadata**: compaction details preserve raw seed, expanded seed, ambiguity mode, confidence/fallback metadata, and transcript path.
- **Prior-session search and compaction boundaries**: `search_prior_sessions` can search earlier session transcripts, including the current session when `include_current: true`; `session_compaction_history` reports current-branch compaction counts and boundary identifiers without scanning the transcript.
- **Optional durable workstreams**: agents can start a concise, unpinned focus when its purpose must survive context loss; transcript-authoritative state, a persistent width-aware active-focus widget above the editor, bounded context/compaction projections, private session registry records, exact overlap warnings, and optional terminal/launcher metadata are wired through the Pi lifecycle.
- **Session task list**: an enumerable checklist that survives compaction. `session_tasks` and `/tasks` keep tasks in the transcript, the list is re-rendered into the prompt every turn, a settle-time nudge names what is still open, and the remaining tasks ride the compaction seed into the next phase.
- **User-facing session health**: `/focus health` and `/sessions health` expose scrubbed adapter/capability state; `/sessions` lists bounded session projections and `/sessions jump <id>` delegates only through an available launcher.
- **Typed cross-extension service**: protocol v1 exposes pressure/headroom, session lineage, stable context-cache references, optional explicit one-way artifact promotion, and bounded seeded handoffs without parsing model-facing markers.
- **Runtime overrides**: CLI flags can temporarily override the extension config for a single Pi process.

## Install

Install the public package with Pi:

```sh
pi install npm:@centerforagenticai/pi-context-aware
```

For local development, add the checkout path to `~/.pi/agent/settings.json`
under `packages`. The package's `dist/` directory is gitignored, so run
`npm run build` after every pull or branch switch, before `/reload` or
restarting Pi. The manifest loads `./dist/index.js`; the `prepare` script builds
`dist/` automatically during install and `npm pack`.

The supported host version is exactly Pi 0.84.2
(`@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai`) on Node 22.19
or newer. Pi 0.83.0 is not compatible with release 0.2.3 or later; consumers
must upgrade Pi. Release 0.2.0 remains the last release declaring Pi 0.80.6 or
0.83.0. Earlier releases are not declared as compatible: Pi 0.80.6 could lose
input queued during compaction, while the current lifecycle requires
post-compaction handoffs to wait until Pi has released compaction.

## Cross-extension integration

Other Pi extensions can import the protocol-v1 contract from
`@centerforagenticai/pi-context-aware/context-service` and discover the session-scoped service over
Pi's shared `pi.events` bus. It returns typed point-in-time pressure/lineage
snapshots and metadata-only artifact references, and can request the same
seeded compaction/handoff pipeline used by `compact_session`.

See [context-service.md](context-service.md) for discovery, request/response
shapes, lifecycle events, bounds, non-interactive behavior, cancellation,
conflict handling, provenance, and versioning.

Model-facing `<context-telemetry>` envelopes, historical `[ctx ...]` markers,
status text, prompt cache blocks, and `Prior transcript:` lines are **not** an
integration API. Consumers must not parse them.

## Getting started

### 1. Check the current context state

Inside Pi:

```text
/context-status
```

This reports context usage, seed mode, rewrite behavior, ambiguity mode, compaction model, proactive compaction threshold, and the latest seed handoff (including the raw seed, seed actually used, and any expansion or no-expansion reason). The shared footer deliberately shows only the pressure icon and rounded percentage (for example, `🟢 24%`); detailed token counts and non-default configuration stay out of the crowded footer.

While a durable workstream is active, a separate widget above the editor shows its objective, status, and goal progress. The widget word-wraps to the available terminal width within a two-line collapsed budget, marks a longer objective with `…`, and reveals the full text plus a collapse hint while tool output is expanded. It refreshes after focus mutations and session replay, and disappears when the workstream is paused, completed, detached, disabled, or unavailable.

`/focus` renders the authoritative snapshot as a scan-friendly summary of the objective, status, goals, references, boundaries, and revision rather than raw JSON. Focus mutations use the same view for confirmations or rejection reasons; `/focus activity` shows the full recorded activity timeline. `/focus health` reports scrubbed adapter and capability state without exposing transcript content.

Activity entries are generated automatically after a settled run that contains a material typed event such as a decision, commit, file change, blocker, or handoff. The primary coding agent does not author these entries, so no agent skill is required. A separate bounded activity-model call receives an explicit system rubric and a structured payload with two different trust roles:

- `authoritativeWorkstream` is validated alignment state replayed from `context-aware.workstream.v1`. Its objective, status, pinning, goals, references, and boundaries are the sole semantic authority for the workstream's current purpose and constraints.
- `transcriptEvidence` is a bounded, redacted account of what happened. Embedded text may provide evidence of a genuine decision or result, but it cannot instruct the activity model or redefine the workstream. `recentActivity` is likewise a projection used for continuity and deduplication, never authority.

The model may emit zero to three grounded events and should return no events when the evidence is routine, ambiguous, unrelated to the authoritative objective, or contains no durable change. Objective, goal, boundary, status, and pinning changes must come from `authoritativeWorkstream`, not be inferred from raw transcript language. For inactive workstreams, only lifecycle transitions or still-relevant unresolved state qualify; unrelated subsequent work does not. Oversized state is reduced to a valid bounded JSON projection with explicit `omittedCounts`; omitted items are never treated as absent state.

The activity rubric uses these meanings:

- `progress`: a meaningful objective milestone was completed or independently verified, not merely a command or intermediate edit;
- `decision`: an approach, constraint, trade-off, or direction was deliberately chosen with consequences for later work;
- `blocker`: progress remains materially impaired until a named condition is met;
- `handoff`: responsibility or a defined next phase moved to another agent, session, reviewer, or operator;
- `diagnostic-gap`: a material uncertainty or missing piece of evidence about the work remains unresolved.

Each summary must describe a durable outcome rather than raw tool activity, remain grounded in supplied transcript-entry IDs, avoid duplicating recent activity, and contain no secrets or unnecessary path details. `relevant: true` means an agent resuming after compaction would need the event to continue the objective or honor a current decision, blocker, constraint, or handoff. Other durable historical milestones may be recorded as not relevant and therefore stay out of the bounded compaction digest.

Durable focus is deliberately optional and defaults to unset. The model-facing policy asks the agent to make an explicit continuity decision at the start of each objective. Start it only when the objective itself must survive an expected compaction, session handoff, restart, or explicit user request. Complexity, multiple files, delegation, worktrees, tests, or a long single-session task are not enough:

```ts
session_focus({
  action: "start",
  objective: "Preserve the durable lifecycle handoff",
  reason: "The objective must survive an expected compaction and reviewer handoff"
})
```

If uncertain, leave focus unset. `session_focus` is not a to-do list, progress tracker, activity log, or implementation ledger. Do not create goals for ordinary steps or add refs merely to record transient branches, worktrees, commits, or paths. Do not update it after each phase, tool call, test result, commit, or routine status change.

A self-contained answer, routine one-file edit, or task expected to finish in the current response should remain without focus; if the objective later must survive context loss, start focus then after any required thinking-effort preflight. When focus is justified, state one concise overall purpose instead of copying the user's prompt. Use a goal only for a durable sub-objective whose state must survive context loss, a ref only when it is needed to resume the work, and a boundary only for a lasting constraint. Mutate it only for a durable semantic change needed after context loss: the objective materially changes, the user establishes or changes a lasting constraint, a resumable external reference becomes essential, or the lifecycle truly pauses, completes, or detaches. Otherwise do not call `session_focus`.

Agent-created objectives start unpinned so the agent can refine them. An explicit user `/focus edit <objective>` creates or updates a pinned objective that agent mutations cannot replace. The initial agent `start` operation is rejected when a focus already exists; invalid mutations are rejected without changing the authoritative snapshot. A user uses `/focus edit` to establish or replace a user-owned objective.

Only enabled, active focus affects prompt context, compaction guidance/details, or next-phase seed constraints. Missing, disabled, paused, completed, and detached focus leaves normal compaction unchanged and contributes no durable-workstream content.

For the model itself, context-aware avoids rewriting exact usage numbers into the system prompt every turn. Instead, it keeps stable telemetry-reading guidance in the system prompt and persists one hidden, self-describing `<context-telemetry>` envelope when each outer user turn starts. The envelope carries the pressure band, rounded usage percentage, approximate headroom, and an optional action while explicitly identifying itself as extension telemetry rather than user input. It remains unchanged through the turn's internal tool/model loop, keeping the transcript append-only for provider prompt caching.

### 2. Compact with an explicit seed

Use `/compact-then` when you are at a clean phase boundary:

```text
/compact-then continue with item #3
```

The extension will:

1. rewrite `continue with item #3` into a self-contained next-session prompt;
2. show the rewrite live as it streams;
3. compact the current conversation using the rewritten prompt as summary guidance;
4. preserve Pi's native order for input queued during compaction, then deliver the
   rewritten prompt exactly once as a generated compaction handoff.

With no queued input, the seed starts the next turn immediately after
compaction. With queued input, Pi submits that input in its native order first;
the seed follows after the queue is idle. The extension does not inspect or
reorder Pi's private interactive queue.

To choose the model for the next phase, add a trailing model option:

```text
/compact-then continue with item #3 --model anthropic/claude-sonnet-4-20250514
```

Context-aware resolves the model through Pi's registry, respects any model scope configured for the session, and verifies authentication before seed preparation or compaction starts. A missing, malformed, unknown, out-of-scope, or unavailable model is rejected without compacting. After compaction and any queued input finish, the extension awaits Pi's public model setter and sends the seed only when selection succeeds. Pi persists this active-model change for later turns.

This command option is separate from `compactionModel`: it neither changes that setting nor chooses the model that generates the compaction summary. It applies only to `/compact-then`; the `compact_session` tool has no model option.

You can also use a loaded Pi prompt template as the explicit seed:

```text
/compact-then /review-auth src/auth.ts
```

Before seed rewriting starts, context-aware finds `/review-auth` through Pi's command registry, reads the loaded template body, and applies its argument placeholders. The rewrite model receives that resolved body, not the slash-command name. This makes the combination deterministic instead of relying on the model to infer what `/review-auth` means.

This resolves the prompt text only. It does not execute template frontmatter controls such as `model`, `thinking`, `skill`, `loop`, `chain`, `subagent`, or deterministic shell steps. A registered extension or skill command without a matching loaded prompt template is rejected because it has no prompt body that context-aware can safely use as a handoff seed.

### 3. Compact without writing a seed

```text
/compact-then
```

With no seed, the extension first generates a raw next-phase seed from the conversation, then applies the same rewrite and handoff flow.

### 4. Let the agent compact via tool call

Agents can call:

```ts
compact_session({
  seed_prompt: "continue with item #3",
  summary_focus: "Preserve exact file paths and validation commands."
})
```

Use this at clean boundaries, not mid-edit or mid-debug.

### 5. Use fully autonomous handoff mode when appropriate

```text
/context-aware-mode autonomous
```

This sets:

```json
{
  "seedMode": "auto-gen",
  "seedRewrite": true,
  "ambiguityMode": "always-proceed"
}
```

Autonomous mode is useful for unattended agents that should self-compact and continue without stopping for clarification.

### 6. Let context-aware preempt unseeded auto-compaction

By default, proactive compaction is enabled at **78%** context usage with a **16,384-token output allowance plus 2,048 tokens of protocol overhead**. After every completed provider turn—including `toolUse`, `length`, and error turns—context-aware estimates the newly appended tool results and other trailing context. The `turn_end` handler records the trigger, arms the cancellation drain, and returns without awaiting seed generation. After Pi emits `agent_settled`, context-aware restores the exact active-tool set and launches seed preparation in the background only while `ctx.isIdle()` is true. It compacts before the next model call when either the percentage threshold is crossed or remaining headroom is below the generation reserve. The output allowance is capped at the active model's advertised `maxTokens` when that limit is smaller.

This closes the same-turn gap where a large tool result could leave only a few thousand tokens for the automatic follow-up response. Repeated pressure while preparation is pending or generating is coalesced into that attempt; a later active run is drained without starting a duplicate model call. A competing Pi threshold/overflow compaction is cancelled while preparation owns the seeded handoff, so the same pressure event cannot produce an unseeded compaction followed by a duplicate. Seed generation plus rewriting uses a first-output grace period and a resettable stall timeout, with an absolute five-minute preparation ceiling. A provider that ignores cancellation may finish its detached request later, but it cannot hold `turn_end`, `agent_settled`, shutdown, or a replacement session open, and its late result cannot queue work. The reserve check takes priority when selecting the trigger, but generation-reserve and threshold triggers share the proactive cooldown. A queued attempt starts the guard, and completion resets its full duration; when before/after usage confirms that compaction did not reduce context, context-aware warns instead of immediately re-arming the drain. If Pi has not made post-compaction usage measurable yet, context-aware records a pending measurement, keeps the cooldown active, and checks the first later assistant result before warning. If model-generated seed preparation is unavailable at that safety boundary, context-aware records the failure, falls back to a deterministic recovery seed, and still starts compaction instead of allowing the under-budget normal turn.

If a provider nevertheless returns `stopReason: "length"` while usable headroom is below the reserve, context-aware replaces the prose of the finalized incomplete assistant message before persistence and starts the same compact+handoff recovery. The truncated tool call and the `length` stop reason are both kept, because Pi answers a length-stopped call with an error result of its own rather than executing possibly truncated arguments: erasing the call would leave that result with no tool call to belong to, which is the failure behind issues #10 and #56. That recovery is guarded to one attempt per interrupted run: a second length stop remains visible and does not start an infinite compaction loop. Ordinary length-limited responses with adequate context headroom are left unchanged because compaction would not repair a model's independent output cap.

Configure it with:

```text
/context-aware-proactive status
/context-aware-proactive 80%
/context-aware-proactive reserve 32768
/context-aware-proactive off
/context-aware-proactive on
```

### Choose one automatic compaction owner

For seeded automatic handoffs, enable context-aware proactive compaction and disable Pi native auto-compaction:

`~/.pi/agent/context-aware.json`:

```json
{
  "proactiveCompaction": {
    "enabled": true
  }
}
```

`~/.pi/agent/settings.json`:

```json
{
  "compaction": {
    "enabled": false
  }
}
```

Pi's `compaction.enabled` switch gates only its automatic threshold/overflow checks. Manual `/compact`, `compact_session`, `/compact-then`, and context-aware's `ctx.compact()` path remain available when it is off.

At `session_start`, context-aware reads Pi's public `SettingsManager` with the active cwd, agent directory, and project-trust decision. This mirrors Pi's default/global/project precedence for a normal file-backed Pi CLI startup. The extension API does not expose Pi's live settings manager or a settings-change event, so changing Pi's auto-compaction option in `/settings` requires `/reload` (or a restart) before this warning and the ownership status are refreshed. Context-aware's own `/context-aware-proactive` command re-evaluates ownership immediately against that startup snapshot. SDK hosts that inject an in-memory/custom settings manager or runtime `applyOverrides()` are not observable through `ExtensionContext`; their ownership status is therefore limited to the same file-backed approximation.

| Context-aware summarizer | Context-aware proactive | Pi native automatic | Startup warning/status |
|---|---|---|---|
| on | on | off | none — context-aware owns automatic compaction |
| on | off | on | none — intentional Pi-native-only mode |
| on | on | on | competing automatic compaction owners |
| on | off | off | no automatic compaction owner |
| off | inactive (configured value retained) | either | none — deferred to another compactor |

Warnings are emitted once per observed unsafe state rather than on every status check. `/context-aware-proactive status` and `/context-status` show the owner plus the startup source of Pi's setting. When `summarizer.enabled` is `false`, ownership status is `deferred to another compactor`; context-aware does not guess which registered extension will claim the hook. If the global or trusted-project Pi settings file cannot be parsed or read, status reports the owner as unknown instead of guessing and no ownership warning is emitted.

To let another extension own both automatic triggering and summarization while retaining context-aware tasks, focus, and telemetry, configure:

```json
{
  "summarizer": { "enabled": false },
  "proactiveCompaction": { "enabled": false }
}
```

The configured proactive value is retained, but its effective state is inactive while `summarizer.enabled` is `false`. Context-aware does not initiate threshold, generation-reserve, or output-limit compactions for another compactor, and it suppresses any prepared automatic handoff if ownership changes before delivery.

## Model dispatch decisions

All extension-owned model calls share one recorded routing decision. Pi exposes `ExtensionContext.modelRegistry.complete` for routed completion, but it exposes no public routed `stream` or `streamSimple` method to extensions.

Completion-only sites route through `ctx.modelRegistry.complete`. The three streaming sites are **adaptive**: they stream through compat when the loaded compat instance can dispatch the model's api (`getApiProvider(model.api)` resolves), and otherwise route through `ctx.modelRegistry.complete`. The transport decision is made per model, so a compaction that falls back to a configured overflow-fallback model reconsiders it — a fallback reachable only through a runtime-registered api routes even when the primary streamed, and vice versa. This adaptive fallback matters when a model is reachable only through an api registered at runtime by another extension — for example `@centerforagenticai/pi-multi-account`'s `unified` alias router. Under a `packages:` load the extension's `@earendil-works/pi-ai/compat` bare specifier resolves to this package's own on-disk copy, whose registry never received `unified`; a raw `streamSimple` on that copy throws `No API provider registered for api: unified` synchronously, before any overflow or transient recovery can run. That is the module-split failure that previously forced Pi's un-reduced built-in compaction to retry the full transcript and overflow. Routing through the registry keeps those models reachable and keeps the existing reduced-payload and configured-fallback recovery ladder in play. The tradeoff is that a routed call is non-streaming, so incremental seed/compaction progress is not shown while it runs; for the seed paths, a routed call pings the preparation liveness heartbeat on an interval so a slow-but-healthy completion is not aborted by the first-output grace, while the absolute preparation ceiling still bounds a stuck call.

When the compaction hook fails for a reason that is neither an exhausted overflow ladder nor an exhausted transient transport, context-aware normally defers to Pi's built-in compaction. Before doing so it checks that the built-in's requests could actually fit. Pi sends the history summary and, for a split turn, the turn-prefix summary as separate requests, each with `settings.reserveTokens` of headroom, so context-aware models the largest single request rather than their sum and extrapolates its bounded token estimate to the full transcript. When even that request cannot fit, context-aware cancels with a visible error instead of handing the built-in an oversized request it can only reproduce as an unchanged-context overflow.

| Site | Dispatch | Decision and failure signal |
|---|---|---|
| Cache artifacts | Routed via `ctx.modelRegistry.complete` | A failed artifact warns in the UI; the compaction summary is preserved. |
| Seed generation | Adaptive: raw `streamSimple`, else routed `complete` | Streaming is used when the loaded compat instance can dispatch the model; otherwise the call routes through the registry. Retry exhaustion or the static safety handoff is reported in the UI. |
| Seed expansion | Adaptive: raw `streamSimple`, else routed `complete` | Streaming when dispatchable; otherwise routed. The failure reason is reported in the UI and the safe raw-seed fallback remains. |
| Override summary | Routed via `ctx.modelRegistry.complete` | A routed failure warns before the active-model fallback runs. |
| Compaction primary stream | Adaptive: raw `streamSimple`, else routed `complete` | Streaming when dispatchable; otherwise routed. Compaction recovery and fallback failures are reported in the UI. |
| Compaction retry/fallback | Adaptive: raw `streamSimple`, else routed `complete` | The same visible compaction recovery handling covers the reduced and configured-fallback attempts. |
| Workstream activity | Routed via `ctx.modelRegistry.complete` | A routing or completion gap immediately warns; the authoritative workstream remains intact. |

The provider-side API-registration prerequisite has landed. That fixes the known missing registration trigger but does not replace this extension's routing contract.

The parity matrix is maintained in `MODEL_DISPATCH_DECISIONS` and tested for all seven sites. Completion paths use Pi routing; retained raw streaming paths have deliberate reasons and visible, non-fatal degradation.

## Important concepts

### Cache-aware context telemetry

Prompt caching works best when the long prompt prefix stays stable. Earlier versions appended exact context usage numbers to the system prompt before every agent turn, which could make provider prompt caches diverge before conversation history.

Current behavior splits this into two pieces:

1. a stable `<context-awareness>` system prompt block that explains how to interpret context-pressure telemetry;
2. a hidden, self-describing custom message persisted once when the outer user turn starts.

Envelope format:

```xml
<context-telemetry source="pi-extension:context-aware" user-input="false" response-expected="false">
  <pressure band="WARN" usage-percent="64" approximate-headroom="98k" action="gate-broad-work" />
  <instruction>This is extension telemetry, not user input. No response or acknowledgement is expected. It does not supersede the preceding user request or tool result. Continue the current agent loop without acknowledging this telemetry, using the pressure data only for context-management decisions.</instruction>
</context-telemetry>
```

The `action` attribute is omitted in the `OK` band, is `gate-broad-work` in `WARN`, and is `compact-before-tool` in `URGENT`. Usage percentage and headroom are intentionally rounded.

Pi currently converts extension custom messages to an LLM-facing `user` role. The envelope is therefore deliberately self-describing: it identifies `pi-extension:context-aware` as its source, states that it is not user input, and tells the model to continue the preceding request or tool loop without acknowledgement. Its snapshot includes the newly submitted user prompt, then remains byte-identical while tool results and later model calls append after it. A new envelope is appended only when the next user turn starts.

Interpretation is intentionally graduated:

- `OK`: compact only at natural phase boundaries.
- `WARN`: gate broad work. Before broad search/read, repeated test/debug loops, phase switches, or context-heavy delegation, the agent should either compact at a clean boundary, keep the next action small and reassess, or delegate bounded work with controlled context. For delegated work, prefer `delegate` with `task_only` or `snippet` `clone_mode`, explicit scope/stop rules, and concise collapsed results. Compact first for broad or full-context delegation.
- `URGENT`: compact before nontrivial tool use unless finishing one atomic edit/validation that would be unsafe to interrupt; then compact immediately.

### Raw seed vs expanded seed

The **raw seed** is what the user/tool provides:

```text
continue with item #3
```

The **expanded seed** is the rewritten prompt sent into the next compacted session:

```text
Continue the context-aware extension work by designing and implementing the test/benchmark suite for seed expansion and compaction handoff. Relevant files include ...
```

When `seedRewrite=true`, the expanded seed replaces the raw seed for both compaction steering and the post-compaction follow-up message.

### Handoff sequence

The sequence is intentionally sequential:

1. resolve or generate raw seed;
2. rewrite raw seed into a self-contained prompt;
3. optionally ask for approval/edit;
4. start full compaction using the final expanded seed;
5. let Pi drain input queued during compaction, then deliver the final expanded
   seed exactly once as a generated compaction handoff.

Full compaction does **not** start concurrently with seed rewriting or approval, because the compaction summary is steered by the final expanded seed.

### Live progress UI

Seed expansion uses a streaming-friendly tagged protocol with blocks like:

```xml
<expanded_seed_prompt>
...
</expanded_seed_prompt>
```

or:

```xml
<question>
...
</question>
```

The UI should show:

1. live seed rewrite progress while the model writes the expanded prompt/question;
2. a distinct compaction loading state while the full summary is being generated:

```text
Compressing conversation into handoff summary…
```

### Transcript and metadata

Compaction summaries should include a prior transcript reference:

```text
Prior transcript: ~/.pi/agent/sessions/...
```

Compaction details should include seed handoff metadata when available, such as:

```json
{
  "priorTranscriptPath": "~/.pi/agent/sessions/...",
  "rawSeedPrompt": "continue with item #3",
  "expandedSeedPrompt": "Continue by designing and implementing...",
  "seedRewrite": true,
  "ambiguityMode": "inherit",
  "effectiveAmbiguityMode": "cautious-proceed",
  "seedExpansionConfidence": "medium"
}
```

When rewriting was expected but the model throws, returns no text, or returns an unparseable result, context-aware uses a raw-seed safety fallback, records the failure reason, and shows one warning. An intentional no-expansion-needed outcome (aborted, no model, unavailable auth, or no history) uses the raw seed silently and records its reason. `/context-status` shows the latest raw seed, the seed actually handed to the next phase, and the recorded outcome.

### Tool-result integrity

A provider rejects a whole conversation when a tool result has no matching tool call in the message right before it. That single fault is fatal in a way most are not: the request fails, every later turn rebuilds the same history, and the same rejection comes back, so the session cannot be used again. Anthropic and OpenAI report it in two unrelated-looking ways:

```text
Anthropic: messages.<i>.content.<b>: unexpected `tool_use_id` found in `tool_result` blocks: <id>.
           Each `tool_result` block must have a corresponding `tool_use` block in the previous message.
OpenAI:    No tool call found for function call output with call_id <id>.
```

Context-aware guards both ends of this.

**Nothing this extension does destroys a tool call.** When a transient response has to be discarded—the cancellation drain, or output-limit recovery—only its prose is replaced. Pi applies such a replacement with `_replaceMessageInPlace`, which empties the original object, and that object is the one held by both agent state and the running agent loop, so a tool call left out of the replacement is destroyed in both at once while its tool may still be executing and about to deliver a result.

**Every outgoing history is checked before the request leaves.** The check runs on the shape the provider actually receives, not the raw message list: Pi converts custom, bash-execution and summary messages into user messages, drops assistant messages whose stop reason is `error` or `aborted`, synthesizes a result for any unanswered tool call, and merges consecutive tool results into one message. An orphan can therefore hide at `content.2` of a batch whose first two blocks are fine, which is exactly the shape that killed a session on 2026-08-17.

When a check finds one, the history is repaired rather than sent:

- **Restore the tool call** when it still exists earlier in the list—typically because Pi dropped the assistant message that carried it—so the tool output survives. One observed orphan was a 53-second `npm run check`.
- **Drop that one tool result** when its call cannot be recovered. Losing one result costs a retry; losing the session costs everything.

Each repair is reported once per session at warning level, naming the tool and the tool-call id, so a silent repair cannot hide the defect that caused it. A provider rejection that still matches either wording above is treated as repairable rather than terminal: extension-owned model calls retry it, and a main-loop rejection is named as repairable, because the next request is repaired before it goes out.

When an explicit seed came from a prompt template, details also record `promptTemplateInvocation`, `promptTemplateName`, `promptTemplatePath`, and `resolvedPromptTemplateSeed`. This distinguishes the text Pi resolved from any later model rewrite.

## Main commands

### `/compact-then [seed prompt]`

Compact and start a new phase.

With an explicit seed:

```text
/compact-then continue with item #3
```

A loaded prompt template invocation is also accepted and resolved before rewriting:

```text
/compact-then /review-auth src/auth.ts
```

With no seed:

```text
/compact-then
```

The no-seed path generates a seed from the current conversation, then applies the same rewrite/approval/ambiguity behavior.

### `compact_session` tool

LLM-callable equivalent of `/compact-then`.

Parameters:

```ts
compact_session({
  seed_prompt: string,
  summary_focus?: string,
  rewrite_seed?: boolean,
  ambiguity_mode?: "inherit" | "ask" | "cautious-proceed" | "always-proceed"
})
```

`seed_prompt` is required. It is both:

1. the brief used to steer compaction; and
2. the generated compaction handoff delivered after compaction.

When rewriting is enabled, the expanded seed replaces the raw seed for both purposes.

A successful `compact_session` call is a terminating tool action: Pi ends the current agent run without an extra LLM continuation, then the extension starts compaction from the `agent_settled` lifecycle boundary. After compaction, the extension sends the expanded seed automatically, so the user does not need to repeat the prompt. The agent should call `compact_session` as the only tool in its response because Pi only terminates a mixed tool batch when every result in that batch is terminating.

`/compact-then` follows the same no-reprompt handoff contract. As an extension command it waits for an idle boundary, compacts, and auto-sends its captured or generated seed.

### Prior-session search

Use `search_prior_sessions` when compacted-away or prior-session transcript text is needed. Set `include_current: true` to search the active session's compacted-away text; it defaults to `false` for cross-session recall. Use `session_compaction_history` when you need the current branch's compaction count or boundary identifiers. Project-scoped searches include sessions from same-repo Git worktrees by default.

The prompt's compaction projection contains only the current-branch count; compaction boundaries contain metadata, not summary text. Summaries are not retained by this mechanism. Use `search_prior_sessions` with `include_current: true` to retrieve earlier summaries or other compacted-away transcript text.

#### Recall tool-name migration

Call the bounded cache-and-session lookup tool as `session_recall`. It replaces the former `recall` call name. There is no `recall` alias because another plugin may own that name. Existing session history is not rewritten, so recorded calls keep their original text; new calls must use `session_recall`.

### Context cache management

The context cache stores curated, scoped reference documents that survive compaction and future sessions. By default, files live under `~/.pi/agent/context-cache/<sha256(scopePath).slice(0,32)>/`, where `scopePath` is the current Git worktree root. The `contextCache.scope` setting can select the session directory, repository common Git directory, or absolute current directory instead. Each pool has an `_manifest.json` tracking descriptions and metadata; unrelated worktrees do not share a pool.

Explicit context-cache artifact promotion is create-only: tracked, untracked, symlinked, and concurrently created destinations are refused rather than overwritten. Callers are responsible for choosing a fresh safe cache filename before retrying. The chosen filename may not be the reserved manifest name `_manifest.json` in any case variant. Promotion stages the complete document privately before atomically publishing it, so the final destination does not expose partial bytes. The cache is a UTF-8 text store: a source that is not valid UTF-8 is rejected before anything is staged or published rather than being decoded lossily, and valid UTF-8 (including a leading byte-order mark) is preserved byte-for-byte.

When compaction generates new cache artifacts, the raw hidden `<cache-plan>` is stripped from the stored summary and replaced with a visible `## Context Cache` section listing each generated artifact's full path, size, and description. Automatic system-prompt, seed-rewrite, seed-preamble, and compaction-notification listings show newest-updated files first, at most 12 entries by default, and one `…and N more` line when additional files exist. The full file contents stay in the cache files; they are not inlined into the summary.

On first use of a scope, a recoverable legacy `sessions/--<cwd-slug>--/context/` pool is merged into the new pool without deleting the source. The shared `sessions/forks/context/` pool is deliberately left untouched and reported once for manual recovery or removal.

Useful commands:

```text
/context-cache-list             # list cached files
/context-cache-inspect          # show cache dir, size, config, manifest/orphan status
/context-cache-view <file>      # render a cached file into the conversation
/context-cache-open <file>      # open a cached file in the Pi editor; saving updates it
/context-cache-delete <file>    # delete one cached file
/context-cache-ttl <7d|168h>    # view or adjust TTL before stale-file cleanup
/context-cache-gc               # run stale/size/orphan cleanup
/context-cache-clear            # clear manifest-tracked files
/context-cache-purge [--yes]    # remove the entire cache directory, including orphans
```

`clear` removes files tracked by the manifest and leaves an empty manifest. `purge` removes the whole cache directory, including orphan files and `_manifest.json`.

The default context cache TTL is **7 days** (`168` hours). Files older than the TTL are pruned by automatic cleanup and `/context-cache-gc`. Adjust it persistently with:

```text
/context-cache-ttl 14d
/context-cache-ttl 336h
/context-cache-ttl status
```

### Status commands

Inspect current state with:

```text
/context-aware-mode status
/context-aware-seed-rewrite status
/context-aware-ambiguity status
/context-aware-model status
/context-aware-overflow-fallback status
/context-aware-proactive status
/context-status
```

`/context-status` also reports context usage, available headroom, and the automatic-compaction owner resolved at startup.

## Configuration

### Where settings come from

Settings resolve through six layers. Later layers win:

```text
built-in defaults
  → global      ~/.pi/agent/context-aware.json
  → project     <project>/.pi/context-aware.json
  → CLI flags   --context-aware-*
  → session     an override recorded in the session
  → host policy declared by whoever created the session   ← wins
```

The project file uses the same shape as the global one, so anything documented
below can be set per repository and checked in. It is a separate file from Pi's
own `.pi/settings.json`, so a malformed value here cannot damage Pi's settings.

The last two layers are carried in the session record itself, which is how a
process that creates a session — pi-delegate creating a worker, for example —
declares how that session must behave. Host policy beats a command-line flag on
purpose: a worker must not be knocked off its declared behaviour by a flag it
inherited from its parent process.

### `sessionRole`

`"foreground"` — default — or `"worker"`. A creating process sets it to say what
kind of session this is, and the behaviour follows from that one value rather
than from a set of switches that could be set to contradict each other.

A session with the **worker** role belongs to a delegated run: it has no user,
and its task belongs to the supervisor driving it. Under that role, this
extension:

- does not send the expanded seed back into the session as a new message, because
  the next prompt belongs to the supervisor;
- does not rewrite the task with a model, because the supervisor holds the brief
  verbatim and never compacts — a rewrite would replace the agreed task with a
  paraphrase nobody approved;
- does not inject the context-cache listing anywhere, because nothing in a
  worker session can read it or act on its commands;
- does not compact in the middle of a reply—including proactive output-limit recovery—deferring to the round boundary.

That deferral uses the session-record channel
`context-aware.worker-compaction.v1`. When a worker crosses the proactive
threshold, loses safe generation reserve, or stops on `length`, context-aware
appends an `advised` or `required` custom entry during the turn. It never aborts
the reply. The worker host reads the entry only after harvesting the reply and
may compact at the round boundary using the entry's static summary
instructions. A completed worker compaction appends `satisfied` with the
revision it discharged. Repeated same-state observations are coalesced until
usage has increased by at least one percentage point. Foreground sessions never
write this channel.

This channel is deliberately separate from the process-local `pi.events`
service. The session record survives detached workers and does not require the
worker and its host to share an event-bus instance. Advisory instructions are
bounded to 4,000 characters and each JSON payload is bounded to 8,192 bytes.

It keeps one thing: the `Prior transcript:` line. Worker sessions are file-backed
and discoverable, so that reference is genuinely useful to a worker session.

Instead of an auto-sent prompt, a compacted worker records a bounded compaction
receipt in its session, which the host can hand to the supervisor.

With no role declared, a session is `foreground` and behaves exactly as it did
before roles existed.

**Merging is per key, never per object.** A project file that sets only
`contextCache.scope` overrides only that key; every sibling key still comes from
whichever lower layer supplied it. A value that fails validation is skipped, so
the next layer down supplies it rather than the setting jumping to its default.

Run `/context-status layers` to see which layer supplied each value, including
values that were read and then overruled:

```text
contextCache.scope    worktree   (host policy: pi-delegate/worker)  [overruled: global=repo]
seedRewrite           on         (global: ~/.pi/agent/context-aware.json)
compactionModel       (active)   (default)
```

### `sessionNaming`

Automatic session naming (issue #86). After every turn, a one-shot call to the
first available lightweight model either names the session or defers. The
default model chain never contains a premium model, and the session's active
model is never used.

- **Names** use a semi-templated grammar: `open-mr(owner/repo#23)`,
  `code-review(owner/repo!43)`, `planning(feature-slug)`, `overseer(owner/repo)`,
  `research(topic-slug)`. Slugs are lowercase-hyphen. A malformed answer gets
  one repair retry, then a free-form fallback capped at `maxNameLength`.
- **Template names are final.** Free-form names are provisional: revised after
  each compaction and every `reviseEveryTurns` turns, at most `maxRevisions`
  times.
- **User-set names win permanently.** `--name`, `/name`, RPC renames, and fork
  inheritance freeze a session against every future auto-name or revision.
- **Bounded cost:** at most `attempts` naming calls up front plus
  `maxRevisions` revisions. If no model in the chain is available, the session
  stays unnamed and the failure is only logged.

`scope: "off"` disables naming entirely. `"interactive"` names only
foreground sessions — worker sessions are excluded.

### Config file

```text
~/.pi/agent/context-aware.json
```

Default shape:

```json
{
  "seedMode": "auto-gen",
  "compactionModel": null,
  "overflowFallbackModel": null,
  "seedRewrite": true,
  "ambiguityMode": "inherit",
  "seedAuthorityGuard": "warn",
  "summarizer": {
    "enabled": true
  },
  "proactiveCompaction": {
    "enabled": true,
    "thresholdFraction": 0.78,
    "outputReserveTokens": 16384
  },
  "contextCache": {
    "enabled": true,
    "maxTotalSizeMB": 5,
    "staleHours": 168,
    "scope": "worktree",
    "maxListedFiles": 12
  },
  "restartNotice": {
    "enabled": true,
    "minAwayMs": 60000
  },
  "workstream": {
    "enabled": true,
    "registryEnabled": true,
    "activityEnabled": true,
    "cmuxEnabled": true,
    "activityToCmux": false
  },
  "sessionNaming": {
    "scope": "all",
    "attempts": 3,
    "reviseEveryTurns": 10,
    "maxRevisions": 2,
    "models": ["z-ai/glm-5.3-flash", "gpt-5.6-luna"],
    "maxNameLength": 40,
    "contextChars": 12000
  }
}
```

Configuration can be changed persistently with the slash commands below or by editing the JSON file. Existing configuration files may omit `workstream`; omitted fields use the defaults above, so sessions without prior workstream entries migrate without a rewrite.

The durable workstream switches are intentionally conservative: authority, registry, and activity integration are enabled by default; cmux is capability-gated and activity logging to cmux remains opt-in. Registry files are private projections under `~/.pi/agent/session-registry/v1/`; transcript custom entries remain authoritative. This package validates launcher metadata and delegates optional jumps, but does not route intercom messages, create/select/clean up worktrees, launch terminals, or construct terminal commands.

You can also provide one-off runtime overrides through extension CLI flags. CLI overrides are **ephemeral**: they affect the current Pi process but do not rewrite `~/.pi/agent/context-aware.json`.

```bash
pi \
  --context-aware-mode autonomous \
  --context-aware-seed-rewrite on \
  --context-aware-ambiguity always-proceed \
  --context-aware-model google/gemini-2.5-flash \
  --context-aware-overflow-fallback anthropic/claude-sonnet-4-6
```

Available CLI flags:

```text
--context-aware-mode <auto-gen|user-approve|autonomous>
--context-aware-seed-rewrite <on|off>
--context-aware-ambiguity <inherit|ask|cautious-proceed|always-proceed>
--context-aware-model <provider/id|none>
--context-aware-overflow-fallback <provider/id|none>
--context-aware-proactive <on|off|threshold|reserve=tokens>
```

If CLI overrides are active, status commands include a `Runtime CLI overrides:` line.

Pi applies extension flag values after loading extension factories. Context-aware reads them again at `session_start`, so `--context-aware-proactive` works both for an installed package and for an explicit `pi -e /path/to/index.ts` load. The CLI values then participate in the six-layer order above; a session override or host policy can intentionally overrule them.

`/context-aware-proactive status`, `/context-status`, and the typed context service use the same resolved proactive values. Each value reports its exact winning layer: `default`, `global`, `project`, `cli`, `session`, or `host`. The summary source is `mixed` when the three values come from different layers. Invalid overrides are ignored with a visible warning and a diagnostic in the typed snapshot. If a Pi release does not expose a requested extension flag by `session_start`, context-aware warns instead of silently claiming that the override applied.

## `seedMode`

Controls how `/compact-then` behaves when it needs a seed prompt.

Values:

```ts
"auto-gen" | "user-approve"
```

### `"auto-gen"` — default

When `/compact-then` is run without a seed:

1. generate a raw seed;
2. rewrite it;
3. compact without asking.

Use this when you want smoother handoffs with less interruption.

### `"user-approve"`

When `/compact-then` is run without a seed:

1. generate a raw next-phase seed from the conversation;
2. rewrite it into a self-contained prompt;
3. open an editor for approval/edit;
4. compact only after approval.

With seed rewriting enabled, `user-approve` opens the approval editor after rewrite even for explicit seeds.

Use this when you want safety and the chance to edit the exact handoff prompt.

### Commands

```text
/context-aware-mode user-approve
/context-aware-mode auto-gen
/context-aware-mode autonomous
/context-aware-mode status
```

## `seedAuthorityGuard`

Controls what a refused compaction handoff or automatic task continuation costs.

Before a generated handoff or task-continuation reminder is used, a
deterministic check—a fixed-rule check rather than another model
judgement—compares it with the authority already in the session.

Every `compact_session` seed is a generated handoff, because the agent writes
it as a tool argument. A seed typed into `/compact-then` is not: it is a literal
user message and keeps user authority. When the approval editor is shown, the
exact approved bytes are re-evaluated as an explicit raw seed before persistence;
pre-approval generated text does not receive that attribution.

### Authority baseline

The guard treats these sources as authority:

- literal user messages, excluding follow-ups previously generated by this
  extension;
- the durable workstream objective, when one exists; and
- the current working directory as the repository identity.

Excluding generated follow-ups prevents repeated compactions from turning
model-written text into user authority. Accepted generated provenance carries a
copy of the last grounded side-effect surface with its original source; later
compactions may inherit that copy, but generated text cannot replace it.
User-authoritative extension-delivery markers likewise carry the validated
surface for an explicit raw seed, so a later compaction does not relabel it as
literal or generated text. Legacy provenance and delivery markers without the
additive surface remain readable and contribute no new authority. The
context-cache listing is supplied separately as reference material. It may
support an objective that an authority source already names,
but it cannot create or broaden one.

### Blocking and advisory findings

One candidate can report more than one finding. `reasons` contains only blocking
findings. `advisories` contains telemetry-only findings that do not substitute a
fallback:

| Finding | Disposition |
| --- | --- |
| `cache-origin` | Blocking. The candidate declares cache reference material as its origin. Normal generated and explicit-seed flows do not use this origin, but the guard rejects it defensively. |
| `cache-material-originated-term` | Advisory. A whole cache artifact filename is retained as a passive reference and excluded from authority-bearing objective, project, deliverable, constraint, and permission data. |
| `project-switch` | Blocking for generated handoffs when a canonical GitLab reference or repository-root path names an ungrounded project. Advisory for explicit seeds, whose exact raw or resolved prompt-template text remains operative. |
| `objective-switch` | Blocking. The candidate both introduces new objective terms and explicitly says to switch, replace, abandon, or start a different task, objective, project, repository, deliverable, or focus. |
| `side-effect-authority-change` | Blocking for generated handoffs. An explicit generated claim added, removed, strengthened, weakened, or misattributed local-edit, local-commit, remote-Git-write, provider-metadata-write, or named-target authority. |
| `mutation-authority-escalation` | Advisory. The legacy lexical permission snapshot remains telemetry only; it does not refuse a handoff. |

`repository-switch` was removed because the normal call path had no independent
candidate repository target. Candidate and baseline repository values both came
from the foreground working directory, so the finding could never fire.

The blocking side-effect surface keeps five dimensions separate: local edits,
local commits, remote Git writes such as a push, provider metadata writes, and
a named merge-request target. Each explicit claim is `allowed`, `forbidden`, or
`unstated`, and a stated claim retains its grounded source (`literal-user`,
`explicit-raw-seed`, or `durable-objective`). Named targets retain the target
kind, optional canonical project, and identifier, so authority for one merge
request cannot silently become authority for another.

A generated candidate inherits every dimension it does not state. Repeating a
grounded claim also retains the grounded source rather than relabelling the
claim as generated. Any explicit generated delta—an addition, removal,
strengthening, weakening, target change, or source misattribution—is refused.
A literal user instruction or explicit raw seed remains authority and may state
or change a claim. Ordinary sequencing such as "finish tests, then update the
documentation" is continuity, not side-effect authority, and inherits the
surface without creating a restriction.

The side-effect parser deliberately recognizes a narrow audited vocabulary:
explicit source-edit, commit, push, provider-metadata, and merge-request-target
directives, including forms such as `do not push`, `do not alter GitLab
metadata`, and `do not touch MR !2507`. It does not broaden the general English
objective parser or guess authority from unrelated prose.

The legacy mutation authority—the coarse permission level for changing code or
files—is still ordered as follows:

```text
unspecified < read-only/analysis/design < implement < write
```

That legacy value remains in snapshots for compatibility and telemetry. Its
comparison does not refuse or replace a seed because broad lexical permission
matching has known false positives and misses material side effects. Its ceiling
follows the most recent instruction that stated one. Instructions are read as
blocks separated by a blank line, and the last block that states a permission
wins, so "review this without modifying source code" does not outlive a later
"now implement it". Within one block a prohibition still wins.

The guard uses fixed text rules. For example, project detection requires a
reference: a canonical GitLab reference such as `acme/widgets#1375`, or an
absolute repository-root path such as `/srv/repos/acme/widgets`. A naming
phrase in prose is not evidence. A path names a repository only at that
repository's root, so the guard finds the root rather than reading the path's
spelling: it walks from the path up through its ancestors and takes the first one
the host confirms is a checkout root, which is a directory holding `.git`. A Git
worktree resolves to the repository that owns it, so
`<repo>/.worktrees/<branch>` is `<repo>` and never a project called `<branch>`.
One repository is therefore named the same way however deep the path goes:
`<root>`, `<root>/tests`, and `<root>/src/exporter.ts` all name it, and a path
under no root — an unrelated directory, a shared parent of several checkouts, or
a URL — names no project at all. When the checkout has a canonical GitLab remote,
the guard uses it to match the path with the same namespace/project reference;
`acme/widgets#1375` does not ground `other/widgets#1375`. Text alone cannot
settle this because checkouts on one machine sit at different depths, so the host supplies the lookup and a
lookup that fails answers "not a root": a broken probe can lose a project name
but never invent one. A canonical path form removes terminal sentence punctuation
and separators. A project is identified only by a reference, never by prose.
Two forms qualify: a canonical GitLab reference such as `acme/widgets#1375`, and
an absolute path the host resolves to a repository root. Both point at something
that exists, so neither can be misread.

Prose is not read at all. Six review rounds narrowed a prose parser and never
made it correct, because English does not separate naming from describing:
`project url` and `project metadata` describe attributes, `the project is ready`
and `the project at hand` are descriptions, and even the delimiter and naming-verb
forms failed both ways — `Project: ready for review.` was read as a project named
`ready`, `the project called the deployment API` as one named `the`, while a real
switch phrased `the project is named frobnicator` was missed entirely. Every
narrowing traded one direction for the other.

The cost is stated plainly and pinned by tests: a switch stated only in words is
not detected here, in any phrasing and for any keyword. It is not undefended: the cache-origin and objective-switch checks still apply,
and mutation-authority differences remain visible in telemetry.
Refusing an honest handoff is the worse error, because it discards the user's own
continuation, which is the failure this guard exists to prevent; over the
recorded sessions the guard evaluated 1,286 handoffs and refused 296 as project
switches, so that cost is paid roughly one turn in four.

The guard checks every reference in a candidate, so an incidental one cannot hide
a later project switch. A candidate project is allowed only when an authority
reference or repository-root path already identifies it, or it is the session's
own repository; ordinary authority vocabulary is not grounding evidence.
Objective-switch detection requires explicit switch language plus new
terms. It does not reject a candidate merely because it contains ordinary
deliverable words such as `changes` or `tests`. The former
`deliverable-not-grounded` check was removed because those words caused false
refusals.

Values:

```ts
"enforce" | "warn" | "off"
```

### `warn` — default

For compaction, a generated refusal is reported and replaced with current
durable workstream state plus the current task snapshot when available. The
rejected generated side-effect claim is never copied into the operative fallback.
Without that state, a fixed neutral prompt resumes only from the current
compaction summary and asks for clarification if no authorized next step is
clear. Earlier onboarding prompts, earlier compaction prompts, and unrelated
workflows are never fallback sources. The compaction still happens.

For automatic task continuation, a refusal is reported but the turn still
happens. The rejected reminder is replaced with a fixed reconciliation prompt.
That prompt carries no rejected task title. It tells the agent that the task
list is extension state, not new user authority, and to continue only work
grounded in literal user instructions.
The bounded corrective turn keeps the same substitution while that task-list
revision remains unchanged.

### `enforce`

In an interactive flow, a refusal stops the compaction and asks you for an
approved seed. This gives the strongest protection against a drifted objective,
at the cost of a session that cannot compact until you answer. Non-interactive
proactive preparation cannot ask; it uses the same current-durable-state or
neutral summary fallback described under `warn` so the session does not cross
its context safety boundary.

A refused automatic task continuation is suppressed. No replacement turn is
sent.

### `off`

The check does not run. No refusal reason is produced. Compaction uses its
ordinary prompt, and automatic task continuation sends its ordinary reminder
without substitution.

As an interim mitigation for an older loaded runtime, set
`"seedAuthorityGuard": "off"` in `~/.pi/agent/context-aware.json`, preserving
all other keys. For one repository, use `<project>/.pi/context-aware.json`.
Configuration is re-read on each resolution, so no restart is required for the
setting. Run `/context-status layers` to confirm that a higher-precedence
session or host policy did not override it. `warn` still invokes the guard;
`off` is the only mode that skips it entirely.

Compaction refusal metadata retains bounded, credential-redacted candidate text,
separate grounded and candidate snapshots, exact redacted trigger values, and an
`authorityChanges` list. Each change names its dimension, optional named target,
grounded and candidate states, change kind, and original source attribution.
Metadata also records the fallback source and SHA-256 hash, delivery ID, and
loaded guard implementation version. `/context-status` reports the loaded
implementation version. Automatic task continuation records the same decision
identity and evidence in `details.authorityGuard`. Accepted generated-delivery
provenance retains the legacy `authority` snapshot and additively records the
grounded and candidate snapshots, authority changes, delivery ID, and guard
implementation version. Version-1 records that omit the additive fields remain
readable; missing fields mean legacy/unstated, never generated authority.

### Recovery after a failed compaction

The follow-up that resumes work after a compaction fails is never dropped, in
any mode. A literal user seed is re-sent as a user message. A refused generated
handoff uses its recorded current-durable-state or neutral summary fallback,
and the refusal is reported. It never selects an earlier prompt from session
history.

## `seedRewrite`

Controls whether raw seeds are rewritten before compaction.

Values:

```ts
true | false
```

### `true` — default

Raw seeds like:

```text
continue with item #3
do the next thing
finish this
```

are expanded into self-contained next-session prompts before compaction.

The expanded seed is then used for both:

1. steering the compaction summary;
2. the generated compaction handoff after compaction.

### `false`

Legacy behavior. The raw seed is used directly:

1. raw seed steers the summary;
2. raw seed is sent after compaction.

Use this if you want exact old behavior or are debugging the rewrite layer.

### Commands

```text
/context-aware-seed-rewrite on
/context-aware-seed-rewrite off
/context-aware-seed-rewrite status
```

## `ambiguityMode`

Controls what happens when seed rewriting cannot confidently resolve the raw seed.

Values:

```ts
"inherit" | "ask" | "cautious-proceed" | "always-proceed"
```

### `"inherit"` — default

Derives behavior from `seedMode`:

- if `seedMode = "user-approve"`, effective ambiguity mode is `ask`;
- if `seedMode = "auto-gen"`, effective ambiguity mode is `cautious-proceed`.

This is the safest default.

### `"ask"`

If the expander returns a clarification, stop before compacting and show a visible question.

Example ambiguous seed:

```text
continue with item #3
```

when there are multiple plausible item #3 lists.

Behavior:

- no compaction starts;
- clarification message is shown;
- user must provide a better/self-contained prompt or rerun.

Best for interactive work.

### `"cautious-proceed"`

Do not block. Instead, synthesize a cautious expanded prompt that includes the ambiguity.

The next-phase prompt tells the model to:

- inspect the compaction summary;
- use the `Prior transcript:` path if needed;
- resolve the ambiguity before irreversible work;
- choose the smallest reversible next step if still uncertain.

Best when you want mostly autonomous operation but still want the model to be cautious.

### `"always-proceed"`

Never block on ambiguity.

The handoff prompt explicitly says the session is configured for autonomous handoff and should proceed without asking, while making assumptions explicit.

Best for fully autonomous agents or unattended long runs.

### Commands

```text
/context-aware-ambiguity inherit
/context-aware-ambiguity ask
/context-aware-ambiguity cautious-proceed
/context-aware-ambiguity always-proceed
/context-aware-ambiguity status
```

## `compactionModel`

Controls which model is used for the full compaction summary, not seed rewriting.

Values:

```ts
"<provider>/<model-id>" | null
```

### `null` — default

Use Pi’s normal compaction behavior, based on the active conversation model.

### `"<provider>/<model-id>"`

Use a dedicated override model for compaction summarization.

Example:

```json
{
  "compactionModel": "google/gemini-2.5-flash"
}
```

Use this if you want compaction to be handled by a cheaper, faster, or larger-context model than the current active model.

Important distinction:

- production seed expansion deliberately disables reasoning, even though it uses the active conversation model, to protect the structured-output budget;
- the experimental live benchmark accepts an explicit `--thinking` level per selected model; `off` omits reasoning, and an unsupported model/level pair fails with a model-specific diagnostic rather than being clamped;
- compaction summary can use `compactionModel` if configured.

### Commands

```text
/context-aware-model google/gemini-2.5-flash
/context-aware-model none
/context-aware-model status
```

## `overflowFallbackModel`

Controls the optional cross-model fallback used only after a provider reports context overflow and the automatic reduced-payload retry also overflows.

Values:

```ts
"<provider>/<model-id>" | null
```

`null` is the default. Context-aware still retries once on the same model with a payload capped both by model metadata and to at most half of the provider-rejected dynamic prompt text, but it does not move conversation content to another provider or incur cross-model cost without an explicit choice.

When configured, the extension resolves the model and its auth lazily after both attempts on the primary model overflow. Registry-provided API keys, headers, environment, and valid ambient/keyless provider authentication are preserved. The fallback must differ from the primary model. Choose a model with a larger effective context window and compatible data-handling policy. Because that model may have a larger window, its final attempt can include more original context than the reduced same-model retry.

Recovery applies to runtime model calls owned by this extension: next-phase seed generation, seed rewriting, custom/default compaction summarization, and context-cache artifact generation. For split-turn default compaction, recovery retries the exact rejected history or turn-prefix summarization request rather than replaying an earlier successful request. It does not retry unrelated provider, auth, quota, network, rate-limit, cancellation, or output-length failures. Pi's provider-aware overflow classifier also recognizes silent input overflow where providers return a nominally successful or length-limited response.

The TUI shows a warning when payload reduction or model fallback begins; full errors and attempt details are also written to the context-aware debug log. Each retry is a separate provider request and may incur an additional charge. If compaction still overflows after all available attempts, context-aware cancels that compaction instead of handing the same oversized request back to Pi's built-in path, preserving the original session and showing a recovery hint rather than a raw provider failure.

### Commands

```text
/context-aware-overflow-fallback anthropic/claude-sonnet-4-6
/context-aware-overflow-fallback none
/context-aware-overflow-fallback status
```

## `summarizer`

Controls whether context-aware claims Pi's `session_before_compact` hook and returns a compaction summary.

```json
{
  "summarizer": {
    "enabled": true
  }
}
```

`enabled` defaults to `true`, preserving the existing summary, context-cache, transcript-reference, and workstream augmentation behavior. Set it to `false` when another extension owns summarization. In that mode context-aware does not claim unrelated threshold or manual compactions and never supplies a summary. If ownership changes after context-aware already initiated a proactive compaction, it may return `{ "cancel": true }` only to cancel that stale context-aware attempt and its generated handoff. Tasks, durable focus, telemetry, recall, and the other non-summary features remain available.

Context-aware's explicit handoff flows depend on its summary contract, so `compact_session` and `/compact-then` fail before starting compaction while summarization is deferred. The error tells you to set `summarizer.enabled` to `true` and retry. Use the other compactor's own handoff command while this switch is off.

This leaf participates in global, trusted-project, session-policy, and host-policy precedence. An untrusted project's `.pi/context-aware.json` cannot change summary ownership; its `summarizer.enabled` leaf is ignored until the project is trusted. There is no CLI flag or setter command for it; edit `~/.pi/agent/context-aware.json`, a trusted project `.pi/context-aware.json`, or a host/session policy entry.

## `proactiveCompaction`

Controls context-aware’s proactive compact+handoff loop.

Shape:

```json
{
  "proactiveCompaction": {
    "enabled": true,
    "thresholdFraction": 0.78,
    "outputReserveTokens": 16384,
    "preparationStallTimeoutMs": 30000,
    "preparationFirstOutputGraceMs": 90000,
    "commitDrainTimeoutMs": 10000
  }
}
```

When enabled, after each provider-completed assistant turn, context-aware:

1. reads current usage including trailing tool results;
2. computes a usable generation reserve as `min(outputReserveTokens, model.maxTokens) + 2,048 protocol-overhead tokens` (bounded by the context window);
3. triggers when either `thresholdFraction` is crossed or headroom is below that reserve;
4. records or coalesces the pending trigger, starts the cancellation drain, and returns from `turn_end` without a model wait;
5. waits for Pi's public `agent_settled` boundary and verifies `ctx.isIdle()` before launching background seed preparation;
6. generates a raw next-phase seed from the conversation and rewrites it into a self-contained prompt using non-blocking ambiguity handling; thinking/tool-call events count as liveness during `preparationFirstOutputGraceMs`, text output then uses `preparationStallTimeoutMs`, and the absolute preparation ceiling is five minutes;
7. runs compaction with that seed as summary guidance;
8. re-checks, at the moment the summary is ready to commit, that no agent run is in flight, ending one first if it is;
9. waits for Pi to drain input queued during compaction, then delivers the seed
   exactly once as a generated compaction handoff.

The check runs after normal, tool-use, length-limited, and error turns, but not after a user-aborted turn. This matters for internal tool loops: Pi can otherwise proceed directly from a large tool result to another provider request without reaching an outer user-message boundary. Generation-reserve and threshold triggers share the proactive-compaction cooldown, whose full duration restarts when compaction completes. This prevents an ineffective compaction from immediately re-arming the provider drain. The separate one-shot output-limit recovery carries explicit state from the discarded length-limited response into its turn completion, so it may cross the ordinary proactive cooldown once without restoring a general generation-reserve exemption.

Current Pi releases may enter one final provider-stream setup after a tool-loop abort. During that cancellation drain, context-aware temporarily exposes no tools and replaces the provider context with a single synthetic cancellation message, so the original transcript and tool result cannot reach a side-effect-capable follow-up. The transient response is discarded, the exact active-tool set is restored after settlement, and compaction then runs once. Discarding that response replaces its prose only: any tool call it carried is kept, because Pi applies the replacement in place on the message object that agent state and the running loop share, and a tool that is already executing still delivers a result that needs its tool call to be there. During session shutdown/reload, the sanitizer gets one bounded grace period to catch that drain before tools are restored; an abort-ignoring provider cannot hold shutdown open. Shutdown, reload, resume, fork, and session replacement abort pending preparation and invalidate its runtime owner; queued/running callbacks from that owner cannot send a handoff or update stale UI in the new session.

### Committing only against a quiet session

Generating a summary takes minutes, and idleness at queue time does not survive that wait: a message arriving inside the window starts a new agent run. Pi applies a compaction by replacing `agent.state.messages`, and a running agent loop reads a copy of that array taken when the run started, so a commit landing mid-run reduces nothing while the transcript records a boundary the live context never crossed (issue #55).

Liveness is therefore re-checked when the summary is ready to commit, not only when the work was queued:

- **No run in flight.** The prepared boundary is returned unchanged and nothing is aborted. This includes Pi's own automatic compaction after a run has ended, where the session still reports itself busy but no loop holds the array.
- **A run in flight.** The run is ended through the same provider drain the trigger path uses, and the commit waits up to `commitDrainTimeoutMs` for that run to finish before applying the boundary.
- **A run that outlives the budget.** The compaction is refused: Pi records no compaction entry, the extension reports it as unapplied rather than completed, the generated summary is retained so a retry on the same branch does not pay for it twice, and the work is queued again for the next idle boundary. A compaction refused twice in a row is abandoned with an error instead of looping through another summary.

Verify a real reduction the way the issue's evidence was gathered: on the assistant messages either side of a compaction entry, a boundary that landed shows `cacheRead` dropping to `0` with a large `cacheWrite` (a rebuilt prefix), while a boundary that changed nothing shows `cacheRead` continuing with a small incremental `cacheWrite`.

`commitDrainTimeoutMs` defaults to `10000` (10 seconds); ending a run is signal-based and normally unwinds in milliseconds. Raise it for sessions whose tool calls take longer to unwind, or set `0` to never wait and always re-queue instead.

`outputReserveTokens` defaults to `16384` and is configurable independently of the percentage threshold. `preparationStallTimeoutMs` defaults to `30000` (30 seconds) after text output begins. `preparationFirstOutputGraceMs` defaults to `90000` (90 seconds) so reasoning models can think before their first text token. Both values are resolved through the normal configuration layers and appear with provenance in `/context-status` and the typed service snapshot. The absolute five-minute ceiling bounds total preparation even while thinking or text events continue. It is an intended generation allowance, not a promise that every response will use that many tokens. Models advertising a smaller maximum output automatically use the smaller limit; models advertising a larger maximum still use the configured allowance unless you raise it.

### Commands

```text
/context-aware-proactive status
/context-aware-proactive on
/context-aware-proactive off
/context-aware-proactive 78%
/context-aware-proactive 0.8
/context-aware-proactive reserve 16384
/context-aware-proactive reserve=32k
/context-aware-proactive stall 30s
/context-aware-proactive first-output 90s
/context-aware-proactive commit-drain 10s
```

Thresholds accept either fractions (`0.78`) or percentages (`78`, `78%`). Valid range is 25%–95%. Reserve values accept exact tokens or `k`/`m` suffixes. Stall, first-output and commit-drain values accept milliseconds, seconds, or minutes (for example, `stall 30s`, `first-output 90s` and `commit-drain 10s`); only commit-drain accepts `0`, meaning never wait for an in-flight run. The equivalent ephemeral CLI override is `--context-aware-proactive reserve=32k`.

The status output includes the effective values, their sources, and the current proactive lifecycle (`idle`, `pending`, `generating`, `queued`, `compacting`, `cooldown`, `failed`, or `cancelled`). It also shows the most recent proactive failure while a static fallback or cooldown remains active. A CLI threshold sets only `enabled` and `thresholdFraction`; a CLI reserve sets only `outputReserveTokens`. Unnamed values continue to come from their own winning layers, so the summary source can be `mixed`. Run `/context-status layers` for the full six-layer attribution.

## `contextCache`

Controls the curated project context cache.

Shape:

```json
{
  "contextCache": {
    "enabled": true,
    "maxTotalSizeMB": 5,
    "staleHours": 168,
    "scope": "worktree",
    "maxListedFiles": 12
  }
}
```

### `enabled`

When `true`, cached files are surfaced to future sessions and compaction handoffs. Set to `false` to disable context cache surfacing and automatic cache-plan processing.

### `maxTotalSizeMB`

Maximum total cache size before cleanup prunes oldest files. Default: `5` MB.

### `staleHours`

TTL used by cleanup. Files not updated within this many hours are considered stale and can be pruned. Default: `168` hours, i.e. **7 days**.

### `scope`

Selects the cache pool key: `session`, `worktree` (default), `repo`, or
`directory`. Git worktree and repository scopes use Git resolution from the
current cwd; a non-Git cwd falls back to directory scope. Scopes do not read
through to one another.

### `maxListedFiles`

Maximum number of cache documents rendered by automatic prompt, seed, and
notification listings. Newest-updated entries are retained and the remainder
is summarized with a bounded count. Default: `12`.

### Commands

```text
/context-cache-ttl status
/context-cache-ttl 7d
/context-cache-ttl 168h
/context-cache-inspect
/context-cache-gc
```

## Session task list

A session given six tasks used to finish task one, drift, and report success while five were never attempted — because the only record of "six tasks" was transcript text that summarisation later threw away.

The task list fixes that the way focus fixes a single objective: every change is written to the transcript as a full snapshot, the list is rebuilt by replay, and the current list is rendered into the prompt on every turn. Nothing depends on an earlier message surviving compaction.

### Statuses

`pending`, `active`, `done`, `blocked`, `deferred`. `blocked` and `deferred` both need a written reason.

They read alike but answer different questions, and both questions are answered mechanically rather than from prose:

- everything `done` or `deferred` means the list **is finished**;
- anything `blocked` means the list **is stuck** and something has to escalate.

### Structure

Sub-tasks go exactly one level deep. A parent's status is **derived** from its children and cannot be set:

- any child blocked → parent blocked;
- else any child active → parent active;
- else all children done or deferred → parent done;
- else pending.

Derivation is what stops a parent claiming `done` while three children sit pending. Deeper nesting with settable parents is a work graph, and pi-work owns that.

Ordering is the list's own order. There are no dependency edges: `add` takes `after`/`before`, `reorder` takes the full sequence, and "blocked until t3 lands" belongs in the note as prose.

### Opaque task references

A task may carry an optional `ref` value. It is opaque data: context-aware carries and displays it but does not interpret its meaning, reconcile by it, or require it to be unique. A `ref` must be a non-empty value of at most 32 characters matching `^[A-Za-z0-9][A-Za-z0-9._-]*$`. Task IDs remain separate from refs, including owner-side and worker-local delegation IDs.

Structured task snapshots and version-1 seeds preserve valid refs, and delegated task rows expose them to consumers. Aggregate progress events remain aggregate-only and never include a ref. Markdown export and seed degradation retain the existing checklist syntax and intentionally omit refs rather than inventing provider-specific metadata.

Changing a ref is a task edit. Agent-origin tasks may be edited by the agent; user- and spec-origin tasks retain their origin lock, while the user can still change them.

### Who may change what

`origin` decides. It mirrors the pinned-objective rule focus already has: an agent may report progress on work it was given, but may not quietly rewrite or delete it.

| origin | agent may retitle or remove | agent may change status |
|---|---|---|
| `user` (you typed it) | no | yes |
| `spec` (seeded by a dispatch) | no | yes |
| `agent` | yes | yes |

### The tool

`session_tasks` takes batched actions, because a model laying out six tasks should not spend six tool calls. When pi-fabric makes registered extension tools callable only through its active `fabric_exec` tool, the injected task and focus guidance uses the reachable forms `extensions.session_tasks(...)` and `extensions.session_focus(...)`. Context-aware accepts that path only when Pi attributes `fabric_exec` to the `pi-fabric` package and, when `PI_FABRIC_TOOL_ALLOWLIST` is set, the requested extension tool appears in its valid JSON string array; a malformed allowlist fails closed. Without either the native active tool or that authorized pi-fabric executor path, context-aware omits tool-call guidance and automatic task continuation remains unavailable.

| action | what it does |
|---|---|
| `plan` | replaces the whole list; accepts tasks with `title`, optional `status`, `note`, `ref`, and one level of `subtasks`; the normal way to start |
| `add` | one task with optional `ref`, optionally under a `parent` or `after`/`before` a sibling |
| `update` | takes an **array** of `{id, status?, title?, note?, ref?}` |
| `remove` | agent-origin tasks only |
| `reorder` | the full id sequence |
| `list` | rarely needed; the list is in the prompt already |

### Commands

```
/tasks                      show the list
/tasks add <title>          appends, origin=user
/tasks done <id>
/tasks block <id> <reason>
/tasks defer <id> <reason>
/tasks reopen <id>          clears a reason that no longer applies
/tasks clear
/tasks export [path]        markdown checklist; prints when no path is given
/tasks import <path>        replaces the list from a markdown checklist
/tasks on|off
```

### Where it shows

The focus widget grows a second line rather than a second widget appearing, because the above-editor budget is two lines per feature and focus had already spent it:

```
🎯 Ship the task-list feature · active
☑ 3/7 · ▸ wire the replay projection · ⚠ 1 blocked
```

The second line appears only when a list exists.

### Automatic continuation

At Pi's `agent_settled` boundary, a foreground session with `pending` or `active` work may receive up to two extension-generated turns for the current task-list revision. The first asks the agent to reconcile completed work, record each status change with `session_tasks`, and continue. If the agent settles without changing the list, one final corrective turn tells the agent—not the user—to update the list, keep working, or mark the task blocked and ask one precise question. A further unchanged settle stops quietly and records only a debug diagnostic. Finished and blocked-only lists stay silent. New user input resets the bound.

Worker sessions never self-prompt; their supervisor owns the next instruction. The continuation is stored as extension-generated state with machine-readable provenance, not as user-authored text.

`seedAuthorityGuard` applies before each generated turn. Its default `warn`
mode replaces a refused reminder with the fixed, title-free reconciliation
prompt described above, so a conservative fixed-rule classification cannot
leave an authorized workflow idle. `enforce` suppresses the turn. `off` sends
the ordinary reminder without running the check.

Before either turn, context-aware gives queued user input priority and checks whether the session is waiting on a running `pi-delegate` worker. Busy work suppresses the turn without consuming it, so the same stage remains available after that work finishes. An unreadable or unowned delegate signal fails closed and reports the reason once rather than starting a competing agent turn. Pending `pi-callbacks` jobs are deliberately not treated as busy because recurring polls and far-future reminders would suppress continuation indefinitely.

An aborted turn stops automatic continuation until the user speaks again, not merely for the settle that follows it. Pressing Esc means stop, so a single-settle suppression would let the next settle restart the work the user just interrupted. The abort is read from the session branch on each settle rather than held in a flag, because Pi resumes a session by more paths than the `input` event covers — `AgentSession.steer()` and `followUp()`, and the RPC `steer` and `follow_up` commands, queue a user message directly without emitting it — and a flag missed by one of them would leave continuation silently disabled for the rest of the session. What lifts the suppression is the user, not merely a later turn: a follow-up the extension had already queued when Esc was pressed can still run, so the scan starts at the abort and looks for a literal user message after it. Extension deliveries are separated structurally rather than by their text. A `pi.sendMessage` delivery persists as a `custom_message` entry, so only a plain `message` entry can be the user at all. `pi.sendUserMessage` is the harder case, because it produces a message shaped exactly like typed input: the check-in, the compaction seed, the two compaction recovery paths, and interrupted-prompt recovery all use it. Each records a `context-aware.extension-delivery.v1` marker immediately before sending, and each marker claims exactly one following user message, in order — so a marker can never disqualify a later message the user did write. Seed provenance recorded after the abort is kept as a fallback, for a host without `appendEntry` and for a delivery whose marker was lost; scoping it to that window stops a user message repeating an earlier seed's wording from being mistaken for a replay of it. A delivery that records no marker and has no provenance resumes continuation one turn early, which is the recoverable direction; discarding a real user message would leave the session silently stopped, which is the failure this exists to prevent. Suppression consumes neither bounded stage, so both the continuation and the corrective turn remain available for that revision. A session whose branch cannot be read reports an unanswered abort, matching the fail-closed treatment of the idle predicate and the delegate busy probe on the same handler.

### Talking to pi-delegate

Neither package imports the other. context-aware publishes a versioned wire contract; pi-delegate accepts the caller-facing `checklist` field on supervised slots, direct calls and slots, and detached `orchestrate`. `tasks` remains the selector for parallel-direct dispatch, so it is not reused for the checklist field.

Supervised and direct in-process workers can receive a durable pre-turn seed when the loaded worker runtime owns `session_tasks`. If no runtime claimant exists, the checklist degrades to markdown appended to the worker's task text instead; the seeded and markdown paths are mutually exclusive. Detached `orchestrate` always uses markdown because the local foreground process does not own the detached driver's worker `SessionManager`.

Inline sequential and parallel chain-step schemas deliberately do not expose `checklist`; this documents only that shipped schema boundary and makes no broader chain claim.

The contract is built to survive being wrong: unknown and newer fields are ignored rather than rejected, one malformed task cannot discard a dispatched plan, and a status sent without its required reason is downgraded rather than refused. The seed payload and the progress payload are versioned separately so each side can move on its own.

For a durable seeded checklist, progress travels at `fields.tasks` on an ordinary `updated` bus event. This retains the existing event validator and latest-`updated` bounded coalescing. The existing status row shows bounded checklist counts (`{done, total, active, blocked}`), and the final `taskLedger` exposes a mechanical `complete` / `gap` / `stuck` outcome, counts, and unfinished entries. Markdown-only degradation still shows the plan, but does not itself guarantee structured progress or a `taskLedger`.

Task state remains an agent claim, not acceptance evidence: a checked or `done` task, and the mechanical ledger outcome, do not prove that acceptance criteria passed.

### What it is not

The list is not a tracker. Owner, estimates, timestamps, priority, tags and percent-complete are all deliberately absent: each one is a request that will arrive, and each one turns a checklist into something else.

It is also not the authority on whether work is really done. A task marked `done` is a claim by an agent, not evidence.

## Session restart notice

When Pi restarts or switches sessions, context-aware classifies the session history and keeps a pending hidden telemetry notice when entries exist. At the first agent turn, it measures the away gap and sends the notice when it meets `restartNotice.minAwayMs`. The notice asks the agent to re-check volatile state such as background jobs, dev servers, tmux sessions, and shell state. Set `restartNotice.enabled` to `false` or adjust `restartNotice.minAwayMs` to change this behavior.

## Development

Install pinned development dependencies from the lockfile:

```bash
cd ~/src/pi-context-aware
npm ci
```

Run `npm ci` again in each Git worktree you check the repository out into.
Node's own module resolution walks up to the parent checkout, so `tsc` and
`eslint` run there without it, but `tests/compaction-tool-result-budget.test.mjs`
loads Pi from `process.cwd()/node_modules` and fails with `ERR_MODULE_NOT_FOUND`
until the worktree has its own install.

Run the full deterministic quality matrix:

```bash
npm run check
```

This runs:

- `npm run build` first — emits the production JavaScript and declarations under `dist/`, before any check consumes the package exports.
- `npm run pi:check` — verifies matching exact Pi development pins, matching tested peer bounds, lockfile resolutions, and the Node floor.
- `npm run typecheck` — strict TypeScript over the extension sources.
- `npm run lint` — flat ESLint config for TypeScript and benchmark `.mjs` files.
- `npm run coverage` — compiles tests into `.test-dist`, runs Node's built-in test runner under `c8`, writes text, lcov, and Cobertura reports, and validates the Cobertura XML.
- `npm run exports:check` — resolves the published `@centerforagenticai/pi-context-aware/context-service` export and imports it with plain Node, then verifies its protocol-v1 entry points.
- `npm run pack:check` — installs every peer at the exact matching `devDependencies` version in an isolated consumer, checks the dist-only tarball assertions, imports the resolved root export with plain Node, and retains the Pi loader smoke.

Individual commands are also available:

```bash
npm run build
npm run prepare
npm run pi:check
npm run typecheck
npm run lint
npm test
npm run coverage
npm run exports:check
npm run pack:check
```

Run the complete suite in an isolated install at each edge of the declared Pi range with:

```bash
npm run pi:compat -- --endpoint minimum
npm run pi:compat -- --endpoint current
```

Both compatibility endpoints resolve to the one supported version, Pi 0.84.2.
The CI matrix runs only the current endpoint because the minimum endpoint would
install the identical manifest at a duplicate cost. The compatibility helper
still accepts and validates both endpoint names for local checks.

### Coverage and CI artifacts

Tests compile to `.test-dist`, but `tsconfig.test.json` emits source maps with inline source content and `c8` is configured with `exclude-after-remap`. Coverage reports therefore use source filenames such as `context-telemetry.ts`, `seed-expansion.ts`, `overflow-recovery.ts`, `context-cache.ts`, `context-service.ts`, and `index.ts` rather than generated `.test-dist/*.js` paths. The generated report set includes terminal text, `coverage/lcov.info`, and `coverage/cobertura-coverage.xml`.

Configured c8 repo floors are intentionally measured close to the current deterministic suite and include `index.ts` so the report remains source-inclusive:

- lines: **43%**
- statements: **43%**
- functions: **39%**
- branches: **65%**

`npm run coverage:verify` additionally validates that `coverage/cobertura-coverage.xml` is a Cobertura report suitable for GitLab and enforces higher floors for the currently testable helper modules:

- `context-service.ts`: at least **90%** line coverage and **72%** branch coverage.
- `context-telemetry.ts`: at least **94%** line coverage and **86%** branch coverage.
- `seed-expansion.ts`: at least **95%** line coverage and **85%** branch coverage.
- `overflow-recovery.ts`: at least **95%** line coverage and **80%** branch coverage.
- `context-cache.ts`: at least **95%** line coverage and **85%** branch coverage.
- `history-integrity.ts`: at least **95%** line coverage and **85%** branch coverage.
- `index.ts`: at least **33%** line coverage and **33%** branch coverage from the registration/lifecycle harness, preventing regression to an entirely untested extension entry point.

`npm run build` emits the production JavaScript and declaration pairs under `dist/`; `npm run prepare` runs that same build for install and pack lifecycle hooks. `npm run exports:check` verifies that the documented `@centerforagenticai/pi-context-aware/context-service` package subpath resolves and exposes protocol v1 through plain Node. `npm run pack:check` packs the release payload, installs every peer at its exact tested development version in an isolated consumer, asserts that only `dist/`, the two shipped documents, and the npm-added manifest are present, imports the resolved root export with plain Node, and loads that same dist entry through Pi's real extension loader. It also rejects repository-only paths such as tests, coverage, scripts, and `.graft`.

Both `npm run pack:check` and `npm run pi:compat` unpack a complete throwaway consumer install into a temporary directory. They resolve that directory from `TMPDIR` when it names an existing writable directory, and fall back to the platform default otherwise. On a host where `/tmp` is `tmpfs`, that install competes with memory and can fail with `ENOSPC`, which reads as a packaging or test fault rather than an environment one — export `TMPDIR` to disk-backed storage before running the gate:

```bash
export TMPDIR=/var/tmp
npm run check
```

Point `TMPDIR` at a directory that holds nothing else. The legacy context-cache migration guard inspects sibling directories in the temporary root, so a shared scratch directory can make `tests/cache-lifecycle.test.ts` fail for reasons unrelated to the change under test. CI runs in a container where `/tmp` is ordinary disk and needs no such setting.

GitLab CI is defined in `.gitlab-ci.yml`; its quality job runs `npm ci` followed by `npm run check` and publishes `coverage/cobertura-coverage.xml` as a `coverage_report` artifact. One compatibility job runs the complete check in an isolated exact-version install; minimum and current resolve to the same Pi 0.84.2 manifest, so CI avoids running that install twice. Publishing waits for quality and the compatibility job. The Cobertura verifier checks that the XML is valid Cobertura-style output and that class filenames are remapped to TypeScript sources, not `.test-dist`.

Canary packages are published manually from a successful default-branch
pipeline. Stable releases are immutable and tag-driven. Do not edit both
manifests or create release tags by hand. From a clean checkout of `main` that
matches `origin/main`, preview the complete preflight with:

```bash
npm run release -- X.Y.Z --dry-run
```

When the preflight passes, generate the matching `package.json`,
`package-lock.json`, release commit, and annotated tag with:

```bash
npm run release -- X.Y.Z
```

The command refuses detached or non-`main` checkouts, dirty or stale trees,
mismatched manifests, occupied local or remote tags, and versions already
published to the registry. It does not push or publish. After reviewing the
result, it prints the exact `git push`, `glab pipeline status`, and `npm view`
commands for the remaining operator steps. The tag pipeline reruns the full
quality and package-loader checks, rejects a tag that does not exactly match
`package.json`, and publishes the tested tarball with the `latest` dist-tag.

### Optional local hooks

Tracked hooks live under `.githooks/` and are opt-in via local Git config:

- `.githooks/pre-commit` runs `npm run lint` and `npm run typecheck`.
- `.githooks/pre-push` runs `npm run coverage`; this command already compiles and executes the test suite under c8, so the hook does not run `npm test` separately.

Install them for this clone when desired:

```bash
npm run hooks:install
```

The installer only sets this repository's local `core.hooksPath` to `.githooks`; it does not copy files into `.git/hooks` or overwrite existing hooks. It is idempotent, refuses to replace a different configured hooks path unless `--force` is supplied, and supports a no-write check mode:

```bash
npm run hooks:install -- --check
```

### Experimental live benchmarks

Experimental live-model prompt R&D benchmark:

```bash
npm run bench:live -- --models openai/gpt-5-mini --fixtures all --repeats 1 --thinking off
```

Compare multiple models concurrently:

```bash
npm run bench:live -- \
  --models openai/gpt-5-mini,anthropic/claude-sonnet-4.5 \
  --fixtures all \
  --repeats 3 \
  --concurrency 2 \
  --thinking medium
```

List models available through Pi SDK auth/model resolution:

```bash
npm run bench:live -- --list-available
```

The live benchmark is not part of the normal test suite. It calls real LLMs, writes JSONL metrics under `bench-results/`, and is intended for prompt iteration and model comparison.

## License

MIT. See [LICENSE](LICENSE).
