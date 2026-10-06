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
| `diagnostics.ndjson` | 1 MiB | Sanitized events, mode `0600`; compaction selects newest failure/routing records before routine observations, then returns append order. |
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

Response-header diagnostics retain only named, validated quota and retry facts.
Unknown header names, request identifiers, private prose, and malformed values
under known names are dropped. Memory, disk writes, reads, and restart apply the
same projection. Old header records are safe when read; they are rewritten only
by ordinary bounded compaction, not by an eager migration.

Unified and alias public response projections copy named fields instead of the
provider object. Assistant text, thinking, tool arguments, and their protocol
signatures remain response content for the host; they are not diagnostic data.
Structured refusal and unknown-stop explanations use fixed reasons and closed
stop codes, not raw provider prose or unknown reason payloads.

Persistent diagnostics reuse the same sanitizer as `/multi-account log`.
Priority selection applies to memory, disk compaction, and count-limited reads;
reads are not necessarily a contiguous newest suffix. A priority flood can still
evict older priority records. A stable peer-append tail keeps its bytes and can
reduce the priority prefix budget to zero. The file bound applies after successful
compaction; a busy lease or I/O failure can leave the file temporarily over cap.
Files remain owner-only, compaction remains machine-leased, and persistence stays
fail-soft. See [Failure evidence and diagnostic retention](diagnostic-retention.md)
for the exact selection budget and bounds.
Oversized, malformed, or unsafe records are rejected. Storage failures are
fail-soft for managed subscription routing and fail-closed for a metered budget
reservation.
