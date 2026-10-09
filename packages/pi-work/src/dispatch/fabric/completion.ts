import type { ContextEvent } from "@earendil-works/pi-coding-agent";

type Message = ContextEvent["messages"][number];

/** Enrich only Fabric-delivered results. Fabric owns waking, batching and wait acknowledgment.
 * Register context as a Pi context handler, track dispatch receipts, and clear on session changes.
 * No sendMessage, timer, lifecycle subscription or second completion queue is needed here.
 */
export function createFabricCompletionAnnouncements() {
	const pending = new Set<string>();
	let annotated = new WeakMap<Message, Message>();
	return {
		track(runId: string): void {
			if (!runId.trim() || [...runId].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error("Invalid Fabric run identity");
			pending.add(runId);
		},
		/** For a caller that collected a run through wait or terminal status. */
		acknowledge(runId: string): void { pending.delete(runId); },
		clear(): void {
			pending.clear();
			annotated = new WeakMap<Message, Message>();
		},
		context(event: ContextEvent): { messages: Message[] } | undefined {
			let changed = false;
			const messages = event.messages.map((message) => {
				const cached = annotated.get(message);
				if (cached) { changed = true; return cached; }
				if (message.role !== "custom" || message.customType !== "pi-fabric-agent-complete" || typeof message.content !== "string") return message;
				const details: unknown = message.details;
				if (typeof details !== "object" || details === null || !("ids" in details) || !Array.isArray(details.ids)) return message;
				const lines: string[] = [];
				for (const id of details.ids) {
					if (typeof id !== "string" || !pending.delete(id)) continue;
					lines.push(`pi-work background run ${id} finished. Inspect its result before claiming the node is done.`);
				}
				if (!lines.length) return message;
				const result: Message = {
					role: "custom", customType: message.customType,
					content: `${message.content}\n\n${lines.join("\n")}`,
					display: message.display, details: message.details, timestamp: message.timestamp,
				};
				annotated.set(message, result);
				changed = true;
				return result;
			});
			return changed ? { messages } : undefined;
		},
	};
}
