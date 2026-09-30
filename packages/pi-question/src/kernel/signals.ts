import type { SurfaceName } from "./select.ts";

export interface EventSink {
	emit(channel: string, data: unknown): void;
}

export const BLOCKED_CHANNEL = "herdr:blocked";

/**
 * Run `work` while the agent is marked blocked on a human. Every raise has
 * exactly one clear, on every exit path (laws L14-L15). The `none` surface
 * raises nothing. Emission is best effort: a listener error never affects the ask.
 */
export async function withBlockedSignal<T>(
	events: EventSink | undefined,
	surface: SurfaceName,
	label: string,
	enabled: boolean,
	work: () => Promise<T>,
): Promise<T> {
	if (!enabled || !events || surface === "none") return work();
	const emit = (active: boolean) => {
		try {
			events.emit(BLOCKED_CHANNEL, active ? { active, label } : { active });
		} catch {
			// best effort
		}
	};
	emit(true);
	try {
		return await work();
	} finally {
		emit(false);
	}
}
