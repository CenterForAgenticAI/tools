import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { loadCallbackConfig } from "./config.ts";
import { DEFAULT_HOST, DEFAULT_PORT, serverFile } from "./paths.ts";
import { claimPendingDesktopDeliveryEvents, claimPendingScriptJobForLaunch, cleanupStore, cleanupZombieSessions, DELIVERY_CLAIM_MS, listJobs, loadStore, markDeliveryEventDelivered, releaseDeliveryEventClaim, renewDeliveryEventClaim, updateJob, updateJobWithDelivery } from "./store.ts";
import type { CallbackConfig, CallbackJob, CallbackJobStatus, CheckInDetails, CheckInSchedulerDetails, DaemonHealth, DeliveryEvent, ExternalCallbackPayload, PollJob, PollResult, ScriptJob, ServerInfo } from "./types.ts";
import { executePollSource, isTerminalPollSourceStatus } from "./poll-sources.ts";
import { conditionMatches, describeDuration, summarizeResult, truncateMiddle } from "./utils.ts";

interface TimerState {
  timer?: NodeJS.Timeout;
  process?: ChildProcessWithoutNullStreams;
}

interface ActivePollGroup {
  pid: number;
  shutdownTimer?: NodeJS.Timeout;
}

interface SchedulerCheckInStatus {
  degraded: boolean;
  details: CheckInSchedulerDetails;
}

interface PollExecutionHooks {
  onSpawn: (pid: number) => void;
  onGroupExit: (pid: number) => void;
}

export interface CallbackDaemonOptions {
  now?: () => number;
  cleanupIntervalMs?: number;
  cleanupRetryMs?: number;
  cleanupStore?: (now: number) => void;
  isProcessAlive?: (pid: number) => boolean;
  desktopNotifier?: (event: DeliveryEvent) => Promise<void>;
  port?: number;
  pollTimeoutMs?: number;
  /** Test and embedding override; package config remains the normal source. */
  checkInIntervalMs?: number | null;
  checkInTriggerTurn?: boolean;
}

export const STORE_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
export const DEFAULT_POLL_TIMEOUT_MS = 30 * 1_000;
export const SCHEDULER_STALE_AFTER_MS = 3 * 1_000;
const STORE_CLEANUP_RETRY_MS = 60 * 1_000;

export class CallbackDaemon {
  private timers = new Map<string, TimerState>();
  private server?: http.Server;
  private reconcileTimer?: NodeJS.Timeout;
  private stopping = false;
  private nextCleanupAt?: number;
  private lastSchedulerTickAt?: number;
  private lastSchedulerErrorAt?: number;
  private lastSchedulerError?: string;
  private schedulerFailurePending = false;
  private runningPolls = new Set<string>();
  private overduePolls = new Map<string, number>();
  private activePollGroups = new Map<number, ActivePollGroup>();
  private stopPromise?: Promise<void>;
  private readonly options: CallbackDaemonOptions;
  private readonly desktopClaimant = `desktop-daemon:${process.pid}`;
  private desktopDrainInFlight = false;

  constructor(options: CallbackDaemonOptions = {}) {
    this.options = options;
  }

  start(): void {
    this.startServer();
    this.reconcile();
    this.reconcileTimer = setInterval(() => this.reconcile(), 1_000);
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    for (const state of this.timers.values()) {
      if (state.timer) clearTimeout(state.timer);
      // Leave script children alone on daemon shutdown; they can still use token callbacks.
    }
    this.timers.clear();
    this.server?.close();
    try {
      fs.unlinkSync(serverFile());
    } catch {
      // Ignore missing daemon state during shutdown.
    }
    const shutdowns = [...this.activePollGroups.entries()].map(([pid, group]) => this.stopPollGroup(pid, group));
    this.stopPromise = Promise.all(shutdowns).then(() => undefined);
    return this.stopPromise;
  }

  private stopPollGroup(pid: number, group: ActivePollGroup): Promise<void> {
    this.terminatePollGroup(pid, "SIGTERM");
    return new Promise((resolve) => {
      group.shutdownTimer = setTimeout(() => {
        this.terminatePollGroup(pid, "SIGKILL");
        this.activePollGroups.delete(pid);
        resolve();
      }, 250);
    });
  }

  private terminatePollGroup(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(pid, signal);
    } catch {
      // The group leader may have exited before shutdown reached it.
    }
    try {
      process.kill(-pid, signal);
    } catch {
      // The process group may already have exited.
    }
  }

  private registerPollGroup(pid: number): void {
    this.activePollGroups.set(pid, { pid });
    if (this.stopping) this.terminatePollGroup(pid, "SIGTERM");
  }

  private releasePollGroup(pid: number): void {
    const group = this.activePollGroups.get(pid);
    if (!group || group.shutdownTimer) return;
    this.activePollGroups.delete(pid);
  }

  private reconcile(): void {
    if (this.stopping) return;
    try {
      const now = this.currentTime();
      const config = this.callbackConfig();
      // Establish the persisted upgrade baseline before any cleanup path loads the store.
      loadStore({ now });
      cleanupZombieSessions({
        now,
        ...(this.options.isProcessAlive === undefined ? {} : { isProcessAlive: this.options.isProcessAlive }),
      });
      this.cleanupStoreIfDue();
      const store = loadStore();
      const jobs = store.jobs;
      const activeIds = new Set<string>();
      for (const job of jobs) {
        if (job.status === "pending" || job.status === "running") {
          activeIds.add(job.id);
          if (!this.timers.has(job.id)) this.schedule(job);
        }
      }
      this.updateSchedulerSnapshot(jobs, now);
      this.deliverDueCheckIns(jobs, now, config, store.checkInBaselineAt);
      for (const [id, state] of this.timers.entries()) {
        if (!activeIds.has(id)) {
          if (state.timer) clearTimeout(state.timer);
          if (state.process && !state.process.killed) state.process.kill("SIGTERM");
          this.timers.delete(id);
        }
      }
      this.lastSchedulerTickAt = now;
      this.schedulerFailurePending = false;
      void this.drainDesktopEvents().catch((error) => {
        console.error(`[pi-callbacks daemon] desktop event drain failed: ${this.errorMessage(error)}`);
      });
    } catch (error) {
      this.recordSchedulerFailure(error);
    }
  }

  private currentTime(): number {
    return (this.options.now ?? Date.now)();
  }

  private callbackConfig(): CallbackConfig {
    const config = loadCallbackConfig();
    return {
      ...config,
      checkInIntervalMs: this.options.checkInIntervalMs === undefined ? config.checkInIntervalMs : this.options.checkInIntervalMs,
      checkInTriggerTurn: this.options.checkInTriggerTurn ?? config.checkInTriggerTurn,
    };
  }

  private deliverDueCheckIns(jobs: CallbackJob[], now: number, config: CallbackConfig, checkInBaselineAt?: number): void {
    const intervalMs = config.checkInIntervalMs;
    if (intervalMs === null) return;
    const scheduler = this.schedulerCheckInStatus(now);
    for (const job of jobs) {
      if (!this.shouldCheckIn(job)) continue;
      const lastDeliveryAt = Math.max(job.createdAt, job.lastDeliveryAt ?? checkInBaselineAt ?? 0);
      if (now - lastDeliveryAt < intervalMs) continue;
      updateJobWithDelivery(job.id, (current, store) => {
        if (!this.shouldCheckIn(current)) return undefined;
        const currentLastDeliveryAt = Math.max(current.createdAt, current.lastDeliveryAt ?? store.checkInBaselineAt ?? 0);
        if (now - currentLastDeliveryAt < intervalMs) return undefined;
        const elapsedMs = Math.max(0, now - current.createdAt);
        const elapsed = describeDuration(elapsedMs);
        const runCount = current.kind === "poll"
          ? current.maxRuns === undefined ? `${current.runCount} (no maxRuns)` : `${current.runCount}/${current.maxRuns}`
          : undefined;
        const latestResult = current.kind === "poll" && current.lastResult?.matched === false ? current.lastResult : undefined;
        const checkInDetails: CheckInDetails = {
          schedulerDegraded: scheduler.degraded,
          elapsedMs,
          ...(runCount === undefined ? {} : { runCount }),
          ...(latestResult === undefined ? {} : { latestResult }),
          ...(scheduler.degraded ? { scheduler: scheduler.details } : {}),
        };
        const lines = scheduler.degraded
          ? [
            "Scheduler stalled: this is not a condition match, and this job's counters cannot be trusted as evidence of progress.",
            `Job ${current.id} (${current.kind}) has been waiting ${elapsed}.`,
            `Scheduler details: last successful tick ${this.describeSchedulerTick(scheduler.details.lastSuccessfulTickAgeMs)}; overdue polls: ${scheduler.details.overduePollCount}; current scheduler error: ${scheduler.details.error ?? "none pending"}.`,
            runCount === undefined ? undefined : `Job counters (not trusted while stalled): ${runCount}.`,
            latestResult === undefined ? undefined : `Most recent non-matching poll result:\n${summarizeResult(latestResult, 600)}.`,
            `This advisory notice is not a condition match. Recorded history: callbacks action="info" id=${current.id}`,
          ]
          : [
            `Status check-in (not a condition match): job ${current.id} (${current.kind}) has been waiting ${elapsed}.`,
            runCount === undefined ? undefined : `Runs: ${runCount}.`,
            latestResult === undefined ? undefined : `Most recent non-matching poll result:\n${summarizeResult(latestResult, 600)}.`,
            `This is an advisory status notice, not a condition match. Recorded history: callbacks action="info" id=${current.id}`,
          ];
        const message = scheduler.degraded
          ? "Periodic degraded scheduler check-in (not a condition match)"
          : "Periodic status check-in (not a condition match)";
        return {
          job: {
            ...current,
            events: [...current.events, { at: now, kind: "check-in" as const, message, details: checkInDetails }].slice(-50),
          } as CallbackJob,
          delivery: {
            kind: "check-in",
            body: lines.filter((line): line is string => line !== undefined).join("\n\n"),
            details: checkInDetails,
            triggerTurn: config.checkInTriggerTurn,
            at: now,
          },
        };
      });
    }
  }

  private shouldCheckIn(job: CallbackJob): boolean {
    return (job.status === "pending" || job.status === "running")
      && job.kind !== "reminder"
      && !(job.kind === "poll" && job.pushEachResult);
  }

  private schedulerCheckInStatus(now: number): SchedulerCheckInStatus {
    const overduePolls = [...this.overduePolls.entries()]
      .filter(([id]) => !this.runningPolls.has(id));
    const oldestOverduePollAt = overduePolls.length === 0
      ? undefined
      : Math.min(...overduePolls.map(([, nextRunAt]) => nextRunAt));
    const oldestOverduePollAgeMs = oldestOverduePollAt === undefined
      ? null
      : Math.max(0, now - oldestOverduePollAt);
    const lastSuccessfulTickAgeMs = this.lastSchedulerTickAt === undefined
      ? null
      : Math.max(0, now - this.lastSchedulerTickAt);
    return {
      degraded: this.schedulerFailurePending
        || (lastSuccessfulTickAgeMs !== null && lastSuccessfulTickAgeMs >= SCHEDULER_STALE_AFTER_MS)
        || (oldestOverduePollAgeMs !== null && oldestOverduePollAgeMs >= SCHEDULER_STALE_AFTER_MS),
      details: {
        lastSuccessfulTickAgeMs,
        overduePollCount: overduePolls.length,
        ...(this.schedulerFailurePending && this.lastSchedulerError !== undefined ? { error: truncateMiddle(this.lastSchedulerError, 400) } : {}),
      },
    };
  }

  private describeSchedulerTick(ageMs: number | null): string {
    return ageMs === null ? "never (no successful tick recorded)" : `${describeDuration(ageMs)} ago`;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private recordSchedulerFailure(error: unknown): void {
    this.lastSchedulerErrorAt = this.currentTime();
    this.lastSchedulerError = this.errorMessage(error);
    this.schedulerFailurePending = true;
    console.error(`[pi-callbacks daemon] scheduler reconciliation failed: ${this.lastSchedulerError}`);
  }

  private updateSchedulerSnapshot(jobs: CallbackJob[], now: number): void {
    this.overduePolls = new Map(
      jobs
        .filter((job): job is PollJob => (
          job.kind === "poll"
          && (job.status === "pending" || job.status === "running")
          && job.nextRunAt <= now
        ))
        .map((job) => [job.id, job.nextRunAt]),
    );
  }

  private daemonHealth(): DaemonHealth {
    const now = this.currentTime();
    const overduePolls = [...this.overduePolls.entries()]
      .filter(([id]) => !this.runningPolls.has(id));
    const oldestOverdueJobAt = overduePolls.length === 0
      ? undefined
      : Math.min(...overduePolls.map(([, nextRunAt]) => nextRunAt));
    const oldestOverdueJobAgeMs = oldestOverdueJobAt === undefined
      ? null
      : Math.max(0, now - oldestOverdueJobAt);
    const schedulerStale = this.lastSchedulerTickAt === undefined
      || now - this.lastSchedulerTickAt >= SCHEDULER_STALE_AFTER_MS;
    const overdueSchedulerStale = oldestOverdueJobAgeMs !== null
      && oldestOverdueJobAgeMs >= SCHEDULER_STALE_AFTER_MS;
    const schedulerFailed = this.schedulerFailurePending;
    return {
      ok: !schedulerStale && !overdueSchedulerStale && !schedulerFailed,
      daemon: "pi-callbacks",
      pid: process.pid,
      lastSchedulerTickAt: this.lastSchedulerTickAt ?? null,
      overdueJobCount: overduePolls.length,
      oldestOverdueJobAgeMs,
      schedulerStaleAfterMs: SCHEDULER_STALE_AFTER_MS,
      lastSchedulerErrorAt: this.lastSchedulerErrorAt ?? null,
      lastSchedulerError: this.lastSchedulerError ?? null,
    };
  }

  private cleanupStoreIfDue(): void {
    const now = (this.options.now ?? Date.now)();
    const intervalMs = this.options.cleanupIntervalMs ?? STORE_CLEANUP_INTERVAL_MS;
    if (this.nextCleanupAt !== undefined && now < this.nextCleanupAt) return;
    try {
      if (this.options.cleanupStore) this.options.cleanupStore(now);
      else cleanupStore({ now });
      this.nextCleanupAt = now + intervalMs;
    } catch (error) {
      this.nextCleanupAt = now + (this.options.cleanupRetryMs ?? STORE_CLEANUP_RETRY_MS);
      console.error(`[pi-callbacks daemon] store cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private schedule(job: CallbackJob): void {
    if (job.kind === "reminder") this.scheduleReminder(job);
    else if (job.kind === "poll") this.schedulePoll(job);
    else if (job.kind === "script") this.scheduleScript(job);
    // callback jobs are passive: delivered by HTTP/CLI token callback.
  }

  private scheduleReminder(job: Extract<CallbackJob, { kind: "reminder" }>): void {
    const delay = Math.max(0, job.dueAt - Date.now());
    const timer = setTimeout(() => {
      updateJobWithDelivery(job.id, (j) => {
        if (j.kind !== "reminder" || (j.status !== "pending" && j.status !== "running")) return undefined;
        const now = Date.now();
        const next: CallbackJob = {
          ...j,
          status: "completed",
          deliveredAt: now,
          events: [...j.events, { at: now, kind: "reminder" as const, message: j.message }].slice(-50),
        };
        return {
          job: next,
          delivery: { kind: "reminder", body: `Reminder fired: ${next.message}` },
        };
      });
      this.timers.delete(job.id);
    }, delay);
    this.timers.set(job.id, { timer });
  }

  private schedulePoll(job: PollJob): void {
    const delay = Math.max(0, job.nextRunAt - Date.now());
    const timer = setTimeout(() => void this.runPoll(job.id), delay);
    this.timers.set(job.id, { timer });
  }

  private async runPoll(id: string): Promise<void> {
    if (this.stopping) return;
    const job = listJobs().find((candidate): candidate is PollJob => candidate.id === id && candidate.kind === "poll");
    if (!job || job.status === "cancelled" || job.status === "completed" || job.status === "failed") {
      this.timers.delete(id);
      return;
    }

    this.runningPolls.add(id);
    let result: PollResult;
    try {
      result = await executePoll(job, this.options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS, {
        onSpawn: (pid) => this.registerPollGroup(pid),
        onGroupExit: (pid) => this.releasePollGroup(pid),
      });
      // Generation is recorded after the source has produced its final result,
      // separately from the durable delivery-event queue timestamp.
      result = { ...result, at: this.currentTime() };
    } finally {
      this.runningPolls.delete(id);
    }
    if (this.stopping) return;
    const sourceStatus = job.source === undefined ? undefined : result.status;
    const monitoringFailure = job.source !== undefined && sourceStatus === undefined;
    const sourceTerminal = sourceStatus !== undefined && isTerminalPollSourceStatus(sourceStatus);
    const matched = monitoringFailure
      ? false
      : job.source === undefined
        ? conditionMatches(job.condition, result)
        : sourceStatus === "success" && conditionMatches(job.condition, result);
    result.matched = matched;
    const updated = updateJobWithDelivery(job.id, (current) => {
      if (this.stopping) return undefined;
      if (current.kind !== "poll" || (current.status !== "pending" && current.status !== "running")) return undefined;
      const exhausted = current.maxRuns !== undefined && current.runCount + 1 >= current.maxRuns;
      const sourceTerminalFailure = current.source !== undefined && sourceTerminal && sourceStatus !== "success";
      const sourceNeutralTerminal = current.source !== undefined
        && sourceTerminal
        && sourceStatus !== "success"
        && sourceStatus !== "failed";
      const nextStatus: CallbackJobStatus = matched
        ? "completed"
        : sourceNeutralTerminal
          ? "completed"
          : sourceTerminalFailure || exhausted
            ? "failed"
            : "pending";
      const monitoringFailureHeadline = exhausted
        ? "Poll monitoring failed and poll exhausted"
        : "Poll monitoring failed; job remains pending";
      const sourceTerminalHeadline = sourceStatus === "failed"
        ? "GitLab pipeline failed"
        : sourceStatus === "success"
          ? "Poll condition matched"
          : `GitLab pipeline reached terminal status ${sourceStatus}`;
      const eventMessage = monitoringFailure
        ? "Poll monitoring failed"
        : sourceTerminal
          ? sourceTerminalHeadline
          : matched
            ? "Poll condition matched"
            : exhausted ? "Poll exhausted" : "Poll checked";
      const next: PollJob = {
        ...current,
        status: nextStatus,
        runCount: current.runCount + 1,
        nextRunAt: Date.now() + current.intervalMs,
        lastResult: result,
        ...(matched
          ? { deliveredAt: Date.now() }
          : current.deliveredAt === undefined ? {} : { deliveredAt: current.deliveredAt }),
        events: [...current.events, { at: Date.now(), kind: "poll" as const, message: eventMessage, details: result }].slice(-50),
      };
      if (!next.pushEachResult && !matched && !exhausted && !sourceTerminal && !monitoringFailure) return { job: next };
      const headline = monitoringFailure
        ? monitoringFailureHeadline
        : sourceTerminal
          ? sourceTerminalHeadline
          : matched
            ? "Poll condition matched"
            : exhausted
              ? "Poll exhausted without a match"
              : "Poll condition did not match; job remains pending";
      return {
        job: next,
        delivery: {
          kind: monitoringFailure
            ? exhausted ? "failed" : "poll"
            : sourceStatus === "failed" || exhausted && !matched ? "failed" : "poll",
          body: `${headline}: ${next.message}\n\n${summarizeResult(result)}`,
          details: result,
          generatedAt: result.at,
        },
      };
    });
    this.overduePolls.delete(id);
    if (!updated || updated.kind !== "poll") return;

    this.timers.delete(updated.id);
    if (!this.stopping && updated.status === "pending") this.schedulePoll(updated);
  }

  private scheduleScript(job: ScriptJob): void {
    if (job.status === "running") {
      updateJobWithDelivery(job.id, (current) => {
        if (current.kind !== "script" || current.status !== "running") return undefined;
        const message = "Daemon restarted while script was running; original process cannot be reattached. Use token callback from scripts for restart-safe completion.";
        const failed: ScriptJob = {
          ...current,
          status: "failed",
          completedAt: Date.now(),
          events: [...current.events, { at: Date.now(), kind: "failed" as const, message }].slice(-50),
        };
        return {
          job: failed,
          delivery: { kind: "failed", body: `Background script status unknown after daemon restart: ${failed.message}` },
        };
      });
      return;
    }
    this.startScript(job.id);
  }

  private startScript(id: string): void {
    const job = claimPendingScriptJobForLaunch(id);
    if (!job) return;
    const child = spawn(job.command, { shell: true, cwd: job.cwd, env: { ...process.env, PI_CALLBACK_TOKEN: job.token ?? "", PI_CALLBACK_JOB_ID: job.id } });
    this.timers.set(job.id, { process: child });
    let stdout = "";
    let stderr = "";
    const record = () => {
      updateJob(job.id, (current) => current.kind === "script" && current.status === "running"
        ? {
            ...current,
            ...(child.pid === undefined ? {} : { pid: child.pid }),
            stdoutTail: truncateMiddle(stdout, 4000),
            stderrTail: truncateMiddle(stderr, 4000),
          }
        : current);
    };
    child.stdout.on("data", (chunk) => { stdout += String(chunk); stdout = stdout.slice(-20_000); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); stderr = stderr.slice(-20_000); });
    child.on("spawn", record);
    child.on("error", (error) => {
      updateJobWithDelivery(job.id, (current) => {
        if (current.kind !== "script" || (current.status !== "pending" && current.status !== "running")) return undefined;
        const failed: ScriptJob = {
          ...current,
          status: "failed",
          completedAt: Date.now(),
          stderrTail: truncateMiddle(`${stderr}\n${error.message}`, 4000),
          events: [...current.events, { at: Date.now(), kind: "failed" as const, message: error.message }].slice(-50),
        };
        return {
          job: failed,
          delivery: {
            kind: "failed",
            body: `Background script failed to start: ${failed.message}\n\n${error.message}`,
            details: { error: error.message },
          },
        };
      });
    });
    child.on("close", (code, signal) => {
      const latest = listJobs().find((candidate) => candidate.id === job.id);
      if (latest && latest.status !== "running" && latest.status !== "pending") {
        this.timers.delete(job.id);
        return;
      }
      updateJobWithDelivery(job.id, (current) => {
        if (current.kind !== "script" || (current.status !== "pending" && current.status !== "running")) return undefined;
        const script: ScriptJob = {
          ...current,
          status: code === 0 ? "completed" : "failed",
          completedAt: Date.now(),
          exitCode: code,
          signal,
          stdoutTail: truncateMiddle(stdout, 4000),
          stderrTail: truncateMiddle(stderr, 4000),
          deliveredAt: Date.now(),
          events: [...current.events, { at: Date.now(), kind: "script-exit" as const, message: `Script exited code=${code} signal=${signal ?? ""}`, details: { code, signal } }].slice(-50),
        };
        const body = `Background script ${code === 0 ? "completed" : "failed"}: ${script.message}\n\nexit=${code} signal=${signal ?? "none"}\n\nstdout:\n${script.stdoutTail || "(empty)"}\n\nstderr:\n${script.stderrTail || "(empty)"}`;
        return {
          job: script,
          delivery: { kind: code === 0 ? "script-exit" : "failed", body, details: { code, signal, stdoutTail: script.stdoutTail, stderrTail: script.stderrTail } },
        };
      });
      this.timers.delete(job.id);
    });
    record();
  }

  private async drainDesktopEvents(): Promise<void> {
    if (this.desktopDrainInFlight) return;
    this.desktopDrainInFlight = true;
    try {
      const notify = this.options.desktopNotifier ?? notifyDesktop;
      while (!this.stopping) {
        const [event] = claimPendingDesktopDeliveryEvents(this.desktopClaimant, { limit: 1 });
        if (!event) break;
        const renewal = setInterval(() => {
          renewDeliveryEventClaim(event.id, this.desktopClaimant);
        }, Math.floor(DELIVERY_CLAIM_MS / 2));
        renewal.unref();
        try {
          const deliveredAt = this.currentTime();
          await notify(decoratePollDeliveryEvent(event, deliveredAt));
          markDeliveryEventDelivered(event.id, this.desktopClaimant, deliveredAt);
        } catch (error) {
          releaseDeliveryEventClaim(event.id, this.desktopClaimant);
          console.error(`[pi-callbacks daemon] desktop notification failed: ${error instanceof Error ? error.message : String(error)}`);
          break;
        } finally {
          clearInterval(renewal);
        }
      }
    } finally {
      this.desktopDrainInFlight = false;
    }
  }

  private callback(payload: ExternalCallbackPayload): CallbackJob | undefined {
    const job = handleExternalCallbackPayload(payload);
    if (job && payload.complete !== false) {
      const state = this.timers.get(job.id);
      if (state?.timer) clearTimeout(state.timer);
      // Do not kill a running script that invoked its own callback; let it exit naturally.
      this.timers.delete(job.id);
    }
    return job;
  }

  private startServer(): void {
    if (this.server) return;
    const server = http.createServer((req, res) => { void this.handleHttp(req, res); });
    server.on("error", (error: NodeJS.ErrnoException) => {
      console.error(`[pi-callbacks daemon] server error: ${error.message}`);
      void this.stop().finally(() => process.exit(1));
    });
    server.listen(this.options.port ?? DEFAULT_PORT, DEFAULT_HOST, () => this.writeServerInfo(server));
    this.server = server;
  }

  private writeServerInfo(server: http.Server): void {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : DEFAULT_PORT;
    const info: ServerInfo = { version: 1, pid: process.pid, port, host: DEFAULT_HOST, startedAt: Date.now() };
    const file = serverFile();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(info, null, 2), { mode: 0o600 });
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (req.method === "GET" && req.url === "/health") {
        const health = this.daemonHealth();
        res.writeHead(health.ok ? 200 : 503, { "content-type": "application/json" });
        res.end(JSON.stringify(health));
        return;
      }
      if (req.method !== "POST" || req.url !== "/callback") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "not found" }));
        return;
      }
      const payload = JSON.parse(await readRequest(req)) as ExternalCallbackPayload;
      if (!payload.token) throw new Error("Missing token");
      const job = this.callback(payload);
      if (!job) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "unknown token" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, id: job.id, status: job.status }));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
  }
}

export function runDaemon(): void {
  const daemon = new CallbackDaemon();
  daemon.start();
  const stop = () => {
    void daemon.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function executePoll(job: PollJob, timeoutMs = DEFAULT_POLL_TIMEOUT_MS, hooks?: PollExecutionHooks): Promise<PollResult> {
  const at = Date.now();
  const timeoutMessage = `Poll timed out after ${timeoutMs}ms`;
  if (job.source) {
    return executePollSource(job.source, timeoutMs, hooks);
  }
  if (job.url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(job.url, { method: job.method || "GET", signal: controller.signal });
      const text = await response.text();
      return { at, ok: response.ok, statusCode: response.status, text: truncateMiddle(text, 8000), matched: false };
    } catch (error) {
      const timedOut = controller.signal.aborted;
      return { at, ok: false, error: timedOut ? timeoutMessage : error instanceof Error ? error.message : String(error), matched: false };
    } finally {
      clearTimeout(timeout);
    }
  }
  if (job.command) {
    return new Promise((resolve) => {
      const child = spawn(job.command!, { shell: true, cwd: job.cwd, detached: true });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let groupReleased = false;
      let escalationTimer: NodeJS.Timeout | undefined;
      const childPid = child.pid;
      const releaseGroup = (): void => {
        if (groupReleased) return;
        groupReleased = true;
        if (childPid !== undefined) hooks?.onGroupExit(childPid);
      };
      if (childPid !== undefined) hooks?.onSpawn(childPid);
      const terminate = (signal: NodeJS.Signals): void => {
        try {
          child.kill(signal);
        } catch {
          // The child may have exited between the timeout and the kill.
        }
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, signal);
          } catch {
            // The process group may already have exited after killing the child.
          }
        }
      };
      const clearEscalation = (): void => {
        if (escalationTimer) clearTimeout(escalationTimer);
        escalationTimer = undefined;
      };
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        terminate("SIGTERM");
        escalationTimer = setTimeout(() => {
          terminate("SIGKILL");
          escalationTimer = undefined;
          releaseGroup();
        }, 250);
        resolve({ at, ok: false, stdout: truncateMiddle(stdout, 8000), stderr: truncateMiddle(stderr, 8000), error: timeoutMessage, matched: false });
      }, timeoutMs);
      const finish = (result: PollResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearEscalation();
        releaseGroup();
        resolve(result);
      };
      child.stdout.on("data", (chunk) => { stdout += String(chunk); stdout = stdout.slice(-20_000); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); stderr = stderr.slice(-20_000); });
      child.on("error", (error) => { finish({ at, ok: false, error: error.message, matched: false }); });
      child.on("close", (code) => {
        finish({
          at,
          ok: code === 0,
          ...(code === null ? {} : { exitCode: code }),
          stdout: truncateMiddle(stdout, 8000),
          stderr: truncateMiddle(stderr, 8000),
          matched: false,
        });
      });
    });
  }
  return { at, ok: false, error: "Poll job has neither command nor url", matched: false };
}

function handleExternalCallbackPayload(payload: ExternalCallbackPayload): CallbackJob | undefined {
  return updateJobWithDelivery(payload.token, (current) => {
    if (current.status === "cancelled") return undefined;
    const message = payload.message || current.message || "External callback fired";
    const status: CallbackJobStatus = payload.complete === false ? current.status : payload.status === "failure" ? "failed" : "completed";
    const job = {
      ...current,
      status,
      completedAt: payload.complete === false ? ("completedAt" in current ? current.completedAt : undefined) : Date.now(),
      events: [...current.events, { at: Date.now(), kind: "external-callback", message, details: payload.details }].slice(-50),
    } as CallbackJob;
    return {
      job,
      delivery: {
        kind: payload.status === "failure" ? "failed" : "external-callback",
        body: formatCallbackBody(job, payload.message || job.message, payload.details),
        details: payload.details,
      },
    };
  });
}

function formatCallbackBody(job: CallbackJob, message: string, details?: unknown): string {
  const parts = [`External callback fired for ${job.id}: ${message}`];
  if (details !== undefined) parts.push(`details:\n${typeof details === "string" ? details : JSON.stringify(details, null, 2)}`);
  return parts.join("\n\n");
}

function decoratePollDeliveryEvent(event: DeliveryEvent, deliveredAt: number): DeliveryEvent {
  if (!isPollResultEvent(event)) return event;
  const generatedAt = event.generatedAt ?? event.at;
  const freshness = [
    `generated=${new Date(generatedAt).toISOString()}`,
    `delivered=${new Date(deliveredAt).toISOString()}`,
    `queued=${new Date(event.at).toISOString()}`,
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

function isPollResultEvent(event: DeliveryEvent): event is DeliveryEvent & { jobSnapshot: PollJob } {
  return (event.kind === "poll" || event.kind === "failed") && event.jobSnapshot.kind === "poll";
}

function notifyDesktop(event: DeliveryEvent): Promise<void> {
  if (process.platform !== "darwin") {
    return Promise.reject(new Error("desktop callback targets are supported only on macOS"));
  }
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/osascript", [
      "-e", "on run argv",
      "-e", "display notification (item 2 of argv) with title (item 1 of argv)",
      "-e", "end run",
      "pi-callbacks",
      event.body.slice(0, 1_000),
    ]);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`osascript exited ${code}: ${stderr.trim()}`));
    });
  });
}

function readRequest(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("error", reject);
    req.on("end", () => resolve(body));
  });
}
