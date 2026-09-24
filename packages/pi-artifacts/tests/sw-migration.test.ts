import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import vm from "node:vm";

const swSource = fs.readFileSync(path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..", "web", "sw.js"), "utf8");

// Minimal Response-like double: enough for the worker's cache put/match/clone flow.
function fakeResponse(body: string, ok = true) {
  return { body, ok, clone() { return fakeResponse(body, ok); } };
}
class FakeCache {
  store = new Map<string, ReturnType<typeof fakeResponse>>();
  async match(req: string | { url: string }) { return this.store.get(typeof req === "string" ? req : req.url); }
  async put(req: string | { url: string }, resp: ReturnType<typeof fakeResponse>) { this.store.set(typeof req === "string" ? req : req.url, resp); }
  async keys() { return [...this.store.keys()]; }
}
class FakeCacheStorage {
  caches = new Map<string, FakeCache>();
  async open(name: string) { let c = this.caches.get(name); if (!c) { c = new FakeCache(); this.caches.set(name, c); } return c; }
  async keys() { return [...this.caches.keys()]; }
  async delete(name: string) { return this.caches.delete(name); }
}

/** Evaluate sw.js in a sandbox, capturing its lifecycle listeners so tests can drive them. */
function loadWorker(caches: FakeCacheStorage, fetchImpl: (u: string) => Promise<ReturnType<typeof fakeResponse>>) {
  const listeners = new Map<string, (event: { waitUntil: (p: Promise<unknown>) => void }) => void>();
  const self = {
    addEventListener: (type: string, handler: (event: { waitUntil: (p: Promise<unknown>) => void }) => void) => listeners.set(type, handler),
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined },
    location: { origin: "https://example.test" },
  };
  const sandbox = { self, caches, fetch: fetchImpl, URL, console, Response: fakeResponse };
  vm.runInNewContext(swSource, sandbox, { filename: "sw.js" });
  return async (type: string) => {
    const handler = listeners.get(type);
    assert.ok(handler, `worker registered a ${type} listener`);
    let waited: Promise<unknown> = Promise.resolve();
    handler!({ waitUntil: (p) => { waited = p; } });
    await waited;
  };
}

test("service worker upgrade migrates durable caches and seeds the current viewer shell", async () => {
  const caches = new FakeCacheStorage();
  // Seed a prior version's caches: pinned raw bytes, a cached sidecar, and an old viewer shell.
  const oldContent = await caches.open("pa-content-v5");
  await oldContent.put("/raw/abcdef012345", fakeResponse("PINNED-BYTES"));
  const oldApi = await caches.open("pa-api-v5");
  await oldApi.put("/api/artifact/abcdef012345/annotations", fakeResponse("SIDECAR-V5"));
  const oldShell = await caches.open("pa-shell-v5");
  await oldShell.put("/__view_shell__", fakeResponse("OLD-VIEW-SHELL"));
  // An even older version holds a STALE copy of the same sidecar URL; the newer v5 copy must win.
  const olderApi = await caches.open("pa-api-v4");
  await olderApi.put("/api/artifact/abcdef012345/annotations", fakeResponse("SIDECAR-V4-STALE"));

  const fetched: string[] = [];
  const dispatch = loadWorker(caches, async (u: string) => { fetched.push(u); return fakeResponse(`FRESH:${u}`); });

  await dispatch("install");
  await dispatch("activate");

  const currentKeys = await caches.keys();
  assert.ok(currentKeys.every((name) => name.endsWith("-v6")), `only v6 caches remain: ${currentKeys.join(", ")}`);

  // Pinned raw bytes survive; the sidecar migrates from the NEWEST prior version (v5), not v4.
  assert.equal((await (await caches.open("pa-content-v6")).match("/raw/abcdef012345"))?.body, "PINNED-BYTES");
  assert.equal((await (await caches.open("pa-api-v6")).match("/api/artifact/abcdef012345/annotations"))?.body, "SIDECAR-V5", "newest prior cache wins");

  // The viewer shell is the freshly-installed one, not the migrated stale copy.
  assert.ok(fetched.includes("/__view_shell__"), "install fetched the current viewer shell");
  assert.equal((await (await caches.open("pa-shell-v6")).match("/__view_shell__"))?.body, "FRESH:/__view_shell__");

  // Old-version caches are gone.
  assert.equal(await caches.open("pa-content-v5").then((c) => c.store.size === 0 || !caches.caches.has("pa-content-v5")), true);
});
