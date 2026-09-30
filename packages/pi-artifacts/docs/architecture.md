# Architecture reference

For contributors and operators: how the extension, command-line client, daemon, store, and viewers fit together.

## Architecture

```
 pi session ─┐
 CLI ────────┼──HTTP──▶  serving daemon (127.0.0.1:8787)  ──▶  ~/.pi/artifacts/
 loopback/remote clients ──────────┘                     │                              ├ index.db   (node:sqlite + FTS)
                                   │                              ├ blobs/<sha256>  (versioned snapshots)
                                   │                              ├ annotations/<artifactId>.json
                                   │                              ├ staging/  (bounded streaming uploads)
                                   │                              ├ applets/<id>/  (small app frontends/backends)
                                   │                              └ applet-data/<id>/applet.db
                          tailscale serve (HTTPS, MagicDNS)
                                   │
                    any tailnet device's browser ──▶ explorer / viewers
```

- **Daemon** (`src/server.ts`): zero-dependency Node HTTP server (Node 22+ runs the
  TypeScript directly with native type-stripping flags; SQLite is the built-in `node:sqlite`).
  Single writer — the extension and CLI clients register over HTTP.
- **Store** (`src/store.ts`): content-addressed blob store + SQLite index + FTS5 search.
  Every register uploads bytes → a **guaranteed snapshot** (works cross-machine);
  identical content is de-duplicated, changed content creates a **new version**.
- **Small applets** (`~/.pi/artifacts/applets/<id>/`): quick artifact-adjacent mini apps
  served by the same daemon under `/applets/<id>/`. Each applet is just static frontend
  files, an `applet.json` manifest, and optionally a backend module mounted at
  `/api/applets/<id>/…`. The backend gets its own `node:sqlite` DB at
  `~/.pi/artifacts/applet-data/<id>/applet.db`.
- **Referenced vs stored**: a `referenced` artifact keeps a live pointer to the original
  file (rendered live for trusted loopback registrations when the daemon can read the path)
  **plus** a snapshot fallback.
  A `stored` artifact is snapshot-only. Default for on-disk files is `referenced`.
- **PreviewShip publishing**: an explicit publish action uploads the artifact's registered
  HTML/Markdown snapshot to PreviewShip, records the fixed external URL + deployment metadata,
  and shows current/stale publish state in the explorer. Normal registration remains tailnet-only.
- **Document comments**: Markdown, code, and HTML snapshots use a document-first commenting flow rather than the metadata drawer. Choose **Comments**, select text, and use the contextual **+ Comment** action beside the passage; threads live in a dedicated desktop rail or mobile comments sheet with explicit Edit, Resolve/Reopen, and Delete actions. Comments are durable JSON sidecars at `~/.pi/artifacts/annotations/<artifactId>.json`, pin an immutable origin selector **and SHA-256 blob digest** plus per-version placements, and use ETag compare-and-swap to avoid overwriting another editor's notes. The client only renders an exact or uniquely contextual placement; ambiguous and orphaned placements remain visible as status rather than highlighting unrelated text. Offline create/edit/delete/placement changes queue in dependency-free IndexedDB, replay in causal order with operation IDs, and item conflicts remain visible for explicit retry or discard. HTML annotation mode preserves authored markup, CSS, and passive assets while injecting a nonce-authorized selector/placement bridge into an opaque sandbox (no `allow-same-origin`); it reports inert selection geometry only to position the parent-owned comment affordance. Authored scripts are intentionally inert in annotation mode so they cannot forge trusted bridge messages; normal HTML viewing still runs authored scripts in its separate opaque sandbox. CSP and runtime guards disable script-initiated connections, forms, and top-level navigation, and comment bodies are never sent into the frame.
- **Offline / installable (PWA)**: the explorer is a Progressive Web App — a web app manifest
  (`web/manifest.webmanifest`) + service worker (`web/sw.js`) make it installable ("Add to Home
  Screen") and readable offline. See [Offline mode](viewers.md#offline-mode).
- **Public URLs**: the serving daemon is authoritative for every ordinary artifact, annotation,
  explorer, and applet URL. It automatically discovers one matching HTTPS Tailscale Serve mapping
  (`tailscale serve status --json`), preserving its mount path and HTTPS port. A loopback client
  therefore receives the same canonical URL as a remote client; client transport addresses are
  diagnostic only. If discovery is unavailable or ambiguous, the daemon reports an actionable
  unavailable result instead of returning localhost or a guessed host. Set `publicBaseUrl` in
  `~/.pi/artifacts/config.json` or `PI_ARTIFACTS_PUBLIC_URL` for an explicit validated HTTP/HTTPS
  override, for example `https://node.example.com:8443/artifacts`. Credentials, queries,
  fragments, local/private addresses, and raw Tailscale IPs are rejected.
- **Extension** (`index.ts`): registers the `artifact` tool + slash commands. Awareness is
  carried by the tool's `promptSnippet`/`promptGuidelines` (always-on but cheap, in the system
  prompt's Guidelines); deeper how-to lives in bundled, on-demand **skills**
  (`skills/pi-artifacts/`, `skills/pi-artifacts-applets/`, `skills/pi-artifacts-reports/`, and
  `skills/pi-artifacts-authoring/`) contributed via the `resources_discover` event.
