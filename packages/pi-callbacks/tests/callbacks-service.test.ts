import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import {
  CALLBACKS_SERVICE_DISCOVERY_EVENT,
  CALLBACKS_SERVICE_PROTOCOL_VERSION,
  createCallbacksServiceV1,
  discoverCallbacksServiceV1,
  provideCallbacksServiceV1,
} from "../src/callbacks-service.ts";
import piCallbacks from "../index.ts";
import { upsertJob } from "../src/store.ts";
import type { ExternalCallbackJob, PollJob, ReminderJob, ScriptJob, SessionRef } from "../src/types.ts";

interface FakeEvents {
  events: EventBus;
  emit(value: unknown): void;
  activeRegistrationCount(): number;
  disposeCount(): number;
}

function fakeEvents(): FakeEvents {
  const listeners = new Set<(value: unknown) => void>();
  let disposedCount = 0;
  const events = {
    on(event: string, next: (value: unknown) => void): () => void {
      assert.equal(event, CALLBACKS_SERVICE_DISCOVERY_EVENT);
      listeners.add(next);
      return () => {
        if (listeners.delete(next)) disposedCount++;
      };
    },
    emit(event: string, value: unknown): void {
      assert.equal(event, CALLBACKS_SERVICE_DISCOVERY_EVENT);
      for (const listener of listeners) listener(value);
    },
  } as unknown as EventBus;
  return {
    events,
    emit(value: unknown): void {
      events.emit(CALLBACKS_SERVICE_DISCOVERY_EVENT, value);
    },
    activeRegistrationCount: () => listeners.size,
    disposeCount: () => disposedCount,
  };
}

type LifecycleHandler = (event: { reason?: string }, ctx: FakeExtensionContext) => void;

interface FakeExtensionContext {
  cwd: string;
  hasUI: boolean;
  sessionManager: {
    getSessionFile: () => string | undefined;
    getSessionId: () => string;
  };
  ui: {
    notify: (message: string, level: "info" | "warning" | "error") => void;
    setStatus: (key: string, value: string | undefined) => void;
  };
  isIdle: () => boolean;
}

function fakeExtensionContext(session: SessionRef): FakeExtensionContext {
  return {
    cwd: session.cwd,
    hasUI: false,
    sessionManager: {
      getSessionFile: () => session.sessionFile,
      getSessionId: () => session.sessionId,
    },
    ui: {
      notify: () => undefined,
      setStatus: () => undefined,
    },
    isIdle: () => true,
  };
}

function fakeExtensionPi(events?: EventBus): {
  pi: { on: (event: string, handler: LifecycleHandler) => void; events?: EventBus };
  handlers: Map<string, LifecycleHandler>;
} {
  const handlers = new Map<string, LifecycleHandler>();
  const pi = {
    registerMessageRenderer: () => undefined,
    on: (event: string, handler: LifecycleHandler) => { handlers.set(event, handler); },
    registerTool: () => undefined,
    registerCommand: () => undefined,
    sendMessage: () => undefined,
    sendUserMessage: () => undefined,
    ...(events === undefined ? {} : { events }),
  };
  return { pi, handlers };
}

function useTempCallbacksDir(t: test.TestContext): void {
  const previous = process.env.PI_CALLBACKS_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-callbacks-service-test-"));
  process.env.PI_CALLBACKS_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CALLBACKS_DIR;
    else process.env.PI_CALLBACKS_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

const currentSession: SessionRef = {
  sessionId: "current-session",
  sessionFile: "/tmp/current-session.jsonl",
  cwd: "/tmp/project",
};

const otherSession: SessionRef = {
  sessionId: "other-session",
  sessionFile: "/tmp/other-session.jsonl",
  cwd: "/tmp/project",
};

function reminderJob(id: string, session: SessionRef, dueAt: number, status: ReminderJob["status"] = "pending"): ReminderJob {
  return {
    id,
    kind: "reminder",
    status,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...(session.sessionFile === undefined ? {} : { sessionFile: session.sessionFile }),
    origin: session,
    cwd: session.cwd,
    message: id,
    delivery: "custom",
    triggerTurn: true,
    dueAt,
    events: [],
  };
}

function pollJob(id: string, session: SessionRef, nextRunAt: number): PollJob {
  return {
    id,
    kind: "poll",
    status: "pending",
    createdAt: 1_000,
    updatedAt: 1_000,
    ...(session.sessionFile === undefined ? {} : { sessionFile: session.sessionFile }),
    origin: session,
    cwd: session.cwd,
    message: id,
    delivery: "custom",
    triggerTurn: true,
    intervalMs: 1_000,
    nextRunAt,
    command: "true",
    condition: { type: "always" },
    runCount: 0,
    pushEachResult: true,
    events: [],
  };
}

function scriptJob(id: string, session: SessionRef): ScriptJob {
  return {
    id,
    kind: "script",
    status: "running",
    createdAt: 1_000,
    updatedAt: 1_000,
    ...(session.sessionFile === undefined ? {} : { sessionFile: session.sessionFile }),
    origin: session,
    cwd: session.cwd,
    message: id,
    delivery: "custom",
    triggerTurn: true,
    command: "sleep 1",
    events: [],
  };
}

function callbackJob(id: string, session: SessionRef): ExternalCallbackJob {
  return {
    id,
    kind: "callback",
    status: "pending",
    createdAt: 1_000,
    updatedAt: 1_000,
    ...(session.sessionFile === undefined ? {} : { sessionFile: session.sessionFile }),
    origin: session,
    cwd: session.cwd,
    message: id,
    delivery: "custom",
    triggerTurn: true,
    token: `token-${id}`,
    events: [],
  };
}

test("a session with no jobs has an empty pending-work summary", (t) => {
  useTempCallbacksDir(t);
  assert.deepEqual(createCallbacksServiceV1(currentSession).pendingWorkSummary(), {
    count: 0,
    openEndedCount: 0,
  });
});

test("timed jobs report the earliest reminder or poll due time as ISO 8601", (t) => {
  useTempCallbacksDir(t);
  upsertJob(reminderJob("later-reminder", currentSession, 5_000));
  upsertJob(pollJob("earlier-poll", currentSession, 3_000));

  assert.deepEqual(createCallbacksServiceV1(currentSession).pendingWorkSummary(), {
    count: 2,
    nextDueAt: new Date(3_000).toISOString(),
    openEndedCount: 0,
  });
});

test("open-ended jobs are counted without a next due time", (t) => {
  useTempCallbacksDir(t);
  upsertJob(scriptJob("running-script", currentSession));
  upsertJob(callbackJob("waiting-callback", currentSession));

  assert.deepEqual(createCallbacksServiceV1(currentSession).pendingWorkSummary(), {
    count: 2,
    openEndedCount: 2,
  });
});

test("a mixed session reports both open-ended and earliest timed work", (t) => {
  useTempCallbacksDir(t);
  upsertJob(reminderJob("later-reminder", currentSession, 5_000));
  upsertJob(pollJob("earlier-poll", currentSession, 3_000));
  upsertJob(scriptJob("running-script", currentSession));
  upsertJob(callbackJob("waiting-callback", currentSession));

  assert.deepEqual(createCallbacksServiceV1(currentSession).pendingWorkSummary(), {
    count: 4,
    nextDueAt: new Date(3_000).toISOString(),
    openEndedCount: 2,
  });
});

test("jobs owned by another session are excluded", (t) => {
  useTempCallbacksDir(t);
  upsertJob(reminderJob("other-session-job", otherSession, 3_000));
  upsertJob(scriptJob("current-session-job", currentSession));

  assert.deepEqual(createCallbacksServiceV1(currentSession).pendingWorkSummary(), {
    count: 1,
    openEndedCount: 1,
  });
});

test("terminal jobs are excluded", (t) => {
  useTempCallbacksDir(t);
  upsertJob(reminderJob("completed", currentSession, 3_000, "completed"));
  upsertJob(reminderJob("cancelled", currentSession, 4_000, "cancelled"));
  upsertJob(reminderJob("failed", currentSession, 5_000, "failed"));

  assert.deepEqual(createCallbacksServiceV1(currentSession).pendingWorkSummary(), {
    count: 0,
    openEndedCount: 0,
  });
});

test("extension lifecycle registers and disposes the pending-work provider", (t) => {
  useTempCallbacksDir(t);
  const eventBus = fakeEvents();
  const { pi, handlers } = fakeExtensionPi(eventBus.events);
  piCallbacks(pi as never);
  const context = fakeExtensionContext(currentSession);

  handlers.get("session_start")!({}, context);
  const service = discoverCallbacksServiceV1(eventBus.events, "test-consumer");
  assert.ok(service);
  assert.deepEqual(service.pendingWorkSummary(), { count: 0, openEndedCount: 0 });

  handlers.get("session_shutdown")!({ reason: "quit" }, context);
  assert.equal(discoverCallbacksServiceV1(eventBus.events, "test-consumer"), undefined);
});

test("extension lifecycle disposes the old provider before rebinding to a new session", (t) => {
  useTempCallbacksDir(t);
  upsertJob(reminderJob("current-session-job", currentSession, 5_000));
  upsertJob(reminderJob("other-session-job", otherSession, 6_000));

  const eventBus = fakeEvents();
  const { pi, handlers } = fakeExtensionPi(eventBus.events);
  piCallbacks(pi as never);
  const currentContext = fakeExtensionContext(currentSession);
  const otherContext = fakeExtensionContext(otherSession);

  handlers.get("session_start")!({}, currentContext);
  const currentService = discoverCallbacksServiceV1(eventBus.events, "test-consumer");
  assert.ok(currentService);
  assert.deepEqual(currentService.pendingWorkSummary(), {
    count: 1,
    nextDueAt: new Date(5_000).toISOString(),
    openEndedCount: 0,
  });

  handlers.get("session_start")!({}, otherContext);
  assert.equal(eventBus.disposeCount(), 1, "the previous provider registration was disposed");
  assert.equal(eventBus.activeRegistrationCount(), 1, "rebinding leaves exactly one provider registration");
  const otherService = discoverCallbacksServiceV1(eventBus.events, "test-consumer");
  assert.ok(otherService);
  assert.notEqual(otherService, currentService);
  assert.deepEqual(otherService.pendingWorkSummary(), {
    count: 1,
    nextDueAt: new Date(6_000).toISOString(),
    openEndedCount: 0,
  });

  handlers.get("session_shutdown")!({ reason: "quit" }, otherContext);
  assert.equal(discoverCallbacksServiceV1(eventBus.events, "test-consumer"), undefined);
  assert.equal(eventBus.activeRegistrationCount(), 0);
});

test("extension lifecycle is safe when the event bus is absent", (t) => {
  useTempCallbacksDir(t);
  const eventBus = fakeEvents();
  const { pi, handlers } = fakeExtensionPi();
  piCallbacks(pi as never);
  const context = fakeExtensionContext(currentSession);

  assert.doesNotThrow(() => handlers.get("session_start")!({}, context));
  assert.equal(eventBus.activeRegistrationCount(), 0);
  assert.equal(discoverCallbacksServiceV1(eventBus.events, "test-consumer"), undefined);

  handlers.get("session_shutdown")!({ reason: "quit" }, context);
});

test("discovery returns nothing without a provider and validates requests", () => {
  const noProvider = fakeEvents();
  assert.equal(discoverCallbacksServiceV1(noProvider.events, "consumer"), undefined);

  const registered = fakeEvents();
  const service = createCallbacksServiceV1(currentSession);
  let acceptedMalformed = false;
  const dispose = provideCallbacksServiceV1(registered.events, service);
  registered.emit({
    protocolVersion: CALLBACKS_SERVICE_PROTOCOL_VERSION + 1,
    consumerId: "consumer",
    accept: () => { acceptedMalformed = true; },
  });
  registered.emit({
    protocolVersion: CALLBACKS_SERVICE_PROTOCOL_VERSION,
    consumerId: " ",
    accept: () => { acceptedMalformed = true; },
  });
  registered.emit({ protocolVersion: CALLBACKS_SERVICE_PROTOCOL_VERSION, consumerId: "consumer" });
  assert.equal(acceptedMalformed, false);
  assert.equal(discoverCallbacksServiceV1(registered.events, "consumer"), service);
  dispose();
  assert.equal(discoverCallbacksServiceV1(registered.events, "consumer"), undefined);
});
