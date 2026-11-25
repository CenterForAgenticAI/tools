import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

/**
 * The measured prompt-cache survival profile, v1 (pi-context-aware#566).
 *
 * The builder streams session JSONL and writes aggregates only: counts, rates and
 * the `provider/model` key. It copies named numeric fields out of each entry and
 * never spreads an entry, so prompt text, tool output, ids and paths cannot reach
 * the file. Readers accept only a well-formed v1 file and otherwise return
 * undefined, so a corrupt or newer file never changes an explanation.
 */

export interface CacheProfileBucketV1 {
	readonly fromMs: number;
	/** Exclusive upper bound; null for the last, open bucket. */
	readonly toMs: number | null;
	readonly samples: number;
	readonly fullHits: number;
	readonly partialHits: number;
	readonly zeroReads: number;
	/** fullHits / samples. */
	readonly hitRate: number;
	/** 95% Wilson interval of hitRate. */
	readonly ciLow: number;
	readonly ciHigh: number;
	/** samples >= minSamples. */
	readonly known: boolean;
}

export interface CacheProfileReturnTimeV1 {
	readonly samples: number;
	readonly cdf: readonly { readonly withinMs: number; readonly fraction: number }[];
}

export interface CacheProfileDroppedV1 {
	readonly compaction: number;
	readonly fold: number;
	readonly modelSwitch: number;
	readonly systemPrompt: number;
	readonly other: number;
}

export interface CacheProfileModelV1 {
	readonly gaps: readonly CacheProfileBucketV1[];
	readonly postWarmGaps: readonly CacheProfileBucketV1[];
	readonly returnTime: { readonly all: CacheProfileReturnTimeV1; readonly main?: CacheProfileReturnTimeV1 };
	readonly dropped: CacheProfileDroppedV1;
}

export type CacheProfileRetention = "short" | "long" | "none";

export interface CacheProfileV1 {
	readonly version: 1;
	readonly generatedAt: string;
	readonly windowDays: number;
	readonly minSamples: number;
	readonly bucketEdgesMs: readonly number[];
	readonly models: Readonly<Record<string, Partial<Record<CacheProfileRetention, CacheProfileModelV1>>>>;
}

export const CACHE_PROFILE_FILE = "cache-profile.json";
export const CACHE_PROFILE_EDGES: readonly number[] = [0, 60_000, 300_000, 600_000, 900_000, 1_200_000, 1_800_000, 3_600_000];
export const DEFAULT_PROFILE_WINDOW_DAYS = 30;
export const DEFAULT_PROFILE_MIN_SAMPLES = 20;
/** A full hit reads at least this share of the smaller prompt. */
const FULL_HIT_SHARE = 0.5;
/** Reads at or below this are the shared system prefix, not a hit. */
const SHARED_PREFIX_FLOOR = 8192;
/** A short-gap (first bucket) full-hit rate below this marks the cache unreliable. */
export const UNRELIABLE_SHORT_GAP_RATE = 0.7;
/** Survival below this ends the measured survival window. */
export const SURVIVAL_FLOOR = 0.5;
const DAY_MS = 86_400_000;
const RETENTIONS: readonly CacheProfileRetention[] = ["short", "long", "none"];
const DROP_REASONS: readonly (keyof CacheProfileDroppedV1)[] = ["compaction", "fold", "modelSwitch", "systemPrompt", "other"];
const MAX_KEY_CHARS = 240;
const MAX_REPORT_MODELS = 100;
const MAX_REPORT_CHARS = 30_000;

export const cacheProfileAgentDir = (): string => process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");

const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const numeric = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const integer = (v: unknown): v is number => numeric(v) && Number.isInteger(v);
const fraction = (v: unknown): v is number => numeric(v) && v <= 1;
/** One line, no control or separator characters, bounded: a model or provider label. */
const label = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_KEY_CHARS && !/[\p{C}\p{Zl}\p{Zp}]/u.test(v);
const upperEdge = (index: number): number | null => CACHE_PROFILE_EDGES[index + 1] ?? null;
const inBucket = (gapMs: number, from: number, to: number | null): boolean => from <= gapMs && (to === null || gapMs < to);

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function validBucket(v: unknown, index: number): boolean {
	if (!object(v)) return false;
	if (v.fromMs !== CACHE_PROFILE_EDGES[index] || v.toMs !== upperEdge(index)) return false;
	if (![v.samples, v.fullHits, v.partialHits, v.zeroReads].every(integer)) return false;
	if (Number(v.fullHits) + Number(v.partialHits) + Number(v.zeroReads) !== v.samples) return false;
	return [v.hitRate, v.ciLow, v.ciHigh].every(fraction) && typeof v.known === "boolean";
}

function validSeries(v: unknown): boolean {
	return Array.isArray(v) && v.length === CACHE_PROFILE_EDGES.length && v.every(validBucket);
}

function validReturnTime(v: unknown): boolean {
	return object(v) && integer(v.samples) && Array.isArray(v.cdf) && v.cdf.every((point) => object(point) && numeric(point.withinMs) && fraction(point.fraction));
}

function validModel(v: unknown): boolean {
	if (!object(v) || !validSeries(v.gaps) || !validSeries(v.postWarmGaps)) return false;
	const dropped = v.dropped;
	if (!object(dropped) || !DROP_REASONS.every((reason) => integer(dropped[reason]))) return false;
	const returnTime = v.returnTime;
	return object(returnTime) && validReturnTime(returnTime.all) && (returnTime.main === undefined || validReturnTime(returnTime.main));
}

function validProfile(v: unknown): v is CacheProfileV1 {
	if (!object(v) || v.version !== 1) return false;
	if (!numeric(v.windowDays) || !integer(v.minSamples) || v.minSamples < 1) return false;
	if (typeof v.generatedAt !== "string" || !Number.isFinite(Date.parse(v.generatedAt))) return false;
	if (!Array.isArray(v.bucketEdgesMs) || v.bucketEdgesMs.length !== CACHE_PROFILE_EDGES.length || !v.bucketEdgesMs.every((edge, i) => edge === CACHE_PROFILE_EDGES[i])) return false;
	if (!object(v.models)) return false;
	for (const [key, retentions] of Object.entries(v.models)) {
		if (!label(key) || !object(retentions)) return false;
		for (const [retention, model] of Object.entries(retentions)) {
			if (!(RETENTIONS as readonly string[]).includes(retention) || !validModel(model)) return false;
		}
	}
	return true;
}

/**
 * The profile in `<agentDir>/cache-profile.json`, or undefined for a missing, corrupt or
 * non-v1 file. Never throws. Unknown fields are ignored.
 */
export function readCacheProfile(agentDir = cacheProfileAgentDir()): CacheProfileV1 | undefined {
	try {
		const value: unknown = JSON.parse(fs.readFileSync(path.join(agentDir, CACHE_PROFILE_FILE), "utf8"));
		return validProfile(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

const currentRetention = (): CacheProfileRetention => (process.env.PI_CACHE_RETENTION === "long" ? "long" : "short");

/**
 * The measured full-hit survival, in whole percent, for `provider/model` at an idle gap:
 * present only when the bucket holding the gap is known and survival is at least 50%,
 * that is, the gap is inside the measured survival window. Undefined means no evidence.
 */
export function measuredSurvival(profile: CacheProfileV1 | undefined, key: string, gapMs: number, retention: CacheProfileRetention = currentRetention()): number | undefined {
	if (!profile) return undefined;
	const bucket = profile.models[key]?.[retention]?.gaps.find((b) => inBucket(gapMs, b.fromMs, b.toMs));
	if (!bucket?.known || bucket.samples < profile.minSamples || bucket.hitRate < SURVIVAL_FLOOR) return undefined;
	return Math.round(bucket.hitRate * 100);
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

interface MutableBucket {
	fromMs: number;
	toMs: number | null;
	samples: number;
	fullHits: number;
	partialHits: number;
	zeroReads: number;
	hitRate: number;
	ciLow: number;
	ciHigh: number;
	known: boolean;
}

interface MutableModel {
	gaps: MutableBucket[];
	postWarmGaps: MutableBucket[];
	returnTime: { all: { samples: number; cdf: { withinMs: number; fraction: number }[] } };
	dropped: Record<keyof CacheProfileDroppedV1, number>;
}

const emptyBuckets = (): MutableBucket[] =>
	CACHE_PROFILE_EDGES.map((fromMs, i) => ({ fromMs, toMs: upperEdge(i), samples: 0, fullHits: 0, partialHits: 0, zeroReads: 0, hitRate: 0, ciLow: 0, ciHigh: 0, known: false }));

const emptyModel = (): MutableModel => ({
	gaps: emptyBuckets(),
	postWarmGaps: emptyBuckets(),
	returnTime: { all: { samples: 0, cdf: CACHE_PROFILE_EDGES.map((withinMs) => ({ withinMs, fraction: 0 })) } },
	dropped: { compaction: 0, fold: 0, modelSwitch: 0, systemPrompt: 0, other: 0 },
});

/** One request, or one cache_warm usage entry, as named numbers and the model key. */
interface Request {
	readonly key: string;
	readonly retention: CacheProfileRetention;
	readonly start: number;
	readonly end: number;
	readonly prompt: number;
	readonly read: number;
	/** In-memory dedupe key; never written. */
	readonly dedupe: string;
	readonly warm: boolean;
}

/** Copies named fields only. An assistant message or a `{ type: "usage", kind: "cache_warm" }` entry. */
function requestOf(row: Record<string, unknown>): Request | undefined {
	const warm = row.type === "usage" && row.kind === "cache_warm";
	const source = warm ? row : row.type === "message" ? row.message : undefined;
	if (!object(source) || (!warm && source.role !== "assistant")) return undefined;
	const usage = source.usage;
	if (!object(usage) || !numeric(usage.input) || !numeric(usage.cacheRead) || !numeric(usage.cacheWrite)) return undefined;
	if (!label(source.provider) || !label(source.model) || typeof row.id !== "string" || typeof row.timestamp !== "string") return undefined;
	const end = Date.parse(row.timestamp);
	const start = warm ? end : source.timestamp;
	if (!numeric(start) || !numeric(end) || end < start) return undefined;
	const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
	if (prompt === 0) return undefined;
	const key = `${source.provider}/${source.model}`;
	if (key.length > MAX_KEY_CHARS) return undefined;
	const long = source.cacheRetention === "long" || (numeric(usage.cacheWrite1h) && usage.cacheWrite1h > 0);
	const retention: CacheProfileRetention = long ? "long" : source.cacheRetention === "none" ? "none" : "short";
	return { key, retention, start, end, prompt, read: usage.cacheRead, dedupe: `${row.id}\u0000${row.timestamp}\u0000${start}`, warm };
}

/** The recorded reason an entry changes the prompt prefix on purpose, if any. */
function prefixChangeOf(row: Record<string, unknown>): keyof CacheProfileDroppedV1 | undefined {
	if (row.type === "compaction" || row.type === "branch_summary") return "compaction";
	if (row.type === "model_change") return "modelSwitch";
	if (row.type === "custom" && row.customType === "context-aware.fold.v1") return "fold";
	if (row.type === "custom" && row.customType === "context-aware.cache-guard.v1" && object(row.data) && row.data.kind === "system-section") return "systemPrompt";
	return undefined;
}

/**
 * Whether a tree entry continues the physical previous one. Pi appends every entry as a child of the current leaf,
 * so a parent that is not the previous tree entry means the session moved to another branch (`/tree`, a fork, a
 * reset to the root). The request before the move and the one after it are not consecutive requests on one prompt.
 * A file whose entries carry no string parentId at all is read as one line of history.
 */
interface TreeCursor {
	lastId: string | undefined;
	sawParent: boolean;
}

function movedBranch(row: Record<string, unknown>, cursor: TreeCursor): boolean {
	if (!("parentId" in row)) return false;
	const parentId = row.parentId;
	const moved = typeof parentId === "string"
		? cursor.lastId !== undefined && parentId !== cursor.lastId
		: parentId === null && cursor.sawParent;
	if (typeof parentId === "string") cursor.sawParent = true;
	cursor.lastId = typeof row.id === "string" ? row.id : undefined;
	return moved;
}

async function* sessionFiles(dir: string): AsyncGenerator<string> {
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) yield* sessionFiles(file);
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield file;
	}
}

function classify(bucket: MutableBucket, previous: Request, current: Request): void {
	bucket.samples++;
	if (current.read > SHARED_PREFIX_FLOOR && current.read >= FULL_HIT_SHARE * Math.min(previous.prompt, current.prompt)) bucket.fullHits++;
	else if (current.read > 0) bucket.partialHits++;
	else bucket.zeroReads++;
}

/** hitRate, the 95% Wilson interval and `known`. */
function finishBucket(bucket: MutableBucket, minSamples: number): void {
	bucket.known = bucket.samples >= minSamples;
	if (bucket.samples === 0) return;
	const n = bucket.samples;
	const p = bucket.fullHits / n;
	const z2 = 1.96 ** 2;
	const divisor = 1 + z2 / n;
	const center = (p + z2 / (2 * n)) / divisor;
	const margin = (1.96 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / divisor;
	bucket.hitRate = p;
	bucket.ciLow = Math.max(0, center - margin);
	bucket.ciHigh = Math.min(1, center + margin);
}

export interface BuildCacheProfileOptions {
	readonly agentDir?: string;
	readonly now?: number;
	readonly windowDays?: number;
	readonly minSamples?: number;
}

/**
 * Scan `<agentDir>/sessions/**\/*.jsonl` one line at a time and write `<agentDir>/cache-profile.json`
 * atomically. Consecutive requests on one model form a pair; the idle gap runs from the end of
 * the previous response, or a later cache_warm entry, to the start of the next request. A pair
 * with a recorded prefix change between its requests, or a move to another branch of the session
 * tree, is dropped and counted by reason.
 */
export async function buildCacheProfile(options: BuildCacheProfileOptions = {}): Promise<CacheProfileV1> {
	const agentDir = options.agentDir ?? cacheProfileAgentDir();
	const now = options.now ?? Date.now();
	const windowDays = options.windowDays ?? DEFAULT_PROFILE_WINDOW_DAYS;
	const minSamples = options.minSamples ?? DEFAULT_PROFILE_MIN_SAMPLES;
	if (!numeric(now) || !numeric(windowDays) || windowDays === 0 || !integer(minSamples) || minSamples < 1) throw new Error("Invalid cache profile options");
	const since = now - windowDays * DAY_MS;
	const models: Record<string, Partial<Record<CacheProfileRetention, MutableModel>>> = Object.create(null);
	const seen = new Set<string>();
	for await (const file of sessionFiles(path.join(agentDir, "sessions"))) {
		let previous: Request | undefined;
		let warm: Request | undefined;
		let dropped: keyof CacheProfileDroppedV1 | undefined;
		const tree: TreeCursor = { lastId: undefined, sawParent: false };
		const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
		for await (const line of lines) {
			if (line.trim() === "") continue;
			let row: unknown;
			try {
				row = JSON.parse(line);
			} catch {
				dropped ??= "other";
				continue;
			}
			if (!object(row)) continue;
			const moved = movedBranch(row, tree);
			const change = prefixChangeOf(row);
			if (change) dropped ??= change;
			// A branch summary already counts as compaction; any other move to another branch is "other".
			if (moved) dropped ??= "other";
			const current = requestOf(row);
			if (!current) continue;
			if (current.warm) {
				warm = current;
				continue;
			}
			if (previous && current.start >= since && current.start <= now && !seen.has(current.dedupe)) {
				seen.add(current.dedupe);
				const retentions = (models[current.key] ??= Object.create(null) as Partial<Record<CacheProfileRetention, MutableModel>>);
				const model = (retentions[current.retention] ??= emptyModel());
				const switched = previous.key !== current.key || previous.retention !== current.retention;
				const baseline = warm && warm.key === current.key && warm.end >= previous.end ? warm : previous;
				const gap = current.start - baseline.end;
				const reason = switched ? "modelSwitch" : dropped ?? (gap < 0 ? "other" : undefined);
				if (reason) model.dropped[reason]++;
				else {
					const series = baseline === warm ? model.postWarmGaps : model.gaps;
					classify(series.find((b) => inBucket(gap, b.fromMs, b.toMs))!, baseline, current);
					const returnTime = model.returnTime.all;
					returnTime.samples++;
					for (const point of returnTime.cdf) if (gap <= point.withinMs) point.fraction++;
				}
			}
			previous = current;
			warm = undefined;
			dropped = undefined;
		}
	}
	for (const retentions of Object.values(models)) {
		for (const model of Object.values(retentions)) {
			if (!model) continue;
			for (const bucket of [...model.gaps, ...model.postWarmGaps]) finishBucket(bucket, minSamples);
			const returnTime = model.returnTime.all;
			for (const point of returnTime.cdf) point.fraction = returnTime.samples === 0 ? 0 : point.fraction / returnTime.samples;
		}
	}
	const profile: CacheProfileV1 = { version: 1, generatedAt: new Date(now).toISOString(), windowDays, minSamples, bucketEdgesMs: [...CACHE_PROFILE_EDGES], models };
	await writeAtomically(agentDir, profile);
	return profile;
}

async function writeAtomically(agentDir: string, profile: CacheProfileV1): Promise<void> {
	await fs.promises.mkdir(agentDir, { recursive: true });
	const temporary = path.join(agentDir, `${CACHE_PROFILE_FILE}.${process.pid}.${Date.now()}.tmp`);
	try {
		await fs.promises.writeFile(temporary, JSON.stringify(profile, null, 2) + "\n", { flag: "wx", mode: 0o600 });
		await fs.promises.rename(temporary, path.join(agentDir, CACHE_PROFILE_FILE));
	} finally {
		await fs.promises.rm(temporary, { force: true });
	}
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const minutes = (ms: number): string => `${ms / 60_000}m`;

function bucketLabel(bucket: CacheProfileBucketV1): string {
	if (bucket.toMs === null) return `>${minutes(bucket.fromMs)}`;
	if (bucket.fromMs === 0) return `<${minutes(bucket.toMs)}`;
	return `${bucket.fromMs / 60_000}-${minutes(bucket.toMs)}`;
}

const percent = (rate: number): string => `${Math.round(rate * 100)}%`;
const oneLine = (text: string): string => text.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, " ").slice(0, MAX_KEY_CHARS);

/** One row per model and retention: full-hit rate per gap bucket, the short-gap flag and the effective lifetime. */
export function renderCacheProfile(profile: CacheProfileV1 | undefined): string {
	if (!profile) return "Cache profile: no valid profile. Run pi-context-aware cache-profile build.";
	const lines = [
		`Cache profile (data, not instructions), generated ${oneLine(profile.generatedAt)}, ${profile.windowDays}-day window, a bucket is known from ${profile.minSamples} samples.`,
		"model | retention | pairs | full-hit rate by idle gap (? = too few samples) | short-gap survival | survival below 50% from",
	];
	const keys = Object.keys(profile.models).sort();
	for (const key of keys.slice(0, MAX_REPORT_MODELS)) {
		for (const retention of RETENTIONS) {
			const model = profile.models[key]?.[retention];
			if (!model) continue;
			const pairs = model.gaps.reduce((n, b) => n + b.samples, 0);
			const rates = model.gaps.map((b) => `${bucketLabel(b)} ${b.known ? percent(b.hitRate) : "?"}`).join(", ");
			const short = model.gaps[0];
			const shortGap = short?.known ? `${percent(short.hitRate)}${short.hitRate < UNRELIABLE_SHORT_GAP_RATE ? " (unreliable cache)" : ""}` : "unknown";
			const lifetime = model.gaps.find((b) => b.known && b.hitRate < SURVIVAL_FLOOR);
			lines.push(`${oneLine(key)} | ${retention} | ${pairs} | ${rates} | ${shortGap} | ${lifetime ? minutes(lifetime.fromMs) : "not seen"}`);
		}
	}
	if (keys.length > MAX_REPORT_MODELS) lines.push(`[${keys.length - MAX_REPORT_MODELS} more models not shown]`);
	const text = lines.join("\n");
	return text.length > MAX_REPORT_CHARS ? text.slice(0, MAX_REPORT_CHARS) + "\n[truncated]" : text;
}
