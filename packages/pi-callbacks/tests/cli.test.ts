import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { ensureDaemon } from "../src/daemon-control.ts";
import type { DaemonHealth, ExternalCallbackPayload, ServerInfo } from "../src/types.ts";

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function useTempCallbacksDir(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-callbacks-cli-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "bin/pi-callbacks.ts", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function withCallbackServer<T>(callback: (endpoint: string, received: ExternalCallbackPayload[]) => Promise<T>, daemon = "pi-callbacks"): Promise<T> {
  const received: ExternalCallbackPayload[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, daemon, pid: process.pid }));
      return;
    }
    if (req.method === "POST" && req.url === "/callback") {
      let body = "";
      req.on("data", (chunk) => { body += String(chunk); });
      req.on("end", () => {
        const payload = JSON.parse(body) as ExternalCallbackPayload;
        received.push(payload);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, id: "cb_test", status: payload.status ?? "success" }));
      });
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return await callback(`http://127.0.0.1:${address.port}/callback`, received);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("CLI prints usage and resolves the configured daemon endpoint without touching real state", async (t) => {
  const callbacksDir = useTempCallbacksDir(t);
  await withCallbackServer(async (endpoint) => {
    const url = new URL(endpoint);
    const info: ServerInfo = { version: 1, pid: process.pid, host: url.hostname, port: Number(url.port), startedAt: Date.now() };
    fs.writeFileSync(path.join(callbacksDir, "server.json"), JSON.stringify(info));

    const help = await runCli(["--help"], { PI_CALLBACKS_DIR: callbacksDir });
    assert.equal(help.code, 0);
    assert.match(help.stdout, /pi-callbacks/);

    const endpointResult = await runCli(["endpoint"], { PI_CALLBACKS_DIR: callbacksDir });
    assert.equal(endpointResult.code, 0, endpointResult.stderr);
    assert.equal(endpointResult.stdout.trim(), endpoint);

    const status = await runCli(["status"], { PI_CALLBACKS_DIR: callbacksDir });
    assert.equal(status.code, 0, status.stderr);
    const parsed = JSON.parse(status.stdout) as { healthy: boolean; endpoint: string };
    assert.equal(parsed.healthy, true);
    assert.equal(parsed.endpoint, endpoint);
  });
});

test("CLI status rejects an unrelated healthy listener", async (t) => {
  const callbacksDir = useTempCallbacksDir(t);
  await withCallbackServer(async (endpoint) => {
    const url = new URL(endpoint);
    const info: ServerInfo = { version: 1, pid: process.pid, host: url.hostname, port: Number(url.port), startedAt: Date.now() };
    fs.writeFileSync(path.join(callbacksDir, "server.json"), JSON.stringify(info));

    const status = await runCli(["status"], { PI_CALLBACKS_DIR: callbacksDir });
    assert.equal(status.code, 0, status.stderr);
    assert.equal((JSON.parse(status.stdout) as { healthy: boolean }).healthy, false);
  }, "unrelated-listener");
});

test("degraded authentic daemon is reachable without spawning a replacement and is reported distinctly", async (t) => {
  const callbacksDir = useTempCallbacksDir(t);
  const previousCallbacksDir = process.env.PI_CALLBACKS_DIR;
  process.env.PI_CALLBACKS_DIR = callbacksDir;
  t.after(() => {
    if (previousCallbacksDir === undefined) delete process.env.PI_CALLBACKS_DIR;
    else process.env.PI_CALLBACKS_DIR = previousCallbacksDir;
  });
  const marker = path.join(callbacksDir, "replacement-spawned");
  const replacement = path.join(callbacksDir, "replacement.mjs");
  fs.writeFileSync(replacement, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "spawned");`);
  const server = http.createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/health") {
      res.writeHead(404).end();
      return;
    }
    const health: DaemonHealth = {
      ok: false,
      daemon: "pi-callbacks",
      pid: process.pid,
      lastSchedulerTickAt: Date.now() - 3_000,
      overdueJobCount: 0,
      oldestOverdueJobAgeMs: null,
      schedulerStaleAfterMs: 3_000,
      lastSchedulerErrorAt: null,
      lastSchedulerError: null,
    };
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify(health));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  fs.writeFileSync(path.join(callbacksDir, "server.json"), JSON.stringify({
    version: 1,
    pid: process.pid,
    host: "127.0.0.1",
    port: address.port,
    startedAt: Date.now(),
  } satisfies ServerInfo));

  const startedAt = Date.now();
  const ensured = await ensureDaemon(replacement);
  assert.equal(ensured, "degraded");
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(fs.existsSync(marker), false);

  const status = await runCli(["status"], { PI_CALLBACKS_DIR: callbacksDir });
  assert.equal(status.code, 0, status.stderr);
  const parsed = JSON.parse(status.stdout) as { healthy: boolean; status: string };
  assert.equal(parsed.healthy, false);
  assert.equal(parsed.status, "degraded");
});

test("CLI callback posts structured payloads to an explicit test endpoint", async (t) => {
  const callbacksDir = useTempCallbacksDir(t);
  await withCallbackServer(async (endpoint, received) => {
    const result = await runCli([
      "callback",
      "--endpoint", endpoint,
      "--token", "pi_cb_cli_token",
      "--message", "tests passed",
      "--status", "info",
      "--details-json", JSON.stringify({ suite: "cli" }),
      "--no-complete",
    ], { PI_CALLBACKS_DIR: callbacksDir });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, id: "cb_test", status: "info" });
    assert.deepEqual(received, [{
      token: "pi_cb_cli_token",
      message: "tests passed",
      status: "info",
      details: { suite: "cli" },
      complete: false,
    }]);
  });
});
