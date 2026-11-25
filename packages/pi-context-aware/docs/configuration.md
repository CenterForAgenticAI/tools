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

### Prompt-cache guard

The guard is off by default. Enable it in a config layer:

```json
{ "cacheGuard": { "enabled": true, "askAboveUsd": 0.01, "interactive": "auto", "askTimeoutMs": 60000 } }
```

`askAboveUsd` is a non-negative dollar amount, default `0.01`. At the first request
of a user turn, a session where a person is at the terminal asks before a predicted
break above this amount. Continue sends the request unchanged. Decline stops the
turn; it never restores old rules or tools. Headless sessions, Fabric child
sessions and tool-loop requests only log a record. The last log-only report is
also shown in the UI status line.

The guard never holds an unattended session:

- `interactive` decides where it asks. `"auto"` (default) asks only when Pi
  reports the `tui` run mode. Pi's RPC mode reports a UI, but its dialogs go to a
  host (a web UI, for example) that may have nobody watching and sets no timeout,
  so under RPC the guard only logs. A Pi that reports no run mode keeps the old
  rule: ask whenever it has a UI. `"never"` always logs only. `"always"` asks in
  every session that has a UI, including RPC; Fabric child sessions still only log.
- `askTimeoutMs` (integer, at least `1000`, default `60000`) bounds every ask.
  When nobody answers in time, the guard dismisses the dialog and sends the
  request as is, as if the user had chosen Continue. A timeout is not a decline.
  A dialog that fails the same way sends the request.

The session record's `timedOut` field says an ask ran out of time.

On models without mid-conversation system messages, date, cwd, mode-line and
skill-listing sections retain their first-sent system text. Updates arrive as
conversation-tail data instead. When compaction or pruning drops the message an
update followed, the current value is sent again after the newest message. Rules, unrecognized sections and tool permissions
are not frozen. Turning the guard off leaves requests unchanged.

Each prediction records `context-aware.cache-guard.v1` in the session, including
the cause, changed sections, estimated lost tokens, extra write cost and whether
the user was asked. Names in reports are bounded one-line data. Whole-prompt
replacements have no extension attribution when Pi does not expose it.

The estimate compares request blocks and uses registry pricing: lost prefix
tokens × (cache write price − cache read price). Tokens are estimated from text,
not billed usage. Provider eviction is invisible. Continuation requests report
unknown when the transport exposes a previous response or thread identifier;
transport changes made after the hook cannot be observed.

### Host-owned skill loading

Hosts that already own skill reads can prevent this extension from registering
`load_skill`:

```sh
PI_CONTEXT_AWARE_DISABLE_LOAD_SKILL=1 pi
```

The value `1` disables registration; unset or `0` keeps the standalone default.
Each extension instance reads this process policy before Pi assembles its tool
catalog. Project/session settings cannot override it. Recreate existing
extension instances to apply a changed value.

SDK sessions observe the environment when their factories run. Hosts must also
forward the variable to separately spawned workers; a foreground
`--exclude-tools` flag does not configure a separate SDK session.

The opt-out registers no loader and does not change active tools, preserving
unrelated deferred tools on resume. The outgoing context boundary uses the
host's canonical `read` tool in matching extension-generated skill guidance.
This covers both new and saved condensed/stub blocks, including older captures
when new condensation is off. Stored text, rule bodies and user-authored
lookalikes stay unchanged. The host must provide `read`.

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
    "thresholdFraction": 0.9,
    "outputReserveTokens": 32768
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

The durable workstream switches are intentionally conservative: authority, registry, and activity integration are enabled by default; cmux is capability-gated and activity logging to cmux remains opt-in. Registry files are private projections under `~/.pi/agent/session-registry/v1/`; transcript custom entries remain authoritative. This package hands an optional `/sessions jump` to a launcher, but does not route intercom messages, create/select/clean up worktrees, launch terminals, or construct terminal commands.

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

The config file accepts only these two. `autonomous` is a preset, not a stored
`seedMode` value (`src/platform/config-layers.ts` rejects it in the file). Set it
with `--context-aware-mode autonomous` or `/context-aware-seed-mode autonomous`
for the current session. It turns on auto-gen, seed rewrite and
`always-proceed` ambiguity together, and `/context-aware-seed-mode status`
reports it while those settings hold.

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

Controls what a refused compaction handoff costs.

Before a generated handoff is used, a
deterministic check—a fixed-rule check rather than another model
judgement—compares it with the authority already in the session.

Every `context_compact` seed is a generated handoff, because the agent writes
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
| `project-switch` | Blocking for generated handoffs when a canonical GitLab reference or repository-root path names an ungrounded project. Advisory for explicit seeds, whose exact seed text, or command invocation text, remains operative. Also advisory, outside `enforce`, for the seed the agent itself passes to `context_compact`: a coordinator's handoff names other projects it read about in tool output, which the user's own messages rarely repeat. |
| `objective-switch` | Blocking. The candidate both introduces new objective terms and explicitly says to switch, replace, abandon, or start a different task, objective, project, repository, deliverable, or focus. A negated switch (`do not switch repository`), a switch back (`switch back to layout`), and text inside inline code spans do not count. |
| `side-effect-authority-change` | Blocking for generated handoffs. An explicit generated claim added, removed, weakened, or misattributed local-edit, local-commit, remote-Git-write, provider-metadata-write, or named-target authority, in a direction that permits more than the grounded surface. |
| `side-effect-restriction` | Advisory. An explicit generated claim forbids something the grounded surface left unstated or allowed. A restriction cannot widen what the agent may do, so it does not refuse the handoff, and it never becomes grounded authority for a later compaction. |
| `mutation-authority-escalation` | Advisory. The legacy lexical permission snapshot remains telemetry only; it does not refuse a handoff. |
| `forged-role-turn` | Blocking for generated handoffs. A line of the candidate presents itself as a turn: a bracketed role name as Pi prints a conversation (`[User]: `, `[System]: `, `[Assistant]: `, `[Tool result]: `, with any bracket, decoration, lookalike letters or colon), a role tag such as `<user>`, a chat-template token such as `<|im_start|>`, or a turn name alone on its line. Such a line would reach the next phase as if someone had said it. A line that starts with `(quoted)`, prose about the user, and a bare `User: ...` line that reports what the user said do not count. The finding names the line number, role and form, never the line's text. Only the user's own typing is exempt: a line of a seed typed into `/compact-then`, or of the text approved in the seed approval editor. When `seedRewrite` rewrites a typed seed, every line the rewrite adds is checked, and a line it copies verbatim from the typed seed is not. A refused rewrite falls back to the typed seed. In `warn`, a `context_compact` seed with this finding is not kept with a note: it is replaced by the fallback, as for `cache-origin`. A protocol handoff request whose `nextPhaseSeed` carries such a line is refused with `INVALID_REQUEST` (caair/pi/pi-context-aware#474). |

A delivery marker records a hash of the message it announces, so a prompt the user types between the marker and that message still counts as user authority. Markers from older sessions have no hash and keep first-in-first-out pairing. A refusal's `authorityGuardGroundingMessages` lists, for each user message, its position, where its authority came from (`typed`, `delivery-marker-authoritative`, `delivery-marker-generated` or `generated-seed-echo`) and a hash of its text, never the text.

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
claim as generated. An explicit generated delta that permits more—an added
permission, a removed or weakened restriction, a target change, or a source
misattribution—is refused. A delta that only forbids more is reported as
`side-effect-restriction` and does not refuse the handoff. A `do not`, `don't`,
`never`, `without` or `nor` that leads a list applies to every item in it, so
"do not kill terminals, close workspaces, change files or Git state" forbids
changing files; the list ends at a sentence break or a turn word such as `but`,
`then`, `instead` or `until`.
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

For a seed the agent passes to `context_compact`, a refusal is reported and
the agent's handoff is kept. The delivered handoff starts with a note that
lists the findings and tells the agent to follow the user where the handoff
differs from what the user asked. The kept handoff is not recorded as accepted
provenance, so nothing in it becomes authority for a later compaction. When
`seedRewrite` is on and the rewritten seed is refused, the agent's own seed is
checked and used instead, with the same note if it has findings of its own. A
`cache-origin` or `forged-role-turn` finding in the kept seed still uses the
fallback below; a `forged-role-turn` finding only in the rewrite falls back to
the agent's own seed, which is checked on its own.

For other generated compaction handoffs, such as proactive preparation, a
refusal is reported and replaced with current
durable workstream state when available. The
rejected generated side-effect claim is never copied into the operative fallback.
Without that state, a fixed neutral prompt resumes only from the current
compaction summary and asks for clarification if no authorized next step is
clear. Earlier onboarding prompts, earlier compaction prompts, and unrelated
workflows are never fallback sources. The compaction still happens.

### `enforce`

In an interactive flow, a refusal stops the compaction and asks you for an
approved seed. This gives the strongest protection against a drifted objective,
at the cost of a session that cannot compact until you answer. Non-interactive
proactive preparation cannot ask; it uses the same current-durable-state or
neutral summary fallback described under `warn` so the session does not cross
its context safety boundary.

### `off`

The check does not run. No refusal reason is produced. Compaction uses its
ordinary prompt.

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
implementation version. Accepted generated-delivery
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

`enabled` defaults to `true`, preserving the existing summary, context-cache, transcript-reference, and workstream augmentation behavior. Set it to `false` when another extension owns summarization. In that mode context-aware does not claim unrelated threshold or manual compactions and never supplies a summary. If ownership changes after context-aware already initiated a proactive compaction, it may return `{ "cancel": true }` only to cancel that stale context-aware attempt and its generated handoff. Telemetry, recall, the focus projections, and the other non-summary features remain available. The task list and the focus belong to pi-workstream and do not depend on this switch.

Context-aware's explicit handoff flows depend on its summary contract, so while summarization is deferred, neither `context_compact` nor `/compact-then` is registered. Registration normally happens at extension load. When the current project's `.pi/context-aware.json` sets `summarizer.enabled`, it waits for `session_start`, because only a session can tell whether that project is trusted. The context-awareness guidance, telemetry actions, and check-in prompt stop telling the agent to compact. Telemetry, `context_recall` and the focus projections stay available. A `summarizer.enabled: false` set by a session policy entry after load cannot unregister the tool, so it still fails before starting compaction and tells you to set `summarizer.enabled` to `true`. Use the other compactor's own handoff command while this switch is off.

An extension that cancels every compaction, such as `billion-context-pi`, has the same effect on these surfaces without any setting. Context-aware detects it at session start and hides `context_compact` instead of unregistering it. See [compaction blocked by another extension](commands-and-concepts.md#compaction-blocked-by-another-extension).

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

`enabled` defaults to `false`. With it off, context-aware sends nothing to pi-fabric and compaction behaves exactly as it did before this setting existed. Leave it off while `billion-context-pi` is in the profile: that extension stays the only live context manager until it is removed, and the claim is meant to be turned on at that point. Turning it on while `billion-context-pi` is loaded does nothing, because context-aware cannot compact there. Both `enabled` and `fabricFallback`, like `summarizer.enabled`, are ignored in an untrusted project's `.pi/context-aware.json`.

With `enabled: true`, context-aware sends one claim on the `pi-fabric:compaction-owner:v1` channel at `session_start`. It names `pi-context-aware`, its version, and the actions it supports: `request`, `status`, `pressure`, `carry` and `cancel`. pi-fabric may answer during the send or a little later, because it loads its claim code on the first claim. Until it answers, the claim is pending: it is not held, pi-fabric's own compactor keeps compacting, and no second claim is sent. If nobody answers within 5 seconds, context-aware cancels the claim, treats pi-fabric as not loaded for that session, and nothing changes: Pi's own summarizer runs as usual. A grant that arrives after that, or after the setting is turned off, the session ends or a new session starts, is withdrawn at once. The next session asks again. The claim does not take `/tree` branch summaries; pi-fabric keeps those.

While the claim is held:

- pi-fabric's compactor, its threshold trigger and its threshold deferral stand down. context-aware writes the summary alone.
- `compact.request` queues a compaction at the next settled boundary. Its `instructions`, `reason`, `requestedBy` and `preserve` list become focus text for the summary. A `seed` starts the next phase: after the compaction commits, context-aware sends it as a labelled custom message that starts a turn, never as a user message. A request without a seed sends nothing. A new request replaces one that has not started, as pi-fabric's own controller does; while a compaction is running, a request is refused. `compact.cancel` drops a request that has not started.
- Each action checks its own arguments with pi-fabric's limits (for example, a seed of at most 8192 characters and lists of at most 16 items), because any extension on the event bus can call the actions directly.
- `compact.carry` keeps a short list of facts (at most 16 items, each at most 2048 characters) that every summary keeps until the list is cleared. Each call returns the whole list, and pi-fabric refuses an action result over 16 KiB, so a change that would make the list larger than that as JSON is refused and nothing is written. The list is stored in the session file, so it follows the branch, and it is written into the summary's Constraints section. At the claim, context-aware takes over the list pi-fabric already held.
- `compact.pressure` reports the stage of the [pressure ladder](#pressureladder) and its four thresholds. `compact.status` reports whether the fallback is on, the carry count, and any queued request.
- The model that writes the summary also sees an index of the active folds: each fold's topic, range and message refs, with a pointer to `context_recall` for the original text.

`fabricFallback` decides what happens when the model summary fails or no model is available. With `true` (the default), the summary comes from pi-fabric's deterministic compactor, which also renders the carry list. With `false`, or when pi-fabric cannot produce one, context-aware returns no result and Pi's own summarizer runs. This also applies when overflow recovery or transient retries are exhausted: without the claim context-aware cancels the compaction in those cases, but while the claim is held pi-fabric has stood down, so a cancel would leave nobody to compact. Only if both fail is the last step of the [pressure ladder](#pressureladder), at `recoverableHideFraction` (95%), left to act. That step is not the recoverable hide the policy promises: it is the fold engine's emergency truncation of the request, which shortens large old messages and tells you so. See [What the last step does](#what-the-last-step-does).

After each committed compaction, context-aware reads the newest compaction entry on the active branch, the same source used by `/context-status`. Only a live held claim creates an expectation that context-aware writes: no-Fabric, refused, faulted, released, and other non-held states leave Fabric or Pi in charge and do not warn. While the claim is held, a summary written by Fabric's engine or another extension produces one warning per session. A named extension is shown only when its bounded metadata name contains no control, format, line/paragraph separator, surrogate, or private-use characters; otherwise it is reported as `another extension`. A `fromHook: true` entry with missing or non-object details is also a valid unnamed extension commit and warns. Context-aware's own summaries, Fabric fallbacks carrying `claimOwner: "pi-context-aware"`, Pi's intentional last-resort summary, and truly malformed metadata do not warn. `/context-status`, the typed context snapshot and the `context_status` tool report the newest committed writer. The tool's `compactions` view (also part of a call with no view) prints `Last committed compaction writer: <name>`, or `none` when the branch has no compaction, from the same observation as `/context-status`. Its `details` carry the same value as `writer: { kind, name }`, and each listed boundary carries the writer of that compaction.

The claim is withdrawn, and pi-fabric's compactor compacts again, when `enabled` becomes `false` (at the next turn or settled boundary), when the session shuts down, when the extension unloads, and when an action fails for a reason other than its input, returns a result pi-fabric would reject, or runs past pi-fabric's 30-second bound. A call that the calling program cancels keeps the claim. After such a failure context-aware does not claim again until the next session. Another extension that already holds the claim keeps it; context-aware does not take it over and does not ask again until the next session. Only a refusal that names that holder counts as another owner. pi-fabric also refuses without naming one, for example when the claim's signal was already aborted, pi-fabric is shutting down, or its owner code failed to load; such a refusal is treated as no claim, as when pi-fabric is not loaded, and context-aware keeps folding and writing its own summary.

While another owner holds the claim, context-aware leaves compaction to it (the one-writer rule of the context strategy contract, limited to compaction):

- `session_before_compact` returns no result, so that owner writes the summary.
- `context_compact` is refused with one line that tells the model to continue the task, because that owner compacts when the context fills.
- The fold nudge and the pressure note do not offer `context_compact`, so the model is not told to compact and then refused.

Folds are not affected: `context_fold`, replayed and queued folds, and the emergency hides of the last ladder step work as they do without the claim.

## `proactiveCompaction`

Controls context-aware’s proactive compact+handoff loop.

Shape:

```json
{
  "proactiveCompaction": {
    "enabled": true,
    "thresholdFraction": 0.9,
    "outputReserveTokens": 32768,
    "preparationStallTimeoutMs": 30000,
    "preparationFirstOutputGraceMs": 90000,
    "commitDrainTimeoutMs": 10000
  }
}
```

When enabled, after each provider-completed assistant turn, context-aware:

1. reads current usage including trailing tool results;
2. computes a usable generation reserve as `min(outputReserveTokens, model.maxTokens) + 2,048 protocol-overhead tokens` (bounded by the context window). `model.maxTokens` is the model's real maximum output; `outputReserveTokens` is only the cap (see "How much reply space is held back" below);
3. triggers when either `thresholdFraction` is crossed or headroom is below that reserve. `thresholdFraction` is a share of the full context window. When no layer sets it, it follows the pressure ladder's `seededCompactionFraction` (90% by default), held to the 25%–95% range this setting accepts. A value you set in any layer wins over the ladder, and `/context-status` shows which one applies;
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

The wait has no time limit of its own: the extension stays proactively idle until Pi reports a valid size. A measured size comes from Pi's own report or from the first later assistant reply that completed without an error and was not aborted; the usage on an error or aborted reply is partial and is not used. Waiting does not recover an overflow. While the size is unknown, recovery depends on Pi's native automatic compaction settings. If Pi's automatic compaction is turned off, nothing compacts the session until the size is measured or you run `/compact` or `context_compact` yourself.

The check runs after normal, tool-use, length-limited, and error turns, but not after a user-aborted turn. This matters for internal tool loops: Pi can otherwise proceed directly from a large tool result to another provider request without reaching an outer user-message boundary. Generation-reserve and threshold triggers share the proactive-compaction cooldown, whose full duration restarts when compaction completes. This prevents an ineffective compaction from immediately re-arming the provider drain. The separate one-shot output-limit recovery carries explicit state from the discarded length-limited response into its turn completion, so it may cross the ordinary proactive cooldown once without restoring a general generation-reserve exemption.

Current Pi releases may enter one final provider-stream setup after a tool-loop abort. During that cancellation drain, context-aware temporarily exposes no tools and replaces the provider context with a single synthetic cancellation message, so the original transcript and tool result cannot reach a side-effect-capable follow-up. The transient response is discarded, the exact active-tool set is restored after settlement, and compaction then runs once. Discarding that response replaces its prose only: any tool call it carried is kept, because Pi applies the replacement in place on the message object that agent state and the running loop share, and a tool that is already executing still delivers a result that needs its tool call to be there. During session shutdown/reload, the sanitizer gets one bounded grace period to catch that drain before tools are restored; an abort-ignoring provider cannot hold shutdown open. Shutdown, reload, resume, fork, and session replacement abort pending preparation and invalidate its runtime owner; queued/running callbacks from that owner cannot send a handoff or update stale UI in the new session.

### Committing only against a quiet session

Generating a summary takes minutes, and idleness at queue time does not survive that wait: a message arriving inside the window starts a new agent run. Pi applies a compaction by replacing `agent.state.messages`, and a running agent loop reads a copy of that array taken when the run started, so a commit landing mid-run reduces nothing while the transcript records a boundary the live context never crossed (issue #55).

Liveness is therefore re-checked when the summary is ready to commit, not only when the work was queued:

- **No run in flight.** The prepared boundary is returned unchanged and nothing is aborted. This includes Pi's own automatic compaction after a run has ended, where the session still reports itself busy but no loop holds the array.
- **A run that started during summarization.** When no run was going as the compaction began, a run found at commit time came from a wake message (a `tmux-job` completion or an intercom message). It is waited for, not aborted, for up to five minutes, and the wait counts as no refused attempt. A run that outlives the five minutes is ended as in the next item.
- **A run in flight.** The run is ended through the same provider drain the trigger path uses, and the commit waits up to `commitDrainTimeoutMs` for that run to finish before applying the boundary.
- **A run that outlives the budget.** The compaction is refused: Pi records no compaction entry, the extension reports it as unapplied rather than completed, the generated summary is retained so a retry on the same branch does not pay for it twice, and the work is queued again for the next idle boundary. After two refusals in a row the notice says so and the compaction stays queued with a fresh two-attempt budget; it runs at the next idle boundary, never in a tight loop. If it still does not apply, run `/compact` once the session is idle. The stop text of an interrupted turn names its real cause: a threshold trip, or a queued compaction being applied.

Verify a real reduction the way the issue's evidence was gathered: on the assistant messages either side of a compaction entry, a boundary that landed shows `cacheRead` dropping to `0` with a large `cacheWrite` (a rebuilt prefix), while a boundary that changed nothing shows `cacheRead` continuing with a small incremental `cacheWrite`.

`commitDrainTimeoutMs` defaults to `10000` (10 seconds); ending a run is signal-based and normally unwinds in milliseconds. Raise it for sessions whose tool calls take longer to unwind, or set `0` to never wait and always re-queue instead.

`outputReserveTokens` defaults to `32768` and is configurable independently of the percentage threshold. It is a cap on the reply space the trigger holds back, not the amount itself: the amount is the model's own maximum output when that is smaller. `preparationStallTimeoutMs` defaults to `30000` (30 seconds) after text output begins. `preparationFirstOutputGraceMs` defaults to `90000` (90 seconds) so reasoning models can think before their first text token. Both values are resolved through the normal configuration layers and appear with provenance in `/context-status` and the typed service snapshot. The absolute five-minute ceiling bounds total preparation even while thinking or text events continue. It is an intended generation allowance, not a promise that every response will use that many tokens. Models advertising a smaller maximum output automatically use the smaller limit; models advertising a larger maximum still use the configured allowance unless you raise it.

### Commands

```text
/context-aware-proactive status
/context-aware-proactive on
/context-aware-proactive off
/context-aware-proactive 85%
/context-aware-proactive 0.8
/context-aware-proactive reserve 16384
/context-aware-proactive reserve=32k
/context-aware-proactive stall 30s
/context-aware-proactive first-output 90s
/context-aware-proactive commit-drain 10s
```

Thresholds accept either fractions (`0.85`) or percentages (`85`, `85%`). Valid range is 25%–95%. Setting one writes `proactiveCompaction.thresholdFraction` to the config file and so pins it: the ladder no longer moves it. Other commands that save the config file leave an unset threshold unset. Reserve values accept exact tokens or `k`/`m` suffixes. Stall, first-output and commit-drain values accept milliseconds, seconds, or minutes (for example, `stall 30s`, `first-output 90s` and `commit-drain 10s`); only commit-drain accepts `0`, meaning never wait for an in-flight run. The equivalent ephemeral CLI override is `--context-aware-proactive reserve=32k`.

The status output includes the effective values, their sources, and the current proactive lifecycle (`idle`, `pending`, `generating`, `queued`, `compacting`, `cooldown`, `failed`, or `cancelled`). It also shows the most recent proactive failure while a static fallback or cooldown remains active. A CLI threshold sets only `enabled` and `thresholdFraction`; a CLI reserve sets only `outputReserveTokens`. Unnamed values continue to come from their own winning layers, so the summary source can be `mixed`. Run `/context-status layers` for the full six-layer attribution.

## `modes`

Controls the model-facing `suggest_mode` tool. The default is `true`. Set
`modes.suggestTool` to `false`, or use
`--context-aware-modes-suggest-tool=off`, to hide the tool declaration. The
layered resolver applies the same default → global → project → CLI → session →
host precedence as the other leaves.

## `operatorRequests`

Tracks each message you type until the agent answers it, so a reply is not lost among event turns from callbacks, herdr panes or Fabric workers. On by default.

```json
{
  "operatorRequests": { "enabled": true, "sources": ["interactive"] }
}
```

- `sources` lists the Pi input sources that open a request: `"interactive"` (typed in the TUI) and `"rpc"` (sent by an RPC client). The default is `["interactive"]`. An RPC client is often a program, such as an orchestrator or a test harness, so its prompts open no request, get no reminder and get no extra turn unless you add `"rpc"`, for example when the RPC client is a person's front end. A list with any other value is rejected and the default applies. Messages other extensions send with `pi.sendUserMessage()` are never requests.
- Herdr: an overseer agent that prompts this session through its Herdr pane types into the TUI, so its input arrives as `interactive` and cannot be told apart from you typing. Such a prompt opens a request like yours, and the agent answers whoever typed.
- An input is matched to the message Pi saves for it by its text. A typed skill (`/skill:name args`) is matched to Pi's expansion of that skill with those args. A typed prompt template is not tracked: its expanded text comes from the template file, so it cannot be shown to come from what you typed.
- A request is answered by the first assistant reply after it that has text and ends the turn. A reply that ends on a tool call does not answer it.
- A reply that ends on a tool call and has at least 160 characters of text (after trimming) marks the request *in progress*: the model reported where the work stands and is still working. A one-line preamble such as "Let me check the code." stays below that floor and leaves the request open. The latest such reply is kept as the request's progress update. An in-progress request is still unanswered: a later reply that ends the turn answers it, as above.
- While a request is open and an event turn came after it, each model call carries a hidden reminder naming it. For an in-progress request it reads `Operator request in progress (14 min, last update 2 min ago). The operator wrote: "..." Keep working on it and report back to the operator when it is done; do not switch to unrelated work.`, so it never tells the agent to stop the requested work; an open request keeps `Answer it before continuing other work`. One reminder can list both kinds. Up to three open requests are listed, newest first; when more are open, a last line says how many older ones were left out (`2 older open requests not shown; /requests lists them.`). The reminder quotes each request on one line, with control characters and every Unicode format character (`\p{Cf}`: bidi controls, zero-width characters, the soft hyphen and the tag characters U+E0000-E007F, which can carry hidden text) removed, cut at 300 characters. It is not saved to the session, and the provider's cache breakpoint is moved to the block before it, as for the pressure line, so the reminder never stops the prompt cache from being reused.
- When the model ends a run with a request still open, the agent gets one more turn to reply; its note lists requests the same way as the reminder, including the left-out line. An in-progress request counts as unanswered here too: a run the model ends without a final reply still gets this one turn. A run that a tool ended, such as `context_compact` queuing a compaction, gets none, and the request stays open for the next run. An aborted run gets none either, and the request stays open. Pi reports every abort the same way, whether you pressed Esc or code stopped the run (this extension stops runs to compact), so an abort never closes a request.
- A line below the editor shows `your request is open (4m)`, `working on your request (14m) · update 2m ago` while it is in progress, or `last reply to you 12m ago · 7 event turns since · /requests` once event turns follow the answer.
- `/requests` opens an overlay listing every request on the branch, newest first. Each row shows its state (`open`, `in progress` or `answered`), its age, its first line, and for an answered request the event turns since the answer. Up and Down select, Enter opens the full request and its full answer (or its latest progress update while it is in progress), scrollable with Up, Down, Page Up and Page Down. Esc goes back to the list, and Esc on the list closes it. `/requests 2` opens with the second-newest selected. Opening, browsing and closing add nothing to the session. `/requests` replaced `/reply`, which no longer exists.
- Without a TUI, for example in RPC mode, `/requests [n]` shows the n-th newest request and its answer as a notice instead, at most 60 lines and 4,000 characters of an answer and 2,000 characters of a request, with a line saying what was cut.
- Both views remove control characters and every Unicode format character from the text they show.

The ledger is rebuilt from the session branch, so it survives a restart and follows `/tree`. Sessions without a UI, such as Fabric workers, do not track requests.

## `contextMetrics`

Records one line of numbers per model request, so the cut-over step 5 and pilot sessions can be compared afterwards. On by default. It records only while this extension runs the folds; while billion-context-pi manages context, nothing is written.

Shape:

```json
{
  "contextMetrics": {
    "enabled": true,
    "maxBytes": 4194304,
    "maxDirBytes": 67108864
  }
}
```

The file is `<agent dir>/context-aware/metrics/v1/<session-id>.jsonl`, mode 0600 in a directory only you can use; a symlinked or foreign-owned path is refused. Each line is a record with `v: 4` holding: time, session id, branch leaf id, model id, window; tokens before and after the per-turn pass, pressure fraction and ladder band (`ok`, `warn`, `urgent`); the kind of nudge sent; emergency truncation and hide counts; folds requested, accepted, refused and dropped during that request (counts by reason code; `refused` and `dropped` are breakdowns, not request counts, so a refusal with several reasons counts once under each, and a refusal with no code and no error text counts as `unknown`); a compaction that committed during that request (writer; `trigger`: `tool` for the model's `context_compact`, or for a `compact.request` a code-mode program sends through Fabric while this package holds the compaction claim, `proactive` for a threshold, this package's or Pi's, `overflow` for Pi's overflow recovery, `operator` for a person's `/compact`, or `other`, such as another extension's handoff; tokens before and after); `folds.freedTokens`, the tokens the folds written for that request freed (each fold's hidden tokens less its summary's, never below 0 per fold); `steer`, the wording that request's fold nudge and `context_fold` guideline were chosen in (`default`, `compact-boundary` or `fold-first`, see `by-model-v1` under [assign](#assign)), or null when nothing reported it; the previous turn's provider usage (input, output, cache read, cache write); the session's strategy (`strategy`: the methods, where they came from (`strategy.methods`, `folds.engine` or `auto`), the shadow method lists and the guidance); each stage that acted on the request, or on a compaction asked for during it (`stages`: trigger `request` or `compaction`, `recipe`, the method set the stage ran for, such as `fold+compact`, role `active` or `shadow`, stage, outcome `applied`, `shadowed`, `refused`, `deferred`, `unapplied` or `failed`, and the refusal codes), at most 32, with `stagesOmitted` counting the rest; and `recalls`, the `context_recall` calls by reference during the request that returned a fold's or a hide's entries. A shadow list's plan is never applied: its stages carry role `shadow` and outcome `shadowed` or `refused`, so they never count as the session's own. Every method, method set, stage, outcome and code is copied from a closed list; any other value is written as `other`. Version 3 records (pi-context-aware#526) have no `steer`, `compaction.trigger` or `folds.freedTokens`. Version 2 records (pi-context-aware#473) name a recipe instead of methods: `folds-v1` ran fold and compact, `compaction-only-v1` ran compact. Version 1 records, written before pi-context-aware#473, have no strategy, stages or recalls. The writer is `context-aware`, `fabric`, `extension`, `pi`, `malformed` or `none`; older records may also say `other` or `unknown`. Pi reports no token count until an assistant replies after a compaction, so the record waits for the first measured count and holds it as `tokensAfter`. It is never estimated. After three records with no measured count it is written with `tokensAfter: null`. Each field is copied by name and checked. No message text, summary, tool argument or error text is written.

When a file would pass `maxBytes`, the oldest records are dropped first. When the directory would pass `maxDirBytes`, the oldest other session files are removed. `/session-erase` removes the session's file.

The default is on for every profile. Profile-specific defaults are not implemented; set `contextMetrics.enabled` to `false` to switch it off.

Summarise a set of sessions with `node <package dir>/scripts/context-metrics-summary.mjs [--json] [--source <source>]... <metrics-dir | file.jsonl>...` (`<package dir>` is the installed package, `node_modules/<package name>`; in a source checkout the path is `scripts/context-metrics-summary.mjs`; add `--json` for machine output). Per session it reports folds, refusal reasons, pressure at each fold, compactions and cache-read share, listing at most 100 sessions. Then, per strategy (pi-context-aware#473), which is the set of methods the sessions ran (pi-context-aware#526), such as `fold+compact`, it reports sessions by source and by guidance, turns (a turn is one model request), cost per turn, tokens per turn, the cache hit ratio `cacheRead / (cacheRead + cacheWrite + input)`, folds, compactions, emergency truncations, refusals by code (folds, the session's own plans, and shadow plans apart), stage outcomes, and recall after hide (fold recalls per accepted fold, and hide recalls). Cost is priced per request from the model registry Pi installs, `@earendil-works/pi-ai`, through the strategy bench's price book; a turn whose model the registry does not price is counted as unpriced and left out of the average, and when the registry cannot be loaded nothing is priced. Version 1 records count as `fold+compact` from the source `legacy`; version 2 records count `folds-v1` as `fold+compact` and `compaction-only-v1` as `compact`, so records of every version that ran the same methods share a row. `--source` keeps only the sources it names (`strategy.methods`, `folds.engine`, `auto`, `legacy` or `other`, and `strategy.recipe` or `strategy.assign` for version 2 records; repeat it for several), so `--source strategy.methods` compares sessions whose methods were set explicitly. A torn last line, records of another version and records whose session id is malformed are skipped. An id or code read from a record is shown only when it is a plain lower-case name, otherwise as `other`, and long lists end with a count of what was left out. The first 64 method sets get a row each and later sets count under `other`; the printed summary shows the 8 strategies with the most turns and counts the rest, and it is cut at 131072 characters with a marker. `--json` holds every row.

The summary then compares guidance arms (pi-context-aware#459). Give each store with `--store <host>=<metrics-dir | file.jsonl>`, repeated for several hosts; the host label is 1 to 32 lower-case letters, digits, `.`, `_` or `-`, and a path given without `--store` is labelled `local`. A session is one unit per host, so the same session id on two hosts counts twice, and it joins the arm of its majority guidance and majority model (ties go to the first name in sort order). The 8 models with the most sessions get arms of their own; the rest share `other`. Per arm it reports sessions per host; the primary, which is the session-mean cost per priced turn from the session's first exposure (a fold nudge, an accepted fold or a compaction), counting only exposed sessions with at least `--min-turns` priced turns (default 10); intention to treat, the same over every priced turn of every session with that many priced turns; the modelled compaction summary cost, which both include; the shares of freed tokens shed by folds (`folds.freedTokens`), by the model's own `context_compact` and by other compactions (tokens before less tokens after); the `steer` counts; and the guardrails: fold recalls per accepted fold, emergency truncations and plan refusals per 100 turns, and the share of sessions with enough priced turns that were exposed. A compaction summary is modelled at the request's model price from the `@earendil-works/pi-ai` registry: `tokensBefore` at the list input price, uncached, and `tokensAfter` at the list output price, an upper bound of the summary. Records before version 4 carry no trigger, so their compactions count as other compactions, and no freed fold tokens. For each model with sessions in both `default` and `by-model-v1`, it prints the ratio of the arms' primary means, `by-model-v1` over `default`, with a 95% bootstrap interval that resamples sessions within each host (`--iterations`, default 2000, at most 10000; `--seed`, default 459; no interval while an arm has fewer than 2 analysed sessions), the intention-to-treat ratio, and the guardrail checks: a breach is recalls per fold above 1.5 times `default`'s, emergency truncations or plan refusals per 100 turns above 2 times `default`'s and at least 1 per 100 turns (so a single event over a `default` of 0 is no breach), or exposure shares more than 10 points apart. It then prints the design's decision for that model: `below minimum sample` while either arm has fewer analysed sessions than the minimum (150 for a model whose id's last `/` segment starts with `claude-opus-`, 50 for `gpt-`, 150 for any other; set one with `--min-sessions <opus|gpt|other>=<n>`, repeated per family); `reject` at a ratio of 1.15 or more with the interval's lower bound above 1.0; `win` at a ratio of 0.85 or less with the interval's upper bound below 1.0, an intention-to-treat ratio below 1.0 and no guardrail breach; otherwise `no change`. At most 18 arms are printed, and the text is cut at 131072 characters with a marker.

`--guardrails-only` prints only the arms' session counts, `steer` counts and guardrails, with the guardrail checks, and leaves out every other arm difference: costs, ratios, intervals, freed-token shares and the decision. Use it for the weekly check while the sample is below its minimum. With `--json` it writes only `hosts`, `arms` and `comparisons` with those fields.

A record is written once its request is over, so a fold asked for after request N is counted in record N, with the pressure of that request, and the last request of a session is written when the session ends. Files written before this change count each fold one record late, so a summary over old and new files mixes the two.

In a record, `folds.tiers` is `null` when the recorder did not learn the tier of each fold (the fold engine does not report it today), and a list of tiers (1 to 3) when it did; `[]` means the source reported that no fold was made. Records written before this distinction carry `[]` where the tiers were unknown, so read an empty list in an older file as unknown. Readers accept both forms; that change kept the record version at 1.

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

## `toolOutputCap`

Head-truncates the text of a tool result that is larger than `maxBytes` and appends one notice. It protects the context from a runaway MCP or extension result. Default on.

```json
{
  "toolOutputCap": {
    "maxBytes": 50000,
    "skipTools": ["bash", "read", "grep", "find", "ls", "fabric_exec", "load_skill"]
  }
}
```

- `maxBytes` counts UTF-8 bytes of the text parts. `0` turns the cap off. The cut never splits a character. Images pass through. A result that already carries the notice, or that Pi reports as truncated, is not cut again.
- `skipTools` lists tools that are never capped: the ones that cap their own output, plus `load_skill` (a skill body can be longer than the cap) and `fabric_exec`. An empty list caps every tool.
- Calls made inside a Fabric or Jev program (ids `fabric_…`, `jev:…`, `component:…`, `<parent>/<n>`) are never capped, because no model reads them.
- An untrusted project's `.pi/context-aware.json` cannot set `maxBytes` or `skipTools`.

## `repetitionGuard`

Appends a warning to the result when the model makes the same direct tool call three times in a row with identical arguments. Warn only: no call is ever blocked or aborted. On by default.

```json
{
  "repetitionGuard": { "enabled": true }
}
```

- The count covers the model's own calls. Calls inside a Fabric or Jev program (ids `fabric_…`, `jev:…`, `component:…`, `<parent>/<n>`) are never counted and do not break the model's run.
- A changed argument, a different tool, or new user input starts the count again.
- Set `enabled` to `false` to turn the guard off. This replaces billion-context-pi's guard, which aborted the turn at five repeats and ended polling Fabric programs (pi-context-aware#169).

## `overflowRecovery`

After a real main-turn context overflow, requests one compaction at the next idle point. Default on.

```json
{
  "overflowRecovery": { "enabled": true }
}
```

- An overflow is what pi-ai's `isContextOverflow` reports for the assistant message. Throttles, 429s, quota and network errors do not count.
- It acts only when Pi's own automatic compaction is off (Pi recovers an overflow itself when it is on) and no compaction is already running.
- It runs once. If the next reply also overflows, the error is shown and no second compaction starts. A reply that succeeds ends the episode.
- It learns no context window and reserves no headroom: `proactiveCompaction.outputReserveTokens` already does the second.
- An untrusted project's `.pi/context-aware.json` cannot switch it off.

## `entryPressure`

Counts the entries on the branch path since the last compaction and treats too many as pressure, whatever the token usage. Default on, with a limit of 30,000 entries.

```json
{
  "entryPressure": { "enabled": true, "maxEntriesSinceCompaction": 30000 }
}
```

- Folds keep token usage low, but every hidden entry stays on the path Pi walks to rebuild the context, and only a compaction starts that path again. A session that folds for hours and never compacts can grow past what Pi can rebuild: one session crashed at 65,000 to 80,000 entries after its last compaction (pi-context-aware#441).
- At the limit, proactive compaction starts at the next checkpoint with the trigger `entry-count`, even at 5% usage. It follows the same rules as the threshold trigger: `proactiveCompaction.enabled`, the cooldown, and a measured size.
- At the limit, the request's pressure is `URGENT` and its action line names the entry count as the reason: in `full` mode it gives the count and the limit, as `URGENT (31000 entries since the last compaction, at the limit of 30000; 5% used, …)`, and in `band` mode it says `URGENT (entry count at its limit)`. The line asks for `context_compact`; a fold adds entries, so when `context_compact` cannot be called the line names no fold. The footer shows the entry count, and `context_status` reports `entriesSinceCompaction` and `entryLimit` in its pressure view.
- `maxEntriesSinceCompaction` must be a whole number of at least 1,000. The default leaves about half the entry count of the crash above.
- An untrusted project's `.pi/context-aware.json` cannot change either leaf.

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
    "condensedSkills": false,
    "engine": "auto"
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

`engine` defaults to `auto`: the native folds run unless billion-context-pi is
loaded, and then compaction alone runs with the native folds in shadow. `folds`
and `compaction-only` force one engine. It is a debugging and rollback switch,
not a context policy. It is read only while `strategy.methods` is `auto`: `folds`
gives both methods and `compaction-only` gives `compact` alone (see
[`strategy`](#strategy)). When `folds` is forced while billion-context-pi is loaded,
the setting wins and `context_status` shows a warning. The engine is chosen once
per session, so a change applies at the next session start or reload.
`context_status` and the service snapshot report it as `engine`.

`firstUserMessageMaxTokens` defaults to `8000` and must be a positive whole
number. It affects only `keep-under-tokens`. A folded opening is replaced by a
user-role summary, so a user message still precedes the first assistant in the
rendered request. The original remains in the session file.

Each key resolves independently through global, trusted-project, session, and
host layers. An untrusted project's `.pi/context-aware.json` cannot set any
`folds` leaf (pi-context-aware#525): the agent working in a project can write
that file. There is no CLI flag or setter command. For session policy entries,
use the dotted keys `folds.firstUserMessage`,
`folds.firstUserMessageMaxTokens` and `folds.condensedSkills`.
`/context-policy status` shows their effective values and sources. A
settings change affects subsequent plans; it does not undo folds already
stored in the session. The first two keys' effective values participate in the
parity fingerprint, so changing either starts a new 500-call window.
`condensedSkills` joins the fingerprint only when it is `true`, so turning it
on starts a new window and leaving it off keeps existing fingerprints.

## `strategy`

Both methods are on by default: a session folds and compacts, as it always
has. The exception is a session with billion-context-pi loaded: it runs
`compact` alone, because billion-context-pi does the folding.
`strategy.methods` lists the context methods a session runs, so you can turn
one off (pi-context-aware#526). Leave it out and nothing changes.

To compare methods, give different profiles or projects different `methods`
lists, or add other lists to `shadow`, which checks and records their plans
without applying them. `assign` never changes a session's methods.

```json
{
  "strategy": {
    "methods": "auto",
    "shadow": [],
    "assign": { "guidance": [], "seed": "" }
  }
}
```

There are two methods today:

- `fold`: the model folds finished parts of the conversation into short
  summaries with `context_fold`, and the growth nudge reminds it to.
- `compact`: the model can end a phase with `context_compact` and a seed prompt
  for the next one, and this package writes the compaction summary, carrying
  that seed.

Compaction at the threshold and on overflow happens with or without `compact`.
Without it, Pi writes its own summary.

The pressure note, which tells the model how full the context is at `WARN` and
`URGENT`, belongs to no method. It runs in every session.

### `methods`

- `auto` (the default) runs `fold` and `compact`. While billion-context-pi is
  loaded it runs `compact` alone, because billion-context-pi does the folding.
  The released `folds.engine` setting still works while `methods` is `auto`:
  `folds` gives both methods, and `compaction-only` gives `compact` alone.
- A list, such as `["fold", "compact"]` or `["compact"]`, runs exactly those
  methods, together. Any list of known methods works, as long as it names at
  least one and none twice. A list wins over `folds.engine` and over
  billion-context-pi presence. When the list includes `fold` while
  billion-context-pi is loaded, the list wins and `context_status` shows a
  warning.

Leaving a method out removes what it brings. Without `fold`, `context_fold` is
not offered and the native folds write nothing. Without `compact`,
`context_compact` stays registered but hidden, and a call to it is refused with
one line. No text this package sends the model names it: not the nudges, the
pressure note, the context tools section of the system prompt, the check-in,
the `context_fold` guidelines or a `context_fold` refusal. This holds in a Fabric
code-mode session too, where the model can still reach the hidden tool through
`fabric_exec`.

The methods run together as one recipe, composed from the list: first each
method's nudge, then the pressure note, then each method's tool. One stage loop
runs that recipe, and one plan checker settles every plan, whichever method made
it (ADR 0002). The list order sets the order of the methods within each of those
groups; with today's two methods it changes nothing a session sends.

A mistake is reported, never guessed at. Session start shows an error notice,
and `context_status` shows the same lines. Each problem gets one line that names
the setting and the known methods; after three, the rest are counted on one
line.

- An unknown method, a method listed twice, or an empty list: the list is
  ignored, a last line says which methods the session runs instead, and the
  session runs what `auto` would choose.
- A value that is not a list of names, such as `"fold"`: that one file's or
  policy entry's value is skipped, and another layer's valid list applies.
  With no valid list in any layer, the session runs what `auto` would choose.

Names used by the strategy bench, such as `folds-v1` or an `external/`
strategy, are not methods.

A project's own `.pi/context-aware.json` sets `methods` and `shadow` only
while the project is trusted (pi-context-aware#525). An untrusted project's file
is ignored for every `strategy` leaf, and a value it sets is not reported as an
error either. Set them for an untrusted project in the global file or a
session or host policy entry.

`strategy.recipe` and `strategy.assign.recipes` no longer exist. A file that
still sets either gets an error notice that names the setting to use instead, and
the value is ignored.

### `shadow`

`shadow` lists method lists that run beside the session's methods, such as
`[["compact"]]`. They see the same view of each request. Their plans are checked
and recorded, never applied, so the session file and every request are the same
as without them. A list equal to the session's own, or a repeated one, is
skipped. A list with an unknown or repeated method, or an empty list, is
reported like a mistake in `methods` and does not run. A value that is not a
list of method lists is reported and skipped, and another layer's valid value
applies.

### `assign`

`assign` never changes a session's methods: every session keeps every method its
settings list. It draws what an experiment varies between new sessions: the
guidance, meaning how the methods word what they tell the model. There are two
guidance variants:

- `default`: today's wording.
- `by-model-v1` (pi-context-aware#459): the request's model chooses the wording,
  against each model's lean. A model id whose last `/` segment starts with
  `claude-opus-` (case-insensitive) is told to compact at a finished phase: the
  fold nudge's rule for choosing between the tools says to compact with
  `context_compact` when a phase of the work is finished and to fold within a
  running phase, and the `context_fold` guideline that names `context_compact`
  reads "If context_compact is available and a phase is finished, compact rather
  than fold that phase range by range. Fold within a running phase." A model id
  whose last segment starts with `gpt-` is told to fold first: the rule says to
  fold each finished range and to compact only when the work moves to a new phase
  and most of the context is already fold summaries, and the guideline reads
  "Prefer folding. If context_compact is available, use it only at a phase
  boundary, when most of the context is already fold summaries and folding again
  frees too little." Every
  other model, and a request with no model, gets the `default` wording, so its
  sessions are an A/A check.

`by-model-v1` changes only those two texts, and only while the session runs both
methods: with `strategy.methods` `["fold"]` or `["compact"]` the nudge and the
guidelines name only the method's own tool, as under `default`. A session that
cannot call `context_compact`, such as a Fabric child whose allowlist leaves it
out, gets the `default` nudge and guideline, so it is never told to use a tool it
cannot reach. The `context_compact` tool description and every other text stay as they are. The
guideline is part of the tool guidance, so it stays the same between requests of
one session. When the model changes mid-session, the guideline and the next
nudge follow the new model; a model switch already starts a new prompt cache, so
the change adds no cache write of its own. The metrics record names, in `steer`,
the wording the guidance chose for the request's model and the session's
methods; a session that could not reach `context_compact` still records that
choice, though its texts were the `default` ones.

`assign.guidance` lists the guidance ids to draw from (default empty: nothing is
drawn). `assign.seed` is 1 to 64 letters, digits and `._:-`, and is required. A
list of one is a fixed assignment, and a repeated id weighs its variant. The list
holds at most 16 ids, repeats included; a longer list is an error at session
start and in `context_status`, and draws nothing. The draw takes the first four
bytes of `sha256(<seed> + "\n" + <session id>)` as an unsigned big-endian
integer, modulo the length of the list, as the index into the list. The same seed
and session list always give the same assignment; check one with
`printf '%s\n%s' <seed> <session id> | shasum -a 256`.

Only a new session is drawn: one whose branch holds no message yet. The draw is
written into the session as a `context-aware.strategy-assignment.v2` entry, which
the model never sees, so a resumed session, and a fork, keep their guidance when
the seed or the list changes later. A `context-aware.strategy-assignment.v1`
entry, which recorded a recipe before this change, is ignored, and the debug log
notes it once per session start. A project's own `.pi/context-aware.json` sets
`assign` only while the project is trusted. An unknown guidance id is reported
and is not drawn; `assign.guidance` without a seed is reported and draws nothing.

### What `context_status` shows

The methods are chosen once per session, so a change applies at the next session
start or reload. The folds view of `context_status` reports them on one line,
with where they came from: `Methods: fold, compact (the default).`,
`Methods: compact (billion-context-pi is loaded).`,
`Methods: compact (from strategy.methods).` or `(from folds.engine)`. Beside it
are `Guidance: default.`, `Shadow:` with the shadow lists or `none`, any error
lines, and an `Assignment:` line when one was drawn, naming the seed, the list,
the session the draw was made for, and whether the session records it. The
context service snapshot reports `methods`, and `engine`, which is `folds` while
`fold` is among the methods and `compaction-only` otherwise.

The stages read a view of each request. If that view cannot be built, the
failure is counted in `context_status` as the stage `view` with the outcome
`failed`, and the debug log records the error. The request still carries the
fold nudge and the pressure note, checked against the tools the session can
call, as it did before recipes existed. A compaction goes ahead as Pi asked,
unless another extension holds the compaction claim.

## `pressureTelemetry`

`pressureTelemetry.mode` sets what the pressure action line shows at `WARN` and `URGENT` (pi-context-aware#461). The default is `"full"`. No value adds anything at `OK`, and no value adds rules to the system prompt or persists a message.

- `"full"`: the band, the rounded usage percentage and the approximate headroom, then the action.
- `"band"`: the band and the action.
- `"off"`: no action line. The fold nudge is unchanged. Contributed texts (pi-workstream places its focus and task list this way), restart notices, recall guidance and the footer are unchanged.

The setting keeps its three values so existing configuration still loads. Its default is open in pi-context-aware#460, which the pilot's `"off"` result informs.

The leaf participates in global, trusted-project, session-policy, and host-policy precedence. Invalid values are ignored and the next lower layer supplies the value.

## `pressureLadder`

The pressure ladder is one set of context-usage thresholds. It belongs to the
context policy, and the pressure bands are derived from it.

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

| Ladder step | Setting | Default | Band | Action line |
| --- | --- | --- | --- | --- |
| Below the ladder | — | under 45% | `OK` | none: nothing is injected |
| Fold nudges, first-sight and growth (see the note below the table) | `foldNudgeStartFraction` to `foldNudgeEndFraction` | 45% to 75% | `WARN`, from `foldNudgeStartFraction` | keep the next action small, fold or compact, or delegate |
| Between the last fold nudge and compaction | — | 75% to 90% | `WARN` | keep the next action small, fold or compact, or delegate |
| Seeded compaction | `seededCompactionFraction` | 90% | `URGENT`, from `seededCompactionFraction` | call `context_compact` before the next tool call when it is reachable; else fold with `context_fold`; else finish the atomic work |
| Last step: recoverable hide (shorten with a `context_recall` pointer, saved at the next boundary) | `recoverableHideFraction` | 95% | `URGENT` | as above; with neither context tool, billion-context-pi's `compress` when it is reachable |

The fold-nudge row gives the band, not every nudge. The fold pass also sends a growth nudge at any usage, below 45% too: once at least 50,000 tokens of foldable content are waiting and the context has grown by 22,500 tokens since the last nudge (the engine's `nudge.growthFloor` and `nudge.minGrowthRatio`). A nudge is sent only when the session can call `context_fold` or `context_compact`, and it names only the tools it can call.

So the band edges are:

- `WARN` begins at `foldNudgeStartFraction`.
- `URGENT` begins at `seededCompactionFraction`.

When nothing counted the request, the band is `UNKNOWN` and maps to no
ladder step: Pi has not measured the size, for example right after a
compaction or an overflow, and the fold pass did not run. Nothing is
injected. When the fold pass runs, it counts the request it builds, so the band
comes from that count even before Pi measures the size; proactive compaction
still waits for a measured size. The footer shows `size unknown` until then.

The same edges drive the action line, the footer icon, the per-request
metrics record and the `band` field of the typed service snapshot. Before the
ladder, these bands were fixed at 60% and 80%.

The snapshot's `pressure.phaseBoundary` compaction advice also follows these
edges: it is `not-advised` below WARN, `advised` in WARN, and `required` in
URGENT. With the new defaults, 50% changes from `not-advised` to `advised`,
and 85% changes from `required` to `advised`. This affects consumers of the
existing snapshot field even if they do not use the new `policy` capability.

### What each step drives

The ladder is the one source of truth. Every step is a share of the **context
window**, the same denominator for all of them:

| Ladder value | Drives |
| --- | --- |
| `foldNudgeStartFraction` | The `WARN` band, and the first-sight nudge (the kernel's `nudge.minContextLimitPct`): from here, a session that already holds 50,000 foldable tokens and has had no nudge is nudged at once instead of waiting for growth. It does not gate the growth nudge, which can fire below it (see the note under the ladder table). |
| `foldNudgeEndFraction` | The over-limit nudge (`nudge.maxContextLimitPct`): from here the nudge skips the growth wait and is sent whenever a fold would reclaim enough to matter. |
| `seededCompactionFraction` | Proactive compaction, unless `proactiveCompaction.thresholdFraction` is set (below), and the `URGENT` band. |
| `recoverableHideFraction` | The emergency nudge (`nudge.emergencyThresholdPct`) and the emergency truncation (`truncate.threshold`). |

Change a value in `pressureLadder` and the nudges, compaction and the last step
all move with it. An engine setting passed in code still beats the ladder.
`proactiveCompaction.thresholdFraction`, when set in any layer, beats the
ladder for compaction only. The fold nudges and the last step have no setting of
their own.

**Why the window.** Telemetry, proactive compaction and the ladder settings
already read the full window, and a share of the window is what a person means
by "90% full". The fold pass used to take each step as a share of a smaller
limit, the window less the model's output reserve (at most a quarter of it).
That made one percentage mean different token counts in different places, and
on models with a large output cap the 95% truncation ran before the 90%
compaction. The output reserve now has its own control, the generation-reserve
trigger of proactive compaction (`outputReserveTokens`), which compacts when
headroom for a reply runs short. It no longer moves the fold steps.

**How much reply space is held back.** The generation-reserve trigger holds back
`min(outputReserveTokens, the model's maximum output) + 2,048` tokens. The first term is the
model's real limit, so a model that can write 8,000 tokens holds back 8,000, not a fixed figure.
The default cap is 32,768 tokens, about 25,000 words in a single reply. Without a cap, a model
with a 128,000-token output limit would start compaction when 47% of a 272,000-token window was
used, for a reply that is almost never that long. A cap of 32,768 keeps 87% or more of a window
that size usable and still leaves room for a long reply. Raise it (`/context-aware-proactive reserve 64k`)
if your work routinely asks for very long single replies.

Worked examples from the pinned model data (`@earendil-works/pi-ai` 1.5.0), with the default cap:

| Model | Window | Maximum output | Held back (cap + 2,048) | Trigger fires above | Window left usable |
| --- | --- | --- | --- | --- | --- |
| openai gpt-5.2 | 400,000 | 128,000 | 34,816 | 365,184 | 91% |
| openai gpt-5.5 | 272,000 | 128,000 | 34,816 | 237,184 | 87% |
| anthropic claude-opus-4-5 | 200,000 | 64,000 | 34,816 | 165,184 | 83% |
| anthropic claude-opus-4-8 | 1,000,000 | 128,000 | 34,816 | 965,184 | 97% |
| google gemini-2.5-pro | 1,048,576 | 65,536 | 34,816 | 1,013,760 | 97% |

The trigger is checked only after a completed turn, and not for a worker role, a Fabric child,
or during the cooldown. In those cases the per-request fold steps are the only guard, so a
very large output limit on a model that can fill the rest of the window in one reply can still
overrun between checks. The fold steps are fractions of the whole window and do not hold back
a reply.

If a layer sets the ladder out of order the whole ladder falls back to the
defaults, so the nudges, compaction and the last step all use the defaults
together.

### What the last step does

At `recoverableHideFraction` the fold engine runs a **recoverable hide**
(pi-context-aware#268). It runs whenever usage reaches the step. It is not gated on
whether compaction can run; this replaces the "only when compaction cannot run"
wording of pi-context-aware#114 and #129.

The hide picks the same messages the fold engine's emergency truncation picks: large
old tool results, and large old user and assistant messages, outside the newest few
messages. Fold summaries are never touched. Each picked message keeps its first and
last 2,000 characters and the `[truncated for context space]` marker, plus a pointer line:

```text
[Recover the original with context_recall({ ref: "h1" }).]
```

How it runs:

- On the first request above the step, the message is shortened in that request only,
  as emergency truncation always did, and the engine queues it.
- At the next boundary (`turn_end` or `agent_before_settle`) the engine writes, for each
  queued message, a `context-aware.hide.v1` custom entry (ids `h1`, `h2`, ...) and a
  `context_edit` that replaces the message with the shortened text and the pointer line.
  From then on Pi applies the hide to every request, and it does not repeat.
- `context_recall({ ref: "h1" })` returns the original entry, read from the session, in
  pages. The hide stays in place.
- A hide is not a fold. The fold engine does not count it, nudge about it, number it
  among the `b<N>` blocks or absorb it into a higher tier. A later fold that covers a hidden
  message ends the hide: the fold's summary replaces it.
- If Pi refuses a hide at the boundary, it is left out; the fold drafts and the other hides
  still go through, the session stays consistent, and the next request above the step
  queues it again.
- The session file keeps every original. Nothing is deleted.

It is no longer silent. Each time it acts:

- one line goes to `context-aware-debug.log` on every request at or above the
  step: `fold pass: emergency truncation usage=… threshold=… tokens=…/… truncated=N`,
  with `skipped="…"` when it found nothing to shorten and `terminal-escape` when
  the engine reports that nothing it does can bring the session under the limit;
- one warning is shown in the interface for each of three events, once per
  stretch above the step: messages were shortened, shortening ran and reclaimed
  nothing, and the context is stuck (no range worth folding, nothing to
  shorten, three requests in a row). The notice repeats only after usage has
  dropped below the step and risen again. The terminal escape stays the last resort.

Without an interface the log line is the only record.

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

