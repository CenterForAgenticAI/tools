# Original design intent

For maintainers and graph authors: this page preserves the project's original design intent.

The implementation now exists; this text records the intent that guided it.

## What it is

- **An authoring layer.** Graphs are written in Markdown frontmatter, in `~/.pi/agent/graphs/` or a project's `.pi/graphs/`, not in a separate JSON or TypeScript dialect.
- **A node layer.** A node is an existing `pi-prompt-template-model` template, a `pi-delegate` agent, or a plain command — not a new inline prompt you have to write again.
- **Two execution modes.** Session-guarded, where the graph drives your live session and keeps per-node model, skill, and thinking switching; and orchestrated, where nodes run as isolated or delegated workers.

## What it is not

It is not a general-purpose workflow engine. It runs the smallest engine that supports conditional, bounded, resumable graphs over Pi units, and it deliberately defers parallel-state machinery until a real graph needs it.

Existing Pi graph packages were studied as prior art and reference designs. They are not runtime dependencies: the package owns its parser, compiler, routing, execution, and durability layers.
