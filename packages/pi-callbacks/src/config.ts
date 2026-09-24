import fs from "node:fs";
import { configFile } from "./paths.ts";
import type { CallbackConfig, DeliveryTarget } from "./types.ts";
import { parseDeliveryTarget } from "./targets.ts";

export const DEFAULT_CHECK_IN_INTERVAL_MS = 30 * 60 * 1_000;
export const DEFAULT_SLEEP_REMINDER_MIN_SECONDS = 10;

export const DEFAULT_CALLBACK_CONFIG: CallbackConfig = {
  version: 1,
  defaultTarget: { kind: "origin" },
  checkInIntervalMs: DEFAULT_CHECK_IN_INTERVAL_MS,
  checkInTriggerTurn: true,
  sleepReminderMinSeconds: DEFAULT_SLEEP_REMINDER_MIN_SECONDS,
};

export function loadCallbackConfig(): CallbackConfig {
  const file = configFile();
  if (!fs.existsSync(file)) return DEFAULT_CALLBACK_CONFIG;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Invalid pi-callbacks config at ${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object") throw new Error(`Invalid pi-callbacks config at ${file}: expected an object`);
  const value = parsed as { version?: unknown; defaultTarget?: unknown; checkInIntervalMs?: unknown; checkInTriggerTurn?: unknown; sleepReminderMinSeconds?: unknown };
  if (value.version !== 1) throw new Error(`Invalid pi-callbacks config at ${file}: version must be 1`);
  const checkInIntervalMs = parseCheckInInterval(value.checkInIntervalMs, file);
  const checkInTriggerTurn = value.checkInTriggerTurn === undefined ? true : value.checkInTriggerTurn;
  if (typeof checkInTriggerTurn !== "boolean") {
    throw new Error(`Invalid pi-callbacks config at ${file}: checkInTriggerTurn must be a boolean`);
  }
  const sleepReminderMinSeconds = parseSleepReminderMinSeconds(value.sleepReminderMinSeconds, file);
  return {
    version: 1,
    defaultTarget: parseConfiguredTarget(value.defaultTarget, file),
    checkInIntervalMs,
    checkInTriggerTurn,
    sleepReminderMinSeconds,
  };
}

function parseCheckInInterval(input: unknown, file: string): number | null {
  if (input === undefined) return DEFAULT_CHECK_IN_INTERVAL_MS;
  if (input === null) return null;
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input <= 0) {
    throw new Error(`Invalid pi-callbacks config at ${file}: checkInIntervalMs must be a positive integer or null`);
  }
  return input;
}

function parseSleepReminderMinSeconds(input: unknown, file: string): number | null {
  if (input === undefined) return DEFAULT_SLEEP_REMINDER_MIN_SECONDS;
  if (input === null) return null;
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) {
    throw new Error(`Invalid pi-callbacks config at ${file}: sleepReminderMinSeconds must be a positive finite number or null`);
  }
  return input;
}

function parseConfiguredTarget(input: unknown, file: string): DeliveryTarget {
  if (typeof input === "string") {
    if (input.startsWith("session:")) return parseDeliveryTarget("session", input.slice("session:".length))!;
    return parseDeliveryTarget(input)!;
  }
  if (input && typeof input === "object") {
    const value = input as { kind?: unknown; session?: unknown };
    if (typeof value.kind === "string") {
      return parseDeliveryTarget(value.kind, typeof value.session === "string" ? value.session : undefined)!;
    }
  }
  throw new Error(`Invalid pi-callbacks config at ${file}: defaultTarget must name a callback target`);
}
