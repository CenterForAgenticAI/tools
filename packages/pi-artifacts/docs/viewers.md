# Viewer and offline reference

For artifact readers and operators: supported rendering, printing, explorer features, and offline behavior.

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
[`skills/pi-artifacts/SKILL.md`](../skills/pi-artifacts/SKILL.md#print-friendly-artifacts). House reports
already include tuned print behavior in `templates/report/report-reader.css`; use the
`pi-artifacts-reports` skill for those rather than replacing its rules. The blocking `print-e2e`
GitLab job generates reviewable A4/Letter PDFs under `test-results/print/`.

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
