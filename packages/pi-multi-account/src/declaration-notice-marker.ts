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

const SCHEMA_VERSION = 1;
export const MAX_MARKER_BYTES = 1_024;
const LEASE_TTL_MS = 5_000;

export type DeclarationNoticeCondition = "stale" | "not-installed";

/**
 * The only condition values that may ever reach the persisted marker.
 *
 * TypeScript's `DeclarationNoticeCondition` union is erased at runtime, so a
 * JavaScript or casted caller could otherwise pass an arbitrary string that
 * would be serialized into `declaration-notice.json`. This allow-list is the
 * runtime boundary that keeps a caller from causing a path, identifier, or
 * credential-like value to be retained (AC-6): anything outside it is rejected
 * before the lease is acquired or any byte is written.
 */
const ALLOWED_CONDITIONS: ReadonlySet<DeclarationNoticeCondition> = new Set([
	"stale",
	"not-installed",
]);

function isAllowedCondition(
	value: unknown,
): value is DeclarationNoticeCondition {
	return ALLOWED_CONDITIONS.has(value as DeclarationNoticeCondition);
}


interface DeclarationNoticeState {
	readonly schemaVersion: 1;
	readonly dayStartMs: number;
	readonly condition: DeclarationNoticeCondition;
}

type MarkerReadResult =
	| { readonly status: "valid"; readonly marker: DeclarationNoticeState }
	| { readonly status: "missing" }
	| { readonly status: "malformed" }
	| { readonly status: "unavailable" };

function defaultPaths(): { readonly path: string; readonly lockPath: string } {
	const agentDir =
		process.env.PI_CODING_AGENT_DIR ??
		join(process.env.HOME ?? ".", ".pi", "agent");
	// Package storage identity stays decoupled from the logical provider ID.
	const directory = join(agentDir, "pi-multi-account");
	return {
		path: join(directory, "declaration-notice.json"),
		lockPath: join(directory, "declaration-notice.lock"),
	};
}

function parseMarker(value: unknown): DeclarationNoticeState | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const candidate = value as Record<string, unknown>;
	if (
		candidate.schemaVersion !== SCHEMA_VERSION ||
		!Number.isSafeInteger(candidate.dayStartMs) ||
		(candidate.dayStartMs as number) < 0 ||
		(candidate.condition !== "stale" && candidate.condition !== "not-installed") ||
		Object.keys(candidate).some(
			(key) =>
				key !== "schemaVersion" && key !== "dayStartMs" && key !== "condition",
		)
	) {
		return undefined;
	}
	return {
		schemaVersion: SCHEMA_VERSION,
		dayStartMs: candidate.dayStartMs as number,
		condition: candidate.condition,
	};
}

/** Persistent once-per-UTC-day marker for the session-start declaration notice. */
export class DeclarationNoticeMarker {
	readonly #path: string;
	readonly #lockPath: string;
	readonly #now: () => number;

	constructor(options: {
		readonly path?: string;
		readonly lockPath?: string;
		readonly now?: () => number;
	} = {}) {
		const defaults = defaultPaths();
		this.#path = options.path ?? defaults.path;
		this.#lockPath = options.lockPath ?? defaults.lockPath;
		this.#now = options.now ?? Date.now;
	}

	/**
	 * Returns true when the caller should notify. Contention and lease/read failures
	 * suppress; a post-decision marker write failure still returns true.
	 */
	shouldNotify(condition: DeclarationNoticeCondition): boolean {
		// Reject any runtime value outside the allowed literals BEFORE acquiring
		// the lease or writing, so a caller can never cause an arbitrary string to
		// be persisted in the marker (AC-6).
		if (!isAllowedCondition(condition)) return false;
		let lease: ReturnType<typeof acquireMachineLease>;
		try {
			lease = acquireMachineLease({
				lockPath: this.#lockPath,
				ttlMs: LEASE_TTL_MS,
				now: this.#now,
				reclaimMalformed: true,
			});
		} catch {
			return false;
		}
		if (lease === undefined) return false;
		try {
			const todayStartMs = getPeriodBounds(this.#now(), "day").startMs;
			const existing = this.#readMarker();
			if (existing.status === "unavailable") return false;
			if (
				existing.status === "valid" &&
				existing.marker.dayStartMs === todayStartMs
			) {
				return false;
			}
			this.#writeMarker({
				schemaVersion: SCHEMA_VERSION,
				dayStartMs: todayStartMs,
				condition,
			});
			return true;
		} catch {
			return false;
		} finally {
			try {
				lease.release();
			} catch {
				// A release failure cannot block session startup.
			}
		}
	}

	/** A matched session removes the prior notice marker so later drift can notify. */
	clear(): void {
		let lease: ReturnType<typeof acquireMachineLease>;
		try {
			lease = acquireMachineLease({
				lockPath: this.#lockPath,
				ttlMs: LEASE_TTL_MS,
				now: this.#now,
				reclaimMalformed: true,
			});
		} catch {
			return;
		}
		if (lease === undefined) return;
		try {
			unlinkSync(this.#path);
		} catch {
			// Marker cleanup failures cannot block session startup.
		} finally {
			try {
				lease.release();
			} catch {
				// A release failure cannot block session startup.
			}
		}
	}

	#readMarker(): MarkerReadResult {
		try {
			const stats = statSync(this.#path);
			if (!stats.isFile() || stats.size > MAX_MARKER_BYTES) {
				return { status: "malformed" };
			}
			const parsed = parseMarker(JSON.parse(readFileSync(this.#path, "utf8")));
			return parsed === undefined
				? { status: "malformed" }
				: { status: "valid", marker: parsed };
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ENOENT"
				? { status: "missing" }
				: error instanceof SyntaxError
					? { status: "malformed" }
					: { status: "unavailable" };
		}
	}

	#writeMarker(marker: DeclarationNoticeState): boolean {
		const encoded = `${JSON.stringify(marker)}\n`;
		if (Buffer.byteLength(encoded, "utf8") > MAX_MARKER_BYTES) return false;
		const directory = dirname(this.#path);
		const temporaryPath = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
		let descriptor: number | undefined;
		try {
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			chmodSync(directory, 0o700);
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
				// The notice decision stays fail-soft when persistence fails.
			}
			return false;
		}
	}
}
