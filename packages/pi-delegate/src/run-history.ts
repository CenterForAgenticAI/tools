/**
 * Append-only JSONL run-history for delegate.
 *
 * Every completed (or failed/aborted/paused) run appends one line to
 * `<agentDir>/extensions/pi-delegate/runs.jsonl`. The log is
 * best-effort for ordinary IO errors. A lock acquisition timeout is returned
 * to the runner so it can preserve the worker result while exposing the loss.
 *
 * Rotation: on read, if the file has grown past the configured
 * `readThresholdLines`, it is trimmed in place to the last `keepLines`
 * entries. This keeps the file bounded without needing a background job.
 * See `HistoryRotationLimits` and `configureHistoryRotation`.
 *
 * This module has NO dependency on fork-runner — `recordRun` takes a
 * plain entry object so callers shape the payload themselves.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentSource } from "./agents.js";
import type { CancelReason } from "./runtime.js";
import type { UsageNormalizationDiagnostic } from "./usage-rollup.js";
import type { RetryOf } from "./fork-predecessor.js";
import {
	appendJsonLine,
	preserveCorruptFile,
	readUtf8File,
	replaceTextFile,
	resolveDelegateStateDir,
	StateLockTimeoutError,
	withStateFileLock,
} from "./state-io.js";

export const RUN_HISTORY_SCHEMA_VERSION = 2 as const;
export const MAX_HISTORY_ERROR_BYTES = 4096;
/** Remove control characters and keep synthetic/public diagnostics bounded. */
export function boundHistoryErrorMessage(value: unknown): string {
	const text = typeof value === "string" ? value : String(value);
	const safe = [...text].map((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? " " : character).join("").trim();
	if (Buffer.byteLength(safe, "utf8") <= MAX_HISTORY_ERROR_BYTES) return safe;
	let out = safe.slice(0, MAX_HISTORY_ERROR_BYTES);
	while (Buffer.byteLength(out, "utf8") > MAX_HISTORY_ERROR_BYTES) out = out.slice(0, -1);
	return out;
}
export type RunHistorySchemaVersion = 1 | typeof RUN_HISTORY_SCHEMA_VERSION;

export interface RunHistoryEntry {
	ts: string; // ISO-8601 UTC (finishedAt-ish)
	tsSec: number; // unix seconds for cheap filter/sort
	/** Current records write version 2; omitted on legacy version-1 records. */
	version?: RunHistorySchemaVersion;
	runId?: string;
	/** Foreground/originator pi session id that launched the delegate run. */
	ownerSessionId?: string;
	/** Root run id for nested delegation trees, when available. */
	rootRunId?: string;
	/** Stable persisted addressing key retained as `forkName`. */
	forkName: string;
	/** Effective attempt; absent legacy entries mean 1. */
	attempt?: number;
	/** Exact predecessor reference retained in trusted local history only. */
	retryOf?: RetryOf;
	/**
	 * Derived, NON-ADDRESSING display label for this run (issues #151/#152),
	 * so history agrees with what the widget showed at the time. Absent on
	 * records written before the field existed, and on runs whose label is
	 * just their name.
	 */
	displayLabel?: string;
	agent: string;
	agentSource: AgentSource;
	workerModel?: string; // `${provider}/${id}`
	/**
	 * Phase D: ordered list of model refs we attempted before resolving
	 * `workerModel`. Includes the agent's primary `model:` field, every
	 * `fallbackModels:` entry, and finally the main agent's model used
	 * as a last-resort fallback ("provider/id (main)"). Populated even
	 * when only the primary resolved on the first try — `attemptedModels[0]`
	 * is then the same as `workerModel`.
	 *
	 * Surfaces the resolution walk for diagnostics (e.g. "this run used
	 * the haiku fallback because gpt-5 wasn't authorized") without
	 * needing to scrape stderr.
	 */
	attemptedModels?: string[];
	workerThinking?: string; // off|minimal|low|medium|high|xhigh
	summaryModel?: string; // provider/id of summary model if used
	cwd: string;
	workerSessionFile?: string;
	/** Terminal result status. `paused` is forced completion, not a failure. */
	status: "completed" | "failed" | "aborted" | "paused";
	/**
	 * Populated only when `status === "aborted"`. Distinguishes why the run
	 * was cancelled: user-triggered (Ctrl+Shift+X), per-run timeout,
	 * heartbeat auto-escalation, supervisor-initiated cancel/restart, or
	 * extension shutdown. Absent for completed/failed runs.
	 */
	cancelReason?: CancelReason;
	errorMessage?: string;
	/** Distinct provider/runtime error class when known. */
	errorKind?: "refusal" | "no-model-alternative";
	/** Worker model refs that refused before this run failed or fell back. */
	refusalModels?: string[];
	roundsUsed: number;
	maxRounds: number;
	collapseMode: "final_output" | "summary";
	supervisorFinishKind: "final_output" | "summary" | null;
	summaryFallbackReason?: string;
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	usage: {
		supervisorInput: number;
		supervisorOutput: number;
		supervisorCacheRead?: number;
		supervisorCacheWrite?: number;
		workerInput: number;
		workerOutput: number;
		workerCacheRead?: number;
		workerCacheWrite?: number;
		cost: number;
		diagnostics?: UsageNormalizationDiagnostic[];
	};
	taskPreview: string; // req.task.slice(0, 200)
}

export function resolveHistoryPath(agentDir: string): string {
	return path.join(resolveDelegateStateDir(agentDir), "runs.jsonl");
}

/**
 * Record a terminal failure that happened before the worker runner could
 * construct its normal result/finalization state (for example, a depth-guard
 * rejection). The ordinary inner-run recorders remain responsible for runs
 * that entered worker execution.
 */
export function recordPreflightFailure(
	agentDir: string,
	args: {
		runId?: string;
		rootRunId?: string;
		ownerSessionId?: string;
		/** Stable persisted addressing key retained as `forkName`. */
		forkName: string;
		displayLabel?: string;
		agent: string;
		agentSource: AgentSource;
		cwd: string;
		maxRounds: number;
		collapseMode: "final_output" | "summary";
		task: string;
		errorMessage: string;
		/**
		 * Retry lineage, when the rejected attempt declared one. A pre-flight
		 * rejection is still an attempt in its lane, so dropping these would
		 * make a rejected retry indistinguishable from a first try.
		 */
		attempt?: number;
		retryOf?: RetryOf;
	},
): void {
	const finishedAt = new Date().toISOString();
	recordRun(agentDir, {
		ts: finishedAt,
		tsSec: Math.floor(Date.now() / 1000),
		runId: args.runId,
		rootRunId: args.rootRunId,
		ownerSessionId: args.ownerSessionId,
		forkName: args.forkName,
		...(args.attempt !== undefined ? { attempt: args.attempt } : {}),
		...(args.retryOf ? { retryOf: args.retryOf } : {}),
		...(args.displayLabel !== undefined ? { displayLabel: args.displayLabel } : {}),
		agent: args.agent,
		agentSource: args.agentSource,
		cwd: args.cwd,
		status: "failed",
		errorMessage: args.errorMessage,
		roundsUsed: 0,
		maxRounds: args.maxRounds,
		collapseMode: args.collapseMode,
		supervisorFinishKind: null,
		startedAt: finishedAt,
		finishedAt,
		durationMs: 0,
		usage: {
			supervisorInput: 0,
			supervisorOutput: 0,
			workerInput: 0,
			workerOutput: 0,
			cost: 0,
		},
		taskPreview: args.task.slice(0, 200),
	});
}

export function recordRun(agentDir: string, entry: RunHistoryEntry): void {
	try {
		const historyPath = resolveHistoryPath(agentDir);
		withStateFileLock(historyPath, () => {
			const persisted: RunHistoryEntry = {
				...entry,
				...(entry.errorMessage !== undefined ? { errorMessage: boundHistoryErrorMessage(entry.errorMessage) } : {}),
				version: RUN_HISTORY_SCHEMA_VERSION,
			};
			appendJsonLine(historyPath, persisted);
			// Issue #9 — rotation previously lived ONLY in readRunHistory, so a
			// headless deployment that never reads grew the file without bound.
			// A stat is cheap per append; the actual trim only triggers past the
			// byte threshold. The append and possible rotation share this lock.
			trimHistoryIfOversized(historyPath);
		});
	} catch (error) {
		if (error instanceof StateLockTimeoutError) throw error;
		// Ordinary history IO remains best-effort; lock timeouts stay visible to the runner.
	}
}

/**
 * Write-side rotation guard (issue #9): when runs.jsonl exceeds
 * the configured `writeThresholdBytes`, rewrite it keeping the newest
 * `keepLines` entries. Byte-based (not line-based) so the common path is a
 * single cheap `statSync` rather than a full read. Best-effort.
 */
function trimHistoryIfOversized(historyPath: string): void {
	try {
		if (fs.statSync(historyPath).size <= historyRotationLimits.writeThresholdBytes) return;
		const result = readUtf8File(historyPath);
		if (result.kind !== "ok") {
			if (result.kind === "corrupt") preserveCorruptFile(historyPath);
			return;
		}
		const lines = result.value.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
		if (hasMalformedJsonLine(lines) && !preserveHistoryCorruptForRewrite(historyPath)) return;
		const kept = lines.slice(-historyRotationLimits.keepLines);
		// Atomic swap so a concurrent reader never observes a torn file.
		replaceTextFile(historyPath, `${kept.join("\n")}\n`);
	} catch {
		// Best-effort — rotation failure must not block recording.
	}
}

/**
 * Retention limits for the history log.
 *
 * `readThresholdLines` is the read-side line-count trigger and
 * `writeThresholdBytes` the write-side size trigger (issue #9); 5000 typical
 * entries (~200–600 bytes each) sit well under the byte threshold, so the
 * line-count rotation usually fires first in interactive deployments and the
 * byte trigger is the headless backstop. Either rotation retains the newest
 * `keepLines` entries.
 */
export interface HistoryRotationLimits {
	readThresholdLines: number;
	writeThresholdBytes: number;
	keepLines: number;
}

const DEFAULT_HISTORY_ROTATION_LIMITS: HistoryRotationLimits = {
	readThresholdLines: 5000,
	writeThresholdBytes: 4 * 1024 * 1024,
	keepLines: 4000,
};

let historyRotationLimits: HistoryRotationLimits = { ...DEFAULT_HISTORY_ROTATION_LIMITS };

/** Current retention limits. Returns a copy; mutating it changes nothing. */
export function historyRotationLimits_(): HistoryRotationLimits {
	return { ...historyRotationLimits };
}

/**
 * Override retention limits. Intended for a host that wants a different
 * history budget, and for tests that need rotation to fire without writing
 * megabytes first. Rejects values that would make rotation meaningless.
 */
export function configureHistoryRotation(limits: Partial<HistoryRotationLimits>): void {
	const next: HistoryRotationLimits = { ...historyRotationLimits, ...limits };
	for (const key of ["readThresholdLines", "writeThresholdBytes", "keepLines"] as const) {
		const value = next[key];
		if (!Number.isInteger(value) || value <= 0) {
			throw new Error(`configureHistoryRotation: ${key} must be a positive integer, got ${value}`);
		}
	}
	if (next.keepLines >= next.readThresholdLines) {
		throw new Error(
			`configureHistoryRotation: keepLines (${next.keepLines}) must be below ` +
				`readThresholdLines (${next.readThresholdLines}); otherwise read-side rotation never shrinks the file`,
		);
	}
	historyRotationLimits = next;
}

/** Restore the shipped defaults. */
export function resetHistoryRotation(): void {
	historyRotationLimits = { ...DEFAULT_HISTORY_ROTATION_LIMITS };
}

function preserveHistoryCorruptForRewrite(historyPath: string): boolean {
	if (preserveCorruptFile(historyPath)) return true;
	return readUtf8File(historyPath).kind === "absent";
}

function hasMalformedJsonLine(lines: readonly string[]): boolean {
	return lines.some((line) => {
		try {
			JSON.parse(line);
			return false;
		} catch {
			return true;
		}
	});
}

export function readRunHistory(agentDir: string): RunHistoryEntry[] {
	const historyPath = resolveHistoryPath(agentDir);
	if (!fs.existsSync(historyPath)) return [];
	return withStateFileLock(historyPath, () => {
		const result = readUtf8File(historyPath);
		if (result.kind === "absent") return [];
		if (result.kind === "corrupt") {
			preserveCorruptFile(historyPath);
			return [];
		}

		let lines = result.value.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);

		if (lines.length > historyRotationLimits.readThresholdLines) {
			const canRewrite = !hasMalformedJsonLine(lines) || preserveHistoryCorruptForRewrite(historyPath);
			lines = lines.slice(-historyRotationLimits.keepLines);
			if (canRewrite) {
				try {
					// Atomic swap so a concurrent writer never observes a torn file.
					replaceTextFile(historyPath, `${lines.join("\n")}\n`);
				} catch {
					// Best-effort — rotation failure must not block callers.
				}
			}
		}

		const entries: RunHistoryEntry[] = [];
		for (const line of lines) {
			try {
				entries.push(JSON.parse(line) as RunHistoryEntry);
			} catch {
				// Skip malformed lines silently.
			}
		}
		return entries;
	});
}

export interface RunHistoryAggregate {
	total: number;
	completed: number;
	failed: number;
	aborted: number;
	paused: number;
	failureRate: number;
	versions: Record<RunHistorySchemaVersion, number>;
}

/**
 * Aggregate supported run-history records without guessing at unknown schemas.
 * Missing versions are the version-1 shape; version 2 is the current shape.
 * Paused runs are terminal but are not failures.
 */
export function aggregateRunHistory(entries: readonly RunHistoryEntry[]): RunHistoryAggregate {
	const aggregate: RunHistoryAggregate = {
		total: 0,
		completed: 0,
		failed: 0,
		aborted: 0,
		paused: 0,
		failureRate: 0,
		versions: { 1: 0, 2: 0 },
	};
	for (const entry of entries) {
		const version = entry.version === undefined ? 1 : entry.version;
		if (version !== 1 && version !== RUN_HISTORY_SCHEMA_VERSION) continue;
		aggregate.versions[version]++;
		aggregate.total++;
		switch (entry.status) {
			case "completed":
				aggregate.completed++;
				break;
			case "failed":
				aggregate.failed++;
				break;
			case "aborted":
				aggregate.aborted++;
				break;
			case "paused":
				aggregate.paused++;
				break;
		}
	}
	aggregate.failureRate = aggregate.total === 0 ? 0 : aggregate.failed / aggregate.total;
	return aggregate;
}
