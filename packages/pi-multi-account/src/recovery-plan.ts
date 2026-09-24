import type { AllowedFamily, ManagedFamily, MultiAccountConfig } from "./config.js";
import { isAllowedFamily } from "./config.js";
import { resolveTierModel } from "./tier-model-resolver.js";
import type { ProviderType } from "./vendor.js";
import { sameVendor, vendorForFamily } from "./vendor.js";
import { isCanonicalManagedProviderId } from "./runtime-state.js";

/** Host-observable input modalities used to reject incompatible destinations. */
export type RecoveryInputModality = "text" | "image";

/** Capability facts projected from one physical catalog row. */
export interface RecoveryModelCapability {
	readonly modelId: string;
	readonly input: readonly RecoveryInputModality[];
	readonly supportsTools: boolean;
	readonly contextWindow: number;
}

/** One validated physical account visible when a request-local plan is built. */
export interface RecoveryPlanAccount {
	readonly providerId: string;
	readonly family: ManagedFamily;
	readonly providerType: Exclude<ProviderType, "openrouter">;
	readonly eligible: boolean;
	readonly models: readonly RecoveryModelCapability[];
}

export type RecoveryCandidateTier =
	| "same-family-subscription"
	| "owning-vendor-api"
	| "cross-family-subscription";

/** One finite provider/model pair. Logical and physical model identity stay distinct. */
export interface RecoveryCandidate {
	readonly providerId: string;
	readonly family: ManagedFamily;
	readonly providerType: Exclude<ProviderType, "openrouter">;
	readonly modelId: string;
	readonly selectedModelId: string;
	readonly tier: RecoveryCandidateTier;
	readonly substitution: "exact" | "configured";
	readonly capability: RecoveryModelCapability;
}

export type RecoveryPlanConfig = Pick<
	MultiAccountConfig,
	| "sameFamilyFailover"
	| "crossFamilyChainEnabled"
	| "crossFamilyChains"
	| "preferredModels"
	| "tierModelMap"
>;

export interface RecoveryCandidatePlanRequest {
	readonly selectedModelId: string;
	readonly originFamily: AllowedFamily;
	readonly accounts: readonly RecoveryPlanAccount[];
	readonly config: RecoveryPlanConfig;
	readonly requiredInput: readonly RecoveryInputModality[];
	readonly requiresTools: boolean;
	readonly failedPair?: Readonly<{ providerId: string; modelId: string }>;
}

function providerTypeMatchesFamily(account: RecoveryPlanAccount): boolean {
	if (account.family === "openai-codex") return account.providerType === "subscription";
	if (account.family === "openai") return account.providerType === "owning-vendor-api";
	return account.providerType === "subscription" || account.providerType === "owning-vendor-api";
}

function usableCapability(
	model: RecoveryModelCapability,
	requiredInput: readonly RecoveryInputModality[],
	requiresTools: boolean,
): boolean {
	return (
		typeof model.modelId === "string" &&
		model.modelId.length > 0 &&
		Number.isFinite(model.contextWindow) &&
		model.contextWindow > 0 &&
		requiredInput.every((input) => model.input.includes(input)) &&
		(!requiresTools || model.supportsTools)
	);
}

function immutableCapability(model: RecoveryModelCapability): RecoveryModelCapability {
	return Object.freeze({
		modelId: model.modelId,
		input: Object.freeze([...model.input]),
		supportsTools: model.supportsTools,
		contextWindow: model.contextWindow,
	});
}

/** Build the immutable, deterministic candidate sweep for one logical call. */
export function buildRecoveryCandidatePlan(
	request: RecoveryCandidatePlanRequest,
): readonly RecoveryCandidate[] {
	if (typeof request.selectedModelId !== "string" || request.selectedModelId.length === 0) {
		return Object.freeze([]);
	}

	const accounts: RecoveryPlanAccount[] = [];
	const seenAccounts = new Set<string>();
	for (const account of request.accounts) {
		if (
			!account.eligible ||
			!isCanonicalManagedProviderId(account.providerId, account.family) ||
			!providerTypeMatchesFamily(account) ||
			seenAccounts.has(account.providerId)
		) {
			continue;
		}
		seenAccounts.add(account.providerId);
		accounts.push(account);
	}

	const candidates: RecoveryCandidate[] = [];
	const seenPairs = new Set<string>();
	const add = (
		account: RecoveryPlanAccount,
		model: RecoveryModelCapability | undefined,
		tier: RecoveryCandidateTier,
		substitution: RecoveryCandidate["substitution"],
	): void => {
		if (
			model === undefined ||
			!usableCapability(model, request.requiredInput, request.requiresTools)
		) {
			return;
		}
		if (
			request.failedPair?.providerId === account.providerId &&
			request.failedPair.modelId === model.modelId
		) {
			return;
		}
		const key = `${account.providerId}\u0000${model.modelId}`;
		if (seenPairs.has(key)) return;
		seenPairs.add(key);
		candidates.push(
			Object.freeze({
				providerId: account.providerId,
				family: account.family,
				providerType: account.providerType,
				modelId: model.modelId,
				selectedModelId: request.selectedModelId,
				tier,
				substitution,
				capability: immutableCapability(model),
			}),
		);
	};

	if (request.config.sameFamilyFailover) {
		const sameFamilySubscriptions = accounts.filter(
			(account) =>
				account.providerType === "subscription" &&
				account.family === request.originFamily,
		);
		for (const account of sameFamilySubscriptions) {
			add(
				account,
				account.models.find(({ modelId }) => modelId === request.selectedModelId),
				"same-family-subscription",
				"exact",
			);
		}
	}

	// Google has no supported owning-vendor-API destination. Exclude it before
	// this tier is built at all, so a malformed or hostile account shape can
	// neither expand via an exact model match nor reach resolveTierModel below.
	const owningVendorApiAccounts = accounts.filter(
		(account) =>
			account.providerType === "owning-vendor-api" &&
			account.family !== "google-antigravity" &&
			sameVendor(account.family, request.originFamily),
	);
	for (const account of owningVendorApiAccounts) {
		add(
			account,
			account.models.find(({ modelId }) => modelId === request.selectedModelId),
			"owning-vendor-api",
			"exact",
		);
	}
	for (const account of owningVendorApiAccounts) {
		// Google has no supported metered destination; the filter above already
		// excludes it, and this narrows the type for resolveTierModel below.
		if (account.family === "google-antigravity") continue;
		const resolvedModelId = resolveTierModel(
			request.selectedModelId,
			vendorForFamily(account.family),
			account.models.map(({ modelId }) => modelId),
			request.config.tierModelMap,
		);
		if (resolvedModelId === request.selectedModelId) continue;
		add(
			account,
			account.models.find(({ modelId }) => modelId === resolvedModelId),
			"owning-vendor-api",
			"configured",
		);
	}

	if (request.config.crossFamilyChainEnabled) {
		const destinationFamilies = request.config.crossFamilyChains
			.filter(({ from, to }) => from === request.originFamily && to !== from)
			.map(({ to }) => to);
		for (const destinationFamily of destinationFamilies) {
			if (!isAllowedFamily(destinationFamily)) continue;
			const destinations = accounts.filter(
				(account) =>
					account.providerType === "subscription" &&
					account.family === destinationFamily,
			);
			for (const account of destinations) {
				add(
					account,
					account.models.find(({ modelId }) => modelId === request.selectedModelId),
					"cross-family-subscription",
					"exact",
				);
			}
			for (const modelId of request.config.preferredModels[destinationFamily] ?? []) {
				for (const account of destinations) {
					add(
						account,
						account.models.find((model) => model.modelId === modelId),
						"cross-family-subscription",
						"configured",
					);
				}
			}
		}
	}

	return Object.freeze(candidates);
}
