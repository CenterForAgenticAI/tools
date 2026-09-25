/**
 * Per-run CONTROL SECRET + route record (spec 0009, node A:
 * `control-secret-provisioning`). SECURITY-CRITICAL.
 *
 * ## Why this exists (the keystone finding)
 *
 * `delegate_control({action:"steer", runId})` against a DETACHED `orchestrate` child returns
 * `Unknown runId`. Root cause (verified by two design reviewers against the
 * code): the control-inbox auth `verifyCapToken` (`src/lineage.ts`) recomputes
 * the cap-token keyed by the VERIFIER's per-process `rootSecret`, and
 * `reanchorInheritedLineage` (`src/orchestrate-runner.ts`) re-MACs the detached
 * child's frame under the CHILD's OWN freshly-minted `rootSecret`. So the
 * foreground (a different process, with a different `rootSecret`) provably
 * CANNOT mint a token the detached child accepts. The lineage cap-token is a
 * FORGE-RESISTANCE artifact, NOT a shared control credential.
 *
 * This module introduces a per-run CONTROL SECRET: a shared symmetric
 * capability the foreground holds (in a 0600 route record) and the detached
 * child verifies (read from its spawn env). It is DISTINCT from — and leaves
 * COMPLETELY UNTOUCHED — the spec-0005 Ed25519 / `rootSecret` forge-resistance
 * model. [decision: control-secret-not-captoken]
 *
 * ## The security contract
 *
 * - The secret is 32 random bytes, base64url-encoded (`mintControlSecret`).
 * - The routes dir is created `0700`; the record file written `0600` PLUS an
 *   explicit `fs.chmodSync(file, 0o600)` fallback after write (a permissive
 *   umask can widen the create mode). [decision:
 *   route-record-0600-and-degraded-on-fail]
 * - The secret SHALL NOT be written to the cfg JSON (written `0644` today), any
 *   other `0644` artifact, the dispatch console.log, lifecycle / bus logs, or
 *   across lineage boundaries (REQ-CTRL-6). It travels to the child via the
 *   spawn ENVIRONMENT only (`/proc/<pid>/environ` is `0400` owner-only), and
 *   persists foreground-side ONLY in the `0600` route record.
 * - If the route record cannot be persisted, the caller surfaces a
 *   degraded-control warning — the secret is a control credential, so a
 *   best-effort-never-throw swallow is WRONG here (REQ-CTRL-3). This module
 *   reports the failure to the caller (return value), it does not throw into
 *   the dispatch hot path.
 *
 * The `0600`/`0700` discipline mirrors the existing local pattern at
 * `src/orchestrate-runner.ts` (system-prompt / task temp files written with
 * `{ mode: 0o600 }`).
 *
 * NOTE (node A scope): this module PROVISIONS + PERSISTS + TRANSPORTS the
 * secret only. Reading it back to AUTHENTICATE a control request is node B
 * (`auth-gate-and-resolver`); the terminal-transition delete + startup sweep
 * are node C (`terminality-and-lifecycle`). This module leaves clean seams for
 * both (`readRouteRecord` / `deleteRouteRecord` are exported now; their
 * consumers arrive in B/C).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
	awaitControlResult,
	postControlRequest,
	resolveControlDir,
	rootRunIdFromLineagePath,
} from "./control-inbox.js";
import {
	deleteOrchestrateActiveMarker,
	readResultFile,
	resolveOrchestrateRoutesDir,
	resolveResultFile,
} from "./detached-spawn.js";
import {
	acquireOrchestrateRecoveryLock,
	releaseOrchestrateRecoveryLock,
} from "./orchestrate-recovery-lock.js";
import {
	getProcessNonce,
	isValidProcessBootId,
	isValidProcessNonce,
	isValidProcessStartTicks,
	type ProcessIdentityDependencies,
	type ProcessIdentityEvidence,
	type ProcessIdentityVerdict,
	verifyProcessIdentity,
} from "./process-identity.js";
import { isSafeRunId } from "./run-id.js";

// Re-export so the route-record module is the single import surface for its
// callers (node B's resolver, the tests) — the resolver itself lives next to
// its on-disk siblings in `detached-spawn.ts`.
export { resolveOrchestrateRoutesDir };

/** Env var the detached child reads its control secret from (node B). */
export const CONTROL_SECRET_ENV = "PI_DELEGATE_CONTROL_SECRET";

/** Number of random bytes in a control secret before base64url encoding. */
export const CONTROL_SECRET_BYTES = 32;

/**
 * The per-run route record file (the `0600` secret-bearing artifact).
 *
 * HARDENING (MR !2 review finding #1): `runId` is interpolated into the path,
 * and steer/cancel/status accept caller-supplied ids — so an unvalidated id
 * is a path-traversal vector (`"../../../x"`). Throws on an unsafe id; the
 * read/delete entry points below gate first and degrade to null/no-op.
 */
export function resolveRouteRecordFile(agentDir: string, runId: string): string {
	if (!isSafeRunId(runId)) {
		throw new Error(`unsafe runId rejected (path-traversal guard): ${JSON.stringify(runId)}`);
	}
	return path.join(resolveOrchestrateRoutesDir(agentDir), `${runId}.json`);
}

/**
 * The on-disk shape the foreground persists for a detached run so a LATER-TURN
 * control request can authenticate to the child. Held foreground-side ONLY,
 * `0600`. The child never reads this file — it gets the secret from its env.
 */
export interface RouteRecord {
	/** This run's id (matches the cfg + result-file key). */
	runId: string;
	/** Root-of-tree run id (equals runId for a top-level orchestrate). */
	rootRunId: string;
	/** Lineage path of the detached child (the cross-process address). */
	lineagePath: string;
	/** The shared symmetric control capability (base64url, 32 random bytes). */
	controlSecret: string;
	/** The detached child's pid (liveness + sweep). */
	pid: number;
	/** Linux /proc start ticks disambiguate PID reuse after container restart. */
	runnerStartTicks?: string;
	/** Linux boot id paired with start ticks to reject prior-boot PID reuse. */
	runnerBootId?: string;
	/** Runner-local nonce for same-process generation ownership when available. */
	runnerNonce?: string;
	/**
	 * The id of the session that minted this record. Node B's resolver refuses
	 * a record minted by a sibling session (REQ-CTRL-5). [decision:
	 * same-user-sibling-session-decision]
	 */
	ownerSessionId: string;
}

/**
 * Mint a fresh per-run control secret: `CONTROL_SECRET_BYTES` of CSPRNG
 * randomness, base64url-encoded (url-safe, no padding — safe in an env var and
 * a JSON field). Each call returns a distinct value.
 */
export function mintControlSecret(): string {
	return crypto.randomBytes(CONTROL_SECRET_BYTES).toString("base64url");
}

/**
 * Resolve the owning foreground's session id for a route record's
 * `ownerSessionId` (REQ-CTRL-5 same-user-sibling guard). Used by BOTH sides so
 * they cannot drift: the WRITE side (executeOrchestrateShape, when minting the
 * record) and the READ side (the resolveRunControl caller, when proving
 * ownership) MUST derive the id identically. When the session id is
 * unavailable, fall back to a stable per-foreground id derived from the process
 * pid — this still scopes the record to THIS foreground process (the security
 * property the guard needs) and, crucially, is the SAME value on both sides so
 * a pid-fallback record remains controllable by its minting process.
 *
 * Earlier these two sites computed the id inline and drifted: the write side
 * used `getSessionId() ?? pid-<pid>` while the read side used
 * `getSessionId() : undefined`, so a pid-fallback record was minted owned by
 * `pid-<n>` but the resolver presented `undefined` and fail-closed — making the
 * run permanently uncontrollable. This shared helper closes that gap.
 */
export function resolveOwnerSessionId(
	getSessionId: (() => string | undefined) | undefined,
): string {
	let id: string | undefined;
	try {
		id = typeof getSessionId === "function" ? getSessionId() : undefined;
	} catch {
		id = undefined;
	}
	return id ?? `pid-${process.pid}`;
}

export interface VerifyRouteIdentityDependencies {
	verifyIdentityFn?: (
		evidence: Partial<ProcessIdentityEvidence> | undefined,
		overrides?: Partial<ProcessIdentityDependencies>,
	) => ProcessIdentityVerdict;
	processIdentityDependencies?: Partial<ProcessIdentityDependencies>;
	processNonceFn?: () => string;
}

/**
 * Classify a route record's runner generation using the shared process-identity
 * verifier. Legacy records missing birth/boot evidence remain `unproven`.
 */
export function verifyRouteRecordIdentity(
	record: Pick<RouteRecord, "pid" | "runnerStartTicks" | "runnerBootId" | "runnerNonce"> | undefined,
	deps: VerifyRouteIdentityDependencies = {},
): ProcessIdentityVerdict {
	if (!record || !Number.isSafeInteger(record.pid) || record.pid <= 0) return "unproven";
	if (!isValidProcessBootId(record.runnerBootId)) return "unproven";
	if (!isValidProcessStartTicks(record.runnerStartTicks)) {
		const probePid = deps.processIdentityDependencies?.probePid;
		if (typeof probePid !== "function") return "unproven";
		try {
			return probePid(record.pid) === "absent" ? "absent" : "unproven";
		} catch {
			return "unproven";
		}
	}
	const verifyIdentityFn = deps.verifyIdentityFn ?? verifyProcessIdentity;
	const verdict = verifyIdentityFn(
		{
			pid: record.pid,
			startTicks: record.runnerStartTicks,
			bootId: record.runnerBootId,
		},
		deps.processIdentityDependencies,
	);
	if (verdict !== "match") return verdict;
	if (record.pid !== process.pid || record.runnerNonce === undefined) return "match";
	if (!isValidProcessNonce(record.runnerNonce)) return "unproven";
	try {
		return record.runnerNonce === (deps.processNonceFn ?? getProcessNonce)()
			? "match"
			: "mismatch";
	} catch {
		return "unproven";
	}
}

/**
 * Outcome of a `writeRouteRecord` attempt. A single (non-discriminated) shape
 * so it narrows under the lenient `tsconfig.check.json` (which disables
 * `strictNullChecks`, and with it discriminated-union narrowing): `ok` is the
 * success flag, `file` is set on success, `error` on failure.
 */
export interface WriteRouteResult {
	ok: boolean;
	/** Absolute path of the written record (present when `ok`). */
	file?: string;
	/** Failure message (present when `!ok`) — surfaced as degraded-control. */
	error?: string;
}

/**
 * Persist a route record under the routes dir with the security perms
 * discipline (REQ-CTRL-3):
 *
 *   1. `mkdirSync(routesDir, { recursive: true, mode: 0o700 })`.
 *   2. `writeFileSync(file, json, { mode: 0o600 })`.
 *   3. `chmodSync(file, 0o600)` — a fallback for a permissive umask that could
 *      widen the create mode (the create `mode` is masked by the process
 *      umask; an explicit chmod is not).
 *
 * Returns a structured result rather than throwing: the caller (the dispatch
 * hot path) must keep running and surface a DEGRADED-CONTROL warning on
 * failure — the run still executes, it is just uncontrollable. A control
 * credential must NOT be silently swallowed.
 */
export function writeRouteRecord(agentDir: string, record: RouteRecord): WriteRouteResult {
	const dir = resolveOrchestrateRoutesDir(agentDir);
	const file = resolveRouteRecordFile(agentDir, record.runId);
	try {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		// Defence-in-depth: an existing dir created earlier under a permissive
		// umask keeps its old mode through `mkdirSync` (mode is honoured only on
		// CREATE), so re-assert it.
		fs.chmodSync(dir, 0o700);
		fs.writeFileSync(file, JSON.stringify(record, null, 2), { mode: 0o600 });
		// The create `mode` is masked by the process umask; chmod is not.
		fs.chmodSync(file, 0o600);
		return { ok: true, file };
	} catch (err) {
		return { ok: false, error: (err as Error)?.message ?? String(err) };
	}
}

/**
 * Read + parse a route record. Returns `null` when the file is absent or
 * unreadable / malformed — node B's resolver maps a `null` here to an explicit
 * 'control credential unavailable' result (REQ-CTRL-9), never a misleading
 * 'Unknown runId'. (This is a clean seam for node B; node A only provisions.)
 */
export function readRouteRecord(agentDir: string, runId: string): RouteRecord | null {
	// Path-traversal guard: an unsafe id reads as "no record" (credential
	// unavailable), never as a path interpolation.
	if (!isSafeRunId(runId)) return null;
	const file = resolveRouteRecordFile(agentDir, runId);
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const obj = parsed as Partial<RouteRecord>;
	if (
		typeof obj.runId !== "string" ||
		typeof obj.rootRunId !== "string" ||
		typeof obj.lineagePath !== "string" ||
		typeof obj.controlSecret !== "string" ||
		typeof obj.pid !== "number" ||
		(obj.runnerStartTicks !== undefined && !isValidProcessStartTicks(obj.runnerStartTicks)) ||
		(obj.runnerBootId !== undefined && !isValidProcessBootId(obj.runnerBootId)) ||
		(obj.runnerNonce !== undefined && !isValidProcessNonce(obj.runnerNonce)) ||
		typeof obj.ownerSessionId !== "string"
	) {
		return null;
	}
	return {
		runId: obj.runId,
		rootRunId: obj.rootRunId,
		lineagePath: obj.lineagePath,
		controlSecret: obj.controlSecret,
		pid: obj.pid,
		...(obj.runnerStartTicks ? { runnerStartTicks: obj.runnerStartTicks } : {}),
		...(obj.runnerBootId ? { runnerBootId: obj.runnerBootId } : {}),
		...(obj.runnerNonce ? { runnerNonce: obj.runnerNonce } : {}),
		ownerSessionId: obj.ownerSessionId,
	};
}

/**
 * Remove a route record (call on the run's terminal transition so the secret
 * does not outlive the run — node C wires the lifecycle). Best-effort: a failed
 * unlink is swallowed (the startup sweep in node C is the backstop). Idempotent
 * — an absent file is a no-op.
 */
export function deleteRouteRecord(agentDir: string, runId: string): void {
	// Path-traversal guard: never unlink outside the routes dir.
	if (!isSafeRunId(runId)) return;
	const file = resolveRouteRecordFile(agentDir, runId);
	try {
		fs.rmSync(file, { force: true });
	} catch {
		/* best-effort; the startup sweep is the backstop */
	}
}

/**
 * Whether a detached run has a terminal record (the result file in the results
 * dir — a `done`/`failed`/`steered` result is the terminal marker; the pending
 * dir holds only not-yet-delivered results, not a separate terminal signal).
 * The route-record + orphan-request sweep treats a run with a terminal record
 * as terminal regardless of its pid. Best-effort: a read failure → not
 * terminal (the sweep then leaves the artifact for a later pass). The default
 * is exported as a seam so the startup sweep can inject a deterministic probe
 * in tests.
 */
export function runHasTerminalRecord(agentDir: string, runId: string): boolean {
	try {
		return readResultFile(resolveResultFile(agentDir, runId)).state !== "absent";
	} catch {
		return false;
	}
}

/** Outcome of a `sweepOldOrchestrateRoutes` pass (counts, for diagnostics/tests). */
export interface SweepOrchestrateRoutesResult {
	/** Route records removed for a dead-pid + no-cfg (crashed-foreground) run. */
	routesRemoved: number;
	/** Orphan control-request files reaped because their target is terminal. */
	requestsReaped: number;
}

/**
 * Startup sweep of the orchestrate control substrate (spec 0009, node C,
 * REQ-CTRL-8). The route record is DELETED promptly on the terminal transition
 * (foreground-side, on result delivery / reaping — `deleteRouteRecord`); this
 * sweep is the CRASHED-PEER BACKSTOP, NOT the primary lifecycle. No
 * orchestrate-tree sweep existed before this — only `sweepOldChainDirs` +
 * `sweepOldEventSinks`. [decision: route-record-delete-on-terminal-plus-sweep]
 *
 * Two best-effort passes, fully fs-guarded (never throws into startup):
 *
 *   1. ROUTE RECORDS — remove a record only after durable terminal proof. A
 *      dead PID without a result is deliberately retained: it is recovery's
 *      credential-free discovery/identity authority, including when a crashed
 *      runner's cfg has already disappeared. Recovery terminalizes that shape
 *      before its own locked cleanup removes the secret.
 *   2. ORPHAN CONTROL-REQUESTS — under each route's tree, reap a leftover
 *      `control/requests/<id>.json` whose TARGET run is terminal (the child's
 *      final drain rejects in-flight requests, but a request posted after the
 *      child exited — e.g. a poster that lost the race — has no consumer and
 *      would leak forever).
 *
 * `pidAliveFn` / `hasCfg` remain accepted for compatibility with prior callers;
 * absent terminal proof no longer authorizes deletion. `isTerminal` remains
 * injectable for deterministic terminal tests. `isRecoveryInProgress` protects issue #54's durable outbox
 * transaction: a canonical synthesized result can exist before its pending
 * wake is published, so route hygiene must leave that resume authority intact.
 */
export function sweepOldOrchestrateRoutes(args: {
	agentDir: string;
	pidAliveFn?: (pid: number) => boolean;
	isTerminal?: (agentDir: string, runId: string) => boolean;
	hasCfg?: (agentDir: string, runId: string) => boolean;
	isRecoveryInProgress?: (agentDir: string, runId: string) => boolean;
}): SweepOrchestrateRoutesResult {
	const { agentDir } = args;
	void args.pidAliveFn;
	void args.hasCfg;
	const isTerminal = args.isTerminal ?? runHasTerminalRecord;
	const isRecoveryInProgress = args.isRecoveryInProgress ?? (() => false);
	const result: SweepOrchestrateRoutesResult = {
		routesRemoved: 0,
		requestsReaped: 0,
	};

	const routesDir = resolveOrchestrateRoutesDir(agentDir);
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(routesDir, { withFileTypes: true });
	} catch {
		return result; // no routes dir yet → nothing to sweep
	}

	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const runId = entry.name.replace(/\.json$/, "");
		const initialRecord = readRouteRecord(agentDir, runId);
		if (!initialRecord) {
			// Unreadable / malformed route record — best-effort remove (it carries
			// no usable credential and can never be reconciled).
			deleteRouteRecord(agentDir, runId);
			result.routesRemoved++;
			continue;
		}
		// Reap terminal targets without holding this route's lock across a whole-root
		// directory scan. The reaper acquires each target lock only for its own
		// terminal re-check + unlink, so a live runner's terminal publisher cannot be
		// delayed behind unrelated inbox contents.
		result.requestsReaped += reapOrphanControlRequestsForRoot(
			agentDir,
			initialRecord.rootRunId,
			isTerminal,
		);
		if (!isTerminal(agentDir, runId)) {
			// A dead route with no result remains recoverable. Retaining it is safer
			// than treating cfg absence as authority to discard the only identity that
			// can terminalize the orphan.
			continue;
		}

		// Posting and every terminal cleanup path share this per-run lock. Without
		// it, a post that observed "no result" could land immediately after the
		// sweep's final request reap and be stranded after route deletion.
		const lock = acquireOrchestrateRecoveryLock({ agentDir, runId });
		if (!lock) continue;
		try {
			const record = readRouteRecord(agentDir, runId);
			if (!record || !isTerminal(agentDir, runId)) continue;

			// (1a) Delete a route record whose run has reached a TERMINAL record — the
			// secret-bearing route must not outlive the run (REQ-CTRL-8). This catches
			// the path where a terminal result exists but delete-on-delivery never ran
			// (e.g. the foreground died before hydrate-and-deliver, or the run was
			// only ever observed via the steer/cancel terminal fast path). A terminal
			// record means no consumer will ever drain the secret again, regardless of
			// whether the cfg still exists or the pid probe reports live.
			if (isRecoveryInProgress(agentDir, runId)) {
				// The externally synthesized canonical result is only phase one of
				// recovery. Preserve the route until pending outbox publication commits.
				continue;
			}
			if (hasOrphanControlRequestForRun(agentDir, record.rootRunId, runId)) continue;
			deleteRouteRecord(agentDir, runId);
			deleteOrchestrateActiveMarker({
				agentDir,
				ownerSessionId: record.ownerSessionId,
				runId,
			});
			result.routesRemoved++;
		} finally {
			releaseOrchestrateRecoveryLock(lock);
		}
	}

	return result;
}

/**
 * Reap orphan `control/requests/<id>.json` files under a tree whose TARGET run
 * is terminal (spec 0009, REQ-CTRL-8). A request's `targetPath` is the
 * `<rootRunId>/<runId>#<idx>` lineage path; we recover its runId and, when that
 * run is terminal, remove the leftover request (no consumer will ever drain
 * it). Best-effort throughout. Returns the count reaped.
 */
export function reapOrphanControlRequestsForRoot(
	agentDir: string,
	rootRunId: string,
	isTerminal: (agentDir: string, runId: string) => boolean = runHasTerminalRecord,
	options: { heldRunId?: string } = {},
): number {
	if (!isSafeRunId(rootRunId)) return 0;
	let reaped = 0;
	const requestsDir = path.join(
		resolveControlDir(agentDir, rootRunId),
		"requests",
	);
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(requestsDir, { withFileTypes: true });
	} catch {
		return 0; // no requests dir → nothing to reap
	}
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const file = path.join(requestsDir, entry.name);
		const targetRunId = requestTargetRunId(file);
		if (!targetRunId) continue;
		if (!isTerminal(agentDir, targetRunId)) continue;
		const lock = targetRunId === options.heldRunId
			? undefined
			: acquireOrchestrateRecoveryLock({ agentDir, runId: targetRunId });
		if (targetRunId !== options.heldRunId && !lock) continue;
		try {
			// Re-check under the same lock posters use before unlinking. This is the
			// final-reap boundary: a post is either already present and reaped, or it
			// obtains the lock later, sees terminal proof, and is refused.
			if (!isTerminal(agentDir, targetRunId)) continue;
			fs.rmSync(file, { force: true });
			reaped++;
		} catch {
			/* best-effort */
		} finally {
			if (lock) releaseOrchestrateRecoveryLock(lock);
		}
	}
	return reaped;
}

/** Whether a target still has a parseable control request under its root. */
export function hasOrphanControlRequestForRun(
	agentDir: string,
	rootRunId: string,
	runId: string,
): boolean {
	if (!isSafeRunId(rootRunId) || !isSafeRunId(runId)) return false;
	const requestsDir = path.join(resolveControlDir(agentDir, rootRunId), "requests");
	try {
		for (const entry of fs.readdirSync(requestsDir, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			if (requestTargetRunId(path.join(requestsDir, entry.name)) === runId) return true;
		}
	} catch {
		// A missing directory is clean. Other read failures are not proof that
		// cleanup completed, so retain the route/state for retry.
		try {
			fs.accessSync(requestsDir, fs.constants.F_OK);
			return true;
		} catch {
			return false;
		}
	}
	return false;
}

/**
 * Locked terminal cleanup shared by the normal child, foreground delivery, and
 * fast-path controls. A post either completes before the final reaping pass or
 * acquires this lock afterwards and refuses the durable terminal result.
 */
export function finalizeTerminalOrchestrateRoute(args: {
	agentDir: string;
	runId: string;
	ownerSessionId?: string;
	/** The caller just consumed a validated pending terminal envelope. */
	terminalKnown?: boolean;
}): boolean {
	const { agentDir, runId } = args;
	const lock = acquireOrchestrateRecoveryLock({ agentDir, runId });
	if (!lock) return false;
	try {
		if (!args.terminalKnown && !runHasTerminalRecord(agentDir, runId)) return false;
		const route = readRouteRecord(agentDir, runId);
		const rootRunId = route?.rootRunId;
		if (rootRunId) {
			reapOrphanControlRequestsForRoot(agentDir, rootRunId, undefined, { heldRunId: runId });
			if (hasOrphanControlRequestForRun(agentDir, rootRunId, runId)) return false;
		}
		deleteRouteRecord(agentDir, runId);
		deleteOrchestrateActiveMarker({
			agentDir,
			ownerSessionId: route?.ownerSessionId ?? args.ownerSessionId,
			runId,
		});
		return !fs.existsSync(resolveRouteRecordFile(agentDir, runId));
	} finally {
		releaseOrchestrateRecoveryLock(lock);
	}
}

/**
 * Recover the TARGET run id from a control-request file's `targetPath`. The
 * lineage path is `<rootRunId>/<runId>#<childIndex>`; the runId is the segment
 * after the first `/`, before the `#`. Returns `undefined` on any read/parse
 * failure or a malformed path (the caller then leaves the file in place).
 */
function requestTargetRunId(file: string): string | undefined {
	let targetPath: string | undefined;
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as {
			targetPath?: unknown;
		};
		if (typeof parsed?.targetPath === "string") targetPath = parsed.targetPath;
	} catch {
		return undefined;
	}
	if (!targetPath) return undefined;
	const slash = targetPath.indexOf("/");
	if (slash < 0) return undefined;
	const afterRoot = targetPath.slice(slash + 1);
	const hash = afterRoot.indexOf("#");
	const runId = hash >= 0 ? afterRoot.slice(0, hash) : afterRoot;
	return runId || undefined;
}

// ============================================================================
// resolveRunControl — the unified run-control resolver (spec 0009, node B:
// `auth-gate-and-resolver`). [decision: resolver-map-first-route-second]
// ============================================================================
//
// `delegate_control` actions `steer` / `cancel` accept a BARE runId and must address any
// run uniformly — an in-process run (the same-process owner, the unchanged
// fast path) OR a DETACHED orchestrate child (a different process, reachable
// only via the cross-process control inbox). This resolver collapses the choice
// into one call (REQ-CTRL-1):
//
//   1. Consult the IN-MEMORY runs map FIRST (`lookupRun`). A hit returns an
//      IN-PROCESS handle that applies steer/cancel via the live closure — NO
//      filesystem hop (REQ-CTRL-2 map-first; the fast path MUST NOT regress).
//   2. On a MISS, read the 0600 route record. If present AND its
//      `ownerSessionId` matches the current session (the same-user-sibling
//      guard, REQ-CTRL-5) AND its `runId` matches the requested id (node-A
//      reviewer hardening: never trust a mismatched record for routing), return
//      a DETACHED handle that posts an inbox request authenticated by the
//      record's control secret.
//   3. If the record is absent / unreadable / fails a guard, return an explicit
//      'control credential unavailable' result (REQ-CTRL-9) — NOT a misleading
//      'Unknown runId' fall-through.
//
// The resolver itself performs NO auth: it merely SELECTS the route and carries
// the control secret to `postControlRequest`. The auth gate is on the consumer
// side (`pollControlRequests` / `consumeControlRequests`, this same module's
// sibling `control-inbox.ts`), which matches the presented secret constant-time
// (REQ-CTRL-4).

/** A live in-process run handle (the runs-map fast path), supplied by the caller. */
export interface InProcessRunRef {
	/** Whether the run has already completed (steer is a no-op then). */
	completedAt?: number;
	/** Deliver a steer to the live run(s). Present for an active run. */
	steer?: (
		forkName: string | undefined,
		text: string,
		opts?: { deliverAs?: "steer" | "followUp" | "queue" },
	) => Promise<{ delivered: string; error?: string }>;
	/** Abort the live run(s). Present for an active run. */
	cancel?: (forkName?: string, reason?: string) => Promise<void>;
	/** Stable run-state registry field retained as `forks` for compatibility. */
	forks?: Record<string, unknown>;
}

/**
 * The resolved control handle. A single (non-discriminated) `kind` tag plus the
 * payload fields per branch — a flat shape so it narrows under the lenient
 * `tsconfig.check.json` (which disables `strictNullChecks`, and with it true
 * discriminated-union narrowing); callers switch on `kind`.
 */
export type RunControlHandle =
	| {
			/** The runId is live in THIS process — act via the in-process closure. */
			kind: "in-process";
			run: InProcessRunRef;
	  }
	| {
			/** The runId is a detached child — route via the authenticated inbox. */
			kind: "detached";
			lineagePath: string;
			rootRunId: string;
			controlSecret: string;
			pid: number;
	  }
	| {
			/** No control credential is available for this runId (REQ-CTRL-9). */
			kind: "unavailable";
			reason: string;
	  };

/**
 * Resolve a bare `runId` to a control handle (spec 0009, REQ-CTRL-1/2/5/9).
 *
 * Dependencies are INJECTED so the resolver stays a pure function of (runs-map
 * lookup, route-record read, current session id) and a unit test can assert the
 * critical regression invariant: an IN-MEMORY hit NEVER touches the filesystem.
 * Production wires `lookupRun` to the runtime's `getRun`/`getRunSnapshot`,
 * `readRoute` to `readRouteRecord`, and `currentSessionId` to the foreground
 * session id.
 *
 * @param args.runId            the bare run id to resolve.
 * @param args.lookupRun        runs-map accessor (in-memory; consulted FIRST).
 * @param args.hasInMemoryRun   raw map-presence probe used only to distinguish a filtered hit in diagnostics.
 * @param args.currentSessionId this foreground session's id (the owner guard).
 * @param args.agentDir         agent dir for the route-record read (route path).
 * @param args.readRoute        route-record reader (defaults to `readRouteRecord`).
 */
export function resolveRunControl(args: {
	runId: string;
	lookupRun: (runId: string) => InProcessRunRef | undefined;
	hasInMemoryRun?: (runId: string) => boolean;
	currentSessionId: string | undefined;
	agentDir: string;
	readRoute?: (agentDir: string, runId: string) => RouteRecord | null;
}): RunControlHandle {
	const { runId, lookupRun, currentSessionId, agentDir } = args;
	const readRoute = args.readRoute ?? readRouteRecord;

	// Path-traversal guard (MR !2 review finding #1): a tool-supplied runId is
	// arbitrary text; an unsafe shape can never reach a path interpolation.
	if (!isSafeRunId(runId)) {
		return {
			kind: "unavailable",
			reason: "control credential unavailable (invalid runId format)",
		};
	}

	// (1) MAP-FIRST: a runs-map hit is the in-process fast path. NO fs access
	// here — the regression test pins that a hit never reads the route record.
	const live = lookupRun(runId);
	if (live) {
		return { kind: "in-process", run: live };
	}

	// (2) MISS → consult the 0600 route record (the detached path).
	const record = readRoute(agentDir, runId);
	if (!record) {
		// (3) Absent / unreadable / malformed — an explicit credential-unavailable
		// result, NOT a misleading 'Unknown runId' (REQ-CTRL-9).
		return {
			kind: "unavailable",
			reason: args.hasInMemoryRun?.(runId) === true
				? "control credential unavailable (in-memory run is unavailable for live control and no readable route record exists for this runId)"
				: "control credential unavailable (no in-memory run and no readable route record for this runId)",
		};
	}

	// HARDENING (node-A reviewer nit): never trust a record whose runId does not
	// match the requested id for ROUTING — a mismatched record is treated as
	// unavailable rather than steering some other run.
	if (record.runId !== runId) {
		return {
			kind: "unavailable",
			reason: "control credential unavailable (route record runId mismatch)",
		};
	}

	// OWNER GUARD (REQ-CTRL-5): a route record may only be used by the session
	// that minted it — a sibling session (same user, different session) must NOT
	// be able to steer/cancel a run it does not own.
	if (!currentSessionId || record.ownerSessionId !== currentSessionId) {
		return {
			kind: "unavailable",
			reason: "control credential unavailable (route record owned by a different session)",
		};
	}

	return {
		kind: "detached",
		lineagePath: record.lineagePath,
		rootRunId: record.rootRunId,
		controlSecret: record.controlSecret,
		pid: record.pid,
	};
}

/** Outcome of routing a control verb to a DETACHED run via the inbox. */
export interface DetachedControlOutcome {
	/** Whether a request was successfully posted (a write reached the inbox). */
	posted: boolean;
	/** Whether the child acknowledged success (undefined → no result in window). */
	ok?: boolean;
	/** The posted request id (when `posted`). */
	requestId?: string;
	/** Human-readable detail (the child's result detail, or a failure reason). */
	detail?: string;
}

/**
 * Route a steer/cancel verb to a DETACHED run's control inbox, authenticated by
 * the record's control secret (spec 0009, REQ-CTRL-2 detached branch). Posts a
 * `control-request` carrying the secret (NOT a cap token — the foreground
 * cannot mint one the detached child accepts) and awaits the child's
 * `control-result`. The post + await are the existing best-effort inbox
 * helpers; this is the thin glue the two tools call on a `detached` handle.
 *
 * Injectable `post` / `awaitResult` keep this unit-testable without real fs.
 */
export async function routeDetachedControl(args: {
	agentDir: string;
	handle: Extract<RunControlHandle, { kind: "detached" }>;
	kind: "steer" | "cancel";
	payload?: Record<string, unknown>;
	timeoutMs?: number;
	post?: typeof postControlRequest;
	awaitResult?: typeof awaitControlResult;
}): Promise<DetachedControlOutcome> {
	const post = args.post ?? postControlRequest;
	const awaitResult = args.awaitResult ?? awaitControlResult;
	const id = post({
		agentDir: args.agentDir,
		targetLineagePath: args.handle.lineagePath,
		// No cap token on the detached path — the control secret is the credential.
		capToken: "",
		controlSecret: args.handle.controlSecret,
		kind: args.kind,
		...(args.payload ? { payload: args.payload } : {}),
	});
	if (!id) {
		return { posted: false, detail: "could not post control request (unwritable inbox or malformed path)" };
	}
	const rootRunId =
		args.handle.rootRunId || rootRunIdFromLineagePath(args.handle.lineagePath);
	const result = rootRunId
		? await awaitResult({
				agentDir: args.agentDir,
				rootRunId,
				id,
				timeoutMs: args.timeoutMs ?? 5_000,
			})
		: undefined;
	return {
		posted: true,
		requestId: id,
		...(result ? { ok: result.ok, detail: result.detail } : {}),
	};
}
