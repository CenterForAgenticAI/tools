/**
 * Forces one credential refresh when a provider says 401 while the local
 * credential still looks valid.
 *
 * Pi refreshes an OAuth credential only after LOCAL expiry. A server-side early
 * revocation therefore leaves a token that looks fine locally and 401s on every
 * request, forever, with nothing triggering a refresh. The warmer only warms
 * near-expiry credentials, so it never touches this case either.
 *
 * Ported from the Sarrius reference (index.ts:2576-2646), with one structural
 * improvement: persistence goes through `AuthStorage.modify()`, whose file
 * backend does a locked read-modify-write, so the cross-process race Sarrius
 * handles by hand is handled by the host. Sarrius's sharpest check is kept: a
 * refresh that returns a DIFFERENT account identity is terminal, because the
 * slot is now a different account and continuing would silently use credentials
 * the operator did not intend.
 *
 * CREDENTIAL DISCIPLINE. Credential values transit the `modify` callback and
 * the family refresher, and nowhere else: they never enter fields on this
 * class, never reach diagnostics, and never appear in a return value. Callers
 * receive only a bounded outcome string.
 */

import type { DiagnosticLog } from "./diagnostics.js";
import type { AllowedFamily } from "./config.js";

/**
 * The slice of a stored OAuth credential this module touches. Matches the
 * host's stored shape; extra fields pass through `modify` untouched.
 */
export interface RefreshableCredential {
	readonly type?: string;
	readonly access?: string;
	readonly refresh?: string;
	readonly expires?: number;
	readonly accountId?: string;
	readonly [key: string]: unknown;
}

/** Complete input required by both maintained family refresh callbacks. */
export interface OAuthRefreshCredential extends RefreshableCredential {
	readonly type: "oauth";
	readonly access: string;
	readonly refresh: string;
	readonly expires: number;
}

/** Refreshes one family's credential; the captured upstream oauth surface. */
export type FamilyRefresher = (
	credentials: OAuthRefreshCredential,
) => Promise<RefreshableCredential>;

/**
 * `CredentialStore.modify` shape, injected so tests never construct a real
 * store and live wiring can bind the host's already-open locked store.
 */
export type AuthModify = (
	provider: string,
	fn: (
		current: RefreshableCredential | undefined,
	) => Promise<RefreshableCredential | undefined>,
) => Promise<RefreshableCredential | undefined>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isOAuthRefreshCredential(
	value: RefreshableCredential | undefined,
): value is OAuthRefreshCredential {
	return (
		value?.type === "oauth" &&
		typeof value.access === "string" &&
		value.access.length > 0 &&
		typeof value.refresh === "string" &&
		value.refresh.length > 0 &&
		typeof value.expires === "number" &&
		Number.isFinite(value.expires)
	);
}

function familyRefresher(oauth: unknown): FamilyRefresher | undefined {
	const refreshToken = isRecord(oauth) ? oauth.refreshToken : undefined;
	if (typeof refreshToken !== "function") return undefined;
	return async (credential) => {
		const refreshed: unknown = await refreshToken.call(oauth, credential);
		return isRecord(refreshed) ? refreshed : {};
	};
}

export interface HostForcedCredentialRefresherOptions {
	readonly modelRegistry: unknown;
	readonly oauthByFamily: Partial<Record<AllowedFamily, unknown>>;
	readonly diagnostics: Pick<DiagnosticLog, "record">;
}

/**
 * Binds the maintained OAuth callbacks to Pi's already-open credential store.
 *
 * `ModelRegistry.runtime` and `ModelRuntime.credentials` are private in the
 * locked Pi 0.84.4 declaration files, while that exact installed runtime owns
 * both fields. `RuntimeCredentials` forwards `modify` to `AuthStorage.modify`,
 * whose file backend holds a cross-process lock for the whole async
 * read-modify-write. If that verified host shape changes, this returns
 * undefined and 401 handling fails closed into the existing
 * invalidate-and-route path.
 */
export function createHostForcedCredentialRefresher(
	options: HostForcedCredentialRefresherOptions,
): ForcedCredentialRefresher | undefined {
	const credentials = (
		options.modelRegistry as
			| {
					runtime?: {
						credentials?: { modify?: unknown };
					};
			  }
			| undefined
	)?.runtime?.credentials;
	if (!credentials || typeof credentials.modify !== "function") return undefined;

	const refreshers: Partial<Record<AllowedFamily, FamilyRefresher>> = {};
	for (const family of [
		"anthropic",
		"openai-codex",
		"google-antigravity",
	] as const) {
		const refresh = familyRefresher(options.oauthByFamily[family]);
		if (refresh !== undefined) refreshers[family] = refresh;
	}
	return new ForcedCredentialRefresher({
		modify: credentials.modify.bind(credentials) as AuthModify,
		refreshers,
		diagnostics: options.diagnostics,
	});
}

export type ForcedRefreshOutcome =
	/** A refreshed credential was persisted; the account deserves a fresh chance. */
	| "refreshed"
	/** The refresh identified a DIFFERENT account; invalidation must stand. */
	| "identity-changed"
	/** The refresh failed; nothing was persisted. */
	| "failed"
	/** No stored oauth credential with a refresh token; nothing to force. */
	| "unsupported"
	/** This provider already got its one forced attempt this session. */
	| "already-attempted";

function recordOutcome(
	diagnostics: Pick<DiagnosticLog, "record">,
	providerId: string,
	outcome: ForcedRefreshOutcome,
): ForcedRefreshOutcome {
	diagnostics.record(
		outcome === "refreshed" ? "info" : "warning",
		"credential.force-refresh",
		outcome === "refreshed"
			? "Forced one credential refresh after an explicit provider 401."
			: "A forced credential refresh did not recover the provider; normal invalidation remains active.",
		{ providerId, outcome },
	);
	return outcome;
}

export interface ForcedCredentialRefresherOptions {
	readonly modify: AuthModify;
	readonly refreshers: Partial<Record<AllowedFamily, FamilyRefresher>>;
	readonly diagnostics: Pick<DiagnosticLog, "record">;
}

export class ForcedCredentialRefresher {
	readonly #modify: AuthModify;
	readonly #refreshers: Partial<Record<AllowedFamily, FamilyRefresher>>;
	readonly #diagnostics: Pick<DiagnosticLog, "record">;
	/**
	 * Exactly one forced attempt per provider per session, whatever the outcome.
	 * A 401 that survives a fresh token is not a staleness problem, and retrying
	 * the refresh on every exhausted turn would hammer the provider's token
	 * endpoint with requests that cannot succeed.
	 */
	readonly #attempted = new Set<string>();

	constructor(options: ForcedCredentialRefresherOptions) {
		this.#modify = options.modify;
		this.#refreshers = options.refreshers;
		this.#diagnostics = options.diagnostics;
	}

	async attempt(
		providerId: string,
		family: AllowedFamily,
	): Promise<ForcedRefreshOutcome> {
		if (this.#attempted.has(providerId)) return "already-attempted";
		this.#attempted.add(providerId);

		const refresher = this.#refreshers[family];
		if (refresher === undefined) return "unsupported";

		let outcome: ForcedRefreshOutcome = "failed";
		try {
			await this.#modify(providerId, async (current) => {
				if (!isOAuthRefreshCredential(current)) {
					outcome = "unsupported";
					return undefined;
				}
				let refreshed: RefreshableCredential;
				try {
					refreshed = await refresher(current);
				} catch {
					// The refresh itself failed. Persist nothing; the 401 keeps its
					// terminal classification. Never record the provider's error body:
					// OAuth endpoints can echo credential material.
					outcome = "failed";
					return undefined;
				}
				if (
					typeof current.accountId === "string" &&
					typeof refreshed.accountId === "string" &&
					current.accountId !== refreshed.accountId
				) {
					// The slot now resolves to a different account. Persisting would
					// silently authenticate as an account the operator did not choose --
					// the exact concurrency failure this extension exists to avoid.
					outcome = "identity-changed";
					return undefined;
				}
				const merged: RefreshableCredential = {
					...current,
					...refreshed,
					type: "oauth",
				};
				if (!isOAuthRefreshCredential(merged)) {
					outcome = "failed";
					return undefined;
				}
				outcome = "refreshed";
				return merged;
			});
		} catch {
			// Record only bounded metadata. The thrown value can originate in an OAuth
			// implementation and is therefore not safe diagnostic material.
			outcome = "failed";
		}

		return recordOutcome(this.#diagnostics, providerId, outcome);
	}
}
