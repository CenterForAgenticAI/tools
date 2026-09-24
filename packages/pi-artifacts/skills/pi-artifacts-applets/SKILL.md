---
name: pi-artifacts-applets
description: >
  Create or modify lightweight interactive applets hosted by pi-artifacts. Use when the user asks
  for a quick artifact-adjacent mini app, React-style UI, small SQLite-backed backend, or custom
  tailnet-served workflow under /applets/<id>/.
---

# pi-artifacts applets

Use this skill when creating an interactive mini app hosted by the pi-artifacts daemon.
Applets are deliberately pragmatic: static frontend files plus optional backend endpoints and a
private SQLite DB. They are not a full plugin framework or a hardened multi-user app platform.

## Mental model

- Applet root: `~/.pi/artifacts/applets/<id>/`
- Public UI: `/applets/<id>/`
- Backend API: `/api/applets/<id>/...`
- Per-applet data: `~/.pi/artifacts/applet-data/<id>/`
- Per-applet DB: `~/.pi/artifacts/applet-data/<id>/applet.db`
- Auth: implicit daemon reachability over localhost / Tailscale tailnet. Do not add login/session
  auth unless the user explicitly asks and accepts the extra complexity.

## When an applet is a good fit

Good fits:
- A tiny shared dashboard, checklist, tracker, intake form, review queue, labeler, or annotation UI.
- A one-off workflow that benefits from a browser UI and persistent state.
- A small React/Vite/Svelte/static frontend that can call a few JSON endpoints.
- Something adjacent to artifacts: reviewing generated reports, curating outputs, tracking decisions,
  attaching notes, or presenting a custom view over local/tailnet-only data.

Poor fits:
- A public internet service.
- A security-sensitive multi-user product.
- Anything needing OAuth, roles, background job orchestration, or a migration framework.
- Large apps that deserve their own repository/service.

## Scaffold first

Prefer starting with the built-in scaffold, then edit the generated files:

```bash
pi-artifacts applet-init <id> --title "Human Title"
```

This creates:

```text
~/.pi/artifacts/applets/<id>/
├ applet.json
├ index.html
└ backend.mjs
```

Use lowercase kebab IDs, e.g. `review-queue`, `label-studio-lite`, `meeting-notes`.

## Manifest

`applet.json`:

```jsonc
{
  "id": "review-queue",
  "title": "Review Queue",
  "description": "Quick artifact review triage",
  "entry": "index.html",
  "backend": "backend.mjs"
}
```

Rules:
- `id` must match the directory name and must be URL-safe.
- `entry` defaults to `index.html`.
- `backend` is optional; omit it for static-only applets.

## Frontend pattern

A plain HTML file with `fetch()` is usually enough. A React/Vite build is also fine: build it and
copy the generated static files into the applet directory, then set `entry` to the built HTML.

When porting a Claude-web / Claude artifact app, first identify the persistence seam. Generated
apps may use browser `localStorage`, `window.storage.*`, `sessionStorage`, or IndexedDB-style
helpers. Preserve the UI and state shape where practical, but replace durable writes/reads with
relative applet API calls. Do **not** leave app data only in browser storage for anything the user
expects to survive across devices or browsers.

Frontend requests should use relative daemon paths:

```js
const api = "/api/applets/review-queue/items";
const r = await fetch(api);
const { items } = await r.json();
```

A good porting shape is:

1. `load()` calls `GET /api/applets/<id>/<resource>` and hydrates in-memory UI state.
2. create/update/delete actions call backend endpoints with JSON bodies.
3. after each write, either update local in-memory state from the returned row or re-fetch.
4. keep browser storage only for harmless UI preferences (theme, collapsed panels), not the
   domain data itself.

Client-side routes without a file extension fall back to the applet entry file, so simple SPA
routing works.

## Backend pattern

`backend.mjs` exports `handle(req, res, ctx)` or a default function. Treat the backend as the
source of truth for durable applet state. For a ported single-page app, define a small resource
API that mirrors the old saved objects: e.g. the workout-tracker POC replaced `window.storage`
keys like `entry:<id>` with `GET/POST/DELETE /api/applets/workout-tracker/entries` backed by a
SQLite `entries` table.


```js
export async function handle(req, res, ctx) {
  const url = new URL(req.url || "/", "http://localhost");
  const prefix = "/api/applets/review-queue/";
  const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : "";

  ctx.db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `);

  if (path === "items" && req.method === "GET") {
    return { items: ctx.db.prepare("SELECT * FROM items ORDER BY id DESC LIMIT 200").all() };
  }

  if (path === "items" && req.method === "POST") {
    const body = await ctx.readJsonBody();
    const text = String(body.text || "").trim();
    if (!text) return ctx.json(400, { error: "text is required" });
    ctx.db.prepare("INSERT INTO items (text, created_at) VALUES (?, ?)").run(text, Date.now());
    return { ok: true };
  }

  return ctx.json(404, { error: "not found" });
}
```

Available context:
- `ctx.applet`: manifest-derived applet metadata.
- `ctx.db`: `node:sqlite` `DatabaseSync`, already opened for this applet.
- `ctx.dataDir`: applet-local writable data directory.
- `ctx.readJsonBody(limitBytes?)`: parses request JSON.
- `ctx.json(status, obj)`: sends JSON response.
- `ctx.send(status, body, headers?)`: sends a raw response.

If the handler returns a value and has not already sent a response, pi-artifacts returns it as JSON.

## SQLite guidance

Keep schema setup simple and idempotent:

```js
ctx.db.exec("CREATE TABLE IF NOT EXISTS ...");
```

Use prepared statements for user input. Avoid building SQL by string concatenation. For one-off
applets, inline schema creation in the handler is acceptable; do not introduce a migration system
unless the applet has clearly outgrown the small-applet model.

For domain objects, prefer explicit columns over one giant JSON blob when the shape is stable enough
(e.g. workout entries used `date`, `exercise_id`, `weight`, `set1`, `set2`, `set3`, `notes`,
`created_at`, `updated_at`). Return rows in the frontend's expected shape so the UI port stays small.

## Porting checklist for generated apps

When the source is a Claude-web/Claude-artifact React-ish file:

1. Read the generated file and identify imports/dependencies. If it depends on React/lucide/etc. but
   there is no build pipeline, either copy in a built static artifact or hand-port to plain HTML/JS
   for the POC. Keep the look and interaction model close; do not introduce a framework just to make
   one small applet work.
2. Search the source for persistence APIs: `localStorage`, `sessionStorage`, `indexedDB`,
   `window.storage`, `getItem`, `setItem`, `list`, `delete`.
3. Map old storage keys/objects to a tiny REST-ish API. Example from the first POC:
   `window.storage.list('entry:')` + `window.storage.get/set/delete('entry:<id>')` became
   `GET/POST/DELETE /api/applets/workout-tracker/entries`.
4. Create `applet.json`, `index.html`, and `backend.mjs` under `~/.pi/artifacts/applets/<id>/`.
5. Verify the final frontend has no domain-data browser-storage references:
   ```bash
   rg -n 'localStorage|window\.storage|sessionStorage|indexedDB' ~/.pi/artifacts/applets/<id>
   ```
6. Verify data through both the HTTP API and SQLite DB, not just the visible UI.

## UI guidance

- Favor one screen, clear labels, and optimistic-but-refresh-after-save behavior.
- Use plain CSS or a tiny bundled frontend; avoid CDNs so the applet works across tailnet/offline.
- Keep API responses JSON and small.
- Use `/applets` as the applet index; the artifact explorer homepage links there and shows a compact
  Applets section automatically when manifests exist.

## Validation checklist

After creating or editing an applet:

1. Start a foreground daemon against a test or real home:
   ```bash
   pi-artifacts serve
   ```
2. Open `/applets/<id>/` and confirm static assets load.
3. Exercise every API endpoint with the UI or `curl`.
4. Confirm persistence by reloading and checking that data remains.
5. If changing pi-artifacts source, also run `npm test` from the repository.

## Safety boundaries

- Do not expose secrets in frontend files.
- Do not shell out from applet backends unless explicitly needed and reviewed.
- Do not add heavyweight auth by default; document that access equals tailnet reachability.
- Keep applet-specific files under `~/.pi/artifacts/applets/<id>/` and data under
  `~/.pi/artifacts/applet-data/<id>/`.
