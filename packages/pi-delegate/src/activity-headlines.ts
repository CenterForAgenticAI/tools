/**
 * Ephemeral per-run-entry activity headlines shared by the ticker and status widget.
 *
 * Headlines are intentionally UI-only: they are neither persisted in run-state
 * nor exposed as authoritative runtime history. Publisher ownership prevents a
 * disposed predecessor ticker from clearing a successor's newer headline.
 */

export interface ActivityHeadline {
	text: string;
}

export interface ActivityHeadlinePublisher {
	publish(runId: string, forkName: string, text: string): void;
	clear(runId: string, forkName: string): void;
	dispose(): void;
}

interface OwnedHeadline {
	owner: object;
	headline: ActivityHeadline;
}

const headlines = new Map<string, OwnedHeadline>();
const listeners = new Set<() => void>();

function headlineKey(runId: string, forkName: string): string {
	return `${runId}\u0000${forkName}`;
}

function notifyChanged(): void {
	for (const listener of [...listeners]) {
		try {
			listener();
		} catch {
			// A stale UI listener must never interrupt ticker/runtime activity.
		}
	}
}

export function createActivityHeadlinePublisher(): ActivityHeadlinePublisher {
	const owner = {};
	const ownedKeys = new Set<string>();
	let disposed = false;

	return {
		publish(runId, forkName, text) {
			if (disposed) return;
			const key = headlineKey(runId, forkName);
			const previous = headlines.get(key);
			headlines.set(key, { owner, headline: { text } });
			ownedKeys.add(key);
			if (previous?.headline.text !== text) notifyChanged();
		},
		clear(runId, forkName) {
			const key = headlineKey(runId, forkName);
			ownedKeys.delete(key);
			if (headlines.get(key)?.owner !== owner) return;
			headlines.delete(key);
			notifyChanged();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			let changed = false;
			for (const key of ownedKeys) {
				if (headlines.get(key)?.owner !== owner) continue;
				headlines.delete(key);
				changed = true;
			}
			ownedKeys.clear();
			if (changed) notifyChanged();
		},
	};
}

export function getActivityHeadline(
	runId: string,
	forkName: string,
): ActivityHeadline | undefined {
	return headlines.get(headlineKey(runId, forkName))?.headline;
}

export function onActivityHeadlinesChanged(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Test-only reset for module-global ephemeral UI state. */
export function __resetActivityHeadlinesForTests(): void {
	headlines.clear();
	listeners.clear();
}
