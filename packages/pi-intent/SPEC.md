# Intent records standard v1

**Package:** pi-intent 0.3 · **Status:** experimental. This is the first version of the format, not a stability promise.

An intent record states what a person wants. A compiled-intent model states checkable claims about a finite decision. A Jev receipt records typed judgments about whether those claims match the record. Conformance compares the model with the app's real code. These are separate forms of evidence: a proof of the model does not prove the implementation follows it.

## Files

An adopting repository MUST use this single hidden-directory layout:

```text
CONTEXT.md                         project vocabulary (existing or human-authored)
.intent/
  records/NNNN-<slug>.md
  model/LAWS.bend
        PROOF.bend
        Lib.bend
        neg/*.bend
        laws.sha256
  receipts/<record-id>.json
  conform.json
  oracle/…                        in the app's language
  tools/*.mjs                     vendored scripts, including shared/helper files
```

All tool-created project state MUST stay under `.intent/`; command repo arguments still name the repository root. ripgrep and fd skip hidden directories by default; search `.intent` explicitly or use `rg --hidden` / `fd --hidden`.

Other model modules, enum specifications and row-emitting Bend programs may live in `.intent/model/`. `pi-intent init <dir>` creates a draft scaffold, not approval or a working oracle. `pi-intent vendor <dir>` copies every kit `.mjs` file to `.intent/tools/`, replacing local copies. Review local edits before updating. `Lib.bend` is copied by init; review future library updates separately.

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

Use Bend 2.0.35. Law identifiers MUST be unique; `none` is reserved for receipt coverage. `LAWS.bend` holds claims and the modeled decision. `PROOF.bend` imports it and supplies a total `def` for each law (normally `def M.<law>(...)`). The gate resolves relative import aliases before accepting a syntactic proof definition, then runs `bend PROOF.bend --check-only` and checks any other module defining its own laws, including unimported helpers. The gate uses `--check-only`, not `--verdict`: Bend 2.0.35's `--verdict` kernel recheck rejects proofs that apply a template (`~`) function hypothesis, which the normal checker accepts, so `--verdict` fails on `kit/Lib.bend` (`notIn_map`, `nodup_map`, `join_injective`) until Bend fixes it. Adopter proofs that avoid `~` function hypotheses may be rechecked with `--verdict` by hand. Imported claims are not assumed to be proven merely because Bend type-checks a file.

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

In v1 each approved record is judged against all current laws, so each must cover the whole current model, unless it declares modules (next section).

## Modules and receipt schema 2

Jev refuses a request above about 32K input tokens (`max_tokens_exceeded`, measured on `typesafe/jev-1.13`), and every request resends its state. A model whose record and laws together approach that size cannot be judged whole. A record may therefore declare modules in an optional `## Modules` section, one bullet per module:

```text
## Modules
- keys: R1-R3; laws: r01_*, r02_*, r03_*
- grants: R4-R10, R12; laws: r04_grant_activity, route_generic
```

A name is `[a-z][a-z0-9-]*` (at most 64 characters) and unique. Clauses are `R<n>` or an inclusive range. A law is an id or a prefix ending in `*` that matches at least one law. Every clause and every law MUST belong to exactly one module; an unknown clause, an overlap, or an unassigned clause or law rejects. The section is part of the approved record, so changing it returns the record to draft.

For each module the producer sends one state: the record without the `## Modules` section and with only that module's rules, and LAWS.bend reduced to every block that is not a `law <id>:` block (imports, types and helper definitions, shared by all modules) plus that module's laws. When modules are declared, every top-level `def`, `type`, `import` and `law` must start at column zero of an LF (or CRLF) line, because Bend also accepts one after a lone CR, after indentation or after `}` on the same line, and the split would then glue it to the block above and drop it from every other module; LAWS.bend is read by one small scanner (kit/intent-core.mjs scanBend), for the law ids, the gate's code scan and the block split alike. It accepts a strict subset of Bend layout and refuses everything else with `LAWS.bend: unsupported layout at line N: ...`; it does not try to model all of Bend. The accepted subset: a # comment runs to the end of the line; a "string" has backslash escapes and may not end in a backslash before a line break; a character literal is one character, or one of \n \r \t \0 \' \" \\ or \u{hex} (1 to 8 hex digits), between single quotes (a raw ', a raw newline or a raw tab inside it is refused); a number is decimal with an optional fraction, exponent and `n` suffix, or 0x or 0b, and may not touch a letter, digit, underscore or dot; a string or character literal may not touch a word on either side; a lone CR and Unicode space characters outside a literal or comment are refused. Keywords inside an accepted literal or comment are not declarations. Refusing, not parsing, is the rule for anything Bend reads in a way this subset does not: for example a character literal `'''` or one holding a raw newline, or a float glued to a keyword such as `1.5law`, would let a real declaration hide from the check, so they are refused. When modules are declared the intake also refuses a string that spans lines, an indented declaration keyword, a second declaration keyword on one line (so `@unsafe def f` on one line is refused; put `@unsafe` on its own line) and any column-zero line that is not a declaration, an `@unsafe` line directly above a `def`, a comment or blank (indent the body of a declaration). The same rules apply whether or not modules are declared. The subset is matched to Bend 2.0.35 (its bundled parser) and checked against the binary by a Bend-backed oracle test, which runs only where bend is installed (not in the offline CI image). A block starts at a column-zero declaration; blank, indented and comment lines belong to the block above, except a run of column-zero `#` comment lines directly above a declaration, which is that declaration's doc and belongs to the block below. A comment separated from the declaration by a blank line stays with the block above, so a section banner followed by a blank line is carried by the previous module's laws. Coverage offers only that module's laws plus `none`; fidelity asks about only its laws. The same code policy applies per module, and the receipt passes only if every module passes. The requested model resolves to one snapshot, identical across modules. The token budget applies to each module's request. A record that declares modules must write each rule as one `R<n>: ...` line, with no other text between or after the rules, including sub-headings, except an optional intro before R1, which every module's state keeps (a continuation line would be reattributed to the rule above it in another module's state); put detail in Worked examples or Vocabulary. Modules are judged in isolation: a clause that depends on another clause ("unless R7 applies") must be in the same module as that clause, because other modules' rules are removed from the state. The record is split once, on LF, into lines; each line is shared (every module's state keeps it), a rule line (only its module keeps it) or part of the Modules section (no state keeps it), and the intake rejects a record whose rule lines differ from the clauses the record parser found. Line breaks must be LF or CRLF: a lone CR, U+2028 or U+2029 is rejected, because the parser and the module slicer would split such a record differently. `## Modules` is a reserved heading: rename an existing prose section of that name before declaring modules.

A schema 2 receipt has `schema: 2`, `recordId`, `recordSha256`, `lawsSha256`, `policy`, `model`, `verdict`, `integrity` and `modules`, an object keyed by module name. Each entry has exactly `clauses`, `laws`, `stateSha256` (SHA-256 of the canonical JSON of the `{record, laws}` state sent), `questions`, `answers` and `verdict`. `intent-check` recomputes every module's clause and law lists, state hash, questions and verdict from the current record and LAWS.bend. It refuses a schema 1 receipt for a record that declares modules, and a schema 2 receipt for one that does not. `laws.sha256` still covers the whole LAWS.bend, so approval stays all-or-nothing. Modules are judged independently: a clause cannot be satisfied by a law in another module. Each judgment is rerun when anything changes; incremental reuse of unchanged modules is not part of this version.
When several changes contribute to one model, keep one cumulative approved decision record and use descriptive/draft records for historical observations or proposals. Multi-record law subsets are outside v1.

## Conformance manifest schema 1

```json
{
  "schema": 1,
  "checks": [{
    "name": "transitions-python",
    "laws": ["stopped_rejects", "active_allows"],
    "model": ["bend", ".intent/model/Rows.bend"],
    "real": ["python3", ".intent/oracle/python.py"],
    "broken": ["bend", ".intent/model/Broken.bend"],
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
node .intent/tools/intent-check.mjs [repo-dir]
node .intent/tools/intent-gate.mjs [repo-dir]
node .intent/tools/intent-conform.mjs [repo-dir] [--require-coverage]
node .intent/tools/intent-receipt.mjs <repo-dir> <record-id> <jev-model>
node .intent/tools/intent-impact.mjs [repo-dir] [--since <git-ref>]
```

`intent-impact` names what a change to an approved record or LAWS.bend makes stale, and why. It compares the working tree with a baseline: `--since <git-ref>` for everything, or by default each approved record's receipt, whose recorded record and LAWS hashes are compared with the files now (so an edit that is already committed, as in a shallow CI checkout, is still found, and a receipt committed apart from its record, reformatted or moved cannot hide or invent staleness). Git history is read only to recover the text the receipt judged, which names the changed clauses and laws; when it is not available (a shallow clone) the stale receipt is still reported and a note says the clause, law, row and oracle detail is unavailable. Only top-level records and receipts count, and a receipt with no record is a note. The walk: the receipt itself (any change to the record or to LAWS.bend makes it stale, because its judgment covered both); changed clauses (record clause text differs) and changed laws (body differs, added or removed; a change to the shared non-law code of LAWS.bend, comments ignored, touches every surviving law); clause to law through the receipt that judged the old text (the current receipt is the stale thing; schema 1 and schema 2 coverage answers; a clause is mapped to one law, the receipt's single `choice`); law to every conformance row in the current `conform.json` that names it, so a removed law that a row still names is reported; row to oracle, meaning any argument of the row's `real` command that is an existing path inside the repository (a heuristic: a wrapper such as Cargo.toml is named, not the source it builds). Each line carries its reason chain, for example `conform row "go" is stale: law stopped_rejects is stale (clause R1 edited)`. Exit 0: nothing stale. Exit 1: something is stale, a clause is new or maps to no law, or a receipt is missing (printed as `not yet checked`, never a pass); a missing `conform.json` is also `not yet checked` when a law is stale, and only a note otherwise because conformance is opt-in. Exit 2: an unreadable or malformed link, such as a bad ref, record, receipt or manifest. `intent-check` and `intent-gate` append the same list when they reject. It needs Git and no Bend or network.

`intent-gate` also asks Bend which laws LAWS.bend declares and fails when that differs from the offline scanner (the one `intent-check` uses): the number of open laws Bend reports for a file importing LAWS.bend, and for each scanner law a probe def that Bend resolves to that law. It compares the set of law ids, not their order, and it refuses Bend output it does not recognise rather than passing it. `intent-check` stays Bend-free and offline. Open laws in files LAWS.bend imports are discounted from that count. It compares the set of laws, not their order. The probe is a temporary `.crosscheck-<pid>.bend` file in the model directory, removed afterwards (also on Ctrl-C); the directory must be writable, and `.crosscheck-*.bend` is worth a .gitignore entry.

Node >=22.19 runs the zero-dependency kit. Exit 0 means pass; 1 means rejected evidence; 2 means malformed/missing input, unavailable tools, timeout or output cap. Failures name the stale evidence and a repair. Vendored script headers are `// pi-intent v<version> sha256=<body-hash>` after the shebang, if present. `intent-check` validates its own header and every kit-owned `.mjs` header in `.intent/tools/`, requiring one consistent version; unrelated app tools are ignored. A body hash excludes the header line. This reveals local drift, not malicious script replacement.
