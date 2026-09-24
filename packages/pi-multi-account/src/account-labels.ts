/**
 * Human-meaningful identity for managed accounts.
 *
 * Pi renders a provider's `name` in the login list, falling back to the OAuth
 * method name. Because the Anthropic alias inherits the upstream OAuth config
 * verbatim, every managed Anthropic account previously rendered as the same
 * "Claude Pro/Max" string, leaving an operator unable to tell which account to
 * log in to or refresh.
 *
 * This module resolves a bounded, display-safe label per provider id. It is
 * presentation-only: it performs no I/O, mutates no routing state, and never
 * retains credential material.
 */

import {
	classifyProviderId,
	isProviderSlotWithinAccountLimit,
} from "./discovery.js";

/** Hard cap on a rendered label; derived values are truncated to fit. */
const MAX_LABEL_LENGTH = 64;

/**
 * Printable ASCII excluding control characters. Labels reach a terminal UI, so
 * anything that could smuggle escape sequences is rejected outright rather
 * than escaped.
 */
const DISPLAY_SAFE = /^[\x20-\x7E]+$/;

/** Claim names that may carry a human-identifying value, in priority order. */
const IDENTITY_CLAIMS = ["email", "preferred_username", "name"] as const;

/** Bounded per-account label overrides, keyed by canonical provider id. */
export type AccountLabelConfig = Readonly<Record<string, string>>;

/**
 * Normalizes an operator-supplied or derived label. Returns undefined when the
 * value is absent, empty, unsafe to display, or not a string — callers then
 * fall back rather than surfacing a partial or hostile value.
 */
export function normalizeLabel(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	if (!DISPLAY_SAFE.test(trimmed)) return undefined;
	return trimmed.length > MAX_LABEL_LENGTH
		? trimmed.slice(0, MAX_LABEL_LENGTH)
		: trimmed;
}

/**
 * Extracts a human-identifying claim from a JWT-shaped access token.
 *
 * Only the payload segment is decoded, and only an allow-listed identity claim
 * is read; the signature, header, and every other claim are discarded. A
 * malformed, oversized, non-JWT, or unparseable token yields undefined rather
 * than throwing, so a hostile credential can never break registration or leak
 * token content into a label.
 *
 * Anthropic credentials are opaque and will always return undefined here; they
 * rely on configured labels instead.
 */
export function deriveLabelFromToken(token: unknown): string | undefined {
	if (typeof token !== "string") return undefined;
	// Bound the work: real access tokens are small, and this refuses to parse
	// arbitrarily large strings.
	if (token.length === 0 || token.length > 8_192) return undefined;
	const segments = token.split(".");
	if (segments.length !== 3) return undefined;
	const payloadSegment = segments[1];
	if (payloadSegment === undefined || payloadSegment.length === 0) {
		return undefined;
	}
	let payload: unknown;
	try {
		const decoded = Buffer.from(payloadSegment, "base64url").toString("utf8");
		if (decoded.length === 0 || decoded.length > 8_192) return undefined;
		payload = JSON.parse(decoded);
	} catch {
		return undefined;
	}
	if (typeof payload !== "object" || payload === null) return undefined;
	const record = payload as Record<string, unknown>;
	for (const claim of IDENTITY_CLAIMS) {
		const label = normalizeLabel(record[claim]);
		if (label !== undefined) return label;
	}
	// Some providers nest identity under a namespaced profile object.
	for (const value of Object.values(record)) {
		if (typeof value !== "object" || value === null) continue;
		const nested = value as Record<string, unknown>;
		for (const claim of IDENTITY_CLAIMS) {
			const label = normalizeLabel(nested[claim]);
			if (label !== undefined) return label;
		}
	}
	return undefined;
}

/**
 * A stable fingerprint identifying the real account behind a credential.
 *
 * Detects one account occupying two slots, where failover between them is
 * decorative: they share a single quota and rate limit. Codex tokens are JWTs
 * carrying a stable subject claim, so the fingerprint survives token refresh.
 * Anthropic tokens are opaque and yield undefined, which callers must treat as
 * "unknown" rather than "different account".
 */
export function accountFingerprint(token: unknown): string | undefined {
	if (typeof token !== "string" || token.length === 0) return undefined;
	if (token.length > 8_192) return undefined;
	const segments = token.split(".");
	if (segments.length !== 3) return undefined;
	const payloadSegment = segments[1];
	if (payloadSegment === undefined || payloadSegment.length === 0) {
		return undefined;
	}
	let payload: unknown;
	try {
		const decoded = Buffer.from(payloadSegment, "base64url").toString("utf8");
		if (decoded.length === 0 || decoded.length > 8_192) return undefined;
		payload = JSON.parse(decoded);
	} catch {
		return undefined;
	}
	if (typeof payload !== "object" || payload === null) return undefined;
	const subject = (payload as Record<string, unknown>)["sub"];
	if (typeof subject === "string" && subject.length > 0) return subject;
	return deriveLabelFromToken(token);
}

/**
 * Groups managed slots that resolve to the SAME underlying account.
 *
 * Returns one entry per duplicated account listing the provider ids sharing it.
 * Slots whose identity cannot be determined are never grouped, so an
 * opaque-token family produces no false positives.
 */
export function duplicateAccountGroups(
	slots: ReadonlyArray<{
		readonly providerId: string;
		readonly token?: unknown;
	}>,
): ReadonlyArray<readonly string[]> {
	const byFingerprint = new Map<string, string[]>();
	for (const { providerId, token } of slots) {
		const fingerprint = accountFingerprint(token);
		if (fingerprint === undefined) continue;
		const group = byFingerprint.get(fingerprint);
		if (group) group.push(providerId);
		else byFingerprint.set(fingerprint, [providerId]);
	}
	return [...byFingerprint.values()].filter((group) => group.length > 1);
}

/**
 * Resolves the label for one managed account.
 *
 * Precedence is deliberate: an explicitly configured label always wins, because
 * the operator's own naming convention is more meaningful than any value the
 * provider happens to embed. A derived label is the fallback, and the canonical
 * provider id is the final backstop so registration never fails for want of a
 * name.
 */
export function resolveAccountLabel(input: {
	readonly providerId: string;
	readonly configured?: AccountLabelConfig | undefined;
	readonly token?: unknown;
}): string {
	const configured = normalizeLabel(input.configured?.[input.providerId]);
	if (configured !== undefined) return configured;
	const derived = deriveLabelFromToken(input.token);
	if (derived !== undefined) return derived;
	return input.providerId;
}

/**
 * Resolves a managed account's label only when its provider id is within the
 * current validated account limit.
 *
 * This is the final label sink's own guard. It classifies `input.providerId`,
 * applies `isProviderSlotWithinAccountLimit(slot, input.accountLimit)`, and
 * returns the original provider id before indexing `configured` or invoking the
 * lazy `readToken` callback when the id is malformed or out of the current
 * limit. Only an in-range managed id reaches {@link resolveAccountLabel}. It
 * closes the label boundary independently rather than trusting every future
 * caller to remember an upstream projection.
 */
export function resolveAccountLabelWithinLimit(input: Readonly<{
	providerId: string;
	accountLimit: number;
	configured: AccountLabelConfig;
	readToken: (providerId: string) => unknown;
}>): string {
	const slot = classifyProviderId({
		providerId: input.providerId,
		credentialType: "unknown",
	});
	if (
		slot === null ||
		!isProviderSlotWithinAccountLimit(slot, input.accountLimit)
	) return input.providerId;
	return resolveAccountLabel({
		providerId: input.providerId,
		configured: input.configured,
		token: input.readToken(input.providerId),
	});
}

/**
 * Composes the string Pi shows in its login list and provider UI, pairing the
 * family's product name with the account's own label. When the label carries no
 * information beyond the provider id, the base name is returned unadorned to
 * avoid a redundant "Claude Pro/Max — anthropic-account-2".
 */
export function composeDisplayName(
	baseName: string,
	label: string,
	providerId: string,
): string {
	if (label === providerId) return baseName;
	return `${baseName} — ${label}`;
}
