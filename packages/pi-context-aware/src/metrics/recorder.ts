import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DroppedFold, FoldEngineMetrics, FoldRequestResult } from "../folds/fold-engine.js";
import type { FoldTurnResult } from "../folds/fold-turn.js";
import { rejectReasons } from "../parity/outcome.js";
import type { PressureLadderConfig } from "../policy/context-policy.js";
import {
	appendMetricsRecord, buildMetricsRecord, lastMetricsSeq, DEFAULT_METRICS_MAX_BYTES, DEFAULT_METRICS_MAX_DIR_BYTES,
	type FoldReasonCode, type MetricsBand, type MetricsInput,
} from "./records.js";

export interface MetricsSettings {
	readonly enabled: boolean;
	readonly maxBytes: number;
	readonly maxDirBytes: number;
}
export const DEFAULT_METRICS_SETTINGS: MetricsSettings = { enabled: true, maxBytes: DEFAULT_METRICS_MAX_BYTES, maxDirBytes: DEFAULT_METRICS_MAX_DIR_BYTES };

export interface MetricsRecorderOptions {
	readonly agentDir: () => string;
	readonly settings: (ctx: ExtensionContext) => MetricsSettings;
	readonly ladder: (ctx: ExtensionContext) => PressureLadderConfig;
	readonly now?: () => Date;
	readonly log?: (message: string) => void;
	/** The record writer; tests delay it to prove nothing deletes the directory under a pending write. */
	readonly write?: typeof appendMetricsRecord;
}

export interface CompactionNote {
	readonly writer: string;
	readonly tokensBefore: number | null;
	readonly tokensAfter: number | null;
}

export interface MetricsRecorder {
	/** Passed to the fold engine as `metrics`. */
	readonly observers: FoldEngineMetrics;
	/**
	 * A compaction committed. Like a fold, it belongs to the request in flight, so it is
	 * written with that request's record (the open record, or the next one when none is open).
	 */
	noteCompaction(ctx: ExtensionContext, note: CompactionNote): void;
	/** The session ends: write its open record now, so the last request is not lost. */
	close(ctx: ExtensionContext): void;
	/** Writes every open record, then resolves when every queued write has finished. */
	flush(): Promise<void>;
}

interface Pending {
	requested: number;
	accepted: number;
	refused: Record<string, number>;
	dropped: Record<string, number>;
	compaction: CompactionNote | null;
	/** Records written while the compaction waited for a measured token count. */
	compactionWaited: number;
}

/** Most records a compaction waits for a measured `tokensAfter` before it is written with null. */
export const MAX_COMPACTION_WAIT_RECORDS = 3;

/** A request's record, held until the request is over and its folds are known. */
interface OpenRecord {
	readonly input: Omit<MetricsInput, "seq">;
	readonly agentDir: string;
	readonly settings: MetricsSettings;
}

type SessionKey = ExtensionContext["sessionManager"];

const bump = (into: Record<string, number>, code: string): void => { into[code] = (into[code] ?? 0) + 1; };

function bandOf(fraction: number, ladder: PressureLadderConfig): MetricsBand {
	if (fraction >= ladder.seededCompactionFraction) return "urgent";
	return fraction >= ladder.foldNudgeStartFraction ? "warn" : "ok";
}

/**
 * Reason codes of a refused request: the engine's code when it has one, else the classified error
 * text. A refusal with neither a code nor any error text is `unknown`, so every refusal is counted.
 * `refused` is a breakdown by reason, not a request count: a request with several reasons counts once under each.
 */
function refusalCodes(result: Extract<FoldRequestResult, { ok: false }>): FoldReasonCode[] {
	return result.code ? [result.code] : classifiedReasons(result.errors);
}

/** Classified reasons of error text, or `unknown` when there is none, so a failure is never counted nowhere. */
function classifiedReasons(errors: readonly string[]): FoldReasonCode[] {
	const reasons = rejectReasons(errors.filter((error) => error.trim()));
	return reasons.length ? reasons : ["unknown"];
}

/** Usage of the newest assistant message on the branch that reported any. */
function previousUsage(ctx: ExtensionContext): MetricsInput["usage"] {
	const branch = ctx.sessionManager.getBranch() as readonly { type?: string; message?: { role?: string; usage?: Record<string, unknown> } }[];
	for (let i = branch.length - 1; i >= 0; i--) {
		const message = branch[i]?.type === "message" ? branch[i]!.message : undefined;
		if (message?.role !== "assistant" || !message.usage) continue;
		const n = (value: unknown) => (typeof value === "number" ? value : 0);
		return { input: n(message.usage.input), output: n(message.usage.output), cacheRead: n(message.usage.cacheRead), cacheWrite: n(message.usage.cacheWrite) };
	}
	return null;
}

/** The context usage Pi measured, or null while none exists. */
function measuredTokens(ctx: ExtensionContext): number | null {
	try {
		const tokens = ctx.getContextUsage?.()?.tokens;
		return typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 ? tokens : null;
	} catch { return null; }
}

/** Every queued write that has not finished, across all recorders in this process. */
const inFlight = new Set<Promise<void>>();

/** Every recorder's open records: a parked record is a write that has not been queued yet. */
const openSources = new Set<{ count: () => number; flush: () => void }>();
const openCount = (): number => { let n = 0; for (const source of openSources) n += source.count(); return n; };

/** How many metrics writes have not finished, queued or still parked. A fixture must not delete its directory while this is above zero. */
export function pendingMetricsWrites(): number { return inFlight.size + openCount(); }

/** Writes every parked record, then resolves when no queued metrics write, from any recorder in this process, is still pending. */
export async function settleMetricsWrites(): Promise<void> {
	for (const source of openSources) source.flush();
	while (inFlight.size > 0) await Promise.all([...inFlight]);
}

let writerOverride: typeof appendMetricsRecord | undefined;
/** Test seam: replace the record writer of every recorder created afterwards. Returns the undo. */
export function overrideMetricsWriter(write: typeof appendMetricsRecord): () => void {
	writerOverride = write;
	return () => { writerOverride = undefined; };
}

/** Writes one metrics record per live model request. Reads only; a failure here never changes a request. */
export function registerMetricsRecorder(options: MetricsRecorderOptions): MetricsRecorder {
	const pending = new WeakMap<SessionKey, Pending>();
	const open = new WeakMap<SessionKey, OpenRecord>();
	const openKeys = new Set<SessionKey>();
	const sequence = new Map<string, number>();
	const now = options.now ?? (() => new Date());
	const write = options.write ?? writerOverride ?? appendMetricsRecord;
	let chain: Promise<void> = Promise.resolve();

	const state = (ctx: ExtensionContext): Pending => {
		let found = pending.get(ctx.sessionManager);
		if (!found) pending.set(ctx.sessionManager, found = { requested: 0, accepted: 0, refused: {}, dropped: {}, compaction: null, compactionWaited: 0 });
		return found;
	};
	/** Queue the write of one record. */
	const enqueue = (record: OpenRecord, current: Pending): void => {
		const base: Omit<MetricsInput, "seq"> = {
			...record.input,
			// No tiers: the fold engine does not report them, so the record writes null (unknown), not [] (none made).
			folds: { requested: current.requested, accepted: current.accepted, refused: current.refused, dropped: current.dropped },
			compaction: current.compaction,
		};
		const sessionId = base.sessionId;
		const task = chain.then(async () => {
			try {
				if (!sequence.has(sessionId)) {
					let last = 0;
					try { last = await lastMetricsSeq(record.agentDir, sessionId); } catch (error) { options.log?.(`metrics: seq seed failed: ${error instanceof Error ? error.message : String(error)}`); }
					sequence.set(sessionId, last);
				}
				const seq = sequence.get(sessionId)! + 1;
				sequence.set(sessionId, seq);
				await write(record.agentDir, buildMetricsRecord({ ...base, seq }), record.settings);
			} catch (error) { options.log?.(`metrics: write failed: ${error instanceof Error ? error.message : String(error)}`); }
		});
		chain = task;
		inFlight.add(task);
		void task.then(() => { inFlight.delete(task); });
	};
	/** Write the session's open record with the folds counted since it was parked. */
	const finalize = (key: SessionKey, ctx?: ExtensionContext): void => {
		const record = open.get(key);
		if (!record) return;
		open.delete(key);
		openKeys.delete(key);
		const current = pending.get(key) ?? { requested: 0, accepted: 0, refused: {}, dropped: {}, compaction: null, compactionWaited: 0 };
		pending.delete(key);
		// Pi reports no token count until an assistant replies after the compaction, so a compaction
		// waits for the first measured count (never an estimate) and falls back to null after a few records.
		let compaction = current.compaction;
		let carry = false;
		if (compaction && compaction.tokensAfter === null && ctx) {
			const measured = measuredTokens(ctx);
			if (measured !== null) compaction = { ...compaction, tokensAfter: measured };
			else if (current.compactionWaited < MAX_COMPACTION_WAIT_RECORDS) carry = true;
		}
		if (carry) pending.set(key, { requested: 0, accepted: 0, refused: {}, dropped: {}, compaction: current.compaction, compactionWaited: current.compactionWaited + 1 });
		enqueue(record, { ...current, compaction: carry ? null : compaction });
	};
	openSources.add({ count: () => openKeys.size, flush: () => { for (const key of [...openKeys]) finalize(key); } });
	const settingsOf = (ctx: ExtensionContext): MetricsSettings => {
		try { return options.settings(ctx); } catch { return DEFAULT_METRICS_SETTINGS; }
	};

	const observers: FoldEngineMetrics = {
		onRequest(ctx, result) {
			if (!settingsOf(ctx).enabled) return;
			const current = state(ctx);
			current.requested += 1;
			if (result.ok) current.accepted += 1;
			else for (const code of refusalCodes(result)) bump(current.refused, code);
		},
		onDrain(ctx, dropped: readonly DroppedFold[]) {
			if (!settingsOf(ctx).enabled) return;
			const current = state(ctx);
			for (const item of dropped) {
				for (const code of item.code ? [item.code] : classifiedReasons(item.errors)) bump(current.dropped, code);
			}
		},
		onTurn(ctx, turn: FoldTurnResult | undefined) {
			const settings = settingsOf(ctx);
			if (!settings.enabled) return;
			// The previous request is over: its folds, drops and compaction are all counted now.
			finalize(ctx.sessionManager, ctx);
			const sessionId = ctx.sessionManager.getSessionId();
			const window = ctx.model?.contextWindow;
			const before = turn?.tokens?.before;
			const pressure = typeof before === "number" && window && window > 0 ? before / window : null;
			const emergency = turn?.emergency;
			const input: Omit<MetricsInput, "seq"> = {
				at: now(),
				sessionId,
				leafId: ctx.sessionManager.getLeafId(),
				modelId: ctx.model?.id,
				window,
				tokensBefore: before,
				tokensAfter: turn?.tokens?.after,
				pressure,
				band: pressure === null ? null : bandOf(pressure, options.ladder(ctx)),
				nudge: turn?.nudgeKind,
				emergency: emergency ? { truncated: emergency.truncated, hides: emergency.hideCandidates.length, skipped: emergency.skipped !== undefined, terminal: emergency.terminalEscape !== undefined } : null,
				passFailed: turn === undefined,
				folds: { requested: 0, accepted: 0, refused: {}, dropped: {} },
				compaction: null,
				usage: previousUsage(ctx),
			};
			// Park the record: the folds this request asks for arrive after it, and are added in `finalize`.
			open.set(ctx.sessionManager, { input, agentDir: options.agentDir(), settings });
			openKeys.add(ctx.sessionManager);
		},
	};
	return {
		observers,
		noteCompaction(ctx, note) {
			if (!settingsOf(ctx).enabled) return;
			const current = state(ctx);
			current.compaction = note;
			current.compactionWaited = 0;
		},
		close(ctx) { finalize(ctx.sessionManager); },
		flush: () => { for (const key of [...openKeys]) finalize(key); return chain; },
	};
}
