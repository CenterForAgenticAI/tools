import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import {
	HISTORY_SCHEMA_VERSION,
	iterateHistory,
	type HistoryLogRecord,
	type HistoryRecordEnvelope,
	type HistoryGapRecord,
} from "./history-store.js";

const MAX_ATTESTATION_BYTES = 4096;
const SUPPORTED_ATTESTATION_VERSION = 1;

// The canonical emitter build identity for history records
// Must match the buildProvenance field in WindowSample/CostRecord
const CANONICAL_BUILD_IDENTITY = "pi-multi-account@0.1.0";

export type CoverageState = "unknown" | "partial" | "complete";

export interface CoverageAttestation {
	readonly attestationVersion: number;
	readonly historySchemaVersion: number;
	readonly buildProvenance: string;
	readonly attestedAtMs: number;
}

/**
 * Conjuncts verified for 'complete' coverage state.
 *
 * REQ-COVERAGE-STATE defines 'complete' as requiring FIVE conjuncts:
 * 1. period wholly at/after attestedAtMs (VERIFIED in node 4)
 * 2. period wholly inside retained history (DEFERRED to node 5)
 * 3. all records match attested schema (DEFERRED to node 5)
 * 4. all records match attested build provenance (DEFERRED to node 5)
 * 5. no known gap in the period (DEFERRED to node 5)
 *
 * This type-level marker prevents node 5's integrator from misreading
 * 'complete' as fully verified when only the period-timing conjunct has
 * been checked. Node 5 must wire the remaining four and update this field.
 */
export type VerifiedConjunct =
	| "period-timing"
	| "retained-history"
	| "schema-match"
	| "build-match"
	| "no-gap";

export interface CoverageResult {
	readonly state: CoverageState;
	readonly reason?: string;
	/**
	 * Which coverage conjuncts were actually verified.
	 *
	 * A 'complete' result from node 4 carries ONLY ["period-timing"].
	 * Node 5 must add the remaining four before emitting a total.
	 */
	readonly verifiedConjuncts: readonly VerifiedConjunct[];
}

export type AttestationRejectionReason =
	| "symlink"
	| "not-regular-file"
	| "insecure-mode"
	| "wrong-owner"
	| "outside-base-dir"
	| "oversize"
	| "malformed"
	| "version-mismatch"
	| "schema-mismatch"
	| "build-mismatch"
	| "future-attested-at"
	| "missing"
	| "symlinked-base-dir";

export type AttestationResult =
	| { readonly ok: true; readonly attestation: CoverageAttestation }
	| { readonly ok: false; readonly reason: AttestationRejectionReason };

/**
 * Read and validate the fleet-currency attestation file.
 *
 * REQ-COVERAGE-STATE: 0013 NEVER creates, modifies, or deletes this file.
 * This is a READ-ONLY validator.
 *
 * Valid ONLY when ALL of these hold:
 * - a bounded regular file (NOT a symlink)
 * - owned by the current user
 * - mode 0600
 * - beneath the owner-only machine-global extension directory
 * - contains exactly: a supported attestation version, the current history
 *   schema version, the current canonical emitter build identity, and a
 *   finite non-future attestedAtMs
 *
 * Missing, malformed, insecure, or mismatched -> rollout currency UNPROVEN.
 *
 * SECURITY NOTE: Uses lstatSync (NOT statSync) to detect symlinks without
 * following them, plus realpathSync containment check. Mirrors the pattern
 * from history-store.ts validateAppendPath.
 */
export function readCoverageAttestation(
	extensionDir?: string,
): AttestationResult {
	// Package storage identity stays decoupled from the logical provider ID.
	const baseDir =
		extensionDir ??
		join(
			process.env.PI_CODING_AGENT_DIR ??
				join(process.env.HOME ?? ".", ".pi", "agent"),
			"pi-multi-account",
		);

	const attestationPath = join(baseDir, "history-coverage-attestation.json");

	try {
		// REQ-STORE-PERMISSIONS: Reject symlinked base directory
		// If baseDir is a symlink pointing at a victim directory, an attacker
		// could place a valid-looking attestation there and bypass currency checks.
		const baseDirStats = lstatSync(baseDir);
		if (baseDirStats.isSymbolicLink()) {
			return { ok: false, reason: "symlinked-base-dir" };
		}

		const resolvedBase = realpathSync(baseDir);

		// REQ-COVERAGE-STATE: must be a bounded regular NON-SYMLINK
		const stats = lstatSync(attestationPath);

		if (stats.isSymbolicLink()) {
			// Symlink - REJECT without following
			return { ok: false, reason: "symlink" };
		}

		if (!stats.isFile()) {
			return { ok: false, reason: "not-regular-file" };
		}

		// Bounded size check
		if (stats.size > MAX_ATTESTATION_BYTES) {
			return { ok: false, reason: "oversize" };
		}

		// REQ-COVERAGE-STATE: must be owned by the current user
		if (stats.uid !== process.getuid?.()) {
			return { ok: false, reason: "wrong-owner" };
		}

		// REQ-COVERAGE-STATE: must be mode 0600
		// biome-ignore lint/suspicious/noMagicNumbers: POSIX permission bits
		if ((stats.mode & 0o777) !== 0o600) {
			return { ok: false, reason: "insecure-mode" };
		}

		// REQ-STORE-PERMISSIONS: containment check - must be within baseDir
		//
		// DEFENSE-IN-DEPTH: This guard is unreachable via normal filesystem operations
		// given the guard ordering above. Since attestationPath is constructed as
		// join(baseDir, "history-coverage-attestation.json"), and both paths are
		// resolved through realpathSync:
		// - If baseDir itself is a symlink → caught by symlinked-base-dir guard
		// - If attestationPath is a symlink → caught by isSymbolicLink() guard
		// - If a parent component of baseDir is a symlink → both paths resolve
		//   through it and remain contained
		//
		// This check protects against implementation bugs in realpathSync/relative
		// or exotic filesystem features, but cannot be triggered through standard
		// symlink-based directory traversal.
		const resolvedAttestation = realpathSync(attestationPath);
		const rel = relative(resolvedBase, resolvedAttestation);

		// Valid if:
		// - Non-empty (not the base itself)
		// - Doesn't start with '..' (not outside base)
		// - Not absolute (different roots)
		if (
			!rel ||
			rel.startsWith("..") ||
			relative(resolvedBase, resolvedAttestation).startsWith("/")
		) {
			return { ok: false, reason: "outside-base-dir" };
		}

		// Read and parse
		const raw = readFileSync(attestationPath, "utf8");
		const parsed: unknown = JSON.parse(raw);

		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			return { ok: false, reason: "malformed" };
		}

		const record = parsed as Record<string, unknown>;

		// REQ-COVERAGE-STATE: validate required fields
		if (
			typeof record.attestationVersion !== "number" ||
			typeof record.historySchemaVersion !== "number" ||
			typeof record.buildProvenance !== "string" ||
			typeof record.attestedAtMs !== "number"
		) {
			return { ok: false, reason: "malformed" };
		}

		// REQ-COVERAGE-STATE: supported attestation version
		if (record.attestationVersion !== SUPPORTED_ATTESTATION_VERSION) {
			return { ok: false, reason: "version-mismatch" };
		}

		// REQ-COVERAGE-STATE: must match current history schema version
		if (record.historySchemaVersion !== HISTORY_SCHEMA_VERSION) {
			return { ok: false, reason: "schema-mismatch" };
		}

		// REQ-COVERAGE-STATE: must match current canonical build identity
		if (record.buildProvenance !== CANONICAL_BUILD_IDENTITY) {
			return { ok: false, reason: "build-mismatch" };
		}

		// REQ-COVERAGE-STATE: finite non-future attestedAtMs
		if (
			!Number.isFinite(record.attestedAtMs) ||
			record.attestedAtMs < 0 ||
			record.attestedAtMs > Date.now()
		) {
			return { ok: false, reason: "future-attested-at" };
		}

		return {
			ok: true,
			attestation: {
				attestationVersion: record.attestationVersion,
				historySchemaVersion: record.historySchemaVersion,
				buildProvenance: record.buildProvenance,
				attestedAtMs: record.attestedAtMs,
			},
		};
	} catch (err) {
		// JSON parse errors return malformed; file not found returns missing
		if (err instanceof SyntaxError) {
			return { ok: false, reason: "malformed" };
		}
		return { ok: false, reason: "missing" };
	}
}

/**
 * Compute coverage state for a requested time period.
 *
 * REQ-COVERAGE-STATE coverage states:
 * - `unknown`: rollout currency or fleet membership unproven (no attestation,
 *   or attestation invalid/mismatched)
 * - `partial`: valid attestation exists BUT one or more of the five required
 *   conjuncts is unverified (period timing, retained history, schema match,
 *   build match, no gap)
 * - `complete`: ONLY when the period lies wholly at or after attestedAtMs,
 *   wholly inside retained history, all records match attested schema and
 *   build provenance, and no known gap exists
 *
 * No unqualified total may be emitted unless coverage is `complete`.
 *
 * Implementation verifies ALL FIVE conjuncts:
 * 1. period-timing: period wholly at/after attestedAtMs
 * 2. retained-history: period wholly inside retained history
 * 3. schema-match: all records in period match attested schema
 * 4. build-match: all records match attested build provenance
 * 5. no-gap: no recorded gap overlaps the period
 */
export function computeCoverageState(
	periodStartMs: number,
	periodEndMs: number,
	extensionDir?: string,
): CoverageResult {
	const result = readCoverageAttestation(extensionDir);

	if (!result.ok) {
		return {
			state: "unknown",
			reason: `attestation rejected: ${result.reason}`,
			verifiedConjuncts: [],
		};
	}

	const attestation = result.attestation;
	const verifiedConjuncts: VerifiedConjunct[] = [];

	// CONJUNCT 1: period-timing - period must be wholly at or after attestedAtMs
	if (periodStartMs < attestation.attestedAtMs) {
		return {
			state: "partial",
			reason: "period starts before attestedAtMs",
			verifiedConjuncts: ["period-timing"],
		};
	}
	verifiedConjuncts.push("period-timing");

	// Scan both logs once. Keep only the conjunct evidence needed by this period.
	const stores: ReadonlyArray<{
		readonly recordType: "window-sample" | "cost-delta";
		readonly options: Parameters<typeof iterateHistory>[1];
	}> = [
		{
			recordType: "window-sample",
			options: extensionDir
				? { windowHistoryPath: join(extensionDir, "window-history.ndjson") }
				: undefined,
		},
		{
			recordType: "cost-delta",
			options: extensionDir
				? { costHistoryPath: join(extensionDir, "cost-history.ndjson") }
				: undefined,
		},
	];
	let oldestRecordedAtMs = Number.POSITIVE_INFINITY;
	let recordFailure: string | undefined;
	let gapFailure: string | undefined;
	for (const store of stores) {
		for (const record of iterateHistory(store.recordType, store.options)) {
			if (isRecordEnvelope(record)) {
				if (record.recordedAtMs < oldestRecordedAtMs) {
					oldestRecordedAtMs = record.recordedAtMs;
				}
				if (
					recordFailure === undefined &&
					record.recordedAtMs >= periodStartMs &&
					record.recordedAtMs <= periodEndMs
				) {
					if (record.schemaVersion !== attestation.historySchemaVersion) {
						recordFailure = `record at ${record.recordedAtMs} has schema ${record.schemaVersion}, expected ${attestation.historySchemaVersion}`;
					} else {
						const payload = record.payload as { buildProvenance?: unknown };
						if (typeof payload !== "object" || payload === null) {
							recordFailure = `record at ${record.recordedAtMs} has invalid payload`;
						} else if (
							payload.buildProvenance !== attestation.buildProvenance
						) {
							recordFailure = `record at ${record.recordedAtMs} has build ${payload.buildProvenance}, expected ${attestation.buildProvenance}`;
						}
					}
				}
			} else if (
				gapFailure === undefined &&
				isGapRecord(record) &&
				record.gapStartMs <= periodEndMs &&
				record.gapEndMs >= periodStartMs
			) {
				gapFailure = `gap [${record.gapStartMs}, ${record.gapEndMs}] overlaps period`;
			}
		}
	}

	if (!Number.isFinite(oldestRecordedAtMs)) {
		return {
			state: "partial",
			reason: "no retained history records found",
			verifiedConjuncts,
		};
	}
	if (periodStartMs < oldestRecordedAtMs) {
		return {
			state: "partial",
			reason: "period starts before oldest retained record",
			verifiedConjuncts,
		};
	}
	verifiedConjuncts.push("retained-history");
	if (recordFailure !== undefined) {
		return { state: "partial", reason: recordFailure, verifiedConjuncts };
	}
	verifiedConjuncts.push("schema-match");
	verifiedConjuncts.push("build-match");
	if (gapFailure !== undefined) {
		return { state: "partial", reason: gapFailure, verifiedConjuncts };
	}
	verifiedConjuncts.push("no-gap");

	// All five conjuncts verified - coverage is complete
	return {
		state: "complete",
		verifiedConjuncts,
	};
}

// Type guards for discriminating HistoryLogRecord
function isRecordEnvelope(
	record: HistoryLogRecord,
): record is HistoryRecordEnvelope {
	return "recordType" in record && record.recordType !== "gap";
}

function isGapRecord(record: HistoryLogRecord): record is HistoryGapRecord {
	return "recordType" in record && record.recordType === "gap";
}

export const COVERAGE_CANONICAL_BUILD_IDENTITY = CANONICAL_BUILD_IDENTITY;
