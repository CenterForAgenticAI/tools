// Dependency-free durable mutation queue for annotation edits.  It is deliberately separate
// from the service worker: IndexedDB is available in the page and lets the UI surface stale
// compare-and-swap conflicts instead of blindly retrying them in the background.
const DB_NAME = "pi-artifacts-annotation-queue";
const STORE = "mutations";
const SIDECARS = "sidecars";
const SEQUENCES = "sequences";
const MAX_QUEUE_ITEMS = 500;
const REPLAY_BATCH_SIZE = 50;
const listeners = new Set();
let dbPromise;

function notify(event) { for (const listener of listeners) { try { listener(event); } catch { /* observer failures are isolated */ } } }
function db() {
  if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 3);
    request.onupgradeneeded = () => {
      const store = request.result.objectStoreNames.contains(STORE) ? request.transaction.objectStore(STORE) : request.result.createObjectStore(STORE, { keyPath: "id" });
      if (!store.indexNames.contains("artifactId")) store.createIndex("artifactId", "artifactId", { unique: false });
      if (!request.result.objectStoreNames.contains(SIDECARS)) request.result.createObjectStore(SIDECARS, { keyPath: "key" });
      if (!request.result.objectStoreNames.contains(SEQUENCES)) request.result.createObjectStore(SEQUENCES, { autoIncrement: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("cannot open annotation queue"));
  });
  return dbPromise;
}
function transact(mode, action, storeName = STORE) {
  return db().then((database) => new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let value;
    try { value = action(store); } catch (error) { reject(error); return; }
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error || new Error("annotation queue transaction failed"));
    tx.onabort = () => reject(tx.error || new Error("annotation queue transaction aborted"));
  }));
}
function requestResult(request) {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error || new Error("annotation queue request failed")); });
}
function operationId() { return crypto.randomUUID().replaceAll("-", ""); }
function insertQueuedItem(buildItem) {
  return db().then((database) => new Promise((resolve, reject) => {
    const tx = database.transaction([STORE, SEQUENCES], "readwrite");
    const mutations = tx.objectStore(STORE);
    const sequences = tx.objectStore(SEQUENCES);
    let item;
    let failure;
    const fail = (error) => { failure = error; try { tx.abort(); } catch { /* already ending */ } };
    const count = mutations.count();
    count.onerror = () => fail(count.error || new Error("cannot count queued annotations"));
    count.onsuccess = () => {
      if (count.result >= MAX_QUEUE_ITEMS) { fail(new Error("annotation offline queue is full; reconnect or discard a stale queued change")); return; }
      const next = sequences.add({ createdAt: Date.now() });
      next.onerror = () => fail(next.error || new Error("cannot allocate annotation queue sequence"));
      next.onsuccess = () => {
        const sequence = next.result;
        // Deleting the row does not reset IndexedDB's key generator, so ordering remains
        // monotonic without accumulating one durable bookkeeping record per mutation.
        sequences.delete(sequence);
        item = buildItem(sequence);
        if (!validItem(item)) { fail(new Error("invalid queued annotation operation")); return; }
        const add = mutations.add(item);
        add.onerror = () => fail(add.error?.name === "ConstraintError"
          ? new Error("annotation operation is already queued")
          : add.error || new Error("cannot queue annotation operation"));
      };
    };
    tx.oncomplete = () => resolve(item);
    tx.onerror = () => reject(failure || tx.error || new Error("annotation queue transaction failed"));
    tx.onabort = () => reject(failure || tx.error || new Error("annotation queue transaction aborted"));
  }));
}
function validItem(item) {
  try {
    if (!/^[a-f0-9]{12}$/.test(String(item.artifactId)) || !/^[a-f0-9]{32}$/.test(String(item.id))) return false;
    const url = new URL(item.url, location.origin);
    if (url.origin !== location.origin) return false;
    const root = `/api/artifact/${item.artifactId}`;
    return (item.method === "POST" && (url.pathname === `${root}/annotations` || url.pathname === `${root}/annotations/placements` || new RegExp(`^${root}/annotation/[a-f0-9]{32}/replies$`).test(url.pathname))) ||
      ((item.method === "PATCH" || item.method === "DELETE") && new RegExp(`^${root}/annotation/[a-f0-9]{32}$`).test(url.pathname));
  } catch { return false; }
}
function annotationIdFromUrl(item) {
  return /\/annotation\/([a-f0-9]{32})(?:\/replies)?$/.exec(new URL(item.url, location.origin).pathname)?.[1] || null;
}
function reflected(item, annotations) {
  const id = annotationIdFromUrl(item) || item.id;
  const annotation = annotations.find((candidate) => candidate.id === id);
  if (item.kind === "delete") return !annotation;
  if (item.kind === "create") return !!annotation && annotation.body === item.body.body &&
    annotation.origin?.versionId === item.body.versionId &&
    JSON.stringify(annotation.origin?.target) === JSON.stringify(item.body.target);
  if (item.kind === "edit" || item.kind === "status") return !!annotation &&
    (item.body.body === undefined || annotation.body === item.body.body) &&
    (item.body.status === undefined || annotation.status === item.body.status);
  if (item.kind === "reply") return !!annotation && annotation.replies?.some((reply) => reply.id === item.id && reply.body === item.body.body && reply.author === "user");
  if (item.kind === "placement") return Array.isArray(item.body.placements) && item.body.placements.every((entry) => {
    const candidate = annotations.find((annotation) => annotation.id === entry.annotationId);
    const placement = candidate?.placements?.find((value) => value.versionId === item.body.versionId);
    return placement && JSON.stringify(placement) === JSON.stringify(entry.placement);
  });
  return false;
}
function mutationAnnotationId(item) {
  return annotationIdFromUrl(item) || (item.kind === "create" ? item.id : null);
}
async function advanceLaterOperations(items, completed, etag, data) {
  if (!etag) return;
  const completedId = mutationAnnotationId(completed);
  const committed = completedId && Array.isArray(data?.annotations) ? data.annotations.find((annotation) => annotation.id === completedId) : null;
  const later = items.filter((item) =>
    item.artifactId === completed.artifactId &&
    item.sequence > completed.sequence &&
    item.state !== "conflict",
  );
  if (!later.length) return;
  await transact("readwrite", (store) => {
    for (const item of later) {
      item.etag = etag;
      if (committed && mutationAnnotationId(item) === completedId && (item.kind === "edit" || item.kind === "status" || item.kind === "delete" || item.kind === "reply")) {
        item.body = { ...item.body, expectedUpdatedAt: committed.updatedAt };
        item.baseUpdatedAt = committed.updatedAt;
      }
      store.put(item);
    }
  });
}
async function cacheServerSidecar(artifactId, data) {
  if (!data || !Number.isSafeInteger(data.revision) || !Array.isArray(data.annotations)) return;
  const cached = await transact("readonly", (store) => requestResult(store.getAll()), SIDECARS);
  const records = cached.filter((record) => record.artifactId === String(artifactId));
  if (!records.length) return;
  await transact("readwrite", (store) => {
    for (const record of records) {
      const annotations = data.annotations.map((annotation) => ({
        ...annotation,
        placementStatus: annotation.placements?.find((placement) => placement.versionId === record.versionId)?.state || "unplaced",
      }));
      record.sidecar = { ...record.sidecar, schemaVersion: data.schemaVersion || 1, revision: data.revision, annotations, comments: annotations };
      record.cachedAt = Date.now();
      store.put(record);
    }
  }, SIDECARS);
}
async function cacheMutationResponse(item, response) {
  let data;
  try { data = await response.clone().json(); } catch { return null; }
  await cacheServerSidecar(item.artifactId, data);
  return data;
}
async function reflectedAfterRefresh(item) {
  const response = await fetch(`/api/artifact/${encodeURIComponent(item.artifactId)}/annotations`, { cache: "no-store" });
  if (!response.ok) return null;
  const data = await response.json();
  const result = Array.isArray(data.annotations) && reflected(item, data.annotations);
  if (result) await cacheServerSidecar(item.artifactId, data);
  return result ? { data, etag: response.headers.get("etag") } : null;
}
async function responseCode(response) {
  try { return (await response.clone().json())?.code || null; } catch { return null; }
}

function projectAnnotations(sidecar, items) {
  const state = typeof structuredClone === "function" ? structuredClone(sidecar) : JSON.parse(JSON.stringify(sidecar));
  state.annotations = Array.isArray(state.annotations) ? state.annotations : [];
  for (const item of [...items].sort((a, b) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0))) {
    const annotationId = annotationIdFromUrl(item);
    if (item.kind === "create") {
      if (!state.annotations.some((annotation) => annotation.id === item.id)) {
        const now = item.createdAt || Date.now();
        state.annotations.push({
          id: item.id,
          body: item.body.body,
          author: "user",
          status: "open",
          origin: { versionId: item.body.versionId, blob: "0".repeat(64), representationVersion: 1, target: item.body.target },
          placements: [{ versionId: item.body.versionId, state: "anchored", target: item.body.target }],
          replies: [],
          createdAt: now,
          updatedAt: now,
          pending: true,
          syncConflict: item.state === "conflict",
        });
      }
      continue;
    }
    if (item.kind === "reply" && annotationId) {
      state.annotations = state.annotations.map((annotation) => {
        if (annotation.id !== annotationId || annotation.replies?.some((reply) => reply.id === item.id)) return annotation;
        const now = item.createdAt || Date.now();
        return {
          ...annotation,
          replies: [...(annotation.replies || []), { id: item.id, body: item.body.body, author: "user", createdAt: now, pending: true, syncConflict: item.state === "conflict" }],
          updatedAt: Math.max(Number(annotation.updatedAt) || 0, now),
        };
      });
      continue;
    }
    if ((item.kind === "edit" || item.kind === "status") && annotationId) {
      state.annotations = state.annotations.map((annotation) => {
        if (annotation.id !== annotationId) return annotation;
        // The daemon forbids rewriting an agent-authored comment body, so a poisoned queue entry
        // must not forge Agent text across an offline reload. Status changes still apply to all.
        const applyBody = item.body.body !== undefined && annotation.author !== "agent";
        return {
          ...annotation,
          ...(applyBody ? { body: item.body.body } : {}),
          ...(item.body.status === undefined ? {} : { status: item.body.status }),
          pending: true,
          syncConflict: item.state === "conflict",
        };
      });
      continue;
    }
    if (item.kind === "delete" && annotationId) {
      // Agent-authored comments cannot be deleted; never project a forged deletion for one.
      state.annotations = state.annotations.map((annotation) => annotation.id === annotationId && annotation.author !== "agent"
        ? { ...annotation, pending: true, deleting: true, syncConflict: item.state === "conflict" }
        : annotation);
      continue;
    }
    if (item.kind === "placement" && Array.isArray(item.body.placements)) {
      const byId = new Map(item.body.placements.map((entry) => [entry.annotationId, entry.placement]));
      state.annotations = state.annotations.map((annotation) => {
        const placement = byId.get(annotation.id);
        if (!placement) return annotation;
        const placements = annotation.placements?.some((existing) => existing.versionId === placement.versionId)
          ? annotation.placements
          : [...(annotation.placements || []), placement];
        return { ...annotation, placements, pending: true, syncConflict: item.state === "conflict" };
      });
    }
  }
  return state;
}

export const annotationQueue = {
  onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  async count(artifactId) {
    const all = await transact("readonly", (store) => requestResult(store.getAll()));
    return artifactId ? all.filter((item) => item.artifactId === artifactId).length : all.length;
  },
  async items(artifactId) {
    const all = await transact("readonly", (store) => requestResult(store.getAll()));
    return all.filter((item) => !artifactId || item.artifactId === String(artifactId))
      .sort((a, b) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0));
  },
  async project(artifactId, sidecar) {
    return projectAnnotations(sidecar, await this.items(artifactId));
  },
  async cacheSidecar(artifactId, versionId, sidecar) {
    const record = { key: `${artifactId}:${versionId}`, artifactId: String(artifactId), versionId, sidecar, cachedAt: Date.now() };
    await transact("readwrite", (store) => store.put(record), SIDECARS);
    return record;
  },
  async cachedSidecar(artifactId, versionId) {
    return await transact("readonly", (store) => requestResult(store.get(`${artifactId}:${versionId}`)), SIDECARS);
  },
  async enqueue({ artifactId, url, method, body, etag, operationId: suppliedId, kind = "mutation", baseUpdatedAt = null }) {
    // IndexedDB's auto-increment key is an atomic cross-tab order, independent of clocks and
    // random operation ids. Gaps are harmless if a later mutation transaction fails.
    const id = suppliedId || operationId();
    const item = await insertQueuedItem((sequence) => ({ id, artifactId: String(artifactId), url, method, body, etag: etag || null, kind, baseUpdatedAt, state: "pending", sequence, createdAt: Date.now() }));
    notify({ type: "queued", item });
    return item;
  },
  async purge(artifactId) {
    const all = await transact("readonly", (store) => requestResult(store.getAll()));
    await transact("readwrite", (store) => { for (const item of all) if (item.artifactId === String(artifactId)) store.delete(item.id); });
    const cached = await transact("readonly", (store) => requestResult(store.getAll()), SIDECARS);
    await transact("readwrite", (store) => { for (const item of cached) if (item.artifactId === String(artifactId)) store.delete(item.key); }, SIDECARS);
    notify({ type: "purged", artifactId: String(artifactId) });
  },
  async clear() {
    await transact("readwrite", (store) => store.clear());
    await transact("readwrite", (store) => store.clear(), SIDECARS);
    await transact("readwrite", (store) => store.clear(), SEQUENCES);
    notify({ type: "cleared" });
  },
  async conflicts(artifactId) {
    const all = await transact("readonly", (store) => requestResult(store.getAll()));
    return all.filter((item) => item.state === "conflict" && (!artifactId || item.artifactId === String(artifactId)));
  },
  async discard(id) {
    await transact("readwrite", (store) => store.delete(id));
    notify({ type: "discarded", id });
    // A conflict deliberately blocks later causal operations. Once the user explicitly
    // discards it, resume the remaining queue immediately instead of waiting for another
    // online/focus/visibility lifecycle event.
    scheduleReplay();
  },
  async retry(id) {
    const item = await transact("readonly", (store) => requestResult(store.get(id)));
    if (!item) return false;
    const response = await fetch(`/api/artifact/${encodeURIComponent(item.artifactId)}/annotations`, { cache: "no-store" });
    if (!response.ok) return false;
    const state = await response.json();
    const annotationId = annotationIdFromUrl(item);
    const current = annotationId ? state.annotations?.find((annotation) => annotation.id === annotationId) : null;
    const body = { ...item.body };
    if (current && (item.kind === "edit" || item.kind === "status" || item.kind === "delete" || item.kind === "reply")) body.expectedUpdatedAt = current.updatedAt;
    const next = { ...item, body, etag: response.headers.get("etag"), state: "pending", retriedAt: Date.now() };
    await transact("readwrite", (store) => store.put(next));
    notify({ type: "retried", item: next }); scheduleReplay();
    return true;
  },
  async replay() {
    const all = await transact("readonly", (store) => requestResult(store.getAll()));
    const results = [];
    const blockedArtifacts = new Set();
    for (const item of all.sort((a, b) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0)).slice(0, REPLAY_BATCH_SIZE)) {
      // Preserve causal order only within one artifact; a stale note must not block a
      // completely unrelated artifact's durable queue.
      if (item.state === "conflict") { blockedArtifacts.add(item.artifactId); continue; }
      if (blockedArtifacts.has(item.artifactId)) continue;
      if (!validItem(item)) {
        const conflict = { ...item, state: "conflict", status: 400, conflictedAt: Date.now() };
        await transact("readwrite", (store) => store.put(conflict));
        results.push({ item, state: "conflict", status: 400 }); notify({ type: "conflict", item, status: 400 });
        blockedArtifacts.add(item.artifactId); continue;
      }
      let response;
      try {
        response = await fetch(item.url, { method: item.method, headers: { "content-type": "application/json", ...(item.etag ? { "if-match": item.etag } : {}), "x-pi-artifacts-operation-id": item.id }, body: JSON.stringify(item.body) });
      } catch { break; } // Stay durable; the next online event retries in order.
      const errorCode = response.ok ? null : await responseCode(response);
      let reflectedState;
      if (response.ok) {
        const data = await cacheMutationResponse(item, response);
        await transact("readwrite", (store) => store.delete(item.id));
        // Offline changes from one base ETag are causally ordered. Persist the newly
        // committed ETag onto later local changes so they do not conflict with each other.
        await advanceLaterOperations(all, item, response.headers.get("etag"), data);
        results.push({ item, state: "replayed" }); notify({ type: "replayed", item });
      } else if (response.status === 412 && (reflectedState = await reflectedAfterRefresh(item))) {
        await transact("readwrite", (store) => store.delete(item.id));
        await advanceLaterOperations(all, item, reflectedState.etag, reflectedState.data);
        results.push({ item, state: "replayed" }); notify({ type: "replayed", item });
      } else if (response.status === 412 && !item.rebasedAt) {
        // Refresh one time with the latest server ETag. This preserves a durable operation
        // receipt while allowing a harmless stale collection revision to rebase.
        const current = await fetch(`/api/artifact/${encodeURIComponent(item.artifactId)}/annotations`, { cache: "no-store" });
        const etag = current.headers.get("etag");
        if (current.ok && etag) {
          const rebased = { ...item, etag, rebasedAt: Date.now() };
          await transact("readwrite", (store) => store.put(rebased));
          try { response = await fetch(rebased.url, { method: rebased.method, headers: { "content-type": "application/json", "if-match": etag, "x-pi-artifacts-operation-id": rebased.id }, body: JSON.stringify(rebased.body) }); } catch { break; }
          if (response.ok) {
            const data = await cacheMutationResponse(rebased, response);
            await transact("readwrite", (store) => store.delete(rebased.id));
            await advanceLaterOperations(all, rebased, response.headers.get("etag"), data);
            results.push({ item: rebased, state: "replayed" }); notify({ type: "replayed", item: rebased }); continue;
          }
          const code = await responseCode(response);
          if (response.status >= 500 || code === "ANNOTATION_BUSY") break;
          const conflict = { ...rebased, state: "conflict", status: response.status, code, conflictedAt: Date.now() };
          await transact("readwrite", (store) => store.put(conflict));
          results.push({ item: conflict, state: "conflict", status: response.status }); notify({ type: "conflict", item: conflict, status: response.status });
          blockedArtifacts.add(item.artifactId); continue;
        }
      } else if ([400, 403, 404, 412, 413, 415, 422, 428].includes(response.status) ||
          (response.status === 409 && errorCode !== "ANNOTATION_BUSY")) {
        // A stale CAS item cannot become valid through retrying. Keep it durably visible for
        // explicit discard/review and stop here to preserve causal operation ordering.
        const conflict = { ...item, state: "conflict", status: response.status, code: errorCode, conflictedAt: Date.now() };
        await transact("readwrite", (store) => store.put(conflict));
        results.push({ item, state: "conflict", status: response.status }); notify({ type: "conflict", item, status: response.status });
        blockedArtifacts.add(item.artifactId); continue;
      } else break; // transient 409/5xx preserves order and idempotency key for a later replay.
    }
    return results;
  },
};

let replaying = false;
function scheduleReplay() {
  if (replaying || !navigator.onLine) return;
  replaying = true;
  (async () => {
    // The queue is capped at 500 and replay batches at 50, so ten productive passes drain it
    // without an unbounded reconnect loop. Stop as soon as a pass makes no progress.
    for (let pass = 0; pass < 10; pass++) {
      const before = await annotationQueue.count();
      if (!before) break;
      await annotationQueue.replay();
      const after = await annotationQueue.count();
      if (after >= before) break;
    }
  })().catch(() => {}).finally(() => { replaying = false; });
}
window.addEventListener("online", scheduleReplay);
window.addEventListener("focus", scheduleReplay);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") scheduleReplay(); });
scheduleReplay(); // page-open replay; guarded so repeated lifecycle events never spin.
