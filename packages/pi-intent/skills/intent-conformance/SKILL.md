---
name: intent-conformance
description: Connect an approved finite Bend model to actual application code with a language-neutral conformance manifest, app-language oracles and a broken-model control. Load when proving implementation parity or diagnosing decision drift.
---

Adopter records, models, receipts, conformance manifests, oracles and vendored scripts live under `.intent/` (`.intent/tools/` for scripts). Commands run from the repo root. ripgrep and fd skip hidden directories by default; search `.intent` explicitly or use `rg --hidden` / `fd --hidden`.

# Intent conformance

An oracle is a small program that calls the app's real decision function and emits one row per case. Conformance compares its output with the Bend model. The adopter needs this link because proving LAWS.bend alone says nothing about shipped code.

1. Read the approved record, LAWS.bend and the real implementation. For greenfield work, implement after the approved model-change node. For retrofit work, observe actual output before deciding which behaviour to retain. Load `intent-records` / `compiled-intent` when approval or model evidence is missing.
2. Enumerate the complete finite input domain once per oracle. Write a Bend main that imports the modeled function and prints `case-id result`. Write an app-language oracle in `.intent/oracle/` that imports/calls the shipped implementation. Normalize output only; keep the decision logic in the app. Inspect imports and call sites. Done: an implementation mutation changes the oracle's output and makes comparison reject.
3. Write `.intent/conform.json` using schema 1, unique check names, declared `laws[]` and argv arrays for `model`, `real` and `broken`. Include cwd only when needed; default timeout is 30 s, maximum 600 s, output cap 1 MiB per stream. Programs are trusted local executables, not sandboxed code. Command arguments stay literal: the runner uses execFile without a shell, and ignores extra subprocess options.
4. Write a deliberately wrong model for at least one exercised input. `broken` must differ from real. Done: replacing the real oracle with an equally wrong retyped decision makes the control reject with `oracle does not exercise the real code`. The control cannot prove every oracle's origin; code review of actual calls remains necessary.
5. Run `node .intent/tools/intent-check.mjs`, `node .intent/tools/intent-gate.mjs` and `node .intent/tools/intent-conform.mjs`. Read disagreeing cases and the uncovered-law list. Use `--require-coverage` when full declared-law coverage is required. Resolve drift by fixing app code or requesting changed record/law approval, never by making the oracle mimic the expected rows. Done: positive parity, broken-model disagreement and deliberate app-drift failure are all demonstrated.
6. Use ordinary tests for emergent behaviour (timing, races, performance, multi-process effects) that cannot be exhaustively enumerated. Name the governing law in the test and explain the unmodeled mechanism; a duplicate toy implementation is not useful evidence. Jev belongs to record/model authoring and does not participate in conformance.

## pi-work integration

The approved intent record feeds the pi-work draft/workspec. Follow ADR-0009: any allowable-state change creates a model-change node; affected implementation nodes `depends_on` that node. Use the README's exact command-evidence pattern: `node .intent/tools/intent-check.mjs` and `node .intent/tools/intent-gate.mjs` for model work, `node .intent/tools/intent-conform.mjs` for implementation. Each criterion specifies exit 0 plus expected success output. Run fail-closed `work_verify` against the explicit worktree/commit after the final edit. Only verified evidence permits completion; pi-work does not depend on pi-intent.

## Examples to inspect

The installed `examples/transitions/intent/conform.json` selects Bend row programs and TypeScript, Go, Rust and Python oracles. Inspect their imports and corresponding app code before adapting them. They share a 16-case finite decision; their receipt is visibly a fake-evaluator fixture, not production approval. Node and Bend are needed wherever these checks run, even for non-JavaScript apps.
