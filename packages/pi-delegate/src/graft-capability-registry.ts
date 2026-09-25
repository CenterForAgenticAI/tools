/** Synchronous, in-process capability query used by graft when both packages are live in Pi. */
import type { AgentConfig, AgentDiscoveryResult } from "./agents.js";

export const GRAFT_AGENT_CAPABILITY_QUERY = "pi-delegate:agent-capability-query:v1";
export const GRAFT_AGENT_CAPABILITY_VERSION = 1;

export interface GraftCapabilityEventBus {
	on(channel: string, handler: (payload: unknown) => void): () => void;
}

export interface GraftAgentCapability {
	name: string;
	available: boolean;
	source?: string;
	packageName?: string;
	filePath?: string;
}

export interface GraftAgentCapabilityQuery {
	version: 1;
	cwd: string;
	scope: "both";
	names: string[];
	response?: {
		version: 1;
		agents: GraftAgentCapability[];
		warnings: string[];
	};
}

export interface GraftCapabilityRegistryHandle {
	dispose(): void;
}

const LIVE_REGISTRY_HANDLE = Symbol.for("pi-delegate.graft-capability-registry-handle");
type RegistryGlobal = typeof globalThis & {
	[LIVE_REGISTRY_HANDLE]?: GraftCapabilityRegistryHandle;
};

function isQuery(value: unknown): value is GraftAgentCapabilityQuery {
	if (value === null || typeof value !== "object") return false;
	const query = value as Partial<GraftAgentCapabilityQuery>;
	return (
		query.version === GRAFT_AGENT_CAPABILITY_VERSION &&
		typeof query.cwd === "string" &&
		query.scope === "both" &&
		Array.isArray(query.names) &&
		query.names.every((name) => typeof name === "string")
	);
}

function capability(name: string, agent: AgentConfig | undefined): GraftAgentCapability {
	if (!agent) return { name, available: false };
	return {
		name,
		available: true,
		source: agent.source,
		...(agent.packageName ? { packageName: agent.packageName } : {}),
		filePath: agent.filePath,
	};
}

/**
 * Register only while a foreground session is live. The mutable response is
 * deliberate: Pi's EventBus is synchronous and has no request/reply return.
 */
export function installGraftAgentCapabilityRegistry(
	events: GraftCapabilityEventBus,
	discover: (cwd: string) => AgentDiscoveryResult,
): GraftCapabilityRegistryHandle {
	const registryGlobal = globalThis as RegistryGlobal;
	// Pi can replace an extension module without a reliable opportunity for its
	// old closure to unregister. Keep the live listener in globalThis so a
	// successor registration replaces, rather than stacks on, that stale one.
	registryGlobal[LIVE_REGISTRY_HANDLE]?.dispose();
	const off = events.on(GRAFT_AGENT_CAPABILITY_QUERY, (payload) => {
		if (!isQuery(payload)) return;
		try {
			const discovery = discover(payload.cwd);
			const byName = new Map(discovery.agents.map((agent) => [agent.name, agent]));
			payload.response = {
				version: GRAFT_AGENT_CAPABILITY_VERSION,
				agents: payload.names.map((name) => capability(name, byName.get(name))),
				warnings: [...discovery.warnings],
			};
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			// Keep the exact response shape even when discovery fails. The caller
			// can distinguish an unavailable agent from an absent listener and retain
			// a useful diagnostic without interrupting Pi's synchronous event bus.
			payload.response = {
				version: GRAFT_AGENT_CAPABILITY_VERSION,
				agents: payload.names.map((name) => capability(name, undefined)),
				warnings: [`Agent capability discovery failed: ${detail}`],
			};
		}
	});
	const handle: GraftCapabilityRegistryHandle = {
		dispose: () => {
			if (registryGlobal[LIVE_REGISTRY_HANDLE] !== handle) return;
			off();
			delete registryGlobal[LIVE_REGISTRY_HANDLE];
		},
	};
	registryGlobal[LIVE_REGISTRY_HANDLE] = handle;
	return handle;
}
