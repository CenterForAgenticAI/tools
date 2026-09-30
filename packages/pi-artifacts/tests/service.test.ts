import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installUserService, uninstallUserService, waitForDaemon, type ServiceOptions } from "../src/service.ts";
import { spawn } from "node:child_process";
import http from "node:http";

const cli = fileURLToPath(new URL("../bin/pi-artifacts.ts", import.meta.url));

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifacts-service-test-"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  return { home, bin };
}

// Exercise the shipped CLI, not just a generated service file.
test("Linux install reports a service-manager failure instead of success", { skip: process.platform !== "linux" }, (t) => {
  const { home, bin } = fixture();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(bin, "systemctl"), "#!/bin/sh\necho 'user manager unavailable' >&2\nexit 1\n", { mode: 0o755 });
  const result = spawnSync(process.execPath, ["--experimental-strip-types", cli, "install", "--no-tailscale"], {
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, "config"), PI_ARTIFACTS_HOME: path.join(home, "store"), PATH: bin, PI_ARTIFACTS_PORT: "1" },
    encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /systemctl.*user manager unavailable/s);
  assert.doesNotMatch(result.stdout, /Done|installed launchd/);
  assert.equal(fs.existsSync(path.join(home, "Library")), false);
});

test("Linux install stops before configuring Serve when the daemon never starts", { skip: process.platform !== "linux" }, (t) => {
  const { home, bin } = fixture();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(bin, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const result = spawnSync(process.execPath, ["--experimental-strip-types", cli, "install"], {
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, "config"), PI_ARTIFACTS_HOME: path.join(home, "store"), PATH: bin, PI_ARTIFACTS_PORT: "1" },
    encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /daemon did not become ready.*journalctl --user/);
  assert.doesNotMatch(result.stdout, /Done|configuring.*tailscale|public URL unavailable/);
});

function serviceFixture(t: import("node:test").TestContext, platform: "linux" | "darwin" = "linux") {
  const { home } = fixture();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const commands: string[][] = [];
  const options: ServiceOptions = {
    platform, userHome: home, configHome: path.join(home, "config"), artifactsHome: path.join(home, "store"),
    node: "/usr/bin/node", server: "/opt/pi artifacts/server.ts", uid: 501, env: { PATH: "/usr/bin:/bin" },
    run: (command, args) => { commands.push([command, ...args]); return { status: 0 }; },
  };
  return { home, commands, options };
}

test("Linux service starts, restarts on reinstall, and uninstalls without touching the store", (t) => {
  const { home, commands, options } = serviceFixture(t);
  const service = installUserService(options);
  assert.equal(service.kind, "systemd");
  assert.equal(service.file, path.join(home, "config/systemd/user/pi-artifacts.service"));
  const unit = fs.readFileSync(service.file, "utf8");
  assert.match(unit, /ExecStart="\/usr\/bin\/node" "--experimental-strip-types" "--experimental-sqlite" "\/opt\/pi artifacts\/server.ts"/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /Environment="PATH=\/usr\/bin:\/bin"/);
  assert.deepEqual(commands, [
    ["systemctl", "--user", "show-environment"], ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "pi-artifacts.service"], ["systemctl", "--user", "restart", "pi-artifacts.service"],
  ]);
  assert.equal(fs.existsSync(path.join(home, "Library")), false);
  installUserService(options);
  assert.deepEqual(commands.at(-1), ["systemctl", "--user", "restart", "pi-artifacts.service"]);
  uninstallUserService(options);
  assert.equal(fs.existsSync(service.file), false);
  assert.equal(fs.existsSync(path.join(home, "store")), true);
  assert.deepEqual(commands.slice(-2), [["systemctl", "--user", "disable", "--now", "pi-artifacts.service"], ["systemctl", "--user", "daemon-reload"]]);
  const count = commands.length;
  uninstallUserService(options);
  assert.equal(commands.length, count);
});

test("macOS retains launchd, checks fallback failures, and escapes XML paths", (t) => {
  const { home, commands, options } = serviceFixture(t, "darwin");
  options.server = '/opt/Pi & "artifacts"/server.ts';
  const service = installUserService(options);
  assert.equal(service.kind, "launchd");
  assert.equal(service.file, path.join(home, "Library/LaunchAgents/com.pi.artifacts.plist"));
  assert.match(fs.readFileSync(service.file, "utf8"), /Pi &amp; &quot;artifacts&quot;/);
  assert.deepEqual(commands, [["launchctl", "bootout", "gui/501/com.pi.artifacts"], ["launchctl", "bootstrap", "gui/501", service.file]]);
  uninstallUserService(options);
  assert.deepEqual(commands.at(-1), ["launchctl", "bootout", "gui/501", service.file]);
  options.run = (command, args) => { commands.push([command, ...args]); return { status: args[0] === "bootstrap" ? 1 : 0 }; };
  installUserService(options);
  assert.equal(commands.at(-1)?.[1], "load");
  options.run = () => ({ status: null, error: new Error("ENOENT") });
  assert.throws(() => installUserService(options), /launchctl load.*ENOENT/);
  assert.throws(() => uninstallUserService(options), /launchctl unload.*ENOENT/);
  assert.equal(fs.existsSync(service.file), true);
});

test("Linux manager failures stop each install step and keep files on failed uninstall", (t) => {
  const { commands, options } = serviceFixture(t);
  for (const step of ["show-environment", "daemon-reload", "enable", "restart"]) {
    commands.length = 0;
    options.run = (command, args) => { commands.push([command, ...args]); return { status: args[1] === step ? 1 : 0, stderr: "permission denied" }; };
    assert.throws(() => installUserService(options), /systemctl.*permission denied/);
    assert.equal(commands.at(-1)?.[2], step);
  }
  options.run = () => ({ status: 0 });
  const service = installUserService(options);
  options.run = () => ({ status: null, error: new Error("ENOENT") });
  assert.throws(() => uninstallUserService(options), /systemctl.*ENOENT/);
  assert.equal(fs.existsSync(service.file), true);
});

test("unsupported platforms and relative config homes fail before mutation", (t) => {
  const { home, options, commands } = serviceFixture(t);
  assert.throws(() => installUserService({ ...options, platform: "win32" }), /unsupported.*win32/);
  assert.throws(() => uninstallUserService({ ...options, platform: "win32" }), /unsupported.*win32/);
  assert.throws(() => installUserService({ ...options, configHome: "relative" }), /absolute path/);
  assert.equal(fs.existsSync(path.join(home, "store")), false);
  assert.deepEqual(commands, []);
});

test("unsupported systemd executable paths fail before writing or starting a service", (t) => {
  const { home, commands, options } = serviceFixture(t);
  for (const node of ["relative/node", "/opt/$HOME/node", "/opt/node\nother", "/opt/node\u0000other"]) {
    assert.throws(() => installUserService({ ...options, node }), /Node executable path.*systemd/);
  }
  assert.equal(fs.existsSync(path.join(home, "config")), false);
  assert.deepEqual(commands, []);
});

test("paths and environment values cannot inject directives or expand into extra arguments", (t) => {
  const { options } = serviceFixture(t);
  options.server = '/opt/100%/$HOME/Pi "x"\\name\nRestart=always';
  options.env = { PATH: '/opt/100%/"bin"\nExecStart=/bad', PI_ARTIFACTS_PORT: "9797", PI_ARTIFACTS_PUBLIC_URL: "https://artifacts.example.com/path", UNRELATED_SECRET: "must-not-survive" };
  const service = installUserService(options);
  const unit = fs.readFileSync(service.file, "utf8");
  assert.ok(unit.includes('100%%/$$HOME/Pi \\"x\\"\\\\name\\nRestart=always'));
  assert.ok(unit.includes('Environment="PATH=/opt/100%%/\\"bin\\"\\nExecStart=/bad"'));
  assert.doesNotMatch(unit, /UNRELATED_SECRET|must-not-survive|^Restart=always|^ExecStart=\/bad/m);
  assert.match(unit, /Environment="PI_ARTIFACTS_PORT=9797"/);
});

test("daemon readiness retries a delayed start and has a finite failure budget", async () => {
  let attempts = 0;
  const pauses: number[] = [];
  assert.equal(await waitForDaemon(async () => ++attempts === 3, async (ms) => { pauses.push(ms); }), true);
  assert.equal(attempts, 3);
  assert.deepEqual(pauses, [250, 250]);
  attempts = 0; pauses.length = 0;
  assert.equal(await waitForDaemon(async () => { attempts++; return false; }, async (ms) => { pauses.push(ms); }), false);
  assert.equal(attempts, 20);
  assert.equal(pauses.length, 19);
});

async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--experimental-strip-types", cli, ...args], { env });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const status = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    return { status, stdout, stderr };
  } finally { clearTimeout(timer); }
}

test("Linux CLI install and uninstall use systemd and report the daemon URL", { skip: process.platform !== "linux" }, async (t) => {
  const { home, bin } = fixture();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const calls = path.join(home, "commands.log");
  fs.writeFileSync(path.join(bin, "systemctl"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 0\n`, { mode: 0o755 });
  let healthRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.url !== "/health") { res.writeHead(404); res.end(); return; }
    healthRequests++;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, publicBaseUrl: "https://artifacts.example.com" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, "config"), PI_ARTIFACTS_HOME: path.join(home, "store"), PATH: bin, PI_ARTIFACTS_PORT: String(address.port) };
  const result = await runCli(["install", "--no-tailscale"], env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /installed systemd user service/);
  assert.match(result.stdout, /daemon: UP/);
  assert.match(result.stdout, /Done\. Explorer: https:\/\/artifacts.example.com/);
  assert.ok(healthRequests >= 2, "install must check readiness and retrieve the public URL through /health");
  assert.equal(fs.existsSync(path.join(home, "Library")), false);
  const uninstall = await runCli(["uninstall"], env);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.match(uninstall.stdout, /removed systemd user service/);
  assert.equal(fs.existsSync(path.join(home, "config/systemd/user/pi-artifacts.service")), false);
  assert.equal(fs.existsSync(path.join(home, "store")), true);
  assert.equal(fs.readFileSync(calls, "utf8"), "--user show-environment\n--user daemon-reload\n--user enable pi-artifacts.service\n--user restart pi-artifacts.service\n--user disable --now pi-artifacts.service\n--user daemon-reload\n");
});

test("a failed Serve command cannot be reported as Done even when a URL already exists", { skip: process.platform !== "linux" }, async (t) => {
  const { home, bin } = fixture();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(bin, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "tailscale"), '#!/bin/sh\nif [ "$1" = version ]; then exit 0; fi\nexit 1\n', { mode: 0o755 });
  const server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, publicBaseUrl: "https://artifacts.example.com" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const result = await runCli(["install"], { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, "config"), PI_ARTIFACTS_HOME: path.join(home, "store"), PATH: bin, PI_ARTIFACTS_PORT: String(address.port) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tailscale serve failed/);
  assert.doesNotMatch(result.stdout, /Done/);
});

test("remote client config cannot install a local service", { skip: process.platform !== "linux" }, (t) => {
  const { home, bin } = fixture();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ["--experimental-strip-types", cli, "install", "--no-tailscale"], {
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, "config"), PI_ARTIFACTS_HOME: path.join(home, "store"), PATH: bin, PI_ARTIFACTS_HOST: "remote.example.com" },
    encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /remote clients do not need a service/);
  assert.equal(fs.existsSync(path.join(home, "config")), false);
});
