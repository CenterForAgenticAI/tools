/**
 * The bridge from a logical route to a physical account's provider.
 *
 * The logical provider selects an account and hands this function
 * `{ providerId, modelId, context, options }`. The options it hands over were
 * resolved by the host against the *declaration*, whose `apiKey` is
 * {@link DECLARATION_PLACEHOLDER_KEY} — a fixed placeholder, not a credential.
 * This module resolves the real per-account credential and dispatches to the
 * provider that owns the physical model.
 *
 * It reproduces what `ModelRuntime.prepareRequest` does, because the
 * extension-facing `ModelRegistry` facade exposes no streaming entry point:
 * it has `complete`, but no `stream`, so there is no host call that would
 * apply these transformations for us. Each rule below is copied from that
 * function and is load-bearing:
 *
 * - `apiKey` is **overwritten**, never merged under. The host resolves
 *   `providerOptions.apiKey ?? resolution.auth.apiKey`, so the caller's value
 *   wins; forwarding the placeholder would not merely travel alongside the
 *   real credential, it would suppress it.
 * - `headers` merge auth-first with caller headers layered over, using the
 *   host's case-insensitive rule.
 * - `baseUrl` is applied to the **model**, not to the options.
 * - `env` merges auth env under caller env.
 */
import type {
	AnthropicMessagesCompat,
	Api,
	Context,
	Model,
	ModelCost,
	ProviderHeaders,
	SimpleStreamOptions,
	ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { LogicalDispatchCall } from "./logical-provider.js";

/** Derived from the host so this cannot drift from the real return shape. */
type ResolvedAuth = Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>;

/** Exactly the registry surface a dispatch needs, and nothing more. */
export type DispatchRegistry = Pick<
	ModelRegistry,
	"find" | "getProvider" | "getApiKeyAndHeaders"
>;

/**
 * The host's header merge, reproduced.
 *
 * `mergeHeaders` is module-local in `dist/core/model-runtime.js` and appears in
 * no export surface, so it cannot be imported. The semantics are the
 * load-bearing part, and the case-insensitive delete is the subtle half: a
 * naive `{ ...base, ...override }` keeps both `Authorization` and
 * `authorization` when the two sides differ in case, sending duplicate
 * authentication headers.
 *
 * Returns `undefined` when both sides are absent, matching the host.
 */
export function mergeProviderHeaders(
	base: ProviderHeaders | undefined,
	override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
	if (!base && !override) return undefined;
	const merged: ProviderHeaders = { ...base };
	for (const [name, value] of Object.entries(override ?? {})) {
		const lowerName = name.toLowerCase();
		for (const existingName of Object.keys(merged)) {
			if (existingName.toLowerCase() === lowerName) delete merged[existingName];
		}
		merged[name] = value;
	}
	return merged;
}

/** Raised when an attempt cannot be made at all, so a sibling can be tried. */
export class LogicalDispatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LogicalDispatchError";
	}
}

type CallerOptions = {
	headers?: ProviderHeaders;
	env?: Record<string, string>;
	[key: string]: unknown;
};

function copyThinkingLevelMap(
	value: ThinkingLevelMap | undefined,
): ThinkingLevelMap | undefined {
	if (value === undefined) return undefined;
	const copy: ThinkingLevelMap = {};
	if (value.off !== undefined) copy.off = value.off;
	if (value.minimal !== undefined) copy.minimal = value.minimal;
	if (value.low !== undefined) copy.low = value.low;
	if (value.medium !== undefined) copy.medium = value.medium;
	if (value.high !== undefined) copy.high = value.high;
	if (value.xhigh !== undefined) copy.xhigh = value.xhigh;
	if (value.max !== undefined) copy.max = value.max;
	return copy;
}

function copyModelCost(value: ModelCost): ModelCost {
	const copy: ModelCost = {
		input: value.input,
		output: value.output,
		cacheRead: value.cacheRead,
		cacheWrite: value.cacheWrite,
	};
	if (value.tiers !== undefined) {
		copy.tiers = value.tiers.map((tier) => ({
			input: tier.input,
			output: tier.output,
			cacheRead: tier.cacheRead,
			cacheWrite: tier.cacheWrite,
			inputTokensAbove: tier.inputTokensAbove,
		}));
	}
	return copy;
}

function copyAnthropicCompat(
	value: AnthropicMessagesCompat | undefined,
): AnthropicMessagesCompat | undefined {
	if (value === undefined) return undefined;
	const copy: AnthropicMessagesCompat = {};
	if (value.supportsEagerToolInputStreaming !== undefined) {
		copy.supportsEagerToolInputStreaming = value.supportsEagerToolInputStreaming;
	}
	if (value.supportsLongCacheRetention !== undefined) {
		copy.supportsLongCacheRetention = value.supportsLongCacheRetention;
	}
	if (value.sendSessionAffinityHeaders !== undefined) {
		copy.sendSessionAffinityHeaders = value.sendSessionAffinityHeaders;
	}
	if (value.supportsCacheControlOnTools !== undefined) {
		copy.supportsCacheControlOnTools = value.supportsCacheControlOnTools;
	}
	if (value.supportsTemperature !== undefined) {
		copy.supportsTemperature = value.supportsTemperature;
	}
	if (value.forceAdaptiveThinking !== undefined) {
		copy.forceAdaptiveThinking = value.forceAdaptiveThinking;
	}
	if (value.allowEmptySignature !== undefined) {
		copy.allowEmptySignature = value.allowEmptySignature;
	}
	if (value.supportsStrictTools !== undefined) {
		copy.supportsStrictTools = value.supportsStrictTools;
	}
	if (value.supportsToolReferences !== undefined) {
		copy.supportsToolReferences = value.supportsToolReferences;
	}
	return copy;
}

type AnthropicDispatchModel = Model<Api> & {
	api: "anthropic-messages" | "hypha-anthropic-oauth";
	compat?: AnthropicMessagesCompat;
};

function isAnthropicDispatchModel(
	model: Model<Api>,
): model is AnthropicDispatchModel {
	return (
		model.api === "anthropic-messages" ||
		model.api === "hypha-anthropic-oauth"
	);
}

function projectPhysicalModelForLogicalDispatch(
	sourceModel: Model<Api>,
	resolvedBaseUrl: string | undefined,
): Model<Api> {
	const resolvedModel = resolvedBaseUrl
		? { ...sourceModel, baseUrl: resolvedBaseUrl }
		: sourceModel;
	if (isAnthropicDispatchModel(sourceModel)) {
		const projected: Model<Api> = {
			id: sourceModel.id,
			name: sourceModel.name,
			api: sourceModel.api,
			provider: sourceModel.provider,
			baseUrl: resolvedModel.baseUrl,
			reasoning: sourceModel.reasoning,
			input: [...sourceModel.input],
			cost: copyModelCost(sourceModel.cost),
			contextWindow: sourceModel.contextWindow,
			maxTokens: sourceModel.maxTokens,
		};
		const thinkingLevelMap = copyThinkingLevelMap(sourceModel.thinkingLevelMap);
		if (thinkingLevelMap !== undefined) projected.thinkingLevelMap = thinkingLevelMap;
		const compat = copyAnthropicCompat(sourceModel.compat);
		if (compat !== undefined) projected.compat = compat;
		return projected;
	}
	return resolvedModel;
}

/**
 * Build the dispatch used by {@link LogicalProviderDeps}.
 *
 * Every lookup is live. Snapshotting the provider or its config at startup
 * would miss the base Anthropic account registered at factory time, the
 * builtin `openai-codex` provider that never enters an extension map, and
 * anything a later `add` or `rediscover` registers.
 */
export function createLogicalDispatch(
	registry: DispatchRegistry,
): (call: LogicalDispatchCall) => Promise<AsyncIterable<unknown>> {
	return async (call: LogicalDispatchCall): Promise<AsyncIterable<unknown>> => {
		const { providerId, modelId } = call;

		// `getProvider` covers extension-registered aliases, the re-asserted
		// Anthropic base, and the builtin codex provider uniformly. The
		// extension-map lookups do not: the builtin enters through the runtime
		// constructor and is absent from both of them.
		const provider = registry.getProvider(providerId);
		const model = registry.find(providerId, modelId);
		if (provider === undefined || model === undefined) {
			throw new LogicalDispatchError(
				`No registered route for ${providerId}/${modelId}.`,
			);
		}

		const auth: ResolvedAuth = await registry.getApiKeyAndHeaders(model);
		// The reason is deliberately not interpolated. A provider auth failure
		// can carry an OAuth error body, and this string reaches the host, the
		// turn's assistant message, and any diagnostic that records it.
		if (!auth.ok) {
			throw new LogicalDispatchError(
				`Could not resolve credentials for ${providerId}.`,
			);
		}
		// `ok: true` with no key is reachable, for example after a mid-session
		// logout. Writing `undefined` over the placeholder would dispatch an
		// unauthenticated request, and the resulting authentication failure is
		// indistinguishable from a real one — it would cool a healthy account.
		if (auth.apiKey === undefined) {
			throw new LogicalDispatchError(
				`No credential is available for ${providerId}.`,
			);
		}

		const callerOptions = (call.options ?? {}) as CallerOptions;
		const env =
			auth.env || callerOptions.env
				? { ...(auth.env ?? {}), ...(callerOptions.env ?? {}) }
				: undefined;

		// The override belongs on the model, matching the host. Passing it in
		// options would leave the declaration's unreachable base URL in place.
		const physicalModel = projectPhysicalModelForLogicalDispatch(
			model,
			auth.baseUrl,
		);

		// Built by assignment rather than as a literal: under
		// `exactOptionalPropertyTypes` an explicit `undefined` is not the same as
		// an absent key, and the host distinguishes them.
		const physicalOptions: Record<string, unknown> = {
			...callerOptions,
			apiKey: auth.apiKey,
		};
		const headers = mergeProviderHeaders(auth.headers, callerOptions.headers);
		if (headers === undefined) delete physicalOptions.headers;
		else physicalOptions.headers = headers;
		if (env === undefined) delete physicalOptions.env;
		else physicalOptions.env = env;

		return provider.streamSimple(
			physicalModel,
			call.context as Context,
			physicalOptions as SimpleStreamOptions,
		);
	};
}
