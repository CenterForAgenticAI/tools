This page is for people using the extension's commands, tools, handoffs, and recovery features.

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

