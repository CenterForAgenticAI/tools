# Surface reference

For users and contributors: the tools, commands, skills, and path rules that pi-work exposes.

### Tools

| Tool | Does |
|---|---|
| `work_validate` | Parse and validate a spec; typed findings plus advisory lints |
| `work_promote` | Draft → spec, carrying the criteria block verbatim |
| `work_amend_criterion` | Change one criterion as an append-only recorded act |
| `work_status` | Derive per-node state: done, ready, blocked, or needs-decision |
| `work_plan` | Compile a ready node into a brief and return a receipt |
| `work_dispatch` | Perform exactly one delegate dispatch; record the receipt |
| `work_verify` | Execute a node's evidence fail-closed in a named tree |

### Commands

`/work-draft`, `/work-promote`, `/work-decompose`, `/work-status`, `/work-next`.
Commands may be interactive; tools never are.

`/work-status --refresh` returns a typed blocked result in v1: the public
verification barrel exposes no authority constructor, so status cannot produce a
trusted current-session result. Run `work_verify` for that.

### Skills

`work-authoring` (drafting method), `work-decomposition` (granularity, criterion
homes, honest `touches` scoping), and `work-execution` (ready set → plan →
dispatch → verify).

### Paths are relative by design

Every path-taking tool resolves its input against a confinement root and
**rejects an absolute path** rather than rewriting it. Pass a path relative to
the root.
