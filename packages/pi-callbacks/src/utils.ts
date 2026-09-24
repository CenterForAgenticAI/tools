import crypto from "node:crypto";
import type { CallbackCondition, CallbackJob, PollResult } from "./types.ts";
import { describeDeliveryTarget, effectiveJobOrigin, effectiveJobTarget } from "./targets.ts";

export function newId(prefix = "cb"): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

export function newToken(): string {
  return `pi_cb_${crypto.randomBytes(24).toString("base64url")}`;
}

export function parseDuration(input: string | number): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input <= 0) throw new Error("duration must be a positive number");
    return Math.round(input);
  }
  const text = input.trim().toLowerCase();
  const simple = text.match(/^(\d+(?:\.\d+)?)(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)?$/);
  if (simple) {
    const value = Number(simple[1]);
    const unit = simple[2] ?? "ms";
    return Math.round(value * unitToMs(unit));
  }

  const partRe = /(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)/g;
  let total = 0;
  let matched = false;
  for (const match of text.matchAll(partRe)) {
    const unit = match[2];
    if (unit === undefined) continue;
    matched = true;
    total += Number(match[1]) * unitToMs(unit);
  }
  if (!matched || total <= 0) throw new Error(`Invalid duration: ${input}`);
  return Math.round(total);
}

function unitToMs(unit: string): number {
  switch (unit) {
    case "ms": return 1;
    case "s": case "sec": case "secs": case "second": case "seconds": return 1_000;
    case "m": case "min": case "mins": case "minute": case "minutes": return 60_000;
    case "h": case "hr": case "hrs": case "hour": case "hours": return 3_600_000;
    case "d": case "day": case "days": return 86_400_000;
    default: throw new Error(`Unknown duration unit: ${unit}`);
  }
}

export function describeDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const units: Array<[string, number]> = [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000], ["s", 1_000]];
  for (const [label, size] of units) {
    if (ms >= size && ms % size === 0) return `${ms / size}${label}`;
  }
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 1_000)}s`;
}

export function parseCondition(spec: string | undefined): CallbackCondition {
  const raw = spec?.trim();
  if (!raw) return { type: "any_output" };
  const lower = raw.toLowerCase();
  if (lower === "always") return { type: "always" };
  if (lower === "any" || lower === "any_output") return { type: "any_output" };
  if (lower.startsWith("contains:")) return { type: "text_contains", value: raw.slice("contains:".length).trim() };
  if (lower.startsWith("not_contains:")) return { type: "not_contains", value: raw.slice("not_contains:".length).trim() };
  if (lower.startsWith("regex:")) return { type: "regex", value: raw.slice("regex:".length).trim() };
  if (lower.startsWith("exit:")) return { type: "exit_code", value: Number(raw.slice("exit:".length).trim()) };
  if (lower.startsWith("status:")) return { type: "status_code", value: Number(raw.slice("status:".length).trim()) };
  return { type: "text_contains", value: raw };
}

export function conditionMatches(condition: CallbackCondition, result: PollResult): boolean {
  const combined = [result.stdout, result.stderr, result.text, result.error].filter(Boolean).join("\n");
  switch (condition.type) {
    case "always": return true;
    case "any_output": return combined.trim().length > 0 || result.ok;
    case "text_contains": return combined.includes(condition.value);
    case "not_contains": return !combined.includes(condition.value);
    case "regex": {
      // Shell output conventionally ends with a line break; preserve all other whitespace for regex semantics.
      const regexInput = combined.replace(/(?:\r?\n)+$/, "");
      return new RegExp(condition.value, condition.flags).test(regexInput);
    }
    case "exit_code": return result.exitCode === condition.value;
    case "status_code": return result.statusCode === condition.value;
  }
}

export function summarizeResult(result: PollResult, max = 1200): string {
  const chunks: string[] = [];
  if (result.status !== undefined) chunks.push(`sourceStatus=${result.status}`);
  if (result.statusCode !== undefined) chunks.push(`status=${result.statusCode}`);
  if (result.exitCode !== undefined) chunks.push(`exit=${result.exitCode}`);
  if (result.error) chunks.push(`error=${result.error}`);
  const body = result.text ?? [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (body) chunks.push(body);
  const text = chunks.join("\n").trim();
  return truncateMiddle(text || "(no output)", max);
}

export function truncateMiddle(text: string, max = 4000): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 40) / 2);
  return `${text.slice(0, half)}\n… [truncated ${text.length - max} chars] …\n${text.slice(-half)}`;
}

export interface FormatJobBlockOptions {
  now?: number;
  pendingDeliveries?: number;
  showScope?: boolean;
}

export function formatJobBlock(job: CallbackJob, options: FormatJobBlockOptions = {}): string {
  const now = options.now ?? Date.now();
  const lines = [job.label ? `${job.id} — ${job.label}` : job.id];
  const statusParts = [`status: ${job.status}`, `kind: ${job.kind}`];
  if (job.token) statusParts.push("token");
  if (job.kind === "script" && job.pid) statusParts.push(`pid: ${job.pid}`);
  lines.push(`  ${statusParts.join(" · ")}`);
  if (options.showScope) {
    const origin = effectiveJobOrigin(job);
    lines.push(`  scope: owner ${origin?.sessionId ?? "legacy/unscoped"} · target ${describeDeliveryTarget(effectiveJobTarget(job))}`);
    if (origin?.cwd) lines.push(`  cwd: ${origin.cwd}`);
  }

  if (job.kind === "poll") {
    const parts = [`every ${describeDuration(job.intervalMs)}`];
    if (job.status === "pending" || job.status === "running") {
      parts.push(`next ${formatScheduledTime(job.nextRunAt, now)}`);
    }
    parts.push(`runs ${job.runCount}${job.maxRuns === undefined ? "" : `/${job.maxRuns}`}`);
    lines.push(`  timing: ${parts.join(" · ")}`);
    if (job.lastResult) {
      const outcome = job.lastResult.status !== undefined
        ? `source=${job.lastResult.status}`
        : job.lastResult.exitCode !== undefined
          ? `exit=${job.lastResult.exitCode}`
          : job.lastResult.statusCode !== undefined
            ? `status=${job.lastResult.statusCode}`
            : job.lastResult.ok ? "ok" : "checked";
      lines.push(`  last poll ${outcome} @ ${new Date(job.lastResult.at).toLocaleString()}`);
    } else if (job.status === "pending" || job.status === "running") {
      lines.push("  poll scheduled");
    }
  } else if (job.kind === "reminder") {
    lines.push(`  timing: due ${formatScheduledTime(job.dueAt, now)}`);
  } else if (job.kind === "script") {
    const [verb, timestamp] = job.completedAt !== undefined
      ? ["completed", job.completedAt]
      : job.startedAt !== undefined
        ? ["started", job.startedAt]
        : ["created", job.createdAt];
    lines.push(`  timing: ${verb} ${formatScheduledTime(timestamp, now)}`);
  } else {
    const [verb, timestamp] = job.completedAt !== undefined
      ? ["completed", job.completedAt]
      : ["created", job.createdAt];
    lines.push(`  timing: ${verb} ${formatScheduledTime(timestamp, now)}`);
  }

  lines.push(`  message: ${job.message.replace(/\n/g, "\n    ")}`);
  if ((options.pendingDeliveries ?? 0) > 0) {
    lines.push(`  pending deliveries: ${options.pendingDeliveries}`);
  }
  return lines.join("\n");
}

function formatScheduledTime(timestamp: number, now: number): string {
  const delta = timestamp - now;
  const relative = Math.abs(delta) < 1_000
    ? "now"
    : delta > 0
      ? `in ${describeDuration(delta)}`
      : `${describeDuration(-delta)} ago`;
  return `${relative} (${new Date(timestamp).toLocaleString()})`;
}

export function safeJson(value: unknown): string {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}
