# pi-intent

**Kind:** extension · **Status:** experimental · **Pi:** >=0.85 · **Node:** >=22

This package is experimental and its formats may change.

pi-intent turns expressed intent into rules a checker can prove, then checks whether the app's real code follows them. It keeps three records per change:

- **Intent record:** numbered rules, worked examples, freedoms, non-goals and open questions, approved by a person. Terms cite the project's `CONTEXT.md`.
- **Compiled-intent model:** claims in `LAWS.bend`, one proof per law in `PROOF.bend`, and deliberately failing negative controls. A person approves the claims by their SHA-256 hash.
- **Jev receipt:** typed judgments about whether the laws match the approved record, bound to both files by SHA-256. Code computes the verdict from the answers.

A proved model is not proof of the app. **Conformance** compares output from the model with an **oracle**: a small program that calls the app's actual decision function. A deliberately broken model must disagree with that oracle.

## Install the prerequisites first

pi-intent does not bundle other pi packages. Install these before installing pi-intent:

| Prerequisite | Why | Install |
|---|---|---|
| pi-fabric | runs the Jev evaluations that produce receipts | `pi install npm:pi-fabric` |
| pi-work | carries intent records into workspecs and model-change nodes | `pi install npm:@centerforagenticai/pi-work` |
| pi-delegate | runs independent reviews of laws and proofs | `pi install npm:@centerforagenticai/pi-delegate` |
| pi-artifacts | shows the plain-language law projection for approval | `pi install npm:@centerforagenticai/pi-artifacts` |
| bend | checks `LAWS.bend` and `PROOF.bend` | `curl -fsSL https://bend-lang.com/install.sh \| sh` |
| jev-fabric | runs Jev from scripts outside a pi session | `curl -fsSL https://raw.githubusercontent.com/monotykamary/jev-fabric/main/install.sh \| sh` |

Jev also needs a credential. Configure one through pi-fabric (`/login jev`, `/login openrouter` or `/login vercel-ai-gateway`). When a session starts, pi-intent warns if a prerequisite is missing. Run `/intent-prereqs` to check again.

The offline scripts need none of those pi packages or credentials. They need Node; the proof gate and Bend model oracles also need Bend on PATH (tested at 2.0.34). Node 22.19 or later is required by this package's engines; the TypeScript example uses Node's built-in type stripping. Use a newer Node or your normal compiler/runner for TypeScript that needs transformation.

## Start an adopting repo

```sh
pi install npm:@centerforagenticai/pi-intent
# With the package installed through npm, its bin is also available:
npm install --save-dev @centerforagenticai/pi-intent
npx pi-intent init .
# Update only the scripts in an existing adopter:
npx pi-intent vendor .
```

If installed only as a pi package, run `node <installed-package>/bin/pi-intent.mjs init .` using its resolved installation directory. `init` scaffolds a draft; it does not approve a record or supply your app oracle. `vendor` overwrites `.intent/tools/` copies. Review local edits first. Each script carries the package version and a SHA-256 body hash so local drift is visible.

```text
.intent/records/NNNN-slug.md
.intent/model/LAWS.bend PROOF.bend Lib.bend neg/*.bend laws.sha256
.intent/receipts/<record-id>.json
.intent/conform.json
.intent/oracle/…
.intent/tools/*.mjs
```

All tool-created project state lives in one hidden `.intent/` directory. Run commands from the repo root (or pass that root as the argument), not from `.intent/`. ripgrep and fd skip hidden directories by default; search `.intent` explicitly or use `rg --hidden` / `fd --hidden`.

### Migrate from 0.2.0 to 0.3.0

Review local script edits, then move the old directories and refresh the scripts:

```sh
git mv intent .intent && git mv tools .intent/tools
npx pi-intent vendor .
```

Update build hooks, workspec paths and oracle/manifest command paths to `.intent/`. Receipts remain valid when file contents stay unchanged: they bind record and law contents, not paths.

Read [SPEC.md](SPEC.md) for the first format version. The three shipped skills guide drafting (`intent-records`), Bend authoring (`compiled-intent-model`) and app parity (`intent-conformance`). New projects draft then approve a record; retrofits describe actual behaviour first, then ask which behaviour to keep.

## Three checks

| Check | Run it | Proves |
|---|---|---|
| `node .intent/tools/intent-check.mjs` | every build | record structure, approved law hash, current receipt hashes, integrity and recomputed passing policy; no Bend or network |
| `node .intent/tools/intent-gate.mjs` | CI | freshness plus Bend proofs, failing negative controls and absence of forbidden bypass constructs |
| `node .intent/tools/intent-conform.mjs` | opt-in build/CI | model rows match actual app rows; broken model differs; lists uncovered laws |

Add `--require-coverage` to conformance to reject uncovered laws. Exit 0 means pass, 1 rejection, 2 missing/malformed input or unavailable tool, timeout or output cap. Failures say what to repair. `BEND_BIN` can select the proof-gate executable; manifest commands select their own executable.

### Build hooks

**npm** (merge with your existing build scripts):

```json
{"scripts": {
  "prebuild": "node .intent/tools/intent-check.mjs",
  "build": "tsc",
  "intent:ci": "node .intent/tools/intent-gate.mjs && node .intent/tools/intent-conform.mjs --require-coverage"
}}
```

**Make** (also suitable for Go):

```make
.PHONY: intent-check build intent-ci
intent-check:
	node .intent/tools/intent-check.mjs
build: intent-check
	go build ./...
intent-ci:
	node .intent/tools/intent-gate.mjs
	node .intent/tools/intent-conform.mjs --require-coverage
```

**Cargo:** put this in `build.rs` for the compiler-free check. Cargo runs it when the listed inputs change; run the standalone check in CI as well.

```rust
fn main() {
    for path in [".intent/records", ".intent/model", ".intent/receipts", ".intent/tools"] {
        println!("cargo:rerun-if-changed={path}");
    }
    let status = std::process::Command::new("node")
        .arg(".intent/tools/intent-check.mjs").status().expect("install Node >=22.19");
    assert!(status.success(), "intent freshness rejected; read the error above");
}
```

**Go:** `go generate` can run the fast check explicitly; it is not automatically run by `go build`. Make the Makefile above your build entry point, or use:

```go
//go:generate node .intent/tools/intent-check.mjs
```

**CI**, with Node, Bend and the app toolchain preinstalled:

```sh
node .intent/tools/intent-check.mjs
node .intent/tools/intent-gate.mjs
# opt in for finite decisions connected to app code
node .intent/tools/intent-conform.mjs --require-coverage
```

Do not give CI Jev credentials. Commit the authoring receipt before CI runs.

## Languages and oracle examples

| App language | Model | Real oracle | Needed where checks run |
|---|---|---|---|
| TypeScript / JavaScript | Bend; language-neutral decision | import the real app function | Node, Bend, app compiler/runner if needed |
| Go | same Bend model | main package imports app package | Node, Bend, Go |
| Rust | same Bend model | binary imports app crate | Node, Bend, Cargo/Rust |
| Python | same Bend model | import app module | Node, Bend, Python |
| Other | same Bend model | any executable emitting rows | Node, Bend, its app toolchain |

The fast check alone needs only Node. The gate needs Bend regardless of app language. Conformance does not use Jev.

[examples/transitions](examples/transitions) models one decision over `idle`, `working`, `blocked` and `not-running`: stopped sources reject; active sources allow every target. All 16 source/target pairs are exercised. Its approval and receipt are labeled synthetic fixtures, not real human/Jev approval. The example stores its tree as `intent/` because npm and the public release omit dot-directories; adopters use `.intent/`.

The TypeScript oracle imports `src/session.ts`; the Go main imports `go/session`; the Rust binary imports the `transition_session` library; the Python oracle imports `python/session.py`. Each calls the implementation, not a copied predicate. Stage a scratch adopter before running from the package checkout (the tests do the same):

```sh
mkdir -p .scratch
example=$(mktemp -d .scratch/transitions-XXXXXX)
cp -R examples/transitions/. "$example/"
mv "$example/intent" "$example/.intent"
node kit/intent-check.mjs "$example"
BEND_BIN="$HOME/.bend/bin/bend" node kit/intent-gate.mjs "$example"
PATH="$HOME/.bend/bin:$PATH" node kit/intent-conform.mjs "$example" --require-coverage
rm -rf "$example"
```

The staged example manifest uses these real commands (the Rust manifest points its binary at `../.intent/oracle/rust.rs`):

```json
["node", ".intent/oracle/typescript.mjs"]
["go", "run", "./.intent/oracle/go"]
["cargo", "run", "--quiet", "--manifest-path", "rust/Cargo.toml"]
["python3", ".intent/oracle/python.py"]
```

Adapt `conform.json` to the languages installed in your project. Package tests require TypeScript, Go and Python; Rust is skipped with a reason only when Cargo is absent. Tests also change the real code to prove drift rejects, and substitute a wrongly retyped oracle/model to prove the broken-model control rejects.

## Package agents

pi-delegate discovers these shipped agents through `pi-delegate.agents` in the package manifest:

| Agent | Bare model id | Role |
| --- | --- | --- |
| `intent-lawyer` | `claude-opus-5-5` | Proposes neutral laws and negative controls from an approved record; maps each law to a clause. Never edits the approval hash or implementation. |
| `intent-prover` | `gpt-6.1-sol` | Writes proofs, implementation and the real-code oracle; reports failed obligations and attempts without changing laws, records, approval hashes or receipts. |
| `intent-judge` | `gpt-6-astra` | Advisory ruling for a stuck prover: implementation hint, human law-change proposal, or intent clarification. Not the Jev receipt producer `kit/intent-receipt.mjs`. |

The farm's credentialed `unified` provider resolves these bare ids with failover; no farm override file is needed. The farm must expose those models. Agent tool lists are minimal: lawyer has read/edit/write, prover also has bash for validation, and judge has read/write only (write is for its ruling). File-specific prohibitions are prompt rules, not a filesystem sandbox; dispatch with an appropriate write scope and attempt budget. None may approve human-owned claims.

The offline package smoke asserts the packed manifest and parses all agent frontmatter with Pi's parser. It does not require pi-delegate or farm credentials; actual pi-delegate package discovery is verified separately during development.

## Jev at authoring time

After human record and law approval:

```sh
# The standalone command dynamically imports this optional authoring dependency.
npm install --no-save pi-fabric
node .intent/tools/intent-receipt.mjs . 0001-transitions <jev-model>
```

`intent-receipt` needs `pi-fabric` resolvable from the authoring project, not merely installed in a separate pi package directory. It imports `pi-fabric/jev` and exits 2 with an installation hint if unavailable. Model identifiers select the route:

| Requested model | Route | Credential |
| --- | --- | --- |
| `jev-1.13` | TypeSafe | `TYPESAFE_API_KEY` or pi `/login jev` |
| `typesafe/jev-1.13` | OpenRouter | `OPENROUTER_API_KEY` or pi `/login openrouter` |
| `typesafe-ai/jev` | Vercel AI Gateway | `AI_GATEWAY_API_KEY` or pi `/login vercel-ai-gateway` |

Both evaluations must echo the same model identifier. A requested id may resolve to a dated snapshot (`<requested-id>-YYYYMMDD`); the receipt records that echoed snapshot, not the undated request. Other model echoes reject. Tests inject fake evaluators and clients; they never call live Jev.

Coverage asks one Choice per clause over the laws plus `none`. Fidelity asks one Noul (probability of true) per law about its selected clauses. Policy requires coverage confidence and selected probability >=0.8, fidelity >=0.9, and at least one clause mapped to every law. The receipt keeps model, questions, answers, probabilities, hashes and policy version. Only code chooses pass/reject. CI recomputes that verdict offline.

The integrity hash detects accidental receipt edits. It is not a signature: a person who can rewrite the receipt and checksum can forge one. Review commits and protect approvals. Jev itself is fallible; independent review and negative controls still matter.

## Worked pi-work example

The approved record feeds pi-work's draft, which is promoted into a workspec. Keep the clause text and record path through decomposition. Following pi-work ADR-0009, changes to allowable states belong in a model-change node; implementation depends on that node. pi-work does not depend on pi-intent: the link is ordinary command evidence.

This is a **workspec fragment** to add after pi-work's draft promotion, retaining the promoted title, description, intent and source/criterion lineage:

```yaml
work:
  - id: model-change
    task: Encode the approved session transition rules and prove them.
    refs:
      - path: .intent/records/0001-transitions.md
        why: Human-approved R1 and R2 define allowable transitions.
    touches: [.intent/model/**, .intent/receipts/**, .intent/tools/**]
    acceptance:
      - id: receipt-current
        statement: The laws encode approved R1 and R2 with a current passing receipt.
        evidence:
          kind: command
          run: node .intent/tools/intent-check.mjs
          expect:
            exit: 0
            output_includes: "intent-check: ok"
      - id: model-proven
        statement: R1 and R2 are proved and their negative controls fail.
        evidence:
          kind: command
          run: node .intent/tools/intent-gate.mjs
          timeout_ms: 180000
          expect:
            exit: 0
            output_includes: "intent-gate: ok"
  - id: implementation
    task: Implement the transition decision and real-code oracle.
    depends_on: [model-change]
    touches: [src/**, .intent/oracle/**, .intent/conform.json]
    acceptance:
      - id: app-conforms
        statement: Actual session decisions follow the approved transition laws.
        evidence:
          kind: command
          run: node .intent/tools/intent-conform.mjs
          timeout_ms: 180000
          expect:
            exit: 0
            output_includes: "broken model differs"
```

Use pi-work's `work_validate`, then `work_verify` with the spec path, node id, explicit worktree and expected commit. Its fail-closed verification leaves missing, stale or unsuccessful evidence unverified. Add `--require-coverage` to the command when all laws must be connected.

## Limits

Use this for finite decisions, not emergent behaviour. Timing, race safety, throughput and multi-process effects need an ordinary test that names the applicable law. Matching rows only prove the enumerated cases; declared law coverage and oracle calls still need review.

Bend is young and has consistency caveats; retain deliberately failing controls for each law. In format v1 each approved record covers the complete current model; use a cumulative approved record for a multi-change model. See SPEC.md for that limit and the trust boundaries.

## Develop

```sh
npm install
npm run check
```

The gate lints, type-checks, runs node:test under c8 floors, builds the extension and loads the packed package and its skills through pi. The kit is plain zero-dependency `.mjs`; keep runtime `dependencies` empty.
