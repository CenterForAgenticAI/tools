import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executePollSource, preflightPollSource, projectPollSource } from "../src/poll-sources.ts";
import { appendDeliveryEvent, upsertJob } from "../src/store.ts";
import { handleAction } from "../index.ts";
import type { PollJob, PollSource } from "../src/types.ts";

function installFakeGlab(t: test.TestContext, dir: string, source: string): void {
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const executable = path.join(binDir, "glab");
  fs.writeFileSync(executable, `#!/usr/bin/env node\n${source}\n`);
  fs.chmodSync(executable, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
}

const source = { kind: "gitlab_pipeline", host: "gitlab.test", project: "group/project", pipelineId: 42 } as const;

test("GitLab source children do not inherit GITLAB_TOKEN", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-callbacks-source-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  installFakeGlab(t, dir, `
if (process.env.GITLAB_TOKEN !== undefined) {
  process.stderr.write("GITLAB_TOKEN was inherited");
  process.exit(1);
}
process.stdout.write(JSON.stringify({ status: "success" }));
`);
  const previousToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "sentinel-source-token";
  t.after(() => {
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
  });

  preflightPollSource(source);
  const result = await executePollSource(source, 1_000);
  assert.equal(result.status, "success");
  assert.doesNotMatch(JSON.stringify(result), /sentinel-source-token/);
});

test("creating a source persists only its non-secret fields", (t) => {
  const callbacksDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-callbacks-source-test-"));
  const previousCallbacksDir = process.env.PI_CALLBACKS_DIR;
  process.env.PI_CALLBACKS_DIR = callbacksDir;
  t.after(() => {
    if (previousCallbacksDir === undefined) delete process.env.PI_CALLBACKS_DIR;
    else process.env.PI_CALLBACKS_DIR = previousCallbacksDir;
    fs.rmSync(callbacksDir, { recursive: true, force: true });
  });

  installFakeGlab(t, callbacksDir, 'process.stdout.write(JSON.stringify({ status: "running" }));');
  const result = handleAction(
    { cwd: process.cwd(), sessionManager: { getSessionFile: () => "/tmp/source-test.json", getSessionId: () => "source-test" } } as never,
    { action: "poll", interval: "1m", source: { ...source, token: "sentinel-source-token" } } as never,
  );
  const created = result.details as PollJob;
  assert.deepEqual(created.source, source);
  assert.equal("token" in (created.source ?? {}), false);

  const persisted = fs.readFileSync(path.join(callbacksDir, "jobs.json"), "utf8");
  assert.deepEqual((JSON.parse(persisted) as { jobs: PollJob[] }).jobs[0]?.source, source);
  assert.doesNotMatch(persisted, /sentinel-source-token/);
});

test("sanitized source diagnostics never reach persisted jobs, results, or events", async (t) => {
  const callbacksDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-callbacks-source-test-"));
  const previousCallbacksDir = process.env.PI_CALLBACKS_DIR;
  process.env.PI_CALLBACKS_DIR = callbacksDir;
  t.after(() => {
    if (previousCallbacksDir === undefined) delete process.env.PI_CALLBACKS_DIR;
    else process.env.PI_CALLBACKS_DIR = previousCallbacksDir;
    fs.rmSync(callbacksDir, { recursive: true, force: true });
  });
  installFakeGlab(t, callbacksDir, 'process.stderr.write("authentication failed PRIVATE-TOKEN: sentinel-source-token"); process.exit(1);');

  const result = await executePollSource(source, 1_000);
  const now = Date.now();
  const job: PollJob = {
    id: "poll_sanitized_source",
    kind: "poll",
    status: "pending",
    createdAt: now,
    updatedAt: now,
    cwd: process.cwd(),
    message: "source diagnostics",
    delivery: "custom",
    triggerTurn: true,
    intervalMs: 1_000,
    nextRunAt: now,
    source: projectPollSource({ ...source, token: "sentinel-source-token" } as PollSource & { token: string }),
    condition: { type: "always" },
    runCount: 1,
    pushEachResult: true,
    lastResult: result,
    events: [{ at: now, kind: "poll", message: "Poll monitoring failed", details: result }],
  };
  upsertJob(job);
  appendDeliveryEvent(job, "poll", "Poll monitoring failed", result);

  const persisted = fs.readFileSync(path.join(callbacksDir, "jobs.json"), "utf8");
  assert.match(result.error ?? "", /authentication failed/);
  assert.doesNotMatch(persisted, /sentinel-source-token/);
});

test("GitLab source diagnostics retain failure category but redact credentials", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-callbacks-source-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  installFakeGlab(t, dir, 'process.stderr.write("authentication failed PRIVATE-TOKEN: sentinel-source-token"); process.exit(1);');

  assert.throws(
    () => preflightPollSource(source),
    (error: unknown) => {
      assert.match(error instanceof Error ? error.message : String(error), /authentication failed/);
      assert.doesNotMatch(error instanceof Error ? error.message : String(error), /sentinel-source-token/);
      return true;
    },
  );
  const result = await executePollSource(source, 1_000);
  assert.match(result.error ?? "", /authentication failed/);
  assert.doesNotMatch(JSON.stringify(result), /sentinel-source-token/);
});

test("GitLab source execution reports a missing glab binary", async (t) => {
  const previousPath = process.env.PATH;
  process.env.PATH = path.join(os.tmpdir(), "pi-callbacks-no-such-glab");
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });

  const result = await executePollSource(source, 1_000);
  assert.match(result.error ?? "", /spawn glab ENOENT/);
  assert.equal(result.matched, false);
});

test("GitLab source execution reports a timeout", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-callbacks-source-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  installFakeGlab(t, dir, "setTimeout(() => process.stdout.write(JSON.stringify({ status: 'success' })), 1_000);");

  const result = await executePollSource(source, 20);
  assert.equal(result.error, "Poll timed out after 20ms");
  assert.equal(result.matched, false);
});

test("GitLab source execution reports malformed output", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-callbacks-source-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  installFakeGlab(t, dir, "process.stdout.write('not json');");

  const result = await executePollSource(source, 1_000);
  assert.match(result.error ?? "", /unparseable GitLab pipeline response/);
  assert.equal(result.matched, false);
});

test("GitLab source preflight surfaces the underlying glab failure", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-callbacks-source-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  installFakeGlab(t, dir, "process.stderr.write('authentication failed'); process.exit(1);");

  assert.throws(
    () => preflightPollSource({ kind: "gitlab_pipeline", host: "gitlab.test", project: "group/project", pipelineId: 42 }),
    /authentication failed/,
  );
});
