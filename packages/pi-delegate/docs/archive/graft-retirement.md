# Graft path retirement

On 2026-09-25, issue 570 moved the maintained Lean model and all executable model tooling from `.graft/models/pi-delegate/` to `.spec/model/`. The public command remains `npm run model:difftest`.

The source-selected `.spec/model/` layout retains the Lean declarations, propositions, finite cases, runtime oracle, generated model data, browser page, and source axiom checker. Main's root model additions are preserved there: the README, tracked Lake manifest, Bend port and gate fixtures, Bend differential command, and layout guard. The model remains descriptive except for the previously approved narrow recovery-delivery rule.

## Retained historical records

The historical Graft records selected by the source migration are retained byte-for-byte in `.spec/docs/graft-history/`. The retired `.graft/` directory and its obsolete configuration, migration manifest, live state, and workflow placeholders are deleted. The archive contains 157 files: 24 draft records, 71 archived draft records, 37 work records plus one empty `.gitkeep` under `work-records/`, 21 retrospectives plus one empty `.gitkeep` under `retro/`, and the landed/tag indexes. They are historical prose and data only, not current project state or executable tooling.

The archive includes old `.graft` path citations by design. They are exempt from the active `.graft` reference scan because they are immutable historical content. `docs/archive/graft-records.sha256` records each relocated file's SHA-256 fingerprint and canonical archive path. The inventory is explicit evidence for this authorized relocation: every archive file is listed, sorted, regular, non-executable, and byte-for-byte protected.

## Enforcement

`scripts/check-model-layout.mjs` runs in both `npm run check` and `npm run check:ci`. It rejects:

- any new tracked file under retired `.graft/`;
- any changed, removed, executable, or new operational file in `.spec/docs/graft-history/`;
- active tracked references to `.graft` outside the archive, bounded historical evidence blocks, exact legacy ignore lines, and the guard's own documentation/test fixtures;
- a changed `model:difftest` entry point; and
- missing canonical `.spec/model/` assets.

The fingerprint inventory is an immutable-history exception, not a filename-extension exemption. It preserves approved historical bytes and makes any edit fail, including an edit that adds an operational command to an otherwise allowed YAML, JSON, or Markdown filename. A legitimate archival correction requires scoped review and a narrow fingerprint update followed by the mutation tests and named gates. New maintained or operational assets must live outside `.graft/` and the archive.

`tests/unit/model-layout.test.ts` covers the relocated model and archive contract. Its mutation cases restore a model under `.graft/`, use bare and old model paths, add or change an archive file, remove an approved record, make an archive file executable, and omit canonical model assets; each case must fail.

## Former README command wording

The previous README used this historical description for the layout gate:

```text
npm run model:layout  # reject active dependencies on retired .graft paths
```
