import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { acquireMachineLease } from "./machine-lease.js";
import { getPeriodBounds } from "./period-boundaries.js";
import { isProjectKey } from "./project-identity.js";

const SCHEMA_VERSION = 1;
const MAX_STATE_BYTES = 64 * 1024;
const MAX_PROJECTS = 512;
const MAX_AMOUNT_USD = 1_000_000;
const RETENTION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const LEASE_TTL_MS = 5_000;
const ROUNDING_SCALE = 1_000_000;

interface BudgetEntry {
	readonly dayStartMs: number;
	readonly reservedUsd: number;
}

interface BudgetState {
	readonly schemaVersion: 1;
	readonly entries: Readonly<Record<string, BudgetEntry>>;
}

export type OpenRouterBudgetReservation =
	| {
			readonly status: "reserved";
			readonly dayStartMs: number;
			readonly reservedTodayUsd: number;
			readonly remainingTodayUsd: number;
	  }
	| {
			readonly status: "exhausted";
			readonly dayStartMs: number;
			readonly reservedTodayUsd: number;
			readonly remainingTodayUsd: number;
	  }
	| { readonly status: "unavailable" };

function defaultPaths(): { readonly path: string; readonly lockPath: string } {
	const agentDir =
		process.env.PI_CODING_AGENT_DIR ??
		join(process.env.HOME ?? ".", ".pi", "agent");
	// Package storage identity stays decoupled from the logical provider ID.
	const directory = join(agentDir, "pi-multi-account");
	return {
		path: join(directory, "openrouter-budget.json"),
		lockPath: join(directory, "openrouter-budget.lock"),
	};
}

function boundedAmount(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= MAX_AMOUNT_USD
	);
}

function parseState(value: unknown): BudgetState | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const candidate = value as Record<string, unknown>;
	if (
		candidate.schemaVersion !== SCHEMA_VERSION ||
		typeof candidate.entries !== "object" ||
		candidate.entries === null ||
		Array.isArray(candidate.entries) ||
		Object.keys(candidate).some(
			(key) => key !== "schemaVersion" && key !== "entries",
		)
	) {
		return undefined;
	}
	const rawEntries = candidate.entries as Record<string, unknown>;
	if (Object.keys(rawEntries).length > MAX_PROJECTS) return undefined;
	const entries: Record<string, BudgetEntry> = {};
	for (const [projectKey, rawEntry] of Object.entries(rawEntries)) {
		if (
			!isProjectKey(projectKey) ||
			typeof rawEntry !== "object" ||
			rawEntry === null ||
			Array.isArray(rawEntry)
		) {
			return undefined;
		}
		const entry = rawEntry as Record<string, unknown>;
		if (
			!Number.isSafeInteger(entry.dayStartMs) ||
			(entry.dayStartMs as number) < 0 ||
			!boundedAmount(entry.reservedUsd) ||
			Object.keys(entry).some(
				(key) => key !== "dayStartMs" && key !== "reservedUsd",
			)
		) {
			return undefined;
		}
		entries[projectKey] = {
			dayStartMs: entry.dayStartMs as number,
			reservedUsd: entry.reservedUsd,
		};
	}
	return { schemaVersion: SCHEMA_VERSION, entries };
}

function roundUpUsd(value: number): number {
	return Math.ceil(value * ROUNDING_SCALE) / ROUNDING_SCALE;
}

/** Persistent per-project worst-case reservations for metered fallback turns. */
export class OpenRouterBudgetStore {
	readonly #path: string;
	readonly #lockPath: string;
	readonly #now: () => number;
	readonly #beforeWrite: (() => void) | undefined;

	constructor(options: {
		readonly path?: string;
		readonly lockPath?: string;
		readonly now?: () => number;
		/** Test seam for a peer attempting a reservation while this lease is held. */
		readonly beforeWrite?: () => void;
	} = {}) {
		const defaults = defaultPaths();
		this.#path = options.path ?? defaults.path;
		this.#lockPath = options.lockPath ?? defaults.lockPath;
		this.#now = options.now ?? Date.now;
		this.#beforeWrite = options.beforeWrite;
	}

	path(): string {
		return this.#path;
	}

	reservedToday(projectKey: string, nowMs = this.#now()): number | undefined {
		if (!isProjectKey(projectKey)) return undefined;
		try {
			const state = this.#readState(true);
			if (state === undefined) return undefined;
			const entry = state.entries[projectKey];
			return entry?.dayStartMs === getPeriodBounds(nowMs, "day").startMs
				? entry.reservedUsd
				: 0;
		} catch {
			return undefined;
		}
	}

	reserve(options: {
		readonly projectKey: string;
		readonly reservationUsd: number;
		readonly dailyLimitUsd: number;
		readonly nowMs?: number;
	}): OpenRouterBudgetReservation {
		if (
			!isProjectKey(options.projectKey) ||
			!boundedAmount(options.reservationUsd) ||
			options.reservationUsd <= 0 ||
			!boundedAmount(options.dailyLimitUsd) ||
			options.dailyLimitUsd <= 0
		) {
			return { status: "unavailable" };
		}
		const reservationUsd = roundUpUsd(options.reservationUsd);
		const dailyLimitUsd = roundUpUsd(options.dailyLimitUsd);
		const nowMs = options.nowMs ?? this.#now();
		let dayStartMs: number;
		try {
			dayStartMs = getPeriodBounds(nowMs, "day").startMs;
		} catch {
			return { status: "unavailable" };
		}

		let lease: ReturnType<typeof acquireMachineLease>;
		try {
			lease = acquireMachineLease({
				lockPath: this.#lockPath,
				ttlMs: LEASE_TTL_MS,
				now: this.#now,
				// A wedged lock would otherwise fail every reservation closed and
				// disable OpenRouter permanently.
				reclaimMalformed: true,
			});
		} catch {
			return { status: "unavailable" };
		}
		if (lease === undefined) return { status: "unavailable" };
		try {
			if (!lease.renew()) return { status: "unavailable" };
			const existing = this.#readState(true);
			if (existing === undefined) return { status: "unavailable" };
			const current = existing.entries[options.projectKey];
			const reservedTodayUsd =
				current?.dayStartMs === dayStartMs ? current.reservedUsd : 0;
			const remainingTodayUsd = Math.max(
				0,
				dailyLimitUsd - reservedTodayUsd,
			);
			if (reservedTodayUsd + reservationUsd > dailyLimitUsd) {
				return {
					status: "exhausted",
					dayStartMs,
					reservedTodayUsd,
					remainingTodayUsd,
				};
			}

			const retainedEntries = Object.fromEntries(
				Object.entries(existing.entries).filter(
					([, entry]) => entry.dayStartMs >= dayStartMs - RETENTION_DAYS * DAY_MS,
				),
			);
			retainedEntries[options.projectKey] = {
				dayStartMs,
				reservedUsd: roundUpUsd(reservedTodayUsd + reservationUsd),
			};
			if (Object.keys(retainedEntries).length > MAX_PROJECTS) {
				return { status: "unavailable" };
			}
			this.#beforeWrite?.();
			if (!lease.renew()) return { status: "unavailable" };
			if (!this.#writeState({ schemaVersion: SCHEMA_VERSION, entries: retainedEntries })) {
				return { status: "unavailable" };
			}
			const nextReserved = retainedEntries[options.projectKey]?.reservedUsd;
			if (nextReserved === undefined) return { status: "unavailable" };
			return {
				status: "reserved",
				dayStartMs,
				reservedTodayUsd: nextReserved,
				remainingTodayUsd: Math.max(0, dailyLimitUsd - nextReserved),
			};
		} catch {
			return { status: "unavailable" };
		} finally {
			lease.release();
		}
	}

	#readState(missingIsEmpty: boolean): BudgetState | undefined {
		try {
			const stats = statSync(this.#path);
			if (!stats.isFile() || stats.size > MAX_STATE_BYTES) return undefined;
			return parseState(JSON.parse(readFileSync(this.#path, "utf8")));
		} catch (error) {
			if (
				missingIsEmpty &&
				(error as NodeJS.ErrnoException).code === "ENOENT"
			) {
				return { schemaVersion: SCHEMA_VERSION, entries: {} };
			}
			return undefined;
		}
	}

	#writeState(state: BudgetState): boolean {
		const encoded = `${JSON.stringify(state)}\n`;
		if (Buffer.byteLength(encoded, "utf8") > MAX_STATE_BYTES) return false;
		const directory = dirname(this.#path);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		chmodSync(directory, 0o700);
		const temporaryPath = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
		let descriptor: number | undefined;
		try {
			descriptor = openSync(temporaryPath, "wx", 0o600);
			writeFileSync(descriptor, encoded, { encoding: "utf8" });
			fsyncSync(descriptor);
			closeSync(descriptor);
			descriptor = undefined;
			renameSync(temporaryPath, this.#path);
			chmodSync(this.#path, 0o600);
			return true;
		} catch {
			if (descriptor !== undefined) {
				try {
					closeSync(descriptor);
				} catch {
					// Continue with temporary-file cleanup.
				}
			}
			try {
				unlinkSync(temporaryPath);
			} catch {
				// A failed reservation must not escape into routing.
			}
			return false;
		}
	}
}
