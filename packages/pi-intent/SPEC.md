# Intent records standard v1

**Package:** pi-intent 0.2 · **Status:** experimental. This is the first version of the format, not a stability promise.

An intent record states what a person wants. A compiled-intent model states checkable claims about a finite decision. A Jev receipt records typed judgments about whether those claims match the record. Conformance compares the model with the app's real code. These are separate forms of evidence: a proof of the model does not prove the implementation follows it.

## Files

An adopting repository MUST use this visible layout:

```text
CONTEXT.md                         project vocabulary (existing or human-authored)
intent/
  records/NNNN-<slug>.md
  model/LAWS.bend
        PROOF.bend
        Lib.bend
        neg/*.bend
        laws.sha256
  receipts/<record-id>.json
  conform.json
  oracle/…                        in the app's language
 tools/intent-*.mjs                vendored scripts, plus shared/helper .mjs files
```

Other model modules, enum specifications and row-emitting Bend programs may live in `intent/model/`. `pi-intent init <dir>` creates a draft scaffold, not approval or a working oracle. `pi-intent vendor <dir>` copies every kit `.mjs` file to `tools/`, replacing local copies. Review local edits before updating. `Lib.bend` is copied by init; review future library updates separately.

## Intent record

A file name MUST be `NNNN-slug.md`: four digits and a lowercase hyphen-separated slug. These metadata lines MUST occur once:

```text
id: 0001-transitions
status: descriptive
context: ./CONTEXT.md
```

The id MUST equal the filename without `.md`. Status is `descriptive`, `draft` or `approved`. Required level-two sections are `Intent`, `Vocabulary`, `Rules`, `Worked examples`, `Freedoms`, `Non-goals`, `Open questions` and `Approval`. Put nonempty content in each; write `None` where appropriate. Under Rules, use one clause per line, contiguous `R1: ...`, `R2: ...` identifiers. Keep identifiers stable during implementation; an approved meaning change requires review and fresh receipts.

Terms already defined by the project MUST cite `CONTEXT.md`; records define only terms they introduce. A file citation is structural evidence, not a machine judgment about vocabulary quality. Human review checks definitions, examples and unresolved questions.

### Lifecycle and authority

- **descriptive:** a retrofit observation of existing behaviour, not a requirement and not approval.
- **draft:** proposed rules, examples and unresolved choices. Resolve or explicitly defer each question with the person before approval.
- **approved:** a person approved the record. Record `approved-by: <human>` in Approval and commit the reviewed text. An agent may draft or record an explicit approval, but MUST NOT confer it on itself.

Edits to an approved record return it to draft until reviewed. LAWS.bend is also human-owned. Approval of the record alone is insufficient: project the model back to plain language, cite its declarations, ask the person to approve that meaning, then write the raw 64-hex SHA-256 of LAWS.bend's UTF-8 bytes to `laws.sha256`. Changing claims invalidates that hash and every receipt. Proof-only edits do not change the claims hash; rerun the gate and conformance.

### Greenfield sequence

1. Read CONTEXT.md; draft the record and worked examples.
2. Obtain human record approval.
3. Write the finite Bend model, one law per obligation and one proof def per law. Add one deliberately invalid proof control per law.
4. Independently review the model's plain-language projection; obtain law approval and record its hash.
5. Run authoring-time Jev to produce a passing receipt; review and commit it.
6. Implement the app and oracles; run offline freshness, the proof gate and conformance. Wire required checks into build/CI.

### Retrofit sequence

1. Call the actual implementation to observe its finite decisions. Write a descriptive record and examples, distinguishing observations from desired changes.
2. Ask which behaviour to retain. Turn observations into a draft and obtain human approval.
3. Follow greenfield steps 3–6. Where implementation differs, change the code or request a revised record/model; preserve the mismatch as evidence until resolved.

## Model and proof gate

Use Bend 2.0.34. Law identifiers MUST be unique; `none` is reserved for receipt coverage. `LAWS.bend` holds claims and the modeled decision. `PROOF.bend` imports it and supplies a total `def` for each law (normally `def M.<law>(...)`). The gate resolves relative import aliases before accepting a syntactic proof definition, then runs `bend PROOF.bend --check-only` and checks any other module defining its own laws, including unimported helpers. Imported claims are not assumed to be proven merely because Bend type-checks a file.

The gate scans every authored `.bend` file (including negatives) for `@unsafe`, partial `def f?` and `?TODO`, ignoring comments and strings. Model files MUST be regular files, not symlinks. Keep declarations at column zero in Bend's ordinary `law name:` / `def name(...)` form so the inventory and gate can see them.

Each `neg/*.bend` MUST contain `# expect-failure: M.<law>` naming a definition that imports the declared law and MUST emit `SOME PROOFS FAIL` with that exact `Location:`. A parse error, missing import, missing tool, successful proof or arbitrary nonzero exit is not a valid negative control. Every declared LAWS.bend law needs a negative. Positive output must contain a full-line `All terms check.` or `ALL PROOFS CHECK` and must not contain `SOME PROOFS FAIL`.

`inventory.mjs` is a declaration index, not a proof checker. Its `defined` status means an authored definition resolves to a law; only the gate establishes the judgment. `gen-enums.mjs` generates enum/key round-trip proof terms. Generated code is checked by Bend like authored code.

## Jev receipt schema 1 and code policy

The producer uses `pi-fabric/jev` only at authoring time; `pi-fabric` must be resolvable from the authoring project. It resolves the requested model's route before constructing the client: bare `jev-1.13` selects TypeSafe (`TYPESAFE_API_KEY` or pi `/login jev`), `typesafe/jev-1.13` selects OpenRouter (`OPENROUTER_API_KEY` or pi `/login openrouter`), and `typesafe-ai/jev` selects Vercel AI Gateway (`AI_GATEWAY_API_KEY` or pi `/login vercel-ai-gateway`). An injected evaluator has shape `(JevRequest) => Promise<JevResponse>`. Requests contain `{state: {record, laws}, questions, model}`. The producer makes two requests:

1. **Coverage:** one Jev `choice` per record clause, with options for every declared law plus `none`. An answer is `{type: "choice", choice, confidence, probabilities}`.
2. **Fidelity:** one Jev `noul` per law, asking whether it faithfully encodes the clause(s) selected for it without adding, weakening or strengthening constraints. An answer is `{type: "noul", noul}`; `noul` is the probability of true. An unmapped law asks about no clauses and cannot pass.

Only named typed answer fields enter storage. Model-supplied verdicts and extra fields are discarded. See `templates/receipts/example.json` for a complete **fake-evaluator fixture**, not production approval.

A receipt has exactly these top-level fields:

| Field | Value |
|---|---|
| `schema` | `1` |
| `recordId` | approved record filename without extension |
| `recordSha256`, `lawsSha256` | SHA-256 of the exact current UTF-8 files |
| `policy` | `{version: "pi-intent/1", coverageThreshold: 0.8, fidelityThreshold: 0.9}` |
| `model` | explicit Jev model identifier echoed identically by both evaluations; the requested id may resolve to `<requested-id>-YYYYMMDD`, in which case that dated snapshot is recorded; any other echo rejects |
| `questions` | `{coverage: {R1: …}, fidelity: {law: …}}`, complete instructions and criteria |
| `answers` | `{coverage: {R1: …}, fidelity: {law: …}}`, complete typed judgments |
| `verdict` | `pass` or `reject`, computed by code |
| `integrity` | SHA-256 of canonical JSON of every field except integrity |

Canonical JSON sorts object keys recursively, preserves array order, uses JSON string encoding and no insignificant whitespace. Probabilities and confidence MUST be finite numbers in `[0,1]`; Choice probabilities MUST name every option and sum to 1 within 0.01. All clause and law answers MUST be present, with no extra judgment ids. A pass requires each choice to select a law (not `none`), both its confidence and selected probability to be at least 0.8, each law to be selected by at least one clause, and every law's Noul to be at least 0.9. The model never decides the verdict.

`intent-check` recomputes the questions, policy verdict, file hashes and integrity. An edited answer, question, policy or identity requires a new receipt. The checksum detects accidental edits; it is **not a signature or proof of Jev origin**. A caller able to rewrite a receipt and its checksum can forge it. Trust reviewed commits and protected review/CI permissions, not this checksum as authentication. Jev is probabilistic evidence, not mathematical proof. CI makes no network request and needs no Jev credentials.

In v1 each approved record is judged against all current laws, so each must cover the whole current model. When several changes contribute to one model, keep one cumulative approved decision record and use descriptive/draft records for historical observations or proposals. Multi-record law subsets are outside v1.

## Conformance manifest schema 1

```json
{
  "schema": 1,
  "checks": [{
    "name": "transitions-python",
    "laws": ["stopped_rejects", "active_allows"],
    "model": ["bend", "intent/model/Rows.bend"],
    "real": ["python3", "intent/oracle/python.py"],
    "broken": ["bend", "intent/model/Broken.bend"],
    "cwd": ".",
    "timeoutMs": 30000
  }]
}
```

`checks` MUST be nonempty; names MUST be unique and nonempty. `laws` MUST be a nonempty list of identifiers declared in LAWS.bend. The entire manifest is validated before any command executes. All three commands MUST be nonempty argv arrays of strings, without NUL bytes. `cwd` is optional, resolved relative to the adopting repo (it may name an external build directory). Timeout is optional, default 30000 ms, bounded to 1–600000 ms. Each command has a fixed 1 MiB output cap per stream. These are trusted local programs, not a sandbox for untrusted repositories; an explicitly invoked shell/interpreter can still execute its own code.

The runner uses `execFile` with `shell: false`, copying only named fields into subprocess options. A hostile manifest MUST NOT be able to enable a shell, remove output limits or convert metacharacters in ordinary arguments into shell syntax. A careless or hostile evaluator MUST NOT inject policy/verdict/options through its response. Tests supply these forbidden inputs and assert they do not survive.

Programs MUST exit zero and emit at least one nonempty stdout row per case (`case-id result`). The checker removes blank lines, sorts remaining lines, preserves duplicates, and compares model and real. Differences print the disagreeing rows with multiplicities. `broken` MUST differ from real; a match rejects with `oracle does not exercise the real code`. Make the broken model wrong for an exercised case; this control is useful but cannot itself prove every oracle calls the app.

A real oracle MUST import/call the app's shipped function or entry point. It may enumerate inputs and normalize output; it MUST NOT retype the decision rules. Declare the covered laws honestly. Uncovered laws are always listed; `--require-coverage` rejects any gap. Named coverage is an author assertion, not proof that a manifest exercises every branch. Review finite input completeness separately.

Conformance is language-neutral and does not use Jev. Finite decisions fit this method. Timing, concurrency, performance and other emergent behaviour need an ordinary test that names the applicable law, rather than a duplicate miniature implementation.

## Commands and failure contract

```sh
node tools/intent-check.mjs [repo-dir]
node tools/intent-gate.mjs [repo-dir]
node tools/intent-conform.mjs [repo-dir] [--require-coverage]
node tools/intent-receipt.mjs <repo-dir> <record-id> <jev-model>
```

Node >=22.19 runs the zero-dependency kit. Exit 0 means pass; 1 means rejected evidence; 2 means malformed/missing input, unavailable tools, timeout or output cap. Failures name the stale evidence and a repair. Vendored script headers are `// pi-intent v<version> sha256=<body-hash>` after the shebang, if present. `intent-check` validates its own header and every kit-owned `.mjs` header in `tools/`, requiring one consistent version; unrelated app tools are ignored. A body hash excludes the header line. This reveals local drift, not malicious script replacement.
