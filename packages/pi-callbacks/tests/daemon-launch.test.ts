import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { cliSelfPath, daemonCliPath, daemonDownMessage, ensureDaemon } from "../src/daemon-control.ts";
import type { ServerInfo } from "../src/types.ts";

function tempDir(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-callbacks-launch-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function useCallbacksDir(t: test.TestContext, dir: string): void {
  const previous = process.env.PI_CALLBACKS_DIR;
  process.env.PI_CALLBACKS_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CALLBACKS_DIR;
    else process.env.PI_CALLBACKS_DIR = previous;
  });
}

// A port with nothing listening, used only for the first health probe so it
// fails fast instead of reaching the shared default port. The stand-in daemon
// binds its own port, so nothing races for this one after it is released.
async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

// A stand-in daemon: binds an ephemeral port, records it in server.json as the
// real daemon does, answers one /health request as an authentic daemon, then exits.
function fakeDaemonSource(serverJson: string, marker: string): string {
  return `import fs from "node:fs";
import http from "node:http";
const label: string = "spawned";
fs.writeFileSync(${JSON.stringify(marker)}, label);
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, daemon: "pi-callbacks", pid: process.pid }));
  server.close();
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  fs.writeFileSync(${JSON.stringify(serverJson)}, JSON.stringify({ version: 1, pid: process.pid, host: "127.0.0.1", port, startedAt: Date.now() }));
});
setTimeout(() => process.exit(0), 5000).unref();
`;
}

function writeInstalledPackage(root: string, serverJson: string, marker: string, options: { compiled: boolean }): string {
  const packageRoot = path.join(root, "node_modules", "@centerforagenticai", "pi-callbacks");
  fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
  // The TypeScript entry is what an npm install ships under bin/.
  fs.writeFileSync(path.join(packageRoot, "bin", "pi-callbacks.ts"), fakeDaemonSource(serverJson, marker));
  if (options.compiled) {
    fs.mkdirSync(path.join(packageRoot, "dist", "bin"), { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "dist", "bin", "pi-callbacks.js"),
      fakeDaemonSource(serverJson, marker).replace("const label: string", "const label"),
    );
  }
  return packageRoot;
}

function pointServerInfoAt(callbacksDir: string, port: number): string {
  const serverJson = path.join(callbacksDir, "server.json");
  fs.writeFileSync(serverJson, JSON.stringify({
    version: 1, pid: 0, host: "127.0.0.1", port, startedAt: 0,
  } satisfies ServerInfo));
  return serverJson;
}

test("an npm-installed package launches its daemon from the compiled CLI, not the TypeScript source", async (t) => {
  const root = tempDir(t);
  const callbacksDir = path.join(root, "callbacks");
  fs.mkdirSync(callbacksDir);
  useCallbacksDir(t, callbacksDir);
  const serverJson = pointServerInfoAt(callbacksDir, await closedPort());
  const marker = path.join(root, "daemon-spawned");
  const packageRoot = writeInstalledPackage(root, serverJson, marker, { compiled: true });

  const cli = daemonCliPath(packageRoot);
  assert.equal(cli, path.join(packageRoot, "dist", "bin", "pi-callbacks.js"));
  assert.equal(await ensureDaemon(cli), "running");
  assert.equal(fs.existsSync(marker), true);
});

test("node cannot run the TypeScript CLI from node_modules, so that path never becomes reachable", async (t) => {
  const root = tempDir(t);
  const callbacksDir = path.join(root, "callbacks");
  fs.mkdirSync(callbacksDir);
  useCallbacksDir(t, callbacksDir);
  const serverJson = pointServerInfoAt(callbacksDir, await closedPort());
  const marker = path.join(root, "daemon-spawned");
  const packageRoot = writeInstalledPackage(root, serverJson, marker, { compiled: true });

  assert.equal(await ensureDaemon(path.join(packageRoot, "bin", "pi-callbacks.ts")), "down");
  assert.equal(fs.existsSync(marker), false);
});

test("a source checkout keeps the TypeScript CLI even when a dist build exists", () => {
  const root = path.join(path.sep, "work", "pi-callbacks");
  assert.equal(daemonCliPath(root, () => true), path.join(root, "bin", "pi-callbacks.ts"));
});

test("an installed package without a compiled CLI falls back to the TypeScript entry", () => {
  const root = path.join(path.sep, "x", "node_modules", "pi-callbacks");
  assert.equal(daemonCliPath(root, () => false), path.join(root, "bin", "pi-callbacks.ts"));
});

test("the down warning names the missing compiled CLI for an installed package without dist", () => {
  const root = path.join(path.sep, "x", "node_modules", "pi-callbacks");
  const message = daemonDownMessage(root, () => false);
  assert.match(message, /missing the compiled CLI/);
  assert.ok(message.includes(path.join(root, "dist", "bin", "pi-callbacks.js")));
});

test("the down warning stays generic when the compiled CLI exists or in a source checkout", () => {
  const generic = "pi-callbacks daemon did not become reachable; callbacks may not fire";
  assert.equal(daemonDownMessage(path.join(path.sep, "x", "node_modules", "pi-callbacks"), () => true), generic);
  assert.equal(daemonDownMessage(path.join(path.sep, "work", "pi-callbacks"), () => false), generic);
});

test("the CLI resolves its own path with percent escapes decoded", () => {
  const dir = path.join(os.tmpdir(), "pi callbacks dir");
  const file = path.join(dir, "bin", "pi-callbacks.js");
  const url = pathToFileURL(file).href;
  assert.ok(url.includes("%20"));
  assert.equal(cliSelfPath(url), file);
});

test("the CLI never derives its own path from URL.pathname", () => {
  const source = fs.readFileSync(new URL("../bin/pi-callbacks.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /import\.meta\.url\)\.pathname/);
});
