import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import {
  DaemonRequestError,
  connectDaemon,
  type DaemonClient,
} from "../client/index.js";
import { DAEMON_VERSION, runDaemon } from "../daemon/bootstrap.js";
import { STAMPED_HOST_SDK_VERSION } from "../host/sdk-stamp.js";
import { runTui } from "../tui/index.js";

const CONNECTION_TIMEOUT_MS = 300;
const STOP_CLEANUP_ALLOWANCE_MS = 1_000;

export interface CliIo {
  readonly environment?: NodeJS.ProcessEnv;
  readonly stdout?: (value: string) => void;
  readonly stderr?: (value: string) => void;
}

interface ResolvedCliIo {
  readonly environment: NodeJS.ProcessEnv;
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export async function runCli(argv: readonly string[], io: CliIo = {}): Promise<number> {
  const resolvedIo: ResolvedCliIo = {
    environment: io.environment ?? process.env,
    stdout: io.stdout ?? ((value) => process.stdout.write(value)),
    stderr: io.stderr ?? ((value) => process.stderr.write(value)),
  };

  try {
    const [command, ...args] = argv;
    if (command === undefined) throw new CliUsageError("a command is required");
    switch (command) {
      case "tui":
        if (args.length !== 0) throw new CliUsageError("usage: pi-daemon tui");
        await runTui({ environment: resolvedIo.environment });
        return 0;
      case "start":
        return await startCommand(args, resolvedIo);
      case "stop":
        return await stopCommand(args, resolvedIo);
      case "status":
        return await statusCommand(args, resolvedIo);
      case "list":
        return await listCommand(args, resolvedIo);
      case "open":
        return await openCommand(args, resolvedIo);
      case "sleep":
      case "wake":
        return await lifecycleCommand(command, args, resolvedIo);
      default:
        throw new CliUsageError(`unknown command: ${command}`);
    }
  } catch (error) {
    if (error instanceof CliUsageError) {
      writeJson(resolvedIo.stderr, { error: "bad_args", message: error.message });
      return 2;
    }
    writeJson(resolvedIo.stderr, {
      error: error instanceof DaemonRequestError ? error.code : "operation_failed",
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}

async function startCommand(args: readonly string[], io: ResolvedCliIo): Promise<number> {
  if (
    args.length > 1 ||
    (args.length === 1 && args[0] !== "--foreground" && args[0] !== "--replace")
  ) {
    throw new CliUsageError("usage: pi-daemon start [--foreground | --replace]");
  }
  const foreground = args[0] === "--foreground";
  const replace = args[0] === "--replace";
  if (!foreground) {
    let client = await connect(io.environment, true);
    try {
      let result = await client.request("status", { verbose: replace });
      if (!("daemon" in result)) throw new Error("daemon returned session status without a session");
      if (client.hello.sdkVersion !== STAMPED_HOST_SDK_VERSION && replace) {
        const busy =
          result.sessions === undefined ||
          result.sessions.some(
            ({ observedPhase }) => observedPhase === "working" || observedPhase === "blocked",
          ) ||
          typeof result.counts.readers !== "number" ||
          result.counts.readers > 0;
        if (busy) {
          writeJson(io.stdout, incompatibleSdk(result.daemon, true));
          return 1;
        }
        try {
          const shutdown = await client.request("shutdown", { ifIdle: true });
          client.close();
          const released = await waitForPathToDisappear(
            resolveStatePath(io.environment, "daemon.lock"),
            Date.parse(shutdown.deadline) + STOP_CLEANUP_ALLOWANCE_MS,
          );
          if (!released) {
            writeJson(io.stdout, {
              ...incompatibleSdk(result.daemon),
              message: "daemon did not exit before shutdown deadline",
            });
            return 1;
          }
        } catch (error) {
          if (error instanceof DaemonRequestError && error.code === "busy") {
            writeJson(io.stdout, incompatibleSdk(result.daemon, true));
            return 1;
          }
          if (error instanceof DaemonRequestError && error.code === "invalid_request") {
            writeJson(io.stdout, {
              ...incompatibleSdk(result.daemon),
              message: "daemon does not support guarded replacement; stop it manually when idle, then start",
            });
            return 1;
          }
          throw error;
        }
        client = await connect(io.environment, true);
        result = await client.request("status", {});
        if (!("daemon" in result)) throw new Error("daemon returned session status without a session");
      }
      if (client.hello.sdkVersion !== STAMPED_HOST_SDK_VERSION) {
        writeJson(io.stdout, incompatibleSdk(result.daemon));
        return 1;
      }
      writeJson(io.stdout, { status: "healthy", ...result });
      return 0;
    } finally {
      client.close();
    }
  }

  const daemon = await runDaemon({ environment: io.environment });
  const client = await connect(io.environment, false);
  try {
    const result = await client.request("status", {});
    if (!("daemon" in result)) throw new Error("daemon returned session status without a session");
    writeJson(io.stdout, { status: "healthy", ...result });
  } finally {
    client.close();
  }
  const closeOnSignal = (): void => {
    void daemon.close().catch(() => undefined);
  };
  process.once("SIGINT", closeOnSignal);
  process.once("SIGTERM", closeOnSignal);
  try {
    const outcome = await daemon.finished;
    return outcome.exitCode;
  } finally {
    process.off("SIGINT", closeOnSignal);
    process.off("SIGTERM", closeOnSignal);
  }
}

async function stopCommand(args: readonly string[], io: ResolvedCliIo): Promise<number> {
  let graceMs: number | undefined;
  if (args.length > 0) {
    if (args.length !== 2 || args[0] !== "--grace-ms") {
      throw new CliUsageError("usage: pi-daemon stop [--grace-ms N]");
    }
    graceMs = nonNegativeInteger(args[1], "--grace-ms");
  }

  const client = await connect(io.environment, false);
  try {
    const result = await client.request(
      "shutdown",
      graceMs === undefined ? {} : { graceMs },
    );
    client.close();
    const lockReleased = await waitForPathToDisappear(
      resolveStatePath(io.environment, "daemon.lock"),
      Date.parse(result.deadline) + STOP_CLEANUP_ALLOWANCE_MS,
    );
    if (!lockReleased) {
      writeJson(io.stdout, {
        status: "deadline_exceeded",
        deadline: result.deadline,
      });
      return 1;
    }
    writeJson(io.stdout, { status: "stopped", deadline: result.deadline });
    return 0;
  } finally {
    client.close();
  }
}

async function statusCommand(args: readonly string[], io: ResolvedCliIo): Promise<number> {
  if (args.length !== 0) throw new CliUsageError("usage: pi-daemon status");
  let client: DaemonClient;
  try {
    client = await connect(io.environment, false);
  } catch (error) {
    if (error instanceof DaemonRequestError && error.code === "protocol_mismatch") {
      writeJson(io.stdout, {
        status: "incompatible",
        reason: "protocol_mismatch",
        message: error.message,
      });
      return 1;
    }
    if (!isConnectionUnavailable(error)) throw error;
    const lock = await inspectSingletonLock(resolveStatePath(io.environment, "daemon.lock"));
    if (lock === undefined) {
      writeJson(io.stdout, { status: "stopped" });
      return 1;
    }
    if (lock.valid && (await processIdentity(lock.pid)) === lock.processStartIdentity) {
      writeJson(io.stdout, {
        status: "busy",
        reason: "owner_unreachable",
        owner: { pid: lock.pid, daemonInstanceId: lock.daemonInstanceId },
      });
      return 1;
    }
    writeJson(io.stdout, {
      status: "stale",
      ...(lock.valid
        ? { owner: { pid: lock.pid, daemonInstanceId: lock.daemonInstanceId } }
        : { reason: "invalid_lock" }),
    });
    return 1;
  }

  try {
    const result = await client.request("status", { verbose: true });
    if (!("daemon" in result)) throw new Error("daemon returned session status without a session");
    if (client.hello.sdkVersion !== STAMPED_HOST_SDK_VERSION) {
      writeJson(io.stdout, incompatibleSdk(result.daemon));
      return 1;
    }
    const busy = result.sessions?.some(
      ({ observedPhase }) => observedPhase === "working" || observedPhase === "blocked",
    );
    writeJson(io.stdout, { status: busy === true ? "busy" : "healthy", ...result });
    return busy === true ? 1 : 0;
  } finally {
    client.close();
  }
}

function incompatibleSdk(
  daemon: { readonly pid: number; readonly sdkVersion: string },
  busy = false,
) {
  return {
    status: "incompatible",
    reason: "sdk_version",
    expectedSdkVersion: STAMPED_HOST_SDK_VERSION,
    daemon,
    hint: "pi-daemon start --replace",
    ...(busy
      ? { busy: true, message: "daemon has active work or attached readers; replacement refused" }
      : {}),
  };
}

async function openCommand(args: readonly string[], io: ResolvedCliIo): Promise<number> {
  let path: string | undefined;
  let sessionId: string | undefined;
  let cwdOverride: string | undefined;
  let name: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (value === undefined) {
      throw new CliUsageError(
        "usage: pi-daemon open (--path PATH | --session-id ID) [--cwd PATH] [--name NAME]",
      );
    }
    switch (argument) {
      case "--path":
        path = value;
        break;
      case "--session-id":
        sessionId = value;
        break;
      case "--cwd":
        cwdOverride = value;
        break;
      case "--name":
        name = value;
        break;
      default:
        throw new CliUsageError(
          "usage: pi-daemon open (--path PATH | --session-id ID) [--cwd PATH] [--name NAME]",
        );
    }
    index += 1;
  }
  if ((path === undefined) === (sessionId === undefined)) {
    throw new CliUsageError("open requires exactly one of --path or --session-id");
  }
  const params = {
    ...(path === undefined ? { sessionId: sessionId as string } : { path }),
    ...(cwdOverride === undefined ? {} : { cwdOverride }),
    ...(name === undefined ? {} : { name }),
  };
  const client = await connect(io.environment, true);
  try {
    const result = await client.request("open", params);
    writeJson(io.stdout, result);
    return 0;
  } finally {
    client.close();
  }
}

async function lifecycleCommand(
  operation: "sleep" | "wake",
  args: readonly string[],
  io: ResolvedCliIo,
): Promise<number> {
  if (args.length !== 1 || args[0] === undefined || args[0].length === 0) {
    throw new CliUsageError(`usage: pi-daemon ${operation} SESSION`);
  }
  const sessionId = args[0];
  const client = await connect(io.environment, true);
  let attachmentId: string | undefined;
  try {
    const attached = await client.request("attach", { live: false }, sessionId);
    attachmentId = attached.attachmentId;
    const result =
      operation === "wake"
        ? await client.request(
            "wake",
            {
              attachmentId,
              generation: attached.session.generation,
              reason: "cli",
            },
            sessionId,
          )
        : await client.request(
            "sleep",
            {
              attachmentId,
              generation: attached.session.generation,
              reason: "cli",
            },
            sessionId,
          );
    writeJson(io.stdout, result);
    return 0;
  } finally {
    if (attachmentId !== undefined) {
      await client.request("detach", { attachmentId }, sessionId).catch(() => undefined);
    }
    client.close();
  }
}

async function listCommand(args: readonly string[], io: ResolvedCliIo): Promise<number> {
  let cwd: string | undefined;
  const phases: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === "--cwd" && value !== undefined) {
      cwd = value;
      index += 1;
    } else if (argument === "--phase" && value !== undefined) {
      phases.push(value);
      index += 1;
    } else {
      throw new CliUsageError("usage: pi-daemon list [--phase PHASE] [--cwd PATH]");
    }
  }
  const allowedPhases = ["idle", "working", "blocked", "failed", "gone", "asleep"];
  if (phases.some((phase) => !allowedPhases.includes(phase))) {
    throw new CliUsageError("--phase must be idle, working, blocked, failed, gone, or asleep");
  }

  const client = await connect(io.environment, true);
  try {
    const result = await client.request("list", {
      ...(phases.length === 0
        ? {}
        : {
            phase: phases as Array<
              "idle" | "working" | "blocked" | "failed" | "gone" | "asleep"
            >,
          }),
      ...(cwd === undefined ? {} : { cwd }),
    });
    writeJson(io.stdout, result);
    return 0;
  } finally {
    client.close();
  }
}

async function connect(
  environment: NodeJS.ProcessEnv,
  autoSpawn: boolean,
): Promise<DaemonClient> {
  return await connectDaemon({
    environment,
    autoSpawn,
    startupTimeoutMs: autoSpawn ? 10_000 : CONNECTION_TIMEOUT_MS,
    client: { name: "pi-daemon-cli", version: DAEMON_VERSION },
  });
}

function resolveStatePath(environment: NodeJS.ProcessEnv, name: string): string {
  const home = environment.HOME ?? homedir();
  const stateDir =
    environment.PI_DAEMON_STATE_DIR ??
    resolve(environment.XDG_STATE_HOME ?? resolve(home, ".local", "state"), "pi-daemon");
  return resolve(stateDir, name);
}

async function waitForPathToDisappear(path: string, deadlineMs: number): Promise<boolean> {
  for (;;) {
    try {
      await access(path);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return true;
      throw error;
    }
    if (Date.now() >= deadlineMs) return false;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
}

function nonNegativeInteger(value: string | undefined, field: string): number {
  if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new CliUsageError(`${field} must be a non-negative safe integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new CliUsageError(`${field} must be a non-negative safe integer`);
  }
  return parsed;
}

type InspectedSingletonLock =
  | { readonly valid: false }
  | {
      readonly valid: true;
      readonly pid: number;
      readonly processStartIdentity: string;
      readonly daemonInstanceId: string;
    };

async function inspectSingletonLock(path: string): Promise<InspectedSingletonLock | undefined> {
  let encoded: string;
  try {
    encoded = await readFile(path, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
  try {
    const decoded = JSON.parse(encoded) as unknown;
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
      return { valid: false };
    }
    const record = decoded as Record<string, unknown>;
    if (
      typeof record.pid !== "number" ||
      !Number.isSafeInteger(record.pid) ||
      record.pid <= 0 ||
      typeof record.processStartIdentity !== "string" ||
      record.processStartIdentity.length === 0 ||
      typeof record.daemonInstanceId !== "string" ||
      record.daemonInstanceId.length === 0
    ) {
      return { valid: false };
    }
    return {
      valid: true,
      pid: record.pid,
      processStartIdentity: record.processStartIdentity,
      daemonInstanceId: record.daemonInstanceId,
    };
  } catch {
    return { valid: false };
  }
}

async function processIdentity(pid: number): Promise<string | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd === -1) return undefined;
    const startTime = stat.slice(commandEnd + 2).trim().split(/\s+/)[19];
    return startTime === undefined ? undefined : `linux-proc-start:${startTime}`;
  } catch (error) {
    if (hasCode(error, "ENOENT") || hasCode(error, "ESRCH")) return undefined;
    throw error;
  }
}

function isConnectionUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" ||
      error.code === "ECONNREFUSED" ||
      error.code === "ECONNRESET" ||
      error.code === "EPIPE" ||
      error.code === "ETIMEDOUT")
  );
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function writeJson(write: (value: string) => void, value: unknown): void {
  write(`${JSON.stringify(value)}\n`);
}
