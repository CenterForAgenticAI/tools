import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** An event bus alone says nothing about the installed executor. */
export function fabricAvailable(pi: Pick<ExtensionAPI, "events" | "getAllTools">): boolean {
	return pi.events !== undefined && (pi.getAllTools?.().some(tool => tool.name === "fabric_exec") ?? false);
}
