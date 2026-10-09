# Architecture

For contributors and integrators: module ownership, provider request boundaries, and the one permitted base-provider exception.

## Architecture

| Layer | Modules |
| --- | --- |
| Provider integration | `upstream-anthropic.ts`, `anthropic-context-compat.ts`, `anthropic-alias-stream.ts`, `codex-adapter.ts`, `provider-registration.ts`, `catalog-rebinding.ts`, `image-strip.ts` |
| Account discovery and credentials | `discovery.ts`, `credential-lifecycle.ts`, `credential-refresh.ts`, `warmer.ts`, `account-labels.ts` |
| Routing policy | `runtime-state.ts`, `error-classification.ts`, `cooldowns.ts`, `routing.ts`, `preflight.ts`, `model-support.ts` |
| Continuation lifecycle | `continuation.ts`, `watchdog.ts`, `compaction.ts`, `lifecycle.ts` |
| Operator surfaces | `commands.ts`, `command-completions.ts`, `fuzzy.ts`, `status-view.ts`, `logical-route-indicator.ts`, `diagnostics.ts`, `diagnostic-store.ts`, `logical-model-switcher.ts`, `logical-model-selector.ts` |
| Usage and shared state | `usage.ts`, `shared-usage.ts`, `usage-fetch.ts`, `window-history.ts`, `history-store.ts`, `machine-lease.ts` |
| Cost intelligence | `cost-history.ts`, `cost-digest.ts`, `cost-digest-store.ts`, `cost-period-closer.ts`, `cost-report*.ts`, `coverage-attestation.ts` |
| Metered last resort | `openrouter-fallback.ts`, `openrouter-budget.ts`, `pricing-cache.ts`, `api-pricing.ts` |
| Composition | `index.ts` |

The extension does not register `before_provider_request`. The captured in-tree
Anthropic configuration still owns OAuth callbacks, headers, and ordinary
requests. A narrow stateless selector sends adaptive requests to the
MIT-licensed local adapter and leaves every other request on the vendored
`0.2.5-intel.1` stream. Before invoking either stream, the selector reconstructs current Pi
transcript system text and active tool declarations in the legacy context form
that both implementations consume. The adaptive adapter imports the vendored
prompt, message, and tool helpers and changes only adaptive-thinking fields.
The base provider and numbered aliases use that same selector; it does not
replay errors. Because Pi merges a later provider registration over an earlier
one, the extension registers that base configuration again once at session
start. This is its only permitted base-provider exception.
