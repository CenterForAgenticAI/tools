# Initial design

For contributors and integrators: the enduring goals and boundaries behind the shipped multi-account extension.

The extension was designed around four constraints that still apply:

1. Pi owns credentials. Account aliases give each OAuth login its own provider ID, but raw tokens stay inside Pi's credential boundary.
2. Selection is conservative. The extension prefers an eligible account that can serve the requested model and does not replay a failed provider request.
3. Shared account health needs machine-wide coordination. One Pi process must not treat an account as available while another has established a bounded cooldown or invalid state.
4. Cross-provider routing is explicit. A destination and its model policy must be configured; OpenRouter remains a separately consented, budgeted final rung.

The shipped implementation also keeps account policy separate from read-only health and reporting surfaces. Agents may inspect account state, but account lifecycle, session-group selection, and configuration remain operator actions.

The current module map and provider boundary are in [Architecture](architecture.md). The current route order and recovery guarantees are in [Routing and recovery](routing.md).

Repository contributors who need the complete dated design record must also read `docs/maintainers/Initial Design.md`. That workback record is intentionally excluded from the public export.
