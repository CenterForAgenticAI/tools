import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import { parseModelId, type AgentConfig } from "./agents.js";
import { logDelegateDiagnostic } from "./diagnostics.js";
import { isCapacityFailureMessage, isTransientWorkerErrorMessage } from "./refusal.js";

export type ModelScope = ReadonlySet<string>;

function modelRef(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

/**
 * Rank one credentialed route by how it is paid for, lowest first.
 *
 * A bare model ID names a model, never an account, so every credentialed route
 * that serves it is a legitimate candidate and pi-delegate picks the order. It
 * prefers a flat-rate subscription over metered credit because the two are not
 * interchangeable to the operator: a subscription seat is already bought, and
 * silently spending an API key alongside it is a cost the caller never asked
 * for. `openai/<id>` (API key) sorting ahead of `openai-codex/<id>`
 * (subscription) purely because pi-ai constructs the built-in providers in
 * that order is an accident of registration, not a routing decision.
 *
 * Deliberately coarse. Cooldown, disable, exhaustion, and account priority
 * belong to the pi-multi-account route resolver (issue #262); this is only the
 * auth-type preference, and it must not grow into a second policy engine.
 */
function routeAuthRank(registry: ModelRegistry, model: Pick<Model<Api>, "provider" | "id">): number {
	const runtime = (registry as unknown as {
		runtime?: { isUsingSubscription?: (providerId: string) => boolean };
	}).runtime;
	// Subscription detection lives on ModelRuntime, which the ModelRegistry
	// facade does not re-export. Absence is not an error: a runtime without it
	// simply leaves every route at the OAuth/API-key distinction below.
	if (typeof runtime?.isUsingSubscription === "function") {
		try {
			if (runtime.isUsingSubscription(model.provider)) return 0;
		} catch { /* treat an ill-behaved runtime as "not a subscription" */ }
	}
	const usingOAuth = (registry as unknown as {
		isUsingOAuth?: (model: Pick<Model<Api>, "provider" | "id">) => boolean;
	}).isUsingOAuth;
	if (typeof usingOAuth === "function") {
		try {
			if (usingOAuth.call(registry, model)) return 1;
		} catch { /* treat an ill-behaved registry as "not OAuth" */ }
	}
	return 2;
}

/**
 * Order credentialed routes for one bare model ID by auth type.
 *
 * Sorting is stable, so routes sharing a rank keep the registry's own order and
 * this never becomes a hidden account-priority mechanism.
 */
function orderRoutesByAuth<T extends Pick<Model<Api>, "provider" | "id">>(
	registry: ModelRegistry,
	models: readonly T[],
): T[] {
	return models
		.map((model, index) => ({ model, index, rank: routeAuthRank(registry, model) }))
		.sort((left, right) => left.rank - right.rank || left.index - right.index)
		.map(({ model }) => model);
}

/**
 * The logical provider that owns multi-account failover, cooldown, exhaustion,
 * and account priority. A bare model id must reach it: binding a bare id to one
 * physical route instead can fail with `Provider is not configured` while live
 * routes for the same model sit unused. pi-multi-account
 * keeps the bare `<model-id>` as the identity for a unified selection, so bare
 * meaning unified is the same contract on both surfaces.
 */
const UNIFIED_PROVIDER = "unified";

/**
 * Order credentialed routes for one bare model id, unified route first.
 *
 * A `unified` route is preferred over every physical one because it is the only
 * candidate that carries failover; the physical routes stay behind it, still
 * auth-ranked, as the escape path for when no unified row serves the id. This is
 * strictly additive: with no unified row the result is exactly `orderRoutesByAuth`.
 */
function orderRoutesPreferringUnified<T extends Pick<Model<Api>, "provider" | "id">>(
	registry: ModelRegistry,
	models: readonly T[],
): T[] {
	const ranked = orderRoutesByAuth(registry, models);
	const unified = ranked.filter((model) => model.provider === UNIFIED_PROVIDER);
	if (unified.length === 0) return ranked;
	const physical = ranked.filter((model) => model.provider !== UNIFIED_PROVIDER);
	return [...unified, ...physical];
}


export function modelRefsFromSessionScope(
	scopedModels: readonly { model: Pick<Model<Api>, "provider" | "id"> }[] | undefined,
): ModelScope | undefined {
	if (!scopedModels?.length) return undefined;
	return new Set(scopedModels.map(({ model }) => modelRef(model)));
}

/**
 * Derive the parent-session model scope from an extension context.
 *
 * `scopedModels` first appears on the extension context in pi-coding-agent
 * 0.83.0. On an older runtime (0.80.6 peer) the property is absent entirely,
 * which is distinguishable from "present but empty": absence means scope
 * CANNOT be enforced, so we warn (throttled, file-sink) instead of silently
 * running unrestricted while the parent session believes `--models` applies.
 */
export function modelScopeFromExtensionContext(ctx: unknown, agentDir?: string): ModelScope | undefined {
	const source = ctx as { scopedModels?: readonly { model: Pick<Model<Api>, "provider" | "id"> }[] };
	if (typeof source !== "object" || source === null || !("scopedModels" in source)) {
		logDelegateDiagnostic(
			"session model scope unavailable: this Pi runtime does not expose extension-context " +
				"scopedModels (requires pi-coding-agent >= 0.83.0); delegated models run unrestricted",
			{ ...(agentDir ? { agentDir } : {}), level: "warn", throttleKey: "model-scope-unavailable" },
		);
		return undefined;
	}
	return modelRefsFromSessionScope(source.scopedModels);
}

export function isModelInScope(model: Pick<Model<Api>, "provider" | "id">, scope?: ModelScope): boolean {
	return !scope?.size || scope.has(modelRef(model));
}

export function describeModelScope(scope?: ModelScope): string {
	return scope?.size ? [...scope].sort().join(", ") : "unrestricted";
}

export function modelScopeDiagnostic(scope?: ModelScope): string {
	return scope?.size ? `. Active session scope: ${describeModelScope(scope)}` : "";
}

export function workerModelFailureMessage(
	agentName: string,
	attemptedRefs: readonly string[],
	scope?: ModelScope,
): string {
	return `Could not resolve worker model for agent ${agentName}. ` +
		`Tried: ${attemptedRefs.join(" → ") || "(no refs)"}${modelScopeDiagnostic(scope)}`;
}

export function findModel(
	registry: ModelRegistry,
	provider: string | undefined,
	id: string,
	scope?: ModelScope,
): Model<any> | undefined {
	if (provider) {
		// Explicit routes preserve operator intent; scope may still reject them.
		const model = registry.find(provider, id);
		return model && isModelInScope(model, scope) ? model : undefined;
	}

	// A bare ID resolves only to a credentialed route, unified first so it
	// inherits multi-account failover, then physical routes subscription-first.
	// The former fallback to registry.getAll() is gone: an uncredentialed provider
	// cannot serve the turn, so offering it as a candidate only converts an
	// unresolvable reference into a provider-auth failure one dispatch later.
	// Resolving to nothing here instead surfaces the configured refs through
	// workerModelFailureMessage, before any provider call is made.
	const credentialed = registry.getAvailable().filter((model) =>
		model.id === id && isModelInScope(model, scope));
	return orderRoutesPreferringUnified(registry, credentialed)[0];

}

type WorkerModel = NonNullable<ReturnType<typeof findModel>>;

interface WorkerModelRef {
	ref: string;
	provider?: string;
	id: string;
}

export interface WorkerModelChoice {
	readonly model: WorkerModel;
	readonly canonicalRef: string;
}

export interface WorkerModelRung {
	readonly ref: string;
	readonly choices: readonly WorkerModelChoice[];
	/** The first choice, retained as a convenient description of the rung. */
	readonly choice?: WorkerModelChoice;
}

export interface WorkerModelPlan {
	readonly rungs: readonly WorkerModelRung[];
	readonly primary: WorkerModelChoice;
}

export interface WorkerModelPlanOptions {
	mainModel?: { provider: string; id: string };
	scope?: ModelScope;
}

export interface WorkerModelPlanFailure {
	readonly agentName: string;
	readonly attemptedRefs: readonly string[];
	readonly message: string;
}

export type PlannedWorkerRequests<T> =
	| { kind: "planned"; requests: Array<T & { modelPlan: WorkerModelPlan }> }
	| { kind: "failure"; failure: WorkerModelPlanFailure };

function planWorkerModel(
	registry: ModelRegistry,
	agent: AgentConfig,
	options: WorkerModelPlanOptions,
): WorkerModelPlan | WorkerModelPlanFailure {
	const refs: WorkerModelRef[] = [];
	const configuredRoutes = new Set<string>();
	const addRef = (rung: WorkerModelRef): void => {
		const key = `${rung.provider ?? ""}\0${rung.id}`;
		if (configuredRoutes.has(key)) return;
		configuredRoutes.add(key);
		refs.push(rung);
	};

	for (const ref of [agent.model, ...(agent.fallbackModels ?? [])]) {
		if (!ref) continue;
		const route = options.mainModel && ref === options.mainModel.id
			? options.mainModel
			: parseModelId(ref);
		addRef({ ref, ...route });
	}
	if (options.mainModel) {
		addRef({
			ref: `${options.mainModel.provider}/${options.mainModel.id} (main)`,
			...options.mainModel,
		});
	}

	const rungs: WorkerModelRung[] = [];
	const resolvedRoutes = new Set<string>();
	let primary: WorkerModelChoice | undefined;
	for (const rung of refs) {
		const primaryModel = findModel(registry, rung.provider, rung.id, options.scope) as WorkerModel | undefined;
		const isBareId = rung.provider === undefined;
		const candidates: WorkerModel[] = [];
		const candidateRoutes = new Set<string>();
		const addCandidate = (model: WorkerModel | undefined): void => {
			if (!model || !isModelInScope(model, options.scope)) return;
			const canonicalRef = modelRef(model);
			if (candidateRoutes.has(canonicalRef) || resolvedRoutes.has(canonicalRef)) return;
			candidateRoutes.add(canonicalRef);
			candidates.push(model);
		};

		// The primary match is already the highest-ranked credentialed route.
		addCandidate(primaryModel);
		// Bare IDs are a rung with every credentialed in-scope route behind them,
		// unified first so the ladder reaches multi-account failover, then physical
		// routes subscription-first so a rollover reaches a seat that is already
		// paid for before a metered one. Explicit provider/id refs, including the
		// implicit `(main)` rung, stay exact. Uncredentialed catalog entries are
		// not candidates: they cannot serve a turn, so a rung that rolled onto one
		// would spend an attempt to arrive at a provider-auth failure.
		if (isBareId) {
			const credentialed = (registry.getAvailable() as WorkerModel[])
				.filter((model) => model.id === rung.id);
			for (const model of orderRoutesPreferringUnified(registry, credentialed)) addCandidate(model);
		}

		const choices = candidates.map((model) => ({ model, canonicalRef: modelRef(model) }));
		for (const choice of choices) resolvedRoutes.add(choice.canonicalRef);
		primary ??= choices[0];
		rungs.push({ ref: rung.ref, choices, choice: choices[0] });
	}

	if (primary) return { rungs, primary };
	const attemptedRefs = rungs.map(({ ref }) => ref);
	return {
		agentName: agent.name,
		attemptedRefs,
		message: workerModelFailureMessage(agent.name, attemptedRefs, options.scope),
	};
}

export function planWorkerModelRequests<T extends { agent: AgentConfig; modelPlan?: WorkerModelPlan }>(
	registry: ModelRegistry,
	requests: readonly T[],
	options: WorkerModelPlanOptions = {},
): PlannedWorkerRequests<T> {
	// Return a fresh complete batch only after every request is resolvable.
	const planned: Array<T & { modelPlan: WorkerModelPlan }> = [];
	const plansByPolicy = new Map<string, WorkerModelPlan>();
	for (const request of requests) {
		const policyKey = JSON.stringify([request.agent.model, request.agent.fallbackModels ?? []]);
		const plan = request.modelPlan ?? plansByPolicy.get(policyKey) ??
			planWorkerModel(registry, request.agent, options);
		if (!("primary" in plan)) return { kind: "failure", failure: plan };
		plansByPolicy.set(policyKey, plan);
		planned.push({ ...request, modelPlan: plan });
	}
	return { kind: "planned", requests: planned };
}

export class WorkerModelCursor {
	readonly #plan: WorkerModelPlan;
	readonly #attemptedRefs: string[] = [];
	readonly #visitedRungs = new Set<string>();
	#nextRungIndex = 0;
	#nextChoiceIndex = 0;

	constructor(plan: WorkerModelPlan) {
		this.#plan = plan;
	}

	get attemptedRefs(): readonly string[] {
		return this.#attemptedRefs;
	}

	/** Whether a candidate remains behind the current or a later rung. */
	hasNext(includeImplicitMain = true): boolean {
		const currentRung = this.#plan.rungs[this.#nextRungIndex];
		if (
			this.#nextChoiceIndex < (currentRung?.choices.length ?? 0) &&
			(includeImplicitMain || !currentRung?.ref.endsWith(" (main)"))
		) return true;
		for (let index = this.#nextRungIndex + 1; index < this.#plan.rungs.length; index += 1) {
			const rung = this.#plan.rungs[index]!;
			if (rung.choices.length > 0 && (includeImplicitMain || !rung.ref.endsWith(" (main)"))) return true;
		}
		return false;
	}

	/**
	 * Whether another route remains behind the CURRENT rung.
	 *
	 * A rung is one logical model, so every remaining choice here is a different
	 * account serving the same model. That is the only advancement an auth-class
	 * failure may license: it re-routes the account without ever substituting a
	 * different model, and it goes false once the rung is exhausted so a broken
	 * credential still terminates the run.
	 */
	hasNextWithinRung(): boolean {
		const currentRung = this.#plan.rungs[this.#nextRungIndex];
		return this.#nextChoiceIndex < (currentRung?.choices.length ?? 0);
	}

	next(excludedCanonicalRefs: ReadonlySet<string> = new Set()): WorkerModelChoice | undefined {
		while (this.#nextRungIndex < this.#plan.rungs.length) {
			const rung = this.#plan.rungs[this.#nextRungIndex]!;
			if (!this.#visitedRungs.has(rung.ref)) {
				this.#visitedRungs.add(rung.ref);
				this.#attemptedRefs.push(rung.ref);
			}
			while (this.#nextChoiceIndex < rung.choices.length) {
				const choice = rung.choices[this.#nextChoiceIndex++]!;
				if (!excludedCanonicalRefs.has(choice.canonicalRef)) return choice;
			}
			this.#nextRungIndex += 1;
			this.#nextChoiceIndex = 0;
		}
		return undefined;
	}
}

/**
 * Whether a run has a real route left after its current model failed.
 *
 * Declared fallback refs remain a cheap optimistic fast path: resolution will
 * report the configured refs if they turn out to be unavailable. Otherwise,
 * the cursor exposes the remaining sibling routes behind a bare rung without
 * rescanning the registry.
 */
export function hasWorkerModelAlternatives(
	cursor: WorkerModelCursor | undefined,
	agent: AgentConfig,
): boolean {
	return Boolean(agent.fallbackModels?.length) || Boolean(cursor?.hasNext(false));
}

export function shouldAdvanceLadderForRouteFailure(
	error: string,
	cursor: WorkerModelCursor | undefined,
	agent: AgentConfig,
): boolean {
	return (isTransientWorkerErrorMessage(error) || isCapacityFailureMessage(error)) &&
		hasWorkerModelAlternatives(cursor, agent);
}

/**
 * Whether an auth-class failure may re-route to another account for the SAME
 * model.
 *
 * Deliberately narrower than hasWorkerModelAlternatives: it consults only the
 * current rung and ignores declared fallbackModels entirely. A missing or
 * rejected credential is not a reason to run the task on a different model, so
 * this never reaches the next declared ref, and it goes false once the rung's
 * accounts are exhausted -- at which point the caller reports the auth failure
 * rather than masking it.
 */
export function hasSameModelRouteAlternative(
	cursor: WorkerModelCursor | undefined,
): boolean {
	return Boolean(cursor?.hasNextWithinRung());
}

