# Agent Definitions

One file format for coding-agent definitions. A definition is a Markdown file with YAML frontmatter. The frontmatter says what the agent is for and what it may do. The body is its instructions.

The same file is meant to load in pi-delegate, pi-fabric and pi-prompt-graph, and to work as a Claude Code subagent file. Converters will import files from other tools and export to them, with a report of what each target could not keep.

This repository holds the schema, parser, validation, discovery rules and conformance suite, published as `@centerforagenticai/agent-definitions`. [docs/format.md](docs/format.md) describes the file layout, fields, defaults and diagnostics.

```sh
npm install @centerforagenticai/agent-definitions
```

## A minimal definition

```markdown
---
name: reviewer
description: Use after a change passes its tests, to review one bounded diff for defects.
---
You review one change. Report each defect with the file, the line and a case that fails.
```

`name`, `description` and a body make a complete definition. Every other field is optional and has a written default.

## Parse a definition

```ts
import {
  checkIsolation,
  checkRuntime,
  parseDefinition,
} from "@centerforagenticai/agent-definitions";
import schema from "@centerforagenticai/agent-definitions/schema.json" with { type: "json" };

const parsed = parseDefinition(source, { origin: "project", file: "agents/reviewer.md" });
if (!parsed.ok) {
  for (const diagnostic of parsed.diagnostics) console.error(diagnostic.path, diagnostic.message);
} else {
  const isolation = checkIsolation({
    definition: parsed.definition.workspace.isolation,
    requested: "worktree",
  });
  const runtime = checkRuntime(parsed.definition, {
    runtime: "pi-delegate",
    knownKeys: ["defaultProgress"],
  });
  console.log(parsed.definition, parsed.diagnostics, isolation, runtime, schema.$id);
}
```

`parseDefinition` normalizes defaults and compatibility spellings. It returns `ok: false` exactly when a diagnostic has severity `error`. See [docs/format.md](docs/format.md) for all fields, diagnostic paths, policy checks, and defaults.

## Glossary

- **Agent definition**: the reusable file that describes one agent. Not a "role".
- **Brief**: the input a caller sends for one task.
- **Run**: one execution of an agent definition.
- **Actor**: a long-lived running agent created from a definition. Runs and actors use the same file; the caller chooses.
- **Model role**: a name such as `role:reviewer` that selects a model and effort only. The runtime's model configuration resolves it. Always write "model role", never a bare "role".
- **User role**: access control for the people who use an application. Not related to agent definitions.
- **Runtime**: a program that loads definitions and runs agents, such as pi-delegate, Fabric or Claude Code.
- **Adapter**: the code that connects one runtime to this format.
- **Lowering report**: the list an exporter writes of every field the target format dropped or weakened.

## Development

Use Node 24. Run `npm install`, then `npm run check`. It runs lint, the format check, the typecheck, the tests with coverage, the build and a package smoke test. CI runs the same command.

## Documents

- [docs/format.md](docs/format.md): fields, defaults, policy checks and diagnostics.
- [docs/discovery.md](docs/discovery.md): where runtimes look for definition files, and in what order.
- [docs/conformance.md](docs/conformance.md): how another project checks that it reads definitions the same way.
- [docs/decisions.md](docs/decisions.md): each format decision and the reason for it.
- [fixtures/README.md](fixtures/README.md): the conformance fixtures and where each copied file came from.

## Status

Version 0.1 ships the schema, parser, validation, discovery and conformance suite. A linter command and import and export converters are planned.
