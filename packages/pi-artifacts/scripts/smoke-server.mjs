#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifacts-smoke-"));
process.env.PI_ARTIFACTS_HOME = home;
process.env.PI_ARTIFACTS_PUBLIC_HOST = "smoke.example.test";

const { createServer } = await import("../src/server.ts");

const server = createServer();
const close = () => new Promise((resolve) => server.close(() => resolve()));

try {
  const base = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const addr = server.address();
      assert.equal(typeof addr, "object");
      assert.ok(addr);
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });

  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const body = Buffer.from("# Smoke\n\nserver smoke check\n", "utf8");
  const register = await fetch(`${base}/api/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project: "smoke",
      title: "Smoke Report",
      filename: "smoke.md",
      mode: "stored",
      contentBase64: body.toString("base64"),
    }),
  });
  assert.equal(register.status, 200);
  const registered = await register.json();
  assert.equal(registered.ok, true);
  assert.match(registered.url, /\/view\/[a-f0-9]+$/);

  const list = await fetch(`${base}/api/list?project=smoke`).then((res) => res.json());
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].title, "Smoke Report");

  const raw = await fetch(`${base}/raw/${registered.id}`);
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get("content-type"), "text/markdown");
  assert.equal(await raw.text(), body.toString("utf8"));

  console.log(`smoke ok: ${base}`);
} finally {
  await close();
  fs.rmSync(home, { recursive: true, force: true });
}
