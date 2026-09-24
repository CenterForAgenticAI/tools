// pi-artifacts service worker (classic script — broad iOS/Android support).
//
// Caching strategy:
//   • App shell (HTML shell, CSS, JS, vendored viewer libs, icons): stale-while-revalidate.
//   • API JSON (/api/list, /api/projects, /api/artifact/:id): network-first, cache fallback.
//   • Raw bytes (/raw/:id[/v/:n]): cache-first for whole-body (no-Range) GETs; Range requests
//     are served from a cached full body via a synthesized 206 when present, else passed to the
//     network (keeps large video/audio online-only in v1 — "docs-first").
//
// Sync is intentionally trivial: the page just fetches the URLs it wants offline while online,
// and this worker is the single source of caching truth for every one of them.

const VERSION = "v6";
const SHELL_CACHE = `pa-shell-${VERSION}`;
const API_CACHE = `pa-api-${VERSION}`;
const CONTENT_CACHE = `pa-content-${VERSION}`;
const CURRENT_CACHES = new Set([SHELL_CACHE, API_CACHE, CONTENT_CACHE]);

// Do not auto-cache whole bodies larger than this on cache-on-view (guards against a browser
// fetching a huge non-range asset). Explicit sync only targets small doc kinds anyway.
const CONTENT_MAX_BYTES = 100 * 1024 * 1024;

const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/app.css",
  "/common.js",
  "/offline.js",
  "/annotations.js",
  "/annotation-queue.js",
  "/annotation-frame.js",
  "/manifest.webmanifest",
  "/vendor/markdown-it.min.js",
  "/vendor/highlight.min.js",
  "/vendor/purify.min.js",
  "/vendor/mermaid.min.js",
  "/vendor/hljs-github.min.css",
  "/vendor/hljs-github-dark.min.css",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-180.png",
];

const VIEW_SHELL_KEY = "/__view_shell__";
const RAW_RE = /^\/raw\/[a-f0-9]+(?:\/v\/\d+)?$/;
const ARTIFACT_RE = /^\/api\/artifact\/[a-f0-9]+$/;
const ANNOTATIONS_RE = /^\/api\/artifact\/[a-f0-9]+\/annotations$/;
const ANNOTATION_FRAME_RE = /^\/annotation-frame\/[a-f0-9]+\/v\/\d+$/;
const VIEW_RE = /^\/view\/[a-f0-9]+$/;

// Copy still-useful entries from an older-version cache into the current one, without
// overwriting anything the fresh install already wrote. Preserves pinned raw bytes and
// annotation sidecars across a version bump.
async function migrateCache(fromName, toName) {
  const [src, dst] = [await caches.open(fromName), await caches.open(toName)];
  for (const req of await src.keys()) {
    if (await dst.match(req)) continue;
    const resp = await src.match(req);
    if (resp) await dst.put(req, resp.clone());
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Tolerate an individual asset 404 rather than failing the whole install.
      await Promise.all(
        SHELL_ASSETS.map(async (url) => {
          try {
            const resp = await fetch(url, { cache: "no-cache" });
            if (resp.ok) await cache.put(url, resp);
          } catch {
            /* offline during install; runtime caching will backfill */
          }
        }),
      );
      // Seed the CURRENT viewer shell so an offline /view/:id right after an upgrade renders the
      // viewer (this build's shell), never the explorer fallback.
      try {
        const shell = await fetch("/__view_shell__", { cache: "no-cache" });
        if (shell.ok) await cache.put(VIEW_SHELL_KEY, shell);
      } catch {
        /* offline during install; a prior-version shell is migrated in activate as a stopgap */
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const stale = (await caches.keys())
        .filter((name) => !CURRENT_CACHES.has(name))
        .map((name) => { const m = /^pa-(shell|api|content)-v(\d+)$/.exec(name); return { name, kind: m && m[1], ver: m ? Number(m[2]) : -1 }; })
        // Migrate the newest prior version first so its copy of any URL wins; older duplicates are
        // then skipped (migrateCache never overwrites), and the freshly installed v5 entries stay.
        .sort((a, b) => b.ver - a.ver);
      for (const { name, kind } of stale) {
        if (kind) {
          const target = kind === "shell" ? SHELL_CACHE : kind === "api" ? API_CACHE : CONTENT_CACHE;
          await migrateCache(name, target);
        }
      }
      for (const { name } of stale) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Annotation-frame URLs carry a fresh channel query on every open. Canonicalize before the
  // generic navigation path so a frame warmed during pinning is available offline.
  if (ANNOTATION_FRAME_RE.test(url.pathname)) {
    event.respondWith(networkFirstCanonical(req, CONTENT_CACHE, url.pathname));
    return;
  }
  // Explicit pinning warms the viewer through a same-origin subresource fetch, whose request
  // mode is not "navigate". Cache the same generic shell key in either mode.
  if (VIEW_RE.test(url.pathname)) {
    event.respondWith(handleNavigate(req, url));
    return;
  }
  if (req.mode === "navigate") {
    event.respondWith(handleNavigate(req, url));
    return;
  }
  if (url.pathname === "/api/list" || url.pathname === "/api/projects" || ARTIFACT_RE.test(url.pathname) || ANNOTATIONS_RE.test(url.pathname)) {
    event.respondWith(networkFirst(req, API_CACHE));
    return;
  }
  if (RAW_RE.test(url.pathname)) {
    event.respondWith(handleRaw(req, url));
    return;
  }
  if (isShellAsset(url.pathname)) {
    event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
    return;
  }
});

async function networkFirstCanonical(req, cacheName, pathname) {
  const cache = await caches.open(cacheName);
  const key = new Request(pathname);
  try {
    const response = await fetch(req);
    if (response.ok) await cache.put(key, response.clone());
    return response;
  } catch {
    return (await cache.match(key)) || new Response("offline", { status: 504 });
  }
}

function isShellAsset(pathname) {
  return (
    pathname === "/app.css" ||
    pathname === "/common.js" ||
    pathname === "/offline.js" ||
    pathname === "/annotations.js" ||
    pathname === "/annotation-queue.js" ||
    pathname === "/annotation-frame.js" ||
    pathname === "/manifest.webmanifest" ||
    pathname.startsWith("/vendor/") ||
    pathname.startsWith("/icons/")
  );
}

async function handleNavigate(req, url) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const resp = await fetch(req);
    // Every /view/:id navigation returns the same viewer shell HTML; store one copy so any
    // artifact can be opened offline. Other navigations cache under their own path.
    const key = url.pathname.startsWith("/view/") ? VIEW_SHELL_KEY : url.pathname;
    if (resp.ok) cache.put(key, resp.clone());
    return resp;
  } catch {
    if (url.pathname.startsWith("/view/")) {
      return (await cache.match(VIEW_SHELL_KEY)) || (await cache.match("/index.html")) || offlineFallback();
    }
    return (await cache.match(url.pathname)) || (await cache.match("/index.html")) || (await cache.match("/")) || offlineFallback();
  }
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const resp = await fetch(req);
    if (resp.ok) cache.put(req, resp.clone());
    return resp;
  } catch {
    const cached = await cache.match(req);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: "offline", offline: true }), {
      status: 503,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((resp) => {
      if (resp.ok) cache.put(req, resp.clone());
      return resp;
    })
    .catch(() => null);
  return cached || (await network) || new Response("offline", { status: 504 });
}

// Cache-first for whole bodies; synthesize partial responses from a cached full body so PDF
// viewers (and other Range consumers) work offline. Uncached Range requests hit the network,
// keeping large media online-only in v1.
async function handleRaw(req, url) {
  const cache = await caches.open(CONTENT_CACHE);
  const range = req.headers.get("range");
  if (range) {
    const full = await cache.match(url.pathname, { ignoreVary: true });
    if (full) return buildRangeResponse(full, range);
    try {
      return await fetch(req);
    } catch {
      return new Response("offline", { status: 504 });
    }
  }
  const cached = await cache.match(url.pathname, { ignoreVary: true });
  if (cached) return cached;
  try {
    const resp = await fetch(req);
    if (resp.ok && resp.status === 200) {
      const len = Number(resp.headers.get("content-length") || "0");
      if (!len || len <= CONTENT_MAX_BYTES) await cache.put(url.pathname, resp.clone());
    }
    return resp;
  } catch {
    return new Response("offline", { status: 504 });
  }
}

async function buildRangeResponse(full, rangeHeader) {
  const buf = await full.arrayBuffer();
  const size = buf.byteLength;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || (!match[1] && !match[2])) {
    return new Response(buf, { status: 200, headers: full.headers });
  }
  let start;
  let end;
  if (!match[1]) {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (start > end || start >= size) {
    return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
  }
  const headers = new Headers(full.headers);
  headers.set("content-range", `bytes ${start}-${end}/${size}`);
  headers.set("content-length", String(end - start + 1));
  headers.set("accept-ranges", "bytes");
  return new Response(buf.slice(start, end + 1), { status: 206, statusText: "Partial Content", headers });
}

function offlineFallback() {
  return new Response(
    "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>" +
      "<body style='font-family:system-ui;background:#0d1117;color:#c9d1d9;display:grid;place-items:center;height:100vh;margin:0'>" +
      "<div style='text-align:center'><h1>Offline</h1><p>This page isn’t available offline yet. Reconnect and open it once to cache it.</p></div>",
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
