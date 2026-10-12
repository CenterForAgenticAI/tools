# Lint agent definitions

The `lint` command checks agent definition files before a runtime loads them. It reports parser diagnostics and environment-specific problems in one pass.

```sh
agent-definitions lint [--json] [--models <file>] [--skills <dir>]... [--tools <file>] <path>...
```

Each path can name a file or a directory. For a directory, the command checks its direct `*.md` children. It does not search nested directories. Chain files ending in `.chain.md` are skipped because they are not agent definitions.

## Checks

The command always runs the Agent Definitions parser. It keeps every parser error and warning, including the source line when available. It also suggests canonical fields for known spellings from other agent formats:

- `max_turns` and `maxTurns` → `limits.maxTurns`
- `timeout_mins` → `limits.timeoutMinutes`
- `mcp-servers` → `services`
- `disable-model-invocation` and `user-invocable` → `invocation`
- `model_reasoning_effort` → `effort`

The optional flags enable checks against the current environment:

- `--models <file>` checks every model other than `inherit` against the supplied names.
- `--skills <dir>` checks each short or long skill reference by looking for `<dir>/<name>/SKILL.md`. Repeat the flag to search more than one directory.
- `--tools <file>` checks non-portable tool names against the supplied names. Portable tool names and their recognized aliases do not need to be listed.

Model and tool files can be a JSON array of strings or a text file with one name per line. Blank lines and lines beginning with `#` are ignored in text files.

## Output

The default output has one line per diagnostic, followed by a summary:

```text
agents/reviewer.md:4: warning legacy-spelling maxTurns: Use the canonical 0.1 field instead.
agents/reviewer.md:4: hint foreign-spelling maxTurns: Use the canonical field "limits.maxTurns" instead of "maxTurns".
1 files, 0 errors, 1 warnings, 1 hints
```

Use `--json` to print one JSON document. Its shape is:

```json
{
  "files": [{ "file": "agents/reviewer.md", "ok": true, "diagnostics": [] }],
  "errors": 0,
  "warnings": 0,
  "hints": 0
}
```

All reported file paths are relative to the current working directory. Files are reported in sorted order.

## Exit status

- `0`: every checked file has no error
- `1`: at least one checked file has an error
- `2`: invalid command usage, a missing path, or an unreadable model or tool file

## CI example

Run the linter in the repository's test job:

```yaml
jobs:
  lint-agents:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci
      - run: npx agent-definitions lint agents/
```
