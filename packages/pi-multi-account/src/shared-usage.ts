import {
	appendFileSync,
	chmodSync,
	closeSync,
	fstatSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { iterateBoundedFileLines } from "./bounded-file-lines.js";
import { isAllowedFamily, type AllowedFamily } from "./config.js";
import { acquireMachineLease, type MachineLeaseHandle } from "./machine-lease.js";
import { isCanonicalManagedProviderId } from "./runtime-state.js";
// The one exhaustion rule, imported rather than restated. A newer reading that
// this predicate does NOT call exhausted supersedes an older durable recovery
// time for the same account, so a recovered account is released without waiting
// for a stale `recoveryAtMs` to elapse. `routing.ts` does not import this
// module, so this adds no cycle.
import { snapshotIndicatesExhaustion } from "./routing.js";

export const SHARED_USAGE_TTL_MS = 5 * 60_000;
/**
 * How far ahead a recovery time may plausibly sit.
 *
 * `validTimestamp` accepts any finite non-negative number, so a malformed
 * provider response or a corrupted retained record can carry something like
 * `1e308`. Nothing downstream would ever see that instant pass, so an account
 * excluded by it would stay excluded across every process and every restart --
 * exactly the transient-becomes-permanent failure the routing rules exist to
 * prevent, and the one risk a durable exhaustion signal genuinely adds.
 *
 * Thirty-five days clears the longest real recovery this extension has
 * observed, a monthly quota window, with room to spare. A value beyond it is
 * not a long outage; it is a broken reading, and a broken reading must not be
 * able to retire an account.
 */
export const MAX_RECOVERY_HORIZON_MS = 35 * 24 * 60 * 60_000;
/**
 * How long an account stays out of routing after the provider reported it
 * exhausted without giving a recovery time.
 *
 * Sixty minutes is a policy choice measured against retained observations, not
 * a constant borrowed from elsewhere in this file: of 28 header-reported
 * exhaustions carrying no recovery time, 15 had an authoritative recovery
 * reading within the hour and 13 did not. The long tail is deliberately left
 * uncovered -- the hold is a time-boxed guess that lapses on its own, not a
 * claim to know the account is still spent.
 */
export const EXHAUSTION_HOLD_MS = 60 * 60_000;

/**
 * Ceiling on a failure-triggered refresh debounce, enforced on append and read.
 *
 * The debounce itself is `USAGE_FETCH_INTERVAL_MS`, defined in `usage-fetch.ts`
 * where the cadence lives. This is only the outer bound a persisted deadline
 * may claim, kept here because validation cannot import from that module. It is
 * deliberately loose: its job is to refuse an absurd value, not to restate the
 * policy.
 */
const MAX_REFRESH_DEBOUNCE_MS = 60 * 60_000;

export const SHARED_USAGE_MAX_BYTES = 512 * 1024;
const MAX_RECORD_BYTES = 4_096;
const MAX_OBSERVER_ID_LENGTH = 256;
/**
 * Shape a field name must have inside a record type this build does not
 * recognise, applied when deciding whether compaction may carry it forward
 * rather than delete it.
 *
 * A length bound alone was the first attempt and round 3 refuted it: a key
 * called `Bearer SECRET` is short, so the credential simply moved from the
 * value into the key. Field names this project writes are lower-camel
 * identifiers.
 *
 * There is no companion value-length bound: unknown string VALUES are refused
 * outright rather than length-capped, because a bounded short string is
 * exactly the shape of a leaked bearer token.
 */
const CARRYABLE_FIELD_NAME = /^[a-z][A-Za-z0-9]{0,63}$/;

export type UsageObservationSource = "rate-limit-header" | "usage-endpoint";

export interface SharedUsageTokens {
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly cacheCreationInputTokens?: number;
	readonly cacheReadInputTokens?: number;
}

export interface SharedUsageRateLimit {
	readonly remainingRequests?: number;
	readonly remainingTokens?: number;
	readonly recoveryAtMs?: number;
	/** Always normalized to a 0-1 fraction, regardless of source API units. */
	readonly utilization?: number;
	readonly utilizationSource?: UsageObservationSource;
}

export interface SharedUsageRecord {
	readonly providerId: string;
	readonly family: AllowedFamily;
	readonly observedAtMs: number;
	readonly observerId: string;
	readonly tokens?: SharedUsageTokens;
	readonly rateLimit?: SharedUsageRateLimit;
}

export type UsageFailureDetail =
	| "not-object"
	| "no-quota-groups"
	| "quota-summary-error";

const USAGE_FAILURE_DETAILS = new Set<UsageFailureDetail>([
	"not-object",
	"no-quota-groups",
	"quota-summary-error",
]);

/** Machine-global fetch-attempt state; deliberately ignored by usage aggregation. */
export interface SharedUsageAttemptRecord {
	readonly recordType: "usage-attempt";
	/** Null or missing makes pre-0012 readers reject this as a usage observation. */
	readonly tokens?: null;
	readonly providerId: string;
	readonly family: AllowedFamily;
	readonly observedAtMs: number;
	readonly observerId: string;
	readonly failureCount: number;
	readonly nextAttemptAtMs: number;
	readonly disabled: boolean;
	readonly failureReason?: string;
	/** Fixed, sanitized classification detail; never an upstream error body. */
	readonly failureDetail?: UsageFailureDetail;
	/**
	 * The failure that triggered this attempt, when it was failure-triggered.
	 *
	 * Distinguishes a refresh provoked by a rate-limit failure from an ordinary
	 * cadence poll, so a later failure can tell whether the account has already
	 * been probed since *its own* failure rather than merely recently.
	 */
	readonly failureTriggeredAtMs?: number;
	/**
	 * When another failure-triggered refresh may run. Bounded relative to
	 * `failureTriggeredAtMs` on read, so a corrupt far-future value cannot
	 * suppress refreshes permanently.
	 */
	readonly refreshDebounceUntilMs?: number;
}

/**
 * A bounded, machine-global hold that keeps an account out of routing after the
 * provider reported it exhausted without saying when it recovers.
 *
 * This is deliberately a separate fact rather than a synthesised `recoveryAtMs`.
 * That field means "the provider said so", and aggregation already treats it as
 * authoritative; writing a guessed duration into it would conflate an estimate
 * with authority. A hold is an admitted guess with an expiry.
 */
export interface SharedUsageExhaustionHoldRecord {
	readonly recordType: "usage-exhaustion-hold";
	/** Null or missing makes older readers reject this as a usage observation. */
	readonly tokens?: null;
	readonly providerId: string;
	readonly family: AllowedFamily;
	readonly observedAtMs: number;
	readonly observerId: string;
	/** When the failure that installed this hold was classified. */
	readonly failedAtMs: number;
	/** Exclusion end. Bounded relative to `failedAtMs` on append and on read. */
	readonly holdUntilMs: number;
}

export type SharedUsageLogRecord =
	| SharedUsageRecord
	| SharedUsageAttemptRecord
	| SharedUsageExhaustionHoldRecord;

export interface SharedUsageSnapshot {
	readonly providerId: string;
	readonly family: AllowedFamily;
	readonly snapshotAtMs: number;
	readonly ageMs: number;
	readonly observerId: string;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheCreationInputTokens: number;
	readonly cacheReadInputTokens: number;
	readonly remainingRequests?: number;
	readonly remainingTokens?: number;
	readonly recoveryAtMs?: number;
	readonly utilization?: number;
	readonly utilizationSource?: UsageObservationSource;
}

export interface SharedUsageAggregate {
	readonly providerId: string;
	readonly family: AllowedFamily;
	readonly session?: SharedUsageSnapshot;
	readonly fleet?: SharedUsageSnapshot;
	readonly stale?: SharedUsageSnapshot;
	/**
	 * Newest record whose recovery time is still ahead, from any observer and of
	 * any age.
	 *
	 * Separate from the three above because it answers a different question.
	 * They ask "what did usage last look like, and who measured it", which the
	 * TTL rightly ages out. This asks "is the account known to be out right
	 * now", which a five-minute window cannot decide: the answer carries its own
	 * expiry in `recoveryAtMs`.
	 *
	 * Absent once that instant passes, so it can never keep an account excluded
	 * after it recovers.
	 */
	readonly durableExhaustion?: SharedUsageSnapshot;
}

function nonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validFraction(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= 1
	);
}

function validTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Whether a record this build cannot interpret may survive compaction.
 *
 * Compaction rebuilds the file from recognised records, so anything not carried
 * here is deleted. That is how an older build destroys a record type added
 * after it. Carrying unknown records forward keeps a newer build's state alive
 * across a mixed-version fleet.
 *
 * The filter exists because "unrecognised" also covers records this build
 * rejected as malformed, including the credential-bearing ones that
 * `append` refuses and compaction currently scrubs. Carrying those would turn a
 * durability fix into a privacy regression, so a carried record must still look
 * like a usage record for a known account: a `recordType` string this build
 * does not know, the same account identity fields every record carries, and no
 * field outside that shape. A future record type satisfies this; a leaked
 * authorization header does not.
 */
function carryableUnknownRecord(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return false;
	const record = value as Record<string, unknown>;
	// `recordType` must look like a record type, not merely be non-empty.
	//
	// Round 2 proved "non-empty string" is not a constraint: `Bearer <token>`
	// is a non-empty string, so a credential placed here survived compaction.
	// A real record type is a lower-kebab identifier, and nothing that fails
	// this shape is a record type this build should carry blind.
	if (
		typeof record.recordType !== "string" ||
		!CARRYABLE_RECORD_TYPE.test(record.recordType)
	)
		return false;
	if (
		typeof record.providerId !== "string" ||
		typeof record.family !== "string" ||
		!isAllowedFamily(record.family) ||
		!isCanonicalManagedProviderId(record.providerId, record.family) ||
		!validTimestamp(record.observedAtMs) ||
		!validObserverId(record.observerId) ||
		// Stricter than `validObserverId` on purpose: that only bounds length,
		// and a bearer token is a bounded string. See CARRYABLE_OBSERVER_ID.
		!CARRYABLE_OBSERVER_ID.test(record.observerId)
	)
		return false;
	// Beyond the identity fields above, a carried record may hold only
	// NON-STRING values.
	//
	// The first version of this filter bounded value shape -- primitives only,
	// length-capped -- and review proved it unsound: `{ authorization: "Bearer
	// SHORT" }` is a bounded primitive and survived compaction, which is exactly
	// the privacy regression the carry-through was not allowed to create.
	//
	// Refusing unknown strings outright is the only defensible rule here. A
	// denylist of sensitive-looking field names would be a guess about what a
	// future record type calls its fields, and every credential this project
	// handles is a string. Timestamps, counts, fractions and flags -- what a
	// forward-compatible usage record actually needs -- are unaffected. A future
	// type that genuinely needs a string field must teach this build about
	// itself rather than rely on being carried blind.
	for (const [key, entry] of Object.entries(record)) {
		// Field NAMES are constrained by shape, not only length. Round 3 found
		// a length bound alone lets a key called `Bearer SECRET` through: the
		// credential rides in the key rather than the value. A field name in a
		// JSON record written by this project is a lower-camel identifier.
		if (!CARRYABLE_FIELD_NAME.test(key)) return false;
		if (CARRYABLE_IDENTITY_FIELDS.has(key)) continue;
		if (!carryableUnknownValue(entry)) return false;
	}
	return true;
}

/**
 * Record types compaction may carry forward: the project's own namespace.
 *
 * Two weaker rules were tried and both refuted. "Non-empty" fell to
 * `Bearer <token>` in round 2. A lower-kebab shape fell in round 3 to
 * `sk-ant-api03-deadbeef`, which IS lower-kebab -- an API key and a record
 * type are not distinguishable by shape, so no amount of character-class
 * tightening can separate them.
 *
 * A namespace can. Every record type this file writes is `usage-`-prefixed
 * (`usage-attempt`, `usage-exhaustion-hold`), so a future type from a newer
 * build will be too. That is a property of the writer rather than a guess
 * about what a credential looks like, which is why it holds where the shape
 * checks did not.
 */
const CARRYABLE_RECORD_TYPE = /^usage-[a-z][a-z0-9-]{0,56}$/;

/**
 * Shape a carried record's `observerId` must have.
 *
 * `validObserverId` only bounds length, and round 2 proved that insufficient:
 * a bearer token is a bounded string. This restricts the CHARACTER SET instead,
 * which is what makes the field unusable for smuggling while still accepting
 * everything the producer can emit.
 *
 * The colon is deliberately NOT required. `defaultObserverId` builds
 * `${hostname()}:${process.pid}` and then truncates to MAX_OBSERVER_ID_LENGTH,
 * so on a host with a very long name the pid -- and the colon with it -- is cut
 * off entirely. Round 3 found an earlier version of this expression required
 * the colon, which would have made compaction DELETE legitimate records on such
 * a machine: the precise data loss this carry-through exists to prevent, caused
 * by the fix for it. A verified probe produced a 256-character id with no colon
 * at all.
 *
 * The length bound matches MAX_OBSERVER_ID_LENGTH rather than guessing a
 * narrower one, so the accepted domain covers every value the producer can
 * actually return.
 */
const CARRYABLE_OBSERVER_ID = /^[A-Za-z0-9._:-]{1,256}$/;

/**
 * Identity fields every record carries. They are the only strings a carried
 * unknown record may contain, and each is format-checked above rather than
 * merely bounded.
 */
const CARRYABLE_IDENTITY_FIELDS = new Set([
	"recordType",
	"providerId",
	"family",
	"observerId",
]);

function carryableUnknownValue(value: unknown): boolean {
	return (
		value === null || typeof value === "boolean" || typeof value === "number"
	);
}

function validObserverId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_OBSERVER_ID_LENGTH
	);
}

const TOKEN_FIELDS = [
	"inputTokens",
	"outputTokens",
	"cacheCreationInputTokens",
	"cacheReadInputTokens",
] as const;
const RATE_LIMIT_FIELDS = [
	"remainingRequests",
	"remainingTokens",
	"recoveryAtMs",
	"utilization",
	"utilizationSource",
] as const;

function validRecord(value: unknown): value is SharedUsageRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return false;
	const record = value as Record<string, unknown>;
	if (
		record.recordType !== undefined ||
		typeof record.providerId !== "string" ||
		typeof record.family !== "string" ||
		!isAllowedFamily(record.family) ||
		!isCanonicalManagedProviderId(record.providerId, record.family) ||
		!validTimestamp(record.observedAtMs) ||
		!validObserverId(record.observerId)
	)
		return false;
	if (record.tokens !== undefined) {
		if (typeof record.tokens !== "object" || record.tokens === null)
			return false;
		for (const field of TOKEN_FIELDS) {
			const value = (record.tokens as Record<string, unknown>)[field];
			if (value !== undefined && !nonNegativeInteger(value)) return false;
		}
	}
	if (record.rateLimit !== undefined) {
		if (typeof record.rateLimit !== "object" || record.rateLimit === null)
			return false;
		const rateLimit = record.rateLimit as Record<string, unknown>;
		for (const field of ["remainingRequests", "remainingTokens"] as const) {
			const value = rateLimit[field];
			if (value !== undefined && !nonNegativeInteger(value)) return false;
		}
		// A recovery time implausibly far after its own observation is a broken
		// reading, and this is the only place that says so. Letting one in would
		// mean every reader had to remember to distrust it.
		//
		// The `observedAtMs` anchor is what makes the question decidable here:
		// "365 days after someone looked" is wrong on sight, whereas "within 35
		// days of now" has no answer at the moment a record is written. It is
		// also what keeps the verdict stable. Anchored to the clock instead, the
		// same value is refused today and admitted months later when it drifts
		// into range -- not a bound, but a delayed admission of a record already
		// judged broken once.
		//
		// `validRecord` guards the read path as well as the append path, so a
		// record already on disk -- written before this check existed, or
		// corrupted since -- is dropped when it is read. That is why no second
		// check guards selection: there is no route by which such a record
		// reaches a reader, and an unreachable guard is a claim no test can keep
		// honest.
		if (
			rateLimit.recoveryAtMs !== undefined &&
			(!validTimestamp(rateLimit.recoveryAtMs) ||
				rateLimit.recoveryAtMs >
					record.observedAtMs + MAX_RECOVERY_HORIZON_MS)
		)
			return false;
		if (
			rateLimit.utilization !== undefined &&
			!validFraction(rateLimit.utilization)
		)
			return false;
		if (
			rateLimit.utilizationSource !== undefined &&
			rateLimit.utilizationSource !== "rate-limit-header" &&
			rateLimit.utilizationSource !== "usage-endpoint"
		)
			return false;
	}
	return true;
}

function validAttemptRecord(value: unknown): value is SharedUsageAttemptRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return false;
	const record = value as Record<string, unknown>;
	return (
		record.recordType === "usage-attempt" &&
		(record.tokens === undefined || record.tokens === null) &&
		typeof record.providerId === "string" &&
		typeof record.family === "string" &&
		isAllowedFamily(record.family) &&
		isCanonicalManagedProviderId(record.providerId, record.family) &&
		validTimestamp(record.observedAtMs) &&
		validObserverId(record.observerId) &&
		nonNegativeInteger(record.failureCount) &&
		validTimestamp(record.nextAttemptAtMs) &&
		typeof record.disabled === "boolean" &&
		(record.failureReason === undefined ||
			(typeof record.failureReason === "string" &&
				record.failureReason.length <= 128)) &&
		(record.failureDetail === undefined ||
			(typeof record.failureDetail === "string" &&
				USAGE_FAILURE_DETAILS.has(record.failureDetail as UsageFailureDetail))) &&
		(record.failureTriggeredAtMs === undefined ||
			validTimestamp(record.failureTriggeredAtMs)) &&
		// The debounce deadline is bounded against the failure that set it, not
		// the clock. Without this a corrupt far-future value would suppress every
		// failure-triggered refresh for that account forever, turning a
		// five-minute debounce into a permanent one.
		(record.refreshDebounceUntilMs === undefined ||
			(validTimestamp(record.refreshDebounceUntilMs) &&
				record.failureTriggeredAtMs !== undefined &&
				record.refreshDebounceUntilMs >= record.failureTriggeredAtMs &&
				record.refreshDebounceUntilMs - record.failureTriggeredAtMs <=
					MAX_REFRESH_DEBOUNCE_MS))
	);
}

/**
 * Validates an exhaustion hold on both append and read.
 *
 * The duration bound is anchored to `failedAtMs`, the record's own observation
 * of when the failure happened, rather than to the current clock. A
 * clock-anchored bound is a sliding window: it silently admits a far-future
 * value once enough time passes. Anchoring to the record makes "longer than the
 * hold we would ever install" decidable from the record alone, so a corrupt or
 * hostile `holdUntilMs` cannot park an account out of routing indefinitely.
 */
function validExhaustionHoldRecord(
	value: unknown,
): value is SharedUsageExhaustionHoldRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return false;
	const record = value as Record<string, unknown>;
	return (
		record.recordType === "usage-exhaustion-hold" &&
		(record.tokens === undefined || record.tokens === null) &&
		typeof record.providerId === "string" &&
		typeof record.family === "string" &&
		isAllowedFamily(record.family) &&
		isCanonicalManagedProviderId(record.providerId, record.family) &&
		validTimestamp(record.observedAtMs) &&
		validObserverId(record.observerId) &&
		validTimestamp(record.failedAtMs) &&
		validTimestamp(record.holdUntilMs) &&
		record.holdUntilMs >= record.failedAtMs &&
		record.holdUntilMs - record.failedAtMs <= EXHAUSTION_HOLD_MS
	);
}

function projectExhaustionHold(
	record: SharedUsageExhaustionHoldRecord,
): SharedUsageExhaustionHoldRecord {
	return {
		recordType: "usage-exhaustion-hold",
		tokens: null,
		providerId: record.providerId,
		family: record.family,
		observedAtMs: record.observedAtMs,
		observerId: record.observerId.slice(0, MAX_OBSERVER_ID_LENGTH),
		failedAtMs: record.failedAtMs,
		holdUntilMs: record.holdUntilMs,
	};
}

function defaultStorePath(): string {
	const agentDir =
		process.env.PI_CODING_AGENT_DIR ??
		join(process.env.HOME ?? ".", ".pi", "agent");
	// Package storage identity stays decoupled from the logical provider ID.
	return join(agentDir, "pi-multi-account", "usage.ndjson");
}

/** Identity is bounded metadata only; it contains no credential-derived value. */
export function defaultObserverId(): string {
	return `${hostname()}:${process.pid}`.slice(0, MAX_OBSERVER_ID_LENGTH);
}

function projectRecord(record: SharedUsageRecord): SharedUsageRecord {
	const tokens = record.tokens;
	const rateLimit = record.rateLimit;
	const projectedTokens =
		tokens === undefined
			? undefined
			: (Object.fromEntries(
					TOKEN_FIELDS.flatMap((field) =>
						tokens[field] === undefined ? [] : [[field, tokens[field]]],
					),
				) as SharedUsageTokens);
	const projectedRateLimit =
		rateLimit === undefined
			? undefined
			: (Object.fromEntries(
					RATE_LIMIT_FIELDS.flatMap((field) =>
						rateLimit[field] === undefined ? [] : [[field, rateLimit[field]]],
					),
				) as SharedUsageRateLimit);
	return {
		providerId: record.providerId,
		family: record.family,
		observedAtMs: record.observedAtMs,
		observerId: record.observerId.slice(0, MAX_OBSERVER_ID_LENGTH),
		...(projectedTokens === undefined ? {} : { tokens: projectedTokens }),
		...(projectedRateLimit === undefined
			? {}
			: { rateLimit: projectedRateLimit }),
	};
}

function projectAttempt(
	record: SharedUsageAttemptRecord,
): SharedUsageAttemptRecord {
	return {
		recordType: "usage-attempt",
		tokens: null,
		providerId: record.providerId,
		family: record.family,
		observedAtMs: record.observedAtMs,
		observerId: record.observerId.slice(0, MAX_OBSERVER_ID_LENGTH),
		failureCount: record.failureCount,
		nextAttemptAtMs: record.nextAttemptAtMs,
		disabled: record.disabled,
		...(record.failureReason === undefined
			? {}
			: { failureReason: record.failureReason }),
		...(record.failureDetail === undefined
			? {}
			: { failureDetail: record.failureDetail }),
		// Carried through the attempt's success and failure outcomes: a debounce
		// that vanished when the attempt completed would let the next failure
		// poll again immediately, which is the stampede this exists to stop.
		...(record.failureTriggeredAtMs === undefined
			? {}
			: { failureTriggeredAtMs: record.failureTriggeredAtMs }),
		...(record.refreshDebounceUntilMs === undefined
			? {}
			: { refreshDebounceUntilMs: record.refreshDebounceUntilMs }),
	};
}

function* completeUsageLines(
	path: string,
	maxBytes?: number,
): Generator<string> {
	const limit = 10_000;
	const ring = new Array<string>(limit);
	let count = 0;
	let next = 0;
	for (const line of iterateBoundedFileLines(path, {
		maxLineBytes: MAX_RECORD_BYTES,
		includeIncompleteFinalLine: false,
		...(maxBytes === undefined ? {} : { maxBytes }),
	})) {
		ring[next] = line;
		next = (next + 1) % limit;
		count = Math.min(count + 1, limit);
	}
	const start = count === limit ? next : 0;
	for (let index = 0; index < count; index += 1) {
		const line = ring[(start + index) % limit];
		if (line !== undefined) yield line;
	}
}

function parseRecords(lines: Iterable<string>): readonly SharedUsageRecord[] {
	const records: SharedUsageRecord[] = [];
	for (const line of lines) {
		try {
			const parsed: unknown = JSON.parse(line);
			if (validRecord(parsed)) records.push(projectRecord(parsed));
		} catch {
			// One malformed record must not hide the rest of the append log.
		}
	}
	return records;
}

function parseAttempts(lines: Iterable<string>): readonly SharedUsageAttemptRecord[] {
	const attempts: SharedUsageAttemptRecord[] = [];
	for (const line of lines) {
		try {
			const parsed: unknown = JSON.parse(line);
			if (validAttemptRecord(parsed)) attempts.push(projectAttempt(parsed));
		} catch {
			// Corrupt state is ignored; callers then degrade to local behaviour.
		}
	}
	return attempts;
}

function parseExhaustionHolds(
	lines: Iterable<string>,
): readonly SharedUsageExhaustionHoldRecord[] {
	const holds: SharedUsageExhaustionHoldRecord[] = [];
	for (const line of lines) {
		try {
			const parsed: unknown = JSON.parse(line);
			if (validExhaustionHoldRecord(parsed))
				holds.push(projectExhaustionHold(parsed));
		} catch {
			// Corrupt state is ignored; callers then degrade to local behaviour.
		}
	}
	return holds;
}

function snapshotFromRecord(
	record: SharedUsageRecord,
	nowMs: number,
): SharedUsageSnapshot {
	const ageMs = Math.max(0, nowMs - record.observedAtMs);
	return {
		providerId: record.providerId,
		family: record.family,
		snapshotAtMs: record.observedAtMs,
		ageMs,
		observerId: record.observerId,
		inputTokens: record.tokens?.inputTokens ?? 0,
		outputTokens: record.tokens?.outputTokens ?? 0,
		cacheCreationInputTokens: record.tokens?.cacheCreationInputTokens ?? 0,
		cacheReadInputTokens: record.tokens?.cacheReadInputTokens ?? 0,
		...(record.rateLimit?.remainingRequests === undefined
			? {}
			: { remainingRequests: record.rateLimit.remainingRequests }),
		...(record.rateLimit?.remainingTokens === undefined
			? {}
			: { remainingTokens: record.rateLimit.remainingTokens }),
		...(record.rateLimit?.recoveryAtMs === undefined
			? {}
			: { recoveryAtMs: record.rateLimit.recoveryAtMs }),
		...(record.rateLimit?.utilization === undefined
			? {}
			: { utilization: record.rateLimit.utilization }),
		...(record.rateLimit?.utilizationSource === undefined
			? {}
			: { utilizationSource: record.rateLimit.utilizationSource }),
	};
}

function appendState(path: string): { readonly size: number; readonly separator: string } {
	let descriptor: number | undefined;
	try {
		const size = statSync(path).size;
		if (size === 0) return { size, separator: "" };
		descriptor = openSync(path, "r");
		const finalByte = Buffer.allocUnsafe(1);
		const bytesRead = readSync(descriptor, finalByte, 0, 1, size - 1);
		return {
			size,
			separator: bytesRead === 1 && finalByte[0] === 0x0a ? "" : "\n",
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { size: 0, separator: "" };
		}
		throw error;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function completeUsagePrefixBytes(path: string, size: number): number | undefined {
	let descriptor: number | undefined;
	try {
		if (size === 0) return 0;
		const bytesToRead = Math.min(size, MAX_RECORD_BYTES + 1);
		const start = size - bytesToRead;
		const buffer = Buffer.allocUnsafe(bytesToRead);
		descriptor = openSync(path, "r");
		const bytesRead = readSync(descriptor, buffer, 0, bytesToRead, start);
		const bytes = buffer.subarray(0, bytesRead);
		if (bytes.at(-1) === 0x0a) return size;
		const lastNewline = bytes.lastIndexOf(0x0a);
		return start > 0 && lastNewline < 0 ? undefined : start + lastNewline + 1;
	} catch {
		return undefined;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function stableUsageTail(options: {
	readonly path: string;
	readonly start: number;
	readonly maxBytes: number;
	readonly expectedDevice: number;
	readonly expectedInode: number;
}): { readonly bytes: Buffer; readonly sourceSize: number } | undefined {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		let descriptor: number | undefined;
		try {
			const before = statSync(options.path);
			if (
				before.dev !== options.expectedDevice ||
				before.ino !== options.expectedInode ||
				before.size < options.start ||
				before.size - options.start > options.maxBytes
			) {
				return undefined;
			}
			descriptor = openSync(options.path, "r");
			const opened = fstatSync(descriptor);
			if (opened.dev !== before.dev || opened.ino !== before.ino) continue;
			const bytes = Buffer.allocUnsafe(before.size - options.start);
			let offset = 0;
			while (offset < bytes.length) {
				const bytesRead = readSync(
					descriptor,
					bytes,
					offset,
					bytes.length - offset,
					options.start + offset,
				);
				if (bytesRead === 0) break;
				offset += bytesRead;
			}
			const after = statSync(options.path);
			if (
				offset === bytes.length &&
				after.dev === before.dev &&
				after.ino === before.ino &&
				after.size === before.size
			) {
				return { bytes, sourceSize: before.size };
			}
		} catch {
			// Retry a moving append snapshot; publication remains fail-soft.
		} finally {
			if (descriptor !== undefined) closeSync(descriptor);
		}
	}
	return undefined;
}

function compactUsageFile(options: {
	readonly path: string;
	readonly maxBytes: number;
	readonly beforeRename?: () => void;
	readonly mutationLease: MachineLeaseHandle;
	readonly ownerLease?: { renew(): boolean };
}): boolean {
	try {
		const initial = statSync(options.path);
		if (!initial.isFile()) return false;
		const completePrefixBytes = completeUsagePrefixBytes(options.path, initial.size);
		if (completePrefixBytes === undefined) return false;
		const latest = new Map<string, SharedUsageRecord>();
		const latestTokens = new Map<string, SharedUsageRecord>();
		const latestRateLimits = new Map<string, SharedUsageRecord>();
		const latestAttempts = new Map<string, SharedUsageAttemptRecord>();
		const latestHolds = new Map<string, SharedUsageExhaustionHoldRecord>();
		// Records this build has no reader for are carried through verbatim.
		//
		// Compaction rebuilds the file from what it recognises, so without this a
		// process running an older build silently deletes every record type added
		// after it -- including the exhaustion holds that keep a spent account out
		// of rotation. The account then looks healthy
		// to the next process and gets routed to again.
		//
		// Carrying them verbatim rather than re-serialising keeps this build from
		// imposing a shape on data it does not understand, and matches how the
		// writer tail below is copied byte-for-byte.
		//
		// This is deliberately limited to whole unrecognised *records*.
		// Unrecognised *fields* on a recognised record are still stripped by
		// projectRecord/projectAttempt: that projection is the credential scrub
		// required by AGENTS.md, and widening it here would trade a privacy
		// guarantee for a durability one.
		const unrecognisedLines: string[] = [];

		for (const line of completeUsageLines(options.path, completePrefixBytes)) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			if (validRecord(parsed)) {
				const record = projectRecord(parsed);
				const key = JSON.stringify([record.providerId, record.observerId]);
				const previous = latest.get(key);
				if (!previous || record.observedAtMs > previous.observedAtMs) {
					latest.set(key, record);
				}
				if (record.tokens !== undefined) {
					const previousTokens = latestTokens.get(key);
					if (!previousTokens || record.observedAtMs > previousTokens.observedAtMs) {
						latestTokens.set(key, record);
					}
				}
				if (record.rateLimit !== undefined) {
					const previousRateLimit = latestRateLimits.get(key);
					if (
						!previousRateLimit ||
						record.observedAtMs > previousRateLimit.observedAtMs
					) {
						latestRateLimits.set(key, record);
					}
				}
			} else if (validAttemptRecord(parsed)) {
				const attempt = projectAttempt(parsed);
				const previous = latestAttempts.get(attempt.providerId);
				if (!previous || attempt.observedAtMs >= previous.observedAtMs) {
					latestAttempts.set(attempt.providerId, attempt);
				}
			} else if (validExhaustionHoldRecord(parsed)) {
				// Keep the newest hold per account. An expired hold is retained
				// until compaction rather than dropped here: readers decide
				// expiry against the current clock, and deleting one early would
				// hide the record from a reader whose clock disagrees.
				const hold = projectExhaustionHold(parsed);
				const previous = latestHolds.get(hold.providerId);
				if (!previous || hold.observedAtMs >= previous.observedAtMs) {
					latestHolds.set(hold.providerId, hold);
				}
			} else if (carryableUnknownRecord(parsed)) {
				unrecognisedLines.push(line);
			}

		}
		const compactedRecords = new Set([
			...latest.values(),
			...latestTokens.values(),
			...latestRateLimits.values(),
			...latestAttempts.values(),
			...latestHolds.values(),
		]);
		// Carried records go first and verbatim, so a build that cannot interpret
		// them neither reorders them relative to each other nor reformats them.
		const compacted = [
			...unrecognisedLines.map((line) => `${line}\n`),
			...[...compactedRecords].map((record) => `${JSON.stringify(record)}\n`),
		].join("");
		const compactedBytes = Buffer.byteLength(compacted, "utf8");
		if (compactedBytes > options.maxBytes) return false;

		options.beforeRename?.();
		const tail = stableUsageTail({
			path: options.path,
			start: completePrefixBytes,
			maxBytes: options.maxBytes - compactedBytes,
			expectedDevice: initial.dev,
			expectedInode: initial.ino,
		});
		if (tail === undefined) return false;
		const encoded = Buffer.concat([Buffer.from(compacted, "utf8"), tail.bytes]);

		const temporaryPath = `${options.path}.${process.pid}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporaryPath, encoded, { mode: 0o600 });
			if (
				!options.mutationLease.renew() ||
				(options.ownerLease !== undefined && !options.ownerLease.renew())
			) {
				return false;
			}
			const current = statSync(options.path);
			if (
				current.dev !== initial.dev ||
				current.ino !== initial.ino ||
				current.size !== tail.sourceSize
			) {
				return false;
			}
			renameSync(temporaryPath, options.path);
			chmodSync(options.path, 0o600);
			return true;
		} finally {
			try {
				unlinkSync(temporaryPath);
			} catch {
				// A published replacement no longer has a temporary path.
			}
		}
	} catch {
		return false;
	}
}

/**
 * Machine-local append-only usage store. A short mutation lease serializes the
 * projected-size check with append or compaction, so cooperating processes cannot
 * race past the documented byte cap. The warming owner remains the ordinary
 * background compaction trigger.
 */
export class SharedUsageStore {
	readonly #path: string;
	readonly #observerId: string;
	readonly #ttlMs: number;
	readonly #maxBytes: number;
	readonly #mutationLockPath: string;
	readonly #beforeCompactionRename: (() => void) | undefined;

	constructor(
		options: {
			readonly path?: string;
			readonly observerId?: string;
			readonly ttlMs?: number;
			readonly maxBytes?: number;
			readonly mutationLockPath?: string;
			/** Test seam for appending while compaction holds the mutation lease. */
			readonly beforeCompactionRename?: () => void;
		} = {},
	) {
		this.#path = options.path ?? defaultStorePath();
		this.#observerId = options.observerId ?? defaultObserverId();
		this.#ttlMs = options.ttlMs ?? SHARED_USAGE_TTL_MS;
		this.#maxBytes = options.maxBytes ?? SHARED_USAGE_MAX_BYTES;
		this.#mutationLockPath = options.mutationLockPath ?? `${this.#path}.lock`;
		this.#beforeCompactionRename = options.beforeCompactionRename;
		if (!validObserverId(this.#observerId))
			throw new RangeError("observerId must be bounded metadata.");
		if (!Number.isFinite(this.#ttlMs) || this.#ttlMs < 1)
			throw new RangeError("ttlMs must be positive.");
		if (
			!Number.isSafeInteger(this.#maxBytes) ||
			this.#maxBytes < MAX_RECORD_BYTES
		)
			throw new RangeError("maxBytes is too small.");
	}

	get path(): string {
		return this.#path;
	}

	get observerId(): string {
		return this.#observerId;
	}

	append(record: SharedUsageLogRecord): boolean {
		try {
			const projected = validExhaustionHoldRecord(record)
				? projectExhaustionHold(record)
				: validAttemptRecord(record)
					? projectAttempt(record)
					: projectRecord(record);
			if (
				!validRecord(projected) &&
				!validAttemptRecord(projected) &&
				!validExhaustionHoldRecord(projected)
			)
				return false;
			const allowed = validExhaustionHoldRecord(record)
				? [
						"recordType",
						"tokens",
						"providerId",
						"family",
						"observedAtMs",
						"observerId",
						"failedAtMs",
						"holdUntilMs",
					]
				: validAttemptRecord(record)
				? [
						"recordType",
						"tokens",
						"providerId",
						"family",
						"observedAtMs",
						"observerId",
						"failureCount",
						"nextAttemptAtMs",
						"disabled",
						"failureReason",
						"failureDetail",
						"failureTriggeredAtMs",
						"refreshDebounceUntilMs",
					]
				: [
						"providerId",
						"family",
						"observedAtMs",
						"observerId",
						"tokens",
						"rateLimit",
					];
			if (Object.keys(record as object).some((key) => !allowed.includes(key)))
				return false;
			const line = `${JSON.stringify(projected)}\n`;
			if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) return false;
			const directory = dirname(this.#path);
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			chmodSync(directory, 0o700);
			const mutationLease = acquireMachineLease({
				lockPath: this.#mutationLockPath,
				reclaimMalformed: true,
			});
			if (mutationLease === undefined) return false;
			try {
				let state = appendState(this.#path);
				let appendBytes = Buffer.byteLength(`${state.separator}${line}`, "utf8");
				if (state.size + appendBytes > this.#maxBytes) {
					if (
						!compactUsageFile({
							path: this.#path,
							maxBytes: this.#maxBytes,
							...(this.#beforeCompactionRename === undefined
								? {}
								: { beforeRename: this.#beforeCompactionRename }),
							mutationLease,
						})
					) {
						return false;
					}
					state = appendState(this.#path);
					appendBytes = Buffer.byteLength(`${state.separator}${line}`, "utf8");
				}
				if (state.size + appendBytes > this.#maxBytes) return false;
				// A crashed writer may leave a torn final line. Keep it as an
				// independent malformed record so this append remains visible.
				appendFileSync(this.#path, `${state.separator}${line}`, {
					encoding: "utf8",
					mode: 0o600,
				});
				chmodSync(this.#path, 0o600);
				return true;
			} finally {
				mutationLease.release();
			}
		} catch {
			return false;
		}
	}

	readRecords(): readonly SharedUsageRecord[] {
		try {
			return parseRecords(completeUsageLines(this.#path));
		} catch {
			return [];
		}
	}

	readAttempts(): readonly SharedUsageAttemptRecord[] {
		try {
			return parseAttempts(completeUsageLines(this.#path));
		} catch {
			return [];
		}
	}

	readExhaustionHolds(): readonly SharedUsageExhaustionHoldRecord[] {
		try {
			return parseExhaustionHolds(completeUsageLines(this.#path));
		} catch {
			return [];
		}
	}

	/**
	 * The end of an unexpired hold for this account, or undefined.
	 *
	 * Expiry is decided here against the caller's clock rather than by deleting
	 * records, so a hold that has lapsed simply stops being reported. Callers get
	 * a time to compare, not a boolean, because routing has to combine it with an
	 * authoritative recovery time and take whichever is later.
	 */
	activeExhaustionHoldUntilMs(
		providerId: string,
		family: AllowedFamily,
		nowMs: number,
	): number | undefined {
		let latest: number | undefined;
		for (const hold of this.readExhaustionHolds()) {
			if (hold.providerId !== providerId || hold.family !== family) continue;
			if (hold.holdUntilMs <= nowMs) continue;
			// A relative bound alone is not enough. `holdUntilMs - failedAtMs` can
			// be a legitimate 60 minutes while `failedAtMs` itself sits in the year
			// 3138, which would exclude the account for centuries. No honest hold
			// can end more than its own duration from now, so anything beyond that
			// is ignored here as well as refused on append.
			if (hold.holdUntilMs > nowMs + EXHAUSTION_HOLD_MS) continue;
			if (latest === undefined || hold.holdUntilMs > latest)
				latest = hold.holdUntilMs;
		}
		return latest;
	}

	latestAttempt(
		providerId: string,
		family: AllowedFamily,
	): SharedUsageAttemptRecord | undefined {
		let latest: SharedUsageAttemptRecord | undefined;
		for (const record of this.readAttempts()) {
			if (
				record.providerId === providerId &&
				record.family === family &&
				(latest === undefined || record.observedAtMs >= latest.observedAtMs)
			) {
				latest = record;
			}
		}
		return latest;
	}

	aggregate(
		providerId: string,
		family: AllowedFamily,
		nowMs: number,
	): SharedUsageAggregate {
		if (
			!isCanonicalManagedProviderId(providerId, family) ||
			!validTimestamp(nowMs)
		) {
			return { providerId, family };
		}
		const records = this.readRecords()
			.filter(
				(record) =>
					record.providerId === providerId && record.family === family,
			)
			.sort((a, b) => b.observedAtMs - a.observedAtMs);
		const fresh = records.filter(
			(record) => nowMs - record.observedAtMs <= this.#ttlMs,
		);
		// Prefer the newest fresh record that CARRIES a rate-limit observation.
		//
		// The store interleaves two record shapes for the same account: token totals
		// (written per response) and rate-limit observations (written when a
		// response exposes usage headers). Token records are far more numerous, so
		// taking the newest record outright usually lands on one with no
		// `rateLimit`, and the resulting snapshot reports `utilization: undefined`.
		// Observed live: anthropic-account-3 had 45 fresh records carrying
		// utilization 0.36 while the operator surface showed no figure at all,
		// because the single newest record happened to be token-only.
		//
		// Falls back to the newest fresh record of either shape, so token totals
		// still surface for an account that has never reported rate-limit headers.
		const newestWithRateLimit = (
			candidates: readonly SharedUsageRecord[],
		): SharedUsageRecord | undefined =>
			candidates.find((record) => record.rateLimit !== undefined) ??
			candidates[0];
		const local = newestWithRateLimit(
			fresh.filter((record) => record.observerId === this.#observerId),
		);
		const peer = newestWithRateLimit(
			fresh.filter((record) => record.observerId !== this.#observerId),
		);
		// The retained reading exists to tell an operator what the account's
		// utilization last looked like, so prefer the newest expired record that
		// actually CARRIES a rate-limit observation.
		//
		// Taking the newest expired record outright picks a token-only record --
		// they are far more numerous -- and yields a snapshot whose `utilization` is
		// undefined. Observed live: anthropic-account-2 returned a 19-minute-old
		// token record while the 0.99 utilization reading sat 59 minutes back, so
		// the surface still showed no usage figure after the retained-data fallback
		// was added. Falls back to the newest expired record of any kind, so token
		// totals still surface when no rate-limit observation was ever retained.
		const expired = records.filter(
			(record) => nowMs - record.observedAtMs > this.#ttlMs,
		);
		const stale =
			expired.find((record) => record.rateLimit !== undefined) ?? expired[0];
		// A KNOWN FUTURE RECOVERY TIME IS NOT PERISHABLE, so it is chosen from
		// every record rather than only the fresh ones, and from any observer
		// rather than only peers.
		//
		// `SHARED_USAGE_TTL_MS` and `USAGE_FETCH_INTERVAL_MS` are both five
		// minutes, so a rate-limit record ages out of `fresh` exactly as its
		// replacement falls due. In that gap the selections above settle for the
		// newest record of any shape -- normally a token-only one -- and routing
		// sees no `recoveryAtMs` at all. Observed live on `openai-codex`: a
		// three-day outage looked like a healthy account and took two turns before
		// anything noticed (#97).
		//
		// A token count really does expire in five minutes. "This account is out
		// until T" does not: it carries its own expiry and stays true until T
		// passes. The TTL is the wrong instrument for it.
		//
		// Observer-blind ON PURPOSE. The `session`/`fleet` split exists so a caller
		// can tell who measured something, which matters for a token total. A
		// recovery time is a fact about the ACCOUNT, so our own reading and a
		// peer's are equally admissible -- and excluding our own is the other half
		// of the same defect, which is why routing could not avoid the account it
		// had just measured itself.
		//
		// SELF-EXPIRING, and that is load-bearing. `recoveryAtMs > nowMs` is what
		// keeps this from turning a transient condition into a permanent one: once
		// the recovery instant passes, no record qualifies and the account is
		// eligible again with no reset and no new observation. Weakening that
		// comparison to a presence check would strand a recovered account forever.
		//
		// BOUNDED ABOVE TOO, but at the door rather than here: `validRecord`
		// rejects a recovery time more than `MAX_RECOVERY_HORIZON_MS` after its
		// own observation, on both the write and read paths, so such a record
		// never reaches this scan. `validTimestamp` alone admits any finite
		// number, and a value no clock will ever reach would exclude an account
		// permanently.
		//
		// That bound is anchored to `observedAtMs`, never to `nowMs`. A
		// clock-anchored bound is a sliding window: it refuses a year-out reading
		// today and silently admits the same broken value about 330 days later,
		// when it drifts inside the window and outranks every newer healthy
		// reading. A plausibility verdict that reverses itself with no new
		// observation is not a bound at all. Measured from the observation it is
		// a property of the record and never changes.
		//
		// SUPERSEDED BY A NEWER READING FROM THE SAME INSTRUMENT. A durable
		// recovery time survives the TTL, but it does not survive a
		// strictly-newer reading, FROM THE SOURCE THAT OBSERVED IT, that reports
		// capacity again. A provider window can reset ahead of the recorded
		// `recoveryAtMs`; without this, the account stayed excluded until that
		// stale timestamp elapsed even though every fresh poll re-measured it
		// healthy. Observed live: `openai-codex-account-2` sat pinned to the
		// owning-vendor API tier ~40h past its real reset while its newest
		// usage-endpoint records read utilization 0.
		//
		// SAME SOURCE IS LOAD-BEARING, and is why this does not reopen #97's
		// other half. The two instruments see different limits: the usage
		// endpoint tracks the QUOTA window and is blind to a SESSION 429, and a
		// rate-limit header is the reverse. A healthy reading from the OTHER
		// instrument is not evidence that THIS exhaustion cleared -- that is the
		// documented `usage-endpoint util:0 while 429ing` case. Only the same
		// instrument re-measuring its own window can retire its own recovery
		// time. A token-only record carries no rate-limit reading at all, so it
		// is silent about exhaustion rather than evidence of health.
		//
		// The NEWEST same-source reading decides, judged by the one shared
		// exhaustion predicate, so a newer reading that is itself exhausted -- a
		// fresh 429, or its own future recovery -- never releases the account.
		const durableCandidate = records.find(
			(record) =>
				record.rateLimit?.recoveryAtMs !== undefined &&
				record.rateLimit.recoveryAtMs > nowMs,
		);
		const durableSource = durableCandidate?.rateLimit?.utilizationSource;
		const newerSameSourceReading =
			durableCandidate === undefined || durableSource === undefined
				? undefined
				: records.find(
						(record) =>
							record.rateLimit?.utilizationSource === durableSource &&
							record.observedAtMs > durableCandidate.observedAtMs,
					);
		const durableExhaustion =
			newerSameSourceReading !== undefined &&
			!snapshotIndicatesExhaustion(
				newerSameSourceReading.rateLimit,
				nowMs,
				"all-observed",
			)
				? undefined
				: durableCandidate;

		return {
			providerId,
			family,
			...(local === undefined
				? {}
				: { session: snapshotFromRecord(local, nowMs) }),
			...(peer === undefined ? {} : { fleet: snapshotFromRecord(peer, nowMs) }),
			...(stale === undefined
				? {}
				: { stale: snapshotFromRecord(stale, nowMs) }),
			...(durableExhaustion === undefined
				? {}
				: {
						durableExhaustion: snapshotFromRecord(durableExhaustion, nowMs),
					}),
		};
	}

	/** Compact only complete records and only when the caller proves lease ownership. */
	compactUnderLease(lease: {
		readonly record: { readonly token: string };
		renew(): boolean;
	}): boolean {
		if (!lease.record.token || !lease.renew()) return false;
		try {
			if (statSync(this.#path).size <= this.#maxBytes) return false;
		} catch {
			return false;
		}
		const mutationLease = acquireMachineLease({
			lockPath: this.#mutationLockPath,
			reclaimMalformed: true,
		});
		if (mutationLease === undefined) return false;
		try {
			return compactUsageFile({
				path: this.#path,
				maxBytes: this.#maxBytes,
				...(this.#beforeCompactionRename === undefined
					? {}
					: { beforeRename: this.#beforeCompactionRename }),
				mutationLease,
				ownerLease: lease,
			});
		} finally {
			mutationLease.release();
		}
	}
}

/** Header values are already 0-1 fractions. */
export function normalizeHeaderUtilization(value: number): number | undefined {
	return validFraction(value) ? value : undefined;
}

/** Usage endpoint bodies report 0-100 percent; persist the normalized fraction. */
export function normalizeUsageEndpointPercent(
	value: number,
): number | undefined {
	return typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= 100
		? value / 100
		: undefined;
}
