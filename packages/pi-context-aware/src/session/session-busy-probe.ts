/**
 * Whether a session is waiting on delegated work that will wake it.
 *
 * Automatic task continuation fires when Pi reports the session idle. Pi's idle
 * is narrower than the question being asked: a foreground session that
 * dispatched a background delegate worker is idle in Pi's sense for the whole
 * time that worker runs. In one recorded session the task reminder landed nine
 * seconds after a dispatch, and 13 reminders were sent across 11 dispatches
 * while workers were still running — one of them for a further 13 minutes.
 *
 * That was tolerable while the reminder was a hidden note. Continuation now
 * starts a turn, so the same pattern becomes turns nobody asked for, racing the
 * workers' own completion wakes (#45).
 *
 * `ctx.hasPendingMessages()` does not answer this. It reports queued input to
 * this session, not work this session is waiting on elsewhere.
 *
 * pi-delegate now exposes its in-process answer synchronously over Pi's shared
 * event bus. This module asks that live capability first. During a mixed-version
 * rollout, no response means the producer is old or absent, so the probe falls
 * back to pi-delegate's historical `run-state.json`. A response is authoritative:
 * even `unknown` bypasses the file rather than letting stale history overrule the
 * live producer.
 *
 * Active delegate work is the union of that in-process leg and the detached
 * `orchestrate/active` markers. Markers are byte-capped and identity-checked;
 * PID slots are accepted only when fixed-width and, when copied, equal;
 * liveness is checked with `kill(pid, 0)`. A stale marker is skipped, while an
 * unreadable, torn, placeholder, or otherwise uncertain marker fails closed.
 * This mirrors pi-delegate's
 * `docs/active-delegate-work-contract.md` without importing that package.
 *
 * ## Fail closed
 *
 * The verdict is `busy | idle | unknown`, and **`unknown` must suppress**. The
 * two failure modes are not symmetric:
 *
 * - a wrong `busy` delays a continuation to the next settle;
 * - a wrong `idle` starts an agent turn nobody asked for.
 *
 * So a missing file, a malformed file, an unrecognised schema, or a live run
 * whose owner cannot be established all resolve to `unknown`, and therefore to
 * silence. Reaching `idle` requires positively reading the source and finding
 * nothing running.
 *
 * ## Staleness fallback and manual override
 *
 * Failing closed forever is its own failure. pi-delegate shares one
 * `run-state.json` across every session on the machine, and it leaks live-looking
 * run records when the owning process dies without terminalising them — worse,
 * its dead-owner sweep trusts a bare `owningPid`, so a reused PID keeps an orphan
 * looking alive indefinitely. One such orphan, from a session that exited days
 * ago, would suppress continuation on every current session with open tasks,
 * with no way out but hand-editing the file.
 *
 * Two escape hatches, both scoped so they cannot mask a real running worker of
 * this session:
 *
 * - **Staleness fallback.** An *unattributable* live run stops counting as a
 *   doubt once its freshest timestamp is older than `staleMs`
 *   ({@link DEFAULT_UNATTRIBUTABLE_STALE_MS}, overridable with
 *   `PI_CONTEXT_AWARE_BUSY_STALE_MS`). A run this session owns returns `busy`
 *   before the fallback is ever consulted, so ageing the bound never races our
 *   own work.
 * - **Manual override.** `PI_CONTEXT_AWARE_BUSY_PROBE=off|idle` clears an
 *   unattributable doubt (unwedge now) but still yields `busy` when this session
 *   provably owns a live run, so it never masks own-session work. `=busy` forces
 *   `busy` and short-circuits before any file read (it can never mask own work).
 *
 * ## Deliberately only delegate runs
 *
 * The callbacks store is NOT consulted. A pending callback is a scheduled wake,
 * so it looks like the same question, but its pending jobs include recurring
 * polls with no due time and reminders dated hours ahead. Treating those as
 * busy would suppress continuation indefinitely, which is the silent stall this
 * feature exists to remove. Ordering against a callback that does fire is
 * already Pi's job, through the queued-message and idle checks the caller makes.
 */

import { createHash } from "node:crypto";
import { open, readdir } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** How the caller should treat the session. `unknown` is not `idle`. */
export type BusyVerdict = "busy" | "idle" | "unknown";

export interface BusyProbeResult {
	readonly verdict: BusyVerdict;
	/**
	 * Why, in stable words, for the diagnostic.
	 *
	 * A suppressed continuation that never says why is the kind of silence that
	 * takes an afternoon to explain.
	 */
	readonly reason: string;
}

/** Largest file this probe will read. Beyond it the answer is `unknown`. */
export const MAX_BUSY_PROBE_BYTES = 16 * 1024 * 1024;

const TERMINAL_FORK_STATUSES = new Set(["completed", "failed", "aborted", "paused"]);

/** Unknown status values are future live statuses unless they are terminal. */
function isLiveForkStatus(status: string): boolean {
	return !TERMINAL_FORK_STATUSES.has(status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Manual override for the whole probe, read from the environment.
 *
 * The probe fails closed on doubt, and a shared `run-state.json` poisoned by
 * another session's leaked orphan run turns that doubt into a permanent
 * suppression of this session's continuation (pi-delegate leaks such orphans on
 * a reused owner PID; see the module doc's staleness note). `off`/`idle` clear
 * that unattributable doubt so a poisoned file can never wedge a session, while
 * a run this session provably owns still reads as `busy` (the override is
 * resolved after the own-session check, not before it); `busy` forces the
 * opposite for anyone who would rather never continue automatically while any
 * doubt exists. An unset or unrecognised value keeps the normal fail-closed
 * behaviour.
 */
export type BusyProbeOverride = "idle" | "busy" | undefined;

export function readBusyProbeOverride(env: NodeJS.ProcessEnv = process.env): BusyProbeOverride {
	const raw = env.PI_CONTEXT_AWARE_BUSY_PROBE?.trim().toLowerCase();
	if (raw === "off" || raw === "idle") return "idle";
	if (raw === "busy") return "busy";
	return undefined;
}

/**
 * How stale an *unattributable* live run must be before it stops forcing
 * `unknown`.
 *
 * This bound is only ever consulted for a run this probe cannot attribute to
 * any session — the exact doubt that otherwise suppresses forever. A run
 * positively owned by this session is `busy` regardless of age, so raising the
 * bound never races a real worker of ours.
 *
 * The pre-establishment window is generous: pi-delegate's own construction
 * deadline defaults to 600s, and a real worker that has begun emitting sets
 * `startedAt`/`lastActivityAt`, which move it out of the pre-establishment
 * class entirely. The running window covers a fork that reached `running` but
 * whose owning process then died without terminalising it; without any activity
 * signal for this long it is treated as a leaked orphan rather than live work.
 */
export const DEFAULT_UNATTRIBUTABLE_STALE_MS = 60 * 60 * 1000;

export function unattributableStaleMs(
	env: NodeJS.ProcessEnv = process.env,
	configDefault: number = DEFAULT_UNATTRIBUTABLE_STALE_MS,
): number {
	// A durable config value overrides the built-in default; the environment
	// variable overrides both, so a one-off tweak never needs a config edit.
	const fallback = Number.isFinite(configDefault) && configDefault > 0 ? configDefault : DEFAULT_UNATTRIBUTABLE_STALE_MS;
	const raw = env.PI_CONTEXT_AWARE_BUSY_STALE_MS?.trim();
	if (raw === undefined || raw === "") return fallback;
	const parsed = Number(raw);
	// A non-positive or non-finite value would disable the fallback silently;
	// keep the resolved fallback rather than trusting garbage.
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** The most recent activity signal a fork carries, in ms epoch, if any. */
function forkActivityAt(fork: Record<string, unknown>): number | undefined {
	let latest: number | undefined;
	for (const key of ["lastActivityAt", "startedAtMs", "startedAt"]) {
		const value = fork[key];
		if (typeof value === "number" && Number.isFinite(value)) {
			latest = latest === undefined ? value : Math.max(latest, value);
		}
	}
	return latest;
}

/**
 * Whether an unattributable live run is old enough to treat as a leaked orphan
 * rather than live work this session might own.
 *
 * The clock is the freshest evidence the run carries: a fork's own activity
 * timestamp when present, else the run's `createdAt`. A run missing every
 * timestamp cannot be aged out — it stays a doubt and keeps suppressing.
 */
function unattributableRunIsStale(
	run: Record<string, unknown>,
	forks: Record<string, unknown>[],
	now: number,
	staleMs: number,
): boolean {
	let freshest: number | undefined;
	for (const fork of forks) {
		if (!isLiveForkStatus(fork.status as string)) continue;
		const activity = forkActivityAt(fork);
		if (activity !== undefined) freshest = freshest === undefined ? activity : Math.max(freshest, activity);
	}
	if (freshest === undefined) {
		const createdAt = run.createdAt;
		if (typeof createdAt === "number" && Number.isFinite(createdAt)) freshest = createdAt;
	}
	if (freshest === undefined) return false;
	return now - freshest >= staleMs;
}


type ForkReading =
	| { readonly forks: Record<string, unknown>[] }
	| { readonly reason: string };

function readRecognisableForks(run: Record<string, unknown>): ForkReading {
	if (!isRecord(run.forks)) return { reason: "delegate run-state has a live run with no recognisable worker-session records" };
	const forks = Object.values(run.forks);
	if (!forks.every((fork): fork is Record<string, unknown> => isRecord(fork) && typeof fork.status === "string")) {
		return { reason: "delegate run-state has an unrecognisable worker-session record" };
	}
	return { forks };
}

type RecognisableRun = {
	readonly run: Record<string, unknown>;
	readonly forks: Record<string, unknown>[];
};

function readRecognisableRun(run: unknown): RecognisableRun | { readonly reason: string } {
	if (!isRecord(run)) return { reason: "delegate run-state has an unrecognisable run" };
	if (typeof run.runId !== "string" || run.runId.length === 0) {
		return { reason: "delegate run-state has a run with no recognisable runId" };
	}
	if ("rootRunId" in run && run.rootRunId !== undefined && typeof run.rootRunId !== "string") {
		return { reason: "delegate run-state has a run with an unrecognisable rootRunId" };
	}
	if ("ownerSessionId" in run && run.ownerSessionId !== undefined && typeof run.ownerSessionId !== "string") {
		return { reason: "delegate run-state has a run with an unrecognisable ownerSessionId" };
	}
	if (
		"completedAt" in run &&
		run.completedAt !== undefined &&
		run.completedAt !== null &&
		(typeof run.completedAt !== "number" || !Number.isFinite(run.completedAt))
	) {
		return { reason: "delegate run-state has a run with an unrecognisable completedAt" };
	}
	const forks = readRecognisableForks(run);
	return "forks" in forks ? { run, forks: forks.forks } : forks;
}

/** Where pi writes extension state, matching `session-tasks-runtime.ts`. */
export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_CODING_AGENT_DIR ?? path.join(env.HOME ?? os.homedir(), ".pi", "agent");
}

type SourceReading =
	| { readonly kind: "busy"; readonly reason: string }
	| { readonly kind: "clear" }
	| { readonly kind: "unknown"; readonly reason: string };

/** The only event-bus capability the busy probe needs. */
interface BusyProbeEventBus {
	emit(channel: string, data: unknown): void;
}

const DELEGATE_SESSION_ACTIVE_WORK_QUERY_EVENT = "pi-delegate:session-active-work-query:v1";

type LiveDelegateReading = SourceReading | { readonly kind: "absent" };

/** Ask an in-process pi-delegate producer for its authoritative live state. */
function readLiveDelegateWork(events: BusyProbeEventBus | undefined, sessionId: string): LiveDelegateReading {
	if (events === undefined) return { kind: "absent" };
	const request: {
		version: 1;
		ownerSessionId: string;
		response?: unknown;
	} = { version: 1, ownerSessionId: sessionId };
	try {
		events.emit(DELEGATE_SESSION_ACTIVE_WORK_QUERY_EVENT, request);
	} catch {
		return { kind: "unknown", reason: "live delegate active-work query threw" };
	}
	if (!Object.prototype.hasOwnProperty.call(request, "response")) return { kind: "absent" };
	const response = request.response;
	if (
		!isRecord(response) ||
		response.version !== 1 ||
		(response.status !== "busy" && response.status !== "idle" && response.status !== "unknown")
	) {
		return { kind: "unknown", reason: "live delegate active-work query returned a malformed response" };
	}
	if (response.status === "busy") {
		return { kind: "busy", reason: "live delegate capability reports work for this session is still running" };
	}
	if (response.status === "unknown") {
		return { kind: "unknown", reason: "live delegate capability cannot determine whether this session has active work" };
	}
	return { kind: "clear" };
}

type JsonFileReading =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: true; readonly missing: true }
	| { readonly ok: false; readonly reason: string };

const MAX_ORCHESTRATE_MARKER_BYTES = 4096;
/** Marker filenames follow pi-delegate's path-safe id contract; run-state ids remain tolerant. */
const SAFE_ORCHESTRATE_RUN_ID_RE = /^[\w-]{1,128}$/u;

async function readJsonFile(
	file: string,
	maxBytes = MAX_BUSY_PROBE_BYTES,
): Promise<JsonFileReading> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(file, "r");
		const buffer = Buffer.alloc(maxBytes + 1);
		let bytesRead = 0;
		while (bytesRead < buffer.length) {
			const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
			if (result.bytesRead === 0) break;
			bytesRead += result.bytesRead;
		}
		if (bytesRead > maxBytes) return { ok: false, reason: "larger than the probe's byte cap" };
		const text = buffer.subarray(0, bytesRead).toString("utf8");
		try {
			return { ok: true, value: JSON.parse(text) };
		} catch {
			// A concurrent writer can be caught mid-write. Never guess `idle` from a
			// half-written file.
			return { ok: false, reason: "malformed json" };
		}
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		// A file that was never written is a real answer: that package has recorded
		// no work. Any other read failure is genuinely unknown.
		if (code === "ENOENT") return { ok: true, missing: true };
		return { ok: false, reason: `unreadable (${code ?? "error"})` };
	} finally {
		if (handle !== undefined) await handle.close();
	}
}

/**
 * Running delegate work owned by this session.
 *
 * A run is live when `completedAt` is absent or null and at least one fork has a
 * canonical live status (`pending`, `constructing`, `running`, or
 * `awaiting-escalation`). Unknown future statuses are also treated as live;
 * canonical terminal statuses are the only statuses that settle a fork.
 * Ownership matters: another session's worker must not silence this session's
 * continuation.
 *
 * `ownerSessionId` is absent on some shapes, detached and chain runs among them.
 * Such a live child can be attributed through its `rootRunId` when the root entry
 * carries an owner. An unattributable live run is exactly the doubt this probe
 * fails closed on, because it may belong to this session.
 *
 * An unattributable live run that is old enough is treated as a leaked orphan
 * rather than a doubt: pi-delegate leaves such records on `run-state.json` when
 * the owning process dies without terminalising them, and (because that file is
 * shared across every session on the machine) one dead session's orphan would
 * otherwise suppress every session's continuation forever. `staleMs` bounds that
 * window; it is only ever applied to a run this probe cannot attribute, so an
 * owned run is `busy` regardless of age.
 *
 * @param raw Parsed run-state. A missing file is handled by the caller; JSON null
 * is malformed state and therefore remains unknown.
 * @param sessionId The pi session id to attribute runs to.
 * @param options `now`/`staleMs` control the orphan-staleness fallback. The
 * defaults age an unattributable run out after {@link DEFAULT_UNATTRIBUTABLE_STALE_MS};
 * a run carrying no timestamp cannot be aged out and keeps suppressing.
 */
export function readDelegateRunState(
	raw: unknown,
	sessionId: string,
	options: { readonly now?: number; readonly staleMs?: number } = {},
): SourceReading {
	const now = options.now ?? Date.now();
	const staleMs = options.staleMs ?? DEFAULT_UNATTRIBUTABLE_STALE_MS;
	if (raw === null) return { kind: "unknown", reason: "delegate run-state is null" };
	if (!isRecord(raw) || !Array.isArray(raw.runs)) {
		return { kind: "unknown", reason: "delegate run-state has no recognisable runs[]" };
	}
	const ownersByRootRunId = new Map<string, string | undefined>();
	const invalidRootRunIds = new Set<string>();
	let uncertainty: string | undefined;
	const validRuns: RecognisableRun[] = [];
	for (const rawRun of raw.runs) {
		const reading = readRecognisableRun(rawRun);
		if (!("run" in reading)) {
			uncertainty ??= reading.reason;
			if (isRecord(rawRun) && typeof rawRun.runId === "string") invalidRootRunIds.add(rawRun.runId);
			continue;
		}
		validRuns.push(reading);
		const run = reading.run;
		const runId = run.runId as string;
		const rootRunId = run.rootRunId;
		const isRootRecord = rootRunId === undefined || rootRunId === runId;
		if (!isRootRecord) {
			invalidRootRunIds.add(runId);
			ownersByRootRunId.delete(runId);
			continue;
		}
		if (invalidRootRunIds.has(runId)) continue;
		if (ownersByRootRunId.has(runId)) {
			// Duplicate root ids are not an ownership proof. The records may come
			// from different writers, so even equal owners are ambiguous.
			ownersByRootRunId.delete(runId);
			invalidRootRunIds.add(runId);
			continue;
		}
		const owner = run.ownerSessionId as string | undefined;
		// An empty owner string is structurally valid input but cannot establish
		// trustworthy root ownership.
		ownersByRootRunId.set(runId, owner === "" ? undefined : owner);
	}
	let unattributableLive = 0;
	// An unattributable live run is a doubt only while it is plausibly still
	// running. Past the staleness bound it is a leaked orphan (a dead owner that
	// never terminalised it) and no longer suppresses. Owned runs never reach
	// here — they return `busy` above regardless of age.
	const countUnattributable = (run: Record<string, unknown>, forks: Record<string, unknown>[]): void => {
		if (!unattributableRunIsStale(run, forks, now, staleMs)) unattributableLive += 1;
	};
	for (const { run, forks } of validRuns) {
		if (run.completedAt !== undefined && run.completedAt !== null) continue;
		if (!forks.some((fork) => isLiveForkStatus(fork.status as string))) continue;
		const owner = run.ownerSessionId as string | undefined;
		if (owner === sessionId) {
			return { kind: "busy", reason: "a delegate run dispatched by this session is still running" };
		}
		if (owner !== undefined) continue;
		const rootRunId = typeof run.rootRunId === "string" ? run.rootRunId : undefined;
		if (rootRunId !== undefined) {
			if (invalidRootRunIds.has(rootRunId)) {
				countUnattributable(run, forks);
				continue;
			}
			const rootOwner = ownersByRootRunId.get(rootRunId);
			if (rootOwner === sessionId) {
				return { kind: "busy", reason: "a worker session without a direct owner belongs to this session's root run" };
			}
			if (rootOwner !== undefined) continue;
		}
		countUnattributable(run, forks);
	}
	if (unattributableLive > 0) {
		return {
			kind: "unknown",
			reason: `${unattributableLive} running delegate run(s) carry no ownerSessionId, so they cannot be ruled out`,
		};
	}
	if (uncertainty !== undefined) return { kind: "unknown", reason: uncertainty };
	return { kind: "clear" };
}

function readPidSlot(value: unknown): number | undefined {
	if (typeof value !== "string" || !/^\d{10}$/u.test(value)) return undefined;
	const pid = Number(value);
	return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function orchestrateOwnerKey(sessionId: string): string {
	return createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
}

/** Read this session's detached orchestrate markers, failing closed on doubt. */
async function readOrchestrateMarkers(agentDir: string, sessionId: string): Promise<SourceReading> {
	const ownerDir = path.join(
		agentDir,
		"extensions",
		"pi-delegate",
		"orchestrate",
		"active",
		orchestrateOwnerKey(sessionId),
	);
	let names: string[];
	try {
		names = await readdir(ownerDir);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { kind: "clear" };
		return { kind: "unknown", reason: `orchestrate active directory: unreadable (${code ?? "error"})` };
	}
	let uncertainty: string | undefined;
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const runId = name.slice(0, -".json".length);
		if (!SAFE_ORCHESTRATE_RUN_ID_RE.test(runId)) {
			uncertainty ??= `orchestrate marker ${name}: unsafe runId`;
			continue;
		}
		const read = await readJsonFile(path.join(ownerDir, name), MAX_ORCHESTRATE_MARKER_BYTES);
		if (!read.ok) {
			uncertainty ??= `orchestrate marker ${name}: ${read.reason}`;
			continue;
		}
		if ("missing" in read) continue;
		if (read.value === null || !isRecord(read.value)) {
			uncertainty ??= `orchestrate marker ${name}: unreadable shape`;
			continue;
		}
		if (read.value.runId !== runId || read.value.ownerSessionId !== sessionId) {
			uncertainty ??= `orchestrate marker ${name}: identity mismatch`;
			continue;
		}
		const parentPid = readPidSlot(read.value.parentPid);
		const parentPidCopy = readPidSlot(read.value.parentPidCopy);
		if (parentPid === undefined || parentPidCopy === undefined || parentPid !== parentPidCopy) {
			uncertainty ??= `orchestrate marker ${name}: torn parentPid slots`;
			continue;
		}
		const runnerPid = readPidSlot(read.value.runnerPid);
		if (runnerPid === undefined) {
			uncertainty ??= `orchestrate marker ${name}: invalid runnerPid`;
			continue;
		}
		if (read.value.runnerPidCopy !== undefined) {
			const runnerPidCopy = readPidSlot(read.value.runnerPidCopy);
			if (runnerPidCopy === undefined || runnerPid !== runnerPidCopy) {
				uncertainty ??= `orchestrate marker ${name}: torn runnerPid slots`;
				continue;
			}
		}
		if (pidAlive(runnerPid)) {
			return { kind: "busy", reason: "a detached orchestrate runner for this session is still alive" };
		}
	}
	return uncertainty === undefined ? { kind: "clear" } : { kind: "unknown", reason: uncertainty };
}

/**
 * Ask whether this session is waiting on delegated work.
 *
 * Read fresh every time rather than cached: the answer wanted is the state at
 * the moment this session settled.
 *
 * @param sessionId The pi session id, from `ctx.sessionManager.getSessionId()`.
 * @param env Environment to resolve the agent directory from.
 * @param config Durable config-layer defaults for the override and staleness
 * bound. The environment wins over both, so a poisoned-file escape hatch is
 * always reachable without editing config.
 * @param events Pi's shared event bus. A live response bypasses historical
 * run-state; no response preserves the legacy file fallback.
 */
export async function probeSessionBusy(
	sessionId: string,
	env: NodeJS.ProcessEnv = process.env,
	config: { readonly override?: BusyProbeOverride; readonly staleMs?: number } = {},
	events?: BusyProbeEventBus,
): Promise<BusyProbeResult> {
	// `busy` is maximally conservative — it never masks own-session work — so it
	// can answer without reading anything and short-circuits every file read.
	const override = readBusyProbeOverride(env) ?? config.override;
	if (override === "busy") return { verdict: "busy", reason: "busy probe overridden to busy (PI_CONTEXT_AWARE_BUSY_PROBE)" };
	// The `idle` override exists to clear an unattributable doubt from a poisoned
	// run-state.json, NOT to mask a worker this session provably owns. So it does
	// not short-circuit: the sources are still read below, a provably-own `busy`
	// still wins, and only the remaining doubt collapses to idle. Reading is a
	// cheap, lock-free file open, so it cannot reintroduce the contention the
	// override escapes.
	// Without an identity nothing can be attributed. Under an idle override that
	// is simply idle — there is no own-session work to protect — otherwise it is
	// the usual doubt.
	if (!sessionId) {
		return override === "idle"
			? { verdict: "idle", reason: "busy probe overridden to idle (PI_CONTEXT_AWARE_BUSY_PROBE)" }
			: { verdict: "unknown", reason: "this session has no id to attribute work to" };
	}
	// The environment override wins over config; the staleness bound reads env
	// first (an explicit number) then the durable config default.
	const staleMs = unattributableStaleMs(env, config.staleMs);
	const agentDir = resolveAgentDir(env);
	const liveReading = readLiveDelegateWork(events, sessionId);
	let delegateReading: SourceReading;
	if (liveReading.kind !== "absent") {
		delegateReading = liveReading;
	} else {
		const file = path.join(agentDir, "extensions", "pi-delegate", "run-state.json");
		const read = await readJsonFile(file);
		if (!read.ok) {
			delegateReading = { kind: "unknown", reason: `run-state.json: ${read.reason}` };
		} else if ("missing" in read) {
			delegateReading = { kind: "clear" };
		} else {
			try {
				delegateReading = readDelegateRunState(read.value, sessionId, { staleMs });
			} catch {
				// A parser that throws has met a shape it does not understand. That is a
				// doubt, never a clear.
				delegateReading = { kind: "unknown", reason: "run-state.json: unreadable shape" };
			}
		}
	}
	let orchestrateReading: SourceReading;
	try {
		orchestrateReading = await readOrchestrateMarkers(agentDir, sessionId);
	} catch {
		// A filesystem/parser surprise is a doubt, never a clear.
		orchestrateReading = { kind: "unknown", reason: "orchestrate active markers: unreadable shape" };
	}
	if (delegateReading.kind === "busy") return { verdict: "busy", reason: delegateReading.reason };
	if (orchestrateReading.kind === "busy") return { verdict: "busy", reason: orchestrateReading.reason };
	// A provably-own `busy` has already returned above, so any remaining doubt is
	// unattributable. The idle override is exactly the instruction to treat that
	// residual doubt as idle rather than suppress on it.
	if (override === "idle") return { verdict: "idle", reason: "busy probe overridden to idle (PI_CONTEXT_AWARE_BUSY_PROBE)" };
	if (delegateReading.kind === "unknown") return { verdict: "unknown", reason: delegateReading.reason };
	if (orchestrateReading.kind === "unknown") return { verdict: "unknown", reason: orchestrateReading.reason };
	return { verdict: "idle", reason: "no delegate run or detached orchestrate work is running" };
}
