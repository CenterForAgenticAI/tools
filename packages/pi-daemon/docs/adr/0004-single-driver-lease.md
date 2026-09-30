# ADR 0004 — Use one driver lease and unlimited watchers

Each session has at most one active driver lease. Any number of watchers may attach and replay. Prompt, abort, and extension UI answers require the driver. Steer, follow-up, and wake are open to any attached client with separate display-only attribution where applicable. Explicit sleep and external-writer `recover` require the driver only while a lease exists; with no lease any attached client may perform them. Idle auto-sleep is daemon policy and never lease-gated.

- **Status:** Accepted
- **Date:** 2026-03-12

## Context

Several clients may observe or resume one long-running session. Concurrent prompts are unsafe: a measured 0.84.4 race lets one idle caller win while the other rejects, with no daemon-level serialization; installed pi also throws when a plain prompt arrives during streaming (`dist/core/agent-session.js:821-872`). UI questions need one authoritative answer. Observation should not block other readers or keep a terminal alive.

Pi does provide explicit `steer()` and `followUp()` queues (`dist/core/agent-session.d.ts:373-388`; `dist/core/agent-session.js:1008-1074`). These are useful collaborative hints when their source is visible but not model-visible authority.

## Decision

The registry enforces one driver row per session. A lease has a server ID, holder attachment, generation, TTL, and expiry. The holder heartbeats it. Release, expiry, or holder disconnect removes authority. Ordinary acquire never steals; explicit takeover atomically revokes the prior lease and records both identities.

Driver authority is required for prompt, abort, and UI answer. Any attached client may wake because wake is non-destructive and concurrent wakes collapse. Explicit sleep and `recover` check the current lease atomically: its holder must authorize either operation when a lease exists, while any attached client may perform it when none exists. `recover` is valid only for registered `external_writer` failure and leaves the runtime asleep. Idle auto-sleep follows daemon policy and never checks a lease. Any attached client may steer or follow up while a run is active.

The server derives actor identity from the connection. A supplied label is sanitized live display metadata and is not persisted. Neither value is inserted into prompt, steer, or follow-up content.

## Consequences

- Prompt/UI ownership and active-lease sleep/recover authority are deterministic.
- A crashed driver releases authority after disconnect or TTL.
- Explicit takeover is visible and auditable in custom entries.
- Watchers scale independently and never need a lease.
- Watchers may wake without taking authority and may sleep or recover only when no driver lease exists.
- Auto-sleep cannot be blocked by an absent, expired, or disconnected driver.
- Steer/follow-up allow limited collaboration without changing driver ownership.
- Generation fencing rejects commands from a replaced host even when a stale lease ID is replayed.
- Multi-human co-driving needs a later policy and protocol decision.

## Rejected alternatives

### A. No arbitration

Rejected. Racing prompts, aborts, and UI answers can produce nondeterministic acceptance and duplicate provider work.

### B. One connection owns the whole session

Rejected. It prevents independent read-only fleet observation and makes caller disconnect equivalent to session loss.

### C. Lease required for all observation

Rejected. Watchers must attach and replay freely, and read-only observation must not block a driver.

### D. Multiple equal drivers

Deferred, not deleted. It needs conflict rules for prompts, UI answers, takeovers, and attribution. MVP preserves actor and lease records so a future ADR can define collaboration.

### E. Put attribution text into the model-visible message

Rejected. Content could forge labels, metadata would change model behavior, and display concerns would become prompt semantics.
