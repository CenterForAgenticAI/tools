/** A transcript event participating in tool-call pairing. */
export interface ToolPairingEvent {
	id?: string;
	index: number;
}

/**
 * Normalize a persisted tool-call id before pairing it with a result.
 * Empty and whitespace-only ids are legacy anonymous calls, not usable ids.
 */
function normalizeToolCallId(id: string | undefined): string | undefined {
	if (typeof id !== "string") return undefined;
	const normalized = id.trim();
	return normalized.length > 0 ? normalized : undefined;
}

/**
 * Return one transcript index for each unresolved logical tool call.
 *
 * Pairing is deliberately conservative and shared by every projection: calls
 * with the same normalized non-empty id are one logical call, represented by
 * the latest such call; anonymous calls are one logical group, resolved by the
 * latest tool result just as legacy transcripts were handled before ids were
 * available. This makes duplicate ids count once instead of disagreeing about
 * whether one worker tool remains open.
 */
export function unresolvedToolCallIndexes(
	calls: readonly ToolPairingEvent[],
	results: readonly ToolPairingEvent[],
): number[] {
	const latestCallById = new Map<string, number>();
	let latestAnonymousCall: number | undefined;
	for (const call of calls) {
		const id = normalizeToolCallId(call.id);
		if (id === undefined) {
			latestAnonymousCall = latestAnonymousCall === undefined
				? call.index
				: Math.max(latestAnonymousCall, call.index);
			continue;
		}
		const prior = latestCallById.get(id);
		if (prior === undefined || call.index > prior) latestCallById.set(id, call.index);
	}

	const latestResultById = new Map<string, number>();
	let latestResultIndex = -1;
	for (const result of results) {
		latestResultIndex = Math.max(latestResultIndex, result.index);
		const id = normalizeToolCallId(result.id);
		if (id === undefined) continue;
		const prior = latestResultById.get(id);
		if (prior === undefined || result.index > prior) latestResultById.set(id, result.index);
	}

	const unresolved: number[] = [];
	for (const [id, callIndex] of latestCallById) {
		const resultIndex = latestResultById.get(id);
		if (resultIndex === undefined || resultIndex < callIndex) unresolved.push(callIndex);
	}
	if (latestAnonymousCall !== undefined && latestResultIndex < latestAnonymousCall) {
		unresolved.push(latestAnonymousCall);
	}
	return unresolved.sort((a, b) => a - b);
}
