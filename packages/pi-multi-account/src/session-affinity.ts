/**
 * In-process memory of the account that last served each `unified` session
 * (internal issue #204).
 *
 * Every account move costs the session a full prompt-cache rebuild, so a
 * session keeps the account that last served a logical model while that
 * account stays eligible. This memory only reorders candidates the router has
 * already found eligible; eligibility, account groups, cooldowns, `clear` and
 * `disable` stay authoritative.
 *
 * The memory holds provider ids only. It is bounded, lives in this process, and
 * is never persisted. Session keys are lookup keys only: nothing here reports
 * them, and no caller may put them into diagnostics or logs.
 */

/** Sessions remembered at once; the least recently served is evicted first. */
export const SESSION_AFFINITY_MAX_SESSIONS = 64;
/** Logical models remembered per session; the least recently served is evicted first. */
export const SESSION_AFFINITY_MAX_MODELS_PER_SESSION = 16;
/** Longer caller-supplied session ids are not remembered, so one key cannot grow the memory. */
export const SESSION_AFFINITY_MAX_KEY_LENGTH = 256;

/** The session key a call's options carry, or `undefined` when it has no usable one. */
export function sessionAffinityKey(options: unknown): string | undefined {
	if (typeof options !== "object" || options === null) return undefined;
	const sessionId = (options as { sessionId?: unknown }).sessionId;
	return typeof sessionId === "string" &&
		sessionId.length > 0 &&
		sessionId.length <= SESSION_AFFINITY_MAX_KEY_LENGTH
		? sessionId
		: undefined;
}

/** What the memory held for one session and logical model before a record. */
export interface SessionAffinityEntry {
	readonly providerId: string;
	/** A call failed on this account after it last served; it is no longer preferred. */
	readonly failed: boolean;
}

export interface SessionAffinity {
	/**
	 * The provider id of the account that last served a successful call for this
	 * session and logical model, or `undefined` when none is remembered or a call
	 * has failed on it since. Reading never changes the memory.
	 */
	lastServingAccount(sessionKey: string, modelId: string): string | undefined;
	/** Remember the account that served a successful call; returns the previous entry. */
	recordServed(
		sessionKey: string,
		modelId: string,
		providerId: string,
	): SessionAffinityEntry | undefined;
	/** A call failed on `providerId`: stop preferring it if it is the remembered account. */
	recordFailed(sessionKey: string, modelId: string, providerId: string): void;
}

export interface SessionAffinityLimits {
	readonly maxSessions?: number;
	readonly maxModelsPerSession?: number;
}

function positiveLimit(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Move `key` to the newest position, then drop the oldest keys above `limit`. */
function touch<V>(map: Map<string, V>, key: string, value: V, limit: number): void {
	map.delete(key);
	map.set(key, value);
	while (map.size > limit) {
		const oldest = map.keys().next().value as string;
		map.delete(oldest);
	}
}

export function createSessionAffinity(limits: SessionAffinityLimits = {}): SessionAffinity {
	const maxSessions = positiveLimit(limits.maxSessions, SESSION_AFFINITY_MAX_SESSIONS);
	const maxModels = positiveLimit(
		limits.maxModelsPerSession,
		SESSION_AFFINITY_MAX_MODELS_PER_SESSION,
	);
	const sessions = new Map<string, Map<string, SessionAffinityEntry>>();

	return {
		lastServingAccount(sessionKey, modelId) {
			const entry = sessions.get(sessionKey)?.get(modelId);
			return entry === undefined || entry.failed ? undefined : entry.providerId;
		},
		recordServed(sessionKey, modelId, providerId) {
			const models = sessions.get(sessionKey) ?? new Map<string, SessionAffinityEntry>();
			const previous = models.get(modelId);
			touch(models, modelId, Object.freeze({ providerId, failed: false }), maxModels);
			touch(sessions, sessionKey, models, maxSessions);
			return previous;
		},
		recordFailed(sessionKey, modelId, providerId) {
			const models = sessions.get(sessionKey);
			const entry = models?.get(modelId);
			if (models === undefined || entry === undefined || entry.providerId !== providerId) return;
			models.set(modelId, Object.freeze({ providerId, failed: true }));
		},
	};
}
