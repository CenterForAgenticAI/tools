/**
 * How the model sees earlier fold tool calls.
 *
 * A fold tool call carries each item's full summary in its arguments, and the
 * fold's summary message carries the same text. Sending both repeats every
 * summary; billion-context-pi measured about 22K tokens of such repeats on long
 * sessions. billion-context-pi cuts the repeat to 199 characters plus "…", and
 * models copy that cut-off text into new calls as if it were a summary
 * (pi-context-aware#173).
 *
 * The native engine shows a pointer instead:
 * `summary kept in block b6 (9,585 chars)`. The pointer is not a summary, does
 * not end in "…", and names the block whose message holds the text, so the
 * saving stays and nothing invites a copy. `stubSummaryError` refuses a copied
 * pointer as it refuses a copied stub.
 *
 * Only the model's view changes. The session file keeps the call as written.
 * An item is rewritten only when a fold on the branch records its request id,
 * `<tool call id>#<item index>` (see fold-recovery.ts). The items are read from
 * the call's `content` argument, an array or the same array as a JSON string;
 * the shape is kept. An item whose fold was refused or not yet written keeps
 * its summary, so a failure stays visible.
 */

import type { ContextEvent } from "@earendil-works/pi-coding-agent";

import type { FoldRecord } from "./fold-entries.js";

type ContextMessages = ContextEvent["messages"];

/** The pointer shown in place of a summary that blocks `blockIds` carry. */
export function foldPointer(blockIds: readonly string[], chars: number): string {
	const blocks = blockIds.length === 1 ? `block ${blockIds[0]}` : `blocks ${blockIds.join(", ")}`;
	return `summary kept in ${blocks} (${chars.toLocaleString("en-US")} chars)`;
}

const POINTER = /^summary kept in blocks? b[1-9]\d*(?:, b[1-9]\d*)* \(\d{1,3}(?:,\d{3})* chars\)$/u;

/** True when the text is a fold pointer, trimmed. */
export function isFoldPointer(text: string): boolean {
	return POINTER.test(text.trim());
}

/**
 * Visible block ids per request id. A fold that a later fold absorbed points
 * at the absorbing fold, whose message the model sees now.
 */
export function foldPointerTargets(records: readonly FoldRecord[]): Map<string, string[]> {
	const absorbedBy = new Map<string, string>();
	for (const record of records) for (const id of record.directBlockIds) absorbedBy.set(id, record.blockId);
	const visible = (blockId: string): string => {
		let current = blockId;
		const seen = new Set<string>();
		for (let next = absorbedBy.get(current); next !== undefined && !seen.has(next); next = absorbedBy.get(current)) {
			seen.add(current);
			current = next;
		}
		return current;
	};
	const targets = new Map<string, string[]>();
	for (const record of records) {
		if (!record.requestId) continue;
		const ids = targets.get(record.requestId) ?? [];
		const id = visible(record.blockId);
		if (!ids.includes(id)) ids.push(id);
		targets.set(record.requestId, ids);
	}
	return targets;
}

/**
 * The messages with every item of an earlier fold tool call whose fold is on
 * the branch showing a pointer in place of its summary. Returns `messages`
 * itself when nothing changes.
 */
export function renderEarlierFoldCalls(messages: ContextMessages, records: readonly FoldRecord[]): ContextMessages {
	const targets = foldPointerTargets(records);
	if (targets.size === 0) return messages;
	const callIds = new Set([...targets.keys()].map((requestId) => requestId.slice(0, requestId.lastIndexOf("#"))));
	let changed = false;
	const rendered = messages.map((message) => {
		if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
		let partChanged = false;
		const content = message.content.map((part) => {
			if (part.type !== "toolCall" || !callIds.has(part.id)) return part;
			const args = renderArguments(part.id, part.arguments, targets);
			if (!args) return part;
			partChanged = true;
			return { ...part, arguments: args };
		});
		if (!partChanged) return message;
		changed = true;
		return { ...message, content };
	});
	return changed ? rendered : messages;
}

type JsonObject = Record<string, unknown>;

function renderArguments<T extends JsonObject>(callId: string, args: T, targets: ReadonlyMap<string, readonly string[]>): T | undefined {
	const raw = args.content;
	let items: unknown;
	if (typeof raw === "string") {
		try {
			items = JSON.parse(raw);
		} catch {
			return undefined;
		}
	} else {
		items = raw;
	}
	if (!Array.isArray(items)) return undefined;
	let changed = false;
	const next: unknown[] = items.map((item: unknown, index) => {
		const blockIds = targets.get(`${callId}#${index}`);
		if (!blockIds || typeof item !== "object" || item === null || Array.isArray(item)) return item;
		const { summary } = item as JsonObject;
		if (typeof summary !== "string") return item;
		changed = true;
		return { ...item, summary: foldPointer(blockIds, summary.trim().length) };
	});
	if (!changed) return undefined;
	return { ...args, content: typeof raw === "string" ? JSON.stringify(next) : next };
}
