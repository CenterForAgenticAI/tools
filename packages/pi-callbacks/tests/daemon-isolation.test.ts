import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import piCallbacks from "../index.ts";
import { ensureDaemon } from "../src/daemon-control.ts";
import type { ServerInfo } from "../src/types.ts";

const testsDir = path.dirname(fileURLToPath(import.meta.url));

function tempDir(t: test.TestContext, label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-callbacks-isolation-${label}-`));
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

// A port with nothing listening, so the first health probe finds no daemon.
async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function writeServerInfo(dir: string, port: number): void {
  fs.writeFileSync(path.join(dir, "server.json"), JSON.stringify({
    version: 1, pid: 0, host: "127.0.0.1", port, startedAt: 0,
  } satisfies ServerInfo));
}

test("ensureDaemon starts the daemon against the store it was called with, even if the environment changes mid-probe", async (t) => {
  const requested = tempDir(t, "requested");
  const later = tempDir(t, "later");
  useCallbacksDir(t, requested);
  writeServerInfo(requested, await closedPort());
  writeServerInfo(later, await closedPort());
  const marker = path.join(requested, "spawned-with");
  // Stand-in daemon: records its store, binds an ephemeral port, publishes it
  // the way the real daemon does, answers one health check, then exits.
  const fakeDaemon = path.join(requested, "fake-daemon.mjs");
  fs.writeFileSync(fakeDaemon, `import fs from "node:fs";
import http from "node:http";
import path from "node:path";
const dir = process.env.PI_CALLBACKS_DIR ?? "";
fs.writeFileSync(${JSON.stringify(marker)}, dir);
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, daemon: "pi-callbacks", pid: process.pid }));
  server.close();
});
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  fs.writeFileSync(path.join(dir, "server.json"), JSON.stringify({ version: 1, pid: process.pid, host: "127.0.0.1", port, startedAt: Date.now() }));
});
setTimeout(() => process.exit(0), 5000).unref();
`);

  const pending = ensureDaemon(fakeDaemon);
  // What a test's t.after does while the probe is still in flight.
  process.env.PI_CALLBACKS_DIR = later;
  const status = await pending;

  assert.equal(fs.readFileSync(marker, "utf8"), requested);
  assert.equal(status, "running");
});

test("session start launches the daemon through the injected launcher", async () => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const launched: string[] = [];
  const pi = {
    registerMessageRenderer: () => undefined,
    on: (event: string, handler: (event: unknown, ctx: unknown) => void) => { handlers.set(event, handler); },
    registerTool: () => undefined,
    registerCommand: () => undefined,
    sendMessage: () => undefined,
    sendUserMessage: () => undefined,
  };
  const ctx = {
    cwd: process.cwd(),
    hasUI: false,
    sessionManager: { getSessionFile: () => "/tmp/isolation-session.json", getSessionId: () => "isolation-session" },
    ui: { notify: () => undefined, setStatus: () => undefined, setWidget: () => undefined },
    isIdle: () => true,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-callbacks-isolation-session-"));
  const previous = process.env.PI_CALLBACKS_DIR;
  process.env.PI_CALLBACKS_DIR = dir;
  try {
    piCallbacks(pi as never, { ensureDaemon: (binPath) => { launched.push(binPath); return Promise.resolve("running"); } });
    handlers.get("session_start")!({ reason: "startup" }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(launched.length, 1);
    assert.match(launched[0] ?? "", /pi-callbacks\.(ts|js)$/);
  } finally {
    handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
    if (previous === undefined) delete process.env.PI_CALLBACKS_DIR;
    else process.env.PI_CALLBACKS_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("every test that constructs the extension replaces its daemon launcher", () => {
  const offenders: string[] = [];
  for (const name of fs.readdirSync(testsDir).filter((file) => file.endsWith(".test.ts"))) {
    const source = fs.readFileSync(path.join(testsDir, name), "utf8");
    source.split("\n").forEach((line, index) => {
      // A one-argument call would fall back to the real launcher.
      if (/\bpiCallbacks\(\s*[^,()]+(\([^)]*\))?[^,()]*\)/.test(line)) offenders.push(`${name}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, [], "pass NO_DAEMON (tests/no-daemon.ts) or another launcher as the second argument");
});
