import {
	chmodSync,
	closeSync,
	fsyncSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MAX_METHOD_LIMITS_LENGTH } from "./api-pricing.js";
import { iterateBoundedFileLines } from "./bounded-file-lines.js";
import {
	costDigestId,
	type ApiEquivalentMethod,
	type CostDigestRow,
} from "./cost-digest.js";
import type { MachineLeaseHandle } from "./machine-lease.js";
import { PERIOD_TYPES, type PeriodType } from "./period-boundaries.js";
import { isProjectKey } from "./project-identity.js";

const MAX_ROW_BYTES = 8_192;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const ID_PATTERN = /^cost-digest-[0-9a-f]{32}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function safeCount(value: unknown): value is number {
	return Number.isSafeInteger(value) && finiteNonNegative(value);
}

function boundedString(value: unknown, maxLength: number): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= maxLength &&
		!value.includes("\0")
	);
}

function validNumberArray(value: unknown): value is readonly number[] {
	return (
		Array.isArray(value) &&
		value.length <= 512 &&
		value.every(finiteNonNegative)
	);
}

function validStringArray(value: unknown): value is readonly string[] {
	return (
		Array.isArray(value) &&
		value.length <= 512 &&
		value.every((entry) => boundedString(entry, 200))
	);
}

const METHOD_SOURCES = [
	"pi-installed-catalog",
	"openrouter",
	"legacy-day-aggregate",
] as const;

function validMethod(value: unknown): boolean {
	return (
		isRecord(value) &&
		(METHOD_SOURCES as readonly string[]).includes(value.source as string) &&
		boundedString(value.catalogVersion, 200) &&
		(value.tierInputTokensAbove === undefined ||
			finiteNonNegative(value.tierInputTokensAbove)) &&
		boundedString(value.limits, MAX_METHOD_LIMITS_LENGTH)
	);
}

/** Absent on every row persisted before per-response tier pricing existed. */
function validMethods(value: unknown): boolean {
	return (
		value === undefined ||
		(Array.isArray(value) && value.length <= 16 && value.every(validMethod))
	);
}

function validApiEquivalent(value: unknown): boolean {
	if (
		!isRecord(value) ||
		(value.status !== "priced" && value.status !== "unpriced") ||
		!validNumberArray(value.rateAsOfMs) ||
		!validMethods(value.methods)
	) {
		return false;
	}
	return value.status === "priced"
		? finiteNonNegative(value.estimatedUsd) &&
				validStringArray(value.sourceModelIds)
		: boundedString(value.reason, 128);
}

function validRow(value: unknown): value is CostDigestRow {
	if (!isRecord(value) || !isRecord(value.tokens)) return false;
	return (
		value.schemaVersion === 1 &&
		value.kind === "cost-period-digest" &&
		typeof value.id === "string" &&
		ID_PATTERN.test(value.id) &&
		typeof value.projectKey === "string" &&
		isProjectKey(value.projectKey) &&
		boundedString(value.canonicalAccountId, 128) &&
		boundedString(value.requestedModel, 200) &&
		typeof value.periodType === "string" &&
		(PERIOD_TYPES as readonly string[]).includes(value.periodType) &&
		finiteNonNegative(value.periodStartMs) &&
		finiteNonNegative(value.periodEndMs) &&
		value.periodEndMs > value.periodStartMs &&
		finiteNonNegative(value.closedAtMs) &&
		(value.source === "raw" ||
			value.source === "day-rollup" ||
			value.source === "month-rollup") &&
		safeCount(value.childRowCount) &&
		safeCount(value.observationCount) &&
		(value.coverage === "complete" ||
			value.coverage === "partial" ||
			value.coverage === "unknown") &&
		safeCount(value.tokens.input) &&
		safeCount(value.tokens.output) &&
		safeCount(value.tokens.cacheRead) &&
		safeCount(value.tokens.cacheWrite) &&
		safeCount(value.tokens.cacheWrite1h) &&
		value.tokens.cacheWrite1h <= value.tokens.cacheWrite &&
		finiteNonNegative(value.retainedCostUsd) &&
		validApiEquivalent(value.apiEquivalent) &&
		value.id ===
			costDigestId(
				value.projectKey,
				value.canonicalAccountId,
				value.requestedModel,
				value.periodType as PeriodType,
				value.periodStartMs,
			)
	);
}

function readRows(path: string): CostDigestRow[] {
	const rows: CostDigestRow[] = [];
	const ids = new Set<string>();
	for (const line of iterateBoundedFileLines(path, {
		maxLineBytes: MAX_ROW_BYTES,
		includeIncompleteFinalLine: false,
	})) {
		if (line.length === 0) continue;
		try {
			const candidate = JSON.parse(line) as unknown;
			if (!validRow(candidate) || ids.has(candidate.id)) continue;
			rows.push(candidate);
			ids.add(candidate.id);
		} catch {
			// A malformed complete row is isolated from every other row.
		}
	}
	return rows;
}

function repairTornTail(path: string): boolean {
	let descriptor: number | undefined;
	try {
		const stats = statSync(path);
		if (!stats.isFile() || stats.size > MAX_FILE_BYTES) return false;
		if (stats.size === 0) return true;
		descriptor = openSync(path, "r+");
		const buffer = Buffer.allocUnsafe(64 * 1024);
		let cursor = stats.size;
		let completeBytes = 0;
		while (cursor > 0) {
			const requested = Math.min(buffer.length, cursor);
			const start = cursor - requested;
			const bytesRead = readSync(descriptor, buffer, 0, requested, start);
			for (let index = bytesRead - 1; index >= 0; index -= 1) {
				if (buffer[index] === 0x0a) {
					completeBytes = start + index + 1;
					cursor = 0;
					break;
				}
			}
			if (completeBytes > 0) break;
			cursor = start;
		}
		if (completeBytes === stats.size) return true;
		ftruncateSync(descriptor, completeBytes);
		fsyncSync(descriptor);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

export function defaultCostDigestPaths(): {
	readonly path: string;
	readonly lockPath: string;
} {
	const agentDirectory =
		process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	// Package storage identity stays decoupled from the logical provider ID.
	const directory = join(agentDirectory, "pi-multi-account");
	return {
		path: join(directory, "cost-period-digest.ndjson"),
		lockPath: join(directory, "cost-period-digest.lock"),
	};
}

/**
 * Disclosed for every digest row persisted before per-response tier pricing
 * existed: those rows have no `apiEquivalent.methods` on disk. This constant
 * is never written back; it only labels a legacy row when it is read.
 */
export const LEGACY_DAY_AGGREGATE_METHOD: ApiEquivalentMethod = Object.freeze({
	source: "legacy-day-aggregate",
	catalogVersion: "legacy",
	tierInputTokensAbove: undefined,
	limits:
		"Priced by summing this day's tokens under one rate lookup before per-response tier pricing existed; a day mixing tier thresholds may be priced less precisely than tier-aware rows. This closed row is retained unchanged.",
});

/**
 * Read-only disclosure of the pricing method(s) behind one persisted row.
 * Never recomputes or overwrites `row.apiEquivalent`; a row missing
 * `methods` (every row closed before this metadata existed) is labeled
 * with the fixed legacy descriptor above instead.
 */
export function digestRowMethods(
	row: CostDigestRow,
): readonly ApiEquivalentMethod[] {
	const methods = row.apiEquivalent.methods;
	return methods !== undefined && methods.length > 0
		? methods
		: [LEGACY_DAY_AGGREGATE_METHOD];
}

export interface DisclosedCostDigestRow {
	readonly row: CostDigestRow;
	readonly methods: readonly ApiEquivalentMethod[];
}

/** Pair a persisted row with its disclosed method(s) without touching its stored amount. */
export function describeCostDigestRow(
	row: CostDigestRow,
): DisclosedCostDigestRow {
	return { row, methods: digestRowMethods(row) };
}

export class CostDigestStore {
	readonly #path: string;

	constructor(options: { readonly path: string }) {
		this.#path = options.path;
	}

	read(): readonly CostDigestRow[] {
		try {
			const stats = statSync(this.#path);
			if (!stats.isFile() || stats.size < 1 || stats.size > MAX_FILE_BYTES) {
				return [];
			}
			return readRows(this.#path);
		} catch {
			return [];
		}
	}

	/** `read()` paired with each row's disclosed pricing method(s); never recomputes a stored amount. */
	readDisclosed(): readonly DisclosedCostDigestRow[] {
		return this.read().map(describeCostDigestRow);
	}

	appendImmutable(
		rows: readonly CostDigestRow[],
		lease: MachineLeaseHandle,
	): number {
		if (rows.length === 0 || !lease.renew()) return 0;
		if (!repairTornTail(this.#path)) return 0;
		const existingIds = new Set(this.read().map((row) => row.id));
		const pending: CostDigestRow[] = [];
		for (const row of rows) {
			if (!validRow(row) || existingIds.has(row.id)) continue;
			const encoded = JSON.stringify(row);
			if (Buffer.byteLength(encoded, "utf8") > MAX_ROW_BYTES) continue;
			pending.push(row);
			existingIds.add(row.id);
		}
		if (pending.length === 0 || !lease.renew()) return 0;
		const raw = pending.map((row) => JSON.stringify(row)).join("\n") + "\n";
		try {
			const currentBytes = statSync(this.#path).size;
			if (currentBytes + Buffer.byteLength(raw, "utf8") > MAX_FILE_BYTES) {
				return 0;
			}
		} catch {
			if (Buffer.byteLength(raw, "utf8") > MAX_FILE_BYTES) return 0;
		}

		const directory = dirname(this.#path);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		chmodSync(directory, 0o700);
		let descriptor: number | undefined;
		try {
			descriptor = openSync(this.#path, "a", 0o600);
			writeFileSync(descriptor, raw, { encoding: "utf8" });
			fsyncSync(descriptor);
			closeSync(descriptor);
			descriptor = undefined;
			chmodSync(this.#path, 0o600);
			return pending.length;
		} catch {
			if (descriptor !== undefined) {
				try {
					closeSync(descriptor);
				} catch {
					// The original append failure remains authoritative.
				}
			}
			return 0;
		}
	}
}
