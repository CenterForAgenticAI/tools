# Storage and privacy

For operators and reviewers: retained files, size and age bounds, sanitization, and data that must never be stored.

## Storage and privacy

All files live below `$PI_CODING_AGENT_DIR/pi-multi-account/` or the equivalent
`~/.pi/agent/pi-multi-account/` default.

| File | Default file bound | Contents |
| --- | ---: | --- |
| `config.json` | operator-managed | Configuration; no credential values. |
| `config.lock` | 2 KiB | Short machine-global lease, mode `0600`, held only while `configure` commits. |
| `usage.ndjson` | 512 KiB | Per-account token and rate-limit observations shared across Pi processes. |
| `diagnostics.ndjson` | 1 MiB | Sanitized routing events, mode `0600`; compaction keeps the newest complete records. |
| `window-history.ndjson` | 128 MiB, 90 days | Utilization-window history. |
| `cost-history.ndjson` | ≤512 MiB, 90 days | Bounded response-cost observations; the byte cap never exceeds Node's safe decoded-string limit. |
| `*-history.ndjson.retention` | one integer line | UTC-day marker that limits ordinary expiry compaction to once per store per day. |
| `cost-period-digest.ndjson` | 64 MiB | Immutable closed-period project/account/model rollups. |
| `api-pricing.json` | 1,000,000 bytes | Cached public pricing data. |
| `openrouter-budget.json` | 64 KiB, 512 projects | Per-project UTC-day worst-case OpenRouter reservations; inactive entries expire after seven days. |
| `declaration-notice.json` | 1 KiB | UTC-day and stale/not-installed condition for the throttled startup warning. |

History expiry is append-driven. The first append to each store on a new UTC day
removes recognized records older than 90 days. A capacity-bound append may repeat
that check during the same day. An idle store retains its existing bytes until
its next append.

Stop every running Pi process before upgrading across the `usage.ndjson` append-cap
change, then restart them. Older processes do not take the new usage mutation
lease. Mixing old and new processes can bypass the cap or race usage compaction.

Observation, diagnostic, digest, pricing, and budget stores may contain
canonical provider IDs, model IDs, token and cost numbers, timestamps, bounded
error categories, and `project-<digest>` keys. They do not contain OAuth tokens,
API keys, authorization headers, request or response bodies, prompts, assistant
text, tool content, request IDs, raw provider errors, or raw project paths.
Human account and project labels remain in `config.json`; renderers resolve them
at output time instead of copying them into retained observations.

Persistent diagnostics reuse the same sanitizer as `/multi-account log`.
Oversized, malformed, or unsafe records are rejected. Storage failures are
fail-soft for managed subscription routing and fail-closed for a metered budget
reservation.
