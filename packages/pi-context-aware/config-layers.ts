/** Layered configuration resolution with per-value provenance.
 *
 * Settings resolve through six layers, lowest to highest:
 *
 *   built-in defaults
 *     → global      <agentDir>/context-aware.json
 *     → project     <project>/.pi/context-aware.json
 *     → CLI flags   --context-aware-*
 *     → session     an override recorded in the session
 *     → host policy declared by whoever created the session   ← wins
 *
 * Two properties matter and both are deliberate.
 *
 * **Merging is per leaf key, never per object.** A project layer that sets
 * `contextCache.scope` overrides only `scope`; every sibling key still comes
 * from whichever lower layer supplied it. Whole-object replacement was the
 * previous behaviour and it silently discarded siblings.
 *
 * **A losing value is retained, not dropped.** Every leaf records the layers
 * that were overruled, so `/context-status` can show that a flag was read and
 * beaten rather than leaving the user to guess why it did nothing.
 */

import { DEFAULT_COMMIT_DRAIN_TIMEOUT_MS } from "./compaction-commit-guard.js";
import {
	DEFAULT_GENERATION_OUTPUT_RESERVE_TOKENS,
	normalizeGenerationOutputReserve,
} from "./generation-budget.js";
import { DEFAULT_RESTART_NOTICE_MIN_AWAY_MS } from "./restart-notice.js";

// ---------------------------------------------------------------------------
// Config shape
// ---------------------------------------------------------------------------

export type SeedMode = "auto-gen" | "user-approve";
export type AmbiguityMode = "inherit" | "ask" | "cautious-proceed" | "always-proceed";

/**
 * What a refused compaction handoff costs.
 *
 * `warn` never blocks a compaction: the refusal is reported and the last
 * prompt the user actually typed is carried forward instead. `enforce` stops
 * and asks. `off` skips the check, so no refusal is produced at all.
 */
export type SeedAuthorityGuardMode = "enforce" | "warn" | "off";
export type CacheScope = "session" | "worktree" | "repo" | "directory";

/**
 * What kind of session this is, declared by whoever created it.
 *
 * `foreground` is a session with a user at a terminal. `worker` is a delegated
 * worker: no user, and its task belongs to the supervisor driving it, so the
 * foreground behaviours (rewriting the task prompt with a model, auto-sending
 * that prompt, injecting a cache listing) actively contradict its protocol.
 *
 * One value rather than a set of behaviour switches: a host declares what the
 * session *is*, and the behaviours follow. That keeps an incoherent combination
 * unrepresentable. See `sessionRoleBehaviour`.
 */
/** How far auto session naming reaches. `all` includes worker sessions. */
export type SessionNamingScope = "all" | "interactive" | "off";

export interface SessionNamingConfig {
	scope: SessionNamingScope;
	/** M: max naming attempts after turn_end before the session stays unnamed. */
	attempts: number;
	/** K: revise a provisional (free-form) name every K turns. */
	reviseEveryTurns: number;
	/** R: max revisions of a provisional name. */
	maxRevisions: number;
	/** Cheap model chain, tried in order. A premium model must never appear here. */
	models: string[];
	/** Free-form fallback name cap. */
	maxNameLength: number;
	/** Character cap on the conversation text sent to the naming call. */
	contextChars: number;
}

export type SessionRole = "foreground" | "worker";
export interface ContextCacheConfig {
	enabled: boolean;
	maxTotalSizeMB: number;
	staleHours: number;
	scope: CacheScope;
	maxListedFiles: number;
	/** Read repository documents through a worktree-scoped pool. */
	readThrough?: boolean;
}

export interface RestartNoticeConfig {
	enabled?: boolean;
	minAwayMs?: number;
}

export interface SummarizerConfig {
	/** Claim Pi's compaction hook and generate context-aware summaries. */
	enabled: boolean;
}

export interface ProactiveCompactionConfig {
	enabled: boolean;
	thresholdFraction: number;
	outputReserveTokens: number;
	/** Maximum idle time without streamed seed output after a stage starts producing text. */
	preparationStallTimeoutMs: number;
	/** Maximum time before the first text output from a preparation stage. */
	preparationFirstOutputGraceMs: number;
	/**
	 * How long a compaction commit waits for an in-flight agent run to end
	 * before it is abandoned and re-queued. `0` never waits.
	 */
	commitDrainTimeoutMs: number;
}

export interface WorkstreamConfig {
	enabled: boolean;
	registryEnabled: boolean;
	activityEnabled: boolean;
	cmuxEnabled: boolean;
	activityToCmux: boolean;
}

/**
 * The delegate busy probe that gates automatic task-continuation.
 *
 * `override` steers the verdict against pi-delegate's shared `run-state.json`:
 * `idle` unblocks a session wedged by another session's leaked orphan run but
 * still reports `busy` when this session provably owns a live run (it never masks
 * own-session work), `busy` never auto-continues while any doubt exists, `auto`
 * (the default) keeps the normal fail-closed reading. The environment variable
 * `PI_CONTEXT_AWARE_BUSY_PROBE` overrides this so the escape hatch is reachable
 * without a config edit. `unattributableStaleMs` is how old an *unattributable*
 * live run may get before it stops suppressing.
 */
export type BusyProbeOverrideSetting = "auto" | "idle" | "busy";

export interface BusyProbeConfig {
	override: BusyProbeOverrideSetting;
	unattributableStaleMs: number;
}

export interface Config {
	seedMode: SeedMode;
	sessionRole: SessionRole;
	compactionModel: string | null;
	overflowFallbackModel: string | null;
	seedRewrite: boolean;
	ambiguityMode: AmbiguityMode;
	seedAuthorityGuard: SeedAuthorityGuardMode;
	summarizer?: SummarizerConfig;
	sessionNaming?: SessionNamingConfig;
	proactiveCompaction?: ProactiveCompactionConfig;
	contextCache?: ContextCacheConfig;
	restartNotice?: RestartNoticeConfig;
	workstream?: WorkstreamConfig;
	busyProbe?: BusyProbeConfig;
}

export const DEFAULT_CONTEXT_CACHE_CONFIG: ContextCacheConfig = {
	enabled: true,
	maxTotalSizeMB: 5,
	staleHours: 24 * 7,
	scope: "worktree",
	maxListedFiles: 12,
	readThrough: true,
};

export const DEFAULT_RESTART_NOTICE_CONFIG: Required<RestartNoticeConfig> = {
	enabled: true,
	minAwayMs: DEFAULT_RESTART_NOTICE_MIN_AWAY_MS,
};

export const DEFAULT_SUMMARIZER_CONFIG: SummarizerConfig = {
	enabled: true,
};

export const DEFAULT_PROACTIVE_COMPACTION_CONFIG: ProactiveCompactionConfig = {
	enabled: true,
	thresholdFraction: 0.78,
	outputReserveTokens: DEFAULT_GENERATION_OUTPUT_RESERVE_TOKENS,
	preparationStallTimeoutMs: 30_000,
	preparationFirstOutputGraceMs: 90_000,
	commitDrainTimeoutMs: DEFAULT_COMMIT_DRAIN_TIMEOUT_MS,
};

export const DEFAULT_WORKSTREAM_CONFIG: WorkstreamConfig = {
	enabled: true,
	registryEnabled: true,
	activityEnabled: true,
	cmuxEnabled: true,
	activityToCmux: false,
};

/**
 * One hour. Long enough that a genuinely slow but live worker of this session
 * is never aged out (an owned run is `busy` regardless of age anyway), short
 * enough that a leaked orphan from a dead session clears within a work break.
 * Kept in step with `session-busy-probe.ts`'s `DEFAULT_UNATTRIBUTABLE_STALE_MS`.
 */
export const DEFAULT_BUSY_PROBE_CONFIG: BusyProbeConfig = {
	override: "auto",
	unattributableStaleMs: 60 * 60 * 1000,
};

export const DEFAULT_SESSION_NAMING_CONFIG: SessionNamingConfig = {
	scope: "all",
	attempts: 3,
	reviseEveryTurns: 10,
	maxRevisions: 2,
	models: ["openai/gpt-5.6-luna"],
	maxNameLength: 40,
	contextChars: 12_000,
};

export const DEFAULT_CONFIG: Config = {
	seedMode: "auto-gen",
	sessionRole: "foreground",
	compactionModel: null,
	overflowFallbackModel: null,
	seedRewrite: true,
	ambiguityMode: "inherit",
	// A refused handoff must not be able to freeze a session that has to compact.
	seedAuthorityGuard: "warn",
	summarizer: DEFAULT_SUMMARIZER_CONFIG,
	sessionNaming: DEFAULT_SESSION_NAMING_CONFIG,
	proactiveCompaction: DEFAULT_PROACTIVE_COMPACTION_CONFIG,
	contextCache: DEFAULT_CONTEXT_CACHE_CONFIG,
	restartNotice: DEFAULT_RESTART_NOTICE_CONFIG,
	workstream: DEFAULT_WORKSTREAM_CONFIG,
	busyProbe: DEFAULT_BUSY_PROBE_CONFIG,
};

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

/** Lowest to highest. Index order IS precedence order; nothing else encodes it. */
export const CONFIG_LAYERS = ["default", "global", "project", "cli", "session", "host"] as const;
export type ConfigLayer = (typeof CONFIG_LAYERS)[number];

export function layerRank(layer: ConfigLayer): number {
	return CONFIG_LAYERS.indexOf(layer);
}

/** Human-facing layer names used by `/context-status`. */
export const LAYER_LABELS: Readonly<Record<ConfigLayer, string>> = {
	default: "default",
	global: "global",
	project: "project",
	cli: "CLI flag",
	session: "session",
	host: "host policy",
};

// ---------------------------------------------------------------------------
// Leaf registry
// ---------------------------------------------------------------------------

/** A validator returns `undefined` for a value this layer does not supply. */
type LeafParser = (value: unknown) => unknown | undefined;

interface LeafDescriptor {
	/** Dotted path, e.g. `contextCache.scope`. Also the provenance key. */
	readonly path: string;
	readonly parse: LeafParser;
	readonly fallback: unknown;
}

function bool(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function oneOf<T extends string>(allowed: readonly T[]): LeafParser {
	return (value) => (typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined);
}

/** A model reference, or an explicit `null` meaning "use the active model". */
function nullableString(value: unknown): string | null | undefined {
	if (value === null) return null;
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function finiteNumber(min: number, max: number): LeafParser {
	return (value) => (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : undefined);
}

function positiveNumber(max: number): LeafParser {
	return (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 && value <= max ? value : undefined);
}

function positiveInteger(min: number): LeafParser {
	return (value) => (typeof value === "number" && Number.isSafeInteger(value) && value >= min ? value : undefined);
}

/** A non-empty array of `provider/model-id` references, e.g. "z-ai/glm-5.3-flash". */
function modelRefList(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	const refs: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") return undefined;
		const ref = item.trim();
		const slash = ref.indexOf("/");
		if (slash <= 0 || slash === ref.length - 1 || ref.includes(" ")) return undefined;
		refs.push(ref);
	}
	return refs;
}

/** Accepts a fraction (0.78) or a percentage (78); anything outside the band is not a value. */
export function normalizeProactiveThreshold(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	const fraction = value > 1 && value <= 100 ? value / 100 : value;
	return fraction >= 0.25 && fraction <= 0.95 ? fraction : undefined;
}

export const CONFIG_LEAVES: readonly LeafDescriptor[] = [
	{ path: "seedMode", parse: oneOf(["auto-gen", "user-approve"]), fallback: DEFAULT_CONFIG.seedMode },
	{ path: "sessionRole", parse: oneOf(["foreground", "worker"]), fallback: DEFAULT_CONFIG.sessionRole },
	{ path: "compactionModel", parse: nullableString, fallback: DEFAULT_CONFIG.compactionModel },
	{ path: "overflowFallbackModel", parse: nullableString, fallback: DEFAULT_CONFIG.overflowFallbackModel },
	{ path: "seedRewrite", parse: bool, fallback: DEFAULT_CONFIG.seedRewrite },
	{ path: "ambiguityMode", parse: oneOf(["inherit", "ask", "cautious-proceed", "always-proceed"]), fallback: DEFAULT_CONFIG.ambiguityMode },
	{ path: "seedAuthorityGuard", parse: oneOf(["enforce", "warn", "off"]), fallback: DEFAULT_CONFIG.seedAuthorityGuard },
	{ path: "summarizer.enabled", parse: bool, fallback: DEFAULT_SUMMARIZER_CONFIG.enabled },

	{ path: "proactiveCompaction.enabled", parse: bool, fallback: DEFAULT_PROACTIVE_COMPACTION_CONFIG.enabled },
	{ path: "proactiveCompaction.thresholdFraction", parse: normalizeProactiveThreshold, fallback: DEFAULT_PROACTIVE_COMPACTION_CONFIG.thresholdFraction },
	{
		path: "proactiveCompaction.outputReserveTokens",
		// normalizeGenerationOutputReserve clamps rather than rejecting, so an
		// absent key must be filtered before it reaches the clamp.
		parse: (value) => (value === undefined ? undefined : normalizeGenerationOutputReserve(value)),
		fallback: DEFAULT_PROACTIVE_COMPACTION_CONFIG.outputReserveTokens,
	},
	{
		path: "proactiveCompaction.preparationStallTimeoutMs",
		parse: (value) => positiveInteger(1)(value),
		fallback: DEFAULT_PROACTIVE_COMPACTION_CONFIG.preparationStallTimeoutMs,
	},
	{
		path: "proactiveCompaction.preparationFirstOutputGraceMs",
		parse: (value) => positiveInteger(1)(value),
		fallback: DEFAULT_PROACTIVE_COMPACTION_CONFIG.preparationFirstOutputGraceMs,
	},
	{
		path: "proactiveCompaction.commitDrainTimeoutMs",
		// Zero is a value, not an absent key: it means never wait for an
		// in-flight run and always re-queue the commit instead.
		parse: (value) => positiveInteger(0)(value),
		fallback: DEFAULT_PROACTIVE_COMPACTION_CONFIG.commitDrainTimeoutMs,
	},

	{ path: "contextCache.enabled", parse: bool, fallback: DEFAULT_CONTEXT_CACHE_CONFIG.enabled },
	{ path: "contextCache.maxTotalSizeMB", parse: positiveNumber(10_000), fallback: DEFAULT_CONTEXT_CACHE_CONFIG.maxTotalSizeMB },
	{ path: "contextCache.staleHours", parse: positiveNumber(24 * 365 * 10), fallback: DEFAULT_CONTEXT_CACHE_CONFIG.staleHours },
	{ path: "contextCache.scope", parse: oneOf(["session", "worktree", "repo", "directory"]), fallback: DEFAULT_CONTEXT_CACHE_CONFIG.scope },
	{ path: "contextCache.maxListedFiles", parse: positiveInteger(1), fallback: DEFAULT_CONTEXT_CACHE_CONFIG.maxListedFiles },
	{ path: "contextCache.readThrough", parse: bool, fallback: DEFAULT_CONTEXT_CACHE_CONFIG.readThrough },

	{ path: "restartNotice.enabled", parse: bool, fallback: DEFAULT_RESTART_NOTICE_CONFIG.enabled },
	{ path: "restartNotice.minAwayMs", parse: finiteNumber(0, Number.MAX_SAFE_INTEGER), fallback: DEFAULT_RESTART_NOTICE_CONFIG.minAwayMs },

	{ path: "workstream.enabled", parse: bool, fallback: DEFAULT_WORKSTREAM_CONFIG.enabled },
	{ path: "workstream.registryEnabled", parse: bool, fallback: DEFAULT_WORKSTREAM_CONFIG.registryEnabled },
	{ path: "workstream.activityEnabled", parse: bool, fallback: DEFAULT_WORKSTREAM_CONFIG.activityEnabled },
	{ path: "workstream.cmuxEnabled", parse: bool, fallback: DEFAULT_WORKSTREAM_CONFIG.cmuxEnabled },
	{ path: "workstream.activityToCmux", parse: bool, fallback: DEFAULT_WORKSTREAM_CONFIG.activityToCmux },
	{ path: "busyProbe.override", parse: oneOf(["auto", "idle", "busy"]), fallback: DEFAULT_BUSY_PROBE_CONFIG.override },
	{ path: "busyProbe.unattributableStaleMs", parse: positiveInteger(1), fallback: DEFAULT_BUSY_PROBE_CONFIG.unattributableStaleMs },

	{ path: "sessionNaming.scope", parse: oneOf(["all", "interactive", "off"]), fallback: DEFAULT_SESSION_NAMING_CONFIG.scope },
	{ path: "sessionNaming.attempts", parse: positiveInteger(1), fallback: DEFAULT_SESSION_NAMING_CONFIG.attempts },
	{ path: "sessionNaming.reviseEveryTurns", parse: positiveInteger(1), fallback: DEFAULT_SESSION_NAMING_CONFIG.reviseEveryTurns },
	{ path: "sessionNaming.maxRevisions", parse: positiveInteger(0), fallback: DEFAULT_SESSION_NAMING_CONFIG.maxRevisions },
	{ path: "sessionNaming.models", parse: modelRefList, fallback: DEFAULT_SESSION_NAMING_CONFIG.models },
	{ path: "sessionNaming.maxNameLength", parse: positiveInteger(4), fallback: DEFAULT_SESSION_NAMING_CONFIG.maxNameLength },
	{ path: "sessionNaming.contextChars", parse: positiveInteger(100), fallback: DEFAULT_SESSION_NAMING_CONFIG.contextChars },
];

const LEAF_BY_PATH: ReadonlyMap<string, LeafDescriptor> = new Map(CONFIG_LEAVES.map((leaf) => [leaf.path, leaf]));

export function isKnownConfigPath(path: string): boolean {
	return LEAF_BY_PATH.has(path);
}

// ---------------------------------------------------------------------------
// Reading a layer
// ---------------------------------------------------------------------------

/** One layer's contribution: only the leaves it actually supplies. */
export interface ConfigLayerInput {
	readonly layer: ConfigLayer;
	/** Where the values came from — a file path, or who declared the policy. */
	readonly origin?: string;
	readonly values: ReadonlyMap<string, unknown>;
	/** Paths present in the source but rejected as invalid. */
	readonly rejected: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPath(source: Record<string, unknown>, path: string): { present: boolean; value: unknown } {
	const segments = path.split(".");
	let cursor: unknown = source;
	for (const segment of segments) {
		if (!isRecord(cursor) || !Object.prototype.hasOwnProperty.call(cursor, segment)) return { present: false, value: undefined };
		cursor = cursor[segment];
	}
	return { present: true, value: cursor };
}

/**
 * Read one layer from a parsed JSON document. Unknown keys are ignored and
 * invalid values are recorded as rejected rather than silently replaced by a
 * default, so a lower layer can still supply them.
 */
export function readConfigLayer(raw: unknown, layer: ConfigLayer, origin?: string): ConfigLayerInput {
	const values = new Map<string, unknown>();
	const rejected: string[] = [];
	if (isRecord(raw)) {
		for (const leaf of CONFIG_LEAVES) {
			const found = readPath(raw, leaf.path);
			if (!found.present) continue;
			const parsed = leaf.parse(found.value);
			if (parsed === undefined) rejected.push(leaf.path);
			else values.set(leaf.path, parsed);
		}
	}
	return { layer, ...(origin === undefined ? {} : { origin }), values, rejected };
}

/** Build a layer directly from already-validated values, for the CLI and session layers. */
export function configLayerFromValues(
	layer: ConfigLayer,
	values: Iterable<readonly [string, unknown]>,
	origin?: string,
): ConfigLayerInput {
	const map = new Map<string, unknown>();
	for (const [path, value] of values) {
		if (LEAF_BY_PATH.has(path) && value !== undefined) map.set(path, value);
	}
	return { layer, ...(origin === undefined ? {} : { origin }), values: map, rejected: [] };
}

// ---------------------------------------------------------------------------
// Layers carried in the session record
// ---------------------------------------------------------------------------

/** The session override and the creating process's policy share one entry type.
 *
 * Both are settings attached to a session; they differ only in who wrote them,
 * so they differ only by the `layer` field. Carrying them in the session record
 * makes both durable and replayable, and is the same seam a host already uses
 * to seed a worker session before its first turn.
 */
export const CONFIG_POLICY_ENTRY_TYPE = "context-aware.policy.v1" as const;
export const CONFIG_POLICY_SCHEMA_VERSION = 1 as const;

/** Only these two layers may be declared through a session record. */
export type PolicyLayer = Extract<ConfigLayer, "session" | "host">;

export interface ConfigPolicyEntryData {
	readonly schemaVersion: typeof CONFIG_POLICY_SCHEMA_VERSION;
	readonly layer: PolicyLayer;
	/** Who declared it, for display — for example `pi-delegate/worker`. */
	readonly declaredBy?: string;
	readonly values?: Readonly<Record<string, unknown>>;
	/** Paths this entry withdraws from its own layer. */
	readonly remove?: readonly string[];
}

export function isPolicyLayer(value: unknown): value is PolicyLayer {
	return value === "session" || value === "host";
}

export function parseConfigPolicyEntry(value: unknown): ConfigPolicyEntryData | null {
	if (!isRecord(value)) return null;
	const data = isRecord(value.data) ? value.data : value;
	if (data.schemaVersion !== CONFIG_POLICY_SCHEMA_VERSION || !isPolicyLayer(data.layer)) return null;
	if (data.declaredBy !== undefined && (typeof data.declaredBy !== "string" || data.declaredBy.trim().length === 0 || data.declaredBy.length > 240)) return null;
	if (data.values !== undefined && !isRecord(data.values)) return null;
	if (data.remove !== undefined && (!Array.isArray(data.remove) || data.remove.some((path) => typeof path !== "string"))) return null;
	return {
		schemaVersion: CONFIG_POLICY_SCHEMA_VERSION,
		layer: data.layer,
		...(data.declaredBy === undefined ? {} : { declaredBy: data.declaredBy }),
		...(data.values === undefined ? {} : { values: data.values }),
		...(data.remove === undefined ? {} : { remove: data.remove as string[] }),
	};
}

function isPolicyEntry(entry: unknown): entry is { customType: string; data: unknown } {
	return isRecord(entry) && entry.type === "custom" && entry.customType === CONFIG_POLICY_ENTRY_TYPE;
}

/**
 * Replay session-carried policy entries into at most one layer each.
 *
 * Entries accumulate rather than replace: a later entry wins for the paths it
 * names and leaves the rest alone, matching how the layers themselves merge.
 * `remove` withdraws a path so a lower layer supplies it again.
 */
export function readPolicyEntryLayers(entries: Iterable<unknown>): ConfigLayerInput[] {
	const values = new Map<PolicyLayer, Map<string, unknown>>([
		["session", new Map()],
		["host", new Map()],
	]);
	const rejected = new Map<PolicyLayer, Set<string>>([
		["session", new Set()],
		["host", new Set()],
	]);
	const declaredBy = new Map<PolicyLayer, string>();

	for (const entry of entries) {
		if (!isPolicyEntry(entry)) continue;
		const parsed = parseConfigPolicyEntry(entry.data);
		if (!parsed) continue;
		const target = values.get(parsed.layer) as Map<string, unknown>;
		const rejectedPaths = rejected.get(parsed.layer) as Set<string>;
		if (parsed.declaredBy) declaredBy.set(parsed.layer, parsed.declaredBy);
		for (const path of parsed.remove ?? []) {
			target.delete(path);
			rejectedPaths.delete(path);
		}
		for (const [path, raw] of Object.entries(parsed.values ?? {})) {
			const leaf = LEAF_BY_PATH.get(path);
			if (!leaf) continue;
			const value = leaf.parse(raw);
			if (value === undefined) rejectedPaths.add(path);
			else {
				target.set(path, value);
				rejectedPaths.delete(path);
			}
		}
	}

	const inputs: ConfigLayerInput[] = [];
	for (const layer of ["session", "host"] as const) {
		const layerValues = values.get(layer) as Map<string, unknown>;
		const layerRejected = [...(rejected.get(layer) as Set<string>)];
		if (layerValues.size === 0 && layerRejected.length === 0) continue;
		const origin = declaredBy.get(layer);
		inputs.push({ layer, ...(origin === undefined ? {} : { origin }), values: layerValues, rejected: layerRejected });
	}
	return inputs;
}

/** Build the entry payload a host or command appends to a session. */
export function configPolicyEntry(
	layer: PolicyLayer,
	values: Readonly<Record<string, unknown>>,
	options: { readonly declaredBy?: string; readonly remove?: readonly string[] } = {},
): ConfigPolicyEntryData {
	return {
		schemaVersion: CONFIG_POLICY_SCHEMA_VERSION,
		layer,
		...(options.declaredBy === undefined ? {} : { declaredBy: options.declaredBy }),
		values,
		...(options.remove === undefined ? {} : { remove: options.remove }),
	};
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface OverruledValue {
	readonly layer: ConfigLayer;
	readonly origin?: string;
	readonly value: unknown;
}

export interface ResolvedEntry {
	readonly path: string;
	readonly value: unknown;
	readonly layer: ConfigLayer;
	readonly origin?: string;
	/** Lower layers that supplied a value for this path, highest first. */
	readonly overruled: readonly OverruledValue[];
}

export interface ResolvedConfig {
	readonly config: Config;
	readonly entries: readonly ResolvedEntry[];
	readonly byPath: ReadonlyMap<string, ResolvedEntry>;
	/** Paths present in a layer's source but rejected as invalid, for diagnostics. */
	readonly rejected: readonly { readonly layer: ConfigLayer; readonly path: string }[];
}

function assignPath(target: Record<string, unknown>, path: string, value: unknown): void {
	const segments = path.split(".");
	let cursor = target;
	for (const segment of segments.slice(0, -1)) {
		const next = cursor[segment];
		if (!isRecord(next)) cursor[segment] = {};
		cursor = cursor[segment] as Record<string, unknown>;
	}
	cursor[segments[segments.length - 1] as string] = value;
}

/**
 * Resolve layers into one config plus per-value provenance.
 *
 * Inputs may arrive in any order; precedence comes from `CONFIG_LAYERS`, not
 * from argument order, so a caller cannot reorder priority by accident.
 */
export function resolveConfigLayers(inputs: readonly ConfigLayerInput[]): ResolvedConfig {
	const ordered = [...inputs].sort((a, b) => layerRank(a.layer) - layerRank(b.layer));
	const entries: ResolvedEntry[] = [];
	const rejected: { layer: ConfigLayer; path: string }[] = [];

	for (const input of ordered) {
		for (const path of input.rejected) rejected.push({ layer: input.layer, path });
	}

	for (const leaf of CONFIG_LEAVES) {
		const contributions: OverruledValue[] = [];
		for (const input of ordered) {
			if (!input.values.has(leaf.path)) continue;
			contributions.push({ layer: input.layer, ...(input.origin === undefined ? {} : { origin: input.origin }), value: input.values.get(leaf.path) });
		}
		const winner = contributions[contributions.length - 1];
		const losers = contributions.slice(0, -1).reverse();
		entries.push(
			winner === undefined
				? { path: leaf.path, value: leaf.fallback, layer: "default", overruled: [] }
				: {
						path: leaf.path,
						value: winner.value,
						layer: winner.layer,
						...(winner.origin === undefined ? {} : { origin: winner.origin }),
						overruled: losers,
					},
		);
	}

	const config = {} as Record<string, unknown>;
	for (const entry of entries) assignPath(config, entry.path, entry.value);

	return {
		config: config as unknown as Config,
		entries,
		byPath: new Map(entries.map((entry) => [entry.path, entry])),
		rejected,
	};
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

function describeSource(entry: { layer: ConfigLayer; origin?: string }): string {
	const label = LAYER_LABELS[entry.layer];
	return entry.origin ? `${label}: ${entry.origin}` : label;
}

function renderValue(value: unknown): string {
	if (value === null) return "(active)";
	if (typeof value === "boolean") return value ? "on" : "off";
	return String(value);
}

/**
 * One line per resolved value naming the layer that supplied it, and, when a
 * lower layer was beaten, what it asked for. An overruled CLI flag stays
 * visible: a flag that silently does nothing is the complaint in #22.
 */
export function formatLayerAttribution(resolved: ResolvedConfig, options: { readonly onlyOverridden?: boolean } = {}): string {
	const width = Math.max(...resolved.entries.map((entry) => entry.path.length));
	const lines: string[] = [];
	for (const entry of resolved.entries) {
		if (options.onlyOverridden && entry.layer === "default" && entry.overruled.length === 0) continue;
		const overruled = entry.overruled.length === 0
			? ""
			: `  [overruled: ${entry.overruled.map((loser) => `${describeSource(loser)}=${renderValue(loser.value)}`).join(", ")}]`;
		lines.push(`${entry.path.padEnd(width)}  ${renderValue(entry.value).padEnd(10)} (${describeSource(entry)})${overruled}`);
	}
	return lines.join("\n");
}

/** Paths whose winning layer beat at least one lower layer. */
export function overriddenPaths(resolved: ResolvedConfig): readonly string[] {
	return resolved.entries.filter((entry) => entry.overruled.length > 0).map((entry) => entry.path);
}

// ---------------------------------------------------------------------------
// Behaviour derived from the session role
// ---------------------------------------------------------------------------

/** What a role permits. Derived, never configured directly. */
export interface SessionRoleBehaviour {
	/** Allow a session to initiate a user-requested reconciliation turn. */
	readonly allowCheckin: boolean;
	/** Allow a foreground session to initiate an extension-generated task continuation. */
	readonly allowAutomaticContinuation: boolean;
	/** Send the expanded seed back into the session as a new user message. */
	readonly autoSendSeed: boolean;
	/** Rewrite the task prompt with a model before handing it on. */
	readonly rewriteSeedWithModel: boolean;
	/** Inject the context-cache listing into prompts, seeds and notifications. */
	readonly injectCacheListing: boolean;
	/** Start a compaction mid-reply rather than waiting for a round boundary. */
	readonly compactMidReply: boolean;
	/** Record the prior transcript path in the handoff. */
	readonly recordTranscriptReference: boolean;
}

const FOREGROUND_BEHAVIOUR: SessionRoleBehaviour = {
	allowCheckin: true,
	allowAutomaticContinuation: true,
	autoSendSeed: true,
	rewriteSeedWithModel: true,
	injectCacheListing: true,
	compactMidReply: true,
	recordTranscriptReference: true,
};

/**
 * A worker keeps exactly one part of the foreground handoff: the prior
 * transcript reference. Worker sessions are file-backed and discoverable, so
 * that line is the one piece unambiguously useful to a worker session.
 */
const WORKER_BEHAVIOUR: SessionRoleBehaviour = {
	// A worker reports through its supervisor; it must not initiate a check-in or
	// an extension-generated continuation.
	allowCheckin: false,
	allowAutomaticContinuation: false,
	// The next prompt belongs to the supervisor. Auto-sending starts a second
	// agent run it never requested.
	autoSendSeed: false,
	// The supervisor holds the brief verbatim and does not compact. A model
	// rewrite silently replaces the lane contract with a lossy paraphrase.
	rewriteSeedWithModel: false,
	// A worker session cannot act on a cache listing or its commands.
	injectCacheListing: false,
	// Defer to the host's round boundary.
	compactMidReply: false,
	recordTranscriptReference: true,
};

export function sessionRoleBehaviour(role: SessionRole): SessionRoleBehaviour {
	return role === "worker" ? WORKER_BEHAVIOUR : FOREGROUND_BEHAVIOUR;
}
