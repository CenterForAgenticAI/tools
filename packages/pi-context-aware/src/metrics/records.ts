import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { appendFile, readdir, stat, unlink } from "node:fs/promises";
import * as path from "node:path";
import { SessionDatabase, SessionErasedError } from "../erasure/database.js";
import { openStoreDir, openStoreFile } from "../parity/records.js";

/**
 * The per-turn metrics log (pi-context-aware#286): one JSON line per live model request, numbers and
 * closed codes only. Nothing the model, the user or a tool wrote can reach a record, because
 * `buildMetricsRecord` copies each field by name and checks its type.
 */
export const METRICS_RECORD_VERSION = 1 as const;
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
	"coverage-changed", "source-changed", "too-large", "entry-missing", "branch-changed", "refused", "plan-failed", "other",
] as const;
export type FoldReasonCode = (typeof FOLD_REASON_CODES)[number];
export const COMPACTION_WRITERS = ["context-aware", "fabric", "other", "unknown"] as const;
export type MetricsCompactionWriter = (typeof COMPACTION_WRITERS)[number];

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
	readonly folds: { readonly requested: number; readonly accepted: number; readonly refused: Readonly<Record<string, number>>; readonly dropped: Readonly<Record<string, number>>; readonly tiers?: readonly number[] };
	readonly compaction?: { readonly writer: string; readonly tokensBefore: number | null; readonly tokensAfter: number | null } | null;
	readonly usage?: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number } | null;
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
		readonly tiers: readonly number[];
	};
	readonly compaction: { readonly writer: MetricsCompactionWriter; readonly tokensBefore: number | null; readonly tokensAfter: number | null } | null;
	readonly usage: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number } | null;
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

/** Copy the named, checked fields of an input into a record. Never spreads the input. */
export function buildMetricsRecord(input: MetricsInput): MetricsRecord {
	const emergency = input.emergency;
	const compaction = input.compaction;
	const usage = input.usage;
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
			tiers: (input.folds.tiers ?? []).filter((tier) => tier === 1 || tier === 2 || tier === 3).slice(0, 64),
		},
		compaction: compaction ? { writer: writerOf(compaction.writer), tokensBefore: num(compaction.tokensBefore), tokensAfter: num(compaction.tokensAfter) } : null,
		usage: usage ? { input: count(usage.input), output: count(usage.output), cacheRead: count(usage.cacheRead), cacheWrite: count(usage.cacheWrite) } : null,
	};
}

function sessionFileStem(sessionId: string): string {
	if (!/^[A-Za-z0-9._-]+$/u.test(sessionId) || sessionId === "." || sessionId === "..") throw new Error("Invalid metrics session id");
	return sessionId;
}
export function metricsSessionFile(agentDir: string, sessionId: string): string {
	return path.join(agentDir, ...METRICS_STORE_DIRS, `${sessionFileStem(sessionId)}.jsonl`);
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
