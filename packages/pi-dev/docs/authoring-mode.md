# Extension-authoring mode

For Pi extension authors: how to enable the optional authoring guidance and skills.

## Extension-authoring mode

`pi-dev` can contribute guidance for writing Pi extensions. It is **off by default** and contributes nothing — no system-prompt text, and no skill — to any session that did not ask for it.

Turn it on for a session by starting Pi with the flag:

```sh
pi --pi-dev-mode
```

While it is active, the extension contributes exactly two things:

- A short pointer appended to the system prompt. It is appended to whatever other extensions have already contributed, never substituted for it.
- Two skills: `authoring-pi-extensions` carries the lifecycle events and their return shapes, how `before_agent_start` chains the system prompt, how `resources_discover` contributes resources, the glob-expanded `pi.*` discovery fields, and which surfaces are current rather than deprecated; `developing-pi-extension-repos` covers test-layout parity, safe worktree dependencies, CI reproduction, and coverage floors.

The split is deliberate. Anything injected into the prompt is paid for on every turn of the session; each skill is read once, when it is relevant.

`pi-dev` does not ship extension-authoring prompt templates today: no concrete, repeatable workflow has shown that a template is better than a direct prompt. If a specific workflow earns one, we can add a template then.

Run `/dev doctor` to see whether the mode is active. `pi-dev` does not add a dedicated extension-authoring `/dev` subcommand because `/dev doctor` already reports whether the mode is active, and another command would duplicate that information. The flag is namespaced because registered CLI flags share one namespace across every loaded extension, and Pi reports collisions while resolving precedence by extension load order.

### Why a flag rather than a toggle

`resources_discover` fires with reason `startup` or `reload`, and `ExtensionContext.reload()` could make a mid-session toggle load its skills. The CLI flag remains the chosen design because it keeps the prompt and skills selected consistently from session start rather than changing resources during a session.

The skills are contributed from a `resources_discover` handler rather than declared in `package.json` under `pi.skills`, because that field is resolved unconditionally and would make the skills discoverable even with the mode off.
