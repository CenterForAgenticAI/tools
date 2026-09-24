// Offline / PWA client: registers the service worker, tracks which artifacts are pinned for
// offline reading, drives bulk sync (recent / project), and mounts a shared status panel.
//
// The service worker is the single source of caching truth — "syncing" an artifact is just
// fetching its metadata + raw bytes while online so the worker caches them. Video/audio are
// skipped (docs-first): they stream via Range requests and stay online-only in v1.
import { esc, shortProject } from "/common.js";
import { annotationQueue } from "/annotation-queue.js";

const PINNED_KEY = "pa-pinned";
const CONTENT_CACHE_PREFIX = "pa-content-";
const API_CACHE_PREFIX = "pa-api-";
const OFFLINE_KINDS = new Set(["markdown", "html", "pdf", "code", "image", "other"]);

const listeners = new Set();
let installPrompt = null;

function emit() {
  for (const fn of listeners) {
    try { fn(); } catch { /* listener errors must not break sync */ }
  }
}

function readPinned() {
  try {
    const raw = JSON.parse(localStorage.getItem(PINNED_KEY) || "[]");
    return new Set(Array.isArray(raw) ? raw.map(String) : []);
  } catch {
    return new Set();
  }
}

function writePinned(set) {
  localStorage.setItem(PINNED_KEY, JSON.stringify([...set]));
  emit();
}

export const offline = {
  supported: "serviceWorker" in navigator && "caches" in window,
  isPinned(id) { return readPinned().has(String(id)); },
  pinnedCount() { return readPinned().size; },
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  async pin(id) {
    id = String(id);
    if (!(await warm(id))) return false;
    const set = readPinned();
    set.add(id);
    writePinned(set);
    return true;
  },

  async unpin(id) {
    id = String(id);
    if (await annotationQueue.count(id)) {
      if (!confirm("This artifact has unsynced annotation changes. Remove its offline copy and discard those queued changes?")) return false;
    }
    const set = readPinned();
    set.delete(id);
    writePinned(set);
    await purge(id);
    await annotationQueue.purge(id);
    return true;
  },

  async toggle(id) {
    if (this.isPinned(id)) await this.unpin(id);
    else await this.pin(id);
    return this.isPinned(id);
  },

  // Fetch the newest N modified artifacts (doc kinds only) into the offline cache.
  async syncRecent(n = 20, onProgress) {
    const r = await fetch(`/api/list?sort=modified&limit=${encodeURIComponent(n)}`);
    const { items = [] } = await r.json();
    return syncItems(items, onProgress);
  },

  async syncProject(project, onProgress) {
    const r = await fetch(`/api/list?project=${encodeURIComponent(project)}`);
    const { items = [] } = await r.json();
    return syncItems(items, onProgress);
  },

  async clearAll() {
    for (const name of await caches.keys()) {
      if (name.startsWith(CONTENT_CACHE_PREFIX) || name.startsWith(API_CACHE_PREFIX)) await caches.delete(name);
    }
    writePinned(new Set());
    await annotationQueue.clear();
  },

  async estimate() {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    try { return await navigator.storage.estimate(); } catch { return null; }
  },
};

async function warm(id) {
  try {
    if (navigator.serviceWorker?.ready) await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 5_000);
        navigator.serviceWorker.addEventListener("controllerchange", () => { clearTimeout(timeout); resolve(); }, { once: true });
      });
    }
    if (!navigator.serviceWorker.controller) throw new Error("service worker is not controlling this page yet");
    const viewer = await fetch(`/view/${id}`, { cache: "no-store" });
    if (!viewer.ok) throw new Error("artifact viewer unavailable");
    const metadata = await fetch(`/api/artifact/${id}`, { cache: "no-store" }).then((response) => response.ok ? response.json() : null);
    if (!metadata) throw new Error("artifact metadata unavailable");
    const version = metadata?.artifact?.current_version;
    const raw = await fetch(Number.isSafeInteger(version) ? `/raw/${id}/v/${version}` : `/raw/${id}`, { cache: "no-store" });
    if (!raw.ok) throw new Error("artifact bytes unavailable");
    if (Number.isSafeInteger(version)) {
      const sidecar = await fetch(`/api/artifact/${id}/annotations?version=${version}`, { cache: "no-store" });
      if (!sidecar.ok) throw new Error("annotation sidecar unavailable");
      if (metadata?.artifact?.kind === "html") {
        const frame = await fetch(`/annotation-frame/${id}/v/${version}`, { cache: "no-store" });
        if (!frame.ok) throw new Error("annotation frame unavailable");
      }
    }
    return true;
  } catch { await purge(id); return false; }
}

async function purge(id) {
  const names = (await caches.keys()).filter((name) => name.startsWith(CONTENT_CACHE_PREFIX) || name.startsWith(API_CACHE_PREFIX));
  for (const name of names) {
    try {
      const cache = await caches.open(name);
      for (const req of await cache.keys()) {
        const path = new URL(req.url).pathname;
        if (path === `/api/artifact/${id}` || path === `/api/artifact/${id}/annotations` || path === `/raw/${id}` || path.startsWith(`/raw/${id}/`) || path.startsWith(`/annotation-frame/${id}/`)) {
          await cache.delete(req);
        }
      }
    } catch { /* cache may not exist yet */ }
  }
}

async function syncItems(items, onProgress) {
  const targets = items.filter((a) => OFFLINE_KINDS.has(a.kind));
  const set = readPinned();
  let done = 0;
  for (const a of targets) {
    if (await warm(a.id)) { set.add(String(a.id)); done++; }
    if (onProgress) onProgress(done, targets.length, a);
  }
  writePinned(set);
  return { synced: done, skipped: items.length - targets.length };
}

export async function registerServiceWorker() {
  if (!offline.supported) return null;
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => undefined);
  }
  try {
    return await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch {
    return null;
  }
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  emit();
});
window.addEventListener("online", emit);
window.addEventListener("offline", emit);

function fmtBytes(n) {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const isStandalone = () =>
  matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;

// Mounts the offline button + panel into the page header. `getProject` (optional) lets the
// explorer offer a "Sync this project" action scoped to the current filter.
export function mountOfflinePanel({ getProject } = {}) {
  if (!offline.supported) return;
  const host = document.querySelector(".offline-menu");
  const btn = host?.querySelector(".offline-toggle");
  const panel = host?.querySelector(".offline-panel");
  if (!host || !btn || !panel) return;

  host.hidden = false;
  let busy = false;
  let open = false;
  const dot = btn.querySelector(".offline-dot");
  const state = btn.querySelector(".offline-connection-state");
  const setStatus = () => {
    const online = navigator.onLine;
    const label = online ? "online" : "offline";
    dot?.classList.toggle("on", online);
    if (state) state.textContent = label;
    btn.title = `Offline (${label})`;
    btn.setAttribute("aria-label", `Offline menu (${label})`);
  };
  const setOpen = (next, restoreFocus = false) => {
    open = next;
    panel.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    if (!open && restoreFocus) btn.focus();
  };
  const setBusy = (v) => { busy = v; render(); };
  const positionPanel = () => {
    if (!open) return;
    const header = host.parentElement;
    if (!header) return;
    const buttonBox = btn.getBoundingClientRect();
    const headerBox = header.getBoundingClientRect();
    const panelBox = panel.getBoundingClientRect();
    const desired = buttonBox.left - headerBox.left;
    const max = Math.max(8, document.documentElement.clientWidth - panelBox.width - 8 - headerBox.left);
    panel.style.left = `${Math.min(Math.max(8, desired), max)}px`;
    panel.style.right = "auto";
  };

  async function render(focusPanel = false) {
    setStatus();
    if (!open) return;
    const online = navigator.onLine;
    const est = await offline.estimate();
    const project = getProject && getProject();
    const canInstall = !!installPrompt && !isStandalone();
    const iosHint = !isStandalone() && /iphone|ipad|ipod/i.test(navigator.userAgent) && !installPrompt;
    panel.innerHTML = `
      <div class="offline-head">
        <strong>Offline</strong>
        <span class="offline-status ${online ? "on" : "off"}">${online ? "online" : "offline"}</span>
        <button type="button" class="offline-x" title="Close" aria-label="Close offline panel">✕</button>
      </div>
      <div class="offline-body">
        <div class="offline-row"><span>Saved for offline</span><span>${offline.pinnedCount()} item${offline.pinnedCount() === 1 ? "" : "s"}</span></div>
        <div class="offline-row"><span>Storage used</span><span>${est ? fmtBytes(est.usage) : "—"}</span></div>
        ${busy ? `<div class="offline-progress">Syncing…</div>` : ""}
        <div class="offline-actions">
          <button type="button" class="offline-act" data-act="recent" ${busy || !online ? "disabled" : ""}>Sync recent 20</button>
          ${project ? `<button type="button" class="offline-act" data-act="project" ${busy || !online ? "disabled" : ""}>Sync “${esc(shortProject(project))}”</button>` : ""}
          <button type="button" class="offline-act danger" data-act="clear" ${busy ? "disabled" : ""}>Clear offline data</button>
        </div>
        ${canInstall ? `<button type="button" class="offline-act install" data-act="install">Add to home screen</button>` : ""}
        ${iosHint ? `<div class="offline-hint">Install: tap <strong>Share</strong> → <strong>Add to Home Screen</strong>.</div>` : ""}
        <div class="offline-hint">Docs, images &amp; PDFs sync for offline reading. Video &amp; audio stream online only.</div>
      </div>`;
    positionPanel();
    if (focusPanel) panel.querySelector(".offline-x")?.focus();

    panel.querySelector(".offline-x").onclick = () => setOpen(false, true);
    for (const el of panel.querySelectorAll(".offline-act")) {
      el.onclick = async () => {
        const act = el.dataset.act;
        if (act === "install" && installPrompt) {
          installPrompt.prompt();
          await installPrompt.userChoice.catch(() => undefined);
          installPrompt = null;
          render();
          return;
        }
        if (act === "clear") {
          const queued = await annotationQueue.count();
          const warning = queued ? ` This also permanently discards ${queued} unsynced annotation change(s).` : "";
          if (!confirm(`Remove all offline-saved artifacts from this device?${warning}`)) return;
          setBusy(true);
          await offline.clearAll();
          setBusy(false);
          return;
        }
        setBusy(true);
        const onProgress = (d, total) => {
          const p = panel.querySelector(".offline-progress");
          if (p) p.textContent = `Syncing ${d}/${total}…`;
        };
        const currentProject = getProject && getProject();
        try {
          if (act === "recent") await offline.syncRecent(20, onProgress);
          if (act === "project" && currentProject) await offline.syncProject(currentProject, onProgress);
        } finally {
          setBusy(false);
        }
      };
    }
  }

  btn.onclick = () => {
    const next = !open;
    setOpen(next);
    if (next) render(true);
  };
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false, true);
    }
  });
  window.addEventListener("resize", positionPanel);
  offline.onChange(render);
  setStatus();
  render();
}
