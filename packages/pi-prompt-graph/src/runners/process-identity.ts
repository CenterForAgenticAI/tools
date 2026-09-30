import { readFile } from "node:fs/promises";

/**
 * Proving that a process id still names the process that was recorded.
 *
 * A process id on its own is **not** evidence. The operating system reuses
 * them, so a number written to the journal before a crash may, by the time a
 * resume reads it, belong to an unrelated program. Acting on it then kills
 * something that was never ours.
 *
 * This is the same trap D-056 met for run ownership, where a boot-unique token
 * was added because "a process id alone is not evidence of liveness, because
 * the operating system reuses process ids". The evidence here is the process's
 * **start time**, which is fixed for the life of a process and cannot be
 * inherited by a recycled id.
 *
 * The rule this module exists to enforce: **unproven means leave it alone.**
 * Where identity cannot be established, the caller must not kill.
 */

/** What the journal records so a later runner can recognise the same process. */
export interface ProcessIdentity {
	/** The child's process id, which is also its process-group id when spawned detached. */
	readonly pid: number;
	/**
	 * The kernel's start time for that process, in clock ticks since boot
	 * (`/proc/<pid>/stat` field 22). Absent where it could not be read, which
	 * makes the identity unprovable rather than merely unknown.
	 */
	readonly startTicks?: number;
}

export type IdentityVerdict =
	/** The process exists and is provably the one recorded. Safe to signal. */
	| { readonly state: "same-process"; readonly pid: number }
	/** Nothing with that id is running. Nothing to do. */
	| { readonly state: "gone" }
	/** Something is running under that id and it is provably NOT ours. MUST NOT be signalled. */
	| { readonly state: "recycled"; readonly detail: string }
	/** Identity could not be established either way. MUST NOT be signalled. */
	| { readonly state: "unproven"; readonly detail: string };

/**
 * Read a process's start time from `/proc/<pid>/stat`.
 *
 * Field 22 (1-based) is `starttime`. It is parsed from after the final `)`
 * because field 2 is the executable name in parentheses and may itself contain
 * spaces or brackets — splitting the whole line on whitespace is the classic
 * way to read the wrong field.
 *
 * Returns `undefined` on any platform without procfs, and on any read failure.
 * A caller MUST treat that as unprovable rather than as a match.
 */
export async function readStartTicks(pid: number): Promise<number | undefined> {
	try {
		const stat = await readFile(`/proc/${pid}/stat`, "utf8");
		const afterName = stat.slice(stat.lastIndexOf(")") + 2);
		// After the name, field 3 is `state`, so `starttime` (field 22) is the
		// 20th entry of this remainder.
		const ticks = Number(afterName.split(" ")[19]);
		return Number.isFinite(ticks) ? ticks : undefined;
	} catch {
		return undefined;
	}
}

/** Capture what is needed to recognise this process later. */
export async function captureIdentity(pid: number): Promise<ProcessIdentity> {
	const startTicks = await readStartTicks(pid);
	return { pid, ...(startTicks === undefined ? {} : { startTicks }) };
}

/**
 * Decide whether the process running under a recorded id is the recorded one.
 *
 * Only `same-process` permits a signal. Both `recycled` and `unproven` forbid
 * it, and they are kept distinct because they mean different things to a person
 * reading the journal: one is a positive finding that the id was reused, the
 * other is an absence of evidence.
 */
export async function verifyIdentity(identity: ProcessIdentity): Promise<IdentityVerdict> {
	if (!Number.isInteger(identity.pid) || identity.pid <= 0) return { state: "unproven", detail: `${identity.pid} is not a process id.` };
	if (!alive(identity.pid)) return { state: "gone" };

	// Recorded without a start time, so there is nothing to compare against. The
	// process may well be ours; "may well be" is not the standard for killing.
	if (identity.startTicks === undefined) return { state: "unproven", detail: `No start time was recorded for pid ${identity.pid}, so it cannot be told apart from a reused id.` };

	const current = await readStartTicks(identity.pid);
	if (current === undefined) return { state: "unproven", detail: `The start time for pid ${identity.pid} could not be read; this platform may not expose /proc.` };
	if (current !== identity.startTicks) return { state: "recycled", detail: `Pid ${identity.pid} now belongs to a process started later (${current} against the recorded ${identity.startTicks}); it is not this run's.` };
	return { state: "same-process", pid: identity.pid };
}

/** Whether any process holds this id. `EPERM` means it exists and is not ours to signal. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export interface ReapOutcome {
	readonly reaped: boolean;
	readonly verdict: IdentityVerdict;
}

/**
 * Kill a recorded process group, but only once it is proven to be the recorded
 * one.
 *
 * The negative pid targets the **group**, so a command that spawned its own
 * children does not leave them behind — which is the half a group kill exists
 * to cover. A process spawned `detached` is its own group leader, so its pid
 * and its group id are the same number.
 */
export async function reapIfSame(identity: ProcessIdentity): Promise<ReapOutcome> {
	const verdict = await verifyIdentity(identity);
	if (verdict.state !== "same-process") return { reaped: false, verdict };
	try { process.kill(-verdict.pid, "SIGKILL"); } catch { /* the group is already gone */ }
	try { process.kill(verdict.pid, "SIGKILL"); } catch { /* already gone */ }
	return { reaped: true, verdict };
}
