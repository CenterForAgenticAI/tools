# Usage, cost, and standalone CLI

For operators: retained usage and cost facts, calendar reports, pricing refresh, period closure, and account plan history.

## Usage and cost intelligence

Usage comes from two independent record types:

- response records carry token totals and retained provider cost;
- provider headers and fail-soft usage fetches carry utilization, remaining
  quota, and recovery times.

A token record with no utilization does not hide a real utilization reading.
Fresh local and machine-shared observations inform routing. Stale observations
remain display evidence only.

`/multi-account cost` reports two separate facts:

1. Pi's retained provider cost;
2. an API-equivalent estimate based on a bounded cached public rate snapshot.

The estimate is not a bill. Missing, stale, or malformed pricing stays
`unpriced`; it is never treated as zero or substituted for retained cost.

Reported cost and value figures are scoped to this extension's own retained
provider-response history; they never read or sum a delegate rollup. Joining
delegate usage remains separate future work.

Full-detail utilization-window and response-cost history is retained for 90
days. The first append on each UTC day removes older recognized records under
the history lock; a capacity-bound append repeats expiry before refusing the
write. Closed UTC calendar periods are immutable. Days derive from raw history; ISO weeks and months derive from days;
quarters, half-years, and years derive from months. A missing child period is a
coverage gap, not zero usage. Period closure runs on the first observation in a
new UTC day and before cost rendering under one machine-global lease. It does
not create one timer per Pi process.

## Standalone CLI

The package also ships a standalone `multi-account` shell command (`bin` entry
`multi-account`, `scripts/multi-account.mjs`) that runs independent of any
running Pi session.

### `multi-account cost`

```text
multi-account cost
multi-account cost --period quarter --timezone America/New_York --format json
multi-account cost --from 2026-01-01 --to 2026-04-01 --timezone UTC --format json
multi-account cost --from 2026-01-01T12:00:00-05:00 --to 2026-01-02T12:00:00-05:00 --format json
multi-account cost --all-history --format text
multi-account cost refresh-pricing
multi-account cost close-periods
```

Plain `cost` (default `--period month --format text`) is a strict read-only,
offline probe. It never contacts a provider, refreshes pricing, closes a
period, migrates configuration, edits an account rate, or creates a catalog,
including on an empty first run. It feeds the same pure report projection as
`/multi-account cost` and the `multi_account_status` agent tool. Its
tier-aware API-equivalent pricing draws on the same installed-catalog data
those surfaces use: this package's own pinned `@earendil-works/pi-ai`
dependency inside the standalone process, and the running session's live
model registry inside Pi.

`--period <day|week|month|quarter|half-year|year>`, paired `--from`/`--to`,
and `--all-history` are mutually exclusive; `--format` is `text` or `json`
(one versioned document); `--timezone` is an IANA zone (default `UTC`) that
sets calendar-period boundaries and local midnight for date-only custom
bounds. Account-cost allocation always splits at UTC calendar-month
boundaries regardless of this display timezone. A custom bound is an ISO date
(`YYYY-MM-DD`) or an RFC 3339 timestamp with an explicit `Z` or numeric
offset; the range is start-inclusive and end-exclusive.

`multi-account cost refresh-pricing` and `multi-account cost close-periods`
are explicit write actions, kept separate from the read-only report path.
They reach the same authorized OpenRouter pricing cache and machine-leased
period closer the existing slash/tool observation-driven closure already uses.

Exit codes are stable across every standalone command: `0` success
(including a declined confirmation or a truthful empty report), `1` an
unexpected internal failure, `2` a syntax, argument, or domain validation
failure, `3` when retained data cannot satisfy the requested precision, `4`
for corrupt retained cost history, and `5` for an explicit
`refresh-pricing`/`close-periods` action failure. Text or JSON goes to
standard output; diagnostics go to standard error.

### `multi-account account set-plan`

```text
multi-account account set-plan <account-id> --type <preset-id> --effective-from <timestamp> [--monthly-usd <amount>]
```

Assigns a shipped or operator-added catalog preset as an account's new
effective rate record. `--effective-from` is always required as an RFC 3339
instant with an explicit `Z` or numeric offset; it is never inferred from a
history start or renewal boundary. The command resolves the preset, prints a
preview naming the account, provider, account type, preset, monthly rate,
effective instant, and catalog version, then asks for a literal `y`/`yes`
confirmation before writing anything. `--monthly-usd` overrides the preset's
default rate; an explicit `0` is a valid rate and differs from having no rate
at all. A later catalog edit never rewrites an existing rate record or a past
report result.

This command never migrates the legacy `monthlySubscriptionUsd` value: it does
not read, convert, or delete it, and it never invents an `--effective-from`
from a history start or renewal boundary. Recording rate history for an
account that already has a legacy value requires this explicit,
operator-supplied instant; there is no automatic migration path.

Run `multi-account --help`, `multi-account cost --help`, or
`multi-account account set-plan --help` for the exact current grammar.
