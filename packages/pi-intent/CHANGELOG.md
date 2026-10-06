# Changelog

## Unreleased

- Feature: per-module receipts (schema 2). A record may declare an optional `## Modules` section; `intent-receipt` then judges each module against only its own clauses and laws (plus the shared non-law blocks), so a model whose whole state exceeds Jev's ~32K-token request ceiling can still be receipted. `## Modules` is now a reserved heading: rename an existing prose section of that name, and write each rule as one line, and use LF or CRLF line breaks, before declaring modules. Records without a `## Modules` heading and existing schema 1 receipts are unchanged. See SPEC.md, "Modules and receipt schema 2".
- Fix: `intent-receipt` also budgets Jev requests by estimated input tokens. The Jev server refuses requests above about 32K tokens (`max_tokens_exceeded`), long before the byte cap. Tokens are estimated at a deliberately conservative 2.3 bytes per token (measured: digit-heavy text 2.3, Bend and code about 3.0 to 3.1, prose up to 3.7). The estimate can refuse a state of about 71 KB or more that the server would accept: set `PI_INTENT_BYTES_PER_TOKEN=3.0` for Bend/code (3.7 only for plain prose; values above 3.7 are rejected) or split the model per module. The record, laws, model and the largest possible fidelity question are checked before any Jev call, so an oversized state is refused before any spend.
- Fix: `intent-receipt` sends coverage and fidelity questions in batches that keep each Jev request under 131072 bytes (the state is resent per batch), (and at most 128 questions, pi-fabric's per-request cap), merging answers by id and rejecting a model change between batches. Large records and law sets no longer fail with "Jev request exceeds 131072 bytes". Receipt format is unchanged; existing receipts stay valid. Set `PI_INTENT_MAX_REQUEST_BYTES` (16384 to 1048576) if you raised pi-fabric's `maxRequestBytes`; the default matches pi-fabric's 131072. Jev's own server ceiling is not probed here.

## 0.4.0

- **Breaking:** the Bend modelling skill is renamed from `compiled-intent` to `compiled-intent-model` (directory `skills/compiled-intent-model/`). pi-caair-dev-tools ships a different skill named `compiled-intent`, and name-based loaders resolved that name to it. `load_skill compiled-intent` no longer reaches pi-intent; load `compiled-intent-model`. The `intent-lawyer`, `intent-prover` and `intent-judge` agents now list the new name.

## 0.3.0

- **Breaking:** adopter state moves under one hidden `.intent/` directory, including vendored scripts at `.intent/tools/`. Migrate with `git mv intent .intent && git mv tools .intent/tools && npx pi-intent vendor .`. Receipts stay valid because they bind file contents, not paths.

## 0.2.0

- First public release.
