import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import {
  STAMPED_HOST_SDK_VERSION,
  defaultHostSdkCompatibility,
  type HostSdkCompatibility,
  type SessionHostControllerOptions,
} from "../host/index.js";
import {
  createDiagnosticLogger,
  createFileLogSink,
  type DiagnosticLogger,
  type DiagnosticLogSink,
} from "../logging/index.js";
import { Registry, resolveDaemonPaths } from "../registry/index.js";
import {
  SingletonLockContendedError,
  acquireSingletonLockWithRecovery,
  getProcessStartIdentity,
  type SingletonLockRecord,
} from "../registry/singleton-lock.js";
import {
  DEFAULT_PROTOCOL_VERSION,
  createServer,
  resolveSocketPath,
  type UnixSocketServer,
} from "../server/index.js";
import {
  createDaemonDispatch,
  type DaemonDispatchRuntime,
  type DaemonShutdownRequest,
} from "./dispatch.js";

const packageJson: unknown = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);
if (
  packageJson === null ||
  typeof packageJson !== "object" ||
  !("version" in packageJson) ||
  typeof packageJson.version !== "string" ||
  packageJson.version.length === 0
) {
  throw new Error("pi-daemon package has no string version");
}
export const DAEMON_VERSION: string = packageJson.version;
const DAEMON_LAUNCH_PATH = fileURLToPath(import.meta.url);
export const GATE_MODEL_RUNTIME_MODULE_ENV = "PI_DAEMON_MODEL_RUNTIME_MODULE";

/** Result required from an explicitly enabled gate model-runtime module. */
export interface GateModelRuntimeFactoryResult {
  readonly modelRuntime: ModelRuntime;
}

/**
 * Export contract for the absolute ESM path in PI_DAEMON_MODEL_RUNTIME_MODULE.
 * Gate modules receive the daemon environment and must return a ready ModelRuntime.
 */
export type GateModelRuntimeFactory = (
  environment: NodeJS.ProcessEnv,
) => GateModelRuntimeFactoryResult | Promise<GateModelRuntimeFactoryResult>;

export class GateModelRuntimeStartupError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "GateModelRuntimeStartupError";
    if (cause !== undefined) this.cause = cause;
  }
}

export interface RunDaemonOptions {
  readonly stateDir?: string;
  readonly socketPath?: string;
  readonly agentDir?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  readonly daemonVersion?: string;
  readonly sdkVersion?: string;
  readonly sdkCompatibility?: HostSdkCompatibility;
  readonly protocolVersion?: string;
  readonly logSink?: DiagnosticLogSink;
  readonly logNow?: () => Date;
  readonly sessionOptions?: SessionHostControllerOptions["sessionOptions"];
  readonly resourceLoaderOptions?: SessionHostControllerOptions["resourceLoaderOptions"];
}

export interface DaemonTermination {
  readonly reason: "close" | "shutdown";
  readonly exitCode: 0 | 1;
  readonly deadlineExceeded: boolean;
}

export interface RunningDaemon {
  readonly instanceId: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly stateDir: string;
  readonly socketPath: string;
  readonly finished: Promise<DaemonTermination>;
  close(): Promise<void>;
}

export class DaemonAlreadyRunningError extends Error {
  readonly code = "EEXIST";
  readonly owner: SingletonLockRecord;

  constructor(owner: SingletonLockRecord) {
    super(`pi-daemon is already running with pid ${owner.pid}`);
    this.name = "DaemonAlreadyRunningError";
    this.owner = owner;
  }
}

export class DaemonStartupError extends Error {
  readonly elected = true;
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super("elected daemon owner failed during startup");
    this.name = "DaemonStartupError";
    this.cause = cause;
  }
}

export async function runDaemon(options: RunDaemonOptions = {}): Promise<RunningDaemon> {
  const environment = options.environment ?? process.env;
  const sessionOptions = await resolveSessionOptions(options.sessionOptions, environment);
  const homeDirectory = options.homeDirectory ?? environment.HOME ?? homedir();
  const stateDir =
    options.stateDir ??
    environment.PI_DAEMON_STATE_DIR ??
    resolve(environment.XDG_STATE_HOME ?? resolve(homeDirectory, ".local", "state"), "pi-daemon");
  const paths = resolveDaemonPaths({ stateDir, environment });
  const socketPath =
    options.socketPath ?? resolveSocketPath({ environment, homeDirectory });
  const agentDir = resolve(
    options.agentDir ?? environment.PI_DAEMON_AGENT_DIR ?? resolve(homeDirectory, ".pi", "agent"),
  );
  const instanceId = randomUUID();
  const startedAt = new Date().toISOString();
  const daemonVersion = options.daemonVersion ?? DAEMON_VERSION;
  const sdkVersion = options.sdkVersion ?? STAMPED_HOST_SDK_VERSION;
  const sdkCompatibility = options.sdkCompatibility ?? defaultHostSdkCompatibility;
  const protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
  const lockRecord: SingletonLockRecord = {
    pid: process.pid,
    processStartIdentity: getProcessStartIdentity(),
    daemonInstanceId: instanceId,
    stateDir: paths.stateDir,
    socketPath,
    createdAt: startedAt,
  };

  let singletonLock;
  try {
    singletonLock = await acquireSingletonLockWithRecovery(paths.lockPath, lockRecord);
  } catch (error) {
    if (error instanceof SingletonLockContendedError) {
      throw new DaemonAlreadyRunningError(error.owner);
    }
    throw error;
  }

  let logger: DiagnosticLogger | undefined;
  let registry: Registry | undefined;
  let dispatchRuntime: DaemonDispatchRuntime | undefined;
  let server: UnixSocketServer | undefined;
  let closePromise: Promise<void> | undefined;
  let protocolShutdownPromise: Promise<void> | undefined;
  let shutdownDeadlineExceeded = false;
  let termination: DaemonTermination | undefined;
  let resolveFinished!: (result: DaemonTermination) => void;
  const finished = new Promise<DaemonTermination>((resolveFinishedPromise) => {
    resolveFinished = resolveFinishedPromise;
  });
  const settleTermination = (result: DaemonTermination): void => {
    if (termination !== undefined) return;
    termination = result;
    resolveFinished(result);
  };

  const closeResources = async (): Promise<void> => {
    let failure: unknown;
    try {
      await server?.close();
    } catch (error) {
      failure = error;
    }
    try {
      await dispatchRuntime?.dispose();
    } catch (error) {
      failure ??= error;
    }
    try {
      if (failure === undefined && !shutdownDeadlineExceeded) registry?.setCleanShutdown(true);
      registry?.close();
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) throw failure;
    if (!shutdownDeadlineExceeded) logger?.emit({ kind: "shutdown_clean" });
    singletonLock.release();
  };

  const closeDaemon = (reason: DaemonTermination["reason"]): Promise<void> => {
    closePromise ??= closeResources().then(
      () => {
        settleTermination({ reason, exitCode: 0, deadlineExceeded: false });
      },
      (error: unknown) => {
        settleTermination({ reason, exitCode: 1, deadlineExceeded: false });
        throw error;
      },
    );
    return closePromise;
  };

  const beginProtocolShutdown = (request: DaemonShutdownRequest): void => {
    protocolShutdownPromise ??= (async () => {
      logger?.emit({ kind: "shutdown_started" });
      try {
        server?.stopAccepting();
        const settled = await completeBeforeDeadline(
          dispatchRuntime?.drain() ?? Promise.resolve(),
          request.deadlineMs,
        );
        if (!settled) {
          shutdownDeadlineExceeded = true;
          logger?.emit({ kind: "shutdown_deadline" });
          settleTermination({
            reason: "shutdown",
            exitCode: 1,
            deadlineExceeded: true,
          });
          return;
        }
        const closed = await completeBeforeDeadline(
          closeDaemon("shutdown"),
          request.deadlineMs,
        );
        if (!closed) {
          shutdownDeadlineExceeded = true;
          logger?.emit({ kind: "shutdown_deadline" });
          settleTermination({
            reason: "shutdown",
            exitCode: 1,
            deadlineExceeded: true,
          });
        }
      } catch {
        logger?.emit({ kind: "shutdown_failed" });
        settleTermination({
          reason: "shutdown",
          exitCode: 1,
          deadlineExceeded: false,
        });
      }
    })();
  };

  try {
    logger = createDiagnosticLogger({
      daemonInstanceId: instanceId,
      sink:
        options.logSink ??
        createFileLogSink({ path: resolve(paths.stateDir, "log", "pi-daemon.jsonl") }),
      ...(options.logNow === undefined ? {} : { now: options.logNow }),
    });
    logger.emit({ kind: "daemon_starting" });
    await mkdir(agentDir, { recursive: true });
    registry = Registry.open({
      databasePath: paths.registryPath,
      lock: singletonLock,
      daemonInstanceId: instanceId,
      startedAt,
      sdkStamp: sdkVersion,
      protocolVersion,
    });
    dispatchRuntime = createDaemonDispatch({
      registry,
      agentDir,
      daemon: {
        pid: process.pid,
        startedAt,
        version: daemonVersion,
        sdkVersion,
        protocolVersion,
        socketPath,
        launchPath: DAEMON_LAUNCH_PATH,
      },
      onShutdownAccepted: beginProtocolShutdown,
      ...(sessionOptions === undefined ? {} : { sessionOptions }),
      ...(options.resourceLoaderOptions === undefined
        ? {}
        : { resourceLoaderOptions: options.resourceLoaderOptions }),
      sdkCompatibility,
    });
    await dispatchRuntime.restoreAfterCrash();
    server = createServer({
      socketPath,
      daemonVersion,
      sdkVersion,
      protocolVersion,
      dispatch: dispatchRuntime.dispatch,
    });
    await server.listen();
    logger.emit({ kind: "daemon_ready" });
  } catch (error) {
    logger?.emit({
      kind: hasErrorCode(error, "sdk_incompatible")
        ? "startup_sdk_incompatible"
        : "startup_failed",
    });
    if (await closeStartupResources(server, dispatchRuntime, registry)) {
      singletonLock.release();
    }
    throw new DaemonStartupError(error);
  }

  return {
    instanceId,
    pid: process.pid,
    startedAt,
    stateDir: paths.stateDir,
    socketPath,
    finished,
    close(): Promise<void> {
      return closeDaemon("close");
    },
  };
}

async function resolveSessionOptions(
  sessionOptions: RunDaemonOptions["sessionOptions"],
  environment: NodeJS.ProcessEnv,
): Promise<RunDaemonOptions["sessionOptions"]> {
  const modulePath = environment[GATE_MODEL_RUNTIME_MODULE_ENV];
  if (modulePath === undefined || sessionOptions?.modelRuntime !== undefined) {
    return sessionOptions;
  }
  if (!isAbsolute(modulePath)) {
    throw new GateModelRuntimeStartupError(
      `${GATE_MODEL_RUNTIME_MODULE_ENV} must be an absolute ESM module path`,
    );
  }

  let moduleNamespace: Record<string, unknown>;
  try {
    moduleNamespace = (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>;
  } catch (error) {
    throw new GateModelRuntimeStartupError(
      `failed to import ${GATE_MODEL_RUNTIME_MODULE_ENV} module at ${modulePath}: ${errorMessage(error)}`,
      error,
    );
  }

  const factory = moduleNamespace.createGateModelRuntime;
  if (typeof factory !== "function") {
    throw new GateModelRuntimeStartupError(
      `${GATE_MODEL_RUNTIME_MODULE_ENV} module must export async function createGateModelRuntime(environment) returning { modelRuntime }`,
    );
  }

  let result: unknown;
  try {
    result = await factory(environment);
  } catch (error) {
    throw new GateModelRuntimeStartupError(
      `${GATE_MODEL_RUNTIME_MODULE_ENV} createGateModelRuntime failed: ${errorMessage(error)}`,
      error,
    );
  }
  if (
    typeof result !== "object" ||
    result === null ||
    !("modelRuntime" in result) ||
    !(result.modelRuntime instanceof ModelRuntime)
  ) {
    throw new GateModelRuntimeStartupError(
      `${GATE_MODEL_RUNTIME_MODULE_ENV} createGateModelRuntime must return { modelRuntime: ModelRuntime }`,
    );
  }

  return { ...sessionOptions, modelRuntime: result.modelRuntime };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
}

async function completeBeforeDeadline(
  work: Promise<void>,
  deadlineMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolveDeadline) => {
    timer = setTimeout(
      () => resolveDeadline(false),
      Math.max(0, deadlineMs - Date.now()),
    );
  });
  try {
    return await Promise.race([work.then(() => true as const), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function closeStartupResources(
  server: UnixSocketServer | undefined,
  dispatchRuntime: DaemonDispatchRuntime | undefined,
  registry: Registry | undefined,
): Promise<boolean> {
  let closed = true;
  try {
    await server?.close();
  } catch {
    closed = false;
  }
  try {
    await dispatchRuntime?.dispose();
  } catch {
    closed = false;
  }
  try {
    registry?.close();
  } catch {
    closed = false;
  }
  return closed;
}
