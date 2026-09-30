---
name: authoring-pi-extensions
description: Write or change a Pi extension against the current public API — the extension entry shape, how package.json discovery fields are glob-expanded, the full lifecycle event list and what each handler may return, how before_agent_start chains the system prompt, how resources_discover contributes skills and prompts, and which surfaces are current rather than deprecated. Load before adding an event handler, command, flag, tool, or renderer to a Pi extension, and before trusting recollection of an event name or return shape.
load: recognition
---

# Authoring Pi extensions

Everything here is read from the installed typings of
`@earendil-works/pi-coding-agent`, at
`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`.
When this skill and that file disagree, the file wins — say so rather than
following a stale instruction.

## The entry shape

An extension is a module whose default export takes the extension API object.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("example", { /* ... */ });
}
```

A factory that returns that function works equally well, and is worth preferring
when the extension has injectable dependencies, because it gives tests a seam
without a module mock.

## Discovery is declared in package.json

Pi finds an extension through the `pi` field. All three paths are **glob
expanded**, so a directory pattern is legitimate:

```json
{
  "pi": {
    "extensions": ["./index.ts", "./modules/*/index.ts"],
    "skills": ["./skills", "./modules/*/skills"],
    "prompts": ["./prompts"]
  }
}
```

`skills` entries may be a `.md` file or a directory. Directories are recursively
scanned for `SKILL.md`; a directory containing `SKILL.md` is a skill root, so
that subtree is not scanned further. `prompts` entries may be a `.md` file or a
directory. Directories declared in `package.json` are recursively scanned for
`.md` prompt templates. Paths returned from `resources_discover` are passed
directly to the loaders: skill directories are recursive, while prompt
directories are scanned **non-recursively** for `.md` files.

The trap worth knowing: **`pi.skills` is resolved unconditionally.** There is no
per-flag or per-condition gate on that path. If a skill must only exist under
some condition, declaring it here is the wrong mechanism — contribute it from a
`resources_discover` handler instead.

## Registration surface

| Call | Purpose |
| --- | --- |
| `registerCommand(name, options)` | A slash command. `options` is `RegisteredCommand` without `name` and `sourceInfo`. |
| `registerFlag(name, options)` | A CLI flag. `options` is `{ description?, type: "boolean" \| "string", default? }`. |
| `getFlag(name)` | Reads it back: `boolean \| string \| undefined`. |
| `registerTool(tool)` | A tool the model may call. |
| `registerShortcut(key, options)` | A keyboard shortcut. |
| `registerMessageRenderer(customType, renderer)` | Renders a custom message. |
| `registerMarkdownTransformer(transformer)` | Synchronously transforms user, assistant, and thinking Markdown for display only. |
| `registerEntryRenderer(customType, renderer)` | Renders a custom entry. Custom entries never enter model context. |
| `sendMessage(message, options?)` | Sends a custom message into the session. |

Flags share **one global namespace across every loaded extension**. A collision
is diagnosed and precedence follows load order, so namespace anything that is
not obviously yours.

## Lifecycle events

Register with `pi.on(event, handler)`. Only the events listed here exist; do not
invent neighbours by analogy.

Events that accept a **result** that changes behaviour:

| Event | Result | Effect |
| --- | --- | --- |
| `project_trust` | `ProjectTrustEventResult` | Must return `trusted: "yes" | "no" | "undecided"`; the optional `remember?` field is available for the decision. |
| `before_agent_start` | `BeforeAgentStartEventResult` | `systemPrompt` replaces the prompt for the turn; chains across extensions. Also accepts `message`. |
| `input` | `InputEventResult` | `{ action: "continue" }`, `{ action: "transform", text, images? }`, or `{ action: "handled" }`. |
| `context` | `ContextEventResult` | `messages` replaces the context messages. |
| `tool_call` | `ToolCallEventResult` | `block?` can stop execution, `reason?` explains it, and `terminate?` can end the agent early only when every finalized result in the batch is terminating. To change arguments, mutate `event.input` in place instead. |
| `tool_result` | `ToolResultEventResult` | `content?`, `details?`, `isError?`, and `usage?` can replace result fields. |
| `message_end` | `MessageEndEventResult` | `message?` replaces the finalized message, and **must keep the original role**. |
| `user_bash` | `UserBashEventResult` | `operations?` supplies execution, or `result?` replaces it entirely. |
| `resources_discover` | `ResourcesDiscoverResult` | `skillPaths?`, `promptPaths?`, and `themePaths?` add resource paths. |
| `session_before_compact` | `SessionBeforeCompactResult` | `cancel?` cancels; `compaction?` supplies a replacement compaction. |
| `session_before_fork` | `SessionBeforeForkResult` | `cancel?` cancels; `skipConversationRestore?` controls conversation restoration. |
| `session_before_switch` | `SessionBeforeSwitchResult` | `cancel?` cancels the switch. |
| `session_before_tree` | `SessionBeforeTreeResult` | `cancel?`, `summary?: { summary: string, details?: unknown, usage?: Usage }`, `customInstructions?`, `replaceInstructions?`, and `label?` control navigation. |
| `before_provider_request` | `BeforeProviderRequestEventResult` | An `unknown` return value can replace the request payload. |

Observation-only events, where a return value changes nothing:

`agent_start`, `agent_end`, `agent_settled`, `ui_prompt_start`,
`ui_prompt_end`, `turn_start`, `turn_end`, `message_start`, `message_update`,
`session_start`, `session_shutdown`,
`session_compact`, `session_compact_failed`, `session_tree`, `session_info_changed`, `model_select`,
`thinking_level_select`, `tool_execution_start`, `tool_execution_update`,
`tool_execution_end`, `after_provider_response`, `before_provider_headers`.

`ui_prompt_start` and `ui_prompt_end` bracket the outermost blocking extension
UI prompt. Both report `reason: "ui_prompt"`, the prompt `kind`, and an optional
human-facing `title`; nested prompts stay within the same outer pair.

## Two contracts that are easy to get wrong

**`before_agent_start` replaces, so you must compose.**
`BeforeAgentStartEventResult.systemPrompt` is documented as replacing the prompt
for the turn, chaining when several extensions return one. Returning your own
text bare therefore discards whatever ran before you. Append to what you were
handed:

```ts
pi.on("before_agent_start", (event) => ({
  systemPrompt: `${event.systemPrompt}\n\n${mySection}`,
}));
```

**`resources_discover` fires at startup or reload.**

```ts
export interface ResourcesDiscoverEvent {
  type: "resources_discover";
  cwd: string;
  reason: "startup" | "reload";
}
```

Skills and prompt templates cannot appear part-way through a session without a
reload. Anything that can flip mid-session — a command toggle, say — must call
`await ctx.reload()` before its contributed resources appear, while a
startup-time CLI flag can activate them during the initial load. Decide the
activation mechanism with that constraint in mind rather than discovering it
afterwards.

`session_start` carries a wider `reason`: `"startup" | "reload" | "new" |
"resume" | "fork"`.

## Current versus deprecated

Use the public `@earendil-works/pi-*` packages. Do not import Pi implementation
modules by deep path, and do not use the deprecated `@mariozechner/*` packages.

Treat an optional integration as optional: load it dynamically, and degrade with
a clear message when it is absent, rather than making it a hard dependency.

## Keep requirements separate from design

Do not promote an implementation choice into a requirement. Before planning a
change, separate three sources of authority:

- **source requirements** — behavior explicitly required by the request,
  specification, or acceptance criteria;
- **repository invariants** — rules the repository already establishes and must
  keep true;
- **proposed design choices** — mechanisms introduced by the implementer. They
  remain optional unless an authoritative source accepts them.

If removing a proposed mechanism still meets every source requirement and
repository invariant, treat it as optional and prefer not to add it.

### Stop before expanding the contract

Before adding cryptography, credentials, authorization, a new protocol, durable
recovery behavior, or a new trust boundary that no source requirement or
repository invariant requires:

1. Show why the existing trusted path cannot satisfy acceptance.
2. Name the concrete attacker and capability the stronger mechanism addresses.
3. Compare it with the simplest sufficient design.
4. Stop for human approval when the stronger contract would materially expand
   the requested change.

This gate does not weaken a security mechanism required by a human decision,
source specification, or documented repository invariant. It interrupts only an
unsupported expansion.

### Review the requirement before the mechanism

When reviewing a change, first ask whether each mechanism is required. Flag an
unsupported invariant or disproportionate scope before treating an agent-proposed
choice as settled architecture. Report these separately:

- a **source-contract failure**, where required behavior or security is wrong;
- an **optional-defense failure**, where an unrequired added defense is broken;
- **practical severity**, rated from realistic prerequisites and consequences.

Do not turn “the optional defense is broken” into “the required behavior is
insecure.”

## Parallel test execution and isolation

Whole-repository gates run test files in parallel by default. Node's test
runner already supplies process-level concurrency when no serializing flag is
present, so do not add a serializing flag to the whole gate.

If a genuinely serial suite needs serialization, give it its own named serial
script and put a nearby written reason next to that script. Never serialize the whole
gate for one suite. Keep coverage wrappers such as `c8` transparent to the
underlying runner's concurrency: they must preserve the concurrency selected by
the wrapped runner rather than adding their own throttle.

CI may set an optional `TEST_CONCURRENCY` control to reduce CI pressure. Accept
the runner default when it is unset. Reject a fixed low ceiling that ignores the
capacity of the host running the tests.

The slowest file sets a lower bound on parallel wall time. Treat files
around 30 seconds or slower as split candidates. Prefer fakes or event hooks
over `setTimeout` or sleep waits so tests do not spend their time waiting on a
clock.

Make tests parallel-safe with unique temporary directories. Avoid fixed shared
paths, socket names, ports, daemons, and other uncontrolled shared state.
Serialization pressure should trigger an isolation review. Fix the shared
resource rather than hiding the collision behind a serial gate.

## Before you claim it works

Type-check against the real typings rather than trusting an event name that
looks plausible. An unknown event name is a silent no-op — the handler simply
never runs, and nothing reports it.
