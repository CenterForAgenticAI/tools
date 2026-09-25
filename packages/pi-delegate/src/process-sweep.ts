/**
 * ps-tree sweep backstop for run cancellation.
 *
 * `refs.worker?.abort()` → pi-coding-agent's bash tool → `killProcessTree(pid)`
 * (`process.kill(-pid, "SIGKILL")`) normally cleans up the worker's in-flight
 * bash child tree. This module is the *backstop* that runs after a short grace
 * period to catch edge cases where that propagation didn't land:
 *   - worker session hadn't finished booting when cancel fired
 *   - worker bash spawned a grandchild that escaped the pgid
 *   - some other run-side propagation gap we haven't diagnosed yet
 *
 * We enumerate descendants of our own pid via `ps -eo pid,ppid,lstart,command`,
 * filter to processes that started AFTER the run began, and SIGTERM the
 * process group (negative pid); anything still alive after `graceMs` gets
 * SIGKILLed. Unix only — Windows returns empty / no-ops.
 */

import { execSync } from "node:child_process";
import { uptime as systemUptimeSeconds } from "node:os";
import {
	captureProcessIdentity,
	isValidProcessBootId,
	readProcessStartTicks,
	verifyProcessIdentity,
	type ProcessIdentityDependencies,
	type ProcessIdentityEvidence,
	type ProcessIdentityVerdict,
} from "./process-identity.js";

export interface SweepCandidate {
	pid: number;
	ppid: number;
	startedAtMs: number;
	command: string;
	/** Linux process-generation snapshot captured at enumeration time. */
	identity?: ProcessIdentityEvidence;
}

export interface SweepResult {
	terminated: number[];
	killed: number[];
	missed: number[];
}

type ExecSyncImpl = (cmd: string, opts: { encoding: "utf-8" }) => string;
type CaptureIdentityImpl = (
	pid: number,
	overrides?: Partial<ProcessIdentityDependencies>,
) => ProcessIdentityEvidence | undefined;
type ReadStartTicksImpl = (
	pid: number,
	overrides?: Partial<ProcessIdentityDependencies>,
) => string | undefined;
type VerifyIdentityImpl = (
	evidence: Partial<ProcessIdentityEvidence> | undefined,
	overrides?: Partial<ProcessIdentityDependencies>,
) => ProcessIdentityVerdict;
type KillImpl = (pid: number, signal: NodeJS.Signals | number) => void;

export interface EnumerateRunDescendantsOptions {
	execSyncImpl?: ExecSyncImpl;
	captureProcessIdentityImpl?: CaptureIdentityImpl;
	readProcessStartTicksImpl?: ReadStartTicksImpl;
	identityDependencies?: Partial<ProcessIdentityDependencies>;
	/** Optional direct Linux run-start identity for same-second descendant disambiguation. */
	runStartedIdentity?: Pick<ProcessIdentityEvidence, "startTicks" | "bootId">;
	/** Optional direct run-start tick threshold when caller already has one. */
	runStartedAtTicks?: string;
	/** Test seam for deterministic run-start tick estimation. */
	nowMsImpl?: () => number;
	/** Test seam for deterministic run-start tick estimation. */
	systemUptimeMsImpl?: () => number;
	/** Test seam for deterministic run-start tick estimation. */
	processUptimeMsImpl?: () => number;
}

export interface SweepKillOptions {
	killImpl?: KillImpl;
	verifyProcessIdentityImpl?: VerifyIdentityImpl;
	identityDependencies?: Partial<ProcessIdentityDependencies>;
	/** Test seam to avoid real timers. */
	delayImpl?: (ms: number) => Promise<void>;
}

interface RunBoundaryIdentity {
	bootId: string;
	startTicks: number;
}

function parseTickCount(value: string | undefined): number | undefined {
	if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function estimateRunStartedTicks(
	runStartedAtMs: number,
	opts: EnumerateRunDescendantsOptions | undefined,
): number | undefined {
	if (!Number.isFinite(runStartedAtMs)) return undefined;
	const readStartTicks = opts?.readProcessStartTicksImpl ?? readProcessStartTicks;
	const selfStartTicks = parseTickCount(readStartTicks(process.pid, opts?.identityDependencies));
	if (selfStartTicks === undefined) return undefined;

	const nowMs = opts?.nowMsImpl?.() ?? Date.now();
	const systemUptimeMs = opts?.systemUptimeMsImpl?.() ?? systemUptimeSeconds() * 1000;
	const processUptimeMs = opts?.processUptimeMsImpl?.() ?? process.uptime() * 1000;
	if (!Number.isFinite(nowMs) || !Number.isFinite(systemUptimeMs) || !Number.isFinite(processUptimeMs)) {
		return undefined;
	}
	const processStartSinceBootMs = systemUptimeMs - processUptimeMs;
	if (!(processStartSinceBootMs > 0)) return undefined;

	const ticksPerMs = selfStartTicks / processStartSinceBootMs;
	if (!Number.isFinite(ticksPerMs) || ticksPerMs <= 0) return undefined;

	const runAgeMs = nowMs - runStartedAtMs;
	if (!Number.isFinite(runAgeMs) || runAgeMs < 0 || runAgeMs > systemUptimeMs) return undefined;

	const runStartedSinceBootMs = systemUptimeMs - runAgeMs;
	if (runStartedSinceBootMs < 0) return undefined;
	return runStartedSinceBootMs * ticksPerMs;
}

function resolveRunBoundaryIdentity(
	ourPid: number,
	runStartedAtMs: number,
	opts: EnumerateRunDescendantsOptions | undefined,
): RunBoundaryIdentity | undefined {
	const candidate = opts?.runStartedIdentity;
	const explicitTicks = parseTickCount(candidate?.startTicks);
	if (explicitTicks !== undefined && isValidProcessBootId(candidate?.bootId)) {
		return { bootId: candidate.bootId, startTicks: explicitTicks };
	}

	const captureIdentity = opts?.captureProcessIdentityImpl ?? captureProcessIdentity;
	const processIdentity = captureIdentity(ourPid, opts?.identityDependencies);
	if (!processIdentity) return undefined;

	const suppliedThreshold = parseTickCount(opts?.runStartedAtTicks);
	if (suppliedThreshold !== undefined) {
		return { bootId: processIdentity.bootId, startTicks: suppliedThreshold };
	}

	const estimated = estimateRunStartedTicks(runStartedAtMs, opts);
	return estimated === undefined ? undefined : { bootId: processIdentity.bootId, startTicks: estimated };
}

function shouldIncludeSameSecondCandidate(
	candidate: SweepCandidate,
	runStartedAtMs: number,
	candidateIdentity: ProcessIdentityEvidence | undefined,
	runBoundary: RunBoundaryIdentity | undefined,
): boolean {
	if (!runBoundary || !candidateIdentity) return false;
	const runStartedAtWholeSecond = Math.floor(runStartedAtMs / 1000) * 1000;
	if (!Number.isFinite(runStartedAtWholeSecond)) return false;
	if (candidate.startedAtMs !== runStartedAtWholeSecond) return false;
	if (candidateIdentity.bootId !== runBoundary.bootId) return false;
	const candidateStartTicks = parseTickCount(candidateIdentity.startTicks);
	if (candidateStartTicks === undefined) return false;
	return candidateStartTicks > runBoundary.startTicks;
}

/**
 * Enumerate descendants of `ourPid` that started at or after
 * `runStartedAtMs`. Returns [] on Windows (no `ps`) and on any parse
 * failure — sweep is a best-effort backstop, never the thing that decides
 * whether a run ran.
 *
 * Exported for unit testing with a mock `execSync`.
 */
export function enumerateRunDescendants(
	ourPid: number,
	runStartedAtMs: number,
	opts?: EnumerateRunDescendantsOptions,
): SweepCandidate[] {
	if (process.platform === "win32") return [];
	const impl = opts?.execSyncImpl ?? ((cmd, o) => execSync(cmd, o).toString());
	let raw: string;
	try {
		raw = impl("ps -eo pid,ppid,lstart,command", { encoding: "utf-8" });
	} catch {
		return [];
	}
	const all = parsePsOutput(raw);
	const runBoundary = resolveRunBoundaryIdentity(ourPid, runStartedAtMs, opts);
	const captureIdentity = opts?.captureProcessIdentityImpl ?? captureProcessIdentity;

	// Build ppid → children map.
	const children = new Map<number, SweepCandidate[]>();
	for (const row of all) {
		const list = children.get(row.ppid) ?? [];
		list.push(row);
		children.set(row.ppid, list);
	}
	// BFS from ourPid, collecting descendants (exclude ourPid itself).
	const out: SweepCandidate[] = [];
	const visited = new Set<number>([ourPid]);
	const queue: number[] = [ourPid];
	while (queue.length > 0) {
		const cur = queue.shift()!;
		const kids = children.get(cur) ?? [];
		for (const kid of kids) {
			if (visited.has(kid.pid)) continue;
			visited.add(kid.pid);
			queue.push(kid.pid);
			const identity = captureIdentity(kid.pid, opts?.identityDependencies);
			// SAFETY CONTRACT (issue #8 nit — do not "simplify" this comparison):
			// only descendants that started STRICTLY AFTER the run are sweep
			// candidates. This strict `>` is also the NaN exclusion — if either
			// side is NaN (unparseable lstart upstream, or a caller passing a
			// bogus runStartedAtMs) the comparison is FALSE and the process is
			// NOT killed. That fail-closed behavior is what prevents pid-reuse /
			// clock-skew false-positive kills of unrelated user processes.
			if (
				kid.startedAtMs > runStartedAtMs ||
				shouldIncludeSameSecondCandidate(kid, runStartedAtMs, identity, runBoundary)
			) {
				out.push(identity === undefined ? kid : { ...kid, identity });
			}
		}
	}
	return out;
}

/**
 * Parse `ps -eo pid,ppid,lstart,command` output. `lstart` is a fixed-width
 * date like `Wed Apr 23 12:34:56 2026` that `Date.parse` handles natively on
 * both macOS and Linux. Rows with unparseable dates are dropped.
 *
 * Exported for direct unit testing with fixture strings.
 */
export function parsePsOutput(raw: string): SweepCandidate[] {
	const out: SweepCandidate[] = [];
	const lines = raw.split("\n");
	// Skip header row (first non-empty line starts with "PID" or "  PID").
	let started = false;
	for (const line of lines) {
		if (!line.trim()) continue;
		if (!started) {
			started = true;
			if (/^\s*PID\b/.test(line)) continue;
		}
		// pid ppid <24-char lstart> command
		// Example: "62767   62766 Wed Apr 23 12:34:56 2026 sleep 3600"
		const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/);
		if (!m) continue;
		const pid = Number(m[1]);
		const ppid = Number(m[2]);
		const lstart = m[3]!;
		const command = m[4] ?? "";
		const startedAtMs = Date.parse(lstart);
		if (Number.isNaN(startedAtMs)) continue;
		out.push({ pid, ppid, startedAtMs, command });
	}
	return out;
}

function identityStillMatches(
	candidate: SweepCandidate,
	verifyIdentity: VerifyIdentityImpl,
	identityDependencies: Partial<ProcessIdentityDependencies> | undefined,
): boolean {
	return verifyIdentity(candidate.identity, identityDependencies) === "match";
}

/**
 * SIGTERM each candidate's process group, wait `graceMs`, then SIGKILL any
 * still alive. Never throws; ESRCH is expected for already-dead pids.
 *
 * Returns which pids got each signal and which we saw alive after the grace
 * window (so callers / tests can see the shape of what happened).
 */
export async function sweepKill(
	candidates: SweepCandidate[],
	graceMs: number = 3000,
	opts?: SweepKillOptions,
): Promise<SweepResult> {
	if (process.platform === "win32") return { terminated: [], killed: [], missed: [] };
	if (candidates.length === 0) return { terminated: [], killed: [], missed: [] };

	const kill = opts?.killImpl ?? ((pid, sig) => process.kill(pid, sig));
	const verifyIdentity = opts?.verifyProcessIdentityImpl ?? verifyProcessIdentity;
	const identityDependencies = opts?.identityDependencies;
	const delay = opts?.delayImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

	const terminated: number[] = [];
	for (const c of candidates) {
		if (!identityStillMatches(c, verifyIdentity, identityDependencies)) continue;
		try {
			kill(-c.pid, "SIGTERM");
			terminated.push(c.pid);
		} catch {
			/* ESRCH — already dead, or not a pgid leader. Try direct. */
			if (!identityStillMatches(c, verifyIdentity, identityDependencies)) continue;
			try {
				kill(c.pid, "SIGTERM");
				terminated.push(c.pid);
			} catch {
				/* gone */
			}
		}
	}

	await delay(Math.max(0, graceMs));

	const killed: number[] = [];
	const missed: number[] = [];
	for (const c of candidates) {
		if (!identityStillMatches(c, verifyIdentity, identityDependencies)) continue;
		const alive = (() => {
			try {
				kill(c.pid, 0);
				return true;
			} catch {
				return false;
			}
		})();
		if (!alive) continue;
		if (!identityStillMatches(c, verifyIdentity, identityDependencies)) continue;
		try {
			kill(-c.pid, "SIGKILL");
			killed.push(c.pid);
		} catch {
			if (!identityStillMatches(c, verifyIdentity, identityDependencies)) continue;
			try {
				kill(c.pid, "SIGKILL");
				killed.push(c.pid);
			} catch {
				missed.push(c.pid);
			}
		}
	}
	return { terminated, killed, missed };
}

/** @deprecated Use {@link enumerateRunDescendants}; retained for compatibility. */
export const enumerateForkDescendants = enumerateRunDescendants;
