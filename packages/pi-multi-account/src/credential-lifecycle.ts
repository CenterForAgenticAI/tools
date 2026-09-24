/**
 * Credential lifecycle integrity.
 *
 * Three defects surfaced by reading the Sarrius reference implementation
 * (`.scratch/reference/code/pi/pi-multi-account-sarrius`), whose doc comments
 * record the production failures each one caused. They share a root cause:
 * treating a credential as if it were the account. A credential is a rotating
 * artifact; the account behind it is what routing decisions actually care
 * about.
 *
 * Nothing here reads from a store, persists, or logs a credential value. The
 * pure merge helper only reassembles fields. The Antigravity projector copies
 * its reviewed named fields into a short-lived callback input and drops every
 * unknown field; neither helper retains or emits credential material. Every
 * other helper takes bounded metadata (expiry, token presence).
 */

import type { OAuthCredentials } from "@earendil-works/pi-ai";

/** Named credential fields reviewed for the upstream Antigravity OAuth boundary. */
export interface AntigravityOAuthCredential extends OAuthCredentials {
	readonly projectId?: string;
	readonly email?: string;
}

/**
 * Copies only fields used by the selected Antigravity auth primitives.
 * Unknown AuthStorage fields must not cross into login, refresh, or request auth.
 */
export function projectAntigravityOAuthCredential(
	credential: OAuthCredentials,
): AntigravityOAuthCredential {
	const projectId = credential["projectId"];
	const email = credential["email"];
	return {
		access: credential.access,
		refresh: credential.refresh,
		expires: credential.expires,
		...(typeof projectId === "string" ? { projectId } : {}),
		...(typeof email === "string" ? { email } : {}),
	};
}

/**
 * Bounded, value-free description of a stored credential, sufficient to decide
 * whether an account can serve a request. Deliberately not the credential:
 * callers pass presence and expiry, never secrets.
 */
export interface CredentialUsability {
	/** Epoch ms when the credential expires, when the store reports one. */
	readonly expiresAtMs?: number | undefined;
	/** Whether a refresh token exists, i.e. whether expiry is recoverable. */
	readonly hasRefreshToken: boolean;
}

/**
 * Merges a refreshed OAuth credential onto the stored one.
 *
 * Spreading the refreshed fields last is the entire point: it carries the NEW
 * access token and expiry onto the credential the host uses next. Returning the
 * provider's response raw instead — which is what our Codex bridge did — loses
 * any field the response omits. The refresh token is the dangerous one: many
 * providers mint a new access token while returning no replacement refresh
 * token, so a raw return silently drops the only means of future recovery.
 *
 * Sarrius documents shipping exactly this bug: the dropped merge made every
 * post-refresh call reuse a stale access token and 401 forever, after which
 * their consecutive-401 guard concluded the account was dead and killed a slot
 * that was in fact healthy. A refresh that destroys the refresh token converts
 * a recoverable credential into an unrecoverable one.
 *
 * Preserves the stored refresh token when the response carries none, and is
 * conservative about what counts as "carries one" — a blank or whitespace-only
 * value is treated as absent rather than allowed to overwrite a working token.
 */
export function mergeRefreshedCredentials<
	TStored extends Record<string, unknown>,
	TRefreshed extends Record<string, unknown>,
>(stored: TStored, refreshed: TRefreshed): TStored & TRefreshed {
	const refreshedPresent = Object.fromEntries(
		Object.entries(refreshed).filter(
			([, value]) => value !== undefined && value !== null,
		),
	) as TRefreshed;
	const merged = { ...stored, ...refreshedPresent } as TStored & TRefreshed;
	const mintedRefresh = refreshed["refresh"];
	const hasMintedRefresh =
		typeof mintedRefresh === "string" && mintedRefresh.trim().length > 0;
	if (hasMintedRefresh) return merged;
	const storedRefresh = stored["refresh"];
	if (typeof storedRefresh !== "string" || storedRefresh.length === 0) {
		return merged;
	}
	return { ...merged, refresh: storedRefresh };
}

/**
 * Whether a credential can still serve a request.
 *
 * Unusable means provably dead, not merely stale: the credential has expired
 * AND carries no refresh token, so no code path can revive it. Such an account
 * must leave the routing pool, because every dispatch to it is a guaranteed
 * failure that consumes a turn and can trip failure heuristics against an
 * account whose only problem is that nobody has logged in.
 *
 * A credential that is expired but refreshable stays usable — refreshing is the
 * normal path and happens transparently. A credential with unknown expiry also
 * stays usable: absent evidence, the routing pool is the safer default, and a
 * real failure will still be classified reactively.
 */
export function isCredentialUsable(
	credential: CredentialUsability,
	nowMs: number,
): boolean {
	const { expiresAtMs, hasRefreshToken } = credential;
	if (hasRefreshToken) return true;
	if (expiresAtMs === undefined || !Number.isFinite(expiresAtMs)) return true;
	return expiresAtMs > nowMs;
}

/** How an account's identity compares to the one previously observed. */
export type AccountIdentityChange =
	/** No prior observation; nothing can be concluded yet. */
	| "first-observation"
	/** Same real account. A token may have rotated; the account did not. */
	| "unchanged"
	/** The slot now holds a genuinely different real account. */
	| "changed"
	/** Identity is not derivable, so no change can be proven. */
	| "indeterminate";

/**
 * Classifies an account identity transition for a slot.
 *
 * Routing state — rate-limit cooldowns and failure records — belongs to the
 * ACCOUNT, not to the credential that happens to represent it. A routine OAuth
 * refresh rotates the access token while the account behind it is unchanged, so
 * discarding that state on every rotation is wrong twice over: a server-side
 * rate limit is not lifted by minting a new token, and an agent that forgets
 * the cooldown will route straight back into the limit it just hit.
 *
 * When identity cannot be derived — Anthropic issues opaque tokens carrying no
 * account claim — the answer is `indeterminate`, never a guess. Callers must
 * treat that as "cannot prove a change" and retain existing state. Erring
 * toward keeping a cooldown costs at most some delay against one account;
 * erring toward clearing it sends real traffic into a known-limited account.
 */
export function classifyAccountIdentity(
	previous: string | undefined,
	next: string | undefined,
): AccountIdentityChange {
	if (previous === undefined && next === undefined) return "indeterminate";
	if (next === undefined) return "indeterminate";
	if (previous === undefined) return "first-observation";
	return previous === next ? "unchanged" : "changed";
}

/**
 * Whether a slot's accumulated routing state may be discarded.
 *
 * True only for a proven account substitution. Every other case — same account,
 * first sighting, or underivable identity — retains state, because none of them
 * is evidence that the server-side condition which created it has cleared.
 */
export function shouldClearAccountState(
	change: AccountIdentityChange,
): boolean {
	return change === "changed";
}
