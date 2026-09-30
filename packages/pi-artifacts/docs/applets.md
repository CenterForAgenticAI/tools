# Small applets reference

For applet authors: the manifest, frontend, and optional backend contracts for small tools hosted by the artifact daemon.

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
