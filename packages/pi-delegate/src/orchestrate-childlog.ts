import * as fs from "node:fs";
import * as path from "node:path";

import { isSafeRunId } from "./run-id.js";

/** Maximum size of the active log before it is rotated. */
export const CHILDLOG_MAX_BYTES = 4 * 1024 * 1024;
/** Maximum age for an inactive childlog before maintenance removes it. */
export const CHILDLOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Maximum combined size of inactive childlogs retained by maintenance. */
export const CHILDLOG_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

const ROTATED_SUFFIX = ".1";
const LOG_NAME = /^(?<runId>[A-Za-z0-9][A-Za-z0-9._-]*)\.childlog(?:\.1)?$/;
/** Keep fallback rendering bounded before it reaches the active-file cap. */
const FALLBACK_MAX_BYTES = 16 * 1024;
const FALLBACK_MAX_ENTRIES = 64;
const FALLBACK_MAX_STRING_CHARS = 256;
const FALLBACK_MAX_OMITTED_FIELDS = 32;
/** Only known-safe root-level scalar metadata enters fallback JSON. */
const SAFE_FALLBACK_KEY = /^(?:id|runId|rootRunId|phase|status|state|kind|reason|name|method|command|success|terminal|willRetry|toolName|event|code|exitCode|signal|signalCode|pid|runnerPid|parentPid|count|index|attempt|durationMs|timestamp|startedAt|finishedAt|version|remainingPasses|active|streaming)$/;

export interface ChildLogWriter {
	/** Append one rendered RPC event. All failures are swallowed. */
	writeEvent(event: unknown, summary?: string): void;
	/** Append the raw RPC frame when debug verbosity is enabled. */
	writeRaw(frame: string): void;
	/** Close the writer's private append descriptor. */
	close(): void;
	readonly file: string;
}

export interface ChildLogOptions {
	now?: () => number;
	debug?: boolean;
	maxBytes?: number;
}

function safeRunId(runId: string): boolean {
	return isSafeRunId(runId) && runId.length > 0;
}

function mode(dir: string, file?: string): void {
	try {
		fs.chmodSync(dir, 0o700);
	} catch {
		/* best-effort */
	}
	if (file) {
		try {
			fs.chmodSync(file, 0o600);
		} catch {
			/* best-effort */
		}
	}
}

function rotateIfNeeded(file: string, bytesToAppend: number, maxBytes: number): void {
	let size: number;
	try {
		size = fs.statSync(file).size;
	} catch {
		return;
	}
	if (size + bytesToAppend <= maxBytes) return;

	// Keep the inherited runner stdio descriptor pointed at the active inode:
	// copy the old contents to the rotated file, then truncate in place. This
	// avoids a rename racing a detached runner that still has the file open.
	const rotated = `${file}${ROTATED_SUFFIX}`;
	try {
		fs.rmSync(rotated, { force: true });
		const previous = fs.readFileSync(file);
		const retained = previous.subarray(Math.max(0, previous.length - maxBytes));
		fs.writeFileSync(rotated, retained, { mode: 0o600 });
		fs.chmodSync(rotated, 0o600);
		fs.truncateSync(file, 0);
	} catch {
		/* best-effort; the next append can retry the rotation */
	}
}

function append(file: string, text: string, maxBytes: number): void {
	if (!text) return;
	try {
		const dir = path.dirname(file);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		mode(dir);
		const bounded = Buffer.byteLength(text, "utf8") > maxBytes
			? Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8")
			: text;
		const bytes = Buffer.byteLength(bounded, "utf8");
		rotateIfNeeded(file, bytes, maxBytes);
		const fd = fs.openSync(file, "a", 0o600);
		try {
			mode(dir, file);
			fs.writeSync(fd, bounded, undefined, "utf8");
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		/* Childlog capture must never affect the run. */
	}
}

/**
 * Open a per-run childlog for the detached runner's stdout/stderr. This helper
 * is intentionally best-effort because its fd is passed into `spawn()`.
 */
export function openChildLogFd(
	logsDir: string,
	runId: string,
	now: () => number = Date.now,
): { file: string; fd: number } | undefined {
	if (!safeRunId(runId)) return undefined;
	let fd: number | undefined;
	try {
		const dir = logsDir;
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		mode(dir);
		const file = path.join(dir, `${runId}.childlog`);
		rotateIfNeeded(file, 0, CHILDLOG_MAX_BYTES);
		fd = fs.openSync(file, "a", 0o600);
		mode(dir, file);
		const header = `--- childlog run=${runId} started=${new Date(now()).toISOString()} ---\n`;
		fs.writeSync(fd, header, undefined, "utf8");
		return { file, fd };
	} catch {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				/* best-effort */
			}
		}
		return undefined;
	}
}

/**
 * Create the structured RPC event writer. A fresh append descriptor is used
 * per frame so the active file can be capped without corrupting another run.
 */
export function createChildLogWriter(
	logsDir: string,
	runId: string,
	opts: ChildLogOptions = {},
): ChildLogWriter | undefined {
	if (!safeRunId(runId)) return undefined;
	const dir = logsDir;
	const file = path.join(dir, `${runId}.childlog`);
	const maxBytes = opts.maxBytes ?? CHILDLOG_MAX_BYTES;
	const debug = opts.debug ?? process.env.PI_DELEGATE_DEBUG === "1";
	const now = opts.now ?? Date.now;
	return {
		file,
		writeEvent(event, summary) {
			try {
				const rendered = summary ?? renderRpcEvent(event);
				append(file, `[${new Date(now()).toISOString()}] ${rendered}\n`, maxBytes);
			} catch {
				/* Rendering and capture are best-effort and must never affect the run. */
			}
		},
		writeRaw(frame) {
			try {
				if (debug) append(file, `[${new Date(now()).toISOString()}] rpc.raw ${frame}\n`, maxBytes);
			} catch {
				/* Raw capture is best-effort and must never affect the run. */
			}
		},
		close() {
			/* no persistent descriptor */
		},
	};
}

function renderRpcEvent(event: unknown): string {
	try {
		if (!event || typeof event !== "object") return `rpc ${JSON.stringify(event)}`;
		const value = event as Record<string, unknown>;
		switch (value.type) {
			case "agent_start":
				return "turn.start";
			case "agent_end":
				return `turn.end willRetry=${String(value.willRetry)}${renderMessage(value.messages)}`;
			case "tool_execution_start":
				return `tool.start name=${String(value.toolName ?? "unknown")}`;
			case "tool_execution_end":
				return `tool.end name=${String(value.toolName ?? "unknown")}`;
			case "message_end":
				return `message.end${renderMessage(value.message)}`;
			case "extension_ui_request":
				return `ui.request method=${String(value.method ?? "unknown")} id=${String(value.id ?? "unknown")}`;
			case "response":
				return `rpc.response command=${String(value.command ?? "unknown")} success=${String(value.success)}`;
			case "runner_terminal":
				return `rpc.event type=runner_terminal terminal=${safeFallbackScalar(value.terminal)} reason=${safeFallbackScalar(value.reason)}`;
			default:
				return `rpc.event type=${safeFallbackScalar(value.type)} payload=${renderFallbackPayload(value)}`;
		}
	} catch {
		return `rpc.event type=unknown payload={"unavailable":true}`;
	}
}

/** Render root-level allowlisted scalar metadata from an unrecognised event. */
function renderFallbackPayload(event: Record<string, unknown>): string {
	try {
		const safe: Record<string, unknown> = {};
		const omitted: string[] = [];
		let count = 0;
		for (const key of Object.keys(event)) {
			if (key === "type") continue;
			if (count++ >= FALLBACK_MAX_ENTRIES) {
				recordOmittedField(omitted, "[entry limit]");
				break;
			}
			if (!SAFE_FALLBACK_KEY.test(key)) {
				recordOmittedField(omitted, key);
				continue;
			}
			try {
				const scalar = sanitizeFallbackScalarValue(event[key]);
				if (scalar.ok) safe[key.slice(0, FALLBACK_MAX_STRING_CHARS)] = scalar.value;
				else recordOmittedField(omitted, key);
			} catch {
				recordOmittedField(omitted, key);
			}
		}
		const payload = omitted.length > 0 ? { "[omitted]": omitted, ...safe } : safe;
		const serialized = JSON.stringify(payload);
		if (!serialized) return "{\"unavailable\":true}";
		return Buffer.byteLength(serialized, "utf8") <= FALLBACK_MAX_BYTES
			? serialized
			: "{\"truncated\":true}";
	} catch {
		return "{\"unavailable\":true}";
	}
}

function recordOmittedField(omitted: string[], key: string): void {
	if (omitted.length < FALLBACK_MAX_OMITTED_FIELDS) {
		omitted.push(key.slice(0, FALLBACK_MAX_STRING_CHARS));
	}
}

function sanitizeFallbackScalarValue(value: unknown): { ok: true; value: null | boolean | number | string } | { ok: false } {
	if (value === null) return { ok: true, value: null };
	if (typeof value === "boolean") return { ok: true, value };
	if (typeof value === "number" && Number.isFinite(value)) return { ok: true, value };
	if (typeof value === "string") {
		return {
			ok: true,
			value: value.length > FALLBACK_MAX_STRING_CHARS
				? `${value.slice(0, FALLBACK_MAX_STRING_CHARS)}…`
				: value,
		};
	}
	return { ok: false };
}

function safeFallbackScalar(value: unknown): string {
	try {
		const scalar = value === undefined || value === null ? "unknown" : String(value);
		return scalar.slice(0, FALLBACK_MAX_STRING_CHARS).replace(/[\r\n]/g, "\\n");
	} catch {
		return "unknown";
	}
}

function renderMessage(value: unknown): string {
	if (!value) return "";
	const messages = Array.isArray(value) ? value : [value];
	const last = messages[messages.length - 1];
	if (!last || typeof last !== "object") return "";
	const message = last as Record<string, unknown>;
	const stop = message.stopReason;
	const error = message.errorMessage;
	const usage = message.usage;
	const usageRecord = usage && typeof usage === "object"
		? usage as Record<string, unknown>
		: undefined;
	const text = renderContent(message.content);
	const suffix = [
		text ? ` text=${JSON.stringify(text)}` : "",
		stop !== undefined ? ` stop=${String(stop)}` : "",
		usageRecord
			? ` usage=input:${String(usageRecord.input ?? usageRecord.inputTokens ?? 0)},output:${String(usageRecord.output ?? usageRecord.outputTokens ?? 0)},cost:${String((usageRecord.cost as Record<string, unknown> | undefined)?.total ?? 0)}`
			: "",
		error !== undefined ? ` error=${JSON.stringify(String(error))}` : "",
	].join("");
	return suffix;
}

function renderContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const text = (part as Record<string, unknown>).text;
			return typeof text === "string" ? text : "";
		})
		.filter(Boolean)
		.join("\\n");
}

function isLiveRun(activeDir: string, runId: string): boolean {
	try {
		for (const owner of fs.readdirSync(activeDir)) {
			const marker = path.join(activeDir, owner, `${runId}.json`);
			if (fs.existsSync(marker)) return true;
		}
	} catch {
		/* missing or unreadable active index means no known live marker */
	}
	return false;
}

export interface ChildLogSweepOptions {
	now?: number;
	maxAgeMs?: number;
	maxTotalBytes?: number;
}

/**
 * Opportunistic global childlog maintenance. Old inactive files are removed;
 * then the oldest inactive files are removed until the total is bounded. Active
 * markers always win, so a live run's log is never swept.
 */
export function sweepOrchestrateChildLogs(
	logsDir: string,
	activeDir: string,
	opts: ChildLogSweepOptions = {},
): number {
	const dir = logsDir;
	const now = opts.now ?? Date.now();
	const maxAgeMs = opts.maxAgeMs ?? CHILDLOG_MAX_AGE_MS;
	const maxTotalBytes = opts.maxTotalBytes ?? CHILDLOG_MAX_TOTAL_BYTES;
	try {
		const files = fs.readdirSync(dir)
			.map((name) => {
				const match = LOG_NAME.exec(name);
				if (!match?.groups?.runId) return undefined;
				const file = path.join(dir, name);
				try {
					const stat = fs.statSync(file);
					return { file, runId: match.groups.runId, size: stat.size, mtimeMs: stat.mtimeMs };
				} catch {
					return undefined;
				}
			})
			.filter((entry): entry is { file: string; runId: string; size: number; mtimeMs: number } => entry !== undefined);
		let removed = 0;
		const retained: typeof files = [];
		const sweepable: typeof files = [];
		for (const entry of files) {
			if (!entry || isLiveRun(activeDir, entry.runId)) {
				if (entry) retained.push(entry);
				continue;
			}
			if (now - entry.mtimeMs > maxAgeMs) {
				try {
					fs.rmSync(entry.file, { force: true });
					removed++;
				} catch {
					retained.push(entry);
					sweepable.push(entry);
				}
			} else {
				retained.push(entry);
				sweepable.push(entry);
			}
		}
		let total = retained.reduce((sum, entry) => sum + (entry?.size ?? 0), 0);
		for (const entry of [...sweepable].sort((a, b) => (a?.mtimeMs ?? 0) - (b?.mtimeMs ?? 0))) {
			if (!entry || total <= maxTotalBytes) break;
			try {
				fs.rmSync(entry.file, { force: true });
				total -= entry.size;
				removed++;
			} catch {
				/* best-effort */
			}
		}
		return removed;
	} catch {
		return 0;
	}
}
