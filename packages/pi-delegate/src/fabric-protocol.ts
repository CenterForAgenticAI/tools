/**
 * Vendored subset of the pi-fabric provider protocol, version 1.
 *
 * Source: pi-fabric `src/protocol.ts` as published in npm pi-fabric 0.96.x
 * (MIT). pi-delegate deliberately has no dependency of any kind on pi-fabric —
 * not a peer, not optional, not a type import — so the two event names and the
 * structural types the adapter needs are copied here instead.
 * `tests/unit/fabric-protocol-contract.test.ts` compares every constant and
 * member below with the Fabric declarations, so a protocol change fails a test
 * instead of silently drifting.
 *
 * Only the members the adapter reads or implements are declared. Every Fabric
 * member omitted here is optional on the Fabric side, which the contract test
 * also checks.
 */
import type { ExtensionContext, EventBus, EventBusController } from "@earendil-works/pi-coding-agent";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FABRIC_PROVIDER_REGISTER_EVENT = "pi-fabric:provider:register:v1";
export const FABRIC_PROVIDER_DISCOVER_EVENT = "pi-fabric:provider:discover:v1";
/** The only provider-protocol version this adapter speaks. */
export const FABRIC_PROVIDER_PROTOCOL_VERSION = 1;

export type FabricRisk = "read" | "write" | "execute" | "network" | "agent";
export type FabricEffectKind = "none" | "scoped" | "transactional" | "emission";
export type FabricEffectOrdering = "commutative" | "ordered" | "unknown";

export interface FabricActionEffect {
	kind: FabricEffectKind;
	resources?: string[];
	ordering?: FabricEffectOrdering;
}

export interface FabricActionDescriptor {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
	risk: FabricRisk;
	namespace?: string;
	effect?: FabricActionEffect;
}

export interface FabricProviderListRequest {
	namespace?: string;
	query?: string;
	limit?: number;
}

export type FabricActivityEntityKind = "agent" | "actor" | "tool" | "extension" | "mcp" | "mesh" | "task" | "custom";

export type FabricInvocationActivityUpdate =
	| { type: "progress"; message: string }
	| { type: "entity"; id: string; kind: FabricActivityEntityKind; name?: string }
	| { type: "metrics"; tokens?: number; toolCalls?: number; cost?: number };

export interface FabricInvocationContext {
	cwd: string;
	signal: AbortSignal | undefined;
	parentToolCallId: string;
	nestedToolCallId: string;
	/** The context of the `fabric_exec` call that is invoking this provider. */
	extensionContext: ExtensionContext;
	update(message: string): void;
	activity?(update: FabricInvocationActivityUpdate): void;
}

export interface FabricProvider {
	name: string;
	description: string;
	list(request: FabricProviderListRequest, context: FabricInvocationContext): Promise<FabricActionDescriptor[]>;
	describe(actionName: string, context: FabricInvocationContext): Promise<FabricActionDescriptor | undefined>;
	invoke(actionName: string, args: Record<string, unknown>, context: FabricInvocationContext): Promise<unknown>;
	close?(): Promise<void>;
}

export interface FabricProviderRegistration {
	version: 1;
	provider: FabricProvider;
	overwrite?: boolean;
}

export interface FabricProviderDiscovery {
	version: 1;
	register(provider: FabricProvider, options?: { overwrite?: boolean }): void;
}

export type FabricProviderDiscoveryRead =
	| { kind: "supported"; discovery: FabricProviderDiscovery }
	| { kind: "unsupported"; reason: string };

/**
 * Validate a discovery event payload before using it. Anything other than a
 * version 1 object with a `register` function is reported, never called.
 */
export function readFabricProviderDiscovery(value: unknown): FabricProviderDiscoveryRead {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return { kind: "unsupported", reason: "discovery payload is not an object" };
	}
	const record = value as Record<string, unknown>;
	if (record.version !== FABRIC_PROVIDER_PROTOCOL_VERSION) {
		const version = typeof record.version === "number" || typeof record.version === "string" ? String(record.version).slice(0, 32) : typeof record.version;
		return { kind: "unsupported", reason: `provider protocol version ${version} is unsupported (pi-delegate speaks version ${FABRIC_PROVIDER_PROTOCOL_VERSION})` };
	}
	if (typeof record.register !== "function") {
		return { kind: "unsupported", reason: "discovery payload has no register function" };
	}
	return { kind: "supported", discovery: value as FabricProviderDiscovery };
}

/**
 * Host policy handshake, mirrored from pi-fabric `FABRIC_HOST_POLICY_EVENT`.
 * Fabric replies synchronously once the policy is in force. Fabric builds
 * without the handshake never reply, so callers must treat silence as refusal.
 */
export const FABRIC_HOST_POLICY_EVENT = "pi-fabric:host-policy:v1";
/** Process-local key populated only by parent-generated detached owner proxies. */
export const FABRIC_HOST_POLICY_HANDLER_REGISTRY_KEY = "pi-delegate.fabric-host-policy-handlers.v1";

export interface FabricHostPolicyV1 {
	owner: string;
	reason: string;
	deniedTools?: string[];
	deniedProviders?: string[];
	allowedUnhookedRisks?: FabricRisk[];
}

export interface FabricHostPolicyAckV1 {
	version: 1;
	accepted: true;
}

type EventHandler = (data: unknown) => void;

interface AttributedHostPolicyHandler {
	handler: EventHandler;
	registrationStack: string;
}

type BoundHostPolicyHandlerRegistry = Map<string, EventHandler[]>;

const hostPolicyHandlers = new WeakMap<EventBus, Set<AttributedHostPolicyHandler>>();
const instrumentedHostPolicyBuses = new WeakSet<EventBus>();

function captureRegistrationStack(): string {
	const previousLimit = Error.stackTraceLimit;
	try {
		Error.stackTraceLimit = Math.max(previousLimit, 50);
		return new Error().stack ?? "";
	} finally {
		Error.stackTraceLimit = previousLimit;
	}
}

/** Retain host-policy subscription provenance on a worker's shared event bus. */
export function trackFabricHostPolicyEventBus<T extends EventBus>(events: T): T {
	if (instrumentedHostPolicyBuses.has(events)) return events;
	const attributed = new Set<AttributedHostPolicyHandler>();
	const rawOn = events.on.bind(events);
	const controller = events as Partial<EventBusController>;
	const rawClear = typeof controller.clear === "function" ? controller.clear.bind(events) : undefined;
	events.on = (channel, handler) => {
		const record = channel === FABRIC_HOST_POLICY_EVENT
			? { handler, registrationStack: captureRegistrationStack() }
			: undefined;
		if (record) attributed.add(record);
		const unsubscribeRaw = rawOn(channel, handler);
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			if (record) attributed.delete(record);
			unsubscribeRaw();
		};
	};
	if (rawClear) {
		controller.clear = () => {
			attributed.clear();
			rawClear();
		};
	}
	hostPolicyHandlers.set(events, attributed);
	instrumentedHostPolicyBuses.add(events);
	return events;
}

/** Create the worker event bus while retaining host-policy subscription provenance. */
export function createFabricHostPolicyEventBus(): EventBusController {
	return trackFabricHostPolicyEventBus(createEventBus());
}

function canonicalPath(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return resolve(path);
	}
}

function fabricPackageDirectory(resolvedPath: string): string | undefined {
	let current = dirname(canonicalPath(resolvedPath));
	while (true) {
		try {
			const manifest = JSON.parse(readFileSync(resolve(current, "package.json"), "utf8")) as { name?: unknown };
			if (manifest.name === "pi-fabric") return canonicalPath(current);
		} catch {
			// Keep walking: extension entrypoints normally live below the package root.
		}
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function stackFramePaths(stack: string): string[] {
	return stack.split("\n").flatMap((line) => {
		const match = line.match(/((?:file:\/\/\/|\/|[A-Za-z]:[\\/]).+):\d+:\d+\)?$/);
		if (!match) return [];
		const location = match[1]!;
		try {
			return [canonicalPath(location.startsWith("file:///") ? fileURLToPath(location) : location)];
		} catch {
			return [];
		}
	});
}

function registrationIsInsidePackage(registrationStack: string, packageDirectory: string): boolean {
	return stackFramePaths(registrationStack).some((framePath) => {
		const pathFromPackage = relative(packageDirectory, framePath);
		return pathFromPackage === "" || (!pathFromPackage.startsWith("..") && !isAbsolute(pathFromPackage));
	});
}

function boundHostPolicyHandlers(fabricResolvedPath: string): EventHandler[] {
	const key = Symbol.for(FABRIC_HOST_POLICY_HANDLER_REGISTRY_KEY);
	const registry = (globalThis as Record<symbol, unknown>)[key];
	if (!(registry instanceof Map)) return [];
	const expectedPath = canonicalPath(fabricResolvedPath);
	const matching = [...(registry as BoundHostPolicyHandlerRegistry)].filter(([ownerPath, handlers]) =>
		typeof ownerPath === "string" && Array.isArray(handlers) && canonicalPath(ownerPath) === expectedPath);
	if (matching.length !== 1) return [];
	return [...matching[0]![1]].filter((handler): handler is EventHandler => typeof handler === "function");
}

/**
 * Ask the worker's loaded Fabric to enforce `policy`. Returns true only after
 * exactly one handler registered from that Fabric package replies synchronously
 * with a version 1 acknowledgement.
 */
export function requestFabricHostPolicy(
	events: EventBus,
	policy: FabricHostPolicyV1,
	fabricResolvedPath: string,
): boolean {
	const packageDirectory = fabricPackageDirectory(fabricResolvedPath);
	if (!packageDirectory) return false;
	const attributed = hostPolicyHandlers.get(events);
	const attributedHandlers = attributed
		? [...attributed].filter(({ registrationStack }) =>
			registrationIsInsidePackage(registrationStack, packageDirectory)).map(({ handler }) => handler)
		: [];
	const boundHandlers = boundHostPolicyHandlers(fabricResolvedPath);
	const handlers = boundHandlers.length > 0 ? boundHandlers : attributedHandlers;
	if (handlers.length !== 1) return false;

	let acceptingReply = true;
	let replied = false;
	let accepted = false;
	try {
		handlers[0]!({
			policy: structuredClone(policy),
			reply: (ack: unknown) => {
				if (!acceptingReply || replied) return;
				replied = true;
				const record = ack as Partial<FabricHostPolicyAckV1> | null;
				accepted = record !== null && typeof record === "object" && record.version === 1 && record.accepted === true;
			},
		});
	} catch {
		return false;
	} finally {
		acceptingReply = false;
	}
	return replied && accepted;
}
