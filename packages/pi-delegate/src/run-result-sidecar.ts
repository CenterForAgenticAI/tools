/**
 * Per-run completed-result sidecar (#465, #470).
 *
 * A completed run's `finalResult` used to be durable ONLY through the shared
 * `run-state.json` lock: `completeRun` set `run.finalResult` in memory and then
 * flushed it under `withStateFileLock(run-state.json)`. Under contention that
 * lock throws `StateLockTimeoutError` (`DEFAULT_LOCK_TIMEOUT_MS = 5000`), which
 * discarded the completion AND left the result durable nowhere — the exact #465
 * loss ("timed out acquiring state lock ... after 5000ms" with `(no output)`
 * after a 37-minute run finished).
 *
 * This module shards that one hot path off the shared lock (#470's "shard state
 * per-run so the shared file is only needed for cross-run coordination"). Each
 * runId gets its own file `run-results/<runId>.json` with its own lock target
 * (`<runId>.json.lockdir`), so N concurrent completions never contend with each
 * other or with the shared run-state lock. `completeRun` writes the sidecar
 * BEFORE the shared flush, so the result survives even when the shared lock is
 * unavailable at the completion instant; hydrate reads it to restore a
 * completed run rather than an orphan; `delegate_control result` reads it as a
 * fallback; and hydrate sweeps stale sidecars so they stay bounded.
 *
 * The caller sanitizes `finalResult` before writing. This module reprojects
 * persisted results and coordinates artifact-retention pins, but it never
 * reaches back into the runtime registry.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RunResult } from "./fork-runner.js";
import {
	pinWorkerArtifactSync,
	unpinWorkerArtifactSync,
	validateWorkerArtifactReference,
	WorkerArtifactStorageBusyError,
	type WorkerArtifactReference,
} from "./artifact-workspace.js";
import { projectRunResults } from "./run-result-boundary.js";
import { logDelegateDiagnostic } from "./diagnostics.js";
import { isSafeRunId } from "./run-id.js";
import {
	readJsonFile,
	replaceJsonFile,
	resolveDelegateStateDir,
	StateLockTimeoutError,
	tryWithStateFileLock,
	withStateFileLock,
} from "./state-io.js";

/** Schema tag + version for the on-disk sidecar envelope. */
export const RUN_RESULT_SIDECAR_SCHEMA = "pi-delegate.run-result-sidecar";
export const RUN_RESULT_SIDECAR_VERSION = 1;

/** Directory (under the delegate state dir) holding one sidecar per completed run. */
export function resolveRunResultSidecarDir(agentDir: string): string {
	return path.join(resolveDelegateStateDir(agentDir), "run-results");
}

/** Absolute path of a run's completed-result sidecar. Rejects an unsafe runId. */
export function resolveRunResultSidecarPath(agentDir: string, runId: string): string {
	if (!isSafeRunId(runId)) throw new Error(`unsafe delegate runId: ${JSON.stringify(runId)}`);
	return path.join(resolveRunResultSidecarDir(agentDir), `${runId}.json`);
}

/** Durable, self-contained record of a run's terminal result. */
export interface RunResultSidecarEnvelope {
	schema: typeof RUN_RESULT_SIDECAR_SCHEMA;
	version: typeof RUN_RESULT_SIDECAR_VERSION;
	runId: string;
	rootRunId?: string;
	shape?: string;
	ownerSessionId?: string;
	/**
	 * The run's `createdAt` (epoch ms), used as a generation stamp. A runId can be
	 * reused by a supported same-id replacement (a retry claim); binding the
	 * sidecar to `createdAt` stops a new generation from reading, or hydrating
	 * from, a stale predecessor's result (CR-SIDECAR-STALE-GENERATION).
	 */
	createdAt: number;
	/** Epoch ms the run completed; presence marks the sidecar as a real completion. */
	completedAt: number;
	orphanedAt?: number;
	/** Already sanitized by the caller to match run-state.json bounding. */
	finalResult: RunResult[];
	/** Prior-generation pins carried transactionally until a reader or sweep releases them. */
	supersededArtifactPins?: Array<{ ref: WorkerArtifactReference; createdAt: number }>;
}

// A sidecar write contends only with THIS run's own lock, so contention is
// effectively nil. A tiny bounded jittered retry still absorbs a transient
// filesystem/lock hiccup without ever extending completion unboundedly. Mirrors
// the Tier-4 lifecycle-retry shape (#458/#459) at a much smaller budget.
const SIDECAR_WRITE_MAX_RETRIES = 3;
const SIDECAR_WRITE_RETRY_BASE_MS = 10;
const SIDECAR_WRITE_RETRY_MAX_MS = 100;
// A durable carrier owns its pin until that exact carrier is evicted. A fixed
// seven-day pin can expire while a retained run record is still addressable.
const DURABLE_ARTIFACT_PIN_EXPIRES_AT = "9999-12-31T23:59:59.999Z";
const PROVISIONAL_ARTIFACT_PIN_RETENTION_MS = (7 * 24 - 1) * 60 * 60 * 1000;

type DurableArtifactPin = { ref: WorkerArtifactReference; pinId: string };
type SupersededArtifactPin = { ref: WorkerArtifactReference; createdAt: number };

function sidecarArtifactPin(runId: string, createdAt: number, ref: WorkerArtifactReference): DurableArtifactPin {
	const digest = createHash("sha256")
		.update(`${runId}\0${createdAt}\0${ref.artifactId}`, "utf8")
		.digest("hex").slice(0, 48);
	return { ref, pinId: `result-${digest}` };
}

function sidecarArtifactPins(envelope: RunResultSidecarEnvelope): DurableArtifactPin[] {
	const pins: DurableArtifactPin[] = [];
	for (const result of envelope.finalResult) {
		const candidate = (result as unknown as Record<string, unknown>).artifactRef;
		if (candidate === undefined) continue;
		try {
			pins.push(sidecarArtifactPin(envelope.runId, envelope.createdAt, validateWorkerArtifactReference(candidate)));
		} catch { /* invalid references are removed by the result projection boundary */ }
	}
	return pins;
}

function pinSidecarArtifacts(
	envelope: RunResultSidecarEnvelope,
	options: { expiresAt?: string; skipPinIds?: ReadonlySet<string> } = {},
): DurableArtifactPin[] {
	const pinned: DurableArtifactPin[] = [];
	try {
		for (const entry of sidecarArtifactPins(envelope)) {
			if (options.skipPinIds?.has(entry.pinId)) continue;
			pinWorkerArtifactSync(entry.ref, entry.pinId, {
				expiresAt: options.expiresAt ?? DURABLE_ARTIFACT_PIN_EXPIRES_AT,
				timeoutMs: 0,
			});
			pinned.push(entry);
		}
		return pinned;
	} catch (error) {
		unpinSidecarArtifactPins(pinned);
		throw error;
	}
}

function unpinSidecarArtifactPins(pins: readonly DurableArtifactPin[]): void {
	for (const entry of pins) {
		try { unpinWorkerArtifactSync(entry.ref, entry.pinId, { timeoutMs: 0 }); } catch { /* rollback is best-effort */ }
	}
}

function renewSidecarArtifacts(envelope: RunResultSidecarEnvelope): void {
	for (const entry of sidecarArtifactPins(envelope)) {
		// Renewal is idempotent but not one atomic multi-artifact transaction. Never
		// roll back an earlier successful renewal if a later metadata lock is busy;
		// the carrier remains durable and the next read repairs the remaining pins.
		pinWorkerArtifactSync(entry.ref, entry.pinId, { expiresAt: DURABLE_ARTIFACT_PIN_EXPIRES_AT, timeoutMs: 0 });
	}
}

function validateSupersededSidecarPins(value: unknown): SupersededArtifactPin[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((candidate) => {
		if (!candidate || typeof candidate !== "object") return [];
		const record = candidate as Record<string, unknown>;
		if (!Number.isFinite(record.createdAt) || (record.createdAt as number) <= 0) return [];
		try { return [{ ref: validateWorkerArtifactReference(record.ref), createdAt: record.createdAt as number }]; }
		catch { return []; }
	});
}

function supersededSidecarPins(envelope: RunResultSidecarEnvelope): SupersededArtifactPin[] {
	return validateSupersededSidecarPins(envelope.supersededArtifactPins);
}

function releaseSupersededSidecarPins(envelope: RunResultSidecarEnvelope): void {
	for (const entry of supersededSidecarPins(envelope)) {
		const pin = sidecarArtifactPin(envelope.runId, entry.createdAt, entry.ref);
		unpinWorkerArtifactSync(pin.ref, pin.pinId, { timeoutMs: 0 });
	}
}

function releaseSidecarArtifacts(envelope: RunResultSidecarEnvelope, now = Date.now()): void {
	const expiresAt = new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString();
	for (const entry of sidecarArtifactPins(envelope)) {
		pinWorkerArtifactSync(entry.ref, entry.pinId, { expiresAt, timeoutMs: 0 });
	}
}

function sleepMs(ms: number): void {
	if (ms <= 0) return;
	// Synchronous, bounded sleep: completion runs on a sync path and the
	// alternative is losing the write. Atomics.wait blocks only this thread.
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Write a run's completed-result sidecar under its own lock, with generation
 * ordering (CR-SIDECAR-LATE-WRITER-OVERWRITE): the file always holds the NEWEST
 * generation's result for this runId. Under the lock we read the current file and
 * refuse to overwrite it when a strictly-newer generation (higher `createdAt`)
 * already owns it, so an older generation completing late cannot erase a newer
 * generation's only durable result. This is order-independent — whichever writer
 * runs second sees the other's `createdAt` and the newest always wins.
 *
 * Returns true when THIS generation's result landed on disk; false when the write
 * was skipped (a newer generation owns the sidecar) or every attempt timed out.
 * The caller (completeRun) uses that to decide whether a shared-flush timeout may
 * be suppressed: an older generation that could not write its result is not
 * durable and must not report a false completion. Never throws for a lock timeout.
 */
export function writeRunResultSidecar(
	agentDir: string,
	envelope: RunResultSidecarEnvelope,
): boolean {
	let target: string;
	try {
		target = resolveRunResultSidecarPath(agentDir, envelope.runId);
	} catch (error) {
		logDelegateDiagnostic(
			`run-result sidecar write skipped: ${(error as Error).message}`,
			{ agentDir },
		);
		return false;
	}
	for (let attempt = 0; attempt <= SIDECAR_WRITE_MAX_RETRIES; attempt += 1) {
		try {
			return withStateFileLock(target, () => {
				// Generation ordering applies only to the supported v1 shape. Malformed
				// current-version data remains replaceable, but an unsupported version is
				// preserved because this writer cannot safely order or downgrade it.
				const existing = readJsonFile(target);
				const inspection = existing.kind === "ok"
					? inspectSidecarEnvelope(existing.value, envelope.runId)
					: undefined;
				if (inspection?.kind === "unsupported-version") {
					logDelegateDiagnostic(
						`run-result sidecar write skipped runId=${envelope.runId}: ` +
							"on-disk schema version is unsupported and cannot be safely replaced",
						{ agentDir },
					);
					return false;
				}
				const onDisk = inspection?.kind === "supported" ? inspection.envelope : undefined;
				if (onDisk && onDisk.createdAt > envelope.createdAt) {
					logDelegateDiagnostic(
						`run-result sidecar write skipped runId=${envelope.runId}: on-disk generation ` +
							`createdAt=${onDisk.createdAt} is newer than this write's createdAt=${envelope.createdAt}`,
						{ agentDir },
					);
					return false;
				}
				const existingPinIds = new Set(onDisk ? sidecarArtifactPins(onDisk).map((entry) => entry.pinId) : []);
				const provisionalExpiresAt = new Date(Date.now() + PROVISIONAL_ARTIFACT_PIN_RETENTION_MS).toISOString();
				const pinned = pinSidecarArtifacts(envelope, {
					expiresAt: provisionalExpiresAt,
					skipPinIds: existingPinIds,
				});
				const publishedEnvelope: RunResultSidecarEnvelope = { ...envelope };
				if (onDisk) {
					const currentPins = new Set(sidecarArtifactPins(envelope).map((entry) => entry.pinId));
					const carried: SupersededArtifactPin[] = [
						...sidecarArtifactPins(onDisk).map((entry) => ({ ref: entry.ref, createdAt: onDisk.createdAt })),
						...supersededSidecarPins(onDisk),
					];
					const seen = new Set<string>();
					publishedEnvelope.supersededArtifactPins = carried.filter((entry) => {
						const pinId = sidecarArtifactPin(envelope.runId, entry.createdAt, entry.ref).pinId;
						if (currentPins.has(pinId) || seen.has(pinId)) return false;
						seen.add(pinId);
						return true;
					});
					if (publishedEnvelope.supersededArtifactPins.length === 0) delete publishedEnvelope.supersededArtifactPins;
				}
				try { replaceJsonFile(target, publishedEnvelope); }
				catch (error) {
					// Roll back only pins introduced by this unpublished carrier. A same-
					// generation predecessor may still own a shared deterministic pin.
					unpinSidecarArtifactPins(pinned);
					throw error;
				}
				try {
					renewSidecarArtifacts(envelope);
				} catch (error) {
					// The carrier and its bounded provisional pins are already durable.
					// A later read repairs them; reporting the publication as failed would
					// let callers create a competing carrier for an already-published result.
					logDelegateDiagnostic(
						`run-result sidecar durable pin repair deferred runId=${envelope.runId}: ${(error as Error).message}`,
						{ agentDir, level: "warn" },
					);
				}
				return true;
			});
		} catch (error) {
			if (!(error instanceof StateLockTimeoutError)) {
				logDelegateDiagnostic(
					`run-result sidecar write failed runId=${envelope.runId}: ${(error as Error).message}`,
					{ agentDir },
				);
				return false;
			}
			if (attempt === SIDECAR_WRITE_MAX_RETRIES) {
				logDelegateDiagnostic(
					`run-result sidecar write timed out runId=${envelope.runId} after ${attempt + 1} attempts`,
					{ agentDir },
				);
				return false;
			}
			const base = Math.min(SIDECAR_WRITE_RETRY_MAX_MS, SIDECAR_WRITE_RETRY_BASE_MS * (2 ** attempt));
			const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(base / 2)));
			sleepMs(Math.min(SIDECAR_WRITE_RETRY_MAX_MS, base + jitter));
		}
	}
	return false;
}

function isRunResultArray(value: unknown): value is RunResult[] {
	return Array.isArray(value) && value.every((entry) => entry !== null && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string");
}

/**
 * Classify a parsed sidecar without conflating malformed v1 data with an
 * explicit unsupported version. Readers reject both; writers may replace only
 * the malformed/current-version case.
 */
type SidecarEnvelopeInspection =
	| { kind: "supported"; envelope: RunResultSidecarEnvelope }
	| { kind: "unsupported-version"; version: unknown }
	| { kind: "invalid" };

function inspectSidecarEnvelope(value: unknown, runId: string): SidecarEnvelopeInspection {
	if (value === null || typeof value !== "object") return { kind: "invalid" };
	const record = value as Record<string, unknown>;
	if (record.schema !== RUN_RESULT_SIDECAR_SCHEMA) return { kind: "invalid" };
	// Version 1 was originally written without a required `version` property, so
	// absence is the documented legacy v1 migration path. Keep an explicit
	// unsupported version distinct from malformed v1 data: readers reject both,
	// but a writer must preserve an envelope it does not understand.
	const version = record.version === undefined ? RUN_RESULT_SIDECAR_VERSION : record.version;
	if (version !== RUN_RESULT_SIDECAR_VERSION) return { kind: "unsupported-version", version };
	if (typeof record.completedAt !== "number" || !Number.isFinite(record.completedAt)) return { kind: "invalid" };
	if (typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt)) return { kind: "invalid" };
	if (!isRunResultArray(record.finalResult)) return { kind: "invalid" };
	// Trust the caller's runId over any drift in the file body.
	return {
		kind: "supported",
		envelope: {
			schema: RUN_RESULT_SIDECAR_SCHEMA,
			version,
			runId,
			rootRunId: typeof record.rootRunId === "string" ? record.rootRunId : undefined,
			shape: typeof record.shape === "string" ? record.shape : undefined,
			ownerSessionId: typeof record.ownerSessionId === "string" ? record.ownerSessionId : undefined,
			createdAt: record.createdAt,
			completedAt: record.completedAt,
			orphanedAt: typeof record.orphanedAt === "number" && Number.isFinite(record.orphanedAt) ? record.orphanedAt : undefined,
			...(validateSupersededSidecarPins(record.supersededArtifactPins).length > 0
				? { supersededArtifactPins: validateSupersededSidecarPins(record.supersededArtifactPins) }
				: {}),
			// The sidecar is the durable full-result source. Revalidate named fields
			// without applying the foreground delegate-only display cap a second time.
			finalResult: projectRunResults(record.finalResult, { capDelegateOnlyResult: false, includeDetailExtensions: true }),
		},
	};
}

function asSidecarEnvelope(value: unknown, runId: string): RunResultSidecarEnvelope | undefined {
	const inspection = inspectSidecarEnvelope(value, runId);
	return inspection.kind === "supported" ? inspection.envelope : undefined;
}

/**
 * Read a run's completed-result sidecar. Returns undefined when absent, corrupt,
 * or not a real completion. Best-effort: a read failure never throws.
 */
export function readRunResultSidecar(
	agentDir: string,
	runId: string,
): RunResultSidecarEnvelope | undefined {
	let target: string;
	try {
		target = resolveRunResultSidecarPath(agentDir, runId);
	} catch {
		return undefined;
	}
	try {
		const outcome = tryWithStateFileLock(target, () => {
			const read = readJsonFile(target);
			if (read.kind !== "ok") return undefined;
			const envelope = asSidecarEnvelope(read.value, runId);
			if (!envelope) return undefined;
			try {
				releaseSupersededSidecarPins(envelope);
				renewSidecarArtifacts(envelope);
			} catch (error) {
				// Metadata contention is retryable. Keep the carrier and its exact
				// reference unchanged so a later read can repair the pin.
				if (error instanceof WorkerArtifactStorageBusyError) return undefined;
				for (const result of envelope.finalResult) {
					if ((result as unknown as Record<string, unknown>).artifactRef === undefined) continue;
					delete (result as unknown as Record<string, unknown>).artifactRef;
					(result as unknown as Record<string, unknown>).artifactError = {
						kind: "artifact-unavailable", message: error instanceof Error ? error.message : String(error), retryable: false,
					};
				}
			}
			delete envelope.supersededArtifactPins;
			return envelope;
		});
		return outcome.acquired ? outcome.value : undefined;
	} catch {
		return undefined;
	}
}


/** A `<runId>.json` sidecar file discovered on disk, with its runId and mtime. */
interface DiscoveredSidecar {
	runId: string;
	file: string;
	modifiedAtMs: number;
}

/** Enumerate valid `<runId>.json` sidecars in the run-results dir (best-effort). */
export function listRunResultSidecars(agentDir: string): DiscoveredSidecar[] {
	const dir = resolveRunResultSidecarDir(agentDir);
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const out: DiscoveredSidecar[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const runId = name.slice(0, -".json".length);
		if (!isSafeRunId(runId)) continue;
		const file = path.join(dir, name);
		let modifiedAtMs: number;
		try {
			modifiedAtMs = fs.statSync(file).mtimeMs;
		} catch {
			continue;
		}
		out.push({ runId, file, modifiedAtMs });
	}
	return out;
}

export interface SidecarSweepOptions {
	/** RunIds still active/retained in the merged run set: never evicted. */
	retainedRunIds: ReadonlySet<string>;
	/** A sidecar older than this (by mtime) is eligible for eviction. */
	maxAgeMs: number;
	now?: number;
}

/**
 * Evict stale sidecars so the directory stays bounded. A sidecar is removed only
 * when its runId is NOT in `retainedRunIds` AND its file is older than
 * `maxAgeMs`.
 *
 * The eviction is performed under the sidecar's own lock with a fresh re-stat
 * immediately before the unlink (CR-SIDECAR-SWEEP-RACE): a completion may rewrite
 * a sidecar between the enumeration stat and this unlink, and the writer holds
 * the same lock while it does. If the lock cannot be taken (a writer holds it) or
 * the file is fresh under the lock, the sidecar is left in place. Best-effort; a
 * failure to unlink one file never blocks the sweep. Returns the number removed.
 */
export function sweepRunResultSidecars(agentDir: string, opts: SidecarSweepOptions): number {
	const now = opts.now ?? Date.now();
	let removed = 0;
	for (const sidecar of listRunResultSidecars(agentDir)) {
		if (opts.retainedRunIds.has(sidecar.runId)) continue;
		if (now - sidecar.modifiedAtMs < opts.maxAgeMs) continue;
		let target: string;
		try {
			target = resolveRunResultSidecarPath(agentDir, sidecar.runId);
		} catch {
			continue;
		}
		let evicted = false;
		try {
			const outcome = tryWithStateFileLock(target, () => {
				// Re-check freshness under the writer lock: a completion may have
				// rewritten this sidecar since the enumeration stat above.
				let modifiedAtMs: number;
				try {
					modifiedAtMs = fs.statSync(target).mtimeMs;
				} catch {
					return false; // already gone
				}
				if (now - modifiedAtMs < opts.maxAgeMs) return false; // freshly rewritten
				const existing = readJsonFile(target);
				const envelope = existing.kind === "ok" ? asSidecarEnvelope(existing.value, sidecar.runId) : undefined;
				if (envelope) {
					releaseSupersededSidecarPins(envelope);
					releaseSidecarArtifacts(envelope, now);
				}
				fs.rmSync(target, { force: true });
				return true;
			});
			evicted = outcome.acquired && outcome.value;
		} catch {
			/* best-effort: a lock/unlink failure leaves the sidecar in place */
		}
		if (evicted) removed += 1;
	}
	return removed;
}
