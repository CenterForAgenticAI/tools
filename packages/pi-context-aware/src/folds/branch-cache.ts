/**
 * Append fold drafts to a session in linear time (pi-context-aware#254).
 *
 * Pi's `appendContextEdit(targetId, ...)` proves the target is on the active branch with
 * `this.getBranch().some((entry) => entry.id === targetId)`. `getBranch()` walks the leaf-to-root chain
 * and `.some` scans it from the root, so each append costs the branch length. Pi has no batch append,
 * so applying one fold over an n-entry branch is O(n^2). Measured on a 24,000-entry session: 40 s for
 * one whole-session fold and 189 s for a three-tier set, and the cost grew about 4x for each doubling.
 *
 * Every append moves the leaf to the entry it adds and nothing else changes the branch, so the branch
 * after an append is the branch before it plus that entry. For the length of one synchronous apply this
 * keeps that branch array and answers two things from it:
 *  - the argument-less `getBranch()` returns the kept array instead of walking;
 *  - `.some(predicate)` on it first tries the entry about to be edited, found through an id index, and
 *    answers true when the predicate accepts it. Anything else (predicate rejects it, or is something
 *    Pi added later) falls through to the ordinary scan, so the answer is always what a scan gives.
 * Pi still runs every one of its own checks on every draft and may still refuse one. The overrides sit
 * on the instance and the array only, and are removed in `finally`. If an append leaves the leaf
 * anywhere but on the new entry, or the new entry's parent is not the previous tip (a Pi change), the kept array is dropped and Pi's own walk answers
 * from then on: slower, never wrong.
 */

import type { SessionBoundaryDraft, SessionManager } from "@earendil-works/pi-coding-agent";

export type BatchableManager = Pick<SessionManager, "appendContextEdit" | "appendCustomEntry" | "getBranch" | "getLeafId" | "getEntry">;

type SessionEntryOf = ReturnType<SessionManager["getBranch"]>[number];

export function applyDraftsLinear(manager: BatchableManager, drafts: readonly SessionBoundaryDraft[]): void {
	const ownGetBranch = Object.getOwnPropertyDescriptor(manager, "getBranch");
	const walk = manager.getBranch.bind(manager);
	const branch = walk();
	const position = new Map<string, number>(branch.map((entry, index) => [entry.id, index]));
	let target: string | undefined;
	let cached = true;
	Object.defineProperty(branch, "some", {
		configurable: true,
		value(predicate: (entry: SessionEntryOf, index: number, all: SessionEntryOf[]) => unknown, thisArg?: unknown): boolean {
			const at = !cached || target === undefined ? undefined : position.get(target);
			if (at !== undefined && predicate.call(thisArg, branch[at]!, at, branch)) return true;
			return Array.prototype.some.call(branch, predicate, thisArg);
		},
	});
	manager.getBranch = (fromId?: string) => (fromId === undefined && cached ? branch : walk(fromId));
	const track = (id: string): void => {
		const entry = manager.getEntry(id);
		const tip = branch.at(-1);
		// The new entry must hang under the previous tip and hold the leaf; otherwise the kept branch is stale.
		if (cached && entry !== undefined && manager.getLeafId() === id && entry.parentId === (tip?.id ?? null)) {
			position.set(id, branch.length);
			branch.push(entry);
		} else cached = false;
	};
	try {
		for (const draft of drafts) {
			if (draft.type === "context_edit") {
				target = draft.targetId;
				track(manager.appendContextEdit(draft.targetId, draft.replacement));
			} else if (draft.type === "custom") {
				target = undefined;
				track(manager.appendCustomEntry(draft.customType, draft.data));
			} else throw new Error(`fold drafts never contain ${draft.type} entries`);
		}
	} finally {
		if (ownGetBranch) Object.defineProperty(manager, "getBranch", ownGetBranch);
		else delete (manager as { getBranch?: unknown }).getBranch;
	}
}
