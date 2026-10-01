# Center for Agentic AI tools

Public releases of [Pi](https://github.com/earendil-works/pi) extensions and services maintained by the Center for AI Research. Each package lives in `packages/<name>/`, is published to npm under the `@centerforagenticai` scope, and is tagged here as `<name>@vX.Y.Z`.

## Packages

| Package | Kind | Status | What it does |
| --- | --- | --- | --- |
| [pi-adaptive-thinking](packages/pi-adaptive-thinking) | extension | experimental | Lets the agent raise or lower its own thinking effort within configured bounds, with status and bounds commands. |
| [pi-artifacts](packages/pi-artifacts) | extension | experimental | Cross-device registry and viewer for session documents and browser-viewable media, with a lightweight applet host. |
| [pi-callbacks](packages/pi-callbacks) | extension | stable | Persistent reminders, polling checks, background scripts, and token-based external callbacks that wake a Pi agent. |
| [pi-context-aware](packages/pi-context-aware) | extension | stable | Context-budget pressure markers, proactive compaction with handoff seeds, prior-session search, and a context cache. |
| [pi-daemon](packages/pi-daemon) | service | experimental | Runs headless Pi sessions in-process behind a local socket, with durable replay, live streaming, and driver arbitration. |
| [pi-delegate](packages/pi-delegate) | extension | stable | Subagent delegation: supervised forks, direct workers, chains, detached drivers, steering, and worktree isolation. |
| [pi-intent](packages/pi-intent) | extension | experimental | Turns approved intent into rules a checker can prove, then checks whether the app's real code follows them. |
| [pi-multi-account](packages/pi-multi-account) | extension | experimental | Routes Anthropic and OpenAI Codex requests across multiple OAuth accounts. |
| [pi-prompt-graph](packages/pi-prompt-graph) | extension | experimental | Conditional, cyclic workflow graphs over Pi units, with bounded loops and fan-out. |
| [pi-question](packages/pi-question) | extension | experimental | An `ask` tool for structured human questions that works in the TUI, headless hosts, and delegate workers. |
| [pi-work](packages/pi-work) | extension | experimental | Workspec authoring, verification, and plan compilation for agent-directed work. |

Each package README lists its Pi and Node requirements, configuration, and documentation.

## Install

Install an extension into Pi from npm, then restart Pi or run `/reload`:

```sh
pi install npm:@centerforagenticai/pi-callbacks
```

`pi-daemon` is a service rather than an extension; install it with npm and follow its README:

```sh
npm install @centerforagenticai/pi-daemon
```

## How releases work

The canonical source for each package is maintained in a private repository. A release exports an allowlisted snapshot of one tagged version into `packages/<name>/`, scans it for secrets and internal references, builds and tests it without credentials, and then publishes the same verified snapshot here and to npm. Export commits have a fresh history.

## Contributing

Issues and pull requests are welcome. Maintainers review pull requests here and carry accepted changes into the source repository, so a change reaches this repository with the next release of that package rather than by merge.

## License

All packages in this repository are available under the MIT License.
