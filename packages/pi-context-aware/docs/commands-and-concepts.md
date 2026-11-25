This page is for people using the extension's commands, tools, handoffs, and recovery features.

## Getting started

### 1. Check the current context state

Inside Pi:

```text
/context-status
```

This reports context usage, seed mode, rewrite behavior, ambiguity mode, compaction model, proactive compaction threshold, and the latest seed handoff (including the raw seed, seed actually used, and any expansion or no-expansion reason). The shared footer shows the pressure icon and rounded percentage (for example, `🟡 55%`) at the WARN band and above; below WARN it is hidden, except that it shows an entry-limit warning at any percentage and `size unknown` when Pi has not measured the context; detailed token counts and non-default configuration stay out of the crowded footer.

The session focus and the task list belong to pi-workstream: its `workstream_focus` and `workstream_tasks` tools, its `/focus`, `/tasks` and `/answer` commands, and its widget. This package reads the focus that pi-workstream records, `pi-workstream.workstream.v1` or the older `context-aware.workstream.v1`, as one stream in transcript order. It uses the focus for compaction guidance, `/checkin`, the session registry, `/sessions`, cmux status and activity. `/sessions health` reports scrubbed adapter and capability state without exposing transcript content.

Activity entries are generated automatically after a settled run that contains a material typed event such as a decision, commit, file change, blocker, or handoff. The primary coding agent does not author these entries, so no agent skill is required. A separate bounded activity-model call receives an explicit system rubric and a structured payload with two different trust roles:

- `authoritativeWorkstream` is validated alignment state replayed from the session focus entries. Its objective, status, pinning, goals, references, and boundaries are the sole semantic authority for the workstream's current purpose and constraints.
- `transcriptEvidence` is a bounded, redacted account of what happened. Embedded text may provide evidence of a genuine decision or result, but it cannot instruct the activity model or redefine the workstream. `recentActivity` is likewise a projection used for continuity and deduplication, never authority.

The model may emit zero to three grounded events and should return no events when the evidence is routine, ambiguous, unrelated to the authoritative objective, or contains no durable change. Objective, goal, boundary, status, and pinning changes must come from `authoritativeWorkstream`, not be inferred from raw transcript language. For inactive workstreams, only lifecycle transitions or still-relevant unresolved state qualify; unrelated subsequent work does not. Oversized state is reduced to a valid bounded JSON projection with explicit `omittedCounts`; omitted items are never treated as absent state.

The activity rubric uses these meanings:

- `progress`: a meaningful objective milestone was completed or independently verified, not merely a command or intermediate edit;
- `decision`: an approach, constraint, trade-off, or direction was deliberately chosen with consequences for later work;
- `blocker`: progress remains materially impaired until a named condition is met;
- `handoff`: responsibility or a defined next phase moved to another agent, session, reviewer, or operator;
- `diagnostic-gap`: a material uncertainty or missing piece of evidence about the work remains unresolved.

Each summary must describe a durable outcome rather than raw tool activity, remain grounded in supplied transcript-entry IDs, avoid duplicating recent activity, and contain no secrets or unnecessary path details. `relevant: true` means an agent resuming after compaction would need the event to continue the objective or honor a current decision, blocker, constraint, or handoff. Other durable historical milestones may be recorded as not relevant and therefore stay out of the bounded compaction digest.

Only enabled, active focus affects compaction guidance and details or next-phase seed constraints. Missing, disabled, paused, completed, and detached focus leaves normal compaction unchanged and contributes no durable-workstream content. Old sessions keep working: pi-workstream shows their tasks and focus, and this package reads their focus.

For the model itself, context-aware keeps exact usage numbers out of the system prompt and out of the session. The fold pass computes one pressure value per request from the request it builds, and at `WARN` or `URGENT` one action line rides in that request only, after the last session message, so the cached prefix is unchanged. See [Cache-aware context pressure](#cache-aware-context-pressure).

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

This command option is separate from `compactionModel`: it neither changes that setting nor chooses the model that generates the compaction summary. It applies only to `/compact-then`; the `context_compact` tool has no model option.

You can also use a loaded Pi prompt template as the explicit seed:

```text
/compact-then /review-auth src/auth.ts
```

The seed is an invocation, not text. Before compacting, context-aware checks that `/review-auth` is registered with Pi (`pi.getCommands()`); if no command of that name is registered, the text is not an invocation: context-aware shows an info notice (`/tmp is not a registered command; using the text as the seed.`) and uses the whole text as a free-text seed. After compaction completes, it delivers exactly one message, `/review-auth src/auth.ts`, as a follow-up with `expandPromptTemplates: true`. Pi then runs it as it would a direct invocation: prompt template frontmatter controls apply, and registered extension or skill commands are dispatched. The arguments are forwarded as typed, the compacted summary is the context, and no separate seed message is sent. The invocation is not rewritten by the seed rewrite model.

If Pi cannot dispatch the command after compaction, context-aware reports an error naming the command and the cause. It never falls back to sending the command text as a seed. Before sending, it checks that the session has a model and that the model's provider has configured auth; if not, it sends nothing, writes no delivery marker and reports the reason. A failure inside Pi after that check (for example an input-handler error) still surfaces only as Pi's generic "Extension error", because `sendUserMessage` returns no result. Free-text seeds are unchanged.

### 3. Compact without writing a seed

```text
/compact-then
```

With no seed, the extension first generates a raw next-phase seed from the conversation, then applies the same rewrite and handoff flow.

### 4. Let the agent compact via tool call

Agents can call:

```ts
context_compact({
  seed_prompt: "continue with item #3",
  summary_focus: "Preserve exact file paths and validation commands."
})
```

Use this at clean boundaries, not mid-edit or mid-debug.

### 5. Use fully autonomous handoff mode when appropriate

```text
/context-aware-seed-mode autonomous
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

By default, proactive compaction is enabled at **90%** context usage (the pressure ladder's seeded-compaction step; `proactiveCompaction.thresholdFraction` overrides it) with a **16,384-token output allowance plus 2,048 tokens of protocol overhead**. After every completed provider turn—including `toolUse`, `length`, and error turns—context-aware estimates the newly appended tool results and other trailing context. The `turn_end` handler records the trigger, arms the cancellation drain, and returns without awaiting seed generation. After Pi emits `agent_settled`, context-aware restores the exact active-tool set and launches seed preparation in the background only while `ctx.isIdle()` is true. It compacts before the next model call when either the percentage threshold is crossed or remaining headroom is below the generation reserve. The output allowance is capped at the active model's advertised `maxTokens` when that limit is smaller.

This closes the same-turn gap where a large tool result could leave only a few thousand tokens for the automatic follow-up response. Repeated pressure while preparation is pending or generating is coalesced into that attempt; a later active run is drained without starting a duplicate model call. A competing Pi threshold/overflow compaction is cancelled while preparation owns the seeded handoff, so the same pressure event cannot produce an unseeded compaction followed by a duplicate. Seed generation plus rewriting uses a first-output grace period and a resettable stall timeout, with an absolute five-minute preparation ceiling. A provider that ignores cancellation may finish its detached request later, but it cannot hold `turn_end`, `agent_settled`, shutdown, or a replacement session open, and its late result cannot queue work. The reserve check takes priority when selecting the trigger, but generation-reserve and threshold triggers share the proactive cooldown. A queued attempt starts the guard, and completion resets its full duration; when before/after usage confirms that compaction did not reduce context, context-aware warns instead of immediately re-arming the drain. If Pi has not made post-compaction usage measurable yet, context-aware records a pending measurement, keeps the cooldown active, and checks the first later assistant result before warning. A reply that ended in an error or was aborted is skipped, because its usage is partial; the measurement stays pending until a valid reply (or Pi's own measured size) arrives. If model-generated seed preparation is unavailable at that safety boundary, context-aware records the failure, falls back to a deterministic recovery seed, and still starts compaction instead of allowing the under-budget normal turn.

If a provider nevertheless returns `stopReason: "length"` while usable headroom is below the reserve, context-aware replaces the prose of the finalized incomplete assistant message before persistence and starts the same compact+handoff recovery. The truncated tool call and the `length` stop reason are both kept, because Pi answers a length-stopped call with an error result of its own rather than executing possibly truncated arguments: erasing the call would leave that result with no tool call to belong to, which is the failure behind issues #10 and #56. That recovery is guarded to one attempt per interrupted run: a second length stop remains visible and does not start an infinite compaction loop. Ordinary length-limited responses with adequate context headroom are left unchanged because compaction would not repair a model's independent output cap.

When Pi has not measured the context size (for example right after a compaction), context-aware does not read it as 0% used and does not estimate it. A new threshold or reserve check waits until Pi reports a measured size. An owed compaction left by a refused commit stays owed while its own cooldown is still running; once that cooldown has expired or another cooldown has replaced it, the marker is discarded. Waiting does not recover an overflow: while the size is unknown, recovery depends on Pi's native automatic compaction settings, so with Pi's automatic compaction off nothing compacts the session until the size is measured or you compact it yourself. See [When Pi has not measured the context size](configuration.md#when-pi-has-not-measured-the-context-size) for the full behavior.

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

Pi's `compaction.enabled` switch gates only its automatic threshold/overflow checks. Manual `/compact`, `context_compact`, `/compact-then`, and context-aware's `ctx.compact()` path remain available when it is off.

At `session_start`, context-aware reads Pi's public `SettingsManager` with the active cwd, agent directory, and project-trust decision. This mirrors Pi's default/global/project precedence for a normal file-backed Pi CLI startup. The extension API does not expose Pi's live settings manager or a settings-change event, so changing Pi's auto-compaction option in `/settings` requires `/reload` (or a restart) before this warning and the ownership status are refreshed. Context-aware's own `/context-aware-proactive` command re-evaluates ownership immediately against that startup snapshot. SDK hosts that inject an in-memory/custom settings manager or runtime `applyOverrides()` are not observable through `ExtensionContext`; their ownership status is therefore limited to the same file-backed approximation.

| Context-aware summarizer | Context-aware proactive | Pi native automatic | Startup warning/status |
|---|---|---|---|
| on | on | off | none — context-aware owns automatic compaction |
| on | off | on | none — intentional Pi-native-only mode |
| on | on | on | competing automatic compaction owners |
| on | off | off | no automatic compaction owner |
| off | inactive (configured value retained) | either | none — deferred to another compactor |
| any | inactive | either | none — blocked by an extension that cancels every compaction |

Warnings are emitted once per observed unsafe state rather than on every status check. `/context-aware-proactive status` and `/context-status` show the owner plus the startup source of Pi's setting. When `summarizer.enabled` is `false`, ownership status is `deferred to another compactor`; context-aware does not guess which registered extension will claim the hook. If the global or trusted-project Pi settings file cannot be parsed or read, status reports the owner as unknown instead of guessing and no ownership warning is emitted.

To let another extension own both automatic triggering and summarization while retaining context-aware telemetry, recall and focus projections, configure:

```json
{
  "summarizer": { "enabled": false },
  "proactiveCompaction": { "enabled": false }
}
```

The configured proactive value is retained, but its effective state is inactive while `summarizer.enabled` is `false`. Context-aware does not initiate threshold, generation-reserve, or output-limit compactions for another compactor, and it suppresses any prepared automatic handoff if ownership changes before delivery.

### Compaction blocked by another extension

`billion-context-pi` returns `{ "cancel": true }` from Pi's `session_before_compact` hook for every compaction, so no compaction can finish while it is loaded. Context-aware detects it at `session_start` by either of two signatures: the tool pair `compress` and `acp_status` (billion-context-pi's own tools) registered from the same extension, or an `acp_cache` tool registered from outside this package. Only billion-context-pi registers `acp_cache`, and the check uses the name alone, apart from skipping this package's own tools. Another extension that registered a tool named `acp_cache` would also be treated as billion-context-pi: the fold engine would run in shadow mode and the compaction advisory would show. The `acp_cache` signature means the order in which the tools register does not change the result. It does not report a block when `billion-context-pi` stands down: when `BILLION_CONTEXT_NATIVE` or `BILLION_CONTEXT_PROXY` is set, or when the active model's base URL routes through its `/bili/` proxy.

While the block lasts:

- `context_compact` stays registered with `hidden` exposure. Pi does not declare it to the model, and code-mode executors do not list it. A call that still arrives fails with the reason.
- `/compact-then` and the context service's handoff request fail with the reason instead of starting a compaction.
- Proactive compaction is inactive, and `/context-status` reports `Automatic compaction owner: blocked by billion-context-pi, which cancels every compaction`.
- When the current session can reach billion-context-pi's own `compress` tool and neither context tool, the pressure action line names it instead of compaction. Otherwise they do not name it. The `context-tools` section names only our own tools.

The tool list is read once per session start. To restore compaction, remove `billion-context-pi` from the profile's packages and reload Pi.

### Compaction claimed from pi-fabric

With `compactionClaim.enabled` set, context-aware claims compaction from pi-fabric through the `pi-fabric:compaction-owner:v1` channel, so that it writes the summary and pi-fabric's own compactor stands down. The claim is off by default: while `billion-context-pi` is in the profile it stays the only live context manager. See [`compactionClaim`](configuration.md#compactionclaim) for what the claim carries, how a failed model summary falls back, and when the claim is withdrawn. pi-fabric may answer the claim after a short delay, because it loads its claim code on the first claim; until then the claim is pending and compaction is unchanged. Without pi-fabric loaded, nobody answers within 5 seconds and compaction stays unchanged for that session.

## Model dispatch decisions

All extension-owned model calls share one recorded routing decision. Pi exposes `ExtensionContext.modelRegistry.complete` for routed completion, but it exposes no public routed `stream` or `streamSimple` method to extensions.

Completion-only sites route through `ctx.modelRegistry.complete`. The three streaming sites are **adaptive**: they stream through compat when the loaded compat instance can dispatch the model's api (`getApiProvider(model.api)` resolves), and otherwise route through `ctx.modelRegistry.complete`. The transport decision is made per model, so a compaction that falls back to a configured overflow-fallback model reconsiders it — a fallback reachable only through a runtime-registered api routes even when the primary streamed, and vice versa. This adaptive fallback matters when a model is reachable only through an api registered at runtime by another extension — for example `@centerforagenticai/pi-multi-account`'s `unified` alias router. Under a `packages:` load the extension's `@earendil-works/pi-ai/compat` bare specifier resolves to this package's own on-disk copy, whose registry never received `unified`; a raw `streamSimple` on that copy throws `No API provider registered for api: unified` synchronously, before any overflow or transient recovery can run. That is the module-split failure that previously forced Pi's un-reduced built-in compaction to retry the full transcript and overflow. Routing through the registry keeps those models reachable and keeps the existing reduced-payload and configured-fallback recovery ladder in play. The tradeoff is that a routed call is non-streaming, so incremental seed/compaction progress is not shown while it runs; for the seed paths, a routed call pings the preparation liveness heartbeat on an interval so a slow-but-healthy completion is not aborted by the first-output grace, while the absolute preparation ceiling still bounds a stuck call.

When the compaction hook fails for a reason that is neither an exhausted overflow ladder nor an exhausted transient transport, context-aware normally defers to Pi's built-in compaction. Before doing so it checks that the built-in's requests could actually fit. Pi sends the history summary and, for a split turn, the turn-prefix summary as separate requests, so context-aware rebuilds and estimates each complete provider request and models the largest one rather than their sum. It requires at least 1,024 summary-output tokens after pi-ai's 4,096-token safety margin; `settings.reserveTokens` is not subtracted from input capacity, because Pi 1.4 does not use it to budget summary output. When even the largest request cannot leave that useful output budget, context-aware cancels with a visible error instead of handing the built-in an oversized request it can only reproduce as an unchanged-context overflow.

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

### Cache-aware context pressure

Prompt caching works best when the long prompt prefix stays stable. Earlier versions appended exact context usage numbers to the system prompt before every agent turn, and later versions persisted a hidden `<context-telemetry>` envelope at each outer user turn. Both are gone (pi-context-aware#461).

The fold pass computes one pressure value per model request, over the context window: its count of the request it builds, which is Pi's view with the active folds applied, before the pass truncates or hides anything and without the line it injects, and not below Pi's last measured size less what a newer fold has reclaimed. The per-request metrics record keeps it as `tokensBefore`; `tokensAfter` is the view actually sent. When the fold pass does not run (another engine owns folds, or the pass failed), the request is Pi's own view and Pi's measured usage is its count. The action line below, proactive compaction and the retry of a compaction still owed, the metrics record, the `/checkin` prompt, `context_status`, `/context-status`, the compaction owner's pressure, the context service snapshot and the footer all read this one value.

Proactive compaction decides between requests. When the latest request's count (or Pi's measured size, if larger), plus the reply and tool results of the turn that just ended and a 16,384-token margin, would reach the threshold or the generation reserve, it reads the count the fold pass gives the request the session would send next, so a reply and its tool results are counted before the next request goes out. Otherwise nothing can fire, and it reads the latest request's count without running a second pass. Within a tool loop that preview equals the next request's count; at a prompt boundary it is lower, because it leaves out the new prompt and the messages other hooks add.

At `OK` nothing is injected and nothing is persisted. At `WARN` or `URGENT` one action line joins the request, after the last message from the session. When the fold nudge is due on the same request, the line is appended to the nudge, so the model gets one injected message. The line is never persisted: the next request carries its own line, or none. For example:

```text
[context-aware extension, not user input] Context pressure WARN (64% used, about 98k tokens of headroom). Before broad reads, long test loops or a phase switch, keep the next action small, fold finished ranges with `context_fold`, call `context_compact` at a clean boundary, or delegate bounded work.
```

The line names only the tools the session can call now. At `URGENT` it asks for `context_compact` before the next nontrivial tool call when that is reachable, else a fold with `context_fold`; when another extension cancels every compaction and neither tool is reachable, it names that extension's reachable replacement (billion-context-pi's `compress`); otherwise it asks the model to finish only the atomic edit or validation in progress and tell the user context is nearly full. `pressureTelemetry.mode` sets how much the line shows; see [`pressureTelemetry`](configuration.md#pressuretelemetry).

The bytes before the injection stay identical between consecutive requests. pi-ai puts the conversation cache breakpoint at the end of the last user message, which is now the injection: `cache_control` on its last block (Anthropic Messages, and the last text part of OpenAI-compatible payloads) or a trailing `cachePoint` (Bedrock Converse). context-aware moves that breakpoint to the block before the injection, the end of the session's own messages, so the next request reads the entry instead of writing the whole history again. It moves only onto a text, tool-call or tool-result block; when the block before the injection is an image or a thinking block, the breakpoint stays where pi-ai put it. Providers with automatic prefix caching need no breakpoint.

The system prompt carries no pressure rules and no instruction about telemetry, since no envelope can arrive. Its text is set as named Pi prompt sections, one per block: `context-awareness` (the recall guidance), `context-tools`, `context-cache`, and `compaction_history`. Pi sends a changed section as an update, so the other sections stay byte-identical. When another extension has already replaced the whole prompt, context-aware appends the same blocks to that prompt instead.

Contributed text from other extensions (pi-workstream places its focus and task list this way) rides in a hidden `context-aware-task-state` message, and a restart notice in a `context-aware-restart-notice` message, each sent only when its text changes. Both are persisted, so they stay in the cached prefix. The restart notice and the action line each start with `[context-aware extension, not user input]`, since no system-prompt rule explains them.

Sessions saved before pi-context-aware#461 still hold their `context-aware-usage-marker` messages. They stay in the session file and the display, but the request leaves them out: a resumed session's last marker would otherwise remain its newest pressure statement.

The band edges come from the context policy's pressure ladder: `WARN` starts at the first fold nudge (45% by default) and `URGENT` at seeded compaction (90% by default). See [`pressureLadder`](configuration.md#pressureladder) for the full mapping.

`UNKNOWN` means nothing counted the request: Pi has not measured the size, right after a compaction or an overflow, and the fold pass did not run. Nothing is injected then. The context was just reduced, so this is the lowest-pressure point of a session; Pi measures the size again with the next reply, and Pi's own overflow recovery still applies. When the fold pass runs, it counts the request it builds even before Pi has measured the size, so the band comes from that count. Proactive compaction still waits for a size Pi measured. The footer, `/context-status`, compaction notices, the `context_compact` receipt (`tokens_before: null`), the check-in prompt, and the context service (`band: "UNKNOWN"`) report an unmeasured size as unknown.

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

When an explicit seed is a command invocation, details also record `commandInvocation` and `commandName`.

## Main commands

### `/compact-then [seed prompt]`

Compact and start a new phase.

With an explicit seed:

```text
/compact-then continue with item #3
```

A seed that starts with a slash word is a command invocation. Any registered command (prompt template or extension command) is accepted, checked before compaction, and run after it:

```text
/compact-then /review-auth src/auth.ts
```

With no seed:

```text
/compact-then
```

The no-seed path generates a seed from the current conversation, then applies the same rewrite/approval/ambiguity behavior.

### `context_compact` tool

LLM-callable equivalent of `/compact-then`. It has no `ambiguity_mode` parameter.

Parameters:

```ts
context_compact({
  seed_prompt: string,
  summary_focus?: string,
  rewrite_seed?: boolean
})
```

`seed_prompt` is required. It is both:

1. the brief used to steer compaction; and
2. the generated compaction handoff delivered after compaction.

When rewriting is enabled, the expanded seed replaces the raw seed for both purposes.

A successful `context_compact` call is a terminating tool action: Pi ends the current agent run without an extra LLM continuation, then the extension starts compaction from the `agent_settled` lifecycle boundary. After compaction, the extension sends the expanded seed automatically, so the user does not need to repeat the prompt. The agent should call `context_compact` as the only tool in its response because Pi only terminates a mixed tool batch when every result in that batch is terminating.

`/compact-then` follows the same no-reprompt handoff contract. As an extension command it waits for an idle boundary, compacts, and auto-sends its captured or generated seed.

When Pi would refuse the compaction, `context_compact` returns `Nothing to compact (session too small); the conversation is unchanged.` (or `Already compacted; …` when the newest entry is a compaction) as its result, without reporting `queued` first. That result does not end the run. `/compact-then`, the typed service's `requestHandoff` (status `nothing-to-compact`), and a Pi Fabric `compact.request` under the owner claim (`queued: false`) refuse the same way, before any seed is generated or queued. The check reproduces Pi's refusal for the session snapshot as it stands when asked. The `context_compact` snapshot includes an estimate for this call's own persisted result; entries that land after the check are not covered and may change Pi's eventual decision. Unverified Pi versions, missing settings, queued input, pending context edits, and an estimated result that already reaches the kept tail all leave the request to Pi.

In a Pi Fabric child session, `context_compact` refuses with an error and does not end the run. A child ends as soon as its run ends, so nothing would deliver the seed and the rest of its work would be lost. The error says that nothing was compacted and tells the model to keep working, and names `context_fold`, or billion-context-pi's `compress`, when one is reachable. A child is a session whose `PI_FABRIC_LINEAGE` marks a worker or a depth above 0, or whose `PI_FABRIC_DEPTH` is above 0; an unreadable value also counts as a child. A persistent Fabric actor is refused too: it keeps its session file between prompts, but each activation is a child run that Fabric closes once it settles, so nothing would deliver the seed. In a child, `context_compact` is registered with `hidden` exposure, and the per-turn guidance, telemetry action and check-in prompt do not offer it. Proactive compaction and output-limit recovery also stay off in a child, because both end the run to compact; Pi's own overflow recovery still applies.

### Prior-session search

Use `context_recall` when compacted-away or prior-session transcript text is needed. Set `include_current: true` (or `scope: "session"`) to search the active session's compacted-away text; it defaults to `false` for cross-session recall. Pass `ref` (a fold id such as `b5`) to get the original entries behind a fold. Use `context_status({ view: "compactions" })` when you need the current branch's compaction count, boundary identifiers, or the extension that wrote the last committed compaction (`Last committed compaction writer: …`, the same line `/context-status` prints; `details.writer` holds it as `{ kind, name }`). Project-scoped searches include sessions from same-repo Git worktrees by default.

When pi-memory is loaded, a `prior` or `all-projects` query that is not `regex` or `case_sensitive`, and keeps worktrees included, asks pi-memory's session store first. The request goes over `pi.events` on `pi-memory:search`; neither package imports the other. For `prior`, `context_recall` sends `scope: "prior"`, so pi-memory filters to this project and the store can return up to five matching sessions, one per session lineage. The extension also filters out cards from other projects as a compatibility guard for older stores that ignore `scope`; only with such a store can that guard leave fewer than five cards. Cache documents, `include_current`, `scope: "session"` and `ref` are still searched locally. When pi-memory is not loaded, does not answer within 2.5 seconds, returns an error or an invalid reply, or replies twice, the session files are searched as before, and the result starts with a line saying why, such as `pi-memory search unavailable (timeout after 2500 ms); searched session files instead.` `details.pi_memory` records the outcome and the cards shown.

Each card ends with the call that reads it, such as `context_recall({ ref: "session:<session-id>#<entry-id>" })`. The call carries the ids exactly as the store sent them, up to 256 characters each; a card whose id is longer says `expand: none` instead of naming a cut id. A `session:` ref reads one past session over `pi.events` on `pi-memory:read` (caair/pi/pi-memory#34):

- `session:<session-id>#<entry-id>` returns the entries around that entry: `before` it (default 3) and `after` it (default 5), each 0 to 50. One reply holds at most 50 entries, and a larger window gives up entries before the anchor first.
- `session:<session-id>` opens the session from its start, or from its last page with `from: "end"`; the Previous page call then reads back. `from` does not apply to an entry ref.
- `kinds` keeps only some entry kinds, such as `kinds: ["user", "assistant"]` for the conversation without tool calls and results; in raw mode it matches line types. At most 16 kinds of at most 64 characters. An expand keeps its anchor entry whatever its kind.
- `mode: "raw"` returns the stored JSONL lines instead of one block per entry. A line with no entry id, such as the session header, is shown as `[line N ...] (no entry id)` and has no ref of its own.
- `max_chars` caps the session text returned (default 12,000, from 1,000 to 40,000), and `item_max_chars` caps one entry (default 1,500, from 200 to 12,000, never above `max_chars`). A cut is shown with a marker. To read one long tool result whole, expand its entry with `before: 0, after: 0` and a larger `item_max_chars`.

When there is more, the result ends with the exact call for the next or previous page. It passes a `cursor` and keeps `mode`, `kinds`, `max_chars` and `item_max_chars`, because a cursor works only for the same session, mode and kinds. A session ref cannot be combined with `query` or `offset`, and `before`, `after`, `from`, `kinds`, `mode`, `cursor`, `max_chars` and `item_max_chars` are refused without a session ref. A value of the wrong type is refused with a message that names the argument, and nothing is read. The result's first line labels the text as quoted data from another session, not instructions; every line of session text starts with `> `, with control, escape and format characters removed and secrets redacted.

When pi-memory is not loaded, does not answer within 2.5 seconds, or fails, the session's file on this machine is read with the same rendering and bounds, and the result says so; without a file, one line says why the store could not answer. A page cursor from the store (it starts with `c1.`) cannot page a file, so when the store is unavailable such a call says so and asks to read again without the cursor. File cursors start with `f2:` and name the session, mode and kinds they belong to; one used for another session is refused as a bad cursor. When the store answers `not_found`, or the session was erased on this machine, the result is not found and no file is read. The erased-session list is read again after the store replies, so an erase made while the store was being asked still holds. Before a file is read, pi-memory's erased-session cache, `~/.config/pi-memory/erased-sessions.sha256` (one SHA-256 of an erased session id per line, written by pi-memory from the store's erased list), must not list the session. A missing cache lists nothing; a cache that cannot be read or holds a malformed line refuses the file read.

A query also accepts `limit`, `max_results` and `maxResults` as names for `max_sessions`, in that order of precedence; `max_sessions` wins when given. The store returns at most five cards whatever the number; the file search returns up to the number given (at most 100).

Each query or `session:` call gets one trace id, 32 random hex characters, sent as `traceId` on every `pi-memory:search` and `pi-memory:read` request it makes (caair/pi/pi-memory#25). After the call, one event goes out on `pi-memory:recall-log` for pi-memory's search log: `{ v: 1, traceId, askingSessionId?, cwd?, tool: "context_recall", args: { query?, mode?, sessionRef?, limit?, scope? }, outcome, fallbackReason?, resultCount?, tookMs }`. `outcome` is `store` when the store answered, `fallback` when the session files answered instead, and `error` when the call was refused before the store was asked or threw. `fallbackReason` is `absent`, `timeout`, `unavailable`, `internal`, `bad_request`, `not_found` or `other`; a query the store is never asked (`regex`, `case_sensitive`, `scope: "session"`, worktrees left out) is a fallback with no reason. `resultCount` is the cards or entries returned, or the sessions the file search found. The query is cut to 2,000 characters, `cwd` and `sessionRef` to 512, and an asking session id over 256 characters is left out. This extension does not mask the query; pi-memory masks it before writing. The event is sent on a later turn and any error from it is dropped, so a slow, throwing or missing listener does not change the result or delay it. A call with a `query` that is refused before it runs, such as a `query` with a fold `ref` or with a `session:`-only argument like `mode`, sends one `error` event. A fold or hide `ref` with no `query` sends no event, even when it is refused.

In a Pi Fabric program, `memory.recall` is Fabric's own search of this machine's session files: it does not ask pi-memory's store and does not take `session:` refs, `from`, `kinds` or `item_max_chars`. To read a past session from a program, call this tool as `extensions.context_recall({ ref: "session:<session-id>#<entry-id>" })` when the program's tool allowlist permits it.

The prompt's compaction projection contains only the current-branch count; compaction boundaries contain metadata, not summary text. Summaries are not retained by this mechanism. Use `context_recall` with `include_current: true` to retrieve earlier summaries or other compacted-away transcript text.

#### Context tool guidance

One prompt section, `context-tools`, covers `context_status`, `context_recall`, `context_fold` and `context_compact`. The `context_fold` lines render only when that tool is reachable. Each tool's own prompt snippet and guidelines are short. The section, snippets and guidelines of the four context tools together stay at or under 1,500 tokens, counted with `defaultCountTokens`; `tests/context-tool-guidance.test.ts` fails above that. Tool descriptions are not counted.

#### `context_fold` replies

For how a fold is planned, stored, shown to the model and recalled, see [How context folding works](folding.md).

`context_fold` answers with one line per range. An accepted range says `accepted; written at the end of this turn`: Pi writes new session entries only at the end of a turn, so the fold waits in a queue until then.

A range is accepted only if the end-of-turn check would write it with the branch as it is when you call. The engine plans the range, removes the protected recent messages and any entry they would split, and then runs the end-of-turn check on what is left, including the minimum size (`minCompressRange`, 5,000 characters). When too little is left, the range is refused at once with the same message the end of the turn would give, for example `Total compressible content too small (1530 chars across 1 range(s), min 5000)`, and the valid refs. Nothing is queued.

A call in which every range is refused, or which names no readable range, is an error result. A call with at least one accepted range is not, and lists the refused ranges in its text.

A queued fold can still be dropped at the end of the turn for a reason that did not exist when you called, for example when an earlier fold in the same batch already hid part of its range. The turn then ends with one notice that names each dropped range and the reason, such as `Fold m00004..m00018 was not written: Total compressible content too small (1530 chars across 1 range(s), min 5000).` The notice is a custom message entry (`context-aware.fold-notice`), not a turn the user typed. Pi sends it to the model as a user-role message with the next request, and, like other injected messages, it is ordinary history for the fold engine: only a message you typed moves the boundary of the protected zone, so the notice does not stop earlier messages of the turn from being folded. It names at most three folds and counts the rest; `context_status({ view: "folds" })` lists every fold dropped in the last batch.

The folds view ends with three lines that keep what folds save apart from what they cost. Each number comes from the session branch:

```text
Fold savings: 1900 tokens per request from 1 active fold (2000 tokens folded, 100 tokens of summary).
Preprocessing cost: 3762 output tokens on 1 assistant turn that called context_fold.
Recovery cost: 200 tokens returned by 1 context_recall of folded content.
```

- **Fold savings** is the tokens the active folds keep out of every request: the `compressedTokens` each fold record stored when it was made, minus the tokens of the summary that replaced them. A fold that absorbed earlier folds counts their summaries as its input, not as originals; each is subtracted as the fold that absorbed it counted it: the summary text the carrier showed, heading and topic included. Neither cost below is subtracted.
- **Preprocessing cost** is the output tokens Pi recorded (`usage.output`) on each assistant turn that called `context_fold`, because the model writes the summary as that call's arguments. It is the whole turn's output, so it also holds any reasoning and other tool calls in that turn, and a turn whose fold was later refused or dropped still counts; the line names turns, not summaries, for that reason. A count of the call's arguments alone would be an estimate, not a measured number, and would leave out the reasoning spent writing the summary. A turn with no recorded usage adds nothing and is counted as `N of them recorded no usage.`
- **Recovery cost** is the tokens of each successful `context_recall` result that returned a fold's originals (`ref` set to a fold id). A recall of a hide id, or a refused recall, is not counted.

Summary and recall tokens are counted with the engine's `defaultCountTokens` on the text the session saved. `details.savings`, `details.preprocessing` and `details.recovery` carry the same numbers.

### `/session-erase <session-id>`

Permanently erase one closed session from the current profile:

```text
/session-erase <session-id>
```

CAUTION: Close all other Pi sessions before erasing a session. Deletion is direct, not trash, and cannot be undone.
Reload context-aware in every Pi process before erasure. Older processes and hosts without this extension do not publish open-session leases.
The command refuses the current session, live leases, and live registry projections, even when those sessions are idle.
It is a user command only. There is no model tool or unattended `--yes` option.

The command lists all known descendant forks and asks whether to include them.
It also asks about context-cache documents created or updated by the selected sessions, because those documents can be shared.
A final confirmation precedes deletion. Declined forks and documents appear under `Untouched` in the receipt.
Declined documents remain on disk but disappear from recall and automatic cache listings.
Untracked cache files, including anonymous staging leftovers, cannot be attributed to one session.
They stay untouched and appear in the receipt. Review these files separately before the fold-engine cut-over.

Erasure removes the transcript, its `.acp.json` side file, registry projections and crash debris, parity diagnostics, the per-session metrics file, and SQLite discovery rows.
Live registry locks also refuse erasure. Dead locks, reclaim directories, and temporary projections disappear with their session.
Focus, tasks, naming, telemetry, compaction summaries, native folds, and originals stored in the transcript disappear with it.
The command commits session ids to `<configuredAgentDir>/context-aware.sqlite` before deletion and checkpoints the SQLite WAL afterward.
The `erased_sessions` table contains session ids only, without text or hashes. SQLite uses `secure_delete=ON`.
Persisted ACP import and historical backfill must use `importAcpSideFileFromProfile`, not the pure shadow-preview importer.
Recall, search, cache migration, cache writers, registry indexers, and parity readers skip erased ids, including restored copies in profile stores.
Parity appends acquire a ledger-checked lease for the full write, so erasure and persistence cannot both win.
Erased targets cancel session switches and forks. A refused startup lease requests shutdown. This extension blocks its commands, tools, transcript writes, naming, fold drafts, nudges, continuations, and ordinary input.

For turns that another extension starts, it requests abort at `agent_start` and blocks all tool calls. Pi can still persist the trigger message and an assistant abort/error entry. Shutdown is a host request, not a persistence lock.

Pi can rewrite migrations, repair a missing newline, or append missing thinking metadata before `session_start`. Migration rewrites can restore the loaded private transcript.

A cancellable SDK opening handshake is still necessary before any session file load/write. The SDK must hold opening protection through activation.

About one second after session start, and at once on refused-session start and shutdown, context-aware checks whether an erased id's transcript, `.acp.json` side file, parity record, or metrics file returned. A warning lists each detected path. It deletes nothing automatically. The check reads only each transcript's first line, and it is skipped when the ledger has no erased ids.

A returned file can be a backup you restored on purpose. Close the refused session. Run `/session-erase <session-id>` from another session to delete the returned data, with the normal consent dialogs.

The command accepts ids already in the ledger, even if only a side file, parity record, or metrics file remains. Side-only restores use Pi's filename convention or the refused session's known path for identification.

The id-only ledger cannot identify a renamed side file without its transcript.
The database is the shared profile database for future fold and historical-backfill rows.
Node `22.19.0` supports `node:sqlite` without a flag, but emits an experimental-feature warning.

The receipt lists `Erased`, `Failed`, and `Untouched` data. Any deletion or checkpoint failure produces an `incomplete` receipt.
The ledger remains after a partial failure so that import cannot restore erased content.
Fabric's memory index is **not erased** until Fabric supports deletion.
External copies, backups, exported task plans, other extensions' stores, and the shared debug log remain untouched.
The command only deletes files inside this profile. It refuses redirected store directories or unsafe files.
On platforms without directory-descriptor paths, deletion fails closed and the receipt reports the failure.

About one second after session start, missing-source detection runs in the background. Startup does not wait for it. It never deletes session data.
Pi writes a transcript with a session's first user or assistant message, so a session closed before its first prompt leaves a discovery row and no file. context-aware records that first message just before Pi writes the file. When no live process holds a missing session, no message was recorded for it, its transcript was never seen on disk, and it left no `.acp.json` side file, parity record, registry entry, or cache document, the sweep drops the row silently and notes the count in `context-aware-debug.log`.
Any other missing transcript is reported once, and its discovery row is kept. This includes sources recorded by earlier versions, which kept no write history. A missing path can mean an unmounted disk or a moved directory, not intentional deletion. Transcripts that one sweep finds missing share one notice. If a transcript comes back and later goes missing again, it is reported again.
To erase the unavailable session's profile stores, name its id with `/session-erase <session-id>` and confirm through the same fork, cache, and final consent dialogs. Moved copies are not searched for or deleted.

### `/session-erase <session-id> --range <ref>..<ref>` and `--match <literal>`

Erase part of a closed session and keep the rest:

```text
/session-erase <session-id> --range m00012..m00020
/session-erase <session-id> --match <literal text>
```

`--session <id-or-path>` names the session instead of the leading id; a path must lie below `<agentDir>/sessions`. `--range` takes an acp ref (`m00012`) or an entry id on each side, and both must lie on one path of the session tree. `--match` is a literal string, not a pattern.

- **What is erased.** Message text, tool-call arguments and tool output of the chosen entries become `[erased <date>]`. `--match` searches exactly those fields. It never changes ids, parent links, roles, types or tool-call ids, so the tree and call/result pairs stay valid. A compaction or branch summary that covers an erased range is erased too, with the fold record and context edits that carry its text.
- **Preview, then confirmation.** Nothing is written until you confirm a preview that lists the entry ids, the derived stores that hold a copy (fold side file, parity and metrics records, context-cache documents and descriptions), and every fork that holds a copy. Each fork is then asked separately. A declined fork is not opened for writing and stays byte-identical.
- **Receipt.** The receipt lists `Erased`, `Failed` and `Untouched` (declined forks, stores that still hold the text or could not be cleaned), then the limits below. The preview and the receipt hold ids, counts and paths only, never the erased text.
- **Ledger.** The `erased_entries` table records the session id, entry id, a SHA-256 hash of the session id, entry id and original line and the date. It holds no text.
- **Refused, with nothing written.** A session that is open (current session, live lease, live registry projection, or liveness that cannot be established), a range that does not resolve or runs backwards, a session path outside the sessions directory, an empty match, and a match inside a line that is not a readable session entry. The live-session path waits for an upstream Pi API and is not supported.
- **Limits.** Fabric's memory index is not cleaned. Backups, exports and other extensions' stores are not searched. A `--match` literal is removed from derived stores whole, so a short literal removes every derived document that contains it. A `--range` removes derived documents only for erased strings of 12 characters or more.

`/session-erase <session-id>` without a flag still erases the whole session as described above.

### Context cache management

The context cache stores curated, scoped reference documents that survive compaction and future sessions. By default, files live under `~/.pi/agent/context-cache/<sha256(scopePath).slice(0,32)>/`, where `scopePath` is the current Git worktree root. The `contextCache.scope` setting can select the session directory, repository common Git directory, or absolute current directory instead. Each pool has an `_manifest.json` tracking descriptions and metadata; unrelated worktrees do not share a pool.

Manifest entries follow a fixed rule when `_manifest.json` is read. Each entry has six required fields: `description`, `createdBy`, `updatedBy`, `created` and `updated` (strings) and `sizeBytes` (a non-negative safe integer). `artifactId` is optional: a missing, empty or duplicate value is replaced with a stable id derived from the cache path and file name, with a `-2`, `-3` suffix on a collision, so the same manifest always reads to the same ids. An entry that lacks any required field, has a wrong type, or has an unsafe file name is malformed. Reading drops it from the manifest view. Its file stays on disk until the normal orphan cleanup handles it. Malformed entries are not quarantined and not migrated. Only the named fields are kept: unknown properties on the manifest or on an entry do not survive reading, writing or pool migration.

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
/context-aware-seed-mode status
/context-policy status
/fold-parity
/context-aware-seed-rewrite status
/context-aware-ambiguity status
/context-aware-model status
/context-aware-overflow-fallback status
/context-aware-proactive status
/context-status
```

`/context-status` also reports context usage, available headroom, and the automatic-compaction owner resolved at startup.

`/fold-parity` reports shadow fold comparisons while billion-context-pi is loaded: the count toward 500 under the current engine fingerprint and unexplained differences. It writes diagnostics outside the session and registers no tool. See [fold parity](fold-parity.md).

