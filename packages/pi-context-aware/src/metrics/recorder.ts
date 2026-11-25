import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DroppedFold, FoldEngineMetrics, FoldRequestResult } from "../folds/fold-engine.js";
import type { FoldTurnResult } from "../folds/fold-turn.js";
import type { RequestPressure } from "../folds/request-pressure.js";
import { rejectReasons } from "../parity/outcome.js";
import {
	appendMetricsRecord, buildMetricsRecord, lastMetricsSeq, DEFAULT_METRICS_MAX_BYTES, DEFAULT_METRICS_MAX_DIR_BYTES,
	type FoldReasonCode, type MetricsBand, type MetricsInput, type MetricsStageInput,
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
	readonly now?: () => Date;
	readonly log?: (message: string) => void;
	/** The record writer; tests delay it to prove nothing deletes the directory under a pending write. */
	readonly write?: typeof appendMetricsRecord;
}

export interface CompactionNote {
	readonly writer: string;
	/** What asked for the compaction (pi-context-aware#459, `compactionTriggerOf`). */
	readonly trigger: string;
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
	/**
	 * A `context_recall` by reference returned the entries behind a fold or a hide (pi-context-aware#473). Counted in
	 * the request in flight, like a fold.
	 */
	noteRecall(ctx: ExtensionContext, kind: "fold" | "hide"): void;
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
	/** Tokens the folds written at this request's boundaries freed (pi-context-aware#459). */
	freedTokens: number;
	compaction: CompactionNote | null;
	/** Records written while the compaction waited for a measured token count. */
	compactionWaited: number;
	/** Stage outcomes reported after the request was parked: a compaction's (pi-context-aware#473). */
	stages: MetricsStageInput[];
	recalls: { folds: number; hides: number };
}

const emptyPending = (): Pending => ({ requested: 0, accepted: 0, refused: {}, dropped: {}, freedTokens: 0, compaction: null, compactionWaited: 0, stages: [], recalls: { folds: 0, hides: 0 } });

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

/** The request's band in the record's spelling; null when nothing counted the request. */
function bandOf(pressure: RequestPressure): MetricsBand | null {
	return pressure.band === "UNKNOWN" ? null : pressure.band === "URGENT" ? "urgent" : pressure.band === "WARN" ? "warn" : "ok";
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

/**
 * Writes one metrics record per model request: in live mode with the fold pass's result, in shadow mode with Pi's
 * usage and no pass. Reads only; a failure here never changes a request.
 */
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
		if (!found) pending.set(ctx.sessionManager, found = emptyPending());
		return found;
	};
	/** Queue the write of one record. */
	const enqueue = (record: OpenRecord, current: Pending): void => {
		const base: Omit<MetricsInput, "seq"> = {
			...record.input,
			// No tiers: the fold engine does not report them, so the record writes null (unknown), not [] (none made).
			folds: { requested: current.requested, accepted: current.accepted, refused: current.refused, dropped: current.dropped, freedTokens: current.freedTokens },
			compaction: current.compaction,
			stages: [...(record.input.stages ?? []), ...current.stages],
			recalls: current.recalls,
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
		const current = pending.get(key) ?? emptyPending();
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
		if (carry) pending.set(key, { ...emptyPending(), compaction: current.compaction, compactionWaited: current.compactionWaited + 1 });
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
		onDrain(ctx, dropped: readonly DroppedFold[], written) {
			if (!settingsOf(ctx).enabled) return;
			const current = state(ctx);
			const freed = written?.freedTokens;
			if (typeof freed === "number" && Number.isFinite(freed) && freed > 0) current.freedTokens += freed;
			for (const item of dropped) {
				for (const code of item.code ? [item.code] : classifiedReasons(item.errors)) bump(current.dropped, code);
			}
		},
		onStages(ctx, stages) {
			if (!settingsOf(ctx).enabled) return;
			state(ctx).stages.push(...stages);
		},
		onTurn(ctx, turn: FoldTurnResult | undefined, requestPressure: RequestPressure | null, passFailed: boolean, strategy) {
			const settings = settingsOf(ctx);
			if (!settings.enabled) return;
			// The previous request is over: its folds, drops and compaction are all counted now.
			finalize(ctx.sessionManager, ctx);
			const sessionId = ctx.sessionManager.getSessionId();
			const window = requestPressure?.window ?? ctx.model?.contextWindow;
			const before = turn?.tokens?.before;
			// The request's one pressure value (pi-context-aware#461), the one its nudge and proactive compaction read.
			// Null when nothing counted the request: no fold pass and no measured size.
			const pressure = requestPressure && requestPressure.band !== "UNKNOWN" ? requestPressure.fraction : null;
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
				band: requestPressure ? bandOf(requestPressure) : null,
				nudge: turn?.nudgeKind,
				emergency: emergency ? { truncated: emergency.truncated, hides: emergency.hideCandidates.length, skipped: emergency.skipped !== undefined, terminal: emergency.terminalEscape !== undefined } : null,
				// A shadow-mode request runs no fold pass; only a pass that failed or did not line up is a failed pass.
				passFailed,
				folds: { requested: 0, accepted: 0, refused: {}, dropped: {} },
				compaction: null,
				usage: previousUsage(ctx),
				// The session's methods and what their stages did on this request (pi-context-aware#473, pi-context-aware#526).
				strategy: strategy ? { methods: [...strategy.strategy.methods], source: strategy.strategy.source, shadow: strategy.strategy.shadow.map((methods) => [...methods]), guidance: strategy.strategy.guidance } : null,
				stages: strategy ? [...strategy.stages] : [],
				steer: strategy ? strategy.steer : null,
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
		noteRecall(ctx, kind) {
			if (!settingsOf(ctx).enabled) return;
			const current = state(ctx);
			if (kind === "fold") current.recalls.folds += 1;
			else if (kind === "hide") current.recalls.hides += 1;
		},
		close(ctx) { finalize(ctx.sessionManager); },
		flush: () => { for (const key of [...openKeys]) finalize(key); return chain; },
	};
}
