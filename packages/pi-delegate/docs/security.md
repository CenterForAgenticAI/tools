# Security

This page is for users and integrators who need the project-trust boundary for delegated agents and CLI callers.

## Security note

`delegate` now defaults to `agent_scope: "both"`, which means project-local
agents are discoverable by default. Project agent and chain files share the
lowest-to-highest-precedence order `.agents/` < `.agents/agents/` <
`.pi/agents/`; later definitions win on duplicate names.
Pi owns project trust. If `ctx.isProjectTrusted()` is false, delegate refuses
every run shape selecting a project agent before dispatch. There is no
delegate-local trust store and no model-controlled bypass. Trust or revoke the
project through Pi's native trust flow.

Builtin, user, and installed-package agents are not project-gated. The
headless `delegateFromCli` surface has no Pi trust context, so discovered
project agents require the explicit programmatic capability
`trustProject: true`; otherwise the CLI refuses them before creating a
session. Caller-constructed `AgentConfig` objects remain caller-owned. See
`docs/cli-delegate.md` § Project trust.
