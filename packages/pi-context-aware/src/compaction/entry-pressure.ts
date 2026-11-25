/**
 * Entry pressure (pi-context-aware#441): how many entries sit on the branch path
 * since the last compaction, counted apart from tokens.
 *
 * Folding keeps token usage low, but a hidden entry is still an entry on the
 * path Pi walks every time it rebuilds the context. A session that folds and
 * never compacts grows that path without bound, and Pi fails to rebuild a path
 * of tens of thousands of entries. Compaction is the only thing that starts the
 * path again, so past a limit this count is pressure at any token usage.
 */

/** The entry count of one branch against the configured limit. */
export interface EntryPressure {
	/** Entries after the newest compaction entry on the path, or on the whole path when it has none. */
	readonly entriesSinceCompaction: number;
	readonly limit: number;
	/** The count has reached the limit: compact, or treat the session as URGENT. */
	readonly exceeded: boolean;
}

export interface EntryPressureSettings {
	readonly enabled: boolean;
	readonly maxEntriesSinceCompaction: number;
}

/** Entries after the newest `compaction` entry of a root-to-leaf branch. */
export function entriesSinceLastCompaction(branch: readonly unknown[]): number {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (typeof entry === "object" && entry !== null && (entry as { type?: unknown }).type === "compaction") return branch.length - index - 1;
	}
	return branch.length;
}

/** The branch's entry pressure, or null when the check is off. */
export function assessEntryPressure(branch: readonly unknown[], settings: EntryPressureSettings): EntryPressure | null {
	if (!settings.enabled) return null;
	const entriesSinceCompaction = entriesSinceLastCompaction(branch);
	return { entriesSinceCompaction, limit: settings.maxEntriesSinceCompaction, exceeded: entriesSinceCompaction >= settings.maxEntriesSinceCompaction };
}
