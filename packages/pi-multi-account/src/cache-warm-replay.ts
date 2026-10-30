/**
 * Recognition of the host cache warmer's replays on `unified` rows
 * (internal issue #206).
 *
 * Pi's cache warmer keeps a prompt cache entry alive by sending the session's
 * last real request again with `{ ...options, maxTokens: 1, maxRetries: 0 }`
 * shortly before the entry expires (pi-coding-agent
 * `dist/core/cache-warmer.js`). The replay carries no marker of its own, and a
 * caller could send those two option values for its own reasons.
 *
 * The replay does carry the identical message array. The warmer keeps the
 * request's context object and sends it again. Pi's `normalizeContext`
 * returns a context's own message array when the context has no separate
 * system prompt or tools, and agent-loop contexts never have them. Every real
 * agent request builds a new array.
 *
 * A replay is therefore a call that sends a message array an earlier real call
 * already sent, with exactly the warmer's option values. The set is weak, so
 * it keeps no transcript alive, and it stores no session key.
 */

export interface CacheWarmReplayRecognizer {
	/** Remember a real call's message array so its replay can be recognized. */
	noteRealRequest(context: unknown): void;
	/** Whether this call sends a remembered real request again with the warmer's options. */
	isReplay(context: unknown, options: unknown): boolean;
}

function messageArray(context: unknown): readonly unknown[] | undefined {
	if (typeof context !== "object" || context === null) return undefined;
	const messages = (context as { messages?: unknown }).messages;
	return Array.isArray(messages) ? messages : undefined;
}

/** The exact option values of the warmer's replay in Pi 1.3.0. */
export function hasCacheWarmReplayOptions(options: unknown): boolean {
	if (typeof options !== "object" || options === null) return false;
	const { maxTokens, maxRetries } = options as { maxTokens?: unknown; maxRetries?: unknown };
	return maxTokens === 1 && maxRetries === 0;
}

export function createCacheWarmReplayRecognizer(): CacheWarmReplayRecognizer {
	const realRequests = new WeakSet<readonly unknown[]>();
	return {
		noteRealRequest(context) {
			const messages = messageArray(context);
			if (messages !== undefined) realRequests.add(messages);
		},
		isReplay(context, options) {
			if (!hasCacheWarmReplayOptions(options)) return false;
			const messages = messageArray(context);
			return messages !== undefined && realRequests.has(messages);
		},
	};
}
