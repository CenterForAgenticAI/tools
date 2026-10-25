// @centerforagenticai/kleya-server/feed: Feed core (K2), WP-2. Attach, catch-up `since` and commit frames over one
// Harness. Platform-free (MIN-11): the host owns sockets, buffers and attachments; this module only reads the Harness.
// Rules from S1: the watermark comes from storage, never from memory (rule 2); `since` pages (after, through] under an
// entry cap and a byte cap (MIN-15); each commit becomes one frame per conversation, shared by every viewer (MIN-16);
// catch-up reads only the missed range (MIN-18).
import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, EntryRecord, Harness } from "@earendil-works/pi-durable";
import { decodeCursor, encodeCursor, type Attach, type AttachOk, type Commit, type ConversationRef, type EntryView, type FeedError, type HarnessId, type Page, type Since } from "@centerforagenticai/kleya-client/protocol";

/** The two Harness calls Feed makes. */
export type FeedSource = Pick<Harness, "conversation" | "subscribeCommits">;

export type FeedOptions = {
	readonly harnessId: HarnessId;
	/** Newest entries in an attach window. Default 50. */
	readonly windowEntries?: number;
	/** Entry cap of one `since` page. Default 500 (S1). */
	readonly pageEntries?: number;
	/** Byte cap of one `since` page; a client's `maxBytes` may only lower it. Default 1 MiB. A page always holds one entry. */
	readonly pageBytes?: number;
};

export interface Feed {
	attach(frame: Attach, context: Context): Promise<AttachOk | FeedError>;
	/** `conv` is the conversation the socket attached to; the cursors must belong to it. */
	since(conv: ConversationRef, frame: Since, context: Context): Promise<Page | FeedError>;
	/** Commit frames for one conversation. The listener runs synchronously inside the commit publication. */
	subscribe(conversationId: number, listener: (frame: Commit) => void): () => void;
	/** Stops the Harness subscription. Idempotent; later calls answer `unavailable`. */
	dispose(): void;
}

const encoder = new TextEncoder();
const INVALID_CURSOR: FeedError = { t: "error", code: "invalid_cursor", retry: "reattach" };
const FORBIDDEN: FeedError = { t: "error", code: "forbidden", retry: "never" };
const UNAVAILABLE: FeedError = { t: "error", code: "unavailable", retry: "reattach" };

export function createFeed(source: FeedSource, options: FeedOptions): Feed {
	const windowEntries = options.windowEntries ?? 50;
	const pageEntries = options.pageEntries ?? 500;
	const pageBytes = options.pageBytes ?? 1024 * 1024;
	const listeners = new Map<number, Set<(frame: Commit) => void>>();
	let unsubscribe: (() => void) | undefined;
	let disposed = false;

	const view = (conv: ConversationRef, entry: EntryRecord): EntryView => {
		const bytes = encoder.encode(JSON.stringify(entry)).length;
		return { id: encodeCursor(conv, entry.id), kind: entry.kind, bytes, body: entry };
	};
	const ours = (conv: ConversationRef) => conv.harnessId === options.harnessId;
	const open = (conv: ConversationRef, context: Context) => source.conversation(conv.conversationId as ConversationId, context);

	return {
		async attach(frame, context) {
			if (disposed) return UNAVAILABLE;
			if (!ours(frame.conv)) return FORBIDDEN;
			if (frame.cursor !== undefined && decodeCursor(frame.cursor, frame.conv) === undefined) return INVALID_CURSOR;
			const conversation = await open(frame.conv, context);
			if (conversation === undefined) return FORBIDDEN;
			// Rule 2: W is the newest committed entry in storage, read now.
			const newest = await conversation.entries({ order: "descending" }, windowEntries + 1, undefined, context);
			const truncated = newest.items.length > windowEntries;
			const shown = newest.items.slice(0, windowEntries).reverse();
			const head = encodeCursor(frame.conv, shown.at(-1)?.id ?? 0);
			const floor = encodeCursor(frame.conv, truncated ? newest.items[windowEntries]!.id : 0);
			return { t: "attached", watermark: head, live: {}, window: { entries: shown.map((e) => view(frame.conv, e)), floor, head, truncated } };
		},

		async since(conv, frame, context) {
			if (disposed) return UNAVAILABLE;
			if (!ours(conv)) return FORBIDDEN;
			const after = decodeCursor(frame.after, conv);
			const through = decodeCursor(frame.through, conv);
			if (after === undefined || through === undefined) return INVALID_CURSOR;
			if (through <= after) return { t: "page", entries: [], last: frame.after, more: false };
			const conversation = await open(conv, context);
			if (conversation === undefined) return FORBIDDEN;
			// Only a positive finite number lowers the cap; anything else a client sends leaves it in force.
			const asked: unknown = frame.maxBytes;
			const cap = typeof asked === "number" && Number.isFinite(asked) && asked > 0 ? Math.min(asked, pageBytes) : pageBytes;
			const found = await conversation.entries({ order: "ascending", minEntryId: (after + 1) as EntryRecord["id"], maxEntryId: through as EntryRecord["id"] }, pageEntries + 1, undefined, context);
			const entries: EntryView[] = [];
			let bytes = 0;
			for (const entry of found.items.slice(0, pageEntries)) {
				const v = view(conv, entry);
				if (entries.length > 0 && bytes + v.bytes > cap) break;
				entries.push(v);
				bytes += v.bytes;
			}
			const more = entries.length < found.items.length;
			return { t: "page", entries, last: more ? entries.at(-1)!.id : frame.through, more };
		},

		subscribe(conversationId, listener) {
			if (disposed) throw new Error("feed is disposed");
			const set = listeners.get(conversationId) ?? new Set();
			listeners.set(conversationId, set);
			set.add(listener);
			unsubscribe ??= source.subscribeCommits((publication) => {
				const byConversation = new Map<number, EntryRecord[]>();
				for (const change of publication.changes) {
					if (change.type !== "entry" || !listeners.has(change.value.conversationId)) continue;
					const list = byConversation.get(change.value.conversationId) ?? [];
					byConversation.set(change.value.conversationId, list);
					list.push(change.value);
				}
				for (const [id, list] of byConversation) {
					const conv: ConversationRef = { harnessId: options.harnessId, conversationId: id };
					list.sort((a, b) => a.id - b.id);
					// MIN-16: one frame per commit and conversation, the same object for every viewer.
					const frame: Commit = { t: "commit", entries: list.map((e) => view(conv, e)), head: encodeCursor(conv, list.at(-1)!.id) };
					for (const fn of listeners.get(id) ?? []) {
						try {
							fn(frame);
						} catch {
							// One viewer's failure never stops the others; the host closes that viewer.
						}
					}
				}
			});
			return () => {
				set.delete(listener);
				if (set.size === 0) listeners.delete(conversationId);
			};
		},

		dispose() {
			disposed = true;
			unsubscribe?.();
			unsubscribe = undefined;
			listeners.clear();
		},
	};
}
