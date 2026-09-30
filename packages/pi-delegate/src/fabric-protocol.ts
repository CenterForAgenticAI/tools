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
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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
