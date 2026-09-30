# ADR 0002 — Cursor committed entries; bound live events

A pi-daemon cursor covers committed entries in pi's active session branch. Within-turn SDK events are best effort in bounded per-reader queues. Overflow emits `gap` and forces committed catch-up. The daemon will not keep a second durable event log in MVP.

- **Status:** Accepted
- **Date:** 2026-03-12

## Context

Pi session files are append-only trees of entries with IDs, parents, timestamps, and one active leaf (`dist/core/session-manager.d.ts:17-21,173-182`; `docs/session-format.md:1-4,174-185,306-318`). The manager can cold-open a file and read entries, branch, leaf, header, and tree (`dist/core/session-manager.d.ts:239-287,318-325`).

Pi persists finalized messages at `message_end`. `message_update` and `tool_execution_*` are emitted live but are not appended there (`dist/core/agent-session.js:383-425,501-555`). The first file flush is delayed until an assistant exists, then pi writes the full prefix synchronously (`dist/core/session-manager.js:726-755`). Therefore a cursor over all SDK events would claim durability pi does not provide.

A proof of concept established the attach seam: subscribe, capture a snapshot/high-water point, buffer concurrent live activity, replay, suppress already delivered entries, drain, then go live. It delivered 26 contiguous events with no duplicates, and two readers agreed on 19 overlapping sequences.

## Decision

`Cursor = { entryId, epoch }` identifies the last processed committed entry on an active branch. Replay walks the pi file, never a daemon event store.

Attach registers the reader before snapshot. It replays through a captured high-water point, buffers concurrent live frames, suppresses duplicate committed IDs during drain, then goes live.

Each reader has frame and byte limits. Overflow reserves and emits one `gap {lost,resumeFrom,demoted:true}`, drops the transient suffix, and catches up committed entries from `resumeFrom`. A cursor on an abandoned branch returns `cursor_off_branch` and the common fork point.

## Consequences

- Conversation and daemon history have one authority.
- Committed replay is restart-safe and branch-aware.
- Transient token/tool updates can be lost; the protocol says so explicitly.
- Slow readers cannot grow daemon memory without bound.
- Consumers persist cursors only from `entry` frames.
- Important daemon transitions must be small `pi-daemon/*` custom entries if they need replay. Pi excludes those from model context (`dist/core/session-manager.d.ts:59-73`).

## Rejected alternatives

### A. Daemon-owned durable event log

Rejected for MVP because it creates a second source of truth and requires crash, branch, ordering, compaction, and corruption reconciliation with pi's file. It remains a deferred option only if a named consumer proves exact transient replay is necessary.

### B. Unbounded per-reader live queues

Rejected. One stalled reader could exhaust the daemon and every hosted session.

### C. Silently drop live events

Rejected. Consumers could mistake an incomplete display for complete history. Loss must be a `gap`.

### D. Snapshot before subscribing

Rejected. An append between snapshot and subscription disappears from both replay and live delivery.
