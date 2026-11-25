# Real session files

These session files pin the focus formats this package reads but no longer writes.

- `context-aware-0.8.0.jsonl` is a session that pi-context-aware v0.8.0 (commit 9ec06313059886fa3633dd546daa6844a22b1332) recorded. It holds one `context-aware.workstream.v1` focus entry, plus the task, brief and ask entries that pi-workstream now reads. Copied unchanged from pi-workstream's `tests/fixtures/real-sessions/` at commit ae552d5.
- `pi-workstream-focus.jsonl` holds two `pi-workstream.workstream.v1` entries written by pi-workstream's own `createWorkstreamSnapshot` and `appendWorkstreamSnapshot` at commit ae552d5: a bare snapshot, then a revision with `purpose`, `goalReason`, `issue` and `change` references and a `purpose` mutation. Only the entry envelope (`id`, `parentId`, `timestamp`) was added, as Pi adds it.
