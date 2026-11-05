import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DroppedFold, FoldEngineMetrics, FoldRequestResult } from "../folds/fold-engine.js";
import type { FoldTurnResult } from "../folds/fold-turn.js";
import { rejectReasons } from "../parity/outcome.js";
import type { PressureLadderConfig } from "../policy/context-policy.js";
import {
	appendMetricsRecord, buildMetricsRecord, DEFAULT_METRICS_MAX_BYTES, DEFAULT_METRICS_MAX_DIR_BYTES,
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
}

export interface CompactionNote {
	readonly writer: string;
	readonly tokensBefore: number | null;
	readonly tokensAfter: number | null;
}

export interface MetricsRecorder {
	/** Passed to the fold engine as `metrics`. */
	readonly observers: FoldEngineMetrics;
	/** A compaction committed; the next record carries it. */
	noteCompaction(ctx: ExtensionContext, note: CompactionNote): void;
	/** Resolves when every queued write has finished. */
	flush(): Promise<void>;
}

interface Pending {
	requested: number;
	accepted: number;
	refused: Record<string, number>;
	dropped: Record<string, number>;
	compaction: CompactionNote | null;
}

type SessionKey = ExtensionContext["sessionManager"];

const bump = (into: Record<string, number>, code: string): void => { into[code] = (into[code] ?? 0) + 1; };

function bandOf(fraction: number, ladder: PressureLadderConfig): MetricsBand {
	if (fraction >= ladder.seededCompactionFraction) return "urgent";
	return fraction >= ladder.foldNudgeStartFraction ? "warn" : "ok";
}

/** Reason codes of a refused request: the engine's code when it has one, else the classified error text. */
function refusalCodes(result: Extract<FoldRequestResult, { ok: false }>): FoldReasonCode[] {
	if (result.code) return [result.code];
	return rejectReasons(result.errors);
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

/** Writes one metrics record per live model request. Reads only; a failure here never changes a request. */
export function registerMetricsRecorder(options: MetricsRecorderOptions): MetricsRecorder {
	const pending = new WeakMap<SessionKey, Pending>();
	const sequence = new Map<string, number>();
	const now = options.now ?? (() => new Date());
	let chain: Promise<void> = Promise.resolve();

	const state = (ctx: ExtensionContext): Pending => {
		let found = pending.get(ctx.sessionManager);
		if (!found) pending.set(ctx.sessionManager, found = { requested: 0, accepted: 0, refused: {}, dropped: {}, compaction: null });
		return found;
	};
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
				if (item.code) bump(current.dropped, item.code);
				else for (const code of rejectReasons(item.errors)) bump(current.dropped, code);
			}
		},
		onTurn(ctx, turn: FoldTurnResult | undefined) {
			const settings = settingsOf(ctx);
			if (!settings.enabled) return;
			const current = state(ctx);
			pending.delete(ctx.sessionManager);
			const sessionId = ctx.sessionManager.getSessionId();
			const seq = (sequence.get(sessionId) ?? 0) + 1;
			sequence.set(sessionId, seq);
			const window = ctx.model?.contextWindow;
			const before = turn?.tokens?.before;
			const pressure = typeof before === "number" && window && window > 0 ? before / window : null;
			const emergency = turn?.emergency;
			const input: MetricsInput = {
				seq,
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
				folds: { requested: current.requested, accepted: current.accepted, refused: current.refused, dropped: current.dropped },
				compaction: current.compaction,
				usage: previousUsage(ctx),
			};
			const agentDir = options.agentDir();
			chain = chain.then(async () => {
				try {
					await appendMetricsRecord(agentDir, buildMetricsRecord(input), settings);
				} catch (error) { options.log?.(`metrics: write failed: ${error instanceof Error ? error.message : String(error)}`); }
			});
		},
	};
	return {
		observers,
		noteCompaction(ctx, note) {
			if (settingsOf(ctx).enabled) state(ctx).compaction = note;
		},
		flush: () => chain,
	};
}
