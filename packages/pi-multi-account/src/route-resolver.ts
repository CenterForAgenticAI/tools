import {
	ALLOWED_FAMILIES,
	type AllowedFamily,
	type MultiAccountConfig,
} from "./config.js";
import { ModelSupportRegistry } from "./model-support.js";
import {
	selectExactModelRouteCandidates,
	type SubscriptionManagedAccount,
} from "./routing.js";
import {
	isCanonicalManagedProviderId,
	type RuntimeState,
} from "./runtime-state.js";

export const ROUTE_RESOLVER_PURPOSE = "exact-model-routing" as const;
export const ROUTE_RESOLVER_VERSION = 1 as const;
export const ROUTE_RESOLVER_REGISTRY_KEY = Symbol.for(
	"@caair/pi-multi-account/route-resolver",
);

const MAX_MODEL_ID_LENGTH = 256;

type RouteResolverFamily = AllowedFamily;

export interface RouteResolverInput {
	readonly purpose: typeof ROUTE_RESOLVER_PURPOSE;
	readonly version: typeof ROUTE_RESOLVER_VERSION;
	readonly modelId: string;
	readonly family?: RouteResolverFamily;
	readonly preferredProviderId?: string;
	readonly excludedProviderIds?: readonly string[];
}

export interface ExactModelRoute {
	readonly providerId: string;
	readonly modelId: string;
	readonly family: RouteResolverFamily;
}

export type RouteResolverUnresolvedReason =
	| "invalid-input"
	| "unsupported-purpose"
	| "incompatible-version"
	| "unknown-model"
	| "ambiguous-model-family"
	| "family-model-mismatch"
	| "no-eligible-routes";

export interface RouteResolverResolvedResult {
	readonly purpose: typeof ROUTE_RESOLVER_PURPOSE;
	readonly version: typeof ROUTE_RESOLVER_VERSION;
	readonly status: "resolved";
	readonly reason: "eligible-routes";
	readonly routes: readonly ExactModelRoute[];
}

export interface RouteResolverUnresolvedResult {
	readonly purpose: typeof ROUTE_RESOLVER_PURPOSE;
	readonly version: typeof ROUTE_RESOLVER_VERSION;
	readonly status: "unresolved";
	readonly reason: RouteResolverUnresolvedReason;
	readonly routes: readonly [];
}

export type RouteResolverResult =
	| RouteResolverResolvedResult
	| RouteResolverUnresolvedResult;

export interface ExactModelRouteResolutionContext {
	/** Credentialed managed accounts and their live model catalogs. */
	readonly catalogAccounts: readonly SubscriptionManagedAccount[];
	/** Accounts currently eligible for automatic routing. */
	readonly accounts: readonly SubscriptionManagedAccount[];
	readonly state: RuntimeState;
	readonly config: MultiAccountConfig;
	readonly modelSupport?: ModelSupportRegistry;
	readonly nowMs: number;
}

export type RouteResolver = (input: unknown) => RouteResolverResult;

export interface RouteResolverService {
	readonly purpose: typeof ROUTE_RESOLVER_PURPOSE;
	readonly version: typeof ROUTE_RESOLVER_VERSION;
	readonly resolve: RouteResolver;
}

export interface RetainedRouteResolverService {
	readonly purpose: typeof ROUTE_RESOLVER_PURPOSE;
	readonly version: number;
	readonly resolve: (input: unknown) => unknown;
}

export type RouteResolverPublicationResult =
	| { readonly status: "published"; readonly service: RouteResolverService }
	| {
			readonly status: "retained-newer";
			readonly service: RetainedRouteResolverService;
		};

export type RouteResolverLookup =
	| { readonly status: "absent" }
	| { readonly status: "incompatible" }
	| { readonly status: "available"; readonly service: RouteResolverService };

function unresolved(reason: RouteResolverUnresolvedReason): RouteResolverUnresolvedResult {
	return Object.freeze({
		purpose: ROUTE_RESOLVER_PURPOSE,
		version: ROUTE_RESOLVER_VERSION,
		status: "unresolved" as const,
		reason,
		routes: Object.freeze([]) as readonly [],
	});
}

function routeResult(
	accounts: readonly SubscriptionManagedAccount[],
	modelId: string,
): RouteResolverResult {
	const routes = accounts.map((account) =>
		Object.freeze({
			providerId: account.providerId,
			modelId,
			family: account.family,
		}),
	);
	return Object.freeze({
		purpose: ROUTE_RESOLVER_PURPOSE,
		version: ROUTE_RESOLVER_VERSION,
		status: "resolved" as const,
		reason: "eligible-routes" as const,
		routes: Object.freeze(routes),
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function familyForProvider(providerId: string): AllowedFamily | undefined {
	for (const family of ALLOWED_FAMILIES) {
		if (isCanonicalManagedProviderId(providerId, family)) return family;
	}
	return undefined;
}

function validModelId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_MODEL_ID_LENGTH &&
		value.trim() === value &&
		!/[\u0000-\u001f\u007f]/u.test(value)
	);
}

function validInput(value: unknown): value is RouteResolverInput {
	if (!isRecord(value)) return false;
	if (!validModelId(value.modelId)) return false;
	if (
		value.family !== undefined &&
		!ALLOWED_FAMILIES.includes(value.family as AllowedFamily)
	) {
		return false;
	}
	if (
		value.preferredProviderId !== undefined &&
		(typeof value.preferredProviderId !== "string" ||
			familyForProvider(value.preferredProviderId) === undefined)
	) {
		return false;
	}
	if (value.excludedProviderIds !== undefined) {
		if (!Array.isArray(value.excludedProviderIds)) return false;
		if (
			value.excludedProviderIds.some(
				(providerId) =>
					typeof providerId !== "string" ||
					familyForProvider(providerId) === undefined,
			)
		) {
			return false;
		}
	}
	return true;
}

function parseQualifiedModel(modelId: string):
	| { readonly providerId: string; readonly modelId: string }
	| undefined {
	const slash = modelId.indexOf("/");
	if (slash <= 0) return undefined;
	const providerId = modelId.slice(0, slash);
	if (familyForProvider(providerId) === undefined) return undefined;
	const exactModelId = modelId.slice(slash + 1);
	return exactModelId.length === 0
		? undefined
		: { providerId, modelId: exactModelId };
}

function catalogOwners(
	accounts: readonly SubscriptionManagedAccount[],
	modelId: string,
): ReadonlySet<AllowedFamily> {
	const owners = new Set<AllowedFamily>();
	for (const account of accounts) {
		if (
			familyForProvider(account.providerId) === account.family &&
			account.modelIds?.includes(modelId)
		) {
			owners.add(account.family);
		}
	}
	return owners;
}

/**
 * Resolves one exact model against supplied managed-account facts. The context
 * is deliberately explicit so the function has no host, credential, or catalog
 * discovery side effects and can be tested with bounded synthetic facts.
 */
export function resolveExactModelRoutes(
	input: unknown,
	context: ExactModelRouteResolutionContext,
): RouteResolverResult {
	try {
		if (!isRecord(input)) return unresolved("invalid-input");
		if (input.purpose !== ROUTE_RESOLVER_PURPOSE) {
			return unresolved(
				typeof input.purpose === "string"
					? "unsupported-purpose"
					: "invalid-input",
			);
		}
		if (input.version !== ROUTE_RESOLVER_VERSION) {
			return unresolved(
				typeof input.version === "number"
					? "incompatible-version"
					: "invalid-input",
			);
		}
		if (!validInput(input)) return unresolved("invalid-input");

		const slash = input.modelId.indexOf("/");
		if (
			slash > 0 &&
			familyForProvider(input.modelId.slice(0, slash)) !== undefined &&
			input.modelId.slice(slash + 1).length === 0
		) {
			return unresolved("invalid-input");
		}
		const qualified = parseQualifiedModel(input.modelId);
		const exactModelId = qualified?.modelId ?? input.modelId;
		const qualifiedFamily = qualified
			? familyForProvider(qualified.providerId)
			: undefined;
		if (qualified !== undefined && qualifiedFamily === undefined) {
			return unresolved("invalid-input");
		}
		if (
			qualifiedFamily !== undefined &&
			input.family !== undefined &&
			input.family !== qualifiedFamily
		) {
			return unresolved("family-model-mismatch");
		}

		const owners = catalogOwners(context.catalogAccounts, exactModelId);
		let family = qualifiedFamily;
		if (family === undefined) {
			if (input.family !== undefined) {
				if (!owners.has(input.family)) {
					return unresolved(
						owners.size === 0
							? "unknown-model"
							: "family-model-mismatch",
					);
				}
				family = input.family;
			} else if (owners.size === 0) {
				return unresolved("unknown-model");
			} else if (owners.size !== 1) {
				return unresolved("ambiguous-model-family");
			} else {
				family = [...owners][0];
			}
		}

		if (qualified !== undefined) {
			const targetCatalog = context.catalogAccounts.some(
				(account) =>
					account.providerId === qualified.providerId &&
					account.family === family &&
					account.modelIds?.includes(exactModelId),
			);
			if (!targetCatalog) return unresolved("unknown-model");
		}

		if (family === undefined) return unresolved("invalid-input");
		const excludedProviderIds = new Set(input.excludedProviderIds ?? []);
		const candidates = selectExactModelRouteCandidates({
			accounts: context.accounts,
			state: context.state,
			nowMs: context.nowMs,
			family,
			config: context.config,
			modelId: exactModelId,
			...(input.preferredProviderId === undefined
				? {}
				: { preferredProviderId: input.preferredProviderId }),
			...(excludedProviderIds.size === 0 ? {} : { excludedProviderIds }),
			...(qualified === undefined
				? {}
				: { providerId: qualified.providerId }),
			...(context.modelSupport === undefined
				? {}
				: { modelSupport: context.modelSupport }),
		});
		if (candidates.length === 0) return unresolved("no-eligible-routes");
		return routeResult(candidates, exactModelId);
	} catch {
		return unresolved("invalid-input");
	}
}

interface OwnServiceFields {
	readonly purpose: unknown;
	readonly version: unknown;
	readonly resolve: unknown;
}

function ownServiceFields(value: unknown): OwnServiceFields | undefined {
	try {
		if (!isRecord(value)) return undefined;
		const purpose = Object.getOwnPropertyDescriptor(value, "purpose");
		const version = Object.getOwnPropertyDescriptor(value, "version");
		const resolve = Object.getOwnPropertyDescriptor(value, "resolve");
		if (
			purpose === undefined ||
			version === undefined ||
			resolve === undefined ||
			!Object.prototype.hasOwnProperty.call(purpose, "value") ||
			!Object.prototype.hasOwnProperty.call(version, "value") ||
			!Object.prototype.hasOwnProperty.call(resolve, "value")
		) {
			return undefined;
		}
		return {
			purpose: purpose.value,
			version: version.value,
			resolve: resolve.value,
		};
	} catch {
		return undefined;
	}
}

function serviceLike(value: unknown): value is RouteResolverService {
	try {
		const fields = ownServiceFields(value);
		return (
			fields !== undefined &&
			fields.purpose === ROUTE_RESOLVER_PURPOSE &&
			fields.version === ROUTE_RESOLVER_VERSION &&
			typeof fields.resolve === "function"
		);
	} catch {
		return false;
	}
}

function newerServiceLike(value: unknown): value is RetainedRouteResolverService {
	try {
		const fields = ownServiceFields(value);
		return (
			fields !== undefined &&
			fields.purpose === ROUTE_RESOLVER_PURPOSE &&
			typeof fields.version === "number" &&
			Number.isFinite(fields.version) &&
			fields.version > ROUTE_RESOLVER_VERSION &&
			typeof fields.resolve === "function"
		);
	} catch {
		return false;
	}
}

type OwnRegistryValue =
	| { readonly present: false }
	| { readonly present: true; readonly readable: false }
	| { readonly present: true; readonly readable: true; readonly value: unknown };

function ownRegistryValue(): OwnRegistryValue {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(
			globalThis,
			ROUTE_RESOLVER_REGISTRY_KEY,
		);
		if (descriptor === undefined) return { present: false };
		if (!("value" in descriptor)) return { present: true, readable: false };
		return { present: true, readable: true, value: descriptor.value };
	} catch {
		return { present: true, readable: false };
	}
}

// ---------------------------------------------------------------------------
// Reload-safe process-global coordinator.
//
// The public service published under `ROUTE_RESOLVER_REGISTRY_KEY` is a frozen
// facade whose `resolve` captures only the process-global coordinator below. It
// never captures a session-owned resolver or `ExtensionContext`, so a facade
// retained across a Pi reload dispatches to the newest live session owner
// instead of an invalidated one. Session shutdown revokes the owner before Pi
// invalidates its context; a retained facade with no live owner returns the
// frozen version-1 unavailable result rather than reaching stale state.
// ---------------------------------------------------------------------------

/** Internal coordinator slot. Not a discovery API and not a package-root export. */
export const ROUTE_RESOLVER_COORDINATOR_KEY = Symbol.for(
	"@caair/pi-multi-account/route-resolver-coordinator",
);
const ROUTE_RESOLVER_COORDINATOR_BRAND = Symbol.for(
	"@caair/pi-multi-account/route-resolver-coordinator/v1",
);
const ROUTE_RESOLVER_COORDINATOR_PROTOCOL = 1;
// Brands an owner frame so a coordinator's `current` value can be validated as a
// package-created frame rather than a forged object. `Symbol.for` keeps the
// brand stable across module-cache replacement.
const ROUTE_RESOLVER_FRAME_BRAND = Symbol.for(
	"@caair/pi-multi-account/route-resolver-frame/v1",
);

/** Frozen version-1 result a facade returns when it has no live owner. */
const UNAVAILABLE_RESULT: RouteResolverUnresolvedResult =
	unresolved("no-eligible-routes");

interface OwnerFrame {
	active: boolean;
	target: RouteResolver | undefined;
	readonly facade: RouteResolverService;
	readonly predecessor: OwnerFrame | undefined;
}

interface RouteResolverCoordinator {
	readonly protocol: number;
	current: OwnerFrame | undefined;
}

export interface RouteResolverOwner {
	dispose(): void;
}

export type RouteResolverSessionPublication = RouteResolverPublicationResult & {
	readonly dispose: () => void;
};

const NOOP_OWNER: RouteResolverOwner = Object.freeze({
	dispose(): void {
		/* A retained-newer publication owns no version-1 frame. */
	},
});

function createCoordinator(): RouteResolverCoordinator {
	const coordinator: Record<PropertyKey, unknown> = {};
	Object.defineProperty(coordinator, ROUTE_RESOLVER_COORDINATOR_BRAND, {
		value: ROUTE_RESOLVER_COORDINATOR_BRAND,
		enumerable: false,
		writable: false,
		configurable: false,
	});
	Object.defineProperty(coordinator, "protocol", {
		value: ROUTE_RESOLVER_COORDINATOR_PROTOCOL,
		enumerable: false,
		writable: false,
		configurable: false,
	});
	Object.defineProperty(coordinator, "current", {
		value: undefined,
		enumerable: false,
		writable: true,
		configurable: false,
	});
	Object.preventExtensions(coordinator);
	return coordinator as unknown as RouteResolverCoordinator;
}

/** Validate a value as a package-created owner frame through own descriptors only. */
function isBrandedFrame(value: unknown): boolean {
	try {
		if (typeof value !== "object" || value === null) return false;
		const brand = Object.getOwnPropertyDescriptor(
			value,
			ROUTE_RESOLVER_FRAME_BRAND,
		);
		return (
			brand !== undefined &&
			"value" in brand &&
			brand.value === ROUTE_RESOLVER_FRAME_BRAND
		);
	} catch {
		return false;
	}
}

/** Create a branded, active owner frame. */
function createFrame(
	target: RouteResolver,
	facade: RouteResolverService,
	predecessor: OwnerFrame | undefined,
): OwnerFrame {
	const frame: OwnerFrame = { active: true, target, facade, predecessor };
	Object.defineProperty(frame, ROUTE_RESOLVER_FRAME_BRAND, {
		value: ROUTE_RESOLVER_FRAME_BRAND,
		enumerable: false,
		writable: false,
		configurable: false,
	});
	return frame;
}

/** A non-enumerable, non-configurable data descriptor with the expected writability. */
function isExactDataDescriptor(
	descriptor: PropertyDescriptor | undefined,
	expectedWritable: boolean,
): boolean {
	return (
		descriptor !== undefined &&
		"value" in descriptor &&
		descriptor.enumerable === false &&
		descriptor.configurable === false &&
		descriptor.writable === expectedWritable
	);
}

/**
 * Validate a candidate coordinator against the exact protocol through own data
 * descriptors only, never invoking an accessor. Every deviation — wrong
 * prototype, extensibility, an unexpected own key, a mis-attributed field, or a
 * `current` value that is not a package-created frame — fails closed, so a
 * forged or incompatible coordinator can never be reused.
 */
function coordinatorFromValue(
	value: unknown,
): RouteResolverCoordinator | undefined {
	try {
		if (typeof value !== "object" || value === null) return undefined;
		if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;
		if (Object.isExtensible(value)) return undefined;
		const names = Object.getOwnPropertyNames(value);
		const symbols = Object.getOwnPropertySymbols(value);
		if (
			names.length !== 2 ||
			!names.includes("protocol") ||
			!names.includes("current") ||
			symbols.length !== 1 ||
			symbols[0] !== ROUTE_RESOLVER_COORDINATOR_BRAND
		) {
			return undefined;
		}
		const brand = Object.getOwnPropertyDescriptor(
			value,
			ROUTE_RESOLVER_COORDINATOR_BRAND,
		);
		if (
			!isExactDataDescriptor(brand, false) ||
			brand?.value !== ROUTE_RESOLVER_COORDINATOR_BRAND
		) {
			return undefined;
		}
		const protocol = Object.getOwnPropertyDescriptor(value, "protocol");
		if (
			!isExactDataDescriptor(protocol, false) ||
			protocol?.value !== ROUTE_RESOLVER_COORDINATOR_PROTOCOL
		) {
			return undefined;
		}
		const current = Object.getOwnPropertyDescriptor(value, "current");
		if (!isExactDataDescriptor(current, true)) return undefined;
		if (current?.value !== undefined && !isBrandedFrame(current.value)) {
			return undefined;
		}
		return value as unknown as RouteResolverCoordinator;
	} catch {
		return undefined;
	}
}

/**
 * Reuse the valid process-global coordinator or create one. A present value that
 * does not satisfy the exact protocol — including the global slot's own
 * descriptor — fails publication before the public registry or any owner
 * changes; replacing it could strand retained facades, so a Pi process restart
 * is the only recovery.
 */
function getOrCreateCoordinator(): RouteResolverCoordinator {
	let descriptor: PropertyDescriptor | undefined;
	try {
		descriptor = Object.getOwnPropertyDescriptor(
			globalThis,
			ROUTE_RESOLVER_COORDINATOR_KEY,
		);
	} catch {
		throw new TypeError(
			"route resolver coordinator slot is unreadable; a Pi process restart is required.",
		);
	}
	if (descriptor !== undefined) {
		const validSlot =
			"value" in descriptor &&
			descriptor.enumerable === false &&
			descriptor.writable === false &&
			descriptor.configurable === true;
		const coordinator = validSlot
			? coordinatorFromValue(descriptor.value)
			: undefined;
		if (coordinator === undefined) {
			throw new TypeError(
				"route resolver coordinator is incompatible; a Pi process restart is required.",
			);
		}
		return coordinator;
	}
	const created = createCoordinator();
	Object.defineProperty(globalThis, ROUTE_RESOLVER_COORDINATOR_KEY, {
		value: created,
		enumerable: false,
		writable: false,
		configurable: true,
	});
	return created;
}

function buildFacade(
	coordinator: RouteResolverCoordinator,
): RouteResolverService {
	return Object.freeze({
		purpose: ROUTE_RESOLVER_PURPOSE,
		version: ROUTE_RESOLVER_VERSION,
		resolve: (input: unknown): RouteResolverResult => {
			const frame = coordinator.current;
			if (frame === undefined || !frame.active) return UNAVAILABLE_RESULT;
			const target = frame.target;
			if (typeof target !== "function") return UNAVAILABLE_RESULT;
			return target(input);
		},
	});
}

/**
 * Restore or delete the public slot, but only while it still holds this frame's
 * exact facade. Any failure is contained: the frame is already inactive with a
 * cleared target, so a retained facade fails closed through the coordinator.
 */
function restorePublicSlotIfHeld(
	ownFacade: RouteResolverService,
	replacement: OwnerFrame | undefined,
): void {
	try {
		const slot = ownRegistryValue();
		if (!slot.present || !slot.readable || slot.value !== ownFacade) return;
		if (replacement !== undefined) {
			Reflect.defineProperty(globalThis, ROUTE_RESOLVER_REGISTRY_KEY, {
				configurable: true,
				enumerable: false,
				writable: true,
				value: replacement.facade,
			});
		} else {
			Reflect.deleteProperty(globalThis, ROUTE_RESOLVER_REGISTRY_KEY);
		}
	} catch {
		/* Contained; see the doc comment. */
	}
}

function createOwner(
	coordinator: RouteResolverCoordinator,
	frame: OwnerFrame,
): RouteResolverOwner {
	const dispose = (): void => {
		if (!frame.active) return;
		frame.active = false;
		frame.target = undefined;
		if (coordinator.current !== frame) return;
		let candidate = frame.predecessor;
		while (candidate !== undefined && !candidate.active) {
			candidate = candidate.predecessor;
		}
		coordinator.current = candidate;
		restorePublicSlotIfHeld(frame.facade, candidate);
	};
	return { dispose };
}

function ensureResolve(
	publication: Pick<RouteResolverService, "resolve"> | RouteResolverService,
): RouteResolver {
	let resolve: unknown;
	try {
		resolve = publication.resolve;
		if (typeof resolve !== "function") {
			throw new TypeError("route resolver publication must provide resolve.");
		}
	} catch (error) {
		if (
			error instanceof TypeError &&
			error.message === "route resolver publication must provide resolve."
		) {
			throw error;
		}
		throw new TypeError("route resolver publication must provide resolve.");
	}
	return resolve as RouteResolver;
}

function publishRouteResolverCore(
	publication: Pick<RouteResolverService, "resolve"> | RouteResolverService,
): {
	readonly result: RouteResolverPublicationResult;
	readonly owner: RouteResolverOwner;
} {
	const existing = ownRegistryValue();
	if (existing.present && existing.readable && newerServiceLike(existing.value)) {
		return {
			result: { status: "retained-newer", service: existing.value },
			owner: NOOP_OWNER,
		};
	}
	const resolve = ensureResolve(publication);
	const coordinator = getOrCreateCoordinator();
	const priorFrame = coordinator.current;
	const facade = buildFacade(coordinator);
	const frame = createFrame(resolve, facade, priorFrame);
	try {
		coordinator.current = frame;
	} catch (error) {
		frame.active = false;
		frame.target = undefined;
		throw error;
	}
	try {
		Object.defineProperty(globalThis, ROUTE_RESOLVER_REGISTRY_KEY, {
			configurable: true,
			enumerable: false,
			writable: true,
			value: facade,
		});
	} catch (error) {
		coordinator.current = priorFrame;
		frame.active = false;
		frame.target = undefined;
		throw error;
	}
	return {
		result: { status: "published", service: facade },
		owner: createOwner(coordinator, frame),
	};
}

export function publishRouteResolver(
	publication: Pick<RouteResolverService, "resolve"> | RouteResolverService,
): RouteResolverPublicationResult {
	return publishRouteResolverCore(publication).result;
}

/**
 * Session-scoped publication used by the extension factory. Returns the same
 * public publication result plus an idempotent, synchronous, non-throwing
 * `dispose()` that revokes this generation's live target on `session_shutdown`,
 * before Pi invalidates the extension context. Not exported from the package
 * root.
 */
export function publishRouteResolverForSession(
	publication: Pick<RouteResolverService, "resolve"> | RouteResolverService,
): RouteResolverSessionPublication {
	const { result, owner } = publishRouteResolverCore(publication);
	return { ...result, dispose: () => owner.dispose() };
}

export function lookupRouteResolver(): RouteResolverLookup {
	const existing = ownRegistryValue();
	if (!existing.present) return { status: "absent" };
	if (!existing.readable || !serviceLike(existing.value)) {
		return { status: "incompatible" };
	}
	return { status: "available", service: existing.value };
}
