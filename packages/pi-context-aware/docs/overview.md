This page is for readers who need the previous README’s detailed product overview and installation reference, preserved verbatim.

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
