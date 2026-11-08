import { buildContextEntries, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { foldStateFromBranch } from "../folds/fold-adapter.js";
import { baseIdOf } from "../folds/kernel/prune.js";
import { refToIndex } from "../folds/kernel/refs.js";

/** "<ref>..<ref>": both sides are required, and an acp ref or an entry id. */
export function parseRangeSelector(value: string): { from: string; to: string } | undefined {
	const at = value.indexOf("..");
	if (at <= 0) return undefined;
	const from = value.slice(0, at).trim();
	const to = value.slice(at + 2).trim();
	return from && to && !to.includes("..") ? { from, to } : undefined;
}

/** Path from the root to the file's last entry: the branch Pi would continue from. */
function branchOf(entries: readonly SessionEntry[]): SessionEntry[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	for (let entry = entries.at(-1); entry && !seen.has(entry.id); entry = entry.parentId === null ? undefined : byId.get(entry.parentId)) {
		seen.add(entry.id);
		branch.unshift(entry);
	}
	return branch;
}

export type EndpointResolution = { readonly ok: true; readonly entryId: string } | { readonly ok: false; readonly reason: string };

/** Resolves acp refs (m00012) on the file's branch, and entry ids anywhere in the file. */
export function endpointResolver(entries: readonly SessionEntry[]): (token: string) => EndpointResolution {
	const ids = new Set(entries.map((entry) => entry.id));
	let byRef: Readonly<Record<string, string>> | undefined;
	return (token) => {
		if (refToIndex(token) === null) return ids.has(token) ? { ok: true, entryId: token } : { ok: false, reason: "Unknown entry id in range" };
		if (!byRef) {
			try { byRef = foldStateFromBranch(branchOf(entries), buildContextEntries([...entries])).kernel.messageRefs.byRef; }
			catch { return { ok: false, reason: "Cannot resolve message refs for this session" }; }
		}
		const raw = byRef[token] ?? byRef[`m${String(refToIndex(token)).padStart(5, "0")}`];
		const entryId = raw === undefined ? undefined : baseIdOf(raw);
		return entryId !== undefined && ids.has(entryId) ? { ok: true, entryId } : { ok: false, reason: "Unknown message ref in range" };
	};
}
