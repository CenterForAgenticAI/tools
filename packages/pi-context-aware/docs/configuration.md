This page is for operators who need every configuration key, default, override, and command.

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
usage has increased by at least one percentage point, and a turn end repeated for
the same assistant entry, as after a pi-durable resume, never appends twice. Foreground sessions never
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
  "compactionClaim": {
    "enabled": false,
    "fabricFallback": true
  },
  "proactiveCompaction": {
    "enabled": true,
    "thresholdFraction": 0.78,
    "outputReserveTokens": 16384
  },
  "modes": {
    "suggestTool": true
  },
  "imageStripping": {
    "enabled": false,
    "keepRecent": 5
  },
  "folds": {
    "firstUserMessage": "keep",
    "firstUserMessageMaxTokens": 8000
  },
  "contextPolicy": "summaries",
  "pressureLadder": {
    "foldNudgeStartFraction": 0.45,
    "foldNudgeEndFraction": 0.75,
    "seededCompactionFraction": 0.9,
    "recoverableHideFraction": 0.95
  },
  "pressureTelemetry": {
    "mode": "full"
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
--context-aware-modes-suggest-tool <on|off>
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
/context-aware-seed-mode user-approve
/context-aware-seed-mode auto-gen
/context-aware-seed-mode autonomous
/context-aware-seed-mode status
```

`/context-aware-mode` is an alias of `/context-aware-seed-mode` and takes the
same arguments. It stays until a later major release.

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

Context-aware's explicit handoff flows depend on its summary contract, so while summarization is deferred, neither `compact_session` nor `/compact-then` is registered. Registration normally happens at extension load. When the current project's `.pi/context-aware.json` sets `summarizer.enabled`, it waits for `session_start`, because only a session can tell whether that project is trusted. The context-awareness guidance, telemetry actions, and check-in prompt stop telling the agent to compact. Tasks, focus, telemetry, and `search_prior_sessions` stay available. A `summarizer.enabled: false` set by a session policy entry after load cannot unregister the tool, so it still fails before starting compaction and tells you to set `summarizer.enabled` to `true`. Use the other compactor's own handoff command while this switch is off.

An extension that cancels every compaction, such as `billion-context-pi`, has the same effect on these surfaces without any setting. Context-aware detects it at session start and hides `compact_session` instead of unregistering it. See [compaction blocked by another extension](commands-and-concepts.md#compaction-blocked-by-another-extension).

This leaf participates in global, trusted-project, session-policy, and host-policy precedence. An untrusted project's `.pi/context-aware.json` cannot change summary ownership; its `summarizer.enabled` leaf is ignored until the project is trusted. There is no CLI flag or setter command for it; edit `~/.pi/agent/context-aware.json`, a trusted project `.pi/context-aware.json`, or a host/session policy entry.

## `compactionClaim`

Controls whether context-aware claims compaction from pi-fabric, so that this extension writes the compaction summary and Fabric's own compactor stands down.

```json
{
  "compactionClaim": {
    "enabled": false,
    "fabricFallback": true
  }
}
```

`enabled` defaults to `false`. With it off, context-aware sends nothing to pi-fabric and compaction behaves exactly as it did before this setting existed. Leave it off while `billion-context-pi` is in the profile: that extension stays the only live context manager until it is removed, and the claim is meant to be turned on at that point. Turning it on while `billion-context-pi` is loaded does nothing, because context-aware cannot compact there. The setting, like `summarizer.enabled`, is ignored in an untrusted project's `.pi/context-aware.json`.

With `enabled: true`, context-aware sends one claim on the `pi-fabric:compaction-owner:v1` channel at `session_start`. It names `pi-context-aware`, its version, and the actions it supports: `request`, `status`, `pressure`, `carry` and `cancel`. pi-fabric may answer during the send or a little later, because it loads its claim code on the first claim. Until it answers, the claim is pending: it is not held, pi-fabric's own compactor keeps compacting, and no second claim is sent. If nobody answers within 5 seconds, context-aware cancels the claim, treats pi-fabric as not loaded for that session, and nothing changes: Pi's own summarizer runs as usual. A grant that arrives after that, or after the setting is turned off, the session ends or a new session starts, is withdrawn at once. The next session asks again. The claim does not take `/tree` branch summaries; pi-fabric keeps those.

While the claim is held:

- pi-fabric's compactor, its threshold trigger and its threshold deferral stand down. context-aware writes the summary alone.
- `compact.request` queues a compaction at the next settled boundary. Its `instructions`, `reason`, `requestedBy` and `preserve` list become focus text for the summary. A `seed` starts the next phase: after the compaction commits, context-aware sends it as a labelled custom message that starts a turn, never as a user message. A request without a seed sends nothing. A new request replaces one that has not started, as pi-fabric's own controller does; while a compaction is running, a request is refused. `compact.cancel` drops a request that has not started.
- Each action checks its own arguments with pi-fabric's limits (for example, a seed of at most 8192 characters and lists of at most 16 items), because any extension on the event bus can call the actions directly.
- `compact.carry` keeps a short list of facts (at most 16 items, each at most 2048 characters) that every summary keeps until the list is cleared. Each call returns the whole list, and pi-fabric refuses an action result over 16 KiB, so a change that would make the list larger than that as JSON is refused and nothing is written. The list is stored in the session file, so it follows the branch, and it is written into the summary's Constraints section. At the claim, context-aware takes over the list pi-fabric already held.
- `compact.pressure` reports the stage of the [pressure ladder](#pressureladder) and its four thresholds. `compact.status` reports whether the fallback is on, the carry count, and any queued request.
- The model that writes the summary also sees an index of the active folds: each fold's topic, range and message refs, with a pointer to `context_recall` for the original text.

`fabricFallback` decides what happens when the model summary fails or no model is available. With `true` (the default), the summary comes from pi-fabric's deterministic compactor, which also renders the carry list. With `false`, or when pi-fabric cannot produce one, context-aware returns no result and Pi's own summarizer runs. This also applies when overflow recovery or transient retries are exhausted: without the claim context-aware cancels the compaction in those cases, but while the claim is held pi-fabric has stood down, so a cancel would leave nobody to compact. Only if both fail is the last step of the [pressure ladder](#pressureladder), the recoverable hide at `recoverableHideFraction` (95%), left to act. That step is configured and reported but not yet acted on by this extension.

After each committed compaction, context-aware reads the newest compaction entry on the active branch, the same source used by `/context-status`. Only a live held claim creates an expectation that context-aware writes: no-Fabric, refused, faulted, released, and other non-held states leave Fabric or Pi in charge and do not warn. While the claim is held, a summary written by Fabric's engine or another extension produces one warning per session. A named extension is shown only when its bounded metadata name contains no control, format, line/paragraph separator, surrogate, or private-use characters; otherwise it is reported as `another extension`. A `fromHook: true` entry with missing or non-object details is also a valid unnamed extension commit and warns. Context-aware's own summaries, Fabric fallbacks carrying `claimOwner: "pi-context-aware"`, Pi's intentional last-resort summary, and truly malformed metadata do not warn. `/context-status` and the typed context snapshot report the newest committed writer.

The claim is withdrawn, and pi-fabric's compactor compacts again, when `enabled` becomes `false` (at the next turn or settled boundary), when the session shuts down, when the extension unloads, and when an action fails for a reason other than its input, returns a result pi-fabric would reject, or runs past pi-fabric's 30-second bound. A call that the calling program cancels keeps the claim. After such a failure context-aware does not claim again until the next session. Another extension that already holds the claim keeps it; context-aware does not take it over and does not ask again until the next session.

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

### When Pi has not measured the context size

Right after a compaction or an overflow recovery, Pi reports no context size until the next valid assistant reply. context-aware treats that size as unknown, not as empty and not as safe. While the size is unknown:

- A new threshold or generation-reserve check waits. It does not estimate the size, because an estimate could start a compaction that cannot shrink the session and then repeat. No drain, seed preparation, or compaction starts from an unknown size. The debug log records that the check is waiting for a measured size.
- A live owed-compaction marker is kept. A commit refused because an agent run was still in flight leaves a marker that is tied to the cooldown it set. While that same cooldown is still running, the idle boundary keeps both the marker and the cooldown, because an unknown size does not show that the session recovered.
- A stale marker does not survive. Once the cooldown that set the marker has expired, or a later cooldown (for example after a genuine failure) has replaced it, the next idle boundary discards the marker. This happens even when the size is still unknown.
- A measured size ends the wait. The next check then uses the normal threshold and reserve rules, including the cooldown.

The wait has no time limit of its own: the extension stays proactively idle until Pi reports a valid size. A measured size comes from Pi's own report or from the first later assistant reply that completed without an error and was not aborted; the usage on an error or aborted reply is partial and is not used. Waiting does not recover an overflow. While the size is unknown, recovery depends on Pi's native automatic compaction settings. If Pi's automatic compaction is turned off, nothing compacts the session until the size is measured or you run `/compact` or `compact_session` yourself.

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

## `modes`

Controls the model-facing `suggest_mode` tool. The default is `true`. Set
`modes.suggestTool` to `false`, or use
`--context-aware-modes-suggest-tool=off`, to hide the tool declaration. The
layered resolver applies the same default → global → project → CLI → session →
host precedence as the other leaves.

## `imageStripping`

Removes old images from each provider request. Off by default.

Shape:

```json
{
  "imageStripping": {
    "enabled": false,
    "keepRecent": 5
  }
}
```

When `enabled` is `true`, only the newest `keepRecent` image-bearing messages keep their images. `keepRecent` must be at least `1`, so the newest image always reaches the model. It counts request messages, not images: some providers put several tool results, and their images, into one message. Every older image is replaced in the request by a short text placeholder that names its type and size. Text, tool calls, and tool results stay. The session file is not changed, so every original stays recoverable.

The wire format is read from the request body, not from the session model's api. Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses bodies are supported, so stripping also works when the model api is a logical name such as `unified` or an alias such as `hypha-anthropic-oauth`. When stripping is enabled but a request body has another shape (for example Google `contents`), the request is sent unchanged and context-aware warns once per session. Only the first unsupported shape is reported: a later request with a different unsupported shape is also sent unchanged, without a new warning. The warning is shown again after the session restarts.

While billion-context-pi manages context in the session, stripping stays inactive and context-aware says so once. `/context-status` shows the effective state on its `Image stripping:` line.

## `contextPolicy`

Says how the session keeps its history. This release has one value:

```ts
"summaries"
```

`"summaries"` is the default: the model folds older ranges into summaries, and
the originals stay recoverable. Other values come in later releases.

An unsupported value never changes the policy:

- `/context-policy <value>` refuses it with an error and records nothing.
- A session or host policy entry that carries it is ignored, and the policy
  keeps the value from the layers below.
- A global or project file that carries it is ignored the same way.

`/context-policy status` and the typed service report an ignored value as a
diagnostic, and `/context-status layers` lists it under "Ignored as invalid".

The policy is stored in the session's `context-aware.policy.v1` entries and is
read from the current branch path. It follows the branch when you move with
`/tree`, and a resumed session reads the same entries, so a restart returns the
same value. There is no CLI flag for it.

The policy is not a mode. It is separate from the `/mode` runtime, and nothing
switches it automatically. Other extensions can read it through the `policy`
capability of the [context service](context-service.md#context-policy).

### Commands

```text
/context-policy status
/context-policy summaries
```

`/context-policy summaries` records the value as a session override on the
current branch.

## `folds`

Controls whether a native fold can replace the session's first user message
(pi-context-aware#130). It applies to both live plans and shadow previews.

```json
{
  "folds": {
    "firstUserMessage": "keep",
    "firstUserMessageMaxTokens": 8000,
    "condensedSkills": false
  }
}
```

- `keep` (default): keep the original opening user. Move the summary carrier to
  the next covered entry. Drop an opening-only range with a reported reason.
- `fold`: allow the opening user to fold, as in the earlier native engine.
- `keep-under-tokens`: keep the opening user unless its estimated size exceeds
  `firstUserMessageMaxTokens`. Equality keeps it. The kernel's token estimate
  counts CJK characters individually and other characters at four per token.

`condensedSkills` defaults to `false`. When `true`, a native fold replaces a
skill block that has a captured `condensed.md` with that condensed text, and a
compaction resends each skill still in use in condensed form. It stays off by
default until a replay comparison shows agents still follow a skill's hard
rules after the swap. See [skills.md](skills.md#condensed-skills).

`firstUserMessageMaxTokens` defaults to `8000` and must be a positive whole
number. It affects only `keep-under-tokens`. A folded opening is replaced by a
user-role summary, so a user message still precedes the first assistant in the
rendered request. The original remains in the session file.

Each key resolves independently through global, project, session, and host
layers. There is no CLI flag or setter command. For session policy entries,
use the dotted keys `folds.firstUserMessage`,
`folds.firstUserMessageMaxTokens` and `folds.condensedSkills`.
`/context-policy status` shows their effective values and sources. A
settings change affects subsequent plans; it does not undo folds already
stored in the session. The first two keys' effective values participate in the
parity fingerprint, so changing either starts a new 500-call window.
`condensedSkills` joins the fingerprint only when it is `true`, so turning it
on starts a new window and leaving it off keeps existing fingerprints.

## `pressureTelemetry`

`pressureTelemetry.mode` controls how much context-pressure telemetry the model sees. It exists so pilot runs can compare a band-only envelope with no telemetry. The default is `"full"`.

- `"full"` keeps the existing envelope with the pressure band, rounded usage percentage, approximate headroom, and action.
- `"band"` keeps only the pressure band and action.
- `"off"` removes the pressure envelope and its pressure rules from the model-visible prompt. Task state, the session brief, restart notices, recall guidance, and footer status are unchanged. With no envelope, the turn's hidden message is the task-state or restart-notice message rather than the usage marker, so it carries no usage details.

The leaf participates in global, trusted-project, session-policy, and host-policy precedence. Invalid values are ignored and the next lower layer supplies the value.

## `pressureLadder`

The pressure ladder is one set of context-usage thresholds. It belongs to the
context policy, and the telemetry bands are derived from it.

```json
{
  "pressureLadder": {
    "foldNudgeStartFraction": 0.45,
    "foldNudgeEndFraction": 0.75,
    "seededCompactionFraction": 0.9,
    "recoverableHideFraction": 0.95
  }
}
```

These are starting defaults and may change after pilot runs.

| Ladder step | Setting | Default | Telemetry band | Telemetry action |
| --- | --- | --- | --- | --- |
| Below the ladder | — | under 45% | `OK` | none |
| Fold nudges | `foldNudgeStartFraction` to `foldNudgeEndFraction` | 45% to 75% | `WARN`, from `foldNudgeStartFraction` | `gate-broad-work` |
| Between the last fold nudge and compaction | — | 75% to 90% | `WARN` | `gate-broad-work` |
| Seeded compaction | `seededCompactionFraction` | 90% | `URGENT`, from `seededCompactionFraction` | `compact-before-tool` when `compact_session` is reachable; otherwise `finish-atomic-work` |
| Recoverable hide, only when compaction cannot run | `recoverableHideFraction` | 95% | `URGENT` | `compress-before-tool` when the replacement is reachable; otherwise `finish-atomic-work` |

So the band edges are:

- `WARN` begins at `foldNudgeStartFraction`.
- `URGENT` begins at `seededCompactionFraction`.

When Pi has not measured the context size, for example right after a
compaction or an overflow, the band is `UNKNOWN` and maps to no ladder step.
The envelope then reports `band="UNKNOWN"` with no action. With
`pressureTelemetry.mode` set to `"full"` it also reports
`usage-percent="unknown"` and `approximate-headroom="unknown"`; with `"off"`
there is no envelope. The footer shows `size unknown`. The ladder applies
again once a measured size arrives.

The same edges drive the `<context-telemetry>` envelope, the `Bands:` line in
the context-awareness guidance, the footer icon, and the `band` field of the
typed service snapshot. Before the ladder, these bands were fixed at 60% and
80%.

The snapshot's `pressure.phaseBoundary` compaction advice also follows these
edges: it is `not-advised` below WARN, `advised` in WARN, and `required` in
URGENT. With the new defaults, 50% changes from `not-advised` to `advised`,
and 85% changes from `required` to `advised`. This affects consumers of the
existing snapshot field even if they do not use the new `policy` capability.

In this release only the telemetry bands and phase-boundary advice read the
ladder. Proactive compaction still triggers at
`proactiveCompaction.thresholdFraction`, which defaults to
78%. Fold nudges and the recoverable hide are not acted on yet.

Each value must be a number greater than 0 and at most 1. A value outside that
range is ignored, like any other invalid setting, and a lower layer supplies
it. The resolved values must also keep their order: `foldNudgeStartFraction`
≤ `foldNudgeEndFraction` ≤ `seededCompactionFraction` ≤
`recoverableHideFraction`. When they do not, the whole ladder falls back to
the defaults and `/context-policy status` shows a diagnostic.

The ladder participates in the global, project, session, and host-policy
layers. There is no CLI flag or setter command for it.

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

