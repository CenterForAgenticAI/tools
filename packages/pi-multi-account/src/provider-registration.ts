/**
 * Wires discovered account slots into Pi's provider registry.
 *
 * Anthropic aliases use the exact captured upstream behavior; Codex aliases use
 * a bounded identity adapter over Pi's maintained stream. Live catalogs are
 * deep-cloned through the canonical catalog-rebinding helper. Real and spare
 * slots share one numeric registration plan so a lower spare gap is registered
 * before a higher real slot.
 */

import {
	DECLARATION_BASE_URL,
	LOGICAL_PROVIDER_DISPLAY_NAME,
	LOGICAL_PROVIDER_ID,
	assertProjectedManagedModels,
	type ModelDeclarationRow,
} from "./models-declaration.js";
import {
	NOOP_LOGICAL_ATTRIBUTION_ATTEMPT,
	createLogicalProvider,
	type LogicalAttributionLifecycle,
	type LogicalProviderDeps,
} from "./logical-provider.js";
import type {
	ExtensionAPI,
	ExtensionContext,
	ProviderConfig,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import {
	getApiProvider,
	registerApiProvider,
} from "@earendil-works/pi-ai/compat";
import { composeDisplayName } from "./account-labels.js";
import {
	createAnthropicAliasProviderConfig,
	type CapturedAnthropicProvider,
} from "./upstream-anthropic.js";
import {
	CODEX_ALIAS_API,
	buildCodexAliasFromBaseConfig,
	getCodexModelsFromRegistry,
	type CapturedCodexProvider,
} from "./codex-adapter.js";
import {
	OPENAI_ALIAS_API,
	createOpenAiAliasProviderConfig,
	openaiPlatformModels,
} from "./openai-adapter.js";
import {
	classifyProviderId,
	isProviderSlotWithinAccountLimit,
	type CredentialType,
	type ProviderSlot,
} from "./discovery.js";
import { MANAGED_FAMILIES, type ManagedFamily } from "./config.js";
import { cloneProviderModelCatalog } from "./catalog-rebinding.js";
import type { ModelSupportRegistry } from "./model-support.js";
import {
	mergeRefreshedCredentials,
	projectAntigravityOAuthCredential,
} from "./credential-lifecycle.js";
import { GOOGLE_ANTIGRAVITY_API } from "./upstream-antigravity.js";

export interface ProviderRegistrationInput {
	pi: Pick<ExtensionAPI, "registerProvider">;
	extensionContext: Pick<ExtensionContext, "modelRegistry">;
	anthropicCaptured: CapturedAnthropicProvider;
	codexCaptured: CapturedCodexProvider;
	/**
	 * Preloaded through src/upstream-antigravity.ts by the composition root.
	 * Optional so the existing composition remains inert until it owns that async load.
	 */
	antigravityConfig?: ProviderConfig;
	slots: readonly ProviderSlot[];
	spareSlots: ReadonlyMap<string, string>;
	config: {
		accountLimit: number;
		accountLabels?: Readonly<Record<string, string>>;
	};
	/**
	 * Resolves a managed account's operator-facing label. Injected so this module
	 * stays free of credential access; the caller owns credential lookup.
	 */
	resolveLabel?: (providerId: string) => string;
	/** Session-local model divergence used to prune known-unsupported aliases. */
	modelSupport?: ModelSupportRegistry;
}

export interface RegistrationRecord {
	readonly providerId: string;
	readonly family: string;
	readonly slotIndex: number;
	readonly role: "base" | "alias" | "spare";
	readonly api: string;
}

export interface ProviderRegistrationResult {
	readonly registered: readonly RegistrationRecord[];
}

interface RegistrationPlanEntry {
	readonly slot: ProviderSlot;
	readonly role: "base" | "alias" | "spare";
}

function displayLabelFor(providerId: string): string {
	const match = /-account-(\d+)$/.exec(providerId);
	return match ? `Account ${match[1]}` : "Account 1";
}

/**
 * Stamps an account's operator-facing identity onto a provider config.
 *
 * Pi renders `ProviderConfig.name` in its provider and login lists, falling back
 * to the OAuth method name. Because every managed Anthropic alias inherits the
 * same upstream OAuth config, they all rendered as an identical
 * "Claude Pro/Max", leaving an operator unable to tell which account to sign in
 * to or refresh. Setting both fields makes each account addressable.
 *
 * Returns the config unchanged when no label resolver is supplied, so callers
 * that do not care about identity keep today's exact behavior.
 */
function withAccountIdentity(
	config: ProviderConfig,
	providerId: string,
	resolveLabel: ((providerId: string) => string) | undefined,
): ProviderConfig {
	if (!resolveLabel) return config;
	const label = resolveLabel(providerId);
	const baseName = config.name ?? config.oauth?.name ?? providerId;
	const displayName = composeDisplayName(baseName, label, providerId);
	const oauth = config.oauth
		? {
				...config.oauth,
				name: composeDisplayName(config.oauth.name, label, providerId),
			}
		: undefined;
	return {
		...config,
		name: displayName,
		...(oauth === undefined ? {} : { oauth }),
	};
}

function cloneRegistrationModels(
	models: readonly ProviderModelConfig[],
	providerId: string,
): ProviderModelConfig[] {
	try {
		return structuredClone(models) as ProviderModelConfig[];
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Antigravity models for ${providerId} could not be losslessly cloned: ${detail}`,
		);
	}
}

type RegistrationModelFilter = (
	providerId: string,
	models: readonly ProviderModelConfig[],
) => readonly ProviderModelConfig[];

/**
 * Build one isolated Antigravity provider config from the reviewed boundary.
 *
 * Exported so every caller that mints a `google-antigravity` slot -- discovery
 * (`registerDiscoveredProviders` below) and the composition root's interactive
 * `/multi-account add google-antigravity` dispatch -- shares this single
 * OAuth-credential-projection wrapper instead of each growing its own copy.
 * The credential projection, merge, and API-shape guard inside this function
 * are the reviewed boundary; do not duplicate them at a call site.
 */
export function createAntigravitySlotConfig(
	source: ProviderConfig,
	providerId: string,
	resolveLabel: ((providerId: string) => string) | undefined,
	filterModels: RegistrationModelFilter,
): ProviderConfig {
	if (
		source.api !== GOOGLE_ANTIGRAVITY_API ||
		!source.oauth ||
		typeof source.streamSimple !== "function" ||
		!Array.isArray(source.models)
	) {
		throw new Error(
			"The preloaded Antigravity boundary is missing its distinct API, OAuth callbacks, stream, or models.",
		);
	}
	const sourceOauth = source.oauth;
	const models = cloneRegistrationModels(
		filterModels(providerId, source.models),
		providerId,
	);
	const refreshModels = source.refreshModels;
	const config: ProviderConfig = {
		...source,
		api: GOOGLE_ANTIGRAVITY_API,
		models,
		oauth: {
			...sourceOauth,
			login: async (callbacks) =>
				projectAntigravityOAuthCredential(await sourceOauth.login(callbacks)),
			refreshToken: async (credentials, signal) =>
				mergeRefreshedCredentials(
					credentials,
					projectAntigravityOAuthCredential(
						await sourceOauth.refreshToken(
							projectAntigravityOAuthCredential(credentials),
							signal,
						),
					),
				),
			getApiKey: (credentials) =>
				sourceOauth.getApiKey(projectAntigravityOAuthCredential(credentials)),
		},
		...(refreshModels === undefined
			? {}
			: {
					refreshModels: async (context) =>
						cloneRegistrationModels(
							filterModels(
								providerId,
								await refreshModels(context),
							),
							providerId,
						),
				}),
	};
	return withAccountIdentity(config, providerId, resolveLabel);
}

function createRegistrationPlan(
	slots: readonly ProviderSlot[],
	spareSlots: ReadonlyMap<string, string>,
	accountLimit: number,
): RegistrationPlanEntry[] {
	const byProviderId = new Map<string, RegistrationPlanEntry>();
	for (const slot of slots) {
		// Guard the discovered arm before it enters the plan: a hostile discovered
		// slot above the current limit reaches neither label/catalog work,
		// registerProvider(), nor the returned ledger.
		if (!isProviderSlotWithinAccountLimit(slot, accountLimit)) continue;
		if (!byProviderId.has(slot.providerId)) {
			byProviderId.set(slot.providerId, {
				slot,
				role: slot.slotIndex === 1 ? "base" : "alias",
			});
		}
	}

	for (const [family, providerId] of spareSlots) {
		if (!MANAGED_FAMILIES.includes(family as ManagedFamily)) continue;
		if (byProviderId.has(providerId)) continue;
		const slot = classifyProviderId({
			providerId,
			credentialType: "unknown" satisfies CredentialType,
		});
		if (!slot || slot.family !== family) continue;
		// Guard the classified spare arm separately with its own current-limit
		// check before it enters the plan.
		if (!isProviderSlotWithinAccountLimit(slot, accountLimit)) continue;
		byProviderId.set(providerId, { slot, role: "spare" });
	}

	return [...byProviderId.values()].sort((left, right) => {
		const familyDelta =
			MANAGED_FAMILIES.indexOf(left.slot.family) -
			MANAGED_FAMILIES.indexOf(right.slot.family);
		return familyDelta !== 0
			? familyDelta
			: left.slot.slotIndex - right.slot.slotIndex ||
					left.slot.providerId.localeCompare(right.slot.providerId);
	});
}

/** Registers canonical real and spare slots in family/numeric order. */
export function registerDiscoveredProviders(
	input: ProviderRegistrationInput,
): ProviderRegistrationResult {
	const {
		pi,
		extensionContext,
		anthropicCaptured,
		codexCaptured,
		antigravityConfig,
		slots,
		spareSlots,
		config,
		resolveLabel,
		modelSupport,
	} = input;

	const registered: RegistrationRecord[] = [];
	let codexLiveModels: readonly ProviderModelConfig[] | undefined;
	let anthropicLiveModels: readonly ProviderModelConfig[] | undefined;
	const getCodexModels = (): readonly ProviderModelConfig[] =>
		(codexLiveModels ??= getCodexModelsFromRegistry(
			extensionContext.modelRegistry,
		));
	const getAnthropicModels = (): readonly ProviderModelConfig[] =>
		(anthropicLiveModels ??= cloneProviderModelCatalog(
			extensionContext.modelRegistry,
			"anthropic",
		));
	let openaiLiveModels: readonly ProviderModelConfig[] | undefined;
	const getOpenaiModels = (): readonly ProviderModelConfig[] =>
		(openaiLiveModels ??= openaiPlatformModels(
			extensionContext.modelRegistry,
		));
	const modelsFor = (
		providerId: string,
		models: readonly ProviderModelConfig[],
	): readonly ProviderModelConfig[] => {
		if (modelSupport === undefined) return models;
		const supported = models.filter(
			(model) => !modelSupport.isUnsupported(providerId, model.id),
		);
		// The upstream Anthropic contract rejects an empty catalog. When every
		// observed model is unsupported, retain the catalog for registration but
		// let dispatch-time selection exclude the recorded pair.
		return supported.length > 0 ? supported : models;
	};

	for (const { slot, role } of createRegistrationPlan(
		slots,
		spareSlots,
		config.accountLimit,
	)) {
		if (slot.family === "google-antigravity") {
			// The composition root owns the asynchronous upstream boundary.
			// Until it supplies that boundary, publish nothing instead of using Codex.
			if (antigravityConfig === undefined) continue;
			const aliasConfig = createAntigravitySlotConfig(
				antigravityConfig,
				slot.providerId,
				resolveLabel,
				modelsFor,
			);
			pi.registerProvider(slot.providerId, aliasConfig);
			registered.push({
				providerId: slot.providerId,
				family: slot.family,
				slotIndex: slot.slotIndex,
				role,
				api: GOOGLE_ANTIGRAVITY_API,
			});
			continue;
		}

		if (role === "spare") {
			if (slot.family === "anthropic") {
				// Upstream already registered the protected base configuration unchanged.
				// Re-register only numbered spare aliases; replacing `anthropic` with an
				// OAuth-only config would discard its captured models and stream handler.
				if (slot.slotIndex !== 1) {
					pi.registerProvider(
						slot.providerId,
						withAccountIdentity(
							{ oauth: anthropicCaptured.config.oauth },
							slot.providerId,
							resolveLabel,
						),
					);
				}
				registered.push({
					providerId: slot.providerId,
					family: slot.family,
					slotIndex: slot.slotIndex,
					role,
					api: "anthropic-messages",
				});
			} else if (slot.family === "openai") {
				// The host already registered the base `openai` provider, so a base
				// spare (an empty openai family, slot 1) is only recorded, never
				// re-registered — mirroring the anthropic spare guard. A numbered
				// spare is registered as its own api-key alias so an operator can
				// target it.
				if (slot.slotIndex !== 1) {
					pi.registerProvider(
						slot.providerId,
						withAccountIdentity(
							createOpenAiAliasProviderConfig(
								getOpenaiModels(),
								displayLabelFor(slot.providerId),
							),
							slot.providerId,
							resolveLabel,
						),
					);
				}
				registered.push({
					providerId: slot.providerId,
					family: slot.family,
					slotIndex: slot.slotIndex,
					role,
					api: OPENAI_ALIAS_API,
				});
			} else {
				// The host already registered the base openai-codex provider, so a
				// base spare (an empty codex family, slot 1) is only recorded, never
				// re-registered — mirroring the anthropic and openai spare guards. A
				// numbered spare is registered as its own alias.
				if (slot.slotIndex !== 1) {
					pi.registerProvider(
						slot.providerId,
						withAccountIdentity(
							{ oauth: codexCaptured.oauth },
							slot.providerId,
							resolveLabel,
						),
					);
				}
				registered.push({
					providerId: slot.providerId,
					family: slot.family,
					slotIndex: slot.slotIndex,
					role,
					api: "openai-codex-responses",
				});
			}
			continue;
		}

		if (slot.family === "anthropic") {
			if (role === "base") {
				registered.push({
					providerId: slot.providerId,
					family: slot.family,
					slotIndex: slot.slotIndex,
					role,
					api: "anthropic-messages",
				});
			} else {
				const aliasConfig = withAccountIdentity(
					createAnthropicAliasProviderConfig(
						anthropicCaptured,
						modelsFor(slot.providerId, getAnthropicModels()),
					),
					slot.providerId,
					resolveLabel,
				);
				pi.registerProvider(slot.providerId, aliasConfig);
				registered.push({
					providerId: slot.providerId,
					family: slot.family,
					slotIndex: slot.slotIndex,
					role,
					api: aliasConfig.api ?? "hypha-anthropic-oauth",
				});
			}
			continue;
		}

		if (slot.family === "openai") {
			if (role === "base") {
				// The host already registered the base `openai` provider (api-key
				// auth over the platform catalog; the pinned Pi ships it). Re-
				// registering it would replace that host provider and start another
				// availability refresh, so — exactly like the anthropic and
				// openai-codex base slots — we only RECORD it and leave the host
				// provider untouched. Only numbered aliases, which the host does not
				// register, get an api-key alias config.
				registered.push({
					providerId: slot.providerId,
					family: slot.family,
					slotIndex: slot.slotIndex,
					role,
					api: OPENAI_ALIAS_API,
				});
			} else {
				const aliasConfig = withAccountIdentity(
					createOpenAiAliasProviderConfig(
						getOpenaiModels(),
						displayLabelFor(slot.providerId),
					),
					slot.providerId,
					resolveLabel,
				);
				pi.registerProvider(slot.providerId, aliasConfig);
				registered.push({
					providerId: slot.providerId,
					family: slot.family,
					slotIndex: slot.slotIndex,
					role,
					api: OPENAI_ALIAS_API,
				});
			}
			continue;
		}

		if (role === "base") {
			// The host already registered the native openai-codex base provider with
			// its real OAuth lifecycle (login/refresh/toAuth from stored creds) and
			// model catalog. Re-registering it would clobber that native auth with
			// our alias-shaped config, so — exactly like the anthropic base — we only
			// RECORD the base slot and leave the host provider untouched (coexistence).
			registered.push({
				providerId: slot.providerId,
				family: slot.family,
				slotIndex: slot.slotIndex,
				role,
				api: "openai-codex-responses",
			});
		} else {
			const aliasConfig = withAccountIdentity(
				buildCodexAliasFromBaseConfig(
					codexCaptured,
					modelsFor(slot.providerId, getCodexModels()),
					displayLabelFor(slot.providerId),
				),
				slot.providerId,
				resolveLabel,
			);
			pi.registerProvider(slot.providerId, aliasConfig);
			registered.push({
				providerId: slot.providerId,
				family: slot.family,
				slotIndex: slot.slotIndex,
				role,
				api: CODEX_ALIAS_API,
			});
		}
	}

	return { registered };
}

/**
 * Put the logical `unified` provider in front of the host.
 *
 * Registration is separate from construction so a caller can register without
 * driving a request, and drive a request without a host.
 *
 * This adds one provider and touches nothing else. In particular it never
 * re-registers or mutates the base `anthropic` or `openai-codex` providers:
 * those are recorded elsewhere in this module precisely so their native
 * configuration and auth survive, and re-registering base Codex would clobber
 * that native auth with an alias-shaped config. The physical aliases stay
 * registered exactly as they were; the logical provider sits alongside them.
 *
 * Row visibility is not decided here. Which models appear in the picker is the
 * host's business, expressed through its own `enabledModels` setting.
 */
function isAssistantMessageEvent(value: unknown): value is AssistantMessageEvent {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		typeof value.type === "string"
	);
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
	return (
		typeof value === "object" &&
		value !== null &&
		"role" in value &&
		value.role === "assistant"
	);
}

function hasStreamResult(
	value: AsyncIterable<unknown>,
): value is AsyncIterable<unknown> & { result(): Promise<unknown> } {
	return "result" in value && typeof value.result === "function";
}

function deferredLogicalProviderStream(
	upstream: Promise<AsyncIterable<unknown>>,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const events: AssistantMessageEvent[] = [];
	const waiters = new Set<() => void>();
	let completed = false;
	let failure: unknown;
	let terminal: AssistantMessage | undefined;
	const wake = (): void => {
		for (const waiter of waiters) waiter();
		waiters.clear();
	};
	const pump = (async (): Promise<void> => {
		try {
			const source = await upstream;
			for await (const event of source) {
				if (!isAssistantMessageEvent(event)) {
					throw new TypeError("The logical provider emitted an invalid stream event.");
				}
				events.push(event);
				if (event.type === "done") terminal = event.message;
				else if (event.type === "error") terminal = event.error;
				wake();
			}
			if (terminal === undefined && hasStreamResult(source)) {
				const result = await source.result();
				if (!isAssistantMessage(result)) {
					throw new TypeError("The logical provider stream returned an invalid result.");
				}
				terminal = result;
			}
		} catch (cause) {
			failure = cause;
		} finally {
			completed = true;
			wake();
		}
	})();
	stream[Symbol.asyncIterator] = async function* (): AsyncIterator<AssistantMessageEvent> {
		let index = 0;
		while (true) {
			while (index < events.length) {
				yield events[index++]!;
			}
			if (completed) {
				if (failure !== undefined) throw failure;
				return;
			}
			await new Promise<void>((resolve) => waiters.add(resolve));
		}
	};
	stream.result = async (): Promise<AssistantMessage> => {
		await pump;
		if (failure !== undefined) throw failure;
		if (terminal === undefined) {
			throw new Error("The logical provider stream ended without a terminal message.");
		}
		return terminal;
	};
	return stream;
}

/**
 * Identifies this package's logical `unified` entry in pi-ai's process-global
 * API registry. It remains distinct from `ALIAS_API_SOURCE_ID` so Pi's
 * generation reset can track the two extension-owned registrations separately.
 */
export const LOGICAL_API_SOURCE_ID = "hyphagroup-pi-multi-account-unified";

/**
 * The registration seam, injected only so tests can prove fail-closed ordering.
 * Production uses a factory-generation registrar created by
 * {@link createLogicalApiRegistrarForFactoryGeneration}.
 */
export type LogicalApiRegistrar = (
	logicalStream: NonNullable<ProviderConfig["streamSimple"]>,
) => () => void;

type LogicalStream = NonNullable<ProviderConfig["streamSimple"]>;

interface LogicalApiStreamOwner {
	readonly owner: symbol;
	readonly stream: LogicalStream;
}

interface LogicalApiRegistryGeneration {
	readonly provider: NonNullable<ReturnType<typeof getApiProvider>>;
	readonly streams: LogicalApiStreamOwner[];
}

/**
 * The generation currently installed in pi-ai's process-global registry.
 *
 * Several in-process Pi sessions load this module through one host module
 * instance. Their factory registrars join this generation while its exact
 * wrapped provider still occupies the registry. `resetApiProviders()` breaks
 * that identity on reload, so the next factory creates a fresh generation and
 * cannot fall back to a stale pre-reload session stream.
 */
let currentLogicalApiGeneration: LogicalApiRegistryGeneration | undefined;

function createLogicalApiRegistryGeneration(): LogicalApiRegistryGeneration {
	const streams: LogicalApiStreamOwner[] = [];
	const currentStream: LogicalStream = (model, context, options) => {
		const active = streams.at(-1);
		if (active === undefined) {
			throw new Error("No active unified logical provider session is available.");
		}
		return active.stream(model, context, options);
	};

	// Deliberately uncast. `SimpleStreamOptions` extends `StreamOptions` with
	// optional fields, so the one forwarding handler satisfies both slots today.
	// If a pi-ai upgrade changes either signature, this must fail typecheck rather
	// than be silently bridged by a cast.
	registerApiProvider(
		{
			api: LOGICAL_PROVIDER_ID,
			stream: currentStream,
			streamSimple: currentStream,
		},
		LOGICAL_API_SOURCE_ID,
	);
	const provider = getApiProvider(LOGICAL_PROVIDER_ID);
	if (provider === undefined) {
		throw new Error("The unified logical API registrar did not publish its entry.");
	}
	const generation = { provider, streams };
	currentLogicalApiGeneration = generation;
	return generation;
}

function acquireLogicalApiRegistryGeneration(): LogicalApiRegistryGeneration {
	const registered = getApiProvider(LOGICAL_PROVIDER_ID);
	if (
		currentLogicalApiGeneration !== undefined &&
		registered === currentLogicalApiGeneration.provider
	) {
		return currentLogicalApiGeneration;
	}
	return createLogicalApiRegistryGeneration();
}

/**
 * Creates the logical compat registrar owned by one extension factory generation.
 *
 * Registration is lazy so an absent or unreadable declaration publishes
 * nothing. The first matched session installs one process-global forwarding
 * entry; sibling factories join that entry rather than replacing it with a
 * session closure. Each active session contributes its exact host
 * `streamSimple`. The newest live session is current, and releasing it restores
 * the preceding live stream without unregistering the shared API id. Pi's
 * `reload()` calls `resetApiProviders()` before rerunning factories, so the next
 * generation restores the entry structurally, matching the Anthropic alias API
 * lifetime.
 */
export function createLogicalApiRegistrarForFactoryGeneration(): LogicalApiRegistrar {
	let factoryGeneration: LogicalApiRegistryGeneration | undefined;
	return (logicalStream) => {
		const registered = getApiProvider(LOGICAL_PROVIDER_ID);
		const generation =
			factoryGeneration !== undefined && registered === factoryGeneration.provider
				? factoryGeneration
				: acquireLogicalApiRegistryGeneration();
		factoryGeneration = generation;

		const owner = Symbol("logical-session-stream");
		generation.streams.push({ owner, stream: logicalStream });
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const index = generation.streams.findIndex((candidate) => candidate.owner === owner);
			if (index !== -1) generation.streams.splice(index, 1);
		};
	};
}

const registerLogicalApiWithCompat =
	createLogicalApiRegistrarForFactoryGeneration();

function registerProjectedLogicalProvider(
	pi: Pick<ExtensionAPI, "registerProvider">,
	models: ModelDeclarationRow[],
	deps: LogicalProviderDeps,
	registerLogicalApi: LogicalApiRegistrar,
): () => void {
	const provider = createLogicalProvider(deps);
	const streamSimple: NonNullable<ProviderConfig["streamSimple"]> = (
		model,
		context,
		options,
	) =>
		deferredLogicalProviderStream(
			Promise.resolve(provider.streamSimple(model, context, options)),
		);
	const providerConfig: ProviderConfig = {
		name: LOGICAL_PROVIDER_DISPLAY_NAME,
		api: LOGICAL_PROVIDER_ID,
		baseUrl: DECLARATION_BASE_URL,
		models,
		streamSimple,
	};
	// Activate the compat stream BEFORE publishing the host provider, and bind it
	// to the exact same logical stream the host provider uses. A throwing registrar
	// therefore rejects registration and leaves no logical provider publication
	// behind; provider-map and raw-compat dispatch cannot diverge in account
	// selection, failover, attribution, or request options. The registrar is
	// deliberately NOT wrapped here: swallowing its failure would publish a host
	// provider whose `unified` API cannot resolve.
	const releaseLogicalStream = registerLogicalApi(streamSimple);
	try {
		pi.registerProvider(LOGICAL_PROVIDER_ID, providerConfig);
	} catch (error) {
		// Remove only this failed session's stream. The process-global API entry is
		// generation-owned and remains available to any preceding live session.
		releaseLogicalStream();
		throw error;
	}
	return releaseLogicalStream;
}

function safeAttributionCall(call: () => void): void {
	try {
		call();
	} catch {
		// Attribution release and settlement cannot fail a host lifecycle event.
	}
}

/** Permanently release a raw reusable lifecycle at the session boundary. */
export function createSessionAttributionAdapter(
	rawLifecycle: LogicalAttributionLifecycle,
): LogicalAttributionLifecycle {
	let released = false;
	return {
		beginAttempt(route) {
			if (released) return NOOP_LOGICAL_ATTRIBUTION_ATTEMPT;
			try {
				return rawLifecycle.beginAttempt(route);
			} catch {
				return NOOP_LOGICAL_ATTRIBUTION_ATTEMPT;
			}
		},
		settle() {
			if (released) return;
			safeAttributionCall(() => rawLifecycle.settle());
		},
		shutdown() {
			if (released) return;
			released = true;
			safeAttributionCall(() => rawLifecycle.shutdown());
		},
	};
}

/** A session-scoped logical registration, disposed with the session. */
export interface LogicalProviderSessionRegistration {
	/**
	 * Tear the registration down.
	 *
	 * Idempotent by contract: the host calls `session_shutdown` on its own
	 * schedule and a caller may dispose explicitly, so both paths race by
	 * design and the second one must be a no-op rather than a double teardown.
	 */
	dispose(): void;
}

/**
 * Register the logical provider for the lifetime of one session.
 *
 * The registration is bound to a session: it registers, subscribes to
 * `session_shutdown`, and releases on whichever of shutdown or `dispose()`
 * arrives first.
 *
 * The subscription is captured and released rather than left dangling, mirroring
 * `MultiAccountLifecycle` in `./lifecycle.ts`, which is the established idiom
 * for this in the extension. Teardown is deliberately not fail-soft in the
 * `#isolated` sense: there is no diagnostic sink on this path that could report
 * a swallowed fault, so a release fault must not be hidden here.
 */
export function registerLogicalProviderForSession(
	pi: Pick<ExtensionAPI, "registerProvider" | "on">,
	projectedModels: unknown[],
	deps: LogicalProviderDeps,
	registerLogicalApi: LogicalApiRegistrar = registerLogicalApiWithCompat,
): LogicalProviderSessionRegistration {
	const models = assertProjectedManagedModels(projectedModels);
	const rawLifecycle: LogicalAttributionLifecycle = deps.attribution ?? {
		beginAttempt: () => NOOP_LOGICAL_ATTRIBUTION_ATTEMPT,
		settle: () => {},
		shutdown: () => {},
	};
	const sessionAttribution = createSessionAttributionAdapter(rawLifecycle);
	const sessionDeps = Object.defineProperty(
		Object.create(deps) as LogicalProviderDeps,
		"attribution",
		{ value: sessionAttribution, enumerable: true },
	);
	// Reassigned to the active-stream release once registration succeeds; a
	// registrar failure never installs a release.
	let releaseLogicalStream: () => void = () => {};
	try {
		releaseLogicalStream = registerProjectedLogicalProvider(
			pi,
			models,
			sessionDeps,
			registerLogicalApi,
		);
	} catch (error) {
		// registerProjectedLogicalProvider already removed any activated session
		// stream before rethrowing, so only attribution needs releasing here.
		sessionAttribution.shutdown();
		throw error;
	}

	let subscriptionsReleased = false;
	const subscriptions: unknown[] = [];
	let unsubscribe: unknown = () => {
		for (const subscription of subscriptions) {
			if (typeof subscription === "function") {
				safeAttributionCall(() => (subscription as () => void)());
			}
		}
	};
	function releaseSubscriptions(): void {
		if (subscriptionsReleased) return;
		subscriptionsReleased = true;
		if (typeof unsubscribe === "function") unsubscribe();
		unsubscribe = undefined;
	}

	// The one idempotent release for this session. It removes only this session's
	// compat stream, shuts down attribution, and releases subscriptions. The
	// generation-owned API entry remains registered until Pi resets the registry.
	// session_shutdown and dispose() race by design; all three releases are guarded.
	function releaseRegistration(): void {
		releaseLogicalStream();
		sessionAttribution.shutdown();
		releaseSubscriptions();
	}

	try {
		subscriptions.push(
			pi.on("agent_settled", () => {
				sessionAttribution.settle();
			}),
		);
		subscriptions.push(
			pi.on("session_shutdown", () => {
				releaseRegistration();
			}),
		);
	} catch (error) {
		// Subscription setup failed after host publication: deactivate this session,
		// shut attribution down, release partial subscriptions, and rethrow.
		releaseRegistration();
		throw error;
	}

	return {
		dispose() {
			releaseRegistration();
		},
	};
}
