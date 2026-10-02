---
name: intent-records
description: Draft or approve an intent record when a person asks for a change, or describe existing behaviour before retrofitting compiled intent. Use before turning intent into a pi-work workspec.
---

Adopter records, models, receipts, conformance manifests, oracles and vendored scripts live under `.intent/` (`.intent/tools/` for scripts). Commands run from the repo root. ripgrep and fd skip hidden directories by default; search `.intent` explicitly or use `rg --hidden` / `fd --hidden`.

# Intent records

The person has the requirement; the adopting project's agent reads this skill. Finish with a record whose rules and approval state are explicit, not inferred from a green test.

1. Read the adopting repository's CONTEXT.md and relevant code/examples. For a new adopter, run `pi-intent init <repo-dir>`; otherwise preserve existing records. Read the installed package's SPEC.md for the schema and lifecycle.
2. Choose a new four-digit id and slug. Write `.intent/records/NNNN-slug.md` using the installed `templates/records/0001-change.md`. For a retrofit, start `descriptive` and distinguish observed behaviour from proposed rules. For greenfield work, start `draft`.
3. Cite existing terms in CONTEXT.md. Define only terms the record introduces. Give contiguous R1, R2… clauses, concrete input/output examples, freedoms, non-goals and open questions. Done: every clause can be interpreted without guessing and every unresolved decision is visible.
4. Ask the person to review the complete record and resolve or explicitly defer questions. Record their explicit approval with `approved-by: <human>` and `status: approved`; agents draft and capture human decisions rather than approve themselves. An edited approved meaning returns to draft. Done: approval names the exact reviewed text.
5. Load `compiled-intent-model` when the change has a finite decision worth modeling. Emergent effects, timing or concurrency instead need ordinary tests that name the record's rule.
6. Feed the approved record into pi-work's marked draft, preserve its clause text as criteria, promote with `work_promote`, and decompose with pi-work's authoring/decomposition skills. Follow the ADR-0009 pattern: a model-change node owns changed allowable states; affected implementation nodes depend on it. The link is evidence commands, not a pi-work package dependency or a new schema field.

## pi-work handoff

Use the README's worked workspec fragment as the evidence pattern: the model-change node requires `node .intent/tools/intent-check.mjs` and `node .intent/tools/intent-gate.mjs`; implementation depends on it and requires `node .intent/tools/intent-conform.mjs`. Those are `kind: command` criteria with exit 0 and a nonempty expected success string. Run pi-work's fail-closed `work_verify` at the explicit worktree and commit; missing, timed-out or stale evidence leaves work unverified. Add `--require-coverage` if all laws must be exercised.

Done: the record path is a workspec reference, the model dependency is explicit, and each selected check is a criterion whose evidence runs the real command. pi-work does not depend on pi-intent.
