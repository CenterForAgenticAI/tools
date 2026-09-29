import { dirname } from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type ExtensionCommandContextActions,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

import {
  isCustomEntryData,
  type OperationParams,
  type StreamFrame,
} from "../protocol/index.js";
import {
  LeaseArbiter,
  type SleepRecoverAuthorityInput,
} from "../lease/index.js";
import {
  RegistryError,
  canonicalizeSessionFilePath,
  projectSessionFile,
  projectSessionFileAtLeaf,
  type PromptIndexRecord,
  type Registry,
  type SessionFileProjection,
  type SessionRecord,
  type SessionStartupFence,
} from "../registry/index.js";
import {
  SessionOperationError,
  type SessionFileLock,
  type SessionLockRegistry,
} from "../session/index.js";
import {
  SessionStateMachine,
  type SessionStateSignal,
  type SessionStateSnapshot,
} from "../state/index.js";
import { DaemonExtensionUi } from "./daemon-ui.js";
import {
  ExternalWriterError,
  ExternalWriterMonitor,
} from "./external-writer.js";
import {
  readSessionFileState,
  sessionFileStateEquals,
  type SessionFileState,
} from "./file-signature.js";
import { HostQueue } from "./host-queue.js";
import {
  HostStateCoordinator,
  type HostStateDaemonFrame,
  type HostStatePublication,
} from "./host-state.js";
import {
  observeSessionManagerPersistence,
  type PersistenceObserver,
} from "./persistence-observer.js";
import {
  assertSdkCompatible,
  defaultHostSdkCompatibility,
} from "./sdk-stamp.js";

export type DaemonEntryType = `pi-daemon/${string}`;

export interface HostCursor {
  readonly entryId: string;
}

export interface HostCommittedEntry {
  readonly sequence: number;
  readonly sessionId: string;
  readonly cursor: HostCursor;
  readonly entry: SessionEntry;
}

export interface HostSdkEvent {
  readonly sequence: number;
  readonly sessionId: string;
  readonly event: AgentSessionEvent;
}

export type HostExternalWriterFrame = Omit<
  Extract<StreamFrame, { readonly kind: "daemon"; readonly name: "external_writer" }>,
  "attachmentId" | "seq" | "t"
>;

export type HostBlockingUiMethod = "select" | "confirm" | "input" | "editor";

export interface HostUiRequest {
  readonly kind: "request";
  readonly questionId: string;
  readonly method: HostBlockingUiMethod;
  readonly title: string;
  readonly options?: readonly string[];
  readonly message?: string;
  readonly placeholder?: string;
  readonly prefill?: string;
  readonly timeout?: number;
}

export interface HostUiNotice {
  readonly kind: "notice";
  readonly method: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface HostUiPhase {
  readonly kind: "phase";
  readonly phase: "blocked" | "unblocked";
  readonly questionId: string;
  readonly pendingQuestionIds: readonly string[];
}

export type HostUiFrame = HostUiRequest | HostUiNotice | HostUiPhase;

export type HostUiAnswer =
  | { readonly method: "select" | "input" | "editor"; readonly value: string }
  | { readonly method: "select" | "input" | "editor"; readonly cancelled: true }
  | { readonly method: "confirm"; readonly confirmed: boolean }
  | { readonly method: "confirm"; readonly cancelled: true };

export type HostUiProtocolAnswer = OperationParams<"ui_answer">["answer"];
export type HostUiAnswerResult = "answered" | "unknown_question" | "invalid_ui_answer";

export interface HostUiBridge {
  readonly pendingQuestionCount: number;
  readonly pendingQuestionIds: readonly string[];
  subscribe(listener: (frame: HostUiFrame) => void): () => void;
}

export interface AwakeSessionHost {
  readonly generation: number;
  readonly sessionId: string;
  readonly session: AgentSession;
  readonly sessionManager: SessionManager;
  readonly resourceLoader: DefaultResourceLoader;
  readonly ui: HostUiBridge;
  readonly committedSequence: number;
  readonly sdkEventSequence: number;
  subscribeCommittedEntries(
    listener: (committed: HostCommittedEntry) => void,
  ): () => void;
  subscribeSdkEvents(listener: (event: HostSdkEvent) => void): () => void;
  appendDaemonEntry(customType: DaemonEntryType, data?: unknown): Promise<string>;
  answerUi(questionId: string, answer: HostUiAnswer): Promise<boolean>;
  drain(): Promise<void>;
}

export interface StatefulAwakeSessionHost extends AwakeSessionHost {
  readonly state: SessionStateSnapshot;
  subscribeState(listener: (state: HostStatePublication) => void): () => void;
  subscribeStateFrames(listener: (frame: HostStateDaemonFrame) => void): () => void;
}

export interface HostSdkCompatibility {
  installedVersion(): string;
  probe(): void | Promise<void>;
}

type ResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

export type CrashRestoreSessionStatus =
  | "clean"
  | "deferred"
  | "restored"
  | "external_writer"
  | "gone"
  | "failed";

export interface CrashRestoreSessionResult {
  readonly sessionId: string;
  readonly status: CrashRestoreSessionStatus;
  readonly generation: number;
  readonly epoch: number;
  readonly interruptedPromptIds: readonly string[];
}

export interface CrashRestoreResult {
  readonly sessions: readonly CrashRestoreSessionResult[];
}

export interface SessionHostControllerOptions {
  readonly registry: Registry;
  readonly lockRegistry: SessionLockRegistry;
  readonly agentDir: string;
  readonly leaseArbiter?: Pick<LeaseArbiter, "assertSleepRecoverAuthority">;
  readonly now?: () => number;
  readonly sessionOptions?: Omit<
    CreateAgentSessionOptions,
    "cwd" | "agentDir" | "resourceLoader" | "sessionManager"
  >;
  readonly resourceLoaderOptions?: Omit<
    ResourceLoaderOptions,
    "cwd" | "agentDir" | "settingsManager"
  >;
  readonly sdkCompatibility?: HostSdkCompatibility;
  readonly onExternalWriter?: (frame: HostExternalWriterFrame) => void;
}

export type ExplicitSleepRequest = Omit<
  SleepRecoverAuthorityInput,
  "sessionId" | "nowMs"
>;

export type ExplicitRecoverRequest = Omit<
  SleepRecoverAuthorityInput,
  "sessionId" | "nowMs"
>;

export interface SessionRecoverResult {
  readonly closedPromptIds: readonly string[];
  readonly session: SessionRecord;
}

export type SessionHostErrorCode =
  | "controller_disposed"
  | "external_writer"
  | "host_busy"
  | "invalid_state"
  | "sdk_incompatible"
  | "unknown_session";

export class SessionHostError extends Error {
  readonly code: SessionHostErrorCode;

  constructor(code: SessionHostErrorCode, message: string) {
    super(message);
    this.name = "SessionHostError";
    this.code = code;
  }
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const RECOVER_QUIESCENCE_MS = 100;

interface HostEventState {
  committedSequence: number;
  sdkEventSequence: number;
  observerError: unknown;
  lastRunEvent: "agent_start" | "agent_end" | "agent_settled" | undefined;
  readonly committedSubscribers: Set<(entry: HostCommittedEntry) => void>;
  readonly sdkSubscribers: Set<(event: HostSdkEvent) => void>;
}

interface ControllerUiBinding {
  readonly ui: DaemonExtensionUi;
  readonly stopForwarding: () => void;
}

interface ArmedSleepTimer {
  readonly handle: ReturnType<typeof setTimeout>;
  readonly generation: number;
  readonly activityToken: number;
  readonly deadlineMs: number;
}

interface SleepFence {
  readonly generation: number;
  readonly activityToken: number;
  readonly deadlineMs: number;
}

function rejectIdentityReplacement(
  ui: DaemonExtensionUi,
  operation: "newSession" | "fork" | "switchSession",
): Promise<{ cancelled: true }> {
  ui.context.notify(
    `${operation} is unavailable for a daemon-owned session`,
    "warning",
  );
  return Promise.resolve({ cancelled: true });
}

function publishSafely<T>(subscribers: ReadonlySet<(value: T) => void>, value: T): void {
  for (const subscriber of subscribers) {
    try {
      subscriber(value);
    } catch {
      // A transport subscriber cannot change the SDK persistence or event path.
    }
  }
}

function appendDaemonCustomEntry(
  manager: SessionManager,
  customType: DaemonEntryType,
  data?: unknown,
): Promise<string> {
  return Promise.resolve(manager.appendCustomEntry(customType, data));
}

async function appendRecoveryCustomEntry(
  manager: SessionManager,
  persistenceFence: RestorePersistenceFence,
  customType: DaemonEntryType,
  data: unknown,
): Promise<string> {
  if (customType !== "pi-daemon/prompt-outcome") {
    throw new Error(`recover cannot append ${customType}`);
  }
  persistenceFence.verify();
  const entryId = await appendDaemonCustomEntry(manager, customType, data);
  persistenceFence.verify();
  return entryId;
}

interface RestorePersistenceFence {
  verify(): SessionFileState;
  stop(): void;
}

function isExactOwnPersist(
  before: SessionFileState,
  entry: SessionEntry,
  after: SessionFileState,
): boolean {
  if (entry.parentId !== before.signature.leafId) return false;
  const encodedBytes = Buffer.byteLength(`${JSON.stringify(entry)}\n`);
  const expectedBranchEntryIds = [...before.branchEntryIds, entry.id];
  return (
    after.signature.size === before.signature.size + encodedBytes &&
    after.signature.leafId === entry.id &&
    after.branchEntryIds.length === expectedBranchEntryIds.length &&
    after.branchEntryIds.every(
      (entryId, index) => entryId === expectedBranchEntryIds[index],
    )
  );
}

function bindRestorePersistenceFence(
  manager: SessionManager,
  sessionFile: string,
  lock: SessionFileLock,
  initialExpected: SessionFileState,
): RestorePersistenceFence {
  let expected = initialExpected;
  let stopped = false;
  const originalPersist = manager._persist.bind(manager);
  const verify = (): SessionFileState => {
    if (stopped) throw new Error("restore persistence fence is stopped");
    lock.assertHeld();
    const actual = readSessionFileState(sessionFile);
    if (!sessionFileStateEquals(actual, expected)) {
      throw new ExternalWriterError(manager.getSessionId());
    }
    return actual;
  };
  const wrappedPersist: SessionManager["_persist"] = (entry) => {
    verify();
    const before = expected;
    originalPersist(entry);
    lock.assertHeld();
    const actual = readSessionFileState(sessionFile);
    if (!isExactOwnPersist(before, entry, actual)) {
      throw new ExternalWriterError(manager.getSessionId());
    }
    expected = actual;
  };
  manager._persist = wrappedPersist;
  return {
    verify,
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (manager._persist === wrappedPersist) manager._persist = originalPersist;
    },
  };
}

function committedStateSignal(entry: SessionEntry): SessionStateSignal | undefined {
  if (entry.type !== "custom") return undefined;
  if (
    entry.customType === "pi-daemon/prompt-claim" &&
    isCustomEntryData(entry.customType, entry.data)
  ) {
    return { type: "prompt_claimed", promptId: entry.data.promptId };
  }
  if (
    entry.customType === "pi-daemon/prompt-outcome" &&
    isCustomEntryData(entry.customType, entry.data)
  ) {
    return { type: "prompt_settled", promptId: entry.data.promptId };
  }
  if (
    entry.customType === "pi-daemon/restored" &&
    isCustomEntryData(entry.customType, entry.data)
  ) {
    return { type: "restored" };
  }
  return undefined;
}

function sdkStateSignal(event: AgentSessionEvent): SessionStateSignal | undefined {
  switch (event.type) {
    case "agent_start":
    case "agent_end":
    case "agent_settled":
      return { type: event.type };
    case "auto_retry_start":
      return { type: "retry_start" };
    case "auto_retry_end":
      return { type: "retry_end" };
    case "compaction_start":
      return { type: "compaction_start" };
    case "compaction_end":
      return { type: "compaction_end" };
    case "queue_update":
      return {
        type: "queue",
        queued: event.steering.length > 0 || event.followUp.length > 0,
      };
    default:
      return undefined;
  }
}

class BoundSessionHost implements StatefulAwakeSessionHost {
  readonly generation: number;
  readonly sessionId: string;
  readonly session: AgentSession;
  readonly sessionManager: SessionManager;
  readonly resourceLoader: DefaultResourceLoader;
  readonly ui: DaemonExtensionUi;

  readonly #epoch: number;
  readonly #sleepAfterMs: number | null;
  readonly #queue: HostQueue;
  readonly #state: HostEventState;
  readonly #sessionState: HostStateCoordinator;
  readonly #observer: PersistenceObserver;
  readonly #monitor: ExternalWriterMonitor;
  readonly #restorePersistenceFence: () => void;
  readonly #unsubscribeSdk: () => void;
  readonly #activateIndex: () => void;
  readonly #onActivity: (armSleep: boolean) => void;
  readonly #now: () => number;
  #externalWriterFailure: ExternalWriterError | undefined;
  #sleeping = false;
  #disposed = false;

  constructor(options: {
    readonly generation: number;
    readonly epoch: number;
    readonly sleepAfterMs: number | null;
    readonly session: AgentSession;
    readonly resourceLoader: DefaultResourceLoader;
    readonly ui: DaemonExtensionUi;
    readonly queue: HostQueue;
    readonly state: HostEventState;
    readonly sessionState: HostStateCoordinator;
    readonly observer: PersistenceObserver;
    readonly monitor: ExternalWriterMonitor;
    readonly restorePersistenceFence: () => void;
    readonly unsubscribeSdk: () => void;
    readonly activateIndex: () => void;
    readonly onActivity: (armSleep: boolean) => void;
    readonly now: () => number;
  }) {
    this.generation = options.generation;
    this.#epoch = options.epoch;
    this.#sleepAfterMs = options.sleepAfterMs;
    this.session = options.session;
    this.sessionId = options.session.sessionId;
    this.sessionManager = options.session.sessionManager;
    this.resourceLoader = options.resourceLoader;
    this.ui = options.ui;
    this.#queue = options.queue;
    this.#state = options.state;
    this.#sessionState = options.sessionState;
    this.#observer = options.observer;
    this.#monitor = options.monitor;
    this.#restorePersistenceFence = options.restorePersistenceFence;
    this.#unsubscribeSdk = options.unsubscribeSdk;
    this.#activateIndex = options.activateIndex;
    this.#onActivity = options.onActivity;
    this.#now = options.now;
  }

  get state(): SessionStateSnapshot {
    return this.#sessionState.current;
  }

  get committedSequence(): number {
    return this.#state.committedSequence;
  }

  get sdkEventSequence(): number {
    return this.#state.sdkEventSequence;
  }

  subscribeCommittedEntries(
    listener: (committed: HostCommittedEntry) => void,
  ): () => void {
    this.assertAvailable();
    this.#state.committedSubscribers.add(listener);
    return () => this.#state.committedSubscribers.delete(listener);
  }

  subscribeSdkEvents(listener: (event: HostSdkEvent) => void): () => void {
    this.assertAvailable();
    this.#state.sdkSubscribers.add(listener);
    return () => this.#state.sdkSubscribers.delete(listener);
  }

  subscribeState(listener: (state: HostStatePublication) => void): () => void {
    this.assertAvailable();
    return this.#sessionState.subscribeState(listener);
  }

  subscribeStateFrames(listener: (frame: HostStateDaemonFrame) => void): () => void {
    this.assertAvailable();
    return this.#sessionState.subscribeFrames(listener);
  }

  async appendDaemonEntry(customType: DaemonEntryType, data?: unknown): Promise<string> {
    const entryId = await this.#queue.enqueue(() => {
      this.assertAvailable();
      this.#monitor.verify();
      return appendDaemonCustomEntry(this.sessionManager, customType, data);
    });
    await this.#queue.enqueue(() => this.#onActivity(true));
    return entryId;
  }

  answerUi(questionId: string, answer: HostUiAnswer): Promise<boolean> {
    this.assertAvailable();
    const answered = this.ui.answer(questionId, answer);
    if (answered) this.#onActivity(false);
    return Promise.resolve(answered);
  }

  async drain(): Promise<void> {
    await this.#queue.drain();
    this.assertAvailable();
  }

  async recordWake(): Promise<void> {
    await appendDaemonCustomEntry(this.sessionManager, "pi-daemon/lifecycle", {
      v: 1,
      action: "woke",
      generation: this.generation,
      epoch: this.#epoch,
      reason: "explicit",
      at: new Date(this.#now()).toISOString(),
    });
    await this.#queue.drain();
  }

  activateIndex(): void {
    this.#activateIndex();
  }

  canArmSleep(): boolean {
    return (
      !this.#sleeping &&
      !this.#disposed &&
      this.ui.pendingQuestionCount === 0 &&
      this.state.phase === "idle" &&
      this.session.isIdle &&
      !this.session.isStreaming &&
      !this.session.isRetrying &&
      !this.session.isCompacting &&
      this.session.pendingMessageCount === 0 &&
      (this.#state.lastRunEvent === undefined ||
        this.#state.lastRunEvent === "agent_settled")
    );
  }

  async shutdown(
    reason: "explicit" | "idle_timeout",
    assertPreDisposeFence: () => void,
  ): Promise<void> {
    this.assertAvailable();
    this.assertSettledForSleep();
    this.#sleeping = true;

    await appendDaemonCustomEntry(this.sessionManager, "pi-daemon/lifecycle", {
      v: 1,
      action: "sleeping",
      generation: this.generation,
      epoch: this.#epoch,
      reason,
      ...(this.#sleepAfterMs === null ? {} : { sleepAfterMs: this.#sleepAfterMs }),
      at: new Date(this.#now()).toISOString(),
    });
    await this.#queue.drain();
    try {
      this.assertSettledForSleep();
      assertPreDisposeFence();
    } catch (error) {
      this.#sleeping = false;
      throw error;
    }

    this.ui.close();
    await this.session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    this.#unsubscribeSdk();
    this.session.dispose();

    await appendDaemonCustomEntry(this.sessionManager, "pi-daemon/lifecycle", {
      v: 1,
      action: "slept",
      generation: this.generation,
      epoch: this.#epoch,
      reason,
      ...(this.#sleepAfterMs === null ? {} : { sleepAfterMs: this.#sleepAfterMs }),
      at: new Date(this.#now()).toISOString(),
    });
    await this.#queue.drain();

    this.finishDisposal();
  }

  async disposeFailedWake(): Promise<void> {
    if (this.#disposed) return;
    this.#sleeping = true;
    this.ui.close();
    try {
      await this.session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
    } finally {
      try {
        this.#unsubscribeSdk();
        this.session.dispose();
        await this.#queue.drain();
      } finally {
        this.finishDisposal();
      }
    }
  }

  fenceFailedSleep(): void {
    if (this.#disposed) return;
    this.#sleeping = true;
    this.ui.close();
    try {
      this.#unsubscribeSdk();
      this.session.dispose();
    } finally {
      this.finishDisposal();
    }
  }

  private finishDisposal(): void {
    this.#observer.stop();
    this.#restorePersistenceFence();
    this.#disposed = true;
    this.#sessionState.close();
    this.#state.committedSubscribers.clear();
    this.#state.sdkSubscribers.clear();
  }

  private assertSettledForSleep(): void {
    if (
      this.#queue.pending !== 0 ||
      this.ui.pendingQuestionCount !== 0 ||
      this.state.phase !== "idle" ||
      !this.session.isIdle ||
      this.session.isStreaming ||
      this.session.isRetrying ||
      this.session.isCompacting ||
      this.session.pendingMessageCount !== 0 ||
      (this.#state.lastRunEvent !== undefined &&
        this.#state.lastRunEvent !== "agent_settled")
    ) {
      throw new SessionHostError(
        "host_busy",
        `session host is not settled: ${this.sessionId}`,
      );
    }
  }

  failExternalWriter(): void {
    if (this.#disposed) return;
    this.#externalWriterFailure =
      this.#monitor.failure ?? new ExternalWriterError(this.sessionId);
    this.ui.close();
    this.#unsubscribeSdk();
    this.session.dispose();
    this.#observer.stop();
    this.#sessionState.close();
    this.#disposed = true;
    this.#state.committedSubscribers.clear();
    this.#state.sdkSubscribers.clear();
  }

  private assertAvailable(): void {
    if (this.#externalWriterFailure !== undefined) {
      throw this.#externalWriterFailure;
    }
    this.#sessionState.assertHealthy();
    if (this.#state.observerError !== undefined) {
      throw new SessionHostError(
        "sdk_incompatible",
        `sdk_incompatible: persistence observation failed: ${errorMessage(this.#state.observerError)}`,
      );
    }
    if (this.#sleeping) {
      throw new SessionHostError("host_busy", `session host is sleeping: ${this.sessionId}`);
    }
    if (this.#disposed) {
      throw new SessionHostError(
        "controller_disposed",
        `session host is disposed: ${this.sessionId}`,
      );
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function idleDeadlineMs(nowMs: number, sleepAfterMs: number | null): number | null {
  if (sleepAfterMs === null) return null;
  return Math.min(Number.MAX_SAFE_INTEGER, nowMs + sleepAfterMs);
}

export class SessionHostController {
  readonly #registry: Registry;
  readonly #lockRegistry: SessionLockRegistry;
  readonly #agentDir: string;
  readonly #sessionOptions: SessionHostControllerOptions["sessionOptions"];
  readonly #resourceLoaderOptions: SessionHostControllerOptions["resourceLoaderOptions"];
  readonly #sdkCompatibility: HostSdkCompatibility;
  readonly #onExternalWriter: SessionHostControllerOptions["onExternalWriter"];
  readonly #leaseArbiter: Pick<LeaseArbiter, "assertSleepRecoverAuthority">;
  readonly #now: () => number;
  readonly #hosts = new Map<string, BoundSessionHost>();
  readonly #ownerships = new Map<string, ExternalWriterMonitor>();
  readonly #wakePromises = new Map<string, Promise<StatefulAwakeSessionHost>>();
  readonly #sleepPromises = new Map<string, Promise<void>>();
  readonly #recoverPromises = new Map<string, Promise<SessionRecoverResult>>();
  readonly #postSleepWakePromises = new Map<
    string,
    Promise<StatefulAwakeSessionHost>
  >();
  readonly #sleepTimers = new Map<string, ArmedSleepTimer>();
  readonly #uiBindings = new Map<string, ControllerUiBinding>();
  readonly #uiSubscribers = new Map<
    string,
    Set<(frame: HostUiFrame) => void>
  >();
  #disposed = false;
  #disposePromise: Promise<void> | undefined;
  #crashRestorePromise: Promise<CrashRestoreResult> | undefined;

  constructor(options: SessionHostControllerOptions) {
    this.#registry = options.registry;
    this.#lockRegistry = options.lockRegistry;
    this.#agentDir = options.agentDir;
    this.#sessionOptions = options.sessionOptions;
    this.#resourceLoaderOptions = options.resourceLoaderOptions;
    this.#sdkCompatibility =
      options.sdkCompatibility ?? defaultHostSdkCompatibility;
    this.#onExternalWriter = options.onExternalWriter;
    this.#now = options.now ?? Date.now;
    this.#leaseArbiter =
      options.leaseArbiter ??
      new LeaseArbiter({
        registry: this.#registry,
        defaultTtlMs: 60_000,
        now: this.#now,
        getAwakeHost: (sessionId) => this.#hosts.get(sessionId),
      });
  }

  get(sessionId: string): StatefulAwakeSessionHost | undefined {
    return this.#hosts.get(sessionId);
  }

  async recover(
    sessionId: string,
    authority: ExplicitRecoverRequest,
  ): Promise<SessionRecoverResult> {
    if (this.#disposed) {
      throw new SessionHostError(
        "controller_disposed",
        "session host controller is disposed",
      );
    }
    await this.assertRecoverAuthority(sessionId, authority);
    const captured = this.requireExternalWriterFailure(sessionId, authority.generation);
    const key = `${sessionId}:${captured.generation}`;
    const existing = this.#recoverPromises.get(key);
    if (existing !== undefined) return await existing;

    const recovery = this.performExternalWriterRecovery(captured, authority).finally(() => {
      if (this.#recoverPromises.get(key) === recovery) {
        this.#recoverPromises.delete(key);
      }
    });
    this.#recoverPromises.set(key, recovery);
    return await recovery;
  }

  private async performExternalWriterRecovery(
    captured: SessionRecord,
    authority: ExplicitRecoverRequest,
  ): Promise<SessionRecoverResult> {
    await this.assertRecoverAuthority(captured.sessionId, authority);
    this.requireExternalWriterFailure(captured.sessionId, captured.generation);
    await this.assertSdkCompatible();

    let lock: SessionFileLock | undefined;
    let persistenceFence: RestorePersistenceFence | undefined;
    let projection: SessionFileProjection | undefined;
    let recoveredOwnership: ExternalWriterMonitor | undefined;
    try {
      lock = this.#lockRegistry.acquire(captured.sessionFile, captured.sessionId);
      lock.assertHeld();
      const firstSample = readSessionFileState(captured.sessionFile);
      await new Promise<void>((resolvePromise) =>
        setTimeout(resolvePromise, RECOVER_QUIESCENCE_MS),
      );
      lock.assertHeld();
      const secondSample = readSessionFileState(captured.sessionFile);
      if (!sessionFileStateEquals(firstSample, secondSample)) {
        throw new ExternalWriterError(captured.sessionId);
      }

      projection = projectSessionFile(captured.sessionFile, this.#now());
      this.assertRecoveryProjection(captured, projection, secondSample);
      const manager = SessionManager.open(
        captured.sessionFile,
        dirname(captured.sessionFile),
      );
      this.assertManagerIdentity(manager, captured.sessionId, projection.session.cwd);
      const managerFile = manager.getSessionFile();
      if (
        managerFile === undefined ||
        canonicalizeSessionFilePath(managerFile) !== captured.sessionFile ||
        manager.getLeafId() !== projection.continuity.currentLeafId
      ) {
        throw new SessionOperationError(
          "path_mismatch",
          `session identity changed during recovery: ${captured.sessionId}`,
        );
      }
      persistenceFence = bindRestorePersistenceFence(
        manager,
        captured.sessionFile,
        lock,
        secondSample,
      );
      persistenceFence.verify();
      this.#registry.applyExternalWriterRecoveryProjection({
        projection,
        expectedGeneration: captured.generation,
        nowMs: this.#now(),
      });

      const closedPromptIds: string[] = [];
      for (const pending of this.pendingPrompts(projection)) {
        await this.assertRecoverAuthority(captured.sessionId, authority);
        this.requireExternalWriterFailure(captured.sessionId, captured.generation);
        persistenceFence.verify();
        projection = projectSessionFile(captured.sessionFile, this.#now());
        const verifiedBeforeOutcome = persistenceFence.verify();
        this.assertRecoveryProjection(captured, projection, verifiedBeforeOutcome);
        const stillPending = projection.prompts.some(
          (candidate) =>
            candidate.promptId === pending.promptId && candidate.state === "pending",
        );
        if (!stillPending) continue;

        await appendRecoveryCustomEntry(
          manager,
          persistenceFence,
          "pi-daemon/prompt-outcome",
          {
            v: 1,
            promptId: pending.promptId,
            outcome: "failed",
            errorCode: "external_writer",
            settledAt: new Date(this.#now()).toISOString(),
          },
        );
        projection = projectSessionFile(captured.sessionFile, this.#now());
        const verifiedAfterOutcome = persistenceFence.verify();
        this.assertRecoveryProjection(captured, projection, verifiedAfterOutcome);
        this.#registry.applyExternalWriterRecoveryProjection({
          projection,
          expectedGeneration: captured.generation,
          nowMs: this.#now(),
        });
        closedPromptIds.push(pending.promptId);
      }

      await this.assertRecoverAuthority(captured.sessionId, authority);
      this.requireExternalWriterFailure(captured.sessionId, captured.generation);
      persistenceFence.verify();
      projection = projectSessionFile(captured.sessionFile, this.#now());
      const finalFileState = persistenceFence.verify();
      this.assertRecoveryProjection(captured, projection, finalFileState);
      recoveredOwnership = new ExternalWriterMonitor({
        sessionId: captured.sessionId,
        generation: captured.generation,
        epoch: projection.session.epoch,
        sessionFile: captured.sessionFile,
        lock,
        queue: new HostQueue(),
        registry: this.#registry,
        initialExpected: finalFileState,
        emit: (frame) => this.#onExternalWriter?.(frame),
        onDetected: () => this.handleExternalWriter(captured.sessionId),
      });
      this.#ownerships.set(captured.sessionId, recoveredOwnership);
      recoveredOwnership.verify();
      const session = this.#registry.completeExternalWriterRecovery({
        projection,
        expectedGeneration: captured.generation,
        nowMs: this.#now(),
      });
      persistenceFence.stop();
      return { closedPromptIds, session };
    } catch (error) {
      persistenceFence?.stop();
      if (recoveredOwnership !== undefined) {
        if (this.#ownerships.get(captured.sessionId) === recoveredOwnership) {
          this.#ownerships.delete(captured.sessionId);
        }
        recoveredOwnership.release();
      }
      const recoveryError =
        error instanceof Error &&
        error.message.startsWith("session file changed while its signature was read:")
          ? new ExternalWriterError(captured.sessionId, error)
          : error;
      if (recoveryError instanceof ExternalWriterError) {
        if (projection !== undefined) {
          try {
            const changedProjection = projectSessionFile(captured.sessionFile, this.#now());
            this.#registry.applyExternalWriterRecoveryProjection({
              projection: changedProjection,
              expectedGeneration: captured.generation,
              nowMs: this.#now(),
            });
          } catch {
            // Keep the latest successfully rebuilt pending set when the file is unstable.
          }
        }
        let failed = this.#registry.getSession(captured.sessionId) ?? captured;
        try {
          failed = this.#registry.markSessionExternalWriter(
            captured.sessionId,
            this.#now(),
          );
        } catch {
          // The session was already fail-closed; preserve the external-writer error.
        }
        try {
          this.#onExternalWriter?.({
            session: captured.sessionId,
            kind: "daemon",
            generation: captured.generation,
            epoch: failed.epoch,
            name: "external_writer",
            data: {},
          });
        } catch {
          // A frame consumer cannot replace the failure or retain the attempted lock.
        } finally {
          lock?.release();
        }
        throw recoveryError;
      }
      if (
        recoveryError instanceof SessionOperationError &&
        (recoveryError.code === "gone" || recoveryError.code === "path_mismatch")
      ) {
        this.#registry.markSessionGone(captured.sessionId, recoveryError.code, this.#now());
      } else if (
        recoveryError instanceof Error &&
        "code" in recoveryError &&
        (recoveryError as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        this.#registry.markSessionGone(captured.sessionId, "gone", this.#now());
        lock?.release();
        throw new SessionOperationError(
          "gone",
          `registered session file is missing: ${captured.sessionFile}`,
        );
      }
      lock?.release();
      throw recoveryError;
    }
  }

  private async assertRecoverAuthority(
    sessionId: string,
    authority: ExplicitRecoverRequest,
  ): Promise<void> {
    await this.#leaseArbiter.assertSleepRecoverAuthority({
      sessionId,
      attachmentId: authority.attachmentId,
      ...(authority.leaseId === undefined ? {} : { leaseId: authority.leaseId }),
      generation: authority.generation,
      nowMs: this.#now(),
    });
  }

  private requireExternalWriterFailure(
    sessionId: string,
    generation: number,
  ): SessionRecord {
    const current = this.#registry.getSession(sessionId);
    if (current === undefined) {
      throw new SessionHostError("unknown_session", `unknown session: ${sessionId}`);
    }
    if (current.generation !== generation) {
      throw new RegistryError(
        "stale_generation",
        `stale generation ${generation}; current generation is ${current.generation}`,
      );
    }
    if (
      current.runtimeState !== "asleep" ||
      current.lastPhase !== "failed" ||
      current.failureCode !== "external_writer" ||
      this.#hosts.has(sessionId)
    ) {
      throw new SessionHostError(
        "invalid_state",
        `session is not recoverable from external_writer: ${sessionId}`,
      );
    }
    return current;
  }

  private assertRecoveryProjection(
    captured: SessionRecord,
    projection: SessionFileProjection,
    fileState: SessionFileState,
  ): void {
    if (
      projection.session.sessionId !== captured.sessionId ||
      projection.session.sessionFile !== captured.sessionFile ||
      projection.session.cwd !== captured.cwd
    ) {
      throw new SessionOperationError(
        "path_mismatch",
        `registered session identity changed during recovery: ${captured.sessionId}`,
      );
    }
    if (
      fileState.signature.leafId !== projection.continuity.currentLeafId ||
      fileState.signature.size <= 0
    ) {
      throw new ExternalWriterError(captured.sessionId);
    }
  }

  restoreAfterCrash(): Promise<CrashRestoreResult> {
    if (this.#disposed) {
      return Promise.reject(
        new SessionHostError(
          "controller_disposed",
          "session host controller is disposed",
        ),
      );
    }
    if (this.#crashRestorePromise !== undefined) return this.#crashRestorePromise;
    this.#crashRestorePromise = this.performCrashRestore();
    return this.#crashRestorePromise;
  }

  private async performCrashRestore(): Promise<CrashRestoreResult> {
    await this.assertSdkCompatible();
    const nowMs = this.#now();
    const fences = this.#registry.fenceSessionsForStartup(nowMs);
    const daemonInstanceId = this.#registry.getMeta("daemonInstanceId");
    const sessions: CrashRestoreSessionResult[] = [];
    for (const fence of fences) {
      sessions.push(
        await this.restoreStartupSession(
          fence,
          daemonInstanceId,
          this.#registry.startupState.previousCleanShutdown === false,
        ),
      );
    }
    return { sessions };
  }

  private async restoreStartupSession(
    fence: SessionStartupFence,
    daemonInstanceId: string,
    previousDaemonWasUnclean: boolean,
  ): Promise<CrashRestoreSessionResult> {
    const { previous, current } = fence;
    if (!previous.fileMaterialized) {
      return this.crashRestoreResult(current, "deferred", []);
    }

    let lock: ReturnType<SessionLockRegistry["acquire"]> | undefined;
    let restorePersistenceFence: RestorePersistenceFence | undefined;
    let filePendingIds: string[] = [];
    try {
      lock = this.#lockRegistry.acquire(current.sessionFile, current.sessionId);
      lock.assertHeld();
      let projection = projectSessionFile(current.sessionFile, this.#now());
      if (projection.session.sessionId !== current.sessionId) {
        const gone = this.#registry.markSessionGone(
          current.sessionId,
          "path_mismatch",
          this.#now(),
        );
        lock.release();
        return this.crashRestoreResult(gone, "gone", []);
      }

      if (projection.continuity.status === "unproved") {
        const expectedProjection = this.fileProjectionForRestore(projection);
        filePendingIds = this.pendingPrompts(expectedProjection).map(
          ({ promptId }) => promptId,
        );
        this.#registry.applySessionFileProjection(
          expectedProjection,
          this.#now(),
        );
        const failed = this.#registry.markSessionExternalWriter(
          current.sessionId,
          this.#now(),
        );
        lock.release();
        return this.crashRestoreResult(
          failed,
          "external_writer",
          filePendingIds,
        );
      }

      const pending = this.pendingPrompts(projection);
      filePendingIds = pending.map(({ promptId }) => promptId);
      this.#registry.applySessionFileProjection(projection, this.#now());
      if (!previousDaemonWasUnclean && pending.length === 0) {
        const clean = this.#registry.getSession(current.sessionId);
        if (clean === undefined) throw new Error("clean startup session disappeared");
        return this.crashRestoreResult(clean, "clean", []);
      }

      const projectedFileState = readSessionFileState(current.sessionFile);
      if (
        projectedFileState.signature.leafId !== projection.continuity.currentLeafId
      ) {
        throw new ExternalWriterError(current.sessionId);
      }
      const manager = SessionManager.open(
        current.sessionFile,
        dirname(current.sessionFile),
      );
      this.assertManagerIdentity(
        manager,
        current.sessionId,
        projection.session.cwd,
      );
      if (manager.getLeafId() !== projection.continuity.currentLeafId) {
        throw new ExternalWriterError(current.sessionId);
      }
      restorePersistenceFence = bindRestorePersistenceFence(
        manager,
        current.sessionFile,
        lock,
        projectedFileState,
      );
      restorePersistenceFence.verify();

      const pendingPromptIds = [...filePendingIds];
      await appendDaemonCustomEntry(manager, "pi-daemon/restored", {
        v: 1,
        daemonInstanceId,
        generation: current.generation,
        epoch: projection.session.epoch,
        interrupted: true,
        previousPhase:
          projection.session.lastPhase === "working" ||
          projection.session.lastPhase === "blocked"
            ? projection.session.lastPhase
            : pending.length > 0
              ? "working"
              : null,
        unfinishedPromptIds: pendingPromptIds,
        at: new Date(this.#now()).toISOString(),
      });

      for (const prompt of pending) {
        restorePersistenceFence.verify();
        projection = projectSessionFile(current.sessionFile, this.#now());
        restorePersistenceFence.verify();
        if (projection.continuity.status === "unproved") {
          throw new ExternalWriterError(current.sessionId);
        }
        if (manager.getLeafId() !== projection.continuity.currentLeafId) {
          throw new ExternalWriterError(current.sessionId);
        }
        const stillPending = projection.prompts.some(
          (candidate) =>
            candidate.promptId === prompt.promptId && candidate.state === "pending",
        );
        if (!stillPending) continue;
        await appendDaemonCustomEntry(manager, "pi-daemon/prompt-outcome", {
          v: 1,
          promptId: prompt.promptId,
          outcome: "failed",
          errorCode: "interrupted",
          settledAt: new Date(this.#now()).toISOString(),
        });
      }

      restorePersistenceFence.verify();
      projection = projectSessionFile(current.sessionFile, this.#now());
      restorePersistenceFence.verify();
      if (
        projection.continuity.status === "unproved" ||
        manager.getLeafId() !== projection.continuity.currentLeafId
      ) {
        throw new ExternalWriterError(current.sessionId);
      }
      const restored = this.#registry.applySessionFileProjection(
        projection,
        this.#now(),
      );
      restorePersistenceFence.stop();
      return this.crashRestoreResult(
        restored,
        "restored",
        pendingPromptIds,
      );
    } catch (error) {
      restorePersistenceFence?.stop();
      if (error instanceof ExternalWriterError) {
        try {
          const projection = projectSessionFile(current.sessionFile, this.#now());
          const expectedProjection = this.fileProjectionForRestore(projection);
          filePendingIds = this.pendingPrompts(expectedProjection).map(
            ({ promptId }) => promptId,
          );
          this.#registry.applySessionFileProjection(
            expectedProjection,
            this.#now(),
          );
        } catch {
          // Retain the last file-derived pending set when the changed file is unreadable.
        }
        const failed = this.#registry.markSessionExternalWriter(
          current.sessionId,
          this.#now(),
        );
        lock?.release();
        return this.crashRestoreResult(
          failed,
          "external_writer",
          filePendingIds,
        );
      }
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        const gone = this.#registry.markSessionGone(
          current.sessionId,
          "gone",
          this.#now(),
        );
        lock?.release();
        return this.crashRestoreResult(gone, "gone", []);
      }
      let interruptedPromptIds: string[] = [];
      try {
        const projection = projectSessionFile(current.sessionFile, this.#now());
        interruptedPromptIds = this.pendingPrompts(projection).map(
          ({ promptId }) => promptId,
        );
        this.#registry.applySessionFileProjection(projection, this.#now());
      } catch {
        // Preserve the original restore failure; the next startup rebuilds from the file.
      }
      try {
        this.#registry.setSessionState({
          sessionId: current.sessionId,
          runtimeState: "asleep",
          lastPhase: "failed",
          attention: "failed",
          updatedAtMs: this.#now(),
        });
      } catch {
        // The original failure may have made even the existing index unavailable.
      }
      lock?.release();
      const failed = this.#registry.getSession(current.sessionId) ?? current;
      return this.crashRestoreResult(
        failed,
        "failed",
        interruptedPromptIds,
      );
    }
  }

  private fileProjectionForRestore(
    projection: SessionFileProjection,
  ): SessionFileProjection {
    if (projection.continuity.status !== "unproved") return projection;
    return projectSessionFileAtLeaf(
      projection.session.sessionFile,
      projection.continuity.lastActiveLeafId,
      this.#now(),
    );
  }

  private pendingPrompts(
    projection: SessionFileProjection,
  ): PromptIndexRecord[] {
    return projection.prompts.filter(({ state }) => state === "pending");
  }

  private crashRestoreResult(
    session: SessionRecord,
    status: CrashRestoreSessionStatus,
    interruptedPromptIds: readonly string[],
  ): CrashRestoreSessionResult {
    return {
      sessionId: session.sessionId,
      status,
      generation: session.generation,
      epoch: session.epoch,
      interruptedPromptIds: [...interruptedPromptIds],
    };
  }

  subscribeUi(
    sessionId: string,
    listener: (frame: HostUiFrame) => void,
  ): () => void {
    let subscribers = this.#uiSubscribers.get(sessionId);
    if (subscribers === undefined) {
      subscribers = new Set();
      this.#uiSubscribers.set(sessionId, subscribers);
    }
    subscribers.add(listener);
    return () => {
      subscribers?.delete(listener);
      if (subscribers?.size === 0) this.#uiSubscribers.delete(sessionId);
    };
  }

  answerUi(
    sessionId: string,
    questionId: string,
    answer: HostUiAnswer,
  ): Promise<boolean> {
    const binding = this.#uiBindings.get(sessionId);
    if (binding === undefined) return Promise.resolve(false);
    const answered = binding.ui.answer(questionId, answer);
    const host = this.#hosts.get(sessionId);
    if (answered && host !== undefined) {
      this.recordActivity(sessionId, host.generation, false);
    }
    return Promise.resolve(answered);
  }

  answerUiRequest(
    sessionId: string,
    questionId: string,
    answer: HostUiProtocolAnswer,
  ): HostUiAnswerResult {
    const binding = this.#uiBindings.get(sessionId);
    if (binding === undefined) return "unknown_question";
    const result = binding.ui.answerProtocol(questionId, answer);
    const host = this.#hosts.get(sessionId);
    if (result === "answered" && host !== undefined) {
      this.recordActivity(sessionId, host.generation, false);
    }
    return result;
  }

  cancelUi(sessionId: string): void {
    this.#uiBindings.get(sessionId)?.ui.cancelPending();
    const host = this.#hosts.get(sessionId);
    if (host !== undefined) this.recordActivity(sessionId, host.generation, false);
  }

  wake(sessionId: string): Promise<StatefulAwakeSessionHost> {
    if (this.#disposed) {
      return Promise.reject(
        new SessionHostError(
          "controller_disposed",
          "session host controller is disposed",
        ),
      );
    }

    const sleeping = this.#sleepPromises.get(sessionId);
    if (sleeping !== undefined) {
      const existingPostSleepWake = this.#postSleepWakePromises.get(sessionId);
      if (existingPostSleepWake !== undefined) return existingPostSleepWake;
      const postSleepWake = sleeping
        .catch(() => undefined)
        .then(() => this.wake(sessionId))
        .finally(() => {
          if (this.#postSleepWakePromises.get(sessionId) === postSleepWake) {
            this.#postSleepWakePromises.delete(sessionId);
          }
        });
      this.#postSleepWakePromises.set(sessionId, postSleepWake);
      return postSleepWake;
    }

    const awake = this.#hosts.get(sessionId);
    if (awake !== undefined) return Promise.resolve(awake);

    const record = this.#registry.getSession(sessionId);
    if (record === undefined) {
      return Promise.reject(
        new SessionHostError("unknown_session", `unknown session: ${sessionId}`),
      );
    }
    if (record.failureCode === "external_writer") {
      return Promise.reject(new ExternalWriterError(record.sessionId));
    }
    if (record.lastPhase === "failed") {
      return Promise.reject(
        new SessionHostError(
          "sdk_incompatible",
          `session host is fenced after a lifecycle failure: ${sessionId}`,
        ),
      );
    }
    const wakeKey = `${record.sessionId}:${record.generation}`;
    const existingWake = this.#wakePromises.get(wakeKey);
    if (existingWake !== undefined) return existingWake;

    let resolveWake!: (host: StatefulAwakeSessionHost) => void;
    let rejectWake!: (error: unknown) => void;
    const wakePromise = new Promise<StatefulAwakeSessionHost>((resolve, reject) => {
      resolveWake = resolve;
      rejectWake = reject;
    });
    this.#wakePromises.set(wakeKey, wakePromise);

    queueMicrotask(() => {
      void (async () => {
        let host: BoundSessionHost | undefined;
        try {
          const generation = record.generation + 1;
          host = await this.allocateHost(record, generation);
          await host.recordWake();
          const nowMs = this.#now();
          const awakeRecord = this.#registry.advanceSessionGeneration({
            sessionId,
            expectedGeneration: record.generation,
            runtimeState: "awake",
            lastPhase: host.state.phase,
            attention: host.state.attention,
            sleepDeadlineMs:
              host.canArmSleep() ? idleDeadlineMs(nowMs, record.sleepAfterMs) : null,
            updatedAtMs: nowMs,
          });
          host.activateIndex();
          this.#hosts.set(sessionId, host);
          this.#wakePromises.delete(wakeKey);
          this.armSleepTimer(awakeRecord);
          resolveWake(host);
        } catch (error) {
          if (host !== undefined) {
            try {
              await host.disposeFailedWake();
            } catch {
              // Preserve the allocation/activation failure for every wake waiter.
            }
          }
          const uiBinding = this.#uiBindings.get(sessionId);
          uiBinding?.stopForwarding();
          this.#uiBindings.delete(sessionId);
          this.#wakePromises.delete(wakeKey);
          rejectWake(error);
        }
      })();
    });

    return wakePromise;
  }

  sleep(sessionId: string, authority?: ExplicitSleepRequest): Promise<void> {
    return this.authorizeExplicitSleep(sessionId, authority).then(() =>
      this.startExplicitSleep(sessionId, authority),
    );
  }

  private async authorizeExplicitSleep(
    sessionId: string,
    authority: ExplicitSleepRequest | undefined,
  ): Promise<void> {
    const record = this.#registry.getSession(sessionId);
    if (record === undefined) return;
    await this.#leaseArbiter.assertSleepRecoverAuthority({
      sessionId,
      attachmentId: authority?.attachmentId ?? "",
      ...(authority?.leaseId === undefined ? {} : { leaseId: authority.leaseId }),
      generation: authority?.generation ?? record.generation,
      nowMs: this.#now(),
    });
  }

  private startExplicitSleep(
    sessionId: string,
    authority: ExplicitSleepRequest | undefined,
  ): Promise<void> {
    const existingSleep = this.#sleepPromises.get(sessionId);
    if (existingSleep !== undefined) return existingSleep;
    const sleep = this.performSleep(
      sessionId,
      authority,
      undefined,
      "explicit",
      true,
    ).finally(() => {
      if (this.#sleepPromises.get(sessionId) === sleep) {
        this.#sleepPromises.delete(sessionId);
      }
    });
    this.#sleepPromises.set(sessionId, sleep);
    return sleep;
  }

  private async performSleep(
    sessionId: string,
    authority: ExplicitSleepRequest | undefined,
    fence: SleepFence | undefined,
    reason: "explicit" | "idle_timeout",
    enforceAuthority: boolean,
  ): Promise<void> {
    let host = this.#hosts.get(sessionId);
    if (host === undefined) {
      const record = this.#registry.getSession(sessionId);
      const pendingWake =
        record === undefined
          ? undefined
          : this.#wakePromises.get(`${record.sessionId}:${record.generation}`);
      if (pendingWake === undefined) return;
      await pendingWake;
      host = this.#hosts.get(sessionId);
      if (host === undefined) return;
    }
    const captured = this.#registry.getSession(sessionId);
    if (captured === undefined) return;
    await host.drain();
    const current = this.#registry.getSession(sessionId);
    if (fence !== undefined) {
      if (
        current === undefined ||
        current.runtimeState !== "awake" ||
        current.generation !== fence.generation ||
        current.activityToken !== fence.activityToken ||
        current.sleepDeadlineMs !== fence.deadlineMs ||
        host.generation !== fence.generation ||
        this.#hosts.get(sessionId) !== host ||
        this.#wakePromises.has(`${sessionId}:${fence.generation}`)
      ) {
        return;
      }
    } else if (
      current === undefined ||
      current.runtimeState !== "awake" ||
      current.generation !== captured.generation ||
      current.activityToken !== captured.activityToken ||
      host.generation !== captured.generation ||
      this.#hosts.get(sessionId) !== host ||
      this.#wakePromises.has(`${sessionId}:${captured.generation}`)
    ) {
      throw new SessionHostError(
        "host_busy",
        `session activity changed during sleep: ${sessionId}`,
      );
    }
    if (enforceAuthority) {
      await this.#leaseArbiter.assertSleepRecoverAuthority({
        sessionId,
        attachmentId: authority?.attachmentId ?? "",
        ...(authority?.leaseId === undefined ? {} : { leaseId: authority.leaseId }),
        generation: authority?.generation ?? current.generation,
        nowMs: this.#now(),
      });
      const afterAuthority = this.#registry.getSession(sessionId);
      if (
        afterAuthority === undefined ||
        afterAuthority.runtimeState !== "awake" ||
        afterAuthority.generation !== current?.generation ||
        afterAuthority.activityToken !== current.activityToken ||
        this.#hosts.get(sessionId) !== host
      ) {
        throw new SessionHostError(
          "host_busy",
          `session activity changed during authority check: ${sessionId}`,
        );
      }
    }
    this.clearSleepTimer(sessionId);
    const preDisposeGeneration = current.generation;
    const preDisposeActivityToken = current.activityToken;
    const preDisposeDeadlineMs = current.sleepDeadlineMs;
    try {
      await host.shutdown(reason, () => {
        const preDispose = this.#registry.getSession(sessionId);
        if (
          preDispose === undefined ||
          preDispose.runtimeState !== "awake" ||
          preDispose.generation !== preDisposeGeneration ||
          preDispose.activityToken !== preDisposeActivityToken ||
          preDispose.sleepDeadlineMs !== preDisposeDeadlineMs ||
          host.generation !== preDisposeGeneration ||
          this.#hosts.get(sessionId) !== host ||
          this.#wakePromises.has(`${sessionId}:${preDisposeGeneration}`) ||
          this.#postSleepWakePromises.has(sessionId)
        ) {
          throw new SessionHostError(
            "host_busy",
            `session activity changed before disposal: ${sessionId}`,
          );
        }
      });
      const nowMs = this.#now();
      this.#registry.advanceSessionGeneration({
        sessionId,
        expectedGeneration: host.generation,
        runtimeState: "asleep",
        lastPhase: current.lastPhase,
        attention: current.attention,
        sleepDeadlineMs: null,
        updatedAtMs: nowMs,
      });
    } catch (error) {
      if (error instanceof SessionHostError && error.code === "host_busy") {
        const retained = this.#registry.getSession(sessionId);
        if (
          retained !== undefined &&
          retained.runtimeState === "awake" &&
          retained.generation === host.generation &&
          host.canArmSleep()
        ) {
          this.recordActivity(sessionId, host.generation, true);
        }
        throw error;
      }
      this.fenceFailedSleep(sessionId, host);
      throw error;
    }
    this.dropHostReferences(sessionId);
  }

  private fenceFailedSleep(sessionId: string, host: BoundSessionHost): void {
    host.fenceFailedSleep();
    const current = this.#registry.getSession(sessionId);
    if (
      current !== undefined &&
      current.generation === host.generation &&
      current.runtimeState === "awake"
    ) {
      this.#registry.setSessionState({
        sessionId,
        runtimeState: "awake",
        lastPhase: "failed",
        attention: "failed",
        updatedAtMs: this.#now(),
      });
    }
    this.dropHostReferences(sessionId);
  }

  private dropHostReferences(sessionId: string): void {
    this.#hosts.delete(sessionId);
    const uiBinding = this.#uiBindings.get(sessionId);
    uiBinding?.stopForwarding();
    this.#uiBindings.delete(sessionId);
  }

  private recordActivity(
    sessionId: string,
    generation: number,
    armSleep: boolean,
  ): void {
    const host = this.#hosts.get(sessionId);
    const current = this.#registry.getSession(sessionId);
    if (
      host === undefined ||
      host.generation !== generation ||
      current === undefined ||
      current.generation !== generation ||
      current.runtimeState !== "awake"
    ) {
      return;
    }
    const nowMs = this.#now();
    const sleepDeadlineMs =
      armSleep && host.canArmSleep()
        ? idleDeadlineMs(nowMs, current.sleepAfterMs)
        : null;
    const updated = this.#registry.recordSessionActivity({
      sessionId,
      expectedGeneration: generation,
      sleepDeadlineMs,
      updatedAtMs: nowMs,
    });
    if (sleepDeadlineMs === null) {
      this.clearSleepTimer(sessionId);
    } else {
      this.armSleepTimer(updated);
    }
  }

  private armSleepTimer(record: SessionRecord): void {
    this.clearSleepTimer(record.sessionId);
    if (
      this.#disposed ||
      record.runtimeState !== "awake" ||
      record.sleepDeadlineMs === null
    ) {
      return;
    }
    const timer: ArmedSleepTimer = {
      handle: setTimeout(() => {
        if (this.#sleepTimers.get(record.sessionId) !== timer) return;
        this.#sleepTimers.delete(record.sessionId);
        const current = this.#registry.getSession(record.sessionId);
        if (
          current !== undefined &&
          current.generation === timer.generation &&
          current.activityToken === timer.activityToken &&
          current.sleepDeadlineMs === timer.deadlineMs &&
          this.#now() < timer.deadlineMs
        ) {
          this.armSleepTimer(current);
          return;
        }
        if (this.#sleepPromises.has(record.sessionId)) return;
        const sleep = this.performSleep(
          record.sessionId,
          undefined,
          {
            generation: timer.generation,
            activityToken: timer.activityToken,
            deadlineMs: timer.deadlineMs,
          },
          "idle_timeout",
          false,
        ).catch((error: unknown) => {
          if (!(error instanceof SessionHostError) || error.code !== "host_busy") {
            throw error;
          }
        });
        this.#sleepPromises.set(record.sessionId, sleep);
        const clearSleep = (): void => {
          if (this.#sleepPromises.get(record.sessionId) === sleep) {
            this.#sleepPromises.delete(record.sessionId);
          }
        };
        void sleep.then(clearSleep, clearSleep);
      }, Math.min(MAX_TIMER_DELAY_MS, Math.max(0, record.sleepDeadlineMs - this.#now()))),
      generation: record.generation,
      activityToken: record.activityToken,
      deadlineMs: record.sleepDeadlineMs,
    };
    timer.handle.unref();
    this.#sleepTimers.set(record.sessionId, timer);
  }

  private clearSleepTimer(sessionId: string): void {
    const timer = this.#sleepTimers.get(sessionId);
    if (timer === undefined) return;
    clearTimeout(timer.handle);
    this.#sleepTimers.delete(sessionId);
  }


  dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise;
    this.#disposed = true;
    for (const sessionId of [...this.#sleepTimers.keys()]) {
      this.clearSleepTimer(sessionId);
    }
    this.#disposePromise = (async () => {
      const wakes = [...this.#wakePromises.values()];
      await Promise.allSettled(wakes);
      for (const sessionId of [...this.#hosts.keys()]) {
        const host = this.#hosts.get(sessionId);
        const record = this.#registry.getSession(sessionId);
        if (
          host !== undefined &&
          record !== undefined &&
          record.generation !== host.generation
        ) {
          if (!host.canArmSleep()) {
            throw new SessionHostError(
              "host_busy",
              `stale session host is not settled: ${sessionId}`,
            );
          }
          await host.disposeFailedWake();
          this.dropHostReferences(sessionId);
          continue;
        }
        for (let attempt = 0; ; attempt += 1) {
          try {
            await this.performSleep(sessionId, undefined, undefined, "explicit", false);
            break;
          } catch (error) {
            if (
              !(error instanceof SessionHostError) ||
              error.code !== "host_busy" ||
              attempt === 15
            ) {
              throw error;
            }
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        }
      }
      for (const ownership of this.#ownerships.values()) ownership.release();
      this.#ownerships.clear();
      this.#uiSubscribers.clear();
    })();
    return this.#disposePromise;
  }

  private async assertSdkCompatible(): Promise<void> {
    await assertSdkCompatible(this.#sdkCompatibility);
  }

  private async allocateHost(
    record: SessionRecord,
    generation: number,
  ): Promise<BoundSessionHost> {
    const queue = new HostQueue();
    const state: HostEventState = {
      committedSequence: 0,
      sdkEventSequence: 0,
      observerError: undefined,
      lastRunEvent: undefined,
      committedSubscribers: new Set(),
      sdkSubscribers: new Set(),
    };
    const ownership = this.retainOwnership(record, queue, generation);
    await this.assertSdkCompatible();
    ownership.verify();

    const manager = this.createManager(record);
    const rawManagerSessionFile = manager.getSessionFile();
    if (rawManagerSessionFile === undefined) {
      throw new SessionHostError(
        "sdk_incompatible",
        "sdk_incompatible: session manager has no ownership path",
      );
    }
    const managerSessionFile = canonicalizeSessionFilePath(rawManagerSessionFile);
    if (managerSessionFile !== ownership.sessionFile) {
      const reboundLock = this.#lockRegistry.acquire(managerSessionFile);
      try {
        const rebound = this.#registry.rebindSessionReservation({
          sessionId: record.sessionId,
          expectedSessionFile: record.sessionFile,
          sessionFile: reboundLock.sessionFile,
          nowMs: this.#now(),
        });
        ownership.retarget(rebound.sessionFile, reboundLock);
        this.#lockRegistry.acquire(rebound.sessionFile, record.sessionId);
      } catch (error) {
        reboundLock.release();
        throw error;
      }
    }
    const restorePersistenceFence = ownership.bindManager(manager);
    const entriesBeforeFactory = new Set(
      manager.getEntries().map(({ id }) => id),
    );
    let materialized = record.fileMaterialized;
    const observer = observeSessionManagerPersistence(
      manager,
      ({ entry }) => {
        void queue.enqueue(async () => {
          if (!materialized) {
            this.#registry.markSessionMaterialized(record.sessionId, this.#now());
            materialized = true;
          }
          const signal = committedStateSignal(entry);
          if (signal !== undefined) await sessionState.apply(signal);
          state.committedSequence += 1;
          publishSafely(state.committedSubscribers, {
            sequence: state.committedSequence,
            sessionId: record.sessionId,
            cursor: { entryId: entry.id },
            entry,
          });
        });
      },
      (error) => {
        state.observerError = error;
      },
    );
    const stateMachine = new SessionStateMachine({
      runtime: "awake",
      phase: record.lastPhase,
      attention: record.attention,
      fatalFailure: record.failureCode !== null,
    });
    let indexActive = false;
    const sessionState = new HostStateCoordinator({
      sessionId: record.sessionId,
      generation,
      epoch: record.epoch,
      machine: stateMachine,
      now: () => new Date(this.#now()),
      persistTransition: (data) => {
        ownership.verify();
        return appendDaemonCustomEntry(manager, "pi-daemon/phase", data);
      },
      updateIndex: (snapshot) => {
        if (!indexActive) return;
        this.#registry.setSessionState({
          sessionId: record.sessionId,
          runtimeState: snapshot.runtime,
          lastPhase: snapshot.phase,
          attention: snapshot.attention,
          updatedAtMs: this.#now(),
        });
      },
    });

    let session: AgentSession | undefined;
    let unsubscribeSdk: (() => void) | undefined;
    let bound = false;
    const ui = new DaemonExtensionUi();
    const stopForwarding = ui.subscribe((frame) => {
      const subscribers = this.#uiSubscribers.get(record.sessionId);
      if (subscribers !== undefined) publishSafely(subscribers, frame);
      void queue.enqueue(async () => {
        if (frame.kind === "request") {
          await sessionState.apply({
            type: "question_opened",
            question: {
              questionId: frame.questionId,
              method: frame.method,
              title: frame.title,
            },
          });
        } else if (frame.kind === "phase") {
          await sessionState.apply({
            type: "questions",
            pendingQuestionIds: frame.pendingQuestionIds,
          });
        }
        if (indexActive) {
          this.recordActivity(
            record.sessionId,
            generation,
            frame.kind === "phase" && frame.pendingQuestionIds.length === 0,
          );
        }
      });
    });
    this.#uiBindings.set(record.sessionId, { ui, stopForwarding });
    try {
      const settingsManager =
        this.#sessionOptions?.settingsManager ??
        SettingsManager.create(record.cwd, this.#agentDir);
      const resourceLoader = new DefaultResourceLoader({
        ...this.#resourceLoaderOptions,
        cwd: record.cwd,
        agentDir: this.#agentDir,
        settingsManager,
      });
      await resourceLoader.reload();
      const created = await createAgentSession({
        ...this.#sessionOptions,
        cwd: record.cwd,
        agentDir: this.#agentDir,
        settingsManager,
        resourceLoader,
        sessionManager: manager,
      });
      session = created.session;
      if (
        session.sessionManager !== manager ||
        session.sessionId !== record.sessionId
      ) {
        throw new SessionHostError(
          "sdk_incompatible",
          "sdk_incompatible: createAgentSession changed the injected session identity",
        );
      }

      const sdkPrompt = session.prompt.bind(session);
      session.prompt = async (text, options) => {
        await queue.enqueue(() => {
          ownership.verify();
          sessionState.assertHealthy();
        });
        if (indexActive) this.recordActivity(record.sessionId, generation, false);
        try {
          await sdkPrompt(text, options);
        } finally {
          await queue.enqueue(() => {
            ownership.verify();
            sessionState.assertHealthy();
          });
          if (indexActive) {
            await queue.enqueue(() =>
              this.recordActivity(record.sessionId, generation, true),
            );
          }
        }
      };

      unsubscribeSdk = session.subscribe((event) => {
        void queue.enqueue(async () => {
          const signal = sdkStateSignal(event);
          if (signal !== undefined) await sessionState.apply(signal);
          if (
            event.type === "agent_start" ||
            event.type === "agent_end" ||
            event.type === "agent_settled"
          ) {
            state.lastRunEvent = event.type;
          }
          if (indexActive) {
            this.recordActivity(
              record.sessionId,
              generation,
              event.type === "agent_settled",
            );
          }
          state.sdkEventSequence += 1;
          publishSafely(state.sdkSubscribers, {
            sequence: state.sdkEventSequence,
            sessionId: record.sessionId,
            event,
          });
        });
      });
      const commandContextActions: ExtensionCommandContextActions = {
        waitForIdle: () => session?.waitForIdle() ?? Promise.resolve(),
        newSession: async () => rejectIdentityReplacement(ui, "newSession"),
        fork: async () => rejectIdentityReplacement(ui, "fork"),
        navigateTree: async () => {
          ui.context.notify(
            "navigateTree is unavailable until daemon epoch updates are bound",
            "warning",
          );
          return { cancelled: true };
        },
        switchSession: async () => rejectIdentityReplacement(ui, "switchSession"),
        reload: async () => {
          await queue.enqueue(async () => {
            sessionState.assertHealthy();
            await session?.reload();
          });
        },
      };
      await session.bindExtensions({
        uiContext: ui.context,
        mode: "rpc",
        commandContextActions,
      });
      bound = true;

      const factoryEntryIds = manager
        .getEntries()
        .filter(({ id }) => !entriesBeforeFactory.has(id))
        .map(({ id }) => id);
      if (
        factoryEntryIds.some(
          (entryId) => !observer.observedPersistEntryIds.has(entryId),
        )
      ) {
        throw new SessionHostError(
          "sdk_incompatible",
          "sdk_incompatible: factory-time entries bypassed the persistence observer",
        );
      }
      await queue.drain();
      if (state.observerError !== undefined) {
        throw new SessionHostError(
          "sdk_incompatible",
          `sdk_incompatible: persistence observation failed: ${errorMessage(state.observerError)}`,
        );
      }

      return new BoundSessionHost({
        generation,
        epoch: record.epoch,
        sleepAfterMs: record.sleepAfterMs,
        session,
        resourceLoader,
        ui,
        queue,
        state,
        sessionState,
        observer,
        monitor: ownership,
        restorePersistenceFence,
        unsubscribeSdk,
        activateIndex: () => {
          indexActive = true;
        },
        onActivity: (armSleep) =>
          this.recordActivity(record.sessionId, generation, armSleep),
        now: this.#now,
      });
    } catch (error) {
      sessionState.close();
      this.#uiBindings.delete(record.sessionId);
      stopForwarding();
      ui.close();
      try {
        if (session !== undefined && bound) {
          await session.extensionRunner.emit({
            type: "session_shutdown",
            reason: "quit",
          });
        }
      } catch {
        // Preserve the allocation failure while still disposing every partial resource.
      } finally {
        try {
          unsubscribeSdk?.();
          session?.dispose();
        } finally {
          observer.stop();
          restorePersistenceFence();
        }
      }
      throw error;
    }
  }
  private retainOwnership(
    record: SessionRecord,
    queue: HostQueue,
    generation: number,
  ): ExternalWriterMonitor {
    const existing = this.#ownerships.get(record.sessionId);
    if (existing !== undefined) {
      existing.useQueue(queue, generation);
      existing.verify();
      return existing;
    }

    // Interactive pi does not honor this sidecar. Operators must not open a
    // daemon-hosted session in interactive pi.
    const lockByPath = this.#lockRegistry.getBySessionFile(record.sessionFile);
    const lockBySession = this.#lockRegistry.getBySessionId(record.sessionId);
    if (lockByPath === undefined || lockByPath !== lockBySession) {
      throw new SessionHostError(
        "external_writer",
        `external_writer: session sidecar is not held: ${record.sessionId}`,
      );
    }
    lockByPath.assertHeld();
    try {
      const ownership = new ExternalWriterMonitor({
        sessionId: record.sessionId,
        generation,
        epoch: record.epoch,
        sessionFile: record.sessionFile,
        lock: lockByPath,
        queue,
        registry: this.#registry,
        emit: (frame) => this.#onExternalWriter?.(frame),
        onDetected: () => this.handleExternalWriter(record.sessionId),
      });
      this.#ownerships.set(record.sessionId, ownership);
      return ownership;
    } catch (error) {
      lockByPath.release();
      throw error;
    }
  }

  private handleExternalWriter(sessionId: string): void {
    const host = this.#hosts.get(sessionId);
    host?.failExternalWriter();
    this.#hosts.delete(sessionId);
    const uiBinding = this.#uiBindings.get(sessionId);
    uiBinding?.stopForwarding();
    this.#uiBindings.delete(sessionId);
    this.#ownerships.delete(sessionId);
  }

  private createManager(record: SessionRecord): SessionManager {
    if (record.fileMaterialized) {
      const manager = SessionManager.open(
        record.sessionFile,
        dirname(record.sessionFile),
      );
      this.assertManagerIdentity(manager, record.sessionId, record.cwd);
      return manager;
    }

    const manager = SessionManager.create(
      record.cwd,
      dirname(record.sessionFile),
      { id: record.sessionId },
    );
    this.assertManagerIdentity(manager, record.sessionId, record.cwd);
    if (manager.getSessionFile() === undefined) {
      throw new SessionHostError(
        "sdk_incompatible",
        "sdk_incompatible: SessionManager.create returned no planned path",
      );
    }
    return manager;
  }

  private assertManagerIdentity(
    manager: SessionManager,
    sessionId: string,
    cwd: string,
  ): void {
    if (manager.getSessionId() !== sessionId || manager.getCwd() !== cwd) {
      throw new SessionHostError(
        "sdk_incompatible",
        "sdk_incompatible: SessionManager did not preserve the registered identity",
      );
    }
  }
}
