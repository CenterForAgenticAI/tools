import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type PiWithOn = Pick<Partial<ExtensionAPI>, "on">;
type DelegateOnlyEventHandler = (...args: never[]) => unknown;

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function registerDelegateOnlyEvent(
	pi: PiWithOn,
	event: string,
	handler: DelegateOnlyEventHandler,
): void {
	if (typeof pi.on !== "function") {
		throw new Error(`[delegate-only] refusing to start: pi.on("${event}") is unavailable`);
	}
	try {
		(pi.on as unknown as (event: string, handler: DelegateOnlyEventHandler) => void).call(pi, event, handler);
	} catch (error) {
		throw new Error(`[delegate-only] refusing to start: pi.on("${event}") threw: ${errorText(error)}`, {
			cause: error,
		});
	}
}
