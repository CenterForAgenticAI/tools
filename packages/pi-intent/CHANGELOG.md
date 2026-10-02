# Changelog

## 0.4.0

- **Breaking:** the Bend modelling skill is renamed from `compiled-intent` to `compiled-intent-model` (directory `skills/compiled-intent-model/`). pi-caair-dev-tools ships a different skill named `compiled-intent`, and name-based loaders resolved that name to it. `load_skill compiled-intent` no longer reaches pi-intent; load `compiled-intent-model`. The `intent-lawyer`, `intent-prover` and `intent-judge` agents now list the new name.

## 0.3.0

- **Breaking:** adopter state moves under one hidden `.intent/` directory, including vendored scripts at `.intent/tools/`. Migrate with `git mv intent .intent && git mv tools .intent/tools && npx pi-intent vendor .`. Receipts stay valid because they bind file contents, not paths.

## 0.2.0

- First public release.
