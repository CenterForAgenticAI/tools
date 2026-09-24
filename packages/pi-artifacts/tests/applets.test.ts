import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { ServerOptions } from "../src/server.ts";

process.env.PI_ARTIFACTS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifacts-applets-test-"));

const config = await import("../src/config.ts");
const applets = await import("../src/applets.ts");
const serverMod = await import("../src/server.ts");

function writeApplet(id: string, files: Record<string, string>) {
  const dir = path.join(config.APPLETS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
}

function listen(): Promise<{ base: string; close: () => Promise<void> }> {
  const options: ServerOptions = {
    publicUrlProvider: async () => ({ ok: true, publicBaseUrl: "https://daemon.example.com" }),
  };
  const server = serverMod.createServer(options);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      assert.equal(typeof addr, "object");
      const { port } = addr as AddressInfo;
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

test("discovers applets from applet manifests and resolves frontend files safely", () => {
  writeApplet("notes", {
    "applet.json": JSON.stringify({ id: "notes", title: "Notes", description: "tiny notes", entry: "index.html" }),
    "index.html": "<!doctype html><p>notes</p>",
  });

  const listed = applets.listApplets();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, "notes");
  assert.equal(listed[0].url, "/applets/notes/");
  assert.equal(listed[0].apiUrl, "/api/applets/notes/");

  const app = applets.getApplet("notes")!;
  assert.ok(applets.resolveAppletFile(app, "")?.endsWith("index.html"));
  assert.equal(applets.resolveAppletFile(app, "../config.json"), null);
});

test("serves applet list, frontend, and backend with per-applet sqlite", async () => {
  writeApplet("todo", {
    "applet.json": JSON.stringify({ id: "todo", title: "Todo", entry: "index.html", backend: "backend.mjs" }),
    "index.html": "<!doctype html><p>todo app</p>",
    "backend.mjs": `export async function handle(req, res, ctx) {
      ctx.db.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, text TEXT NOT NULL)");
      const url = new URL(req.url, "http://localhost");
      if (url.pathname.endsWith("/items") && req.method === "POST") {
        const body = await ctx.readJsonBody();
        ctx.db.prepare("INSERT INTO items (text) VALUES (?)").run(String(body.text));
        return { ok: true };
      }
      if (url.pathname.endsWith("/items")) {
        return { items: ctx.db.prepare("SELECT text FROM items ORDER BY id").all() };
      }
      return ctx.json(404, { error: "not found" });
    }`,
  });

  const srv = await listen();
  try {
    const list = await fetch(`${srv.base}/api/applets`).then((r) => r.json()) as {
      applets: Array<{ id: string; url: string; apiUrl: string }>;
    };
    const todo = list.applets.find((a) => a.id === "todo");
    assert.ok(todo);
    assert.equal(todo.url, "https://daemon.example.com/applets/todo/");
    assert.equal(todo.apiUrl, "https://daemon.example.com/api/applets/todo/");

    const indexHtml = await fetch(`${srv.base}/applets`).then((r) => r.text());
    assert.match(indexHtml, /Small tools hosted by pi-artifacts/);

    const html = await fetch(`${srv.base}/applets/todo/`).then((r) => r.text());
    assert.match(html, /todo app/);

    const post = await fetch(`${srv.base}/api/applets/todo/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "first" }),
    }).then((r) => r.json());
    assert.deepEqual(post, { ok: true });

    const data = await fetch(`${srv.base}/api/applets/todo/items`).then((r) => r.json());
    assert.deepEqual(data.items, [{ text: "first" }]);

    assert.ok(fs.existsSync(path.join(config.APPLET_DATA_DIR, "todo", "applet.db")));
  } finally {
    await srv.close();
  }
});
