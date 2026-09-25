/**
 * Authenticated nested steer/cancel control plane for the delegation tree
 * (spec 0004, node `control-inbox`, REQ-BUS-3).
 *
 * ## Why
 *
 * `delegate_control` actions `steer` / `cancel` (src/index.ts) today reach only the
 * IMMEDIATE run via the in-process `steer()` / `pendingGuidance` channel.
 * They cannot address a DEEPLY-NESTED child (foreground → orchestrator →
 * worker), and a detached `orchestrate` child (spec 0005) shares no in-memory
 * channel with its parent at all. This module is the boundary-crossing
 * control plane that closes both gaps: a parent writes a `control-request`
 * addressed by lineage path; the addressed child polls for it, AUTHENTICATES
 * it, handles it, and writes back a `control-result`.
 *
 * ## Layout — alongside the event sink (REQ-BUS-5: one id/path scheme)
 *
 *   <agentDir>/extensions/pi-delegate/event-bus/<rootRunId>/control/requests/<id>.json
 *   <agentDir>/extensions/pi-delegate/event-bus/<rootRunId>/control/results/<id>.json
 *
 * The sink is keyed by the SAME `rootRunId` the event bus uses, and the
 * routing ADDRESS is the SAME `lineagePath(frame)` (`<rootRunId>/<runId>#<idx>`)
 * the bus consumes — there is no second id scheme. `rootRunId` is recovered
 * from the target lineage path's leading segment so a poster needs only the
 * path + token, never the child's live frame.
 *
 * ## Auth (REQ-BUS-3 + the spec-0003 security property)
 *
 * A `control-request` carries a `capToken`. The addressed child, polling with
 * its OWN live `DepthFrame`, calls `verifyCapToken(frame, request.capToken)`
 * (src/lineage.ts) — the cap-token HMAC is keyed by the non-inherited,
 * in-memory `rootSecret`, so ONLY a process in the same delegation tree can
 * mint a token that validates for a given frame. A request whose token does
 * NOT validate against the child's frame is REJECTED and never delivered, so
 * an unrelated process cannot steer/cancel someone else's child.
 *
 * ## Best-effort discipline (REQ-BUS-4)
 *
 * Every write / poll is best-effort — exactly like the event-bus sink and the
 * lifecycle logger. A failure (unwritable dir, disk full, garbage file) is
 * swallowed behind a single throttled `console.warn` and NEVER throws into
 * run execution.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DepthFrame } from "./depth-guard.js";
import {
	__resetDelegateDiagnosticsForTests,
	logDelegateDiagnostic,
} from "./diagnostics.js";
import { lineagePath, verifyCapToken } from "./lineage.js";
import {
	acquireOrchestrateRecoveryLock,
	releaseOrchestrateRecoveryLock,
} from "./orchestrate-recovery-lock.js";
import { readResultFile, resolveResultFile } from "./detached-spawn.js";
import { isSafeRunId } from "./run-id.js";

/** Control-request kinds — mirror the immediate-run verbs (steer / cancel). */
export type ControlRequestKind = "steer" | "cancel";

/** Recover the target run id from the canonical `<root>/<run>#<index>` path. */
function targetRunIdFromLineagePath(targetLineagePath: string, rootRunId: string): string | undefined {
	const prefix = `${rootRunId}/`;
	if (!targetLineagePath.startsWith(prefix)) return undefined;
	const remainder = targetLineagePath.slice(prefix.length);
	const hash = remainder.indexOf("#");
	const runId = hash >= 0 ? remainder.slice(0, hash) : remainder;
	return isSafeRunId(runId) ? runId : undefined;
}

/**
 * A parent→child control request addressed by lineage path. Written by
 * `postControlRequest`, polled (and authenticated) by `pollControlRequests`.
 */
export interface ControlRequest {
	/** Unique request id (also the filename stem). */
	id: string;
	/** ms-since-epoch post time. */
	ts: number;
	/** The addressed child's `lineagePath(frame)` — `<rootRunId>/<runId>#<idx>`. */
	targetPath: string;
	/** Cap token authorizing this request against the target frame (REQ-BUS-3). */
	capToken: string;
	/**
	 * Per-run CONTROL SECRET authorizing this request (spec 0009, REQ-CTRL-4).
	 * Carried for the DETACHED path: a foreground process (a DIFFERENT process,
	 * with a different `rootSecret`) provably cannot mint a cap token a detached
	 * child accepts, so it authenticates with the shared control secret from the
	 * run's 0600 route record instead. The child matches it against its OWN
	 * secret (read from `CONTROL_SECRET_ENV`) via `crypto.timingSafeEqual`. The
	 * `capToken` path stays for in-process nested children. Optional because an
	 * in-process nested request carries only a cap token.
	 */
	controlSecret?: string;
	/** `steer` injects guidance; `cancel` requests the child abort. */
	kind: ControlRequestKind;
	/** Free-form payload (e.g. the steer message). */
	payload?: Record<string, unknown>;
}

/**
 * The child's acknowledgement of a handled request, written by
 * `writeControlResult` and read back by `awaitControlResult`.
 */
export interface ControlResult {
	/** The request id this result answers. */
	id: string;
	/** ms-since-epoch handling time. */
	ts: number;
	/** The addressed child's lineage path (echoed for the poster's match). */
	targetPath: string;
	/** Whether the child handled the request successfully. */
	ok: boolean;
	/** Human-readable detail (e.g. `"queued"`, `"aborting"`, a rejection reason). */
	detail?: string;
}

/**
 * Issue #8 — maximum serialized size of a single control request (~1 MB).
 * Oversized requests are refused at the WRITE side (postControlRequest
 * returns undefined + a throttled warning) so a buggy/looping poster can
 * never fill the inbox dir with arbitrarily large files.
 */
export const MAX_CONTROL_REQUEST_BYTES = 1024 * 1024;

/**
 * Recover the `rootRunId` (sink key) from a lineage path. The lineage path is
 * `<rootRunId>/<runId>#<childIndex>` (see `lineagePath` in src/lineage.ts), so
 * the leading `/`-segment is the root. Returns `undefined` for a malformed
 * path so callers can no-op rather than write to a bogus sink.
 */
export function rootRunIdFromLineagePath(targetPath: string): string | undefined {
	if (typeof targetPath !== "string" || targetPath === "") return undefined;
	const slash = targetPath.indexOf("/");
	if (slash <= 0) return undefined;
	return targetPath.slice(0, slash);
}

/** Resolve the control dir for a tree: `<sink>/<rootRunId>/control`. */
export function resolveControlDir(agentDir: string, rootRunId: string): string {
	return path.join(agentDir, "extensions", "pi-delegate", "event-bus", rootRunId, "control");
}

function resolveRequestsDir(agentDir: string, rootRunId: string): string {
	return path.join(resolveControlDir(agentDir, rootRunId), "requests");
}

function resolveResultsDir(agentDir: string, rootRunId: string): string {
	return path.join(resolveControlDir(agentDir, rootRunId), "results");
}

// ── Throttled warn (best-effort discipline, REQ-BUS-4 / spec-0017) ──────────
//
// Thin caller of the shared spec-0017 diagnostics core under
// `throttleKey="control-inbox"`: route the message to the best-effort
// `diagnostics.log` by default and echo to `console.warn` ONLY when
// `PI_DELEGATE_DEBUG === "1"`. The per-key 60s throttle now lives in the shared
// core, so a chatty control-inbox can't flood the file either.
function warnThrottled(message: string, agentDir?: string): void {
	logDelegateDiagnostic(`control-inbox: ${message}`, {
		agentDir,
		throttleKey: "control-inbox",
		level: "warn",
	});
}

/**
 * Test-only: reset the warn throttle so a test can assert a fresh warn.
 * Delegates to the shared diagnostics reset (the throttle state now lives in
 * the spec-0017 core).
 */
export function __resetControlInboxWarnForTests(): void {
	__resetDelegateDiagnosticsForTests();
}

/**
 * Constant-time equality of two control secrets (spec 0009, REQ-CTRL-4/5).
 * Uses `crypto.timingSafeEqual` directly (NOT `===`, which leaks length/prefix
 * timing). `timingSafeEqual` THROWS on unequal-length buffers, so we guard the
 * length first; an empty/absent secret on either side is treated as a
 * non-match. The length guard is itself a (benign) early-out — it leaks only
 * that the lengths differ, which for a fixed-width base64url secret is constant
 * across all valid secrets.
 */
function controlSecretMatches(presented: string | undefined, expected: string | undefined): boolean {
	if (!presented || !expected) return false;
	const a = Buffer.from(presented, "utf-8");
	const b = Buffer.from(expected, "utf-8");
	if (a.length !== b.length) return false;
	return crypto.timingSafeEqual(a, b);
}

/** Parse + shape-validate a control-request file (best-effort; null on garbage). */
function readRequestFile(file: string): ControlRequest | null {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			parsed &&
			typeof parsed === "object" &&
			typeof (parsed as ControlRequest).id === "string" &&
			typeof (parsed as ControlRequest).targetPath === "string" &&
			// A request must carry at least one credential: a cap token (in-process
			// nested) OR a control secret (detached, spec 0009). A garbage file with
			// neither is rejected here.
			(typeof (parsed as ControlRequest).capToken === "string" ||
				typeof (parsed as ControlRequest).controlSecret === "string") &&
			((parsed as ControlRequest).kind === "steer" ||
				(parsed as ControlRequest).kind === "cancel")
		) {
			return parsed as ControlRequest;
		}
	} catch {
		/* garbage line; best-effort */
	}
	return null;
}

/**
 * Post a control-request addressed to a nested child by lineage path
 * (REQ-BUS-3). Writes `<sink>/<rootRunId>/control/requests/<id>.json`, keying
 * the sink off the `rootRunId` embedded in `targetLineagePath`.
 *
 * Returns the request `id` on a successful write, or `undefined` when the
 * write was skipped/failed (malformed path, unresolvable agentDir, unwritable
 * dir). BEST-EFFORT (REQ-BUS-4): never throws into the caller.
 */
export function postControlRequest(args: {
	agentDir: string;
	targetLineagePath: string;
	capToken: string;
	/**
	 * Per-run control secret (spec 0009, REQ-CTRL-4) for the DETACHED path. When
	 * present it is written onto the request so the detached child can
	 * authenticate via `crypto.timingSafeEqual` even though the cap token cannot
	 * validate across the process boundary. The in-process nested path omits it
	 * and relies on the cap token alone.
	 */
	controlSecret?: string;
	kind: ControlRequestKind;
	payload?: Record<string, unknown>;
	ts?: number;
	/** Test seam: deterministic id (defaults to a random hex id). */
	id?: string;
}): string | undefined {
	try {
		const { agentDir, targetLineagePath, capToken, kind } = args;
		// A request must carry AT LEAST one credential — a cap token (in-process
		// nested) or a control secret (detached). A bare path with neither cannot
		// authenticate against any consumer, so skip the write.
		if (!agentDir || !targetLineagePath || (!capToken && !args.controlSecret)) return undefined;
		const rootRunId = rootRunIdFromLineagePath(targetLineagePath);
		if (!rootRunId) return undefined;
		const targetRunId = targetRunIdFromLineagePath(targetLineagePath, rootRunId);
		if (!targetRunId) return undefined;
		// The recovery transaction reaps terminal control requests and then
		// deletes the route secret. Every post path (bare detached and explicit
		// lineage-path) takes this exact lock so a post cannot land between that
		// reap and deletion boundary. A live/stale owner follows the same
		// first-writer-wins and dead-PID reclamation discipline as recovery.
		const recoveryLock = acquireOrchestrateRecoveryLock({ agentDir, runId: targetRunId });
		if (!recoveryLock) return undefined;
		try {
			// A caller can retain a route/lineage handle across terminal cleanup.
			// Terminal result is the durable authority, so reject that stale post
			// while holding the same lock as reconciliation before it can recreate
			// an orphan control-request after the final reap.
			if (readResultFile(resolveResultFile(agentDir, targetRunId)).state !== "absent") return undefined;
			const id = args.id ?? crypto.randomBytes(12).toString("hex");
			const dir = resolveRequestsDir(agentDir, rootRunId);
			// HARDENING (MR !2 review finding #2): the request can carry the per-run
			// `controlSecret`, so apply the SAME owner-only discipline as the route
			// record (control-route.ts writeRouteRecord): 0700 dir (chmod re-asserts
			// against a permissive umask / a pre-existing wide dir), 0600 file.
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
			fs.chmodSync(dir, 0o700);
			const request: ControlRequest = {
				id,
				ts: args.ts ?? Date.now(),
				targetPath: targetLineagePath,
				capToken,
				...(args.controlSecret ? { controlSecret: args.controlSecret } : {}),
				kind,
				...(args.payload ? { payload: args.payload } : {}),
			};
			const requestFile = path.join(dir, `${id}.json`);
			const serialized = JSON.stringify(request);
			// Issue #8 — cap the serialized request (~1 MB). A buggy/looping poster
			// could otherwise write arbitrarily large request files into the inbox.
			// Low attack value (the poster already holds a credential) but cheap
			// insurance; consistent with the RPC client's MAX_STDERR_BYTES cap.
			if (Buffer.byteLength(serialized, "utf-8") > MAX_CONTROL_REQUEST_BYTES) {
				warnThrottled(
					`postControlRequest refused: serialized request exceeds ${MAX_CONTROL_REQUEST_BYTES} bytes ` +
						`(kind=${kind}, target=${targetLineagePath})`,
					args.agentDir,
				);
				return undefined;
			}
			fs.writeFileSync(requestFile, serialized, { encoding: "utf-8", mode: 0o600 });
			// The create `mode` is masked by the process umask; chmod is not.
			fs.chmodSync(requestFile, 0o600);
			return id;
		} finally {
			releaseOrchestrateRecoveryLock(recoveryLock);
		}
	} catch (err) {
		warnThrottled(
			`postControlRequest failed (best-effort, swallowed): ${(err as Error)?.message ?? err}`,
			args.agentDir,
		);
		return undefined;
	}
}

/**
 * Poll for control-requests addressed to `frame`'s OWN lineage path and
 * AUTHENTICATE them. A request is delivered ONLY when it is addressed to THIS
 * child (`request.targetPath === lineagePath(frame)`) AND it authenticates via
 * EITHER of two paths:
 *
 *   (a) `verifyCapToken(frame, request.capToken)` — the in-process nested path
 *       (REQ-BUS-3, spec-0003 security property: only a same-tree process can
 *       mint a validating token). Used by deeply-nested in-process children.
 *   (b) `controlSecretMatches(request.controlSecret, args.controlSecret)` — the
 *       DETACHED path (spec 0009, REQ-CTRL-4): a foreground process (a
 *       DIFFERENT process with a different `rootSecret`) cannot mint a cap
 *       token this child accepts, so it presents the shared per-run control
 *       secret from the 0600 route record, matched constant-time against the
 *       child's OWN secret (read from `CONTROL_SECRET_ENV`, passed here as
 *       `args.controlSecret`).
 *
 * The two paths are ADDITIVE — (b) does NOT replace (a). When the consumer has
 * no control secret (`args.controlSecret` absent, e.g. an in-process child),
 * only path (a) is available, exactly as before spec 0009.
 *
 * A request addressed to a DIFFERENT path is ignored (not this child's). A
 * request for the right path that authenticates by NEITHER path is REJECTED
 * (REQ-CTRL-5) — it is NOT returned, and a `control-result { ok: false }` is
 * written so the (forged) poster's await terminates rather than hanging.
 * Requests for OTHER children are left in place for their own poll.
 *
 * BEST-EFFORT (REQ-BUS-4): any read failure returns `[]`; never throws.
 */
export function pollControlRequests(args: {
	agentDir: string;
	frame: DepthFrame;
	/**
	 * The consumer's OWN per-run control secret (spec 0009, REQ-CTRL-4). When
	 * present, a request presenting a constant-time-matching `controlSecret`
	 * authenticates ALONGSIDE the cap-token path. Absent → only the cap-token
	 * path is available (in-process children).
	 */
	controlSecret?: string;
	now?: number;
}): ControlRequest[] {
	try {
		const { agentDir, frame } = args;
		if (!agentDir || !frame?.rootRunId) return [];
		const myPath = lineagePath(frame);
		const dir = resolveRequestsDir(agentDir, frame.rootRunId);
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return []; // no requests dir yet
		}
		const delivered: ControlRequest[] = [];
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			const file = path.join(dir, entry.name);
			const req = readRequestFile(file);
			if (!req) continue;
			// Not addressed to THIS child — leave it for its own poll.
			if (req.targetPath !== myPath) continue;
			// AUTH (REQ-BUS-3 + spec 0009 REQ-CTRL-4/5): a request authenticates by
			// EITHER the cap-token path (in-process nested) OR the control-secret
			// path (detached). Reject only when NEITHER holds. The control-secret
			// match is constant-time (`crypto.timingSafeEqual`, length-guarded) and
			// is unavailable when the consumer has no own secret (`args.controlSecret`
			// absent — an in-process child), in which case only the cap-token path
			// applies, exactly as before. A request that authenticates by NEITHER is
			// consumed and a failure result written so a forged poster does not block.
			const capOk = req.capToken ? verifyCapToken(frame, req.capToken) : false;
			const secretOk =
				!capOk && controlSecretMatches(req.controlSecret, args.controlSecret);
			if (!capOk && !secretOk) {
				warnThrottled(
					`rejected control-request ${req.id} for ${myPath}: no valid credential (cap token / control secret)`,
					args.agentDir,
				);
				try {
					fs.rmSync(file, { force: true });
				} catch {
					/* best-effort */
				}
				writeControlResult({
					agentDir,
					frame,
					id: req.id,
					ok: false,
					detail: "rejected: invalid credential",
					now: args.now,
				});
				continue;
			}
			// Authentic + addressed: consume the request file and deliver it.
			try {
				fs.rmSync(file, { force: true });
			} catch {
				/* best-effort */
			}
			delivered.push(req);
		}
		return delivered;
	} catch (err) {
		warnThrottled(
			`pollControlRequests failed (best-effort, swallowed): ${(err as Error)?.message ?? err}`,
			args.agentDir,
		);
		return [];
	}
}

/**
 * Write the child's `control-result` for a handled (or rejected) request
 * (REQ-BUS-3). The poster reads it back via `awaitControlResult`.
 *
 * BEST-EFFORT (REQ-BUS-4): swallows write failures; never throws.
 */
export function writeControlResult(args: {
	agentDir: string;
	frame: DepthFrame;
	id: string;
	ok: boolean;
	detail?: string;
	now?: number;
}): void {
	try {
		const { agentDir, frame, id, ok } = args;
		if (!agentDir || !frame?.rootRunId || !id) return;
		const dir = resolveResultsDir(agentDir, frame.rootRunId);
		// Owner-only for consistency with the requests dir (finding #2); results
		// carry no secret, but the whole control/ subtree stays 0700.
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		// Issue #8 (review finding) — chmod re-assert + 0600 result file, same
		// discipline as the request write above (create modes are umask-masked).
		fs.chmodSync(dir, 0o700);
		const result: ControlResult = {
			id,
			ts: args.now ?? Date.now(),
			targetPath: lineagePath(frame),
			ok,
			...(args.detail !== undefined ? { detail: args.detail } : {}),
		};
		const resultFile = path.join(dir, `${id}.json`);
		fs.writeFileSync(resultFile, JSON.stringify(result), { encoding: "utf-8", mode: 0o600 });
		fs.chmodSync(resultFile, 0o600);
	} catch (err) {
		warnThrottled(
			`writeControlResult failed (best-effort, swallowed): ${(err as Error)?.message ?? err}`,
			args.agentDir,
		);
	}
}

/** Read the control-result for a request id, or `undefined` if not yet written. */
export function readControlResult(args: {
	agentDir: string;
	rootRunId: string;
	id: string;
}): ControlResult | undefined {
	try {
		const { agentDir, rootRunId, id } = args;
		if (!agentDir || !rootRunId || !id) return undefined;
		const file = path.join(resolveResultsDir(agentDir, rootRunId), `${id}.json`);
		const raw = fs.readFileSync(file, "utf-8");
		const parsed: unknown = JSON.parse(raw);
		if (
			parsed &&
			typeof parsed === "object" &&
			typeof (parsed as ControlResult).id === "string" &&
			typeof (parsed as ControlResult).ok === "boolean"
		) {
			return parsed as ControlResult;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * Await the `control-result` for a posted request, polling `readControlResult`
 * until it appears or `timeoutMs` elapses. Returns the result, or `undefined`
 * on timeout. BEST-EFFORT (REQ-BUS-4): never throws.
 *
 * `sleepFn` is injectable so a test can drive the poll loop without real
 * wall-clock waits; it defaults to a real `setTimeout`-backed sleep.
 */
export async function awaitControlResult(args: {
	agentDir: string;
	rootRunId: string;
	id: string;
	timeoutMs?: number;
	pollIntervalMs?: number;
	now?: () => number;
	sleepFn?: (ms: number) => Promise<void>;
}): Promise<ControlResult | undefined> {
	const { agentDir, rootRunId, id } = args;
	const timeoutMs = args.timeoutMs ?? 5_000;
	const pollIntervalMs = args.pollIntervalMs ?? 50;
	const now = args.now ?? Date.now;
	const sleep = args.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const deadline = now() + timeoutMs;
	for (;;) {
		const result = readControlResult({ agentDir, rootRunId, id });
		if (result) return result;
		if (now() >= deadline) return undefined;
		await sleep(pollIntervalMs);
	}
}

/**
 * Resolve the control-inbox path a DETACHED child (spec 0005) would poll,
 * from its inherited lineage frame. The detached `orchestrate` spawn that
 * USES this (reading the frame from the lineage env via `deserializeLineage`
 * and polling on an interval) is spec 0005; this helper wires the path
 * resolution so that spawn has a single source of truth for WHERE to poll.
 *
 * Returns `undefined` when the frame carries no `rootRunId` (a genuine
 * top-level process with nothing to poll).
 */
export function resolveDetachedControlInbox(
	agentDir: string,
	frame: DepthFrame | undefined,
): { requestsDir: string; resultsDir: string; targetPath: string } | undefined {
	if (!agentDir || !frame?.rootRunId) return undefined;
	return {
		requestsDir: resolveRequestsDir(agentDir, frame.rootRunId),
		resultsDir: resolveResultsDir(agentDir, frame.rootRunId),
		targetPath: lineagePath(frame),
	};
}

/**
 * Handlers a child-side consumer invokes for each AUTHENTICATED request. Each
 * returns a `{ ok, detail }` to record in the request's `control-result`. A
 * thrown / rejected handler is folded into `{ ok: false }` so a misbehaving
 * handler can never wedge the consumer loop (best-effort, REQ-BUS-4).
 */
export interface ControlConsumerHandlers {
	/** Apply a `steer` request (e.g. inject guidance into the hosted agent). */
	onSteer: (req: ControlRequest) => Promise<{ ok: boolean; detail?: string }> | { ok: boolean; detail?: string };
	/** Apply a `cancel` request (e.g. begin a graceful wind-down). */
	onCancel: (req: ControlRequest) => Promise<{ ok: boolean; detail?: string }> | { ok: boolean; detail?: string };
}

/** The verb + outcome of one consumed request, returned for diagnostics/tests. */
export interface ConsumedControl {
	id: string;
	kind: ControlRequestKind;
	ok: boolean;
	detail?: string;
}

/**
 * ONE child-side consumer step (spec 0005, node C — closes the spec-0004
 * child-side-consumer gap, REQ-ORCH-3): poll the inbox for requests addressed
 * to `frame`, dispatch each AUTHENTICATED request to the matching handler, and
 * write its `control-result`.
 *
 * Auth is NOT bypassed: `pollControlRequests` already verifies each request's
 * cap token against `frame` (`verifyCapToken`, the spec-0003 security property)
 * and only returns — and only lets us act on — requests that authenticate. A
 * request with an invalid token is rejected inside `pollControlRequests` (a
 * `{ ok: false }` result is written there) and never reaches a handler here.
 *
 * The detached `orchestrate` runner calls this on an interval between pipeline
 * steps; it is a pure function of (inbox state, handlers) so a unit test can
 * drive it without a real session.
 *
 * BEST-EFFORT (REQ-BUS-4): a handler that throws is recorded as `{ ok: false }`
 * and the loop continues; the function never throws into the runner.
 */
export async function consumeControlRequests(args: {
	agentDir: string;
	frame: DepthFrame;
	handlers: ControlConsumerHandlers;
	/**
	 * The consumer's OWN per-run control secret (spec 0009, REQ-CTRL-4),
	 * threaded to `pollControlRequests` so a detached foreground steer/cancel
	 * presenting a matching secret authenticates alongside the cap-token path.
	 * Absent for in-process children (cap-token-only).
	 */
	controlSecret?: string;
	now?: number;
}): Promise<ConsumedControl[]> {
	const { agentDir, frame, handlers } = args;
	const requests = pollControlRequests({
		agentDir,
		frame,
		...(args.controlSecret !== undefined ? { controlSecret: args.controlSecret } : {}),
		now: args.now,
	});
	const consumed: ConsumedControl[] = [];
	for (const req of requests) {
		let outcome: { ok: boolean; detail?: string };
		try {
			const handler = req.kind === "cancel" ? handlers.onCancel : handlers.onSteer;
			outcome = await handler(req);
		} catch (err) {
			outcome = {
				ok: false,
				detail: `handler failed: ${(err as Error)?.message ?? err}`,
			};
		}
		writeControlResult({
			agentDir,
			frame,
			id: req.id,
			ok: outcome.ok,
			...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
			now: args.now,
		});
		consumed.push({
			id: req.id,
			kind: req.kind,
			ok: outcome.ok,
			...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
		});
	}
	return consumed;
}
