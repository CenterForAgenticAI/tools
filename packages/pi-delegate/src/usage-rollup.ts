import type { RunResult } from "./fork-runner.js";
import type { DelegateDispatchState } from "./runtime.js";

export const DELEGATE_USAGE_CUSTOM_TYPE = "pi-delegate:usage-rollup";
export const DELEGATE_USAGE_SCHEMA_VERSION = 2 as const;
export type DelegateUsageSchemaVersion = 1 | typeof DELEGATE_USAGE_SCHEMA_VERSION;
/**
 * Selects the cache accounting rule for a usage record:
 * - `aggregate-includes-ticker`: aggregate cache fields already include ticker usage.
 * - `split-excludes-ticker`: supervisor/worker split fields exclude ticker usage;
 *   ticker fields must be added to obtain the aggregate.
 */
export type DelegateUsageCacheSemantics = "aggregate-includes-ticker" | "split-excludes-ticker";

export interface DelegateUsageProvenance {
	version: DelegateUsageSchemaVersion;
	/** For `aggregate-includes-ticker`, aggregate cache-read fields include ticker reads; for `split-excludes-ticker`, supervisor/worker fields exclude ticker reads and `tickerCacheRead` must be added. */
	cacheRead: DelegateUsageCacheSemantics;
	/** For `aggregate-includes-ticker`, aggregate cache-write fields include ticker writes; for `split-excludes-ticker`, supervisor/worker fields exclude ticker writes and `tickerCacheWrite` must be added. */
	cacheWrite: DelegateUsageCacheSemantics;
}

export type UsageCounterKey =
	| "supervisorInput"
	| "supervisorOutput"
	| "supervisorCacheRead"
	| "supervisorCacheWrite"
	| "workerInput"
	| "workerOutput"
	| "workerCacheRead"
	| "workerCacheWrite"
	| "input"
	| "output"
	| "tickerInput"
	| "tickerOutput"
	| "tickerCacheRead"
	| "tickerCacheWrite"
	| "tickerCost"
	| "cacheRead"
	| "cacheWrite"
	| "totalTokens"
	| "cost"
	| "runs"
	/** Stable serialized counter key retained for compatibility. */
	| "forks";

export type UsageNormalizationReason = "not-a-number" | "negative" | "non-finite";

export interface UsageNormalizationDiagnostic {
	field: UsageCounterKey;
	reason: UsageNormalizationReason;
}

export interface NormalizedUsageCounters {
	usage: Partial<Record<UsageCounterKey, number>>;
	diagnostics: UsageNormalizationDiagnostic[];
}

const USAGE_COUNTER_KEYS: readonly UsageCounterKey[] = [
	"supervisorInput",
	"supervisorOutput",
	"supervisorCacheRead",
	"supervisorCacheWrite",
	"workerInput",
	"workerOutput",
	"workerCacheRead",
	"workerCacheWrite",
	"input",
	"output",
	"tickerInput",
	"tickerOutput",
	"tickerCacheRead",
	"tickerCacheWrite",
	"tickerCost",
	"cacheRead",
	"cacheWrite",
	"totalTokens",
	"cost",
	"runs",
	"forks",
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function hasOwn(value: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * The single numeric boundary for usage producers. Missing counters are zero;
 * supplied values must be numbers that are finite and non-negative. Rejected
 * values become zero and are reported so callers can surface or persist the
 * producer diagnostic without contaminating totals.
 */
export function normalizeUsageCounters(raw: unknown): NormalizedUsageCounters {
	const usage: Partial<Record<UsageCounterKey, number>> = {};
	const diagnostics: UsageNormalizationDiagnostic[] = [];
	if (!isRecord(raw)) return { usage, diagnostics };

	for (const field of USAGE_COUNTER_KEYS) {
		if (!hasOwn(raw, field)) continue;
		const value = raw[field];
		if (value === undefined) continue;
		if (typeof value !== "number") {
			diagnostics.push({ field, reason: "not-a-number" });
			continue;
		}
		if (!Number.isFinite(value)) {
			diagnostics.push({ field, reason: "non-finite" });
			continue;
		}
		if (value < 0) {
			diagnostics.push({ field, reason: "negative" });
			continue;
		}
		usage[field] = value;
	}
	return { usage, diagnostics };
}

/** Add finite non-negative usage counters without allowing overflow. */
export function saturatingAdd(left: number, right: number): number {
	const sum = left + right;
	if (sum === Number.POSITIVE_INFINITY) return Number.MAX_VALUE;
	if (sum === Number.NEGATIVE_INFINITY) return -Number.MAX_VALUE;
	return sum;
}

export interface DelegateUsageTotals {
	/** Supervisor-clone input tokens (supervised mode only). */
	supervisorInput: number;
	/** Supervisor-clone output tokens (supervised mode only). */
	supervisorOutput: number;
	/** Worker/direct-agent input tokens. */
	workerInput: number;
	/** Worker/direct-agent output tokens. */
	workerOutput: number;
	/** Aggregate input tokens across supervisor + worker + ticker sessions. */
	input: number;
	/** Aggregate output tokens across supervisor + worker + ticker sessions. */
	output: number;
	/** Activity-ticker model input tokens, retained as a distinct breakdown. */
	tickerInput: number;
	/** Activity-ticker model output tokens, retained as a distinct breakdown. */
	tickerOutput: number;
	/** Activity-ticker cache-read tokens, retained as a distinct breakdown. */
	tickerCacheRead: number;
	/** Activity-ticker cache-write tokens, retained as a distinct breakdown. */
	tickerCacheWrite: number;
	/** Activity-ticker USD cost. Aggregate `cost` already includes this value. */
	tickerCost: number;
	/** Aggregate cache read tokens, including ticker usage when available. */
	cacheRead: number;
	/** Aggregate cache write tokens, including ticker usage when available. */
	cacheWrite: number;
	/** input + output + cacheRead + cacheWrite. */
	totalTokens: number;
	/** Aggregate USD cost across supervisor + worker + ticker sessions. */
	cost: number;
	/** Number of delegate runs represented. */
	runs: number;
	/** Stable serialized count of run entries/tasks; retained as `forks`. */
	forks: number;
	/** Rejected producer counters observed while normalizing this rollup. */
	diagnostics?: UsageNormalizationDiagnostic[];
}

export interface DelegateRunUsageSummary {
	name: string;
	agent: string;
	status: string;
	usage: DelegateUsageTotals;
}

export interface DelegateUsageMetadata {
	version: typeof DELEGATE_USAGE_SCHEMA_VERSION;
	customType: typeof DELEGATE_USAGE_CUSTOM_TYPE;
	runId: string;
	mode?: string;
	createdAt: string;
	provenance: DelegateUsageProvenance;
	usage: DelegateUsageTotals;
	/** Stable usage metadata field retained for compatibility. */
	forks: DelegateRunUsageSummary[];
}

export interface DelegateUsageRecord {
	runId?: string;
	source: "tool-result" | "custom-message" | "custom-entry" | "runtime";
	version: DelegateUsageSchemaVersion;
	provenance: DelegateUsageProvenance;
	usage: DelegateUsageTotals;
	/** Stable usage record field retained for compatibility. */
	forks?: DelegateRunUsageSummary[];
}

export function emptyDelegateUsageTotals(): DelegateUsageTotals {
	return {
		supervisorInput: 0,
		supervisorOutput: 0,
		workerInput: 0,
		workerOutput: 0,
		input: 0,
		output: 0,
		tickerInput: 0,
		tickerOutput: 0,
		tickerCacheRead: 0,
		tickerCacheWrite: 0,
		tickerCost: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: 0,
		runs: 0,
		forks: 0,
	};
}

/** Minimal trusted node shape used by retry-aware presentation layers. */
export interface RetryUsageNode {
	readonly identity?: { readonly runId: string; readonly forkName: string };
	readonly attempt?: number;
	readonly retryOf?: { readonly runId: string; readonly forkName: string };
	readonly retriedBy?: { readonly runId: string; readonly forkName: string };
	readonly usage?: RunResult["usage"];
}

/** Sum each valid attempt in a bounded retry lane exactly once. */
export function cumulativeRetryUsage(
	current: RetryUsageNode,
	lookup: (runId: string, forkName: string) => RetryUsageNode | undefined,
	maxDepth = 100,
): { usage: DelegateUsageTotals; complete: boolean } {
	let usage = runUsageTotals(current.usage);
	let currentNode = current;
	let cursor = current.retryOf;
	const seen = new Set<string>();
	for (let depth = 0; cursor && depth < maxDepth; depth++) {
		const key = `${cursor.runId}\u0000${cursor.forkName}`;
		if (seen.has(key)) return { usage, complete: false };
		seen.add(key);
		const prior = lookup(cursor.runId, cursor.forkName);
		if (!prior) return { usage, complete: false };
		if (!prior.retriedBy || !currentNode.identity || prior.retriedBy.runId !== currentNode.identity.runId || prior.retriedBy.forkName !== currentNode.identity.forkName) {
			return { usage, complete: false };
		}
		if (currentNode.attempt !== undefined && prior.attempt !== undefined && currentNode.attempt !== prior.attempt + 1) {
			return { usage, complete: false };
		}
		usage = addDelegateUsageTotals(usage, runUsageTotals(prior.usage));
		currentNode = prior;
		cursor = prior.retryOf;
	}
	return { usage, complete: cursor === undefined };
}

/**
 * Normalize one live/completed run's rolling counters into the same derived
 * totals used by the durable session rollup.
 */
export function runUsageTotals(
	usage: RunResult["usage"] | undefined,
): DelegateUsageTotals {
	const totals = emptyDelegateUsageTotals();
	if (!usage) return totals;
	const normalized = normalizeUsageCounters(usage);
	const values = normalized.usage;
	totals.supervisorInput = counter(values, "supervisorInput");
	totals.supervisorOutput = counter(values, "supervisorOutput");
	totals.workerInput = counter(values, "workerInput");
	totals.workerOutput = counter(values, "workerOutput");
	totals.tickerInput = counter(values, "tickerInput");
	totals.tickerOutput = counter(values, "tickerOutput");
	totals.tickerCacheRead = counter(values, "tickerCacheRead");
	totals.tickerCacheWrite = counter(values, "tickerCacheWrite");
	totals.tickerCost = counter(values, "tickerCost");
	// Aggregate cache fields include ticker usage. Split fields exclude it. The
	// source run shape has no provenance marker, so cacheTotal applies the
	// explicit split-vs-aggregate field boundary for this live producer.
	totals.cacheRead = cacheTotal(
		usage,
		values,
		"cacheRead",
		"supervisorCacheRead",
		"workerCacheRead",
		totals.tickerCacheRead,
		hasOwn(usage, "cacheRead") ? "aggregate-includes-ticker" : "split-excludes-ticker",
	);
	totals.cacheWrite = cacheTotal(
		usage,
		values,
		"cacheWrite",
		"supervisorCacheWrite",
		"workerCacheWrite",
		totals.tickerCacheWrite,
		hasOwn(usage, "cacheWrite") ? "aggregate-includes-ticker" : "split-excludes-ticker",
	);
	totals.cost = counter(values, "cost");
	const diagnostics = diagnosticsWithGenerated(usage.diagnostics, normalized.diagnostics);
	if (diagnostics.length > 0) totals.diagnostics = diagnostics;
	return withDerived(totals);
}

/** Compact token/cost chip shared by per-run and narrow aggregate rows. */
export function formatUsageTotalsCompact(
	usage: Pick<DelegateUsageTotals, "totalTokens" | "cost">,
): string {
	const tokens = Number.isFinite(usage.totalTokens) && usage.totalTokens >= 0 ? usage.totalTokens : 0;
	const cost = Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : 0;
	if (tokens <= 0 && cost <= 0) return "";
	const parts: string[] = [];
	if (tokens > 0) parts.push(`${formatTokensCompact(tokens)} tok`);
	if (cost > 0) parts.push(`$${cost.toFixed(3)}`);
	return parts.join("/");
}

/** Compact per-run token/cost chip for the below-editor status widget. */
export function formatRunUsageCompact(usage: RunResult["usage"] | undefined): string {
	return formatUsageTotalsCompact(runUsageTotals(usage));
}

function counter(values: Partial<Record<UsageCounterKey, number>>, key: UsageCounterKey): number {
	return values[key] ?? 0;
}

function cacheTotal(
	raw: Record<string, unknown>,
	values: Partial<Record<UsageCounterKey, number>>,
	aggregate: "cacheRead" | "cacheWrite",
	splitA: "supervisorCacheRead" | "supervisorCacheWrite",
	splitB: "workerCacheRead" | "workerCacheWrite",
	ticker: number,
	semantics: DelegateUsageCacheSemantics | undefined,
): number {
	const aggregatePresent = hasOwn(raw, aggregate);
	const aggregateValue = counter(values, aggregate);
	const splitValue = saturatingAdd(counter(values, splitA), counter(values, splitB));
	if (semantics === "aggregate-includes-ticker") {
		return aggregatePresent ? aggregateValue : saturatingAdd(splitValue, ticker);
	}
	if (semantics === "split-excludes-ticker") {
		return splitValue > 0 || !aggregatePresent ? saturatingAdd(splitValue, ticker) : aggregateValue;
	}
	// Version-1 records used truthiness to distinguish aggregate from split
	// fields. Preserve that legacy fallback while making v2 provenance explicit.
	return aggregatePresent ? (aggregateValue > 0 ? aggregateValue : splitValue) : saturatingAdd(splitValue, ticker);
}

function withDerived(t: DelegateUsageTotals): DelegateUsageTotals {
	const tickerInput = t.tickerInput;
	const tickerOutput = t.tickerOutput;
	const tickerCacheRead = t.tickerCacheRead;
	const tickerCacheWrite = t.tickerCacheWrite;
	const tickerCost = t.tickerCost;
	const input = saturatingAdd(saturatingAdd(t.supervisorInput, t.workerInput), tickerInput);
	const output = saturatingAdd(saturatingAdd(t.supervisorOutput, t.workerOutput), tickerOutput);
	const cacheRead = t.cacheRead;
	const cacheWrite = t.cacheWrite;
	const totalTokens = saturatingAdd(
		saturatingAdd(saturatingAdd(input, output), cacheRead),
		cacheWrite,
	);
	return {
		supervisorInput: t.supervisorInput,
		supervisorOutput: t.supervisorOutput,
		workerInput: t.workerInput,
		workerOutput: t.workerOutput,
		input,
		output,
		tickerInput,
		tickerOutput,
		tickerCacheRead,
		tickerCacheWrite,
		tickerCost,
		cacheRead,
		cacheWrite,
		totalTokens,
		cost: t.cost,
		runs: Math.trunc(t.runs),
		forks: Math.trunc(t.forks),
		...(t.diagnostics && t.diagnostics.length > 0
			? { diagnostics: diagnosticsWithGenerated(t.diagnostics, []) }
			: {}),
	};
}

export function addDelegateUsageTotals(
	target: DelegateUsageTotals,
	add: Partial<DelegateUsageTotals> | undefined,
): DelegateUsageTotals {
	if (!add) return withDerived(target);
	const normalized = normalizeUsageCounters(add);
	const values = normalized.usage;
	target.supervisorInput = saturatingAdd(target.supervisorInput, counter(values, "supervisorInput"));
	target.supervisorOutput = saturatingAdd(target.supervisorOutput, counter(values, "supervisorOutput"));
	target.workerInput = saturatingAdd(target.workerInput, counter(values, "workerInput"));
	target.workerOutput = saturatingAdd(target.workerOutput, counter(values, "workerOutput"));
	target.tickerInput = saturatingAdd(target.tickerInput, counter(values, "tickerInput"));
	target.tickerOutput = saturatingAdd(target.tickerOutput, counter(values, "tickerOutput"));
	target.tickerCacheRead = saturatingAdd(target.tickerCacheRead, counter(values, "tickerCacheRead"));
	target.tickerCacheWrite = saturatingAdd(target.tickerCacheWrite, counter(values, "tickerCacheWrite"));
	target.tickerCost = saturatingAdd(target.tickerCost, counter(values, "tickerCost"));
	target.cacheRead = saturatingAdd(target.cacheRead, counter(values, "cacheRead"));
	target.cacheWrite = saturatingAdd(target.cacheWrite, counter(values, "cacheWrite"));
	target.cost = saturatingAdd(target.cost, counter(values, "cost"));
	target.runs = saturatingAdd(target.runs, counter(values, "runs"));
	target.forks = saturatingAdd(target.forks, counter(values, "forks"));
	const eventDiagnostics = diagnosticsWithGenerated(add.diagnostics, normalized.diagnostics);
	const diagnostics = diagnosticsWithGenerated(target.diagnostics, eventDiagnostics);
	if (diagnostics.length > 0) target.diagnostics = diagnostics;
	return withDerived(target);
}

export function runResultUsageTotals(r: RunResult): DelegateUsageTotals {
	const totals = runUsageTotals(r.usage);
	totals.forks = 1;
	return withDerived(totals);
}

export function aggregateRunResults(results: readonly RunResult[] | undefined): DelegateUsageTotals {
	const totals = emptyDelegateUsageTotals();
	if (!results || results.length === 0) return totals;
	for (const r of results) addDelegateUsageTotals(totals, runResultUsageTotals(r));
	totals.runs = 1;
	return withDerived(totals);
}

export function delegateUsageFromAggregate(raw: {
	input?: unknown;
	output?: unknown;
	tickerInput?: unknown;
	tickerOutput?: unknown;
	tickerCacheRead?: unknown;
	tickerCacheWrite?: unknown;
	tickerCost?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	cost?: unknown;
	runs?: unknown;
	forks?: unknown;
	diagnostics?: unknown;
}): DelegateUsageTotals {
	const normalized = normalizeUsageCounters(raw);
	const values = normalized.usage;
	const totals = emptyDelegateUsageTotals();
	totals.tickerInput = counter(values, "tickerInput");
	totals.tickerOutput = counter(values, "tickerOutput");
	totals.tickerCacheRead = counter(values, "tickerCacheRead");
	totals.tickerCacheWrite = counter(values, "tickerCacheWrite");
	totals.tickerCost = counter(values, "tickerCost");
	// Aggregate fields already include ticker usage; retain the remainder as the
	// worker bucket because this producer does not expose supervisor splits.
	totals.workerInput = Math.max(0, counter(values, "input") - totals.tickerInput);
	totals.workerOutput = Math.max(0, counter(values, "output") - totals.tickerOutput);
	totals.cacheRead = counter(values, "cacheRead");
	totals.cacheWrite = counter(values, "cacheWrite");
	totals.cost = counter(values, "cost");
	totals.runs = raw.runs === undefined ? 1 : counter(values, "runs");
	totals.forks = raw.forks === undefined ? 1 : counter(values, "forks");
	const diagnostics = diagnosticsWithGenerated(readDiagnostics(raw.diagnostics), normalized.diagnostics);
	if (diagnostics.length > 0) totals.diagnostics = diagnostics;
	return withDerived(totals);
}

export function summarizeRunUsages(results: readonly RunResult[] | undefined): DelegateRunUsageSummary[] {
	return (results ?? []).map((r) => ({
		name: r.name,
		agent: r.agent,
		status: r.status,
		usage: runResultUsageTotals(r),
	}));
}

export function buildDelegateUsageMetadata(
	runId: string,
	results: readonly RunResult[],
	mode?: string,
): DelegateUsageMetadata {
	return {
		version: DELEGATE_USAGE_SCHEMA_VERSION,
		customType: DELEGATE_USAGE_CUSTOM_TYPE,
		runId,
		...(mode ? { mode } : {}),
		createdAt: new Date().toISOString(),
		provenance: {
			version: DELEGATE_USAGE_SCHEMA_VERSION,
			cacheRead: "aggregate-includes-ticker",
			cacheWrite: "aggregate-includes-ticker",
		},
		usage: aggregateRunResults(results),
		forks: summarizeRunUsages(results),
	};
}

function coerceUsageTotals(
	raw: any,
	provenance?: DelegateUsageProvenance,
): DelegateUsageTotals | undefined {
	if (!isRecord(raw)) return undefined;
	const totals = emptyDelegateUsageTotals();
	// New pi-delegate rollup shape.
	if (
		"supervisorInput" in raw ||
		"workerInput" in raw ||
		"input" in raw ||
		"totalTokens" in raw ||
		"cacheRead" in raw ||
		"cacheWrite" in raw ||
		"supervisorCacheRead" in raw ||
		"workerCacheRead" in raw ||
		"supervisorCacheWrite" in raw ||
		"workerCacheWrite" in raw ||
		"tickerInput" in raw ||
		"tickerOutput" in raw ||
		"tickerCacheRead" in raw ||
		"tickerCacheWrite" in raw ||
		"tickerCost" in raw
	) {
		const normalized = normalizeUsageCounters(raw);
		const values = normalized.usage;
		totals.supervisorInput = counter(values, "supervisorInput");
		totals.supervisorOutput = counter(values, "supervisorOutput");
		totals.workerInput = counter(values, "workerInput");
		totals.workerOutput = counter(values, "workerOutput");
		totals.tickerInput = counter(values, "tickerInput");
		totals.tickerOutput = counter(values, "tickerOutput");
		totals.tickerCacheRead = counter(values, "tickerCacheRead");
		totals.tickerCacheWrite = counter(values, "tickerCacheWrite");
		totals.tickerCost = counter(values, "tickerCost");
		// Aggregate input/output already include ticker usage. When no explicit
		// worker/supervisor split exists, retain only the non-ticker remainder in
		// the worker bucket so derived totals do not add ticker tokens twice.
		if (!totals.supervisorInput && !totals.workerInput && raw.input !== undefined) {
			totals.workerInput = Math.max(0, counter(values, "input") - totals.tickerInput);
		}
		if (!totals.supervisorOutput && !totals.workerOutput && raw.output !== undefined) {
			totals.workerOutput = Math.max(0, counter(values, "output") - totals.tickerOutput);
		}
		totals.cacheRead = cacheTotal(
			raw,
			values,
			"cacheRead",
			"supervisorCacheRead",
			"workerCacheRead",
			totals.tickerCacheRead,
			provenance?.cacheRead,
		);
		totals.cacheWrite = cacheTotal(
			raw,
			values,
			"cacheWrite",
			"supervisorCacheWrite",
			"workerCacheWrite",
			totals.tickerCacheWrite,
			provenance?.cacheWrite,
		);
		totals.cost = counter(values, "cost");
		if (!totals.supervisorInput && !totals.workerInput && !totals.supervisorOutput && !totals.workerOutput && raw.totalTokens !== undefined) {
			// Best-effort compatibility with prospective metadata producers that only
			// persist a total token count. Preserve the non-ticker, non-cache value
			// rather than silently dropping the record.
			totals.workerInput = Math.max(
				0,
				counter(values, "totalTokens") -
					totals.cacheRead -
					totals.cacheWrite -
					totals.tickerInput -
					totals.tickerOutput,
			);
		}
		totals.runs = counter(values, "runs");
		totals.forks = counter(values, "forks");
		const diagnostics = diagnosticsWithGenerated(persistedDiagnostics(raw), normalized.diagnostics);
		if (diagnostics.length > 0) totals.diagnostics = diagnostics;
		return withDerived(totals);
	}
	return undefined;
}

function usageVersion(value: unknown): DelegateUsageSchemaVersion | undefined {
	if (value === undefined || value === 1) return 1;
	if (value === DELEGATE_USAGE_SCHEMA_VERSION) return DELEGATE_USAGE_SCHEMA_VERSION;
	return undefined;
}

function cacheSemantics(value: unknown, fallback: DelegateUsageCacheSemantics): DelegateUsageCacheSemantics {
	return value === "aggregate-includes-ticker" || value === "split-excludes-ticker" ? value : fallback;
}

function usageProvenance(
	version: DelegateUsageSchemaVersion,
	raw: unknown,
	explicit: unknown = undefined,
): DelegateUsageProvenance {
	const fallbackRead = isRecord(raw) && hasOwn(raw, "cacheRead")
		? "aggregate-includes-ticker"
		: "split-excludes-ticker";
	const fallbackWrite = isRecord(raw) && hasOwn(raw, "cacheWrite")
		? "aggregate-includes-ticker"
		: "split-excludes-ticker";
	if (!isRecord(explicit)) {
		return { version, cacheRead: fallbackRead, cacheWrite: fallbackWrite };
	}
	return {
		version,
		cacheRead: cacheSemantics(explicit.cacheRead, fallbackRead),
		cacheWrite: cacheSemantics(explicit.cacheWrite, fallbackWrite),
	};
}

export function isUsageCounterKey(value: unknown): value is UsageCounterKey {
	return typeof value === "string" && USAGE_COUNTER_KEYS.some((key) => key === value);
}

export type TickerUsageCounterKey = Extract<UsageCounterKey, `ticker${string}`>;

/** Recognize ticker counters through the canonical usage-key inventory. */
export function isTickerUsageCounterKey(value: unknown): value is TickerUsageCounterKey {
	return isUsageCounterKey(value) && value.startsWith("ticker");
}

export function diagnosticsWithGenerated(
	persisted: unknown,
	generated: unknown,
): UsageNormalizationDiagnostic[] {
	const merged = readDiagnostics(persisted);
	const seen = new Set(merged.map(({ field, reason }) => `${field}:${reason}`));
	for (const diagnostic of readDiagnostics(generated)) {
		const key = `${diagnostic.field}:${diagnostic.reason}`;
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(diagnostic);
	}
	return merged;
}

function readDiagnostics(value: unknown): UsageNormalizationDiagnostic[] {
	if (!Array.isArray(value)) return [];
	const diagnostics: UsageNormalizationDiagnostic[] = [];
	for (const diagnostic of value) {
		if (!isRecord(diagnostic)) continue;
		if (!isUsageCounterKey(diagnostic.field)) continue;
		if (
			diagnostic.reason !== "not-a-number" &&
			diagnostic.reason !== "negative" &&
			diagnostic.reason !== "non-finite"
		) continue;
		diagnostics.push({ field: diagnostic.field, reason: diagnostic.reason });
	}
	return diagnostics;
}

function persistedDiagnostics(raw: Record<string, unknown>): UsageNormalizationDiagnostic[] {
	return readDiagnostics(raw.diagnostics);
}

function recordFromDetails(
	details: any,
	source: DelegateUsageRecord["source"],
	fallbackRunId?: string,
): DelegateUsageRecord | undefined {
	if (!details || typeof details !== "object") return undefined;
	const runId = typeof details.runId === "string" ? details.runId : fallbackRunId;
	const version = usageVersion(details.version);
	if (version === undefined) return undefined;
	if (details.usage) {
		const provenance = isRecord(details.provenance)
			? usageProvenance(version, details.usage, details.provenance)
			: undefined;
		const usage = coerceUsageTotals(details.usage, provenance);
		if (usage) {
			return {
				runId,
				source,
				version,
				provenance: provenance ?? usageProvenance(version, details.usage),
				usage,
				forks: details.usageByFork,
			};
		}
	}
	if (Array.isArray(details.forks)) {
		return {
			runId,
			source,
			version,
			provenance: usageProvenance(version, undefined),
			usage: aggregateRunResults(details.forks as RunResult[]),
			forks: summarizeRunUsages(details.forks as RunResult[]),
		};
	}
	// New result projections use `driver`; retain the old `orchestrate` key as
	// a read-only compatibility fallback for persisted usage entries.
	const driverUsage = details.driver?.usage ?? details.orchestrate?.usage;
	if (driverUsage && typeof driverUsage === "object") {
		return {
			runId,
			source,
			version,
			provenance: usageProvenance(version, driverUsage),
			usage: delegateUsageFromAggregate(driverUsage),
		};
	}
	return undefined;
}

export function extractDelegateUsageRecordsFromEntries(entries: readonly any[]): DelegateUsageRecord[] {
	const out: DelegateUsageRecord[] = [];
	for (const entry of entries ?? []) {
		if (!entry || typeof entry !== "object") continue;

		if (entry.type === "custom" && entry.customType === DELEGATE_USAGE_CUSTOM_TYPE) {
			const data = entry.data;
			const version = usageVersion(data?.version);
			if (version === undefined) continue;
			const provenance = isRecord(data?.provenance)
				? usageProvenance(version, data?.usage, data.provenance)
				: undefined;
			const usage = coerceUsageTotals(data?.usage, provenance);
			if (usage) {
				out.push({
					runId: typeof data?.runId === "string" ? data.runId : entry.id,
					source: "custom-entry",
					version,
					provenance: provenance ?? usageProvenance(version, data.usage),
					usage,
					forks: Array.isArray(data?.forks) ? data.forks : undefined,
				});
			}
			continue;
		}

		if (entry.type === "custom_message" && entry.customType === "delegate:complete") {
			const rec = recordFromDetails(entry.details, "custom-message", entry.id);
			if (rec) out.push(rec);
			continue;
		}

		if (entry.type !== "message") continue;
		const message = entry.message;
		if (!message || typeof message !== "object") continue;
		if (message.role === "toolResult" && message.toolName === "delegate") {
			const rec = recordFromDetails(message.details, "tool-result", entry.id);
			if (rec) out.push(rec);
			continue;
		}
		if (message.role === "custom" && message.customType === "delegate:complete") {
			const rec = recordFromDetails(message.details, "custom-message", entry.id);
			if (rec) out.push(rec);
		}
	}
	return out;
}

export function aggregateUsageRecords(records: readonly DelegateUsageRecord[]): DelegateUsageTotals {
	const totals = emptyDelegateUsageTotals();
	const latestByRunId = new Map<string, DelegateUsageRecord>();
	const unkeyed: DelegateUsageRecord[] = [];
	for (const rec of records ?? []) {
		if (rec.runId) latestByRunId.set(rec.runId, rec);
		else unkeyed.push(rec);
	}
	// A ticker request can settle after the ordinary completion entry was
	// appended. Its durable custom entry is a cumulative revision for the same
	// run, so select the latest record rather than summing or retaining stale
	// first-writer data. Legacy duplicate records remain exact-once.
	for (const rec of [...unkeyed, ...latestByRunId.values()]) {
		addDelegateUsageTotals(totals, rec.usage);
		// Records are run-level. Preserve explicit run counts when supplied by the
		// record, otherwise count the record itself as one run.
		if (!rec.usage.runs) totals.runs = saturatingAdd(totals.runs, 1);
	}
	return withDerived(totals);
}

export function aggregateRunStateUsage(run: Pick<DelegateDispatchState, "finalResult" | "forks">): DelegateUsageTotals {
	if (run.finalResult) return aggregateRunResults(run.finalResult);
	const totals = emptyDelegateUsageTotals();
	for (const runState of Object.values(run.forks ?? {})) {
		const usage = (runState as any).usage;
		if (usage) {
			const usageTotals = coerceUsageTotals(usage);
			if (usageTotals) {
				addDelegateUsageTotals(totals, {
					...usageTotals,
					// Live run usage is per-run and lacks the aggregate `forks` field.
					// Count the run once it has non-zero usage/cost, but avoid making a
					// just-started zero-usage run visible in the footer solely as "(1 run)".
					forks: usageTotals.forks || (usageTotals.totalTokens > 0 || usageTotals.cost > 0 ? 1 : 0),
				});
			}
		} else if (runState.cost) {
			addDelegateUsageTotals(totals, { cost: runState.cost, forks: 1 });
		}
	}
	totals.runs = Object.keys(run.forks ?? {}).length > 0 ? 1 : 0;
	return withDerived(totals);
}

export function usageHasAnyValue(usage: DelegateUsageTotals): boolean {
	return usage.totalTokens > 0 || usage.cost > 0 || usage.forks > 0;
}

export function formatTokensCompact(count: number): string {
	const n = Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0;
	if (n < 1000) return String(n);
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	return `${Math.round(n / 1_000_000)}M`;
}

export function formatDelegateUsageStatus(usage: DelegateUsageTotals): string {
	const parts = ["delegates"];
	if (usage.input) parts.push(`↑${formatTokensCompact(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokensCompact(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokensCompact(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokensCompact(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(3)}`);
	if (usage.runs > 0) parts.push(`(${usage.runs} run${usage.runs === 1 ? "" : "s"})`);
	return parts.join(" ");
}


/** @deprecated Use {@link DelegateRunUsageSummary}; retained for compatibility. */
export type DelegateForkUsageSummary = DelegateRunUsageSummary;
/** @deprecated Use {@link runUsageTotals}; retained for compatibility. */
export const forkUsageTotals = runUsageTotals;
/** @deprecated Use {@link formatRunUsageCompact}; retained for compatibility. */
export const formatForkUsageCompact = formatRunUsageCompact;
/** @deprecated Use {@link runResultUsageTotals}; retained for compatibility. */
export const forkResultUsageTotals = runResultUsageTotals;
/** @deprecated Use {@link aggregateRunResults}; retained for compatibility. */
export const aggregateForkResults = aggregateRunResults;
/** @deprecated Use {@link summarizeRunUsages}; retained for compatibility. */
export const summarizeForkUsages = summarizeRunUsages;
