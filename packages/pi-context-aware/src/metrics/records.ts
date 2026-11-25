import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { appendFile, readdir, stat, unlink } from "node:fs/promises";
import * as path from "node:path";
import { SessionDatabase, SessionErasedError } from "../erasure/database.js";
import { openStoreDir, openStoreFile } from "../parity/records.js";
import { REFUSAL_RULES } from "../strategy/contract.js";
import { GUIDANCE_VARIANTS, STEERS } from "../strategy/guidance.js";
import { STAGE_IDS } from "../strategy/live.js";
import { CONTEXT_METHODS, parseMethodSetId } from "../strategy/methods.js";

/**
 * The per-turn metrics log (pi-context-aware#286): one JSON line per live model request, numbers and
 * closed codes only. Nothing the model, the user or a tool wrote can reach a record, because
 * `buildMetricsRecord` copies each field by name and checks its type.
 *
 * Version 2 (pi-context-aware#473) added the session's strategy (recipe, where it came from, shadow recipes), each
 * stage's outcome on the request, and recalls by reference. A version 1 record has none of them.
 * Version 3 (pi-context-aware#526) names the session's methods instead of a recipe: `strategy` holds the methods,
 * where they came from, the shadow method lists and the guidance, and a stage's `recipe` is the id of the method
 * set it ran for, such as `fold+compact`.
 * Version 4 (pi-context-aware#459) adds `steer`, the wording the request's nudge and context_fold guideline were
 * chosen in; `compaction.trigger`, what asked for the compaction; and `folds.freedTokens`, the tokens the folds
 * written for the request freed. A reader of versions 1 to 3 ignores them.
 */
export const METRICS_RECORD_VERSION = 4 as const;
export const METRICS_STORE_DIRS = ["context-aware", "metrics", "v1"] as const;
/** Largest a session file may be before the oldest records are dropped. */
export const DEFAULT_METRICS_MAX_BYTES = 4 * 1024 * 1024;
/** Largest the whole metrics directory may be before the oldest session files are removed. */
export const DEFAULT_METRICS_MAX_DIR_BYTES = 64 * 1024 * 1024;

export const BANDS = ["ok", "warn", "urgent"] as const;
export type MetricsBand = (typeof BANDS)[number];
export const NUDGE_KINDS = ["tier1", "tier2", "tier3", "emergency", "fold"] as const;
export type MetricsNudgeKind = (typeof NUDGE_KINDS)[number];
/** Reason codes of a refused or dropped fold: the parity reject codes plus the engine's own drop and failure codes. */
export const FOLD_REASON_CODES = [
	"summary-empty", "summary-short", "summary-long", "unknown-ref", "dangling-ref", "consumed", "protected-zone", "split", "too-small", "no-fold", "header-missing", "stub-summary",
	"coverage-changed", "source-changed", "too-large", "entry-missing", "branch-changed", "refused", "plan-failed", "other", "unknown",
] as const;
export type FoldReasonCode = (typeof FOLD_REASON_CODES)[number];
export const COMPACTION_WRITERS = ["context-aware", "fabric", "extension", "pi", "malformed", "none", "other", "unknown"] as const;
export type MetricsCompactionWriter = (typeof COMPACTION_WRITERS)[number];
/**
 * What asked for a compaction (pi-context-aware#459): `tool` the model's `context_compact`, `proactive` a threshold
 * (this extension's or Pi's), `overflow` Pi's recovery from an overflowed request, `operator` a person's `/compact`,
 * `other` anything else (another extension's handoff, a compaction-owner request).
 */
export const COMPACTION_TRIGGERS = ["tool", "proactive", "overflow", "operator", "other"] as const;
export type MetricsCompactionTrigger = (typeof COMPACTION_TRIGGERS)[number];
/** The trigger of a compaction this extension queued. */
export type QueuedCompactionTrigger = Extract<MetricsCompactionTrigger, "tool" | "proactive" | "other">;
/**
 * A committed compaction's trigger, from Pi's reason (`manual`, `threshold`, `overflow`) and the trigger of the
 * compaction this extension queued, if this is that one. Pi reports every compaction an extension starts as `manual`,
 * so a queued trigger wins over it; an overflow wins over both, because Pi compacted to recover the request.
 */
export function compactionTriggerOf(reason: string | undefined, queued: QueuedCompactionTrigger | undefined): MetricsCompactionTrigger {
	if (reason === "overflow") return "overflow";
	if (queued) return queued;
	if (reason === "threshold") return "proactive";
	if (reason === "manual") return "operator";
	return "other";
}
/** The wording a request got, or `other` (pi-context-aware#459). */
export const RECORD_STEERS = [...STEERS, "other"] as const;
export type MetricsSteer = (typeof RECORD_STEERS)[number];

/** Closed lists of the strategy fields (pi-context-aware#473, pi-context-aware#526). A value outside its list is written as `other`. */
export const RECORD_METHODS = [...CONTEXT_METHODS, "other"] as const;
export const RECORD_METHODS_SOURCES = ["strategy.methods", "folds.engine", "auto", "other"] as const;
export const RECORD_GUIDANCE = [...GUIDANCE_VARIANTS, "other"] as const;
export const RECORD_STAGE_IDS = [...Object.values(STAGE_IDS), "view", "other"] as const;
export const RECORD_STAGE_ROLES = ["active", "shadow", "other"] as const;
export const RECORD_STAGE_TRIGGERS = ["request", "compaction", "other"] as const;
export const RECORD_STAGE_OUTCOMES = ["applied", "shadowed", "refused", "deferred", "unapplied", "failed", "other"] as const;
export const RECORD_REFUSAL_CODES = [...Object.keys(REFUSAL_RULES), "other"] as readonly string[];
/** Most stages one record lists; the rest are counted in `stagesOmitted`. */
export const MAX_RECORDED_STAGES = 32;
/** Most shadow method lists, methods in a list, and refusal codes one record lists. */
const MAX_RECORDED_SHADOW = 8;
const MAX_RECORDED_METHODS = 8;
const MAX_RECORDED_CODES = 8;

/** One stage's outcome on a request or a compaction, as the strategy runtime reported it. */
export interface MetricsStageInput {
	readonly trigger: string;
	readonly recipe: string;
	readonly role: string;
	readonly stage: string;
	readonly outcome: string;
	readonly codes: readonly string[];
}
export interface MetricsStage {
	readonly trigger: (typeof RECORD_STAGE_TRIGGERS)[number];
	/** The id of the method set the stage ran for, such as `fold+compact`, or `other`. */
	readonly recipe: string;
	readonly role: (typeof RECORD_STAGE_ROLES)[number];
	readonly stage: (typeof RECORD_STAGE_IDS)[number];
	readonly outcome: (typeof RECORD_STAGE_OUTCOMES)[number];
	readonly codes: readonly string[];
}
export interface MetricsStrategyInput {
	readonly methods: readonly string[];
	readonly source: string;
	readonly shadow: readonly (readonly string[])[];
	readonly guidance: string;
}
export type MetricsMethod = (typeof RECORD_METHODS)[number];
export interface MetricsStrategy {
	readonly methods: readonly MetricsMethod[];
	readonly source: (typeof RECORD_METHODS_SOURCES)[number];
	readonly shadow: readonly (readonly MetricsMethod[])[];
	readonly guidance: (typeof RECORD_GUIDANCE)[number];
}

export interface MetricsInput {
	readonly seq: number;
	readonly at: Date;
	readonly sessionId: string;
	readonly leafId?: string | null;
	readonly modelId?: string | null;
	readonly window?: number | null;
	readonly tokensBefore?: number | null;
	readonly tokensAfter?: number | null;
	readonly pressure?: number | null;
	readonly band?: MetricsBand | null;
	readonly nudge?: MetricsNudgeKind | null;
	readonly emergency?: { readonly truncated: number; readonly hides: number; readonly skipped: boolean; readonly terminal: boolean } | null;
	readonly passFailed?: boolean;
	readonly folds: { readonly requested: number; readonly accepted: number; readonly refused: Readonly<Record<string, number>>; readonly dropped: Readonly<Record<string, number>>; readonly tiers?: readonly number[] | null; readonly freedTokens?: number };
	readonly compaction?: { readonly writer: string; readonly trigger?: string; readonly tokensBefore: number | null; readonly tokensAfter: number | null } | null;
	/** The wording the request's nudge and context_fold guideline were chosen in (pi-context-aware#459). */
	readonly steer?: string | null;
	readonly usage?: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number } | null;
	readonly strategy?: MetricsStrategyInput | null;
	readonly stages?: readonly MetricsStageInput[];
	/** `context_recall` calls by reference during the request that returned a fold's or a hide's entries. */
	readonly recalls?: { readonly folds: number; readonly hides: number } | null;
}

export interface MetricsRecord {
	readonly v: typeof METRICS_RECORD_VERSION;
	readonly seq: number;
	readonly at: string;
	readonly sessionId: string;
	readonly leafId: string | null;
	readonly modelId: string | null;
	readonly window: number | null;
	readonly tokensBefore: number | null;
	readonly tokensAfter: number | null;
	readonly pressure: number | null;
	readonly band: MetricsBand | null;
	readonly nudge: MetricsNudgeKind | null;
	readonly emergency: { readonly truncated: number; readonly hides: number; readonly skipped: boolean; readonly terminal: boolean } | null;
	readonly passFailed: boolean;
	readonly folds: {
		readonly requested: number;
		readonly accepted: number;
		readonly refused: Readonly<Record<string, number>>;
		readonly dropped: Readonly<Record<string, number>>;
		readonly tiers: readonly number[] | null;
		/** Tokens the folds written for this request freed: each fold's hidden tokens less its summary's, never below 0 per fold. */
		readonly freedTokens: number;
	};
	readonly compaction: { readonly writer: MetricsCompactionWriter; readonly trigger: MetricsCompactionTrigger; readonly tokensBefore: number | null; readonly tokensAfter: number | null } | null;
	/** The wording the request got; null when nothing reported it. */
	readonly steer: MetricsSteer | null;
	readonly usage: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number } | null;
	/** The session's methods; null when nothing reported them. */
	readonly strategy: MetricsStrategy | null;
	/** Each stage that acted on the request, and on a compaction asked for during it; shadow method lists carry role `shadow`. */
	readonly stages: readonly MetricsStage[];
	readonly stagesOmitted: number;
	readonly recalls: { readonly folds: number; readonly hides: number };
}

const ID = /^[A-Za-z0-9._:/@+-]{1,128}$/u;
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
const count = (value: unknown): number => num(value) ?? 0;
const id = (value: unknown): string | null => (typeof value === "string" && ID.test(value) ? value : null);
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | null => (typeof value === "string" && (values as readonly string[]).includes(value) ? (value as T) : null);
function codeCounts(source: Readonly<Record<string, number>>): Record<string, number> {
	const out: Record<string, number> = {};
	for (const code of FOLD_REASON_CODES) {
		const n = num(source[code]);
		if (n) out[code] = n;
	}
	return out;
}
function writerOf(value: string): MetricsCompactionWriter {
	return oneOf(COMPACTION_WRITERS, value) ?? "other";
}
const closed = <T extends string>(values: readonly T[], value: unknown): T => oneOf(values, value) ?? ("other" as T);
const methodsOf = (list: unknown): MetricsMethod[] => (Array.isArray(list) ? list : []).slice(0, MAX_RECORDED_METHODS).map((method) => closed(RECORD_METHODS, method));
/** A method set id as written, or `other` when it is not one. */
const methodSetIdOf = (value: unknown): string => (typeof value === "string" && parseMethodSetId(value) ? value : "other");
function strategyOf(input: MetricsStrategyInput): MetricsStrategy {
	const shadow = Array.isArray(input.shadow) ? input.shadow : [];
	return {
		methods: methodsOf(input.methods),
		source: closed(RECORD_METHODS_SOURCES, input.source),
		shadow: shadow.slice(0, MAX_RECORDED_SHADOW).map(methodsOf),
		guidance: closed(RECORD_GUIDANCE, input.guidance),
	};
}
function stageOf(input: MetricsStageInput): MetricsStage {
	const codes = Array.isArray(input.codes) ? input.codes : [];
	return {
		trigger: closed(RECORD_STAGE_TRIGGERS, input.trigger),
		recipe: methodSetIdOf(input.recipe),
		role: closed(RECORD_STAGE_ROLES, input.role),
		stage: closed(RECORD_STAGE_IDS, input.stage),
		outcome: closed(RECORD_STAGE_OUTCOMES, input.outcome),
		codes: [...new Set(codes.map((code) => closed(RECORD_REFUSAL_CODES, code)))].slice(0, MAX_RECORDED_CODES),
	};
}

/** Copy the named, checked fields of an input into a record. Never spreads the input. */
export function buildMetricsRecord(input: MetricsInput): MetricsRecord {
	const emergency = input.emergency;
	const compaction = input.compaction;
	const usage = input.usage;
	const stages = Array.isArray(input.stages) ? input.stages : [];
	return {
		v: METRICS_RECORD_VERSION,
		seq: count(input.seq),
		at: input.at.toISOString(),
		sessionId: sessionFileStem(input.sessionId),
		leafId: id(input.leafId),
		modelId: id(input.modelId),
		window: num(input.window),
		tokensBefore: num(input.tokensBefore),
		tokensAfter: num(input.tokensAfter),
		pressure: num(input.pressure),
		band: oneOf(BANDS, input.band),
		nudge: oneOf(NUDGE_KINDS, input.nudge),
		emergency: emergency ? { truncated: count(emergency.truncated), hides: count(emergency.hides), skipped: emergency.skipped === true, terminal: emergency.terminal === true } : null,
		passFailed: input.passFailed === true,
		folds: {
			requested: count(input.folds.requested),
			accepted: count(input.folds.accepted),
			refused: codeCounts(input.folds.refused),
			dropped: codeCounts(input.folds.dropped),
			tiers: input.folds.tiers ? input.folds.tiers.filter((tier) => tier === 1 || tier === 2 || tier === 3).slice(0, 64) : null,
			freedTokens: count(input.folds.freedTokens),
		},
		compaction: compaction ? { writer: writerOf(compaction.writer), trigger: closed(COMPACTION_TRIGGERS, compaction.trigger), tokensBefore: num(compaction.tokensBefore), tokensAfter: num(compaction.tokensAfter) } : null,
		steer: input.steer === undefined || input.steer === null ? null : closed(RECORD_STEERS, input.steer),
		usage: usage ? { input: count(usage.input), output: count(usage.output), cacheRead: count(usage.cacheRead), cacheWrite: count(usage.cacheWrite) } : null,
		strategy: input.strategy ? strategyOf(input.strategy) : null,
		stages: stages.slice(0, MAX_RECORDED_STAGES).map(stageOf),
		stagesOmitted: Math.max(0, stages.length - MAX_RECORDED_STAGES),
		recalls: { folds: count(input.recalls?.folds), hides: count(input.recalls?.hides) },
	};
}

function sessionFileStem(sessionId: string): string {
	if (!/^[A-Za-z0-9._-]+$/u.test(sessionId) || sessionId === "." || sessionId === "..") throw new Error("Invalid metrics session id");
	return sessionId;
}
export function metricsSessionFile(agentDir: string, sessionId: string): string {
	return path.join(agentDir, ...METRICS_STORE_DIRS, `${sessionFileStem(sessionId)}.jsonl`);
}

/**
 * The `seq` of the last line of a session's metrics file, so a resumed session or a new process keeps
 * counting. 0 for a missing or empty file, or when the last line is not a record with a positive integer `seq`.
 * The oldest-first trim keeps the newest lines, so the last line always holds the highest `seq`.
 */
export async function lastMetricsSeq(agentDir: string, sessionId: string): Promise<number> {
	const name = `${sessionFileStem(sessionId)}.jsonl`;
	const dir = await openStoreDir(agentDir, false, METRICS_STORE_DIRS);
	if (!dir) return 0;
	try {
		let text: string;
		try {
			const handle = await openStoreFile(dir, name, constants.O_RDONLY);
			try { text = await handle.readFile("utf8"); } finally { await handle.close(); }
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
			throw error;
		}
		const last = text.split("\n").filter((line) => line.length > 0).at(-1);
		if (last === undefined) return 0;
		try {
			const seq = (JSON.parse(last) as { seq?: unknown }).seq;
			return typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0 ? seq : 0;
		} catch { return 0; }
	} finally { await dir.handle.close(); }
}

export interface MetricsLimits {
	readonly maxBytes: number;
	readonly maxDirBytes: number;
}

/**
 * Append one record. When the file would pass `maxBytes`, the oldest records are dropped first, down to
 * half the cap so the file is not rewritten on every request. When the directory passes `maxDirBytes`,
 * the oldest other session files are removed. An erased session id writes nothing.
 */
export async function appendMetricsRecord(agentDir: string, record: MetricsRecord, limits: MetricsLimits): Promise<void> {
	const name = `${sessionFileStem(record.sessionId)}.jsonl`;
	const line = `${JSON.stringify(record)}\n`;
	const lineBytes = Buffer.byteLength(line);
	if (lineBytes > limits.maxBytes) return;
	const db = new SessionDatabase(agentDir);
	const owner = randomUUID();
	try {
		try { db.openSession(record.sessionId, null, owner); } catch (error) {
			if (error instanceof SessionErasedError) return;
			throw error;
		}
		const dir = await openStoreDir(agentDir, true, METRICS_STORE_DIRS);
		if (!dir) throw new Error("Metrics store was not created");
		try {
			const handle = await openStoreFile(dir, name, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT, 0o600);
			try {
				const size = (await handle.stat()).size;
				if (size + lineBytes > limits.maxBytes) {
					const lines = (await handle.readFile("utf8")).split("\n").slice(0, -1);
					let total = lineBytes;
					const kept: string[] = [];
					for (let i = lines.length - 1; i >= 0; i--) {
						const bytes = Buffer.byteLength(lines[i]!) + 1;
						if (total + bytes > limits.maxBytes / 2) break;
						total += bytes;
						kept.unshift(lines[i]!);
					}
					await handle.truncate(0);
					await appendFile(handle, kept.map((kept) => `${kept}\n`).join("") + line);
				} else {
					await appendFile(handle, line);
				}
			} finally { await handle.close(); }
			await trimDirectory(dir.path, name, limits.maxDirBytes);
		} finally { await dir.handle.close(); }
	} finally { db.closeSession(record.sessionId, owner); db.close(); }
}

async function trimDirectory(dirPath: string, keep: string, maxDirBytes: number): Promise<void> {
	const files: { name: string; size: number; mtime: number }[] = [];
	for (const name of await readdir(dirPath)) {
		if (!name.endsWith(".jsonl")) continue;
		try {
			const info = await stat(`${dirPath}/${name}`);
			if (info.isFile()) files.push({ name, size: info.size, mtime: info.mtimeMs });
		} catch { /* Removed by another process. */ }
	}
	let total = files.reduce((sum, file) => sum + file.size, 0);
	for (const file of files.filter((candidate) => candidate.name !== keep).sort((a, b) => a.mtime - b.mtime)) {
		if (total <= maxDirBytes) break;
		try { await unlink(`${dirPath}/${file.name}`); total -= file.size; } catch { /* Gone already. */ }
	}
}
