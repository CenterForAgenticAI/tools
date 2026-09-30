# Write and run a graph

For graph authors: this guide covers the file format and the commands for checking, running, and inspecting a graph.

A graph is a Markdown file with YAML frontmatter. Put a project graph in
`.pi/graphs/` or a user graph in `~/.pi/agent/graphs/`; run a project graph
from that project directory. If both locations contain the same graph name, the
project file is used.

The file name without `.md` is the graph name. Names must start with a
lowercase letter and contain only lowercase letters, digits, and hyphens. For
example, `.pi/graphs/hello.md` is run as `hello`.

## 1. Create the file

Create `.pi/graphs/hello.md`. Start it with a frontmatter block whose first
line is `---` and whose closing delimiter is another `---`. Text after the
frontmatter is documentation; the loader does not execute it.

The frontmatter must include:

- `budget`: an integer of at least `1`. It bounds the total node attempts.
- `graph`: either a long-form mapping with `entry` and `nodes`, or a
  shorthand string.

In the long form, `graph.entry` names the first node and `graph.nodes` maps
node IDs to node definitions. `done` and `fail` are built-in terminal
destinations, not nodes. Each node must declare exactly one node kind and a
transition.

The shorthand also supplies entry and node definitions: `graph: hello -> done`
creates a template node named `hello`. It cannot carry node details, so this
page uses the long form.

Here is a complete graph you can copy:

```markdown
---
description: Record a successful graph run
budget: 3
graph:
  entry: prepare
  nodes:
    prepare:
      set:
        - { path: result.started, op: set, value: true }
      next: check

    check:
      command: [node, --version]
      output: result.node
      on:
        pass: done
        fail: fail

result:
  paths: [result.started, result.node]
---

# hello

This note is documentation for the graph.
```

The `set` node writes `true` to `result.started`; `next` sends it to `check`.
The `command` node uses an argument vector, runs without a shell, and writes
captured standard output to `result.node`. Exit code `0` produces `pass`; any
other code produces `fail`. `result.paths` selects the state paths returned in
the run result.

## 2. Declare and route nodes

The available node kinds are `template`, `agent`, `command`, `human`, and
`set`. A `template` names a prompt-template command, not an inline prompt. An
`agent` names a `pi-delegate` agent. A `human` asks the operator, and a `set`
changes state.

Use `next` for an unconditional route:

```yaml
next: another-node
```

Use a list for static fan-out, which schedules each destination:

```yaml
next: [scan-frontend, scan-backend]
```

Use `on` to map a node's verdict to a destination. The `check` node above uses
`pass` and `fail`. A node with `next` cannot also declare `on`, `when`, or
`default`.

Use ordered `when` clauses for state-based routing and `default` for the
fallback:

```yaml
when:
  - if: { path: result.ready, op: eq, value: true }
    to: finish
default: revise
```

The engine checks `when` clauses in order, then an exact `on` verdict, then
`default`. A conditional node's possible verdicts must be covered by `on` or
`default`; an open verdict set requires `default`. A route to an earlier node
is an ordinary transition. To bound a repeated visit, declare `limit` together
with `onLimit`.

## 3. Check before running

From the project directory, check the graph:

```text
/graph check hello
```

This loads and compiles the file without running a node, then prints compiler
diagnostics. A successful check reports:

```text
Graph is valid.
```

Fix every error before running. The compiler checks destinations, terminal
reachability, the required budget, and routing coverage for the verdicts a node
can produce.

## 4. Run it

Start the graph from the same project directory:

```text
/graph run hello
```

For the complete command-and-set graph above, the command finishes with a JSON
notification containing the run ID, status, and projected result. A successful
run has status `completed`; its result contains `result.started` and
`result.node`.

A graph that reaches a `human` node is the exception: the command displays the
question and an instruction to use `/graph resume` with the run ID and an
accepted answer, instead of sending that JSON notification.

Keep the displayed run ID. To inspect the run's status, use:

```text
/graph status <runId>
```

Run data is stored under `<cwd>/.pi/runs/<runId>`.