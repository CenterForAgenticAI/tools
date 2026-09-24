/**
 * The two derived axes over a managed provider-family token: the vendor that
 * authors the model, and the provider type that reaches it. Both are pure
 * functions of the existing family token plus the per-slot credential type; no
 * new token is introduced and nothing here performs I/O.
 *
 * This module is the single home for the vendor mapping that `src/api-pricing.ts`
 * previously duplicated for pricing attribution.
 */

import type { ManagedFamily } from "./config.js";
import type { CredentialType } from "./discovery.js";

/** Exhaustive managed-family ownership map and the sole source of vendor identity. */
const VENDOR_BY_FAMILY = {
	anthropic: "anthropic",
	"openai-codex": "openai",
	"google-antigravity": "google",
	openai: "openai",
} as const satisfies Readonly<Record<ManagedFamily, string>>;

/** Who authors the model, independent of how an account reaches it. */
export type Vendor = (typeof VENDOR_BY_FAMILY)[ManagedFamily];

/**
 * How a managed account reaches a model:
 * - `subscription`: an OAuth subscription (Claude Pro/Max, ChatGPT/Codex).
 * - `owning-vendor-api`: the vendor's own pay-per-token platform API key.
 * - `openrouter`: the metered OpenRouter last resort.
 */
export type ProviderType = "subscription" | "owning-vendor-api" | "openrouter";

/** The vendor that authors the models a managed family serves. */
export function vendorForFamily<Family extends ManagedFamily>(
	family: Family,
): (typeof VENDOR_BY_FAMILY)[Family] {
	return VENDOR_BY_FAMILY[family];
}

/**
 * The provider type for a managed family and its discovered credential type.
 *
 * Anthropic's OAuth subscription and API key both reach the one `anthropic`
 * messages provider, so the family alone cannot decide: only a proven `api_key`
 * credential is the owning-vendor-API tier, and every other credential state
 * (including `unknown`) defaults to the established subscription. `openai-codex`
 * and `google-antigravity` are always subscriptions; the distinct `openai`
 * platform family is always owning-vendor-api regardless of credential.
 */
export function providerTypeFor(
	family: ManagedFamily,
	credentialType: CredentialType,
): Exclude<ProviderType, "openrouter"> {
	switch (family) {
		case "anthropic":
			return credentialType === "api_key"
				? "owning-vendor-api"
				: "subscription";
		case "openai":
			return "owning-vendor-api";
		case "openai-codex":
		case "google-antigravity":
			return "subscription";
	}
}

/**
 * The paid-progression order a turn descends: subscription first, then the
 * owning-vendor-API tier, then OpenRouter. Lower rank is preferred. This orders
 * the tiers only; Child 1 uses it for presentation, and the physical descent
 * that consumes it lands in Child 2.
 */
export function tierRank(providerType: ProviderType): number {
	switch (providerType) {
		case "subscription":
			return 0;
		case "owning-vendor-api":
			return 1;
		case "openrouter":
			return 2;
	}
}

/** Whether two managed families are authored by the same vendor. */
export function sameVendor(a: ManagedFamily, b: ManagedFamily): boolean {
	return vendorForFamily(a) === vendorForFamily(b);
}
