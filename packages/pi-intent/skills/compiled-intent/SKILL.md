---
name: compiled-intent
description: Author or change a finite Bend model from an approved intent record, review its meaning, obtain human law approval, and produce an offline-verifiable Jev receipt. Load for model-change nodes, not for emergent runtime behaviour.
---

# Compiled intent in Bend

The adopter needs a provable statement of its finite decision. The person owns claims; the agent owns proof work. Read REFERENCE.md beside this skill before writing Bend proof terms. Read the installed package's SPEC.md for the approval and receipt formats. Bend 2.0.34 is the tested compiler; inspect `bend --help` and `bend guide` when the installed version differs.

1. Load `intent-records` if the record is not approved. Extract its finite domain and R1, R2… obligations. List any clause that cannot fit a finite decision and propose an ordinary test that names that rule. Done: each modeled clause has a declared law and a concrete example.
2. Work in `intent/model/`. Keep claims in LAWS.bend; keep one explicit total proof def per law in PROOF.bend. Use relative imports with aliases, `Lib.bend` helpers and `tools/gen-enums.mjs` when useful. Inventory with `node tools/inventory.mjs intent/model`; its `defined` status is only a source index, not proof. Implement proofs with total constructors, matches and equalities; the gate rejects `@unsafe`, partial `def f?` and `?TODO`.
3. Write `neg/<law>.bend` for every law, deliberately failing its judgment and naming it with `# expect-failure: M.<law>`. Run Bend `--check-only` on proofs and controls. Done: every positive prints a success verdict and every negative prints `SOME PROOFS FAIL` at the named location; parse errors do not count.
4. Have an independent reviewer project every declaration into plain language without merely repeating law names. Compare the projection to the approved record and examples. Show the person the projection and exact LAWS.bend bytes. Capture their law approval, then write its SHA-256 to laws.sha256. Proof repairs may continue; claim changes go back for approval. Done: reviewed meanings and the approved hash agree.
5. At authoring time run `node tools/intent-receipt.mjs . <record-id> <jev-model>`. Install pi-fabric beside the authoring repo and configure Jev credentials first. Coverage is one Choice per clause over all laws plus none; fidelity is one Noul per law over its selected clauses. Code computes the verdict using policy thresholds 0.8 coverage / 0.9 fidelity. Inspect and commit the receipt. A rejected receipt means revise with approval, not edit answers or thresholds. Done: `node tools/intent-check.mjs` passes offline for current files.
6. Run `node tools/intent-gate.mjs`, then load `intent-conformance` to connect the decision to actual app code. Done: model proof evidence and app conformance evidence are distinct and both current.

## pi-work model-change node

An approved record feeds a pi-work draft, then a promoted workspec. Apply ADR-0009's optional model-change node pattern: model work precedes every affected implementation node via `depends_on`. See the README's worked fragment for exact `kind: command` criteria using `node tools/intent-check.mjs`, `node tools/intent-gate.mjs` and `node tools/intent-conform.mjs`. Verification is pi-work's fail-closed `work_verify` with explicit worktree and commit. A missing Bend executable or receipt is blocked evidence, not completion. pi-work has no dependency on pi-intent; only the criterion commands connect them.
