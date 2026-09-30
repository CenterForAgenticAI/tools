# Public API and limitations

For integrators: the reusable core and the limits of Pi's public inspection APIs.

## Public API limitations

Pi currently exposes source provenance for tools and slash commands, but not a complete loaded-extension registry. `/dev extensions` therefore cannot list an extension that contributes neither surface, and package versions are available only when public source metadata includes a usable package `baseDir`.

Pi exposes the effective system prompt and structured construction options, but it does not expose a pristine pre-extension prompt or identify which `before_agent_start` handler made each earlier change. `/dev usage` identifies pi-dev's own stage, groups changes observed after pi-dev, and leaves text already present before pi-dev under “Pi scaffold and unattributed prompt text.” It never names an extension without public source evidence.

The UI API restores custom header/footer by passing `undefined`, but does not expose the previously installed factories or a title getter/clear operation. `/dev ui off` therefore restores Pi's built-in header/footer and title `pi`; it cannot reconstruct a custom header/footer/title installed earlier by another extension.

The public read-only SessionManager exposes the compaction-aware active branch, not the final provider-specific serialized request. `/dev context` reports that public context projection. Provider payload events are intentionally excluded from inspection and tracing because they can contain credentials and private conversation data.

## Core API

The reusable core is declared in `src/index.ts` and exported from the package root:

- Phase B inspection, event tracing, diagnostics (`runDoctor`), UI, and command helpers
- `buildContextUsageSnapshot(input)`, `ContextUsageTracker`, and hierarchical display helpers

The `testing` subpath exports `conformanceContext()` for extension tests that exercise only Pi's public API.
