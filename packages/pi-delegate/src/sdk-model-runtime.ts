import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

/**
 * Opaque structural stand-in for Pi's ModelRuntime.
 *
 * The SDK does not expose a stable ModelRuntime type across its supported
 * generations, and the concrete runtime instance must be passed through
 * unchanged. The optional methods name only the cross-version operations used
 * by adapters while keeping generated declarations consumable by both SDK
 * generations.
 */
export type ModelRuntimeLike = object & {
	complete?: (model: unknown, context: unknown, options?: unknown) => Promise<unknown>;
	getAuth?: (providerId: string, options?: { signal?: AbortSignal }) => Promise<unknown>;
};

/** Provider-auth facade added after the oldest supported ModelRegistry. */
export interface ProviderAuthRegistryLike {
	getProviderAuth?: (providerId: string) => Promise<unknown>;
}

export type ProviderAuthReader = (providerId: string) => Promise<unknown>;

/**
 * Resolve provider-auth access without requiring it on the active SDK's
 * ModelRegistry type. The bound closure preserves implementations that read
 * registry state through `this`.
 */
export function providerAuthReader(modelRegistry: unknown): ProviderAuthReader | undefined {
	if (typeof modelRegistry !== "object" || modelRegistry === null) return undefined;
	const getProviderAuth = (modelRegistry as ProviderAuthRegistryLike).getProviderAuth;
	if (typeof getProviderAuth !== "function") return undefined;
	return (providerId) => getProviderAuth.call(modelRegistry, providerId);
}

/**
 * Session model fields understood across the supported SDK boundary.
 *
 * A record is intentional: either SDK generation rejects the other one's
 * named fields at compile time. Keeping the unsafe shape at this one adapter
 * lets the surrounding createAgentSession object remain checked against the
 * active SDK while the selected fields are passed through unchanged.
 */
export type ChildModelSessionOptions = Record<string, unknown>;

/**
 * Model/auth inputs shared by pi-delegate's child AgentSession factories.
 *
 * The SDK's modern session shape uses one canonical `modelRuntime` option. The
 * extension context still exposes a ModelRegistry compatibility facade, whose
 * runtime is the same instance that owns extension-registered providers. The
 * alternate `authStorage` + `modelRegistry` shape remains required by the
 * supported SDK's session API.
 */
export interface ChildModelServices {
	modelRegistry: ModelRegistry;
	modelRuntime?: ModelRuntimeLike;
	authStorage?: object;
	/** Extension contexts lack a public ModelRuntime getter in Pi 0.80. */
	allowRegistryRuntimeFallback?: boolean;
}

/**
 * Select the session model option supported by the active Pi SDK.
 *
 * The facade's `runtime` field is intentionally accessed only at this boundary:
 * the extension context does not expose ModelRuntime directly, while passing the
 * facade's underlying runtime is necessary to preserve dynamically registered
 * providers in child sessions. The alternate branch supplies the auth and
 * registry fields required by the supported SDK session API.
 */
export function childModelSessionOptions(
	services: ChildModelServices,
): ChildModelSessionOptions {
	const registry = services.modelRegistry as unknown as {
		runtime?: ModelRuntimeLike;
		find?: unknown;
		getAll?: unknown;
	};
	const canUseRegistryRuntime = services.allowRegistryRuntimeFallback ||
		(typeof registry.find === "function" && typeof registry.getAll === "function");
	const modelRuntime = services.modelRuntime ?? (
		canUseRegistryRuntime ? registry.runtime : undefined
	);
	if (modelRuntime) return { modelRuntime };

	if (services.authStorage) {
		return {
			authStorage: services.authStorage,
			modelRegistry: services.modelRegistry,
		};
	}

	// Let createAgentSession construct a runtime from agentDir when neither a
	// facade runtime nor auth storage is available.
	return {};
}
