import { FOLD_ENTRY_TYPE, readFoldRecord } from "../folds/fold-entries.js";
import { isObject, type JsonObject } from "./tombstone.js";

/**
 * The entries that hold a derived copy of the chosen ones, so erasing a range cannot leave its summary behind:
 * a compaction or branch summary that covers a chosen entry, the edit that carries a fold summary, the fold record
 * (its topic), and any edit that targets a chosen entry. Ids and links stay; only content is erased later.
 */
export function derivedEntryIds(entries: readonly JsonObject[], chosen: ReadonlySet<string>): Set<string> {
	const byId = new Map<string, JsonObject>();
	for (const entry of entries) if (typeof entry.id === "string") byId.set(entry.id, entry);
	const pathTo = (start: unknown): string[] => {
		const path: string[] = [];
		const seen = new Set<string>();
		for (let id = start; typeof id === "string" && !seen.has(id) && byId.has(id); id = byId.get(id)?.parentId) { seen.add(id); path.unshift(id); }
		return path;
	};
	const result = new Set(chosen);
	for (let changed = true; changed;) {
		changed = false;
		const add = (id: unknown) => { if (typeof id === "string" && !result.has(id)) { result.add(id); changed = true; } };
		for (const entry of entries) {
			const id = entry.id;
			if (typeof id !== "string") continue;
			if (entry.type === "compaction") {
				const path = pathTo(entry.parentId);
				const kept = typeof entry.firstKeptEntryId === "string" ? path.indexOf(entry.firstKeptEntryId) : -1;
				if (path.slice(0, kept < 0 ? path.length : kept).some((covered) => result.has(covered))) add(id);
			} else if (entry.type === "branch_summary") {
				const own = new Set(pathTo(entry.parentId));
				if (pathTo(entry.fromId).some((covered) => !own.has(covered) && result.has(covered))) add(id);
			} else if (entry.type === "context_edit") {
				if (typeof entry.targetId === "string" && result.has(entry.targetId)) add(id);
			} else if (entry.type === "custom" && entry.customType === FOLD_ENTRY_TYPE) {
				const record = isObject(entry.data) ? readFoldRecord(entry.data) : undefined;
				if (!record || ![record.carrierId, ...record.hiddenIds].some((covered) => result.has(covered))) continue;
				add(id);
				for (const edit of entries) if (edit.type === "context_edit" && edit.targetId === record.carrierId) add(edit.id);
			}
		}
	}
	return result;
}
