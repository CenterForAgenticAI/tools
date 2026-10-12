# pi-durable runtime adapter

The `pi-durable` subpath lowers one parsed agent definition into the conversation agent fields used by pi-durable 1.1.0. It is a pure adapter. It does not import pi-durable, run an agent, read workspace context files, or add a runtime dependency.

```ts
import { lowerToPiDurable } from "@centerforagenticai/agent-definitions/pi-durable";

const lowered = lowerToPiDurable(definition, {
	parentModel: "anthropic/claude-sonnet-5",
	parentTools: ["read", "bash"],
	enforcedBy: ["agents"],
});

if (!lowered.ok) {
	for (const diagnostic of lowered.diagnostics) console.error(diagnostic.path, diagnostic.code);
} else {
	console.log(lowered.input, lowered.report);
}
```

The result is either `{ ok: true, input, report }` or `{ ok: false, diagnostics, report }`. Every report has `target: "pi-durable"` and `direction: "runtime"`.

## pi-durable configure shape

`PiDurableConfigureInput` describes the six pi-durable agent fields this adapter can produce:

- `model`: `{ provider, modelId }`
- `thinkingLevel`
- `extensions`
- `tools`
- `instructions`
- `cwd`

pi-durable's published `AgentChange` accepts installed extension and tool objects, then immediately stores their names. This package has no pi-durable dependency, so its structural tool and extension values are the name-bearing handles that configure reads. A typed host that uses pi-durable's full `AgentChange` type should resolve those handles to its installed registry objects at the integration boundary.

The source contract is the official [pi-durable per-conversation agent documentation](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md#per-conversation-agent). Unset fields continue to follow the host. The adapter does not currently select extensions; the host owns extension installation and defaults.

## Mapping

| Definition field           | pi-durable value | Notes                                                                                                                  |
| -------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `model`                    | `model`          | The first available entry wins. `inherit` resolves through `parentModel`. A selected value must be `provider/modelId`. |
| `effort.default`           | `thinkingLevel`  | Pi 1.1.0 accepts every format level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.                    |
| `effort.min`, `effort.max` | lowering report  | configure has no thinking bounds, so set bounds are reported as dropped.                                               |
| `tools`                    | `tools`          | Portable names map to Pi tool registration names. Order is stable and duplicates are removed.                          |
| `disallowedTools`          | filtered `tools` | Removals happen after mapping. The adapter refuses a portable removal it cannot express.                               |
| instruction body           | `instructions`   | pi-durable renders this after extension prompt sections.                                                               |
| `instructions.include`     | `instructions`   | `readInstruction` supplies each file's text. Entries are inlined in listed order before skills and the body.           |
| `skills`                   | `instructions`   | `readSkill` supplies each skill's full text. Each skill is inlined under `## Skill: <name>` in listed order.           |
| `cwd` option               | `cwd`            | The definition format has no working-directory field, so the caller supplies it.                                       |

For `instructions.mode: replace`, the configured instructions replace the conversation's inherited instructions slot, not extension-owned system sections. For `append`, the configured text renders after those extension sections. pi-durable keeps extension sections separate in both modes.

### Models

`availableModels`, when present, is an exact allowlist. The adapter tries definition entries in order and refuses with `model-unavailable` at `model` when none resolve. Without `availableModels`, it takes the first entry. `inherit` is unavailable when `parentModel` is absent.

pi-durable needs a provider and model ID. Bare model names and model-role names therefore cannot lower without first being resolved by the caller to a `provider/modelId` value.

### Tools

The portable mappings follow Pi's official [built-in tool list](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md#tools):

| Portable name          | Pi names             |
| ---------------------- | -------------------- |
| `execute`              | `bash`               |
| `read`                 | `read`               |
| `edit`                 | `edit`, `write`      |
| `search`               | `grep`, `find`, `ls` |
| `agent`, `web`, `todo` | no built-in mapping  |

Names without a portable alias pass through unchanged. `toolMap` can replace either a written name or a portable name with one target name or an ordered list. A written-name mapping takes precedence.

pi-durable's packaged `CodingTools` extension provides only `read`, `write`, `edit`, and `bash`. A host that uses the `search` mapping must install registrations named `grep`, `find`, and `ls`, or override `search` through `toolMap`.

## Options

```ts
interface PiDurableOptions {
	availableModels?: readonly string[];
	parentModel?: string;
	parentTools: readonly string[];
	toolMap?: Readonly<Record<string, string | readonly string[]>>;
	readInstruction?: (path: string) => string | undefined;
	readSkill?: (reference: SkillReference) => string | undefined;
	cwd?: string;
	enforcedBy?: readonly string[];
	downgrade?: { approvedBy: string; paths: readonly string[] };
}
```

`parentTools` is the target runtime's current tool-name list and supplies `tools: inherit`. `readInstruction` is deliberately separate from `readSkill`: include entries are file paths, while skill entries carry name, source, version, and required metadata.

A missing included instruction produces `instruction-include-missing` at `instructions.include[i]`. A missing required skill produces `skill-missing` at `skills[i]`. A missing optional skill (`required: false`) is left out of `instructions` and reported as dropped at `skills[i]`.

## Context

pi-durable configure has no switches for project instructions, user instructions, or inherited skills. The report therefore lists `context.project`, `context.user`, and `context.skills` as dropped. The host can implement them with extensions and prompt sections.

The adapter never reads `context.files`. When the list is non-empty, it reports `context.files` as dropped. Call `resolveContextFiles`, read the returned files, and add them to the first message before starting the run.

## Restrictions and refusals

A caller must not be able to make the adapter silently weaken a definition restriction. configure cannot represent these paths directly:

- `agents`
- `limits.maxTurns`
- `limits.timeoutMinutes`
- non-shared `workspace.isolation`
- `result.schema`
- `result.artifacts`
- a `disallowedTools` entry with no target mapping

For each present restriction, the adapter applies this order:

1. A path in `enforcedBy` is accepted and reported as dropped with reason `enforced by the caller`.
2. A path in `downgrade.paths`, with a non-blank `approvedBy`, is accepted and reported as weakened with the approver's name.
3. Otherwise lowering fails with `restriction-unenforced` at that path.

Isolation uses the package's shared `checkIsolation` policy. A downgrade must exactly move the definition's `worktree` or `ephemeral` requirement to `shared` and name a non-blank approver.

The adapter calls `checkRuntime` with runtime `pi-durable` and no known runtime-specific keys. It refuses a required foreign runtime and every option inside `runtimes.pi-durable`.

Other fields configure cannot store are listed in the report when set: definition version, services, external requirements, disabled invocation modes, license, and metadata.

## Conformance consumer

`piDurableConsumer` implements `ConformanceConsumer`. Its parser is the reference parser. Its `prepare` method:

- accepts only requests for runtime `pi-durable`;
- applies shared isolation and runtime checks;
- reports explicit tool allowlists, expressible tool removals, required skills, and the required pi-durable runtime;
- refuses restrictions configure cannot enforce itself.

It passes `assertConformance(piDurableConsumer, { level: "enforces" })`.

## Out of scope

This adapter does not run conversations, subscribe to events, deliver results, configure storage, or manage long-lived actors. Actor lifecycle and other persistent harness settings belong to the application that owns pi-durable.
