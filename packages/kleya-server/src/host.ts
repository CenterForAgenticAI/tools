// @centerforagenticai/kleya-server/host: session host core (K1, spec 5.1 and 5.2). The core owns turns, request
// records, cursors and session ids; an adapter supplies the ports (HostPorts). `nextWake` is the alarm rule both
// hosts share.
import type { HarnessInspection, TaskInspection } from "@earendil-works/pi-durable";

import { RECOVERY_DELAY_MS } from "./host/core.ts";

export { createHost, harnessIdOf, hostRequestId, RECOVERY_DELAY_MS, sessionName, turnCredential } from "./host/core.ts";
export { effectTool } from "./host/effect.ts";
export type { EffectCall, EffectClass, EffectTool } from "./host/effect.ts";
export type {
	Caller,
	CredentialPort,
	Fence,
	FollowOptions,
	Gateway,
	Host,
	HostOptions,
	HostPorts,
	Right,
	Scope,
	SessionHost,
	SessionStore,
	SubmitOptions,
	ToolCallView,
	Turn,
	TurnCredential,
} from "./host/core.ts";

/** Task kind → the time the task next needs to run, or undefined when it needs to run now. */
export type DeadlineReaders = Readonly<Record<string, (task: TaskInspection) => number | undefined>>;

export type Wake = {
	/** When the host must next wake, or undefined when nothing is live. */
	at: number | undefined;
	/** Live tasks to resume now (the host waits on each and calls nextWake again when it settles). */
	resume: number[];
};

/**
 * P2. A blocked task is skipped (no definition can run it). A task that is not abort-marked and has a future deadline
 * waits for it: a pi-durable 1.4.0 sleeping task's `until`, else the time its reader names. Every other live task is
 * resumed now, with a recovery wake in case the run is lost.
 */
export function nextWake(inspection: Pick<HarnessInspection, "tasks">, readers: DeadlineReaders, now: number, recoveryDelayMs = RECOVERY_DELAY_MS): Wake {
	let at: number | undefined;
	const resume: number[] = [];
	for (const task of inspection.tasks) {
		if (task.state.kind === "blocked") continue;
		const deadline = task.state.kind === "sleeping" ? task.state.until : readers[task.record.kind]?.(task);
		const waits = deadline !== undefined && deadline > now && !task.record.abortRequested;
		const wake = waits ? deadline : now + recoveryDelayMs;
		at = at === undefined ? wake : Math.min(at, wake);
		if (!waits) resume.push(task.record.id);
	}
	return { at, resume };
}
