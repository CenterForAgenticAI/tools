// @centerforagenticai/kleya-server/host: session host core (K1). The part both hosts share (spec 5.1 "Two hosts"):
// `nextWake` here; storage opening, `scheduleWake` and Feed attach live in each host. WP-1, WP-14.
import type { HarnessInspection, TaskInspection } from "@earendil-works/pi-durable";

/** How long a live task with no deadline may sit before the host wakes to resume it (the sample's recovery delay). */
export const RECOVERY_DELAY_MS = 60_000;

/** Task kind → the time the task next needs to run, or undefined when it needs to run now. */
export type DeadlineReaders = Readonly<Record<string, (task: TaskInspection) => number | undefined>>;

export type Wake = {
	/** When the host must next wake, or undefined when nothing is live. */
	at: number | undefined;
	/** Live tasks to resume now (the host waits on each and calls nextWake again when it settles). */
	resume: number[];
};

/**
 * P2. A blocked task is skipped (no definition can run it). A task whose reader names a future deadline and that is not
 * abort-marked waits for it; every other live task is resumed now, with a recovery wake in case the run is lost.
 */
export function nextWake(inspection: Pick<HarnessInspection, "tasks">, readers: DeadlineReaders, now: number, recoveryDelayMs = RECOVERY_DELAY_MS): Wake {
	let at: number | undefined;
	const resume: number[] = [];
	for (const task of inspection.tasks) {
		if (task.state.kind === "blocked") continue;
		const deadline = readers[task.record.kind]?.(task);
		const waits = deadline !== undefined && deadline > now && !task.record.abortRequested;
		const wake = waits ? deadline : now + recoveryDelayMs;
		at = at === undefined ? wake : Math.min(at, wake);
		if (!waits) resume.push(task.record.id);
	}
	return { at, resume };
}
