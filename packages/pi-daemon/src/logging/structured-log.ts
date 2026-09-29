import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname } from "node:path";

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_FILES = 5;
const MAX_IDENTIFIER_LENGTH = 256;

export interface DiagnosticLogSink {
  write(line: string): void;
}

export interface FileLogSinkOptions {
  readonly path: string;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
}

export type DiagnosticEventKind =
  | "daemon_starting"
  | "daemon_ready"
  | "startup_sdk_incompatible"
  | "startup_failed"
  | "shutdown_started"
  | "shutdown_clean"
  | "shutdown_deadline"
  | "shutdown_failed";

export interface DiagnosticLoggerOptions {
  readonly daemonInstanceId: string;
  readonly sink: DiagnosticLogSink;
  readonly now?: () => Date;
}

export interface DiagnosticLogger {
  emit(event: unknown): boolean;
}

interface EventDefinition {
  readonly level: "info" | "error";
  readonly operation: "startup" | "shutdown";
  readonly message: string;
  readonly errorCode?: "sdk_incompatible" | "startup_failed" | "shutdown_deadline" | "shutdown_failed";
}

const EVENT_DEFINITIONS: Readonly<Record<DiagnosticEventKind, EventDefinition>> = {
  daemon_starting: {
    level: "info",
    operation: "startup",
    message: "daemon startup began",
  },
  daemon_ready: {
    level: "info",
    operation: "startup",
    message: "daemon ready",
  },
  startup_sdk_incompatible: {
    level: "error",
    operation: "startup",
    errorCode: "sdk_incompatible",
    message: "SDK compatibility check failed",
  },
  startup_failed: {
    level: "error",
    operation: "startup",
    errorCode: "startup_failed",
    message: "daemon startup failed",
  },
  shutdown_started: {
    level: "info",
    operation: "shutdown",
    message: "daemon shutdown began",
  },
  shutdown_clean: {
    level: "info",
    operation: "shutdown",
    message: "daemon closed cleanly",
  },
  shutdown_deadline: {
    level: "error",
    operation: "shutdown",
    errorCode: "shutdown_deadline",
    message: "daemon shutdown deadline exceeded",
  },
  shutdown_failed: {
    level: "error",
    operation: "shutdown",
    errorCode: "shutdown_failed",
    message: "daemon shutdown failed",
  },
};

export function createDiagnosticLogger(options: DiagnosticLoggerOptions): DiagnosticLogger {
  if (!isBoundedIdentifier(options.daemonInstanceId)) {
    throw new TypeError("daemonInstanceId must be a non-empty bounded string");
  }
  const now = options.now ?? (() => new Date());

  return {
    emit(event: unknown): boolean {
      if (!isRecord(event) || !isEventKind(event.kind)) return false;
      if (event.sessionId !== undefined && !isBoundedIdentifier(event.sessionId)) return false;
      if (
        event.generation !== undefined &&
        (!Number.isSafeInteger(event.generation) || (event.generation as number) < 0)
      ) {
        return false;
      }

      const definition = EVENT_DEFINITIONS[event.kind];
      const record = {
        timestamp: now().toISOString(),
        level: definition.level,
        daemonInstanceId: options.daemonInstanceId,
        ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
        ...(event.generation === undefined ? {} : { generation: event.generation }),
        operation: definition.operation,
        ...(definition.errorCode === undefined ? {} : { errorCode: definition.errorCode }),
        message: definition.message,
      };
      try {
        options.sink.write(`${JSON.stringify(record)}\n`);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function createFileLogSink(options: FileLogSinkOptions): DiagnosticLogSink {
  const maxBytes = positiveSafeInteger(options.maxBytes ?? DEFAULT_MAX_BYTES, "maxBytes");
  const maxFiles = positiveSafeInteger(options.maxFiles ?? DEFAULT_MAX_FILES, "maxFiles");
  mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });

  return {
    write(line: string): void {
      const bytes = Buffer.byteLength(line);
      if (bytes > maxBytes) throw new RangeError("diagnostic log line exceeds maxBytes");
      if (existsSync(options.path)) {
        const current = lstatSync(options.path);
        if (!current.isFile() || current.isSymbolicLink()) {
          throw new Error("diagnostic log path is not a regular file");
        }
        if (current.size + bytes > maxBytes) rotateFiles(options.path, maxFiles);
      }
      appendFileSync(options.path, line, { encoding: "utf8", flag: "a", mode: 0o600 });
      chmodSync(options.path, 0o600);
    },
  };
}

function rotateFiles(path: string, maxFiles: number): void {
  if (maxFiles === 1) {
    rmSync(path, { force: true });
    return;
  }
  rmSync(`${path}.${maxFiles - 1}`, { force: true });
  for (let index = maxFiles - 2; index >= 1; index -= 1) {
    const source = `${path}.${index}`;
    if (existsSync(source)) renameSync(source, `${path}.${index + 1}`);
  }
  renameSync(path, `${path}.1`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEventKind(value: unknown): value is DiagnosticEventKind {
  return typeof value === "string" && Object.hasOwn(EVENT_DEFINITIONS, value);
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}
