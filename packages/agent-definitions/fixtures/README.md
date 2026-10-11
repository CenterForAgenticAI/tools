# Conformance fixtures

This directory is the independent expectations corpus for Agent Definitions 0.1. Consumers use `manifest.json` as the oracle: expectations come from the settled parse contract and format decisions, not from any parser's output.

`tests/conformance.test.ts` checks this package's `parseDefinition` against every `valid` and `invalid` entry: error and warning paths, `ok`, and each listed value. When the two disagree, decide from the contract which one is wrong; never copy parser output into the manifest.

## Contents

- `valid/`: hand-written definitions that must load, including the minimal definition, compatibility warnings and both context-file entry forms.
- `invalid/`: one focused validation failure per definition, including unsafe context-file paths.
- `legacy/`: real agent definitions copied byte for byte from pi-delegate and pi-prompt-graph.
- `external/`: a pinned Claude Code subagent from a public repository.
- `converter/`: a pinned OpenCode input whose native format needs the converter.

## Manifest

`manifest.json` is an array with one entry per fixture file:

```json
{
  "file": "legacy/example.md",
  "source": {
    "url": "https://raw.githubusercontent.com/owner/repo/<commit>/agents/example.md",
    "path": "agents/example.md",
    "commit": "<commit>",
    "licence": "MIT",
    "sha256": "sha256 of the copied bytes"
  },
  "sample": "q4",
  "options": { "origin": "package" },
  "expect": "valid",
  "errors": [{ "path": "field.path" }],
  "warnings": [{ "path": "field.path" }],
  "values": { "canonical.path": "expected parsed value" }
}
```

`source` is present for copied files and has exactly one of `url` or `package`. A `url` is an HTTPS address that contains the `commit` it is pinned to. A `package` names the public npm package whose source repository holds the file at `path`; an entry uses it only when the file has no commit-pinned public URL. `sample` marks the first migration sample. `options` records parser inputs that are not in the file. `expect` is `valid`, `invalid` or `converter`. Diagnostic paths use the spelling in the source file. `values` records only values settled by the contract; omitted values must not be inferred from parser behavior.

## Provenance and licences

Every copied file is MIT-licensed, and its manifest entry records the licence and the SHA-256 digest of the copied bytes.

These files were fetched over HTTPS from commit-pinned raw GitHub URLs:

- pi-delegate's built-in `delegate`, `publisher` and `worker` agents: `CenterForAgenticAI/tools`, `packages/pi-delegate/builtin-agents/`, commit `6b3eb3a367b51f988839e2aa46731a914b42b66f`.
- Claude Code: `wshobson/agents`, `plugins/debugging-toolkit/agents/debugger.md`, commit `46891e7e60da0e52baf1050b7b6391b64e84c6d9`.
- OpenCode: `anomalyco/opencode`, `packages/console/app/.opencode/agent/css.md`, commit `663fbd7573705c13fcb3a4adabf53312e1e3ae59`.

Six files record a package instead: three pi-delegate test fixtures (`smoke-plain`, `smoke-narrow` and `smoke-nested`) and three pi-prompt-graph research agents (`auditor`, `reviewer` and `writer`). They are in the source repositories of `@centerforagenticai/pi-delegate` and `@centerforagenticai/pi-prompt-graph`, but not in those packages' published files or in the public repository. Their digests are the only check on their bytes.

**Never edit, reformat or normalize a copied file.** Refresh it from its source, recompute the digest and re-derive its expectations from the contract instead.

## Deriving expectations

The expectations were worked out by hand from the parse contract in [docs/format.md](../docs/format.md) and the decisions in [docs/decisions.md](../docs/decisions.md). Legacy and foreign keys list every required warning. Canonical values record the contract's alias mappings, defaults and tool normalization. Converter inputs are retained without guessing a direct parse result.
