import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import piCallbacks, { formatStatusSummary, handleAction } from "../index.ts";
import { createJobWidgetLoop, formatJobWidgetLines, JOB_WIDGET_KEY, JOB_WIDGET_REFRESH_INTERVAL_MS, updateJobWidget } from "../src/job-widget.ts";
import { appendDeliveryEvent, closeSessionPresence, getJob, listJobs, listPendingDeliveryEvents, loadStore, registerSessionPresence, removeJob, updateJob, upsertJob } from "../src/store.ts";
import type { PollJob, ReminderJob, SessionPresence } from "../src/types.ts";

interface RegisteredCommand {
  description: string;
  handler: (args: string, ctx: FakeContext) => void | Promise<void>;
}

interface SendMessageOptions {
  triggerTurn?: boolean;
  deliverAs?: "steer" | "followUp" | "nextTurn";
}

interface FakeContext {
  cwd: string;
  mode?: "tui" | "rpc";
  hasUI: boolean;
  sessionManager: { getSessionFile: () => string; getSessionId: () => string };
  ui: {
    notify: (message: string, level: "info" | "warning" | "error") => void;
    setStatus: (key: string, value: string | undefined) => void;
    setWidget?: (key: string, content: unknown, options?: { placement?: "aboveEditor" | "belowEditor" }) => void;
  };
  isIdle: () => boolean;
}

interface StatusCall {
  key: string;
  value: string | undefined;
}

interface WidgetCall {
  key: string;
  content: unknown;
  options?: { placement?: "aboveEditor" | "belowEditor" } | undefined;
}

async function waitForStatusCall(calls: StatusCall[], predicate: (call: StatusCall) => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (calls.some(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for status call; received ${JSON.stringify(calls)}`);
}

function useTempCallbacksDir(t: test.TestContext): string {
  const previous = process.env.PI_CALLBACKS_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-callbacks-extension-test-"));
  process.env.PI_CALLBACKS_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CALLBACKS_DIR;
    else process.env.PI_CALLBACKS_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function reminderJob(overrides: Partial<ReminderJob> = {}): ReminderJob {
  const now = Date.now();
  return {
    id: "rem_extension",
    kind: "reminder",
    status: "pending",
    createdAt: now,
    updatedAt: now,
    sessionFile: "/tmp/session.json",
    cwd: process.cwd(),
    message: "extension command job",
    delivery: "custom",
    triggerTurn: true,
    dueAt: now + 60_000,
    events: [{ at: now, kind: "created", message: "created" }],
    ...overrides,
  };
}
test("handleAction rejects malformed coalesce values before persisting a poll", (t) => {
  useTempCallbacksDir(t);
  const ctx: FakeContext = {
    cwd: process.cwd(),
    hasUI: false,
    sessionManager: { getSessionFile: () => "/tmp/coalesce-session.json", getSessionId: () => "coalesce-session" },
    ui: { notify: () => undefined, setStatus: () => undefined, setWidget: () => undefined },
    isIdle: () => true,
  };

  for (const coalesce of ["yes", 1, null, {}]) {
    assert.throws(
      () => handleAction(ctx as never, { action: "poll", command: "echo ready", coalesce }),
      /coalesce must be a boolean/,
    );
  }
  assert.deepEqual(listJobs(), [], "malformed coalesce must not create a persisted job");
});

test("handleAction captures a stateful coalesce accessor once before persisting", (t) => {
  useTempCallbacksDir(t);
  const ctx: FakeContext = {
    cwd: process.cwd(),
    hasUI: false,
    sessionManager: { getSessionFile: () => "/tmp/coalesce-capture-session.json", getSessionId: () => "coalesce-capture-session" },
    ui: { notify: () => undefined, setStatus: () => undefined, setWidget: () => undefined },
    isIdle: () => true,
  };
  let reads = 0;
  const params = {
    action: "poll" as const,
    command: "echo ready",
    get coalesce(): unknown {
      reads++;
      return reads === 1 ? true : "malformed after validation";
    },
  };

  const result = handleAction(ctx as never, params);
  assert.equal(reads, 1);
  assert.equal((result.details as PollJob).coalesce, true);
  assert.equal((loadStore().jobs[0] as PollJob).coalesce, true);
});

test("footer status is silent when idle, bounded when active, and visible when degraded", () => {
  assert.equal(formatStatusSummary("running", 0, 0, false), undefined);
  assert.equal(formatStatusSummary("running", 2, 1, false), "callbacks: 2 active · 1 delivery");
  assert.equal(formatStatusSummary("running", 0, 0, true), "callbacks: delivery paused");
  assert.equal(formatStatusSummary("daemon down", 0, 0, false), "callbacks: daemon down");
  assert.equal(formatStatusSummary("running", 120, 120, false), "callbacks: 99+ active · 99+ deliveries");
  assert.doesNotMatch(formatStatusSummary("running", 2, 1, false) ?? "", /last poll|poll scheduled/);
});

test("extension passes a check-in triggerTurn override to sendMessage", (t) => {
  useTempCallbacksDir(t);
  const handlers = new Map<string, (event: { reason?: string }, ctx: FakeContext) => void>();
  const sendOptions: SendMessageOptions[] = [];
  const pi = {
    registerMessageRenderer: () => undefined,
    on: (event: string, handler: (event: { reason?: string }, ctx: FakeContext) => void) => { handlers.set(event, handler); },
    registerTool: () => undefined,
    registerCommand: () => undefined,
    sendMessage: (_message: unknown, options?: SendMessageOptions) => { sendOptions.push(options ?? {}); },
    sendUserMessage: () => { throw new Error("sendUserMessage should not be called for a custom check-in"); },
  };
  const ctx: FakeContext = {
    cwd: process.cwd(),
    hasUI: true,
    sessionManager: { getSessionFile: () => "/tmp/check-in-session.json", getSessionId: () => "check-in-session" },
    ui: { notify: () => undefined, setStatus: () => undefined, setWidget: () => undefined },
    isIdle: () => true,
  };
  piCallbacks(pi as never);

  const job = upsertJob(reminderJob({
    id: "check-in-trigger-boundary",
    sessionFile: "/tmp/check-in-session.json",
    origin: { sessionId: "check-in-session", sessionFile: "/tmp/check-in-session.json", cwd: process.cwd() },
  }));
  appendDeliveryEvent(job, "check-in", "Periodic status check-in", undefined, false);
  handlers.get("session_start")!({ reason: "startup" }, ctx);

  assert.equal(sendOptions.length, 1);
  assert.equal(sendOptions[0]?.triggerTurn, false);
  handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
});

test("poll delivery seam prefixes freshness, warning, and structured handoff details", (t) => {
  useTempCallbacksDir(t);
  const handlers = new Map<string, (event: { reason?: string }, ctx: FakeContext) => void>();
  const sent: Array<{ content: string; details?: Record<string, unknown> }> = [];
  const pi = {
    registerMessageRenderer: () => undefined,
    on: (event: string, handler: (event: { reason?: string }, ctx: FakeContext) => void) => { handlers.set(event, handler); },
    registerTool: () => undefined,
    registerCommand: () => undefined,
    sendMessage: (message: { content: string; details?: Record<string, unknown> }) => { sent.push(message); },
    sendUserMessage: () => undefined,
  };
  const session = { sessionFile: "/tmp/freshness-session.json", sessionId: "freshness-session" };
  const ctx: FakeContext = {
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    sessionManager: { getSessionFile: () => session.sessionFile, getSessionId: () => session.sessionId },
    ui: { notify: () => undefined, setStatus: () => undefined, setWidget: () => undefined },
    isIdle: () => true,
  };
  piCallbacks(pi as never);
  const job = upsertJob({
    ...reminderJob({
      id: "poll-freshness-extension",
      sessionFile: session.sessionFile,
      origin: { ...session, cwd: process.cwd() },
    }),
    kind: "poll",
    intervalMs: 100,
    nextRunAt: Date.now(),
    condition: { type: "always" },
    runCount: 1,
    pushEachResult: true,
    coalesce: false,
  } as PollJob);
  const queuedAt = Date.now();
  const oldQueuedAt = queuedAt - 301;
  appendDeliveryEvent(job, "poll", "fresh result", { source: "test" }, true, { at: queuedAt, generatedAt: queuedAt - 10 });
  const oldEvent = appendDeliveryEvent(job, "poll", "backlogged result", undefined, true, { at: oldQueuedAt, generatedAt: oldQueuedAt - 10 });

  handlers.get("session_start")!({ reason: "startup" }, ctx);
  assert.equal(sent.length, 2);
  assert.match(sent[0]!.content, /^generated=.* delivered=.* queued=/);
  assert.match(sent[1]!.content, /consumer is not keeping up/);
  assert.match(sent[1]!.content, /not a condition match/);
  assert.equal(sent[0]!.details?.payload && (sent[0]!.details?.payload as { source: string }).source, "test");
  assert.match(String(sent[0]!.details?.generatedAt), /T/);
  const persisted = loadStore().deliveryEvents.find((event) => event.id === oldEvent.id);
  const deliveredLine = sent[1]!.content.split(" ").find((part) => part.startsWith("delivered="));
  assert.equal(persisted?.deliveredAt, Date.parse(deliveredLine!.slice("delivered=".length)));
  handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
});

test("poll delivery seam supports custom, user, and notify-only outcomes", (t) => {
  useTempCallbacksDir(t);
  const handlers = new Map<string, (event: { reason?: string }, ctx: FakeContext) => void>();
  const customMessages: string[] = [];
  const userMessages: string[] = [];
  const notifications: string[] = [];
  const pi = {
    registerMessageRenderer: () => undefined,
    on: (event: string, handler: (event: { reason?: string }, ctx: FakeContext) => void) => { handlers.set(event, handler); },
    registerTool: () => undefined,
    registerCommand: () => undefined,
    sendMessage: (message: { content: string }) => { customMessages.push(message.content); },
    sendUserMessage: (message: string) => { userMessages.push(message); },
  };
  const session = { sessionFile: "/tmp/delivery-modes-session.json", sessionId: "delivery-modes-session" };
  const ctx: FakeContext = {
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    sessionManager: { getSessionFile: () => session.sessionFile, getSessionId: () => session.sessionId },
    ui: { notify: (message) => { notifications.push(message); }, setStatus: () => undefined, setWidget: () => undefined },
    isIdle: () => true,
  };
  piCallbacks(pi as never);

  const pollJobFor = (id: string, delivery: PollJob["delivery"]): PollJob => ({
    ...reminderJob({
      id,
      sessionFile: session.sessionFile,
      origin: { ...session, cwd: process.cwd() },
      delivery,
    }),
    kind: "poll",
    intervalMs: 100,
    nextRunAt: Date.now(),
    condition: { type: "always" },
    runCount: 1,
    pushEachResult: true,
    coalesce: true,
  });
  for (const [index, delivery] of (["custom", "user", "notify-only"] as const).entries()) {
    const job = upsertJob(pollJobFor(`poll-delivery-mode-${index}`, delivery));
    const metadata = delivery === "user" ? {} : { generatedAt: Date.now() };
    appendDeliveryEvent(job, "poll", `${delivery} result`, undefined, true, metadata);
    if (delivery === "custom") {
      appendDeliveryEvent(job, "poll", `${delivery} result`, undefined, true, metadata);
    }
  }

  assert.deepEqual(listJobs().map((job) => job.delivery), ["custom", "user", "notify-only"]);
  handlers.get("session_start")!({ reason: "startup" }, ctx);
  assert.equal(customMessages.length, 1);
  assert.match(customMessages[0] ?? "", /custom result/);
  assert.match(customMessages[0] ?? "", /generated=.*delivered=.*queued=.*dropped=1/);
  assert.equal(userMessages.length, 1);
  assert.match(userMessages[0] ?? "", /user result/);
  assert.match(userMessages[0] ?? "", /generated=.*delivered=.*queued=/);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0] ?? "", /notify-only result/);
  assert.match(notifications[0] ?? "", /generated=.*delivered=.*queued=/);
  handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
});

test("poll freshness warning starts only after more than three intervals", (t) => {
  useTempCallbacksDir(t);
  let now = 100;
  t.mock.method(Date, "now", () => now);
  const handlers = new Map<string, (event: { reason?: string }, ctx: FakeContext) => void>();
  const sent: string[] = [];
  const pi = {
    registerMessageRenderer: () => undefined,
    on: (event: string, handler: (event: { reason?: string }, ctx: FakeContext) => void) => { handlers.set(event, handler); },
    registerTool: () => undefined,
    registerCommand: () => undefined,
    sendMessage: (message: { content: string }) => { sent.push(message.content); },
    sendUserMessage: () => undefined,
  };
  const session = { sessionFile: "/tmp/warning-boundary-session.json", sessionId: "warning-boundary-session" };
  const ctx: FakeContext = {
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    sessionManager: { getSessionFile: () => session.sessionFile, getSessionId: () => session.sessionId },
    ui: { notify: () => undefined, setStatus: () => undefined, setWidget: () => undefined },
    isIdle: () => true,
  };
  piCallbacks(pi as never);
  const job = upsertJob({
    ...reminderJob({ id: "poll-warning-boundary", createdAt: 0, updatedAt: 0, sessionFile: session.sessionFile, origin: { ...session, cwd: process.cwd() } }),
    kind: "poll",
    intervalMs: 100,
    nextRunAt: 0,
    condition: { type: "text_contains", value: "consumer is not keeping up" },
    runCount: 1,
    pushEachResult: true,
    coalesce: true,
    lastResult: { at: 0, ok: true, matched: false },
  } as PollJob);
  appendDeliveryEvent(job, "poll", "exactly three intervals", undefined, true, { at: 0, generatedAt: 0, backlogStartedAt: 0 });
  now = 300;
  handlers.get("session_start")!({ reason: "startup" }, ctx);
  assert.doesNotMatch(sent[0] ?? "", /consumer is not keeping up/);

  appendDeliveryEvent(job, "poll", "more than three intervals", undefined, true, { at: 1, generatedAt: 1, backlogStartedAt: 1 });
  now = 302;
  handlers.get("session_compact")!({}, ctx);
  assert.match(sent[1] ?? "", /consumer is not keeping up/);
  const persisted = getJob(job.id) as PollJob | undefined;
  assert.equal(persisted?.lastResult?.matched, false, "delivery warning does not change the last poll result");
  assert.equal(persisted?.status, "pending", "delivery warning does not match the poll condition or complete the job");
  handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
});
test("busy delivery final recheck releases a claim before retrying when idle", (t) => {
  useTempCallbacksDir(t);
  const handlers = new Map<string, (event: { reason?: string }, ctx: FakeContext) => void>();
  const sent: string[] = [];
  const pi = {
    registerMessageRenderer: () => undefined,
    on: (event: string, handler: (event: { reason?: string }, ctx: FakeContext) => void) => { handlers.set(event, handler); },
    registerTool: () => undefined,
    registerCommand: () => undefined,
    sendMessage: (message: { content: string }) => { sent.push(message.content); },
    sendUserMessage: () => undefined,
  };
  const session = { sessionFile: "/tmp/busy-recheck-session.json", sessionId: "busy-recheck-session" };
  const job = upsertJob({
    ...reminderJob({ id: "poll-busy-recheck", sessionFile: session.sessionFile, origin: { ...session, cwd: process.cwd() } }),
    kind: "poll",
    intervalMs: 100,
    nextRunAt: Date.now(),
    condition: { type: "always" },
    runCount: 1,
    pushEachResult: true,
    coalesce: true,
  } as PollJob);
  appendDeliveryEvent(job, "poll", "retryable result", undefined, true, { generatedAt: Date.now() });
  let idleChecks = 0;
  const ctx: FakeContext = {
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    sessionManager: { getSessionFile: () => session.sessionFile, getSessionId: () => session.sessionId },
    ui: { notify: () => undefined, setStatus: () => undefined, setWidget: () => undefined },
    isIdle: () => ++idleChecks === 1,
  };
  piCallbacks(pi as never);

  handlers.get("session_start")!({ reason: "startup" }, ctx);
  assert.equal(listPendingDeliveryEvents()[0]?.claimedBy, undefined, "a final busy check releases the claim");
  assert.equal(sent.length, 0);

  ctx.isIdle = () => true;
  handlers.get("session_compact")!({}, ctx);
  assert.equal(sent.length, 1);
  assert.match(sent[0] ?? "", /retryable result/);
  assert.deepEqual(listPendingDeliveryEvents(), []);
  handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
});

test("conversation delivery failure releases every unprocessed claim for a later retry", (t) => {
  useTempCallbacksDir(t);
  const handlers = new Map<string, (event: { reason?: string }, ctx: FakeContext) => void>();
  const sent: string[] = [];
  let failDelivery = true;
  const pi = {
    registerMessageRenderer: () => undefined,
    on: (event: string, handler: (event: { reason?: string }, ctx: FakeContext) => void) => { handlers.set(event, handler); },
    registerTool: () => undefined,
    registerCommand: () => undefined,
    sendMessage: (message: { content: string }) => {
      if (failDelivery) {
        failDelivery = false;
        throw new Error("conversation delivery unavailable");
      }
      sent.push(message.content);
    },
    sendUserMessage: () => undefined,
  };
  const session = { sessionFile: "/tmp/delivery-error-session.json", sessionId: "delivery-error-session" };
  const job = upsertJob({
    ...reminderJob({ id: "poll-delivery-error", sessionFile: session.sessionFile, origin: { ...session, cwd: process.cwd() } }),
    kind: "poll",
    intervalMs: 100,
    nextRunAt: Date.now(),
    condition: { type: "always" },
    runCount: 1,
    pushEachResult: true,
    coalesce: false,
  } as PollJob);
  appendDeliveryEvent(job, "poll", "first delivery result", undefined, true, { generatedAt: Date.now() });
  appendDeliveryEvent(job, "poll", "second delivery result", undefined, true, { generatedAt: Date.now() });
  const ctx: FakeContext = {
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    sessionManager: { getSessionFile: () => session.sessionFile, getSessionId: () => session.sessionId },
    ui: { notify: () => undefined, setStatus: () => undefined, setWidget: () => undefined },
    isIdle: () => true,
  };
  piCallbacks(pi as never);

  assert.throws(() => handlers.get("session_start")!({ reason: "startup" }, ctx), /conversation delivery unavailable/);
  const pendingAfterFailure = listPendingDeliveryEvents();
  assert.equal(pendingAfterFailure.length, 2);
  assert.ok(pendingAfterFailure.every((event) => event.claimedBy === undefined), "all unprocessed delivery claims are released");

  handlers.get("session_compact")!({}, ctx);
  assert.equal(sent.length, 2, "the failed first event and later event are both retried");
  assert.deepEqual(listPendingDeliveryEvents(), []);
  handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
});


test("job widget refreshes on an injected timer and clears when idle", (t) => {
  useTempCallbacksDir(t);
  const session = { sessionId: "widget-session", sessionFile: "/tmp/widget-session.json", cwd: process.cwd() };
  const calls: WidgetCall[] = [];
  const ctx = {
    cwd: session.cwd,
    mode: "tui" as const,
    hasUI: true,
    sessionManager: { getSessionFile: () => session.sessionFile!, getSessionId: () => session.sessionId },
    ui: { setWidget: (key: string, content: unknown, options?: WidgetCall["options"]) => calls.push({ key, content, options }) },
  };
  const job = upsertJob(reminderJob({
    id: "widget-refresh",
    sessionFile: session.sessionFile,
    origin: session,
    label: "wait for deploy",
  }));

  let tick: (() => void) | undefined;
  const handle = {} as ReturnType<typeof setInterval>;
  const loop = createJobWidgetLoop({
    setInterval: (callback, delay) => {
      assert.equal(delay, JOB_WIDGET_REFRESH_INTERVAL_MS);
      tick = callback;
      return handle;
    },
    clearInterval: (value) => assert.equal(value, handle),
  });

  updateJobWidget(ctx as never, 1_000);
  assert.equal(calls.at(-1)?.key, JOB_WIDGET_KEY);
  assert.equal(calls.at(-1)?.options?.placement, "belowEditor");
  assert.equal(typeof calls.at(-1)?.content, "function");
  const factory = calls.at(-1)?.content as (tui: unknown, theme: { fg: (_color: string, text: string) => string }) => { render: (width: number) => string[] };
  assert.match(factory({}, { fg: (_color, text) => text }).render(200).join("\n"), /widget-refresh.*status: pending/);
  // Three jobs fit exactly, with no header line stealing one of them.
  const sourceJob: PollJob = {
    ...job,
    id: "widget-source",
    kind: "poll",
    intervalMs: 10_000,
    nextRunAt: 1_000,
    source: { kind: "gitlab_pipeline", host: "gitlab.test", project: "group/project", pipelineId: 42 },
    condition: { type: "always" },
    runCount: 1,
    pushEachResult: true,
    lastResult: { at: 1_000, ok: false, status: "running", text: "running", matched: false },
  };
  assert.match(formatJobWidgetLines([sourceJob], 1_000)[0] ?? "", /source=running/);
  // A watched pipeline's status is news, not boilerplate, so it is held at the kind tier:
  // at 70 columns this job sheds `status:` but keeps both `kind:` and `source=`.
  const sourceMidLine = formatJobWidgetLines([sourceJob], 1_000, 70)[0] ?? "";
  assert.doesNotMatch(sourceMidLine, /status: /, "a poll sheds status first too");
  assert.match(sourceMidLine, /kind: poll/, "kind survives at the middle tier");
  assert.match(sourceMidLine, /source=running/, "a source status survives with kind");
  const threeJobs = [job, { ...job, id: "widget-second" }, { ...job, id: "widget-third" }];
  const threeLines = formatJobWidgetLines(threeJobs, 1_000);
  assert.equal(threeLines.length, 3);
  assert.ok(threeLines.every((line) => !/more active/.test(line)), "three jobs must all be listed, not summarised");
  assert.match(threeLines[2] ?? "", /widget-third/);
  // A fourth job overflows: two listed, then the summary, still within three lines.
  const fourLines = formatJobWidgetLines([...threeJobs, { ...job, id: "widget-fourth" }], 1_000);
  assert.equal(fourLines.length, 3);
  assert.match(fourLines.at(-1) ?? "", /… and 2 more active/);

  // Responsive tiers: status goes first, then kind, and the id and label are kept longest.
  const wideLine = formatJobWidgetLines([job], 1_000, 200)[0] ?? "";
  assert.match(wideLine, /status: /, "a wide terminal keeps the status");
  assert.match(wideLine, /kind: /, "a wide terminal keeps the kind");
  // For this job the tiers measure 67, 49 and 32 columns, so 55 selects the middle one.
  const midLine = formatJobWidgetLines([job], 1_000, 55)[0] ?? "";
  assert.doesNotMatch(midLine, /status: /, "status is shed first");
  assert.match(midLine, /kind: /, "kind outlives status");
  // 40 fits only the id and label.
  const narrowLine = formatJobWidgetLines([job], 1_000, 40)[0] ?? "";
  assert.doesNotMatch(narrowLine, /status: |kind: /, "the narrowest tier keeps id and label only");
  assert.match(narrowLine, /widget-refresh/, "the id survives every tier");
  // Each tier must actually fit the width it was chosen for.
  for (const width of [200, 55, 40]) {
    const line = formatJobWidgetLines([job], 1_000, width)[0] ?? "";
    assert.ok(visibleWidth(line) <= width, `tier for width ${width} must fit it`);
  }
  // Without a width — RPC never reports one — every line keeps full detail.
  assert.match(formatJobWidgetLines([job], 1_000)[0] ?? "", /status: .*kind: /, "no width means full detail");

  loop.start(() => updateJobWidget(ctx as never, 2_000));
  assert.ok(tick);
  updateJob(job.id, (current) => ({ ...current, label: "deploy still running" }));
  tick!();
  const refreshedFactory = calls.at(-1)?.content as (tui: unknown, theme: { fg: (_color: string, text: string) => string }) => { render: (width: number) => string[] };
  assert.match(refreshedFactory({}, { fg: (_color, text) => text }).render(200).join("\n"), /deploy still running/);

  // Seam coverage: the same captured factory must apply tiers per render, and must restore
  // detail when the terminal widens again. Testing formatJobWidgetLines alone cannot catch a
  // render callback that ignores its width argument.
  const plainTheme = { fg: (_color: string, text: string) => text };
  const tierFactory = calls.at(-1)?.content as (tui: unknown, theme: typeof plainTheme) => { render: (width: number) => string[] };
  const renderAt = (width: number): string => tierFactory({}, plainTheme).render(width).join("\n");
  assert.match(renderAt(200), /status: .*kind: /, "a wide render keeps every field");
  const midRender = renderAt(60);
  assert.doesNotMatch(midRender, /status: /, "a middle render sheds status first");
  assert.match(midRender, /kind: /, "a middle render keeps kind");
  assert.doesNotMatch(renderAt(45), /status: |kind: /, "a narrow render keeps id and label only");
  assert.match(renderAt(200), /status: .*kind: /, "widening again restores full detail");

  updateJob(job.id, (current) => ({ ...current, label: "界".repeat(20) }));
  tick!();
  const wideFactory = calls.at(-1)?.content as (tui: unknown, theme: { fg: (_color: string, text: string) => string }) => { render: (width: number) => string[] };
  assert.ok(wideFactory({}, { fg: (_color, text) => text }).render(20).every((line) => visibleWidth(line) <= 20));

  updateJob(job.id, (current) => ({ ...current, status: "completed" }));
  tick!();
  assert.deepEqual(calls.at(-1), { key: JOB_WIDGET_KEY, content: undefined, options: undefined });
  loop.stop();
});

test("RPC widget boundary forwards active lines and clears with undefined", (t) => {
  useTempCallbacksDir(t);
  const session = { sessionId: "rpc-widget-session", sessionFile: "/tmp/rpc-widget-session.json", cwd: process.cwd() };
  const calls: WidgetCall[] = [];
  const ctx = {
    cwd: session.cwd,
    mode: "rpc" as const,
    hasUI: true,
    sessionManager: { getSessionFile: () => session.sessionFile!, getSessionId: () => session.sessionId },
    ui: { setWidget: (key: string, content: unknown, options?: WidgetCall["options"]) => calls.push({ key, content, options }) },
  };
  const job = upsertJob(reminderJob({
    id: "rpc-widget-active",
    sessionFile: session.sessionFile,
    origin: session,
  }));

  updateJobWidget(ctx as never, 1_000);
  assert.deepEqual(calls.at(-1), {
    key: JOB_WIDGET_KEY,
    content: formatJobWidgetLines([job], 1_000),
    options: { placement: "belowEditor" },
  });
  assert.ok(Array.isArray(calls.at(-1)?.content), "RPC forwards widget lines, not a component factory");

  updateJob(job.id, (current) => ({ ...current, status: "completed" }));
  updateJobWidget(ctx as never, 2_000);
  assert.deepEqual(calls.at(-1), { key: JOB_WIDGET_KEY, content: undefined, options: undefined });
});

test("extension status boundary captures active, degraded, and clearing lifecycle states", async (t) => {
  useTempCallbacksDir(t);
  const statusCalls: StatusCall[] = [];
  const widgetCalls: WidgetCall[] = [];
  const handlers = new Map<string, (event: { reason?: string }, ctx: FakeContext) => void>();
  let staleContext = false;
  const pi = {
    registerMessageRenderer: () => undefined,
    on: (event: string, handler: (event: { reason?: string }, ctx: FakeContext) => void) => { handlers.set(event, handler); },
    registerTool: () => undefined,
    registerCommand: () => undefined,
    sendMessage: () => undefined,
    sendUserMessage: () => undefined,
  };
  const ctx: FakeContext = {
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    sessionManager: { getSessionFile: () => "/tmp/status-session.json", getSessionId: () => "status-session" },
    ui: {
      notify: () => undefined,
      setStatus: (key, value) => { statusCalls.push({ key, value }); },
      setWidget: (key, content, options) => { widgetCalls.push({ key, content, options }); },
    },
    isIdle: () => {
      if (staleContext) throw new Error("ctx is stale after session replacement or reload");
      return true;
    },
  };
  piCallbacks(pi as never);

  const completedJob = upsertJob(reminderJob({
    id: "rem_status_delivery",
    status: "completed",
    sessionFile: "/tmp/status-session.json",
    origin: { sessionId: "status-session", sessionFile: "/tmp/status-session.json", cwd: process.cwd() },
  }));
  appendDeliveryEvent(completedJob, "reminder", "completed delivery");

  handlers.get("session_start")!({ reason: "startup" }, ctx);
  await waitForStatusCall(statusCalls, (call) => call.value === undefined);
  assert.deepEqual(statusCalls.find((call) => call.value === undefined), {
    key: "caair.pi-callbacks/jobs",
    value: undefined,
  });
  assert.deepEqual(widgetCalls.at(-1), { key: JOB_WIDGET_KEY, content: undefined, options: undefined });
  assert.deepEqual(listPendingDeliveryEvents(), [], "the final delivery was drained before the idle status cleared");

  const activeJob = upsertJob(reminderJob({
    id: "rem_status_active",
    sessionFile: "/tmp/status-session.json",
    origin: { sessionId: "status-session", sessionFile: "/tmp/status-session.json", cwd: process.cwd() },
  }));
  handlers.get("session_compact")!({}, ctx);
  assert.deepEqual(statusCalls.at(-1), { key: "caair.pi-callbacks/jobs", value: "callbacks: 1 active" });
  assert.equal(widgetCalls.at(-1)?.key, JOB_WIDGET_KEY);
  assert.equal(typeof widgetCalls.at(-1)?.content, "function");

  updateJob(activeJob.id, (job) => ({ ...job, status: "completed" }));
  handlers.get("session_compact")!({}, ctx);
  assert.deepEqual(statusCalls.at(-1), { key: "caair.pi-callbacks/jobs", value: undefined });
  assert.deepEqual(widgetCalls.at(-1), { key: JOB_WIDGET_KEY, content: undefined, options: undefined });

  const degradedJob = upsertJob(reminderJob({
    id: "rem_status_degraded",
    status: "completed",
    sessionFile: "/tmp/status-session.json",
    origin: { sessionId: "status-session", sessionFile: "/tmp/status-session.json", cwd: process.cwd() },
  }));
  appendDeliveryEvent(degradedJob, "reminder", "delivery that cannot be injected");
  staleContext = true;
  handlers.get("session_compact")!({}, ctx);
  assert.deepEqual(statusCalls.at(-1), {
    key: "caair.pi-callbacks/jobs",
    value: "callbacks: 1 delivery · delivery paused",
  });
  assert.ok(statusCalls.every((call) => call.key === "caair.pi-callbacks/jobs"));

  handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
});

test("bash sleep reminder is advisory, rate-limited, and command-private", (t) => {
  const dir = useTempCallbacksDir(t);
  const lifecycleHandlers = new Map<string, (event: { reason?: string }, ctx: FakeContext) => void>();
  const toolHandlers: Array<(event: { toolName: string; input: { command: string } }) => unknown> = [];
  const sent: Array<{ customType?: string; content?: string; details?: unknown; options?: SendMessageOptions }> = [];
  const pi = {
    registerMessageRenderer: () => undefined,
    on: (event: string, handler: unknown) => {
      if (event === "tool_call") toolHandlers.push(handler as (event: { toolName: string; input: { command: string } }) => unknown);
      else lifecycleHandlers.set(event, handler as (event: { reason?: string }, ctx: FakeContext) => void);
    },
    registerTool: () => undefined,
    registerCommand: () => undefined,
    sendMessage: (message: { customType?: string; content?: string; details?: unknown }, options?: SendMessageOptions) => { sent.push({ ...message, ...(options === undefined ? {} : { options }) }); },
    sendUserMessage: () => undefined,
  };
  const ctx: FakeContext = {
    cwd: process.cwd(),
    hasUI: false,
    sessionManager: { getSessionFile: () => "/tmp/sleep-reminder-session.json", getSessionId: () => "sleep-reminder-session" },
    ui: { notify: () => undefined, setStatus: () => undefined, setWidget: () => undefined },
    isIdle: () => true,
  };
  upsertJob(reminderJob({ id: "sleep-reminder-existing", message: "existing safe job" }));
  piCallbacks(pi as never);
  assert.equal(toolHandlers.length, 1);

  const command = "sleep 10 # hostile-sleep-sentinel";
  const input = { command };
  const snapshot = structuredClone(input);
  assert.deepEqual(toolHandlers[0]!({ toolName: "bash", input }), {});
  assert.deepEqual(input, snapshot);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.customType, "pi-callbacks");
  assert.equal(sent[0]?.content, "For a longer wait, use callbacks instead of keeping the bash command asleep.");
  assert.deepEqual(sent[0]?.options, { triggerTurn: false });
  assert.doesNotMatch(JSON.stringify(sent[0]), /hostile-sleep-sentinel/);
  assert.deepEqual(toolHandlers[0]!({ toolName: "bash", input: { command } }), {});
  assert.equal(sent.length, 1);
  assert.deepEqual(toolHandlers[0]!({ toolName: "not-bash", input: { command } }), {});
  assert.equal(sent.length, 1);

  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ version: 1, defaultTarget: "origin", sleepReminderMinSeconds: null }));
  lifecycleHandlers.get("session_compact")!({}, ctx);
  assert.deepEqual(toolHandlers[0]!({ toolName: "bash", input: { command } }), {});
  assert.equal(sent.length, 1);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ version: 1, defaultTarget: "origin", sleepReminderMinSeconds: 0 }));
  lifecycleHandlers.get("session_compact")!({}, ctx);
  assert.deepEqual(toolHandlers[0]!({ toolName: "bash", input: { command } }), {});
  assert.equal(sent.length, 1);
  fs.rmSync(path.join(dir, "config.json"));

  lifecycleHandlers.get("session_compact")!({}, ctx);
  assert.deepEqual(toolHandlers[0]!({ toolName: "bash", input: { command: "while true; do sleep 1; done" } }), {});
  assert.equal(sent.length, 2);
  lifecycleHandlers.get("session_start")!({ reason: "startup" }, ctx);
  assert.deepEqual(toolHandlers[0]!({ toolName: "bash", input: { command } }), {});
  assert.equal(sent.length, 3);
  assert.deepEqual(loadStore().jobs[0]?.message, "existing safe job");
  assert.doesNotMatch(fs.readFileSync(path.join(dir, "jobs.json"), "utf8"), /hostile-sleep-sentinel/);
  lifecycleHandlers.get("session_shutdown")!({ reason: "quit" }, ctx);
});

test("extension registers callback surfaces and slash commands operate on isolated store", async (t) => {
  useTempCallbacksDir(t);
  const commands = new Map<string, RegisteredCommand>();
  const tools: Array<{ name: string; parameters?: { properties?: { source?: { additionalProperties?: boolean }; coalesce?: unknown } } }> = [];
  const renderers: string[] = [];
  const listeners: string[] = [];
  const sentMessages: Array<{ customType?: string; content?: string }> = [];
  const nextTurnMessages: Array<{ customType?: string; content?: string }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const statusCalls: StatusCall[] = [];

  const pi = {
    registerMessageRenderer: (name: string) => { renderers.push(name); },
    on: (event: string) => { listeners.push(event); },
    registerTool: (tool: { name: string; parameters?: { properties?: { source?: { additionalProperties?: boolean }; coalesce?: unknown } } }) => { tools.push(tool); },
    registerCommand: (name: string, command: RegisteredCommand) => { commands.set(name, command); },
    sendMessage: (message: { customType?: string; content?: string }, options?: SendMessageOptions) => {
      if (options?.deliverAs === "nextTurn") nextTurnMessages.push(message);
      else sentMessages.push(message);
    },
    sendUserMessage: () => { throw new Error("sendUserMessage should not be called by command tests"); },
  };

  piCallbacks(pi as never);

  assert.deepEqual(renderers, ["pi-callbacks"]);
  assert.ok(listeners.includes("session_start"));
  assert.equal(tools.map((tool) => tool.name).join(","), "callbacks");
  assert.equal(tools[0]?.parameters?.properties?.source?.additionalProperties, false);
  assert.ok(tools[0]?.parameters?.properties?.coalesce, "poll schema exposes coalesce");
  assert.ok(commands.has("callbacks"));
  assert.ok(commands.has("callback-cancel"));
  assert.ok(commands.has("callback-delete"));

  const ctx: FakeContext = {
    cwd: process.cwd(),
    hasUI: true,
    sessionManager: { getSessionFile: () => "/tmp/session.json", getSessionId: () => "current-session-id" },
    ui: {
      notify: (message, level) => notifications.push({ message, level }),
      setStatus: (key, value) => { statusCalls.push({ key, value }); },
      setWidget: () => undefined,
    },
    isIdle: () => true,
  };

  const job = upsertJob(reminderJob());
  const otherJob = upsertJob(reminderJob({
    id: "rem_other_session",
    sessionFile: "/tmp/other-session.json",
    origin: { sessionId: "other-session-id", sessionFile: "/tmp/other-session.json", cwd: process.cwd() },
    message: "other session job",
  }));
  const terminalJob = upsertJob(reminderJob({
    id: "rem_current_completed",
    status: "completed",
    sessionFile: "/tmp/session.json",
    origin: { sessionId: "current-session-id", sessionFile: "/tmp/session.json", cwd: process.cwd() },
    message: "current terminal history",
  }));
  await commands.get("callbacks")!.handler("", ctx);
  assert.match(sentMessages.at(-1)?.content ?? "", /^1 callback job/m);
  assert.match(sentMessages.at(-1)?.content ?? "", /rem_extension/);
  assert.doesNotMatch(sentMessages.at(-1)?.content ?? "", /rem_other_session/);
  assert.match(sentMessages.at(-1)?.content ?? "", /timing: due/);
  assert.deepEqual(nextTurnMessages, [], "callback list should render immediately, not wait for the next user prompt");
  assert.equal(notifications.length, 0, "the rendered callback list should not be followed by a redundant toast");

  await commands.get("callbacks")!.handler("--all", ctx);
  assert.match(sentMessages.at(-1)?.content ?? "", /^2 callback jobs/m);
  assert.match(sentMessages.at(-1)?.content ?? "", /rem_extension/);
  assert.match(sentMessages.at(-1)?.content ?? "", /rem_other_session/);

  await commands.get("callbacks")!.handler("all", ctx);
  assert.match(sentMessages.at(-1)?.content ?? "", /^2 callback jobs/m);
  assert.match(sentMessages.at(-1)?.content ?? "", /rem_current_completed/);
  assert.doesNotMatch(sentMessages.at(-1)?.content ?? "", /rem_other_session/);

  await commands.get("callbacks")!.handler("--all --history", ctx);
  assert.match(sentMessages.at(-1)?.content ?? "", /^3 callback jobs/m);

  await commands.get("callback-cancel")!.handler(job.id, ctx);
  assert.equal(getJob(job.id)?.status, "cancelled");
  assert.match(notifications.at(-1)?.message ?? "", /Cancelled rem_extension/);

  await commands.get("callback-delete")!.handler(job.id, ctx);
  assert.equal(getJob(job.id), undefined);
  assert.ok(statusCalls.length > 0);
  assert.ok(statusCalls.every((call) => call.key === "caair.pi-callbacks/jobs"));
  removeJob(otherJob.id);
  removeJob(terminalJob.id);
  assert.deepEqual(listJobs(), []);
  assert.match(notifications.at(-1)?.message ?? "", /Deleted rem_extension/);
});

test("callbacks list scopes discarded origin jobs to the current session unless --all is used", async (t) => {
  useTempCallbacksDir(t);
  const otherOrigin: SessionPresence = {
    runtimeId: "runtime-reaped-other",
    sessionId: "reaped-other-session",
    sessionFile: "/tmp/reaped-other-session.jsonl",
    cwd: process.cwd(),
    pid: process.pid,
    startedAt: 1,
    lastSeenAt: 1,
    lastActiveAt: 1,
  };
  const currentOrigin: SessionPresence = {
    ...otherOrigin,
    runtimeId: "runtime-reaped-current",
    sessionId: "current-session-id",
    sessionFile: "/tmp/original-current-session.jsonl",
  };
  registerSessionPresence(otherOrigin);
  upsertJob(reminderJob({
    id: "reaped-other-origin",
    label: "other deploy watch",
    message: "Other session details",
    origin: otherOrigin,
    target: { kind: "origin" },
  }));
  closeSessionPresence(otherOrigin.runtimeId, true);
  registerSessionPresence(currentOrigin);
  upsertJob(reminderJob({
    id: "reaped-current-origin",
    label: "deploy watch",
    message: "Wait for the deploy to finish",
    origin: currentOrigin,
    target: { kind: "origin" },
  }));
  closeSessionPresence(currentOrigin.runtimeId, true);

  const commands = new Map<string, RegisteredCommand>();
  const sentMessages: Array<{ customType?: string; content?: string }> = [];
  const pi = {
    registerMessageRenderer: () => undefined,
    on: () => undefined,
    registerTool: () => undefined,
    registerCommand: (name: string, command: RegisteredCommand) => { commands.set(name, command); },
    sendMessage: (message: { customType?: string; content?: string }) => { sentMessages.push(message); },
    sendUserMessage: () => undefined,
  };
  piCallbacks(pi as never);
  const ctx: FakeContext = {
    cwd: process.cwd(),
    hasUI: false,
    sessionManager: { getSessionFile: () => "/tmp/resumed-current-session.jsonl", getSessionId: () => "current-session-id" },
    ui: { notify: () => undefined, setStatus: () => undefined, setWidget: () => undefined },
    isIdle: () => true,
  };

  await commands.get("callbacks")!.handler("", ctx);
  const currentText = sentMessages.at(-1)?.content ?? "";
  assert.match(currentText, /Discarded callback jobs \(1\) — re-arm if still needed:/);
  assert.match(currentText, /reaped-current-origin — deploy watch/);
  assert.match(currentText, /message: Wait for the deploy to finish/);
  assert.doesNotMatch(currentText, /reaped-other-origin|Other session details/);

  await commands.get("callbacks")!.handler("--all", ctx);
  const allText = sentMessages.at(-1)?.content ?? "";
  assert.match(allText, /Discarded callback jobs \(2\) — re-arm if still needed:/);
  assert.match(allText, /reaped-current-origin/);
  assert.match(allText, /reaped-other-origin — other deploy watch/);
});

test("session shutdown tears down delivery timers even when presence cleanup fails", async (t) => {
  const callbacksDir = useTempCallbacksDir(t);
  const handlers = new Map<string, (event: { reason?: string }, ctx: FakeContext) => void>();
  const pi = {
    registerMessageRenderer: () => undefined,
    on: (event: string, handler: (event: { reason?: string }, ctx: FakeContext) => void) => { handlers.set(event, handler); },
    registerTool: () => undefined,
    registerCommand: () => undefined,
    sendMessage: () => undefined,
    sendUserMessage: () => undefined,
  };
  const ctx: FakeContext = {
    cwd: process.cwd(),
    hasUI: false,
    sessionManager: { getSessionFile: () => "/tmp/shutdown-session.jsonl", getSessionId: () => "shutdown-session" },
    ui: { notify: () => undefined, setStatus: () => undefined, setWidget: () => undefined },
    isIdle: () => true,
  };
  piCallbacks(pi as never);
  handlers.get("session_start")!({ reason: "startup" }, ctx);
  await new Promise((resolve) => setTimeout(resolve, 100));

  fs.rmSync(callbacksDir, { recursive: true, force: true });
  fs.writeFileSync(callbacksDir, "block callback-state directory creation");
  const originalClearInterval = globalThis.clearInterval;
  let clearedIntervals = 0;
  globalThis.clearInterval = ((handle: Parameters<typeof clearInterval>[0]) => {
    clearedIntervals++;
    originalClearInterval(handle);
  }) as typeof clearInterval;
  try {
    assert.throws(
      () => handlers.get("session_shutdown")!({ reason: "quit" }, ctx),
      /EEXIST|ENOTDIR/,
    );
    assert.equal(clearedIntervals, 2, "delivery and heartbeat intervals are cleared in finally");
  } finally {
    globalThis.clearInterval = originalClearInterval;
    fs.rmSync(callbacksDir, { force: true });
    fs.mkdirSync(callbacksDir, { recursive: true });
  }
});
