import type { CoreMessage } from "./kernel/index.js";
import { baseIdOf } from "./kernel/prune.js";

/** Close coverage over whole Pi entries and tool pairs before making entry edits.
 * Range plans also include intervening messages; legacy imports may be sparse.
 * Each pass adds ids, so even chains of entries with multiple calls terminate.
 */
export function widenFoldCoverage(messages: readonly CoreMessage[], ids: readonly string[], contiguous = false): string[] {
	const selected = new Set(ids);
	let changed = true;
	while (changed) {
		const before = selected.size;
		const entries = new Set([...selected].map(baseIdOf));
		const calls = new Set(messages.filter((message) => selected.has(message.id) && message.toolCallId)
			.map((message) => message.toolCallId));
		for (const message of messages) {
			if (entries.has(baseIdOf(message.id)) || (message.toolCallId && calls.has(message.toolCallId))) selected.add(message.id);
		}
		if (contiguous) {
			const first = messages.findIndex((message) => selected.has(message.id));
			const last = messages.reduce((last, message, index) => selected.has(message.id) ? index : last, -1);
			for (let index = first; index >= 0 && index <= last; index++) selected.add(messages[index]!.id);
		}
		changed = selected.size !== before;
	}
	return [...selected];
}
