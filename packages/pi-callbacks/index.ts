import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attemptBackgroundStoreOperation } from "./src/background-store.ts";
import { ensureDaemon, type DaemonStatus as EnsuredDaemonStatus } from "./src/daemon-control.ts";
import { preflightPollSource, projectPollSource } from "./src/poll-sources.ts";
import { loadCallbackConfig } from "./src/config.ts";
import { detectLiteralSleep } from "./src/sleep-reminder.ts";
import { appendJobEvent, claimPendingDeliveryEvents, closeSessionPresence, getJob, isActiveJob, jobOwnedBySession, listJobs, listPendingDeliveryEvents, listPendingDeliveryEventsOwnedBy, listReapedJobs, listReapedJobsOwnedBy, markDeliveryEventDelivered, registerSessionPresence, releaseDeliveryEventClaim, removeJob, touchSessionPresence, updateJob, upsertJob } from "./src/store.ts";
import { parseDeliveryTarget } from "./src/targets.ts";
import type { CallbackJob, DeliveryEvent, DeliveryMode, DeliveryTarget, ExternalCallbackJob, PollJob, ReapedJob, ReminderJob, ScriptJob, SessionPresence, SessionRef } from "./src/types.ts";
import { createJobWidgetLoop, updateJobWidget } from "./src/job-widget.ts";
import { createCallbacksServiceV1, provideCallbacksServiceV1 } from "./src/callbacks-service.ts";
import { formatJobBlock, newId, newToken, parseCondition, parseDuration, safeJson } from "./src/utils.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.join(__dirname, "bin", "pi-callbacks.ts");
const DEFAULT_ENDPOINT = "http://127.0.0.1:47837/callback";

const TOOL_SCHEMA = Type.Object({
  action: StringEnum(["remind", "poll", "script", "callback", "list", "cancel", "delete", "info"] as const),
  id: Type.Optional(Type.String({ description: "Job id or callback token for cancel/delete/info." })),
  message: Type.Optional(Type.String({ description: "Message to inject when the callback fires." })),
  label: Type.Optional(Type.String({ description: "Short human-readable label." })),
  delay: Type.Optional(Type.String({ description: "Reminder delay, e.g. 5m, 30s, 1h." })),
  interval: Type.Optional(Type.String({ description: "Poll interval, e.g. 10s, 2m." })),
  command: Type.Optional(Type.String({ description: "Shell command for poll or background script." })),
  url: Type.Optional(Type.String({ description: "URL to poll with fetch." })),
  source: Type.Optional(Type.Object({
    kind: Type.Literal("gitlab_pipeline"),
    host: Type.String({ description: "GitLab host, e.g. gitlab.com." }),
    project: Type.String({ description: "GitLab project path, e.g. group/project." }),
    pipelineId: Type.Number({ description: "GitLab pipeline number." }),
  }, { additionalProperties: false, description: "Named source to poll." })),
  condition: Type.Optional(Type.String({ description: "Poll condition: contains:text, regex:pat, not_contains:text, exit:0, status:200, any, always." })),
  maxRuns: Type.Optional(Type.Number({ description: "Maximum poll attempts before failing." })),
  pushEachResult: Type.Optional(Type.Boolean({ description: "For poll jobs, inject every condition-check result so the agent can react to failures/non-matches. Defaults true; set false to only inject matches/exhaustion." })),
  coalesce: Type.Optional(Type.Boolean({ description: "For poll jobs, while the consumer is busy retain only the newest unclaimed result. Defaults false to preserve ordered delivery." })),
  delivery: Type.Optional(StringEnum(["custom", "user", "notify-only"] as const)),
  triggerTurn: Type.Optional(Type.Boolean({ description: "For custom messages, trigger a new agent turn when idle. Defaults true." })),
  includeCompleted: Type.Optional(Type.Boolean({ description: "For list, include completed/cancelled/failed jobs." })),
  allSessions: Type.Optional(Type.Boolean({ description: "For list, include jobs from every Pi session. Defaults to the current session." })),
  target: Type.Optional(StringEnum(["origin", "latest-active", "latest-active-cwd", "session", "desktop"] as const, { description: "Delivery destination. Defaults to the package configuration, then origin." })),
  targetSession: Type.Optional(Type.String({ description: "Exact session id or session file path when target=session." })),
});

type ToolInput = Static<typeof TOOL_SCHEMA>;

let sessionFile: string | undefined;
let disposeCallbacksService = () => {};
let deliveryInterval: NodeJS.Timeout | undefined;
let activeContext: ExtensionContext | undefined;
type DaemonStatus = "starting" | "running" | "degraded" | "daemon down" | "store busy" | "stopped";

const STATUS_KEY = "caair.pi-callbacks/jobs";
const MAX_STATUS_COUNT = 99;

let daemonStatus: DaemonStatus = "starting";
let sessionGeneration = 0;
let sessionActive = false;
let deliveryPausedReason: string | undefined;
let activePresence: SessionPresence | undefined;
let heartbeatInterval: NodeJS.Timeout | undefined;
const jobWidgetLoop = createJobWidgetLoop();
let storeContentionCount = 0;
let storeRetryNotBefore = 0;

const HEARTBEAT_INTERVAL_MS = 30_000;
const STORE_RETRY_BASE_MS = 750;
const STORE_RETRY_MAX_MS = 30_000;

export default function piCallbacks(pi: ExtensionAPI) {
  let sleepReminderSent = false;

  pi.registerMessageRenderer("pi-callbacks", (message, { expanded }, theme) => {
    const details = message.details as { id?: string; kind?: string; status?: string } | undefined;
    const status = details?.status ?? "callback";
    const color = status === "failed" ? "error" : status === "cancelled" ? "warning" : "success";
    const header = `${theme.fg(color, theme.bold("[callback]"))} ${message.content}`;
    let text = header;
    if (expanded && details) text += `\n${theme.fg("dim", safeJson(details))}`;
    const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(text, 0, 0));
    return box;
  });

  pi.on("session_start", (_event, ctx) => {
    sleepReminderSent = false;
    disposeCallbacksService();
    disposeCallbacksService = () => {};
    if (pi.events) {
      disposeCallbacksService = provideCallbacksServiceV1(pi.events, createCallbacksServiceV1(currentSessionRef(ctx)));
    }
    startDeliveryLoop(pi, ctx, { ensureDaemonHealthy: true });
  });

  pi.on("session_compact", (_event, ctx) => {
    sleepReminderSent = false;
    refreshDeliveryContext(pi, ctx);
  });

  pi.on("tool_call", (event) => {
    try {
      if (event.toolName !== "bash") return {};
      const command = event.input.command;
      if (typeof command !== "string") return {};
      const detection = detectLiteralSleep(command);
      if (detection === undefined || sleepReminderSent) return {};
      const config = loadCallbackConfig();
      if (config.sleepReminderMinSeconds === null) return {};
      const qualifies = detection.hasPositiveLoopSleep
        || (detection.maxNonLoopSeconds !== undefined && detection.maxNonLoopSeconds >= config.sleepReminderMinSeconds);
      if (!qualifies) return {};
      pi.sendMessage({
        customType: "pi-callbacks",
        content: "For a longer wait, use callbacks instead of keeping the bash command asleep.",
        display: true,
      }, { triggerTurn: false });
      sleepReminderSent = true;
    } catch {
      // Advisory failures must never affect bash execution.
    }
    return {};
  });

  pi.on("session_tree", (_event, ctx) => {
    refreshDeliveryContext(pi, ctx);
  });

  pi.on("before_agent_start", (_event, ctx) => {
    refreshDeliveryContext(pi, ctx);
  });

  pi.on("input", (_event, ctx) => {
    refreshDeliveryContext(pi, ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    refreshDeliveryContext(pi, ctx);
  });

  pi.on("session_shutdown", (event) => {
    try {
      if (activePresence) {
        attemptBackgroundStoreOperation(() => (
          closeSessionPresence(activePresence!.runtimeId, event.reason !== "reload")
        ));
      }
    } finally {
      disposeCallbacksService();
      disposeCallbacksService = () => {};
      stopDeliveryLoop();
      daemonStatus = "stopped";
    }
  });

  pi.registerTool({
    name: "callbacks",
    label: "Callbacks",
    description: "Create persistent reminders, polling checks (including named GitLab pipeline sources), background scripts, and token-based external callbacks through a central pi-callbacks daemon. Outputs are truncated when long.",
    promptSnippet: "Create/list/cancel reminders, command/URL/source polling checks, background scripts, and external callback tokens.",
    promptGuidelines: [
      "Use callbacks when the user asks the agent to wait, remind them later, watch for a condition, or run a background task that should wake the agent on completion.",
      "Prefer callbacks over ad-hoc polling loops or background shell scripts when a later event should reprompt or steer the agent.",
      "Poll callbacks deliver every condition-check result by default, including non-matches and command/URL/source monitoring failures. Set pushEachResult: false only when the agent should stay asleep until the condition matches or maxRuns is exhausted; a wrong or unsatisfiable condition is a real expected failure, and periodic check-ins surface that wait.",
      "Set coalesce: true when a busy consumer should keep only the newest unclaimed poll result and report how many older results were dropped; the default false preserves ordered delivery.",
      "For a GitLab pipeline source, use source.kind=gitlab_pipeline with host, project, and pipelineId; glab must be installed and logged in, and source fetch failures are monitoring failures rather than pipeline verdicts.",
      "For external scripts, use callbacks action=callback to mint a token and pass the returned curl or pi-callbacks command into the script so it can push completion back into the agent context.",
    ],
    parameters: TOOL_SCHEMA,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      daemonStatus = displayDaemonStatus(await ensureDaemon(BIN_PATH));
      const result = handleAction(ctx, params);
      safeUpdateStatus(ctx);
      return { content: [{ type: "text", text: result.text }], details: result.details };
    },
  });

  pi.registerCommand("callbacks", {
    description: "List callbacks for this session. Use --all for every session and --history for terminal history.",
    handler: async (args, ctx) => {
      const flags = parseListFlags(args);
      if (flags.unknown.length > 0) {
        safeNotify(ctx, undefined, `Unknown /callbacks option: ${flags.unknown.join(" ")}. Usage: /callbacks [--all] [--history]`, "warning");
        return;
      }
      const result = formatJobList({
        includeCompleted: flags.includeCompleted,
        allSessions: flags.allSessions,
        session: currentSessionRef(ctx),
      });
      pi.sendMessage({ customType: "pi-callbacks", content: result.text, display: true, details: { action: "list", allSessions: flags.allSessions } }, { triggerTurn: false });
    },
  });

  pi.registerCommand("remind-in", {
    description: "Schedule a reminder. Usage: /remind-in <duration> <message>",
    handler: async (args, ctx) => {
      const [delay, ...rest] = args.trim().split(/\s+/);
      if (!delay || rest.length === 0) {
        safeNotify(ctx, undefined, "Usage: /remind-in <duration> <message>", "warning");
        return;
      }
      daemonStatus = displayDaemonStatus(await ensureDaemon(BIN_PATH));
      const result = handleAction(ctx, { action: "remind", delay, message: rest.join(" ") });
      safeUpdateStatus(ctx);
      safeNotify(ctx, undefined, result.text, "info");
    },
  });

  pi.registerCommand("callback-token", {
    description: "Mint a token-based external callback. Usage: /callback-token [message]",
    handler: async (args, ctx) => {
      daemonStatus = displayDaemonStatus(await ensureDaemon(BIN_PATH));
      const result = handleAction(ctx, { action: "callback", message: args.trim() || "External callback" });
      safeUpdateStatus(ctx);
      pi.sendMessage({ customType: "pi-callbacks", content: result.text, display: true, details: result.details }, { triggerTurn: false });
      safeNotify(ctx, undefined, "Callback token created", "info");
    },
  });

  pi.registerCommand("callback-cancel", {
    description: "Cancel a callback job. Usage: /callback-cancel <id-or-token>",
    handler: async (args, ctx) => {
      const id = args.trim();
      if (!id) {
        safeNotify(ctx, undefined, "Usage: /callback-cancel <id-or-token>", "warning");
        return;
      }
      const result = handleAction(ctx, { action: "cancel", id });
      safeUpdateStatus(ctx);
      safeNotify(ctx, undefined, result.text, "info");
    },
  });

  pi.registerCommand("callback-delete", {
    description: "Delete a callback job. Usage: /callback-delete <id-or-token>",
    handler: async (args, ctx) => {
      const id = args.trim();
      if (!id) {
        safeNotify(ctx, undefined, "Usage: /callback-delete <id-or-token>", "warning");
        return;
      }
      const result = handleAction(ctx, { action: "delete", id });
      safeUpdateStatus(ctx);
      safeNotify(ctx, undefined, result.text, "info");
    },
  });
}

function displayDaemonStatus(status: EnsuredDaemonStatus): Exclude<DaemonStatus, "starting" | "store busy" | "stopped"> {
  return status === "down" ? "daemon down" : status;
}

function startDeliveryLoop(pi: ExtensionAPI, ctx: ExtensionContext, options?: { ensureDaemonHealthy?: boolean }): void {
  if (deliveryInterval) clearInterval(deliveryInterval);
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  jobWidgetLoop.stop();
  if (activePresence) {
    attemptBackgroundStoreOperation(() => closeSessionPresence(activePresence!.runtimeId, false));
  }
  const generation = ++sessionGeneration;
  sessionActive = true;
  activeContext = ctx;
  sessionFile = ctx.sessionManager.getSessionFile();
  deliveryPausedReason = undefined;
  storeContentionCount = 0;
  storeRetryNotBefore = 0;
  const now = Date.now();
  const proposedPresence: SessionPresence = {
    ...currentSessionRef(ctx),
    runtimeId: newId("runtime"),
    pid: process.pid,
    startedAt: now,
    lastSeenAt: now,
    lastActiveAt: now,
  };
  const registration = attemptBackgroundStoreOperation(() => registerSessionPresence(proposedPresence));
  activePresence = registration.ok ? registration.value : proposedPresence;
  if (!registration.ok) noteStoreContention(ctx, generation);

  if (options?.ensureDaemonHealthy) {
    void ensureDaemon(BIN_PATH).then((status) => {
      if (!isCurrentSession(generation)) return;
      daemonStatus = displayDaemonStatus(status);
      safeUpdateStatus(ctx, generation);
      if (status === "down") safeNotify(ctx, generation, "pi-callbacks daemon did not become reachable; callbacks may not fire", "warning");
    });
  }

  deliveryInterval = setInterval(() => safeDrainDeliveryEvents(pi, generation), 750);
  heartbeatInterval = setInterval(() => {
    if (isCurrentSession(generation) && activePresence) {
      activePresence = safeTouchSessionPresence(ctx, generation, activePresence) ?? activePresence;
    }
  }, HEARTBEAT_INTERVAL_MS);
  safeDrainDeliveryEvents(pi, generation);
  safeUpdateStatus(ctx, generation);
  if (ctx.hasUI) {
    jobWidgetLoop.start(() => {
      const current = activeContext;
      if (current) safeUpdateJobWidget(current, generation);
    });
  }
}

function refreshDeliveryContext(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const nextSessionFile = ctx.sessionManager.getSessionFile();
  if (sessionActive && deliveryInterval && sessionFile === nextSessionFile) {
    activeContext = ctx;
    deliveryPausedReason = undefined;
    if (activePresence) {
      activePresence = safeTouchSessionPresence(ctx, sessionGeneration, activePresence, { active: true }) ?? activePresence;
    }
    safeDrainDeliveryEvents(pi, sessionGeneration);
    safeUpdateStatus(ctx, sessionGeneration);
    return;
  }
  startDeliveryLoop(pi, ctx);
}

function stopDeliveryLoop(): void {
  sessionActive = false;
  sessionGeneration++;
  jobWidgetLoop.stop();
  if (deliveryInterval) clearInterval(deliveryInterval);
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  deliveryInterval = undefined;
  heartbeatInterval = undefined;
  activeContext = undefined;
  activePresence = undefined;
  sessionFile = undefined;
  deliveryPausedReason = undefined;
}

function pauseDeliveryLoop(generation?: number): void {
  if (generation !== undefined && !isCurrentSession(generation)) return;
  if (deliveryInterval) clearInterval(deliveryInterval);
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  jobWidgetLoop.stop();
  deliveryInterval = undefined;
  heartbeatInterval = undefined;
  activeContext = undefined;
  deliveryPausedReason = "delivery paused until a fresh session context is available";
}

export function handleAction(ctx: ExtensionContext, params: unknown): { text: string; details?: unknown } {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("callback action parameters must be an object");
  }
  const candidate = params as { coalesce?: unknown };
  const coalesce = candidate.coalesce;
  if (coalesce !== undefined && typeof coalesce !== "boolean") {
    throw new Error("coalesce must be a boolean");
  }
  return handleActionInternal(ctx, params as ToolInput, coalesce);
}

function handleActionInternal(ctx: ExtensionContext, params: ToolInput, coalesce: boolean | undefined): { text: string; details?: unknown } {
  switch (params.action) {
    case "remind": return createReminder(ctx, params);
    case "poll": return createPoll(ctx, params, coalesce);
    case "script": return createScript(ctx, params);
    case "callback": return createCallback(ctx, params);
    case "list": {
      const result = formatJobList({
        includeCompleted: Boolean(params.includeCompleted),
        allSessions: Boolean(params.allSessions),
        session: currentSessionRef(ctx),
      });
      return { text: result.text, details: { jobs: result.jobs, pendingDeliveryEvents: result.pendingDeliveryEvents, reapedJobs: result.reapedJobs } };
    }
    case "cancel": {
      if (!params.id) throw new Error("cancel requires id");
      const job = updateJob(params.id, (current) => ({
        ...current,
        status: "cancelled",
        events: [...current.events, { at: Date.now(), kind: "cancelled", message: "Cancelled" }].slice(-50),
      } as CallbackJob));
      if (!job) throw new Error(`No callback job found for ${params.id}`);
      return { text: `Cancelled ${job.id}`, details: job };
    }
    case "delete": {
      if (!params.id) throw new Error("delete requires id");
      appendJobEvent(params.id, "cancelled", "Deleted");
      const job = removeJob(params.id);
      if (!job) throw new Error(`No callback job found for ${params.id}`);
      return { text: `Deleted ${job.id}`, details: job };
    }
    case "info": {
      if (!params.id) throw new Error("info requires id");
      const job = getJob(params.id);
      if (!job) throw new Error(`No callback job found for ${params.id}`);
      const pendingDeliveryEvents = listPendingDeliveryEvents().filter((event) => event.jobId === job.id);
      const details = { job, pendingDeliveryEvents };
      return { text: safeJson(details), details };
    }
  }
}

function createReminder(ctx: ExtensionContext, params: ToolInput): { text: string; details: ReminderJob } {
  if (!params.delay) throw new Error("remind requires delay");
  const now = Date.now();
  const scope = jobScope(ctx, params);
  const job: ReminderJob = {
    id: newId("rem"), kind: "reminder", status: "pending", createdAt: now, updatedAt: now,
    ...(scope.origin.sessionFile === undefined ? {} : { sessionFile: scope.origin.sessionFile }), cwd: scope.origin.cwd, origin: scope.origin, target: scope.target,
    ...(params.label === undefined ? {} : { label: params.label }),
    message: params.message || `Reminder after ${params.delay}`, delivery: delivery(params.delivery), triggerTurn: params.triggerTurn ?? true,
    dueAt: now + parseDuration(params.delay), events: [{ at: now, kind: "created", message: "Reminder created" }],
  };
  upsertJob(job);
  return { text: `Scheduled reminder ${job.id} for ${new Date(job.dueAt).toLocaleString()}`, details: job };
}

function createPoll(ctx: ExtensionContext, params: ToolInput, coalesce: boolean | undefined): { text: string; details: PollJob } {
  if (!params.command && !params.url && !params.source) throw new Error("poll requires command, url, or source");
  const source = params.source === undefined ? undefined : projectPollSource(params.source);
  if (source) preflightPollSource(source);
  const now = Date.now();
  const pollLabel = params.command || params.url || (source ? `${source.host}/${source.project} pipeline ${source.pipelineId}` : "named source");
  const intervalMs = parseDuration(params.interval || "30s");
  const scope = jobScope(ctx, params);
  const job: PollJob = {
    id: newId("poll"), kind: "poll", status: "pending", createdAt: now, updatedAt: now,
    ...(scope.origin.sessionFile === undefined ? {} : { sessionFile: scope.origin.sessionFile }), cwd: scope.origin.cwd, origin: scope.origin, target: scope.target,
    ...(params.label === undefined ? {} : { label: params.label }),
    message: params.message || `Poll ${pollLabel}`, delivery: delivery(params.delivery), triggerTurn: params.triggerTurn ?? true,
    intervalMs, nextRunAt: now,
    ...(params.command === undefined ? {} : { command: params.command }),
    ...(params.url === undefined ? {} : { url: params.url }),
    ...(source === undefined ? {} : { source }),
    condition: parseCondition(params.condition),
    ...(params.maxRuns === undefined ? {} : { maxRuns: params.maxRuns }),
    runCount: 0, pushEachResult: params.pushEachResult ?? true, coalesce: coalesce ?? false,
    events: [{ at: now, kind: "created", message: "Poll created" }],
  };
  upsertJob(job);
  return { text: `Scheduled poll ${job.id} every ${params.interval || "30s"} until condition matches`, details: job };
}

function createScript(ctx: ExtensionContext, params: ToolInput): { text: string; details: ScriptJob } {
  if (!params.command) throw new Error("script requires command");
  const now = Date.now();
  const scope = jobScope(ctx, params);
  const job: ScriptJob = {
    id: newId("script"), kind: "script", status: "pending", createdAt: now, updatedAt: now,
    ...(scope.origin.sessionFile === undefined ? {} : { sessionFile: scope.origin.sessionFile }), cwd: scope.origin.cwd, origin: scope.origin, target: scope.target,
    ...(params.label === undefined ? {} : { label: params.label }),
    message: params.message || `Script completed: ${params.command}`, delivery: delivery(params.delivery), triggerTurn: params.triggerTurn ?? true,
    token: newToken(), endpoint: DEFAULT_ENDPOINT, command: params.command, events: [{ at: now, kind: "created", message: "Script created" }],
  };
  upsertJob(job);
  return { text: `Queued background script ${job.id}. The daemon will run it; PI_CALLBACK_TOKEN is available to the process for explicit callbacks.`, details: job };
}

function createCallback(ctx: ExtensionContext, params: ToolInput): { text: string; details: ExternalCallbackJob & { curl: string; cli: string; endpoint: string } } {
  const now = Date.now();
  const token = newToken();
  const endpoint = DEFAULT_ENDPOINT;
  const scope = jobScope(ctx, params);
  const job: ExternalCallbackJob = {
    id: newId("cb"), kind: "callback", status: "pending", createdAt: now, updatedAt: now,
    ...(scope.origin.sessionFile === undefined ? {} : { sessionFile: scope.origin.sessionFile }), cwd: scope.origin.cwd, origin: scope.origin, target: scope.target,
    ...(params.label === undefined ? {} : { label: params.label }),
    message: params.message || "External callback", delivery: delivery(params.delivery), triggerTurn: params.triggerTurn ?? true,
    token, endpoint, events: [{ at: now, kind: "created", message: "External callback token created" }],
  };
  upsertJob(job);
  const curl = `curl -sS -X POST ${shellQuote(endpoint)} -H 'content-type: application/json' --data ${shellQuote(JSON.stringify({ token, message: "done", status: "success" }))}`;
  const cli = `node ${shellQuote(BIN_PATH)} callback --token ${shellQuote(token)} --message ${shellQuote("done")}`;
  return { text: `Created external callback ${job.id}.\n\nToken: ${token}\nEndpoint: ${endpoint}\n\nShell hook:\n${curl}\n\nCLI hook:\n${cli}`, details: { ...job, curl, cli, endpoint } };
}

function safeDrainDeliveryEvents(pi: ExtensionAPI, generation: number): void {
  if (!isCurrentSession(generation) || Date.now() < storeRetryNotBefore) return;
  const ctx = activeContext;
  if (!ctx) return;
  try {
    const attempt = attemptBackgroundStoreOperation(() => drainDeliveryEvents(pi, ctx, generation));
    if (!attempt.ok) {
      noteStoreContention(ctx, generation);
      return;
    }
    clearStoreContention(ctx, generation);
  } catch (error) {
    if (isStaleContextError(error)) {
      pauseDeliveryLoop(generation);
      return;
    }
    throw error;
  }
}

function safeTouchSessionPresence(
  ctx: ExtensionContext,
  generation: number,
  presence: SessionPresence,
  options: { active?: boolean } = {},
): SessionPresence | undefined {
  const attempt = attemptBackgroundStoreOperation(() => {
    const touched = touchSessionPresence(presence.runtimeId, options);
    if (touched) return touched;
    const now = Date.now();
    const { staleSince: _staleSince, ...restored } = presence;
    return registerSessionPresence({
      ...restored,
      lastSeenAt: now,
      lastActiveAt: options.active ? now : presence.lastActiveAt,
    });
  });
  if (!attempt.ok) {
    noteStoreContention(ctx, generation);
    return undefined;
  }
  clearStoreContention(ctx, generation);
  return attempt.value;
}

function noteStoreContention(ctx: ExtensionContext, generation: number): void {
  storeContentionCount++;
  const exponential = STORE_RETRY_BASE_MS * (2 ** Math.min(storeContentionCount - 1, 8));
  const jitter = process.pid % 251;
  storeRetryNotBefore = Date.now() + Math.min(STORE_RETRY_MAX_MS, exponential) + jitter;
  daemonStatus = "store busy";
  safeUpdateStatus(ctx, generation);
}

function clearStoreContention(ctx: ExtensionContext, generation: number): void {
  if (storeContentionCount === 0) return;
  storeContentionCount = 0;
  storeRetryNotBefore = 0;
  if (daemonStatus === "store busy") daemonStatus = "running";
  safeUpdateStatus(ctx, generation);
}

function drainDeliveryEvents(pi: ExtensionAPI, ctx: ExtensionContext, generation: number): void {
  if (!isCurrentSession(generation)) return;
  const presence = activePresence;
  if (!presence) return;
  const idle = safeIsIdle(ctx, generation);
  if (idle === undefined) return;
  const events = claimPendingDeliveryEvents(presence, { consumerIdle: idle });
  for (const [index, event] of events.entries()) {
    if (!isCurrentSession(generation)) {
      releaseUnprocessedDeliveryClaims(events, index, presence.runtimeId);
      return;
    }
    let deliveredAt: number | "busy" | false;
    try {
      deliveredAt = deliver(pi, ctx, event, generation);
    } catch (error) {
      releaseUnprocessedDeliveryClaims(events, index, presence.runtimeId);
      throw error;
    }
    if (deliveredAt === false) {
      releaseUnprocessedDeliveryClaims(events, index, presence.runtimeId);
      return;
    }
    if (deliveredAt === "busy") {
      releaseDeliveryEventClaim(event.id, presence.runtimeId);
      continue;
    }
    markDeliveryEventDelivered(event.id, presence.runtimeId, deliveredAt);
  }
  safeUpdateStatus(ctx, generation);
}

function releaseUnprocessedDeliveryClaims(events: DeliveryEvent[], startIndex: number, runtimeId: string): void {
  for (const event of events.slice(startIndex)) releaseDeliveryEventClaim(event.id, runtimeId);
}

function deliver(pi: ExtensionAPI, ctx: ExtensionContext, event: DeliveryEvent, generation?: number): number | "busy" | false {
  if (generation !== undefined && !isCurrentSession(generation)) return false;
  const job = event.jobSnapshot;
  try {
    if (job.delivery === "notify-only") {
      const deliveredAt = Date.now();
      const presented = decoratePollDeliveryEvent(event, deliveredAt);
      return safeNotify(ctx, generation, presented.body.slice(0, 400), job.status === "failed" ? "error" : "info")
        ? deliveredAt
        : false;
    }
    const idle = safeIsIdle(ctx, generation);
    if (idle === undefined) return false;
    if (isCoalescingConversationDelivery(event) && !idle) return "busy";
    const deliveredAt = Date.now();
    const presented = decoratePollDeliveryEvent(event, deliveredAt);
    if (job.delivery === "user") {
      if (idle) pi.sendUserMessage(presented.body);
      else pi.sendUserMessage(presented.body, { deliverAs: "followUp" });
      return deliveredAt;
    }
    pi.sendMessage({
      customType: "pi-callbacks",
      content: presented.body,
      display: true,
      details: {
        id: job.id,
        eventId: event.id,
        kind: job.kind,
        status: job.status,
        label: job.label,
        payload: event.details,
        ...pollDeliveryDetails(event, deliveredAt),
      },
    }, { triggerTurn: event.triggerTurn ?? job.triggerTurn, deliverAs: idle ? "steer" : "followUp" });
    return deliveredAt;
  } catch (error) {
    if (isStaleContextError(error)) {
      pauseDeliveryLoop(generation);
      return false;
    }
    throw error;
  }
}

function isPollResultEvent(event: DeliveryEvent): event is DeliveryEvent & { jobSnapshot: PollJob } {
  return (event.kind === "poll" || event.kind === "failed") && event.jobSnapshot.kind === "poll";
}

function isCoalescingConversationDelivery(event: DeliveryEvent): boolean {
  return isPollResultEvent(event)
    && event.jobSnapshot.kind === "poll"
    && event.jobSnapshot.coalesce === true
    && event.target?.kind !== "desktop"
    && event.jobSnapshot.delivery !== "notify-only";
}

function pollDeliveryDetails(event: DeliveryEvent, deliveredAt: number): Record<string, string | number> {
  if (!isPollResultEvent(event)) return {};
  return {
    generatedAt: new Date(event.generatedAt ?? event.at).toISOString(),
    deliveredAt: new Date(deliveredAt).toISOString(),
    queuedAt: new Date(event.at).toISOString(),
    ...(event.droppedResults === undefined ? {} : { droppedResults: event.droppedResults }),
  };
}

function decoratePollDeliveryEvent(event: DeliveryEvent, deliveredAt: number): DeliveryEvent {
  if (!isPollResultEvent(event)) return event;
  const details = pollDeliveryDetails(event, deliveredAt);
  const freshness = [
    `generated=${details.generatedAt}`,
    `delivered=${details.deliveredAt}`,
    `queued=${details.queuedAt}`,
    ...(event.droppedResults === undefined ? [] : [`dropped=${event.droppedResults}`]),
  ].join(" ");
  const warning = deliveredAt - (event.backlogStartedAt ?? event.at) > 3 * event.jobSnapshot.intervalMs
    ? "Warning: consumer is not keeping up; this delivery warning is not a condition match."
    : undefined;
  return {
    ...event,
    body: [freshness, warning, event.body].filter((line): line is string => line !== undefined).join("\n\n"),
  };
}

interface JobListOptions {
  includeCompleted: boolean;
  allSessions: boolean;
  session: SessionRef;
}

interface JobListResult {
  text: string;
  jobs: CallbackJob[];
  pendingDeliveryEvents: DeliveryEvent[];
  reapedJobs: ReapedJob[];
}

function formatJobList(options: JobListOptions): JobListResult {
  const reapedJobs = options.allSessions
    ? listReapedJobs()
    : listReapedJobsOwnedBy(options.session);
  const pendingDeliveryEvents = options.allSessions
    ? listPendingDeliveryEvents()
    : listPendingDeliveryEventsOwnedBy(options.session);
  const pendingByJob = new Map<string, number>();
  for (const event of pendingDeliveryEvents) {
    pendingByJob.set(event.jobId, (pendingByJob.get(event.jobId) ?? 0) + 1);
  }
  const jobs = listJobs()
    .filter((job) => options.allSessions || jobOwnedBySession(job, options.session))
    .filter((job) => options.includeCompleted || job.status === "pending" || job.status === "running" || pendingByJob.has(job.id));
  const discardedText = formatReapedJobs(reapedJobs);
  if (jobs.length === 0) {
    const scope = options.allSessions ? "" : " for this session";
    const emptyText = options.includeCompleted ? `No callback jobs${scope}.` : `No pending callback jobs or deliveries${scope}.`;
    return {
      text: discardedText ? `${emptyText}\n\n${discardedText}` : emptyText,
      jobs,
      pendingDeliveryEvents,
      reapedJobs,
    };
  }
  const now = Date.now();
  const header = `${jobs.length} callback job${jobs.length === 1 ? "" : "s"}`;
  const blocks = jobs.map((job) => formatJobBlock(job, {
    now,
    pendingDeliveries: pendingByJob.get(job.id) ?? 0,
    showScope: options.allSessions,
  }));
  const sections = [`${header}\n\n${blocks.join("\n\n")}`];
  if (discardedText) sections.push(discardedText);
  return { text: sections.join("\n\n"), jobs, pendingDeliveryEvents, reapedJobs };
}

function formatReapedJobs(records: ReapedJob[]): string {
  if (records.length === 0) return "";
  const header = `Discarded callback jobs (${records.length}) — re-arm if still needed:`;
  const blocks = records.map((record) => {
    const title = record.label ? `${record.id} — ${record.label}` : record.id;
    const reason = record.reason === "session-crashed"
      ? "origin session expired after a crash"
      : "origin session ended";
    return `${title}\n  reason: ${reason}\n  message: ${record.message.replace(/\n/g, "\n    ")}`;
  });
  return `${header}\n\n${blocks.join("\n\n")}`;
}

function safeUpdateStatus(ctx: ExtensionContext, generation?: number): boolean {
  try {
    updateStatus(ctx, generation);
    safeUpdateJobWidget(ctx, generation);
    return true;
  } catch (error) {
    if (isStaleContextError(error)) {
      pauseDeliveryLoop(generation);
      return false;
    }
    throw error;
  }
}

function updateStatus(ctx: ExtensionContext, generation?: number): void {
  if (generation !== undefined && !isCurrentSession(generation)) return;
  const session = currentSessionRef(ctx);
  const activeJobs = listJobs().filter((job) => isActiveJob(job) && jobOwnedBySession(job, session));
  const pendingDeliveries = listPendingDeliveryEventsOwnedBy(session).length;
  if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, formatStatusSummary(daemonStatus, activeJobs.length, pendingDeliveries, Boolean(deliveryPausedReason)));
}

function safeUpdateJobWidget(ctx: ExtensionContext, generation?: number): boolean {
  if (generation !== undefined && !isCurrentSession(generation)) return false;
  try {
    updateJobWidget(ctx);
    return true;
  } catch (error) {
    if (isStaleContextError(error)) {
      pauseDeliveryLoop(generation);
      return false;
    }
    throw error;
  }
}

export function formatStatusSummary(
  status: DaemonStatus,
  activeJobCount: number,
  pendingDeliveryCount: number,
  deliveryPaused: boolean,
): string | undefined {
  if (status !== "running") {
    const label = status === "daemon down" || status === "store busy" ? status : `daemon ${status}`;
    return `callbacks: ${label}`;
  }

  const parts: string[] = [];
  if (activeJobCount > 0) parts.push(`${boundedStatusCount(activeJobCount)} active`);
  if (pendingDeliveryCount > 0) {
    parts.push(`${boundedStatusCount(pendingDeliveryCount)} ${pendingDeliveryCount === 1 ? "delivery" : "deliveries"}`);
  }
  if (deliveryPaused) parts.push("delivery paused");
  return parts.length > 0 ? `callbacks: ${parts.join(" · ")}` : undefined;
}

function boundedStatusCount(count: number): string {
  return count > MAX_STATUS_COUNT ? `${MAX_STATUS_COUNT}+` : String(Math.max(0, Math.floor(count)));
}

function currentSessionRef(ctx: ExtensionContext): SessionRef {
  const sessionFile = ctx.sessionManager.getSessionFile();
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    ...(sessionFile === undefined ? {} : { sessionFile }),
    cwd: ctx.cwd,
  };
}

function jobScope(ctx: ExtensionContext, params: ToolInput): { origin: SessionRef; target: DeliveryTarget } {
  if (params.target !== "session" && params.targetSession) {
    throw new Error("targetSession is only valid when target=session");
  }
  const target = parseDeliveryTarget(params.target, params.targetSession) ?? loadCallbackConfig().defaultTarget;
  if (target.kind === "desktop" && process.platform !== "darwin") {
    throw new Error("target=desktop is currently supported only on macOS");
  }
  return { origin: currentSessionRef(ctx), target };
}

function parseListFlags(args: string): { allSessions: boolean; includeCompleted: boolean; unknown: string[] } {
  const tokens = args.trim() ? args.trim().split(/\s+/) : [];
  const known = new Set(["--all", "--history", "--completed", "all"]);
  return {
    allSessions: tokens.includes("--all"),
    includeCompleted: tokens.includes("--history") || tokens.includes("--completed") || tokens.includes("all"),
    unknown: tokens.filter((token) => !known.has(token)),
  };
}

function safeNotify(ctx: ExtensionContext, generation: number | undefined, message: string, level: "info" | "warning" | "error"): boolean {
  if (generation !== undefined && !isCurrentSession(generation)) return false;
  try {
    if (ctx.hasUI) ctx.ui.notify(message, level);
    return true;
  } catch (error) {
    if (isStaleContextError(error)) {
      pauseDeliveryLoop(generation);
      return false;
    }
    throw error;
  }
}

function safeIsIdle(ctx: ExtensionContext, generation?: number): boolean | undefined {
  if (generation !== undefined && !isCurrentSession(generation)) return undefined;
  try {
    return ctx.isIdle();
  } catch (error) {
    if (isStaleContextError(error)) {
      pauseDeliveryLoop(generation);
      return undefined;
    }
    throw error;
  }
}

function isCurrentSession(generation: number): boolean {
  return sessionActive && generation === sessionGeneration;
}

function isStaleContextError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("ctx is stale after session replacement or reload");
}

function delivery(input: DeliveryMode | undefined): DeliveryMode {
  return input || "custom";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
