export type CallbackJobKind = "reminder" | "poll" | "script" | "callback";
export type CallbackJobStatus = "pending" | "running" | "completed" | "cancelled" | "failed";
export type DeliveryMode = "custom" | "user" | "notify-only";
export type DeliveryTargetKind = "origin" | "latest-active" | "latest-active-cwd" | "session" | "desktop";
export type CallbackEventKind = "created" | "poll" | "script-exit" | "external-callback" | "reminder" | "check-in" | "cancelled" | "failed";
export type DeliveryEventKind = "reminder" | "poll" | "script-exit" | "external-callback" | "check-in" | "failed";

export interface TextCondition {
  type: "text_contains" | "regex" | "not_contains";
  value: string;
  flags?: string;
}

export interface ExitCodeCondition {
  type: "exit_code";
  value: number;
}

export interface StatusCodeCondition {
  type: "status_code";
  value: number;
}

export interface AnyOutputCondition {
  type: "any_output";
}

export interface AlwaysCondition {
  type: "always";
}

export type CallbackCondition =
  | TextCondition
  | ExitCodeCondition
  | StatusCodeCondition
  | AnyOutputCondition
  | AlwaysCondition;

export interface CheckInSchedulerDetails {
  lastSuccessfulTickAgeMs: number | null;
  overduePollCount: number;
  error?: string;
}

export interface CheckInDetails {
  schedulerDegraded: boolean;
  elapsedMs: number;
  runCount?: string;
  latestResult?: PollResult;
  scheduler?: CheckInSchedulerDetails;
}

export interface JobEvent {
  at: number;
  kind: CallbackEventKind;
  message: string;
  details?: unknown;
}

export interface SessionRef {
  sessionId: string;
  sessionFile?: string;
  cwd: string;
}

export type DeliveryTarget =
  | { kind: "origin" }
  | { kind: "latest-active" }
  | { kind: "latest-active-cwd" }
  | { kind: "session"; session: string }
  | { kind: "desktop" };

export interface SessionPresence extends SessionRef {
  runtimeId: string;
  pid: number;
  startedAt: number;
  lastSeenAt: number;
  lastActiveAt: number;
  /** First cleanup observation after heartbeat expiry; cleared by recovery. */
  staleSince?: number;
}

export interface CallbackJobBase {
  id: string;
  kind: CallbackJobKind;
  status: CallbackJobStatus;
  createdAt: number;
  updatedAt: number;
  sessionFile?: string;
  cwd?: string;
  origin?: SessionRef;
  target?: DeliveryTarget;
  orphanedAt?: number;
  label?: string;
  message: string;
  delivery: DeliveryMode;
  triggerTurn: boolean;
  deliveredAt?: number;
  /** Last time a delivery event was queued for this job. */
  lastDeliveryAt?: number;
  token?: string;
  endpoint?: string;
  events: JobEvent[];
}

export interface ReminderJob extends CallbackJobBase {
  kind: "reminder";
  dueAt: number;
}

export interface GitLabPipelineSource {
  kind: "gitlab_pipeline";
  host: string;
  project: string;
  pipelineId: number;
}

export type PollSource = GitLabPipelineSource;

export interface PollJob extends CallbackJobBase {
  kind: "poll";
  intervalMs: number;
  nextRunAt: number;
  command?: string;
  url?: string;
  source?: PollSource;
  method?: string;
  condition: CallbackCondition;
  maxRuns?: number;
  runCount: number;
  pushEachResult: boolean;
  /** When true, retain only the newest unclaimed poll result while delivery lags. */
  coalesce?: boolean;
  lastResult?: PollResult;
}

export interface ScriptJob extends CallbackJobBase {
  kind: "script";
  command: string;
  pid?: number;
  startedAt?: number;
  completedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  stdoutTail?: string;
  stderrTail?: string;
}

export interface ExternalCallbackJob extends CallbackJobBase {
  kind: "callback";
  completedAt?: number;
}

export type CallbackJob = ReminderJob | PollJob | ScriptJob | ExternalCallbackJob;

export interface PollResult {
  /** Time when the final poll result was generated. */
  at: number;
  ok: boolean;
  exitCode?: number;
  statusCode?: number;
  /** Normalised status from a named source, when the source response parsed successfully. */
  status?: string;
  stdout?: string;
  stderr?: string;
  text?: string;
  error?: string;
  matched: boolean;
}

export interface DeliveryEvent {
  id: string;
  jobId: string;
  sessionFile?: string;
  origin?: SessionRef;
  target?: DeliveryTarget;
  /** Durable queue time for this delivery event. */
  at: number;
  kind: DeliveryEventKind;
  body: string;
  details?: unknown;
  /** Result generation time for poll-result deliveries. */
  generatedAt?: number;
  /** Start of the oldest pending coalesced result chain. */
  backlogStartedAt?: number;
  /** Number of older poll results removed before retaining this event. */
  droppedResults?: number;
  /** Check-ins can be advisory without inheriting the job's match trigger policy. */
  triggerTurn?: boolean;
  jobSnapshot: CallbackJob;
  claimedBy?: string;
  claimExpiresAt?: number;
  /** Successful local handoff time; absent while pending. */
  deliveredAt?: number;
}

export type ReapedJobReason = "session-ended" | "session-crashed";

export interface ReapedJob {
  id: string;
  kind: CallbackJobKind;
  label?: string;
  message: string;
  origin?: SessionRef;
  reapedAt: number;
  reason: ReapedJobReason;
}

export interface StoreDataV1 {
  version: 1;
  jobs: CallbackJob[];
  deliveryEvents: DeliveryEvent[];
}

export interface StoreData {
  version: 2;
  jobs: CallbackJob[];
  deliveryEvents: DeliveryEvent[];
  sessions: SessionPresence[];
  reapedJobs: ReapedJob[];
  /** Persisted once when the periodic check-in upgrade first sees this store. */
  checkInBaselineAt?: number;
}

export type PersistedStoreData = StoreDataV1 | StoreData;

export interface CallbackConfig {
  version: 1;
  defaultTarget: DeliveryTarget;
  /** Null disables periodic check-ins. */
  checkInIntervalMs: number | null;
  /** Whether a check-in starts an agent turn when the delivery mode supports it. */
  checkInTriggerTurn: boolean;
  /** Minimum direct sleep duration to remind about; null disables direct reminders. */
  sleepReminderMinSeconds: number | null;
}

export interface ServerInfo {
  version: 1;
  pid: number;
  port: number;
  host: string;
  startedAt: number;
}

export interface DaemonHealth {
  ok: boolean;
  daemon: "pi-callbacks";
  pid: number;
  lastSchedulerTickAt: number | null;
  overdueJobCount: number;
  oldestOverdueJobAgeMs: number | null;
  schedulerStaleAfterMs: number;
  lastSchedulerErrorAt: number | null;
  lastSchedulerError: string | null;
}

export interface ExternalCallbackPayload {
  token: string;
  message?: string;
  status?: "success" | "failure" | "info";
  details?: unknown;
  complete?: boolean;
}
