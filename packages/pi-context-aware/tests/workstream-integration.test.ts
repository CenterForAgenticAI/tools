import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLauncherHandoff } from "../launcher-handoff.js";
import { replayWorkstreamEntries } from "../workstream-replay.js";
import { createWorkstreamSnapshot, workstreamEntry } from "../workstream-state.js";
import type { ActivityComplete } from "../workstream-activity.js";

interface Harness {
  readonly api: ExtensionAPI;
  readonly events: Map<string, Array<(event: Record<string, unknown>, ctx: ExtensionContext) => unknown>>;
  readonly commands: Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>;
  readonly tools: Map<string, unknown>;
  readonly notifications: string[];
  readonly entries: unknown[];
  readonly statuses: string[];
}

function makeHarness(): Harness {
  const events = new Map<string, Array<(event: Record<string, unknown>, ctx: ExtensionContext) => unknown>>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const tools = new Map<string, unknown>();
  const notifications: string[] = [];
  const entries: unknown[] = [];
  const statuses: string[] = [];
  const api = {
    registerFlag() {},
    getFlag() { return undefined; },
    on(name: string, handler: (event: Record<string, unknown>, ctx: ExtensionContext) => unknown) {
      const current = events.get(name) ?? [];
      current.push(handler);
      events.set(name, current);
    },
    registerCommand(name: string, definition: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
      commands.set(name, definition);
    },
    registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", id: `entry-${entries.length + 1}`, parentId: null, timestamp: new Date().toISOString(), customType, data });
    },
    sendMessage() {},
  } as unknown as ExtensionAPI;
  return { api, events, commands, tools, notifications, entries, statuses };
}

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-integration-"));
  fs.mkdirSync(path.join(root, "agent"), { recursive: true });
  return root;
}

function contextFor(root: string, harness: Harness, sessionId: string, entries: unknown[]): ExtensionContext {
  const sessionFile = path.join(root, `${sessionId}.jsonl`);
  const activityComplete: ActivityComplete = async () => ({
    role: "assistant",
    content: [{ type: "text", text: JSON.stringify({ events: [{ kind: "decision", summary: "Integrated durable workstream lifecycle", relevant: true, sourceEntryIds: ["commit-1"] }] }) }],
    stopReason: "stop",
    api: "openai.responses",
    provider: "openai",
    model: "gpt-5.6-luna",
    timestamp: Date.now(),
    usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  return {
    hasUI: true,
    cwd: root,
    model: undefined,
    getContextUsage: () => ({ tokens: 1_000 }),
    sessionManager: {
      getEntries: () => entries,
      getSessionId: () => sessionId,
      getSessionFile: () => sessionFile,
      getSessionDir: () => root,
      getBranch: () => entries,
    },
    modelRegistry: {
      find: (provider: string, id: string) => provider === "openai" && id === "gpt-5.6-luna" ? ({ provider, id, reasoning: true } as never) : undefined,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
      complete: activityComplete,
    },
    ui: {
      notify: (message: string) => harness.notifications.push(message),
      setStatus: (_name: string, value: string) => harness.statuses.push(value),
      setWidget() {},
      getToolsExpanded: () => false,
      setWorkingMessage() {},
      setWorkingVisible() {},
      setWorkingIndicator() {},
    },
    isIdle: () => true,
  } as unknown as ExtensionContext;
}

function firstHandler(harness: Harness, name: string): (event: Record<string, unknown>, ctx: ExtensionContext) => unknown {
  const handler = harness.events.get(name)?.[0];
  assert.ok(handler, `expected ${name} lifecycle registration`);
  return handler;
}

test("final integration registers and executes durable workstream lifecycle and user seams", async () => {
  const root = tempRoot();
  const priorHome = process.env.HOME;
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = root;
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  try {
    const extension = await import(`../index.js?integration=${Date.now()}`);
    const harness = makeHarness();
    extension.default(harness.api);
    for (const eventName of ["session_start", "before_agent_start", "agent_settled", "session_before_compact", "session_shutdown"]) {
      assert.ok(harness.events.has(eventName), `expected ${eventName} lifecycle registration`);
    }
    assert.ok(harness.commands.has("focus"));
    assert.ok(harness.commands.has("sessions"), "session discovery must be user-facing");
    assert.ok(harness.tools.has("session_focus"));

    const snapshot = createWorkstreamSnapshot({
      workstreamId: "ws-integration",
      piSessionId: "integration-session",
      objective: "Ship the durable integration",
      objectivePinned: true,
      refs: [{ kind: "graft-spec", value: "0001-durable-session-workstreams" }],
      now: new Date("2026-07-20T16:00:00.000Z"),
      idFactory: () => "snapshot-1",
    });
    const entries: unknown[] = [workstreamEntry(snapshot, { entryId: "snapshot-entry", timestamp: "2026-07-20T16:00:00.000Z" })];
    const ctx = contextFor(root, harness, "integration-session", entries);
    await firstHandler(harness, "session_start")({}, ctx);
    const registryRoot = path.join(root, "agent", "session-registry", "v1");
    const projectDirs = fs.readdirSync(registryRoot);
    assert.equal(projectDirs.length, 1, "session_start must publish a private registry projection");
    const projectionFile = path.join(registryRoot, projectDirs[0] as string, "integration-session.json");
    assert.equal(JSON.parse(fs.readFileSync(projectionFile, "utf8")).objective, "Ship the durable integration");

    await firstHandler(harness, "before_agent_start")({ prompt: "Continue the integration", systemPrompt: "base" }, ctx);
    entries.push({ type: "commit", id: "commit-1", summary: "wire lifecycle" });
    await firstHandler(harness, "agent_settled")({}, ctx);
    assert.ok(harness.entries.some((entry) => typeof entry === "object" && entry !== null && (entry as { customType?: string }).customType === "context-aware.activity.v1"), "settled lifecycle must invoke bounded activity projection");

    const sessionsCommand = harness.commands.get("sessions");
    assert.ok(sessionsCommand);
    await sessionsCommand.handler("", ctx);
    assert.match(harness.notifications.at(-1) ?? "", /integration-session/);
    assert.match(harness.notifications.at(-1) ?? "", /Ship the durable integration/);
    const focusCommand = harness.commands.get("focus");
    assert.ok(focusCommand);
    await focusCommand.handler("health", ctx);
    assert.match(harness.notifications.at(-1) ?? "", /capabilities=/);

    await firstHandler(harness, "session_shutdown")({}, ctx);
    assert.equal(JSON.parse(fs.readFileSync(projectionFile, "utf8")).state, "closed", "shutdown must close only this session projection");
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cmux projection command failures stay fail-open and degrade health with scrubbed diagnostics", async () => {
  const root = tempRoot();
  const priorHome = process.env.HOME;
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  const priorCmuxBin = process.env.CMUX_BIN;
  const cmuxBin = path.join(root, "cmux-token=super-secret");
  fs.writeFileSync(cmuxBin, `#!/bin/sh
case "$1" in
  --version) printf 'cmux fake 0.1\\n' ;;
  ping) exit 0 ;;
  status|clear) exit 1 ;;
  *) exit 0 ;;
esac
`);
  fs.chmodSync(cmuxBin, 0o755);
  process.env.HOME = root;
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  process.env.CMUX_BIN = cmuxBin;
  try {
    const extension = await import(`../index.js?cmux-failure=${Date.now()}`);
    const harness = makeHarness();
    extension.default(harness.api);
    const snapshot = createWorkstreamSnapshot({
      workstreamId: "ws-cmux-failure",
      piSessionId: "cmux-failure-session",
      objective: "Keep the lifecycle usable",
      objectivePinned: true,
      refs: [{ kind: "graft-spec", value: "0001-durable-session-workstreams" }],
      now: new Date("2026-07-20T16:00:00.000Z"),
      idFactory: () => "cmux-failure-snapshot",
    });
    const entries: unknown[] = [workstreamEntry(snapshot, { entryId: "cmux-failure-entry", timestamp: "2026-07-20T16:00:00.000Z" })];
    const ctx = contextFor(root, harness, "cmux-failure-session", entries);

    await firstHandler(harness, "session_start")({}, ctx);
    const focusCommand = harness.commands.get("focus");
    assert.ok(focusCommand);
    await focusCommand.handler("health", ctx);
    const focusHealth = harness.notifications.at(-1) ?? "";
    assert.match(focusHealth, /cmux:degraded/);
    assert.match(focusHealth, /\nLast errors:/u);
    assert.doesNotMatch(focusHealth, /\\nLast errors:/u);
    assert.doesNotMatch(focusHealth, /super-secret/);

    await firstHandler(harness, "session_shutdown")({}, ctx);
    const sessionsCommand = harness.commands.get("sessions");
    assert.ok(sessionsCommand);
    await sessionsCommand.handler("health", ctx);
    const sessionsHealth = harness.notifications.at(-1) ?? "";
    assert.match(sessionsHealth, /cmux:degraded/);
    assert.match(sessionsHealth, /\nLast errors:/u);
    assert.doesNotMatch(sessionsHealth, /\\nLast errors:/u);
    assert.doesNotMatch(sessionsHealth, /super-secret/);
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    if (priorCmuxBin === undefined) delete process.env.CMUX_BIN;
    else process.env.CMUX_BIN = priorCmuxBin;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("disabled cmux projections stay fail-open without a false degraded health diagnostic", async () => {
  const root = tempRoot();
  const priorHome = process.env.HOME;
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  const priorCmuxBin = process.env.CMUX_BIN;
  delete process.env.CMUX_BIN;
  process.env.HOME = root;
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  try {
    const extension = await import(`../index.js?cmux-disabled=${Date.now()}`);
    const harness = makeHarness();
    extension.default(harness.api);
    const snapshot = createWorkstreamSnapshot({
      workstreamId: "ws-cmux-disabled",
      piSessionId: "cmux-disabled-session",
      objective: "Keep optional capabilities fail-open",
      objectivePinned: true,
      refs: [{ kind: "graft-spec", value: "0001-durable-session-workstreams" }],
      now: new Date("2026-07-20T16:00:00.000Z"),
      idFactory: () => "cmux-disabled-snapshot",
    });
    const entries: unknown[] = [workstreamEntry(snapshot, { entryId: "cmux-disabled-entry", timestamp: "2026-07-20T16:00:00.000Z" })];
    const ctx = contextFor(root, harness, "cmux-disabled-session", entries);

    await firstHandler(harness, "session_start")({}, ctx);
    const focusCommand = harness.commands.get("focus");
    assert.ok(focusCommand);
    await focusCommand.handler("health", ctx);
    const health = harness.notifications.at(-1) ?? "";
    assert.match(health, /cmux:disabled/);
    assert.doesNotMatch(health, /cmux:degraded/);
    assert.doesNotMatch(health, /projection-failed/);
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    if (priorCmuxBin === undefined) delete process.env.CMUX_BIN;
    else process.env.CMUX_BIN = priorCmuxBin;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("final integration consumes optional launcher handoff without owning launch", async () => {
  const root = tempRoot();
  const priorHome = process.env.HOME;
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = root;
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  try {
    const extension = await import(`../index.js?launcher=${Date.now()}`);
    const harness = makeHarness();
    extension.default(harness.api);
    const childEntries: unknown[] = [];
    const handoff = createLauncherHandoff({
      handoffId: "handoff-1",
      workstreamId: "ws-parent",
      parentPiSessionId: "parent-session",
      objective: "Continue launched workstream",
      status: "active",
      refs: [{ kind: "graft-spec", value: "0001-durable-session-workstreams" }],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const acknowledgements: unknown[] = [];
    const ctx = {
      ...contextFor(root, harness, "child-session", childEntries),
      launcherHandoff: handoff,
      launcherChild: { piSessionId: "child-session", terminal: { terminalId: "terminal-1", kind: "other", location: "pane-1" } },
      acknowledgeLauncherHandoff: (acknowledgement: unknown) => acknowledgements.push(acknowledgement),
    } as unknown as ExtensionContext;
    await firstHandler(harness, "session_start")({}, ctx);
    assert.ok(harness.entries.some((entry) => typeof entry === "object" && entry !== null && (entry as { customType?: string }).customType === "context-aware.workstream.v1"), "session_start must consume handoff into the child transcript");
    assert.equal(acknowledgements.length, 1);
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher acknowledgement failures degrade health without leaking secrets", async () => {
  const root = tempRoot();
  const priorHome = process.env.HOME;
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = root;
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  try {
    const extension = await import(`../index.js?launcher-failure=${Date.now()}`);
    const harness = makeHarness();
    extension.default(harness.api);
    const childEntries: unknown[] = [];
    const handoff = createLauncherHandoff({
      handoffId: "failed-ack-handoff",
      workstreamId: "ws-launcher-failure",
      parentPiSessionId: "parent-session",
      objective: "Continue launched workstream safely",
      status: "active",
      refs: [{ kind: "graft-spec", value: "0001-durable-session-workstreams" }],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const ctx = {
      ...contextFor(root, harness, "failed-ack-child", childEntries),
      launcherHandoff: handoff,
      launcherChild: { piSessionId: "failed-ack-child", terminal: { terminalId: "terminal-failure", kind: "other", location: "pane-failure" } },
      acknowledgeLauncherHandoff: () => { throw new Error("token=launcher-secret"); },
    } as unknown as ExtensionContext;

    await firstHandler(harness, "session_start")({}, ctx);
    assert.ok(harness.entries.some((entry) => typeof entry === "object" && entry !== null && (entry as { customType?: string }).customType === "context-aware.workstream.v1"), "session_start must append the handoff snapshot before acknowledgement failure");

    const focusCommand = harness.commands.get("focus");
    assert.ok(focusCommand);
    await focusCommand.handler("health", ctx);
    const health = harness.notifications.at(-1) ?? "";
    assert.match(health, /worktree-launcher:degraded/);
    assert.match(health, /acknowledgement-failed/);
    assert.doesNotMatch(health, /launcher-secret/);
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("transcript authority suppresses a divergent launcher handoff", async () => {
  const root = tempRoot();
  const priorHome = process.env.HOME;
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = root;
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  try {
    const extension = await import(`../index.js?authority=${Date.now()}`);
    const harness = makeHarness();
    extension.default(harness.api);
    const authoritative = createWorkstreamSnapshot({
      workstreamId: "ws-authoritative",
      piSessionId: "authoritative-child",
      objective: "Continue the pinned workstream",
      objectivePinned: true,
      refs: [{ kind: "graft-spec", value: "0001-durable-session-workstreams" }],
      now: new Date("2026-07-20T16:00:00.000Z"),
      idFactory: () => "authoritative-snapshot",
    });
    const childEntries: unknown[] = [workstreamEntry(authoritative, { entryId: "authoritative-entry", timestamp: "2026-07-20T16:00:00.000Z" })];
    const handoff = createLauncherHandoff({
      handoffId: "divergent-handoff",
      workstreamId: "ws-launcher",
      parentPiSessionId: "launcher-parent",
      objective: "Replace the pinned workstream",
      status: "active",
      refs: [{ kind: "graft-spec", value: "0001-durable-session-workstreams" }],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const acknowledgements: unknown[] = [];
    const ctx = {
      ...contextFor(root, harness, "authoritative-child", childEntries),
      launcherHandoff: handoff,
      launcherChild: { piSessionId: "authoritative-child", terminal: { terminalId: "terminal-authority", kind: "other", location: "pane-authority" } },
      acknowledgeLauncherHandoff: (acknowledgement: unknown) => acknowledgements.push(acknowledgement),
    } as unknown as ExtensionContext;

    await firstHandler(harness, "session_start")({}, ctx);

    assert.equal(replayWorkstreamEntries(childEntries).snapshot?.workstreamId, "ws-authoritative");
    assert.equal(harness.entries.length, 0, "authoritative transcript must prevent launcher append");
    assert.equal(acknowledgements.length, 0, "authoritative transcript must prevent launcher acknowledgement");
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
