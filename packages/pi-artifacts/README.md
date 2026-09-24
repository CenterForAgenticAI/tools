# pi-artifacts

A central, cross-device registry + viewer for the file artifacts your pi agent
sessions produce — Markdown summaries, HTML reports/presentations, PDFs, diagrams,
code, images, audio, video, and other browser-viewable media. An always-on serving daemon indexes
and serves them over your tailnet, so you can read them from any device.

## Install

```sh
pi install npm:@centerforagenticai/pi-artifacts
```

This installs the Pi extension and its bundled skills.

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
  Screen") and readable offline. See [Offline mode](#offline-mode) below.
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
  (`skills/pi-artifacts/`, `skills/pi-artifacts-applets/`, and
  `skills/pi-artifacts-reports/`) contributed via the `resources_discover` event.

## Viewers

| Kind      | Rendering |
|-----------|-----------|
| Markdown  | markdown-it + GitHub styling, **mermaid** diagrams, highlight.js code, DOMPurify-sanitized |
| HTML      | sandboxed `<iframe>` (self-contained docs keep their own CSS/JS) + metadata toolbar |
| PDF       | direct link — `/view/:id` 302-redirects to raw bytes so the browser/native viewer opens it |
| Code/text | highlight.js syntax highlighting |
| Image     | inline `<img>` |
| Video     | native responsive `<video controls>` player with byte-range seeking |
| Audio     | native `<audio controls>` player with byte-range seeking |
| Other     | browser-native rendering in a restricted frame when possible; safe download fallback |

The `/raw/<id>` endpoint supports HTTP `Range` requests (including suffix ranges such as
`bytes=-65536` via `curl -r`), so video/audio seek and head/tail access work for any artifact.
`.ndjson` and `.jsonl` files are classified as **code/text** with MIME `application/x-ndjson`.
For text artifacts larger than 1 MiB, the viewer fetches a 64 KB head and tail preview and offers
a **Load full content** button, keeping multi-megabyte files responsive.

Explorer supports a **List / Projects** view switch (Projects view groups artifacts
under collapsible project headers showing the **full project path** + count), filter
**by project**, sort by **modified / created / title**, and full-text **search**
(title + project + extracted body). Light/dark mode toggle; view + theme are persisted.
PreviewShip-published artifacts show an external-link badge; it becomes **stale** when a
new artifact version is registered but not yet republished. A metadata + **version history**
drawer is on every viewer (full project path, source path, PreviewShip deployment, switch
versions, open raw, download). All viewer libraries are vendored under `web/vendor/` — no CDN at runtime.

### Printing artifacts

The viewer supplies print styles for Markdown, code/text, and image artifacts. Browser **Print** /
**Save as PDF** output omits the viewer toolbar, metadata and comment panels, selection and offline
controls, and other surrounding interface. Wide Markdown tables use a fixed page-width layout with
wrapped cells; Markdown and plain code wrap long lines instead of clipping them at the page edge.
Printing also switches viewer-rendered content to a high-contrast light palette.

Self-contained HTML artifacts run in a fixed-height sandboxed `<iframe>`. The frame cannot paginate
a long inner document, and `web/app.css` cannot style that document. Open **↗ raw** first and print
that page for complete multipage output; printing the outer viewer shows this instruction instead
of silently clipping the frame. The HTML artifact's own stylesheet must still include `@media print`
rules. General guidance and a reusable starting snippet live in
[`skills/pi-artifacts/SKILL.md`](skills/pi-artifacts/SKILL.md#print-friendly-artifacts). House reports
already include tuned print behavior in `templates/report/report-reader.css`; use the
`pi-artifacts-reports` skill for those rather than replacing its rules. The blocking `print-e2e`
GitLab job generates reviewable A4/Letter PDFs under `test-results/print/`.

## Narrative-first analysis reports with evidence on demand

`templates/report/` is the house standard for agent-produced analysis with a readable narrative and
a dense evidence layer. Use the **combined report** by default: it puts both bodies into one
self-contained artifact, starts as the same centered narrative report, and reveals the evidence in
a synchronized second pane only when requested. This avoids the `companionHref` sibling-path
problem: separately registered artifacts do not share relative file paths, so a cross-link to the
other generated file can return 404.

The combined report includes an inline, dependency-free Web Speech API reader. The reader enumerates
the narrative sections only; evidence is never given section playback buttons or added to the speech
queue. Its panel remains dismissible to a `Listen` pill with `Alt+Shift+L`, and that preference is
remembered. Evidence is deliberately different: its open state is never stored, so every page load
starts narrative-first.

Write narrative and evidence fragments with unique `<section id="…">` elements. Map narrative
sections to one or more evidence sections in metadata:

```json
{
  "title": "Analysis title",
  "date": "2026-08-05",
  "provenance": "Agent analysis of repository state at commit abc1234",
  "evidenceMap": {
    "what-happened": ["event-log", "runtime-audit"],
    "what-to-do": ["findings-register"]
  }
}
```

Then generate one file:

```bash
node scripts/make-report.mjs \
  --kind combined \
  --body path/to/narrative-body.html \
  --evidence path/to/evidence-body.html \
  --meta path/to/combined-meta.json \
  --out path/to/report.html
```

### GitLab references in reports

Bake GitLab titles and states into the generated file so references remain useful offline. Supply a
manifest with the explicit `--references` flag:

```bash
node scripts/make-report.mjs \
  --kind combined \
  --body path/to/narrative-body.html \
  --evidence path/to/evidence-body.html \
  --meta path/to/combined-meta.json \
  --references path/to/gl-references.json \
  --out path/to/report.html
```

The manifest has one default project and entries keyed by GitLab reference token:

```json
{
  "defaultProject": "group/project",
  "references": {
    "#123": {
      "kind": "issue",
      "iid": 123,
      "title": "Make report citations self-contained",
      "state": "opened",
      "url": "https://gitlab.example/group/project/-/work_items/123"
    }
  }
}
```

Use `#123` for an issue, `!7` for a merge request in the default project,
`group/project!7` for a cross-project merge request, and `@abcdef1` for a commit. For deliberate
references and custom visible text, write `<a data-gl-ref="#123">the tracking issue</a>`. An empty
anchor uses the token as its text. Existing links whose `href` matches a manifest URL are upgraded
without changing the author's link text; issue and work-item URL forms are treated as equivalent.
Known bare `#NNN` text is also linked by walking parsed text nodes. Text inside `code`, `pre`, `kbd`,
or an existing anchor is never changed.

Any GitLab-form token outside the exclusion contexts that is absent from the manifest stops
generation and names both the token and source file. This includes bare `#NNN` prose; add the correct
same-project or explicit cross-project reference instead of silently shipping an unresolved number.
Generated links carry kind, number, title, and state in one accessible name. Their
inline SVG shape also distinguishes open, closed, and merged states; color is only decorative. The
visual tooltip is hidden from assistive technology. Its script removes the native `title` fallback,
positions the tooltip against the viewport so evidence and table scrollers cannot clip it, and
closes it on blur or Escape.

Create or update a manifest from authored fragments with the authenticated `glab` CLI:

```bash
node scripts/gl-refs.mjs \
  --project group/project \
  --out path/to/gl-references.json \
  path/to/narrative-body.html path/to/evidence-body.html

# Refresh already-recorded titles and states as well as adding missing entries.
node scripts/gl-refs.mjs --project group/project --out path/to/gl-references.json \
  --refresh path/to/narrative-body.html path/to/evidence-body.html
```

The helper bulk-loads open and closed items with `glab ... list --all`, then calls `glab issue view`
for requested work-item types that list output omits. It authenticates before fetching and writes
only after every requested entry succeeds, so an authentication or lookup failure cannot replace a
good manifest with partial data. Commit the manifest and use it as the build input; report builds do
not contact GitLab.

Mapped narrative sections get an **Evidence** button, the header has a global **Evidence** toggle,
and `Alt+Shift+E` toggles the pane outside text-entry controls. On wide screens, evidence opens on
the right; on narrow screens, it replaces the narrative until **Back to the narrative** is used.
Opening from a mapped section selects its first target. With **Follow narrative** on, narrative
scrolling keeps that target synchronized. Manually scrolling evidence or choosing its own table of
contents turns follow off, announces the change politely, and leaves a visible control to resume it.

The evidence pane is `hidden` at startup, absent from the accessibility tree and tab order. Opening
moves focus into it; closing restores focus to the opening control and, on narrow screens, restores
the narrative scroll position. The evidence pane has its own heading, complete table of contents,
related-evidence links, close control, shortcut hint, and polite live status. Printing produces the
narrative followed by all evidence, with interactive controls suppressed.

Use `--kind narrative` or `--kind detailed` for a genuinely standalone reading mode. Those existing
kinds still use a relative `companionHref` and otherwise work unchanged. The helper rejects body
scripts, remote or unresolved resources, duplicate/missing section IDs, and every unknown
`evidenceMap` key or target. A reproducible example of all three kinds lives under
`examples/reports/`; the combined example turns its bare `#123` into a manifest-backed reference.
Regenerate all three files with `npm run reports:example`. Load the
`pi-artifacts-reports` skill for the full authoring and browser-verification workflow.

## Offline mode

The explorer is an installable PWA, so on a phone you can add it to the home screen and read
your artifacts with no connection.

- **Install**: open the tailnet URL, then **Add to Home Screen** (Chrome/Android shows an
  in-app "Add to home screen" button; iOS Safari: **Share → Add to Home Screen**). It launches
  standalone with the app icon. A secure context is required — the `https://…ts.net/` tailnet URL
  (or `http://localhost`) qualifies; plain-HTTP LAN IPs do not.
- **What syncs**: markdown, HTML, code, images, and PDFs are cached for offline reading.
  Video and audio stream online only in v1 (they rely on HTTP range requests).
- **How it syncs** (hybrid):
  - *Cache-on-view* — anything you open while online is automatically readable offline afterwards.
  - *Pin* — the **⤓ / 📥** button on each explorer card (and the viewer toolbar) saves a single
    artifact for offline.
  - *Bulk* — the floating **Offline** panel offers **Sync recent 20** and **Sync “<project>”**
    (scoped to the current project filter), shows storage used, and has **Clear offline data**.
- **How it works**: the service worker (`web/sw.js`) precaches the app shell + vendored viewer
  libraries (stale-while-revalidate), serves `/api/*` network-first with a cached fallback, and
  serves `/raw/:id` cache-first. It synthesizes HTTP 206 partial responses from a cached full body,
  so **PDF viewers seek offline**. Pinning also warms the immutable annotation sidecar and HTML
  annotation frame. Annotation mutations stay in IndexedDB when disconnected, remain visible after
  reload as an optimistic projection, and replay automatically on page open/focus/visibility or
  reconnect; a true per-comment edit conflict requires an explicit **Retry rebase** or **Discard**.
  The daemon serves `/manifest.webmanifest` and a root-scoped
  `/sw.js` (`Service-Worker-Allowed: /`); icons live under `web/icons/` and are regenerated with
  `node scripts/gen-icons.mjs`.

## Small applets

Applets are intentionally lightweight: quick one-off tools that belong next to the artifact
explorer, not a full plugin/app platform. Access control is the same as the artifact daemon:
if you can reach it over localhost or the tailnet/Tailscale Serve URL, you can use the applet.
There is no separate login/session layer.

Create a starter applet:

```bash
pi-artifacts applet-init team-notes --title "Team Notes"
pi-artifacts serve
# open: $(pi-artifacts url)/applets/team-notes/
```

That creates:

```text
~/.pi/artifacts/applets/team-notes/
├ applet.json
├ index.html       # static frontend; React/Vite build output works too
└ backend.mjs      # optional backend handler
```

Manifest shape:

```jsonc
{
  "id": "team-notes",
  "title": "Team Notes",
  "description": "Tiny shared note pad",
  "entry": "index.html",
  "backend": "backend.mjs"
}
```

Frontend files are served from `/applets/team-notes/`. If you build a small React-style UI,
copy the generated static files into the applet directory and set `entry` to the built HTML.
Client-side routes without a file extension fall back to the entry file, so simple SPA routing
works.

Backend modules export `handle(req, res, ctx)` or a default function. They receive:

- `ctx.db`: a `DatabaseSync` connected to this applet's private SQLite DB
- `ctx.dataDir`: writable directory for applet-local files
- `ctx.readJsonBody()`: parse the request body as JSON
- `ctx.json(status, obj)` / `ctx.send(status, body, headers)`: response helpers

Example backend endpoint:

```js
export async function handle(req, res, ctx) {
  const url = new URL(req.url || "/", "http://localhost");
  ctx.db.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL)");
  if (url.pathname.endsWith("/notes") && req.method === "POST") {
    const body = await ctx.readJsonBody();
    ctx.db.prepare("INSERT INTO notes (text) VALUES (?)").run(String(body.text || ""));
    return { ok: true };
  }
  if (url.pathname.endsWith("/notes")) {
    return { items: ctx.db.prepare("SELECT id, text FROM notes ORDER BY id DESC").all() };
  }
  return ctx.json(404, { error: "not found" });
}
```

The explorer home page links to the applet index at `/applets` and shows a compact
**Applets** section when any manifests are present.

## Install the CLI (one-time, on each development machine)

From this checkout:

```bash
npm install
npm link                      # expose this checkout's `pi-artifacts` bin on PATH
pi-artifacts --help
```

A normal `npm install` installs dependencies but does not globally expose the root package's
own `bin` entry. If you do not want a global development link, use
`npm exec -- pi-artifacts <command>` from this repository instead. Registration is available as
both `pi-artifacts add <file>` and `pi-artifacts register <file>`.

## Install the serving daemon (one-time on the store owner)

```bash
pi-artifacts install          # launchd service + tailscale serve (daemon port → Serve)
# or, without touching tailscale:
pi-artifacts install --no-tailscale
```

Do not install a second daemon on a client device; configure its CLI or extension to use the
serving daemon as described in [Remote clients](#registering-from-the-macbook-cross-machine).

`install` writes `~/Library/LaunchAgents/com.pi.artifacts.plist` (RunAtLoad + KeepAlive),
starts the daemon, and points `tailscale serve` at it. Config lives in
`~/.pi/artifacts/config.json`; `port`, `host`, and `clientScheme` are transport settings only.
Use `publicBaseUrl` or `PI_ARTIFACTS_PUBLIC_URL` for a validated explicit override when needed.
The daemon otherwise discovers its canonical HTTPS Serve authority, mount, and port automatically.
Logs: `~/.pi/artifacts/daemon.log`.

In pi, run `/reload` to load the extension.

The client address and canonical public URL are reported separately by `pi-artifacts status`;
unavailable or ambiguous Serve mappings produce an actionable message rather than a local or guessed
link.

## Usage

### From a pi session

The agent can call the **`artifact`** tool, or you can use slash commands:

```
/artifact <path> [title…]      register a file (referenced: live pointer + snapshot)
/artifacts                     list this project's artifacts + explorer URL
/artifacts open                print the explorer URL
/artifacts-url                 print the explorer URL
```

Use **`artifact_comments`** to read durable viewer threads from an immutable snapshot. Its
transcript is intentionally bounded; complete comment, reply, author, selector, and placement
records are returned in tool `details`. Agent writes are always explicit—reading never posts.

```json
{ "id": "<artifact-id-or-view-url>", "versionId": 3, "status": "open", "limit": 50 }
```

Use **`artifact_comment_create`** to post an agent-authored top-level review finding. It requires
an explicit immutable `versionId` plus a complete selector from the rendered corpus (`type`,
`start`, `end`, exact `quote`, `prefix`, `suffix`; HTML also requires `selector`). Use
**`artifact_comment_reply`** with the exact parent comment id to append an agent reply without
changing the thread's open/resolved status. Neither write tool runs automatically. Both use
content-derived operation ids (idempotent replay, no duplicates) and honor cancellation. Agent
comments are immutable — the daemon returns `403 ANNOTATION_FORBIDDEN` for any body edit or delete,
even from a viewer script — and agent writes appear in an open viewer only after a reload.

In a source checkout, run browser annotation coverage with `node --test tests/*.e2e.mjs`.
It uses Playwright Chromium; install its browser with `npx playwright install chromium` when it
is not already available. On iOS, offline annotation replay still happens only while the page
is active (open, focused, visible, or newly
online), so physical Safari touch/background behavior remains a release smoke-check item.

### Immutable snapshot retrieval

Retrieve the current or an explicit historical stored snapshot without following a referenced live source:

```jsonc
{ "action": "get", "id": "<artifact-id>" }
{ "action": "get", "id": "<artifact-id>", "version": 42, "output": "tmp/report.md" }
```

The CLI prints the same JSON result shape:

```bash
pi-artifacts get <artifact-id>
pi-artifacts get <artifact-id> --version 42 --output ./report.md
```

Success metadata always includes `artifactId`, `version`, `title`, `kind`, `mime`, `byteLength`, and `sha256`, with `disposition` set to `inline` or `materialized`. Valid UTF-8 Markdown, HTML, and code snapshots with a compatible text MIME type up to and including 64 KiB return exact `content`. Larger text, invalid UTF-8, binary, unsupported kinds, and kind/MIME conflicts are written as exact bytes to `path`; `--output` always forces a file. Downloads stream to a collision-safe staging file, verify byte length and SHA-256, then atomically replace the requested output. Failed or interrupted downloads remove partial files. A caller cancellation or active-transfer close is `INTERRUPTED`; setup, timeout, and pre-response transport failures are `TRANSPORT_ERROR`.

Retrieval uses configured local or remote HTTP/HTTPS transport, is not scoped to the caller's project, and returns stable error codes including `INVALID_ARTIFACT_ID`, `INVALID_VERSION`, `ARTIFACT_NOT_FOUND`, `VERSION_NOT_FOUND`, `SNAPSHOT_UNAVAILABLE`, `LENGTH_MISMATCH`, `HASH_MISMATCH`, `INTERRUPTED`, `TRANSPORT_ERROR`, and `OUTPUT_ERROR`.

### From any shell (CLI)

```bash
pi-artifacts add report.html --title "Q3 Review" --tags review,q3
pi-artifacts register demo.mp4 --title "Demo recording"  # alias for add
pi-artifacts add interview.m4a --stored
pi-artifacts add scene.data --mime model/gltf-binary
pi-artifacts add notes.md --stored                 # snapshot-only
pi-artifacts publish <artifact-id|report.html> [--name stable-project-name]
pi-artifacts list [--project P] [--q text] [--sort modified|created|project|title]
pi-artifacts open [id]                              # print + open URL
pi-artifacts applets                                # list small applets
pi-artifacts applet-init <id> [--title T]           # scaffold one
pi-artifacts tag <id> a,b,c
pi-artifacts archive|restore <id>
pi-artifacts rm <id>                                # delete (blobs pruned by gc)
pi-artifacts repair-types --dry-run                 # preview kind/mime repairs inferred from bytes
pi-artifacts repair-types --apply                   # repair mismatched stored kind/mime metadata
pi-artifacts gc                                     # prune unreferenced blobs
pi-artifacts status | url
pi-artifacts uninstall                              # remove launchd service
pi-artifacts tailscale | tailscale-off              # (re)configure / reset serve
```

`--project` defaults to the current git repo name; mode defaults to `referenced`. Common media
types are inferred from filenames and signatures; use `--mime type/subtype` for uncommon
browser-native formats.

## PreviewShip external publishing

PreviewShip support is deliberately opt-in: `add` / `add_content` only register inside the
private pi-artifacts daemon. Publishing happens only through `artifact` action `publish`,
`/artifact-publish`, or `pi-artifacts publish` and uploads data to an external service.

One-time setup on the **daemon host**, as the same OS user that runs pi-artifacts:

```bash
npx previewship login
# non-interactive alternative (avoid shell history when possible):
PREVIEWSHIP_API_KEY=ps_live_... pi-artifacts serve
```

The daemon uses PreviewShip's official `previewship` package. Authentication precedence is
`PREVIEWSHIP_API_KEY`, then `~/.previewship/config.json`. The API key is never stored in the
pi-artifacts database or returned to clients.

Publish an existing artifact or register-and-publish one HTML/Markdown file:

```bash
pi-artifacts publish 4f0d5c9a110e
pi-artifacts publish report.html --name quarterly-review
pi-artifacts publish README.md --stored --json
```

From the agent tool:

```jsonc
{ "action": "publish", "id": "4f0d5c9a110e" }
{ "action": "publish", "path": "report.html", "projectName": "quarterly-review" }
```

Only registered HTML and Markdown snapshots are supported. Publishing always uses the stored
snapshot for the current artifact version—not unregistered live-file changes—so the recorded
version and external bytes agree. Generated PreviewShip project names include the artifact ID to
avoid collisions; a custom or previously recorded name is remembered and reused, preserving the
fixed URL across republishes. Registering a newer version marks the explorer's PreviewShip badge
stale until the artifact is published again.

The publish endpoint requires an agent-only `Sec-*` request marker that browser JavaScript cannot
set, and rendered HTML runs in an opaque-origin sandbox. Consequently, artifact content can render
scripts but cannot trigger credentialed PreviewShip publishing through the viewer. This marker is a
browser boundary, not a general tailnet authentication mechanism; the daemon remains intended for
a trusted tailnet.

Password configuration is intentionally not accepted through the agent tool (tool arguments are
session history). Manage project access separately with PreviewShip's CLI. Republishing omits an
access override, so an existing project's current public/password setting is preserved.

## Registering from a remote client (cross-machine)

Point the CLI/extension at the serving daemon over the tailnet. Set in the client's
`~/.pi/artifacts/config.json` (or env):

```jsonc
{
  "host": "daemon.example.com",
  "port": 443,
  "clientScheme": "https"
}
```

`clientScheme` controls transport only. Keep `http` for a loopback daemon or use `https` for a
remote daemon endpoint. The serving daemon, not this client configuration, supplies every ordinary
artifact, annotation, explorer, and applet URL. Automatic discovery preserves a mapped path and
non-default HTTPS port; an explicit `publicBaseUrl`/`PI_ARTIFACTS_PUBLIC_URL` override is validated
and preserves its scheme, port, and base path. For example: `https://daemon.example.com:8443/artifacts/`.

The register call streams the file's bytes, so large media does not need JSON/base64 wrapping or
whole-file buffering and the snapshot always works. The daemon defaults to a 4 GiB per-file limit;
override it with `PI_ARTIFACTS_MAX_UPLOAD_BYTES` when needed. Crash-left `upload-*` staging files
are reclaimed after 24 hours without touching unrelated files. New clients negotiate streaming
support and retain a bounded legacy JSON fallback for files up to 45 MiB. A source path received
over a remote connection is snapshot-only by design; local trusted registrations render live when the
daemon can read the path and otherwise transparently fall back to the snapshot.

## Repairing artifact type metadata

If an older inline artifact was registered without a filename extension, it may have been stored
as `kind=other` / `application/octet-stream` even though the bytes are Markdown or HTML. Preview
and apply metadata-only repairs with:

```bash
pi-artifacts repair-types --dry-run
pi-artifacts repair-types --apply
```

The repair runs through the daemon, sniffs stored snapshot bytes, and updates artifact + current
version kind/mime metadata without changing artifact IDs or blob content.

## Development and quality baseline

This package is validated on **Node 22** in CI. The TypeScript sources are run
directly with Node's native type-stripping and `node:sqlite` flags; the package
`serve` script and launchd install path both pass those flags explicitly.

Install exactly from the lockfile and run the blocking checks locally with:

```bash
npm ci
npm run check      # lint + typecheck + webcheck + blocking coverage + smoke
npm run coverage   # V8/c8 text, lcov, and Cobertura reports
npm run quality    # alias for the canonical check command used by GitLab CI
```

Coverage is source-inclusive for `index.ts`, `src/**/*.ts`, and `bin/**/*.ts`,
including files not reached by the test suite, and writes reports under `coverage/`
(`text`, `lcov`, and `cobertura-coverage.xml`). The measured all-source baseline is
**84.68% statements**, **71.44% branches**, **89.05% functions**, and **84.68% lines**;
blocking floors are **72% statements**, **69% branches**, **87% functions**, and
**72% lines**. These conservative integer floors guard against regressions without
assuming untested CLI paths are covered.

Git hooks are tracked but opt-in only; they are never auto-installed by npm. To
enable the tracked `.githooks/` directory through repository-local Git configuration, run:

```bash
node scripts/install-hooks.mjs
```

The installed hooks run `npm run lint && npm run typecheck` before commits and
`npm run coverage` before pushes.

`npm test` runs the same suite without coverage instrumentation. Use it as the
fast local loop; `check` deliberately does not call it, because `npm run
coverage` already executes the same files. `lint` and `typecheck` keep their
caches under `node_modules/.cache/`, so `npm ci` in CI always starts cold.

## Roadmap

- **Phase 2**: inter-artifact link rewriting (Markdown/HTML cross-links resolve to
  `/view/:id`, with dynamic content rewriting).
- Auto-capture suggestions from write/edit tool results (currently agent-driven via the tool
  guidelines + `pi-artifacts` skill, not a write-watcher).

## Files

```
index.ts              pi extension (tool + commands + prompt reminder)
src/config.ts         paths, port, tailnet config
src/store.ts          SQLite index + content-addressed blobs + versioning + FTS
src/previewship.ts    snapshot publishing + tracked PreviewShip deployment metadata
src/applets.ts        small applet discovery + per-applet SQLite helpers
src/server.ts         the daemon (run: node src/server.ts)
src/client.ts         HTTP client (extension + CLI)
bin/pi-artifacts.ts   CLI (add/list/install/tailscale/gc/…)
web/                  explorer + viewers + vendored libs
templates/report/     self-contained combined/standalone report templates + inline runtimes
scripts/make-report.mjs       combined and standalone report generator
scripts/gl-refs.mjs           GitLab reference manifest builder and refresher
examples/reports/             reproducible source + generated report demonstration
skills/pi-artifacts/          bundled artifact-management skill
skills/pi-artifacts-applets/  bundled applet-authoring skill
skills/pi-artifacts-reports/  bundled report-authoring skill
```

## License

MIT. See [LICENSE](LICENSE).
