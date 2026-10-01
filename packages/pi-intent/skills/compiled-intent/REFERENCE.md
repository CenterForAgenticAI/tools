# Bend proof patterns for compiled-intent models

Read this before writing or porting a Bend model. It maps the Lean proof
habits used in our models to explicit Bend proof terms, and names the shared
helpers in `Lib.bend`, the generator `gen-enums.mjs`, and the gate `tools/intent-gate.mjs`.

Ported from the architect module's Bend 2.0.28 patterns; pi-intent's gate and
transition fixture are checked with Bend 2.0.34 (`bend --help` prints the version). `bend guide`
prints the language guide; `bend base <Name>` prints a Base definition.

## What changes from Lean

Bend has no tactics and no proof search, by design. A proposition is a type,
and a proof is a `def` of that type. Every step a Lean tactic found for you
must be written out. Upstream declined solver integration in Bend itself and
says automation belongs in a separate tool that emits Bend proof terms; our
generators are that tool.

Consequences:

- Proof text is larger. The pi-delegate pilot needed about 300 proof lines
  where Lean needed about 150.
- Finite facts are cheapest as **computation plus a soundness lemma**: compute
  a `Bool` and prove once, generically, that `True` implies the property.
- Checking is slower. Avoid `String` equality inside computed checks; compare
  numeric codes instead. One string-based distinctness check took 71 s; the
  same check over `Nat` codes takes about 16 s.

## Layout

Follow the Bend convention:

- `LAWS.bend` imports the code and states the claims. People own it. The gate
  requires `laws.sha256` to match it, so a changed claim needs recorded
  approval.
- `PROOF.bend` imports `LAWS.bend` and proves each law with a def of the same
  name (`law sorted` is proven by `def Laws.sorted`). `bend PROOF.bend --check-only` rejects
  while any law is open or false.
- `neg-*.bend` or `neg/*.bend` are negative controls: deliberately broken
  copies that must fail to check. They show a proof is not vacuous.
- Copy `Lib.bend` beside the model and `import ./Lib.bend as L`.

## Tactic map

| Lean | Bend |
|---|---|
| `rfl`, `decide` on a closed term | `{==}` (both sides normalise to the same term) |
| `cases x <;> decide` / `<;> rfl` | `match x:` with one `case` per constructor, each `{==}`; generate it with `gen-enums.mjs` |
| `induction n` | `match n:` on the argument; a recursive call is the induction hypothesis |
| `rw [h]` | `%h : P` then the rest; `P` is the goal with `_` where `h`'s right side stands |
| `simp only [f]` | usually nothing: definitions unfold during checking |
| `exact h` | return `h` |
| `intro h` | a lambda `h => ...`, or a `for h:` law parameter |
| `constructor` (for `∧`) | a pair `(p, q)`; conjunction is `A & B` |
| `obtain ⟨a, b⟩ := h` | `(a, b) = h` |
| `exists w` / `⟨w, p⟩` | `exs y: T` in the law; return `(w, p)` |
| `contradiction` on `False = True` | `L.falseTrue(e)`; general form: rewrite `e` through a motive that maps one side to `Empty`, answer `Unit{}` |
| `absurd` on an empty hypothesis | `Empty.absurd(T, h)`; a `match e:` with no cases closes a branch where `e : Empty` |
| `Ne a b` | `{a != b : T}`, which is `{a == b : T} -> Empty` |
| `List.Nodup xs` | `L.Nodup(A, xs)` |
| `decide` on `Nodup` of a concrete list | `L.sortedC_sound(~A, ~code, xs, Unit{})` when codes ascend (linear); `L.distinctC_sound` otherwise (quadratic) |
| `x ∈ xs` | `L.Mem(A, x, xs)`; product membership by `L.mem_product` |
| `(xs.map f).Nodup` from injectivity | `L.nodup_map(~A, ~B, ~f, ~inj, xs, h)` with `inj` a template proof |
| `Function.Injective key` (finite enum) | a `parse(key(x)) == x` law, then injectivity by three rewrites (see `gen-enums.mjs`) |
| `omega`, `linarith` | no equivalent. Prove the arithmetic lemma by `match` on `Nat` and induction, or restate the rule over a finite domain |
| `Equal.symm`/`trans`/`congrArg` | `Equal.sym`, `Equal.trans`, `Equal.cong` in Base |

## Syntax traps (all observed)

- **Affine by default.** A variable is used at most once. Mark reusable
  parameters, pattern fields and law parameters with `+` (`for +h: ...`,
  `case +h <> +t:`). Reuse requires the type to be `Data`.
- **Order matters.** A def must appear before its use; a law's proof def
  must follow the law. Otherwise Bend reports an unfilled law as a dead claim.
- **Match only on parameters.** To match a computed value, give it its own def
  (the pilot's `takeD.fin` helpers).
- **Termination reads arguments left to right.** Put the decreasing argument
  first. This includes lemmas about the function: `ascC(xs, p)` recursing on
  `xs` with a changing `p` fails if `p` comes first.
- **Proofs of `!=` are functions,** so they are affine and cannot be marked
  `+`. A lemma that uses one per list element does not check; restate it so
  each element carries its own proof, or use a Bool check with `T(...)`.
- **Erased binders** (`-x`) are accepted in `law` and `for`, not in the
  parameter list of the def that fills a law, and not in a tuple pattern.
- **Match all constructor combinations** on two `Nat` arguments. A wildcard
  case such as `case _ 0n` leaves the goal unreduced; `Empty.absurd` then
  needs the literal form, for example `T(ltN(1n+p, 0n))`.
- **Imports** are paths: `import ./Lib.bend as L`, and imported constructors
  are qualified: `C.Supervised{}`.
- **Operators need a type** outside `Nat`: `(a * 3n + b : Nat)`. Spaces are
  required around operators.
- **No `if`**: use `Bool.pick(T, cond, then, else)`.
- **Equality of values is a call** (`Nat.is_eq`, `String.eq`); `==` is only the
  equality type.
- **Templates.** A `~` parameter is inlined at compile time, must be closed, and
  must be leading. A generic helper over a type therefore takes the type as a
  template too: `def notInC(~A: Data, ~code: A -> Nat, ...)`. The law states
  `for ~A: Data`, but the def that fills a law uses plain binders:
  `def distinctC_sound(A, code, xs, h):`.
- **`@unsafe` and `def f?(..)`** skip the termination check. The gate rejects
  both, and `?TODO`.

## Recipes

**Finite enum with keys.** Write a spec and run
`node gen-enums.mjs spec.json > Enums.bend`. You get the type, `key`, `parse`,
`code`, `all`, and three proven laws: `parse_key`, `key_injective`,
`all_nodup`.

**Composite key injectivity** (a record keyed by joined field keys): write a
`split1` on the separator, one `take` per field that parses the head and
returns the rest, and prove `take(key(x) ++ (":" ++ r)) == (x, r)` per field by
case split. Then prove `decode(caseKey(k)) == k` by one rewrite per field and
derive injectivity exactly as `gen-enums.mjs` does. See the pi-delegate pilot
(`model/bend-pilot/PendingCases.bend`, laws `takeD_key` to `roundtrip`).

**No duplicates in a generated product list.** Give the record a mixed-radix
`code` (for fields with sizes 3, 2, 2, 2, 4, 3: `d*96 + o*48 + c*24 + s*12 +
out*3 + w`) and prove `L.Nodup(R, all())` with
`L.sortedC_sound(~R, ~code, all(), Unit{})`. Order the fields in `code` the
same way the list nests them, so codes ascend. Soundness does not need `code`
to be injective; a wrong `code` only makes the check fail. `sortedC` is linear:
on the pi-delegate 252-row event list it took 1.3 s, against 16.6 s for the
quadratic `distinctC_sound`.

**Composite keys from reusable parts.** `L.Prd`, `L.product`, `L.join` and
`L.join_injective` give a two-field key `a:b` and its injectivity from a
head-field `take` law and a tail-field injectivity law. `gen-enums.mjs` emits
`E.take_key` for every enum whose keys contain no `:`. Nest `Prd` for more
fields, right-associated, and pass each inner key's injectivity as the tail:

```
law innerKey_injective:
  for p: L.Prd<N.Presence, N.Presence>
  for q: L.Prd<N.Presence, N.Presence>
  for e: {innerKey(p) == innerKey(q) : String}
  {p == q : L.Prd<N.Presence, N.Presence>}

def innerKey_injective(p, q, e):
  L.join_injective(~N.Presence, ~N.Presence, ~N.Presence.key, ~N.Presence.key,
    ~N.Presence.parse, ~N.Presence.take_key, ~N.Presence.key_injective, p, q, e)
```

Then `L.nodup_map(~R, ~String, ~key, ~key_injective, all(), all_nodup())`
proves the emitted keys are distinct. Keep injectivity laws on plain binders
(`for p:`, not `for +p:`) so they fit the template parameter's type. Do not
name an import alias after a prefix of its types (`import ./E.bend as E`
with `E.Presence` is ambiguous).

**Emit parity with Lean.** While both models exist, build a Bend printer
(`bend Emit.bend -o emit.js`) and compare its output byte for byte with the
Lean fixture printer. Parity is the migration's acceptance check.

## Gate

```sh
node tools/intent-check.mjs [repo-dir]    # offline freshness and receipt policy
node tools/intent-gate.mjs [repo-dir]     # PROOF.bend plus neg/*.bend
node tools/intent-conform.mjs [repo-dir] --require-coverage
```

Exit 0 means PROOF.bend exited successfully and printed a complete
`All terms check.` (older Bend) or `ALL PROOFS CHECK` line without a
`SOME PROOFS FAIL` verdict. Trailing `--verdict` advice is allowed; this gate
runs `--check-only`, not the optional BendTT kernel check. Every negative control
failed at its named declared law, no forbidden construct appears, and `LAWS.bend`
matches `laws.sha256`. `intent-check` also verifies a passing committed Jev receipt
for the current approved record and laws. The receipt policy and lifecycle are in
the installed package's SPEC.md; no Jev call occurs in the gate. Exit 1 is an architectural rejection. Exit 2 means the tool or
an input is unavailable; record that as a blocker, not as a pass.

## Limits

- A green gate proves the Bend model's laws. It does not prove the model
  matches requirements or that production code conforms. Keep the difftest.
- Bend is young. Its README warns that the Lean formalisation of the checker
  and the TypeScript checker mismatch and early consistency bugs may occur.
  Keep negative controls for every load-bearing law.
