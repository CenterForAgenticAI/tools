# Agent definitions

This reference is for agent authors who need every supported frontmatter field, discovery rule, and nested-delegation control.

## Agent definition frontmatter

This section is the field inventory. For the authoring judgement around it —
which scope to write to, `replace` vs `append`, how to select extension tools,
which fields are inert in which delegation shape, and why an agent file
silently fails to register — load the `authoring-delegate-agents` skill.

Standard pi-subagents fields:

- `name`, `description` (required)
- `tools` (YAML array; entries prefixed `mcp:` are split into MCP direct
  tools; `ext:<owner>[#<module>]:<tool>[:<action>]` selects one registered extension tool and
  `ext:<extension>` selects all tools from that extension; default:
  `read,bash,edit,write` from the host)
- `model` (e.g. `anthropic/claude-haiku-4-5`; default: main agent's model).
  A **bare** id (`gpt-5.6-luna`, no `provider/` prefix) resolves through the
  `unified` logical provider when the catalog has one, so it inherits
  multi-account failover, cooldown, and account priority. An explicit
  `provider/id` pins that one physical route with no failover.
- `fallbackModels` (YAML array of model refs tried in order if `model`
  is unavailable or returns a prompt-time content refusal; a bare entry gets
  the same unified-first resolution as `model`)
- `thinking` (`off` | `minimal` | `low` | `medium` | `high` | `xhigh`)
- `thinkingMin` / `thinkingMax` (optional session-local adaptive-thinking
  bounds from the same level domain; a declared `thinking` must lie within the
  effective range)
- `systemPromptMode` (`append` | `replace`; default `replace`)
- `inheritProjectContext` (default `false`)
- `inheritSkills` (default `false`)
- `skills` (YAML array of skill names)
- `extensions` (YAML array of extension paths; additive to inherited Pi extensions)
- `env` (JSON object of string values or `null`; default environment patch)
- `extensionInclude` (YAML array of portable extension selectors to require)
- `extensionExclude` (YAML array of portable extension selectors to remove)


An optional worker extension can record a repaired opening prompt before fallback. `pi-delegate` reads only the versioned `prompt-repair` record. It shows the refusal and prompt diff in the run transcript and result, then gives the final revised prompt to the next configured fallback model. Replacement sessions are ineligible, so repairs run only on the original selected model. Without a compatible extension, fallback behavior is unchanged.
Snake_case aliases and CSV list values remain readable for legacy files, but are deprecated. Canonical files use camelCase field names and YAML arrays. The management input API is different: `config` for `action: "create"` and `action: "update"` accepts arrays or `false` for list fields; on create, `false` leaves that field absent, and on update, it clears an existing field. CSV strings are rejected there.

### Portable extension policy and exact extension tools

Workers inherit Pi's configured extensions. The legacy `extensions:` field is
unchanged: it **adds** paths and is never an allowlist. Use the optional policy
fields when an agent must name or remove an extension portably:

```yaml
extensions: [/absolute/dev-only/extra-extension.ts]
extensionInclude: [adaptive-thinking]
extensionExclude: [pi-delegate]
tools: [read, bash, ext:adaptive-thinking:set_thinking_effort]
```

`extensionInclude` validates that every selector resolves in the inherited plus
additive discovered set; it does not create an exact/isolation mode.
`extensionExclude` is applied last and wins if the same extension is included
and excluded. Missing or ambiguous selectors fail closed with the discovered
matches in the diagnostic. Explicit empty lists (`extensionInclude: []` and
`extensionExclude: []`) are no-ops.

Portable identities are derived in this order:

1. nearest `package.json` `name` (for example `@acme/adaptive-thinking`);
2. canonical source (`npm:@scope/pkg` or ref-independent
   `git:github.com/org/repo`) when a package name is not unique;
3. `#<package-relative-entrypoint>` when one package provides multiple
   extensions (for example
   `git:github.com/org/repo#extensions/guard.ts`);
4. an absolute resolved path only as a compatibility fallback.

For local checkouts, `package.json.repository.url` is preferred over Git
`remote.origin.url`. SSH and HTTPS Git URLs normalize to the same `.git`- and
ref-free identity. Host aliases are only canonicalized when explicitly mapped;
an origin is an alias, not a trust proof.

Extension loading and tool exposure are separate. Loading an extension makes
its registrations available; an explicit `tools:` list still exposes only the
named builtins and `ext:` selections. Built-in tools are bare names. The
canonical extension grammar is:

```text
ext:<owner>[#<module>]:<tool>[:<action>]
```

After `ext:`, the owner ends at the first `#` or `:`. An optional kebab-case
module id ends at the next `:`. The first colon after the owner or module starts
the tool name. A second colon starts an action grant. Owners and module ids
never contain colons. Prefer a unique package name as the owner:

```yaml
tools: [read, bash, ext:adaptive-thinking:set_thinking_effort]
tools: [read, ext:@centerforagenticai/pi-delegate:delegate_control:status]
tools: [read, ext:@acme/multi-tools#guard-hooks:guard_check]
```

A package declares module ids in its own `package.json` under
`pi-delegate.modules`, for example `{ "guard-hooks": "./extensions/guard.js" }`.
Pi-delegate rejects absolute paths, `..` escapes, missing entrypoints, and
symlinks that resolve outside that package. When a package has several loaded
entrypoints, a package-only selector still resolves if exactly one same-package
entrypoint owns the requested tool. Use `#<module>` when that shortcut is
ambiguous or the tool registers lazily.

During the migration window, the old final-slash form
`ext:<owner>[#<entrypoint-path>]/<tool>[:<action>]` remains accepted silently and
resolves to the same bare tool name. `ext:<owner>` also remains accepted for a
whole-extension compatibility grant. New and serialized agent definitions use
the colon form. The old source-qualified example
`ext:git:github.com/acme/tools#extensions/guard.ts/guard_check` therefore remains
readable but is not the preferred authoring form.

Tool-owner disambiguation does not apply to `extensionInclude` or
`extensionExclude`; those policy selectors keep their portable-identity grammar.

Pi-delegate's own delegate-family tools also accept
`ext:@centerforagenticai/pi-delegate:delegate` and
`ext:@centerforagenticai/pi-delegate:delegate_control:status`. They use the same
nested-delegation policy as bare names: `allowNestedDelegate: true` remains mandatory for a
worker, and a qualified spelling never bypasses depth, action, escalation,
read-only, or write-confinement checks.

Selected extension tools may register lazily during `session_start` or
`before_agent_start`; direct, supervised-inner, and hosted workers make them
available without restarting the worker. `ext:` narrows the model-visible set
live. Loaded but unselected extensions still run their lifecycle handlers, but
their tools remain inactive and are vetoed if called during the first-turn
registration window. This narrows tool access; it is not process isolation and
does not prevent arbitrary side effects from a loaded extension.

A missing `ext:` owner fails worker construction with a
`[tool-selector:OWNER_NOT_FOUND]` diagnostic. It is never skipped, widened to Pi
defaults, or rebound to a same-named tool from another extension. A configured
candidate whose factory fails, or a provider removed by explicit extension
policy, also remains a setup error. Ambiguous selectors fail with
`OWNER_AMBIGUOUS` unless one eager, exact tool owner disambiguates matching
entrypoints as described above. A valid selector whose extension identity resolves
to one loaded entrypoint may name a tool that never registers; the tool remains unavailable
rather than widening the worker or failing early. This includes a package identity with one
matching loaded entrypoint. A `#module` selector preserves the same lazy behavior
when its package has multiple loaded entrypoints. Eager and late same-named ownership is
checked against the selected extension and fails closed. Workers without an explicit tool list
keep Pi's inherited/default behavior, while isolated or no-extension sessions retain a
static registry allowlist. Excluded extension entrypoints are removed before factory
import, so their handlers, commands, renderers, flags, shortcuts, and tools never
register. Use `extensionInclude` when an extension is required; missing or ambiguous
include selectors remain policy errors.

Selector failures always use the envelope `[tool-selector:<CODE>] …`. The codes
are `SELECTOR_MALFORMED`, `OWNER_NOT_FOUND`, `OWNER_AMBIGUOUS`,
`MODULE_UNKNOWN`, `TOOL_UNDECLARED`, and `PROVIDER_MISMATCH`. Every failure is
closed: no selector is passed to Pi's `setActiveTools()` or CLI `--tools` seam,
and no failure falls back to a built-in or default provider.

Pi currently exposes extension ownership for extension registrations, but not
an owning-extension back-reference for separately discovered skills, prompts,
or themes. Consequently `extensionExclude` does **not** attempt brittle
directory-prefix filtering of those resource types; package-level resource
policy needs an upstream Pi ownership API. Also, a hosted CLI worker using an
exact `ext:` selector preflights the selected (never excluded) factories in its
detached host to learn registered tool names before launching the Pi CLI, so
selected factories must tolerate initialization in both processes.

### Session-local adaptive-thinking bounds

A bounded worker can opt into adaptive thinking without broadening its tool
surface or rewriting machine-global settings:

```yaml
---
name: bounded-reviewer
thinking: high
thinkingMin: medium
thinkingMax: high
extensions: [/path/to/adaptive-thinking/index.ts]
tools: [read, bash, ext:adaptive-thinking:set_thinking_effort]
---
```

The worker starts at `thinking`, and compatible adaptive requests are clamped
to `thinkingMin..thinkingMax` independently for each worker session (including
`this_response`, `next_N`, and `until_changed` scopes). The `ext:` selector is
resolved only after that worker's actual extension loader finishes. Direct and
supervised in-process workers resolve against their complete loaded set (which
can include inherited/global extensions as well as agent-declared paths);
detached driver children use `--no-extensions` and resolve against only
their explicit consumer extensions. Extension identity errors and eager
ownership collisions fail closed. A valid exact tool selector may remain
unavailable until a lazy provider registers it; it never broadens the active
set. This prevents Pi's name-only allowlist from activating a same-named tool
from the wrong extension and does not activate unselected tools from the chosen
extension. An explicit allowlist that is empty, malformed, or reduced to no
usable tools fails before session/model construction rather than silently
widening to Pi's default tool surface.

Bounds are durable agent policy, but remain dormant when no adaptive-thinking
provider is loaded. If a loaded extension registers `set_thinking_effort` for a
bounded worker, it must acknowledge pi-delegate's session-local policy protocol
v1 (`pi-delegate:adaptive-thinking-policy` →
`adaptive-thinking:pi-delegate-policy-accepted`); an older or ambiguous provider
fails before model work instead of silently applying global bounds. Detached
driver performs the compatibility preflight in its runner and then
re-verifies the matching ACK and selected tool inside the authoritative Pi RPC
child before accepting input. The policy is stored in the worker session as a
`pi-delegate-thinking-policy` custom entry.
Pi-delegate never rewrites `~/.pi/agent/adaptive-thinking.json` or shared
process-global settings.

Precedence is agent frontmatter, then durable `agentOverrides`, then the current
invocation or chain-slot override. Every effective policy is revalidated after
patching. Agent management and invocation overrides accept `false` to clear
`thinking`, `thinkingMin`, or `thinkingMax`; frontmatter itself uses level
strings or omission.

Delegate extensions (all optional; canonical camelCase names):

- `defaultMaxRounds` — default total worker-message budget; the exact first turn counts
- `stopConditionHint` — natural-language cue included in the fork-clone's prompt
- `collapseMode` — `"final_output"` or `"summary"` default
- `summaryModel` — explicit model ref for summary collapse, or `"auto"` for the built-in `anthropic/claude-haiku-4-5`; omission makes zero summarizer provider calls and returns the supervisor hint verbatim. When the dispatch preflight warns that the effective reference is unavailable in the active registry or session scope, set per-run `summary_model`, agent frontmatter `summary_model`, or `delegateConfig.agentOverrides.<agent>.summaryModel` to an available `provider/model`; the preflight does not choose a fallback.
- `maxSubagentDepth` — recursive delegate depth cap; the default is a
  conservative 2, while a fresh root may explicitly request up to the hard
  ceiling of 16 (ordinary descendants may tighten but never relax the root's
  inherited cap)
- `allowNestedDelegate` — explicit opt-in for a plain worker session to
  receive delegate-family tools, whether that worker is launched directly or
  runs beneath a supervised fork's supervisor clone. Default is `false`:
  delegate tools listed in `tools:` are still stripped unless this is `true`.
- `nestedDelegateAgents` — optional YAML array child-agent allow-list enforced
  when this worker calls `delegate`.

Nested delegation remains **strip-by-default**. To let a direct worker call
delegate, set `allowNestedDelegate: true` and list exact trusted `pi-delegate`
extension selectors in `tools:` (for example
`ext:@centerforagenticai/pi-delegate:delegate` and optionally
`ext:@centerforagenticai/pi-delegate:delegate_control`, or a single action such
as `ext:@centerforagenticai/pi-delegate:delegate_control:status`). Bare
delegate-family
names remain accepted as input aliases but do not authorize a live registration.
If
`allowNestedDelegate: true` is set but `tools:` is absent, the worker keeps the
normal default tool surface (`read`, `bash`, `edit`, `write`) and receives no
delegate tools. When `nestedDelegateAgents` is absent, an opted-in worker may
delegate to any resolved agent; when present, attempts to spawn non-listed
agents fail before the nested run starts. All nested calls still run through the
existing `maxSubagentDepth` / lineage guard. Calls without an explicit root
policy remain capped at 2; a root agent configured for a deliberate deeper
workflow may raise that cap as high as 16.
A genuinely detached driver root retains its established minimum of 3,
including at its deliberate re-root boundary, but it also cannot exceed 16.
The opt-in therefore grants capability within a bounded tree rather than
unbounded fan-out.

Nested workers are intentionally **not** an agent-management surface: when a
delegate-owned worker calls `delegate`, read-only management actions (`list`,
`get`, `health`) are allowed, but `create`, `update`, `delete`, and
`canonicalize` are refused
before any agent/chain file is touched. This prevents an opted-in worker from
persisting a shadow agent or minting a new `allowNestedDelegate` /
`nestedDelegateAgents` policy that the parent did not authorize. The
`nestedDelegateAgents` allow-list is still bare-name only; after a name passes,
delegate resolves it using the normal discovery order. The allow-list does not
pin a source or file path, so avoid same-name overrides for allow-listed agents
unless that override is the intended target.

Unknown frontmatter fields are preserved in `extraFields` rather than
silently dropped.

Discovery searches (in order, later wins on name collisions):

- **Builtin scope**: bundled `builtin-agents/` snapshot containing `delegate` and
  `worker` (lowest priority)
- **Package scope**: Pi-aware packages found through normal cwd/package discovery plus installed roots listed by Pi's settings package manager; configured roots are additive to the normal package walk.
- **User scope**: `~/.pi/agent/agents/` then `~/.agents/`
- **Project scope**: nearest ancestor's `.agents/`, then `.agents/agents/`, then
  `.pi/agents/`. Agent and chain files use this order; later definitions win on
  duplicate names.

When graft and pi-delegate share a live Pi session, graft can synchronously emit
`pi-delegate:agent-capability-query:v1` with mutable request
`{ version: 1, cwd, scope: "both", names: string[] }`. Pi-delegate sets
`response` to `{ version: 1, agents, warnings }`; each requested name receives
an availability record with package/source/file metadata when available. A
builtin `worker` is therefore distinguishable from a package-provided
`graft-worker` by `source` and `packageName` without an extra classifier.
