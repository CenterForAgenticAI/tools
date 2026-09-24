/** The versioned session-entry contract for worker round-boundary compaction.
 *
 * pi-context-aware produces this advisory and pi-delegate consumes it without
 * either package importing the other. Keep this plain JSON shape synchronized
 * with the settled `context-aware.worker-compaction.v1` contract.
 */

export const WORKER_COMPACTION_CHANNEL = "context-aware.worker-compaction.v1" as const;
export const WORKER_COMPACTION_SCHEMA_VERSION = 1 as const;
export const MAX_INSTRUCTION_CHARS = 4_000;
export const MAX_ADVISORY_ENTRY_BYTES = 8_192;

/** Repeated pressure below this increase is coalesced into the latest entry. */
export const WORKER_COMPACTION_MATERIAL_FRACTION_DELTA = 0.01;

/** Static worker guidance; producing an advisory must never start a model run. */
export const WORKER_COMPACTION_INSTRUCTIONS =
	"Preserve the worker's delegated brief without rewriting or reinterpreting it. Summarize completed work, the current in-flight tool state, and the immediate next action. Include exact file paths, commands, errors, test results, and commit state needed to continue. State whether the last tool call completed; if it did not, preserve its full intended arguments so it can be issued once without duplicating completed side effects.";

export interface WorkerCompactionUsageV1 {
	readonly tokens: number;
	readonly contextWindow: number;
	readonly fraction: number;
}

export interface WorkerCompactionAdvisoryV1 {
	/** Always 1. An entry with any other value is ignored by the reader. */
	readonly schemaVersion: 1;
	readonly state: "advised" | "required" | "satisfied";
	/** Positive, monotonic per session, and incremented for every appended entry. */
	readonly revision: number;
	/** ISO-8601 UTC timestamp for when the producer observed this state. */
	readonly observedAt: string;
	readonly usage?: WorkerCompactionUsageV1;
	readonly reason?: "threshold" | "generation-reserve" | "output-limit";
	/** Summary instructions passed to `session.compact()` verbatim by the host. */
	readonly instructions?: string;
	/** Present only on `satisfied`: the advisory revision the compaction discharged. */
	readonly satisfiedRevision?: number;
}

interface WorkerCompactionBuildBase {
	readonly revision: number;
	readonly observedAt?: string | Date;
	readonly usage?: WorkerCompactionUsageV1;
}

export type WorkerCompactionAdvisoryBuildInput =
	| (WorkerCompactionBuildBase & {
		readonly state: "advised" | "required";
		readonly reason: "threshold" | "generation-reserve" | "output-limit";
		readonly instructions: string;
	})
	| (WorkerCompactionBuildBase & {
		readonly state: "satisfied";
		readonly satisfiedRevision: number;
	});

export interface WorkerCompactionSessionEntries {
	readonly getEntries: () => readonly unknown[];
	readonly appendCustomEntry: (customType: string, data?: unknown) => unknown;
}

export interface WorkerCompactionPressureObservation {
	readonly state: "advised" | "required";
	readonly reason: "threshold" | "generation-reserve" | "output-limit";
	readonly usage?: WorkerCompactionUsageV1;
	readonly observedAt?: string | Date;
}

export interface WorkerCompactionTurnPressure {
	readonly compactMidReply: boolean;
	readonly proactiveEnabled: boolean;
	readonly checkpoint: boolean;
	readonly stopReason?: string;
	readonly thresholdFraction: number;
	readonly generationSafe?: boolean;
	readonly usage?: WorkerCompactionUsageV1;
	readonly observedAt?: string | Date;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function payloadBytes(value: unknown): number | undefined {
	try {
		const encoded = JSON.stringify(value);
		return encoded === undefined ? undefined : Buffer.byteLength(encoded, "utf8");
	} catch {
		return undefined;
	}
}

function isPositiveSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function isCanonicalUtcTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		return new Date(value).toISOString() === value;
	} catch {
		return false;
	}
}

function parseUsage(value: unknown): WorkerCompactionUsageV1 | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.tokens !== "number" || !Number.isFinite(value.tokens)) return undefined;
	if (typeof value.contextWindow !== "number" || !Number.isFinite(value.contextWindow)) return undefined;
	if (typeof value.fraction !== "number" || !Number.isFinite(value.fraction)) return undefined;
	if (value.fraction < 0 || value.fraction > 1) return undefined;
	return {
		tokens: value.tokens,
		contextWindow: value.contextWindow,
		fraction: value.fraction,
	};
}

function parseWorkerCompactionAdvisoryValue(value: unknown): WorkerCompactionAdvisoryV1 | undefined {
	const bytes = payloadBytes(value);
	if (bytes === undefined || bytes > MAX_ADVISORY_ENTRY_BYTES || !isRecord(value)) return undefined;
	if (value.schemaVersion !== WORKER_COMPACTION_SCHEMA_VERSION) return undefined;
	if (value.state !== "advised" && value.state !== "required" && value.state !== "satisfied") return undefined;
	if (!isPositiveSafeInteger(value.revision)) return undefined;
	if (!isCanonicalUtcTimestamp(value.observedAt)) return undefined;

	const usage = value.usage === undefined ? undefined : parseUsage(value.usage);
	if (value.usage !== undefined && usage === undefined) return undefined;
	if (value.instructions !== undefined
		&& (typeof value.instructions !== "string" || value.instructions.length > MAX_INSTRUCTION_CHARS)) return undefined;

	if (value.state === "satisfied") {
		if (value.reason !== undefined || value.instructions !== undefined) return undefined;
		if (!isPositiveSafeInteger(value.satisfiedRevision)) return undefined;
		return {
			schemaVersion: WORKER_COMPACTION_SCHEMA_VERSION,
			state: value.state,
			revision: value.revision,
			observedAt: value.observedAt,
			...(usage === undefined ? {} : { usage }),
			satisfiedRevision: value.satisfiedRevision,
		};
	}

	if (value.reason !== "threshold" && value.reason !== "generation-reserve" && value.reason !== "output-limit") return undefined;
	if (typeof value.instructions !== "string") return undefined;
	if (value.satisfiedRevision !== undefined) return undefined;
	return {
		schemaVersion: WORKER_COMPACTION_SCHEMA_VERSION,
		state: value.state,
		revision: value.revision,
		observedAt: value.observedAt,
		...(usage === undefined ? {} : { usage }),
		reason: value.reason,
		instructions: value.instructions,
	};
}

/** Parse one advisory without throwing; unknown additive fields are ignored. */
export function parseWorkerCompactionAdvisory(value: unknown): WorkerCompactionAdvisoryV1 | undefined {
	try {
		return parseWorkerCompactionAdvisoryValue(value);
	} catch {
		return undefined;
	}
}

function observedAtString(value: string | Date | undefined): string {
	const observedAt = value instanceof Date ? value.toISOString() : value ?? new Date().toISOString();
	if (!isCanonicalUtcTimestamp(observedAt)) {
		throw new TypeError("observedAt must be a canonical ISO-8601 UTC timestamp ending in Z.");
	}
	return observedAt;
}

function truncateWithoutDanglingSurrogate(value: string, length: number): string {
	const truncated = value.slice(0, length);
	const last = truncated.charCodeAt(truncated.length - 1);
	return last >= 0xD800 && last <= 0xDBFF ? truncated.slice(0, -1) : truncated;
}

function fitInstructionsToPayload(
	input: Extract<WorkerCompactionAdvisoryBuildInput, { state: "advised" | "required" }>,
	observedAt: string,
): WorkerCompactionAdvisoryV1 {
	const bounded = input.instructions.slice(0, MAX_INSTRUCTION_CHARS);
	const candidate = (instructions: string): WorkerCompactionAdvisoryV1 => ({
		schemaVersion: WORKER_COMPACTION_SCHEMA_VERSION,
		state: input.state,
		revision: input.revision,
		observedAt,
		...(input.usage === undefined ? {} : { usage: input.usage }),
		reason: input.reason,
		instructions,
	});
	if ((payloadBytes(candidate(bounded)) ?? Number.POSITIVE_INFINITY) <= MAX_ADVISORY_ENTRY_BYTES) {
		return candidate(bounded);
	}

	let low = 0;
	let high = bounded.length;
	while (low < high) {
		const midpoint = Math.ceil((low + high) / 2);
		const instructions = truncateWithoutDanglingSurrogate(bounded, midpoint);
		if ((payloadBytes(candidate(instructions)) ?? Number.POSITIVE_INFINITY) <= MAX_ADVISORY_ENTRY_BYTES) low = midpoint;
		else high = midpoint - 1;
	}
	return candidate(truncateWithoutDanglingSurrogate(bounded, low));
}

/** Build a canonical advisory while enforcing both instruction and payload bounds. */
export function buildWorkerCompactionAdvisory(input: WorkerCompactionAdvisoryBuildInput): WorkerCompactionAdvisoryV1 {
	const observedAt = observedAtString(input.observedAt);
	const advisory: WorkerCompactionAdvisoryV1 = input.state === "satisfied"
		? {
			schemaVersion: WORKER_COMPACTION_SCHEMA_VERSION,
			state: input.state,
			revision: input.revision,
			observedAt,
			...(input.usage === undefined ? {} : { usage: input.usage }),
			satisfiedRevision: input.satisfiedRevision,
		}
		: fitInstructionsToPayload(input, observedAt);
	if (parseWorkerCompactionAdvisory(advisory) === undefined) {
		throw new TypeError("Cannot build a valid worker compaction advisory from the supplied values.");
	}
	return advisory;
}

function advisoryFromEntry(entry: unknown): WorkerCompactionAdvisoryV1 | undefined {
	if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== WORKER_COMPACTION_CHANNEL) return undefined;
	return parseWorkerCompactionAdvisory(entry.data);
}

/** Return the highest valid revision, independent of entry traversal order. */
export function latestWorkerCompactionAdvisory(entries: readonly unknown[]): WorkerCompactionAdvisoryV1 | undefined {
	let latest: WorkerCompactionAdvisoryV1 | undefined;
	for (const entry of entries) {
		const advisory = advisoryFromEntry(entry);
		if (advisory && (latest === undefined || advisory.revision >= latest.revision)) latest = advisory;
	}
	return latest;
}

export function shouldCoalesceWorkerCompactionPressure(
	latest: WorkerCompactionAdvisoryV1 | undefined,
	observation: WorkerCompactionPressureObservation,
): boolean {
	if (latest === undefined || latest.state === "satisfied") return false;
	// Once pressure is required, a later advised observation must not weaken it.
	if (latest.state === "required" && observation.state === "advised") return true;
	if (latest.state !== observation.state) return false;
	if (latest.usage === undefined) return observation.usage === undefined;
	if (observation.usage === undefined) return true;
	const fractionDelta = observation.usage.fraction - latest.usage.fraction;
	const comparisonEpsilon = Number.EPSILON * Math.max(
		1,
		Math.abs(observation.usage.fraction),
		Math.abs(latest.usage.fraction),
	);
	return fractionDelta < WORKER_COMPACTION_MATERIAL_FRACTION_DELTA - comparisonEpsilon;
}

function sessionEntries(value: unknown): WorkerCompactionSessionEntries | undefined {
	if (!isRecord(value)) return undefined;
	const getEntries = value.getEntries;
	const appendCustomEntry = value.appendCustomEntry;
	if (typeof getEntries !== "function" || typeof appendCustomEntry !== "function") return undefined;
	return {
		getEntries: () => {
			const entries = getEntries.call(value) as unknown;
			return Array.isArray(entries) ? entries : [];
		},
		appendCustomEntry: (customType, data) => appendCustomEntry.call(value, customType, data),
	};
}

/** Append one pressure observation, or coalesce it into the latest advisory. */
export function appendWorkerCompactionPressure(
	session: WorkerCompactionSessionEntries,
	observation: WorkerCompactionPressureObservation,
): WorkerCompactionAdvisoryV1 | undefined {
	const latest = latestWorkerCompactionAdvisory(session.getEntries());
	if (shouldCoalesceWorkerCompactionPressure(latest, observation)) return undefined;
	const advisory = buildWorkerCompactionAdvisory({
		...observation,
		revision: (latest?.revision ?? 0) + 1,
		instructions: WORKER_COMPACTION_INSTRUCTIONS,
	});
	session.appendCustomEntry(WORKER_COMPACTION_CHANNEL, advisory);
	return advisory;
}

/** Classify and append pressure observed at a completed provider turn. */
export function appendWorkerCompactionForTurn(
	sessionManager: unknown,
	turn: WorkerCompactionTurnPressure,
): WorkerCompactionAdvisoryV1 | undefined {
	if (turn.compactMidReply || !turn.proactiveEnabled || !turn.checkpoint) return undefined;
	const session = sessionEntries(sessionManager);
	if (!session) return undefined;
	const observation: WorkerCompactionPressureObservation | undefined = turn.stopReason === "length"
		? { state: "required", reason: "output-limit" }
		: turn.usage !== undefined && turn.generationSafe === false
			? { state: "required", reason: "generation-reserve" }
			: turn.usage !== undefined && turn.usage.fraction >= turn.thresholdFraction
				? { state: "advised", reason: "threshold" }
				: undefined;
	if (!observation) return undefined;
	return appendWorkerCompactionPressure(session, {
		...observation,
		...(turn.usage === undefined ? {} : { usage: turn.usage }),
		...(turn.observedAt === undefined ? {} : { observedAt: turn.observedAt }),
	});
}

/** Append the receipt for the latest outstanding advisory after compaction. */
export function appendWorkerCompactionSatisfied(
	session: WorkerCompactionSessionEntries,
	observedAt?: string | Date,
): WorkerCompactionAdvisoryV1 | undefined {
	const latest = latestWorkerCompactionAdvisory(session.getEntries());
	if (latest === undefined || latest.state === "satisfied") return undefined;
	const satisfied = buildWorkerCompactionAdvisory({
		state: "satisfied",
		revision: latest.revision + 1,
		observedAt,
		satisfiedRevision: latest.revision,
	});
	session.appendCustomEntry(WORKER_COMPACTION_CHANNEL, satisfied);
	return satisfied;
}

/** Append satisfaction for a worker session while keeping foreground sessions inert. */
export function appendWorkerCompactionSatisfiedForSession(
	sessionManager: unknown,
	compactMidReply: boolean,
	observedAt?: string | Date,
): WorkerCompactionAdvisoryV1 | undefined {
	if (compactMidReply) return undefined;
	const session = sessionEntries(sessionManager);
	return session === undefined ? undefined : appendWorkerCompactionSatisfied(session, observedAt);
}
