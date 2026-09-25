/** Synchronous live-runtime capability queried by session-scoped consumers. */
import {
	getSessionLocalActiveWorkStatus,
	type SessionLocalActiveWorkStatus,
} from "./runtime.js";

export const SESSION_ACTIVE_WORK_QUERY = "pi-delegate:session-active-work-query:v1";
export const SESSION_ACTIVE_WORK_QUERY_VERSION = 1;

export interface SessionActiveWorkEventBus {
	on(channel: string, handler: (payload: unknown) => void): () => void;
}

export interface SessionActiveWorkQueryResponse {
	version: 1;
	status: SessionLocalActiveWorkStatus;
}

export interface SessionActiveWorkQuery {
	version: 1;
	ownerSessionId: string;
	response?: SessionActiveWorkQueryResponse;
}

export interface SessionActiveWorkQueryRegistryHandle {
	dispose(): void;
}

const LIVE_REGISTRY_HANDLE = Symbol.for("pi-delegate.session-active-work-query-registry-handle");
type RegistryGlobal = typeof globalThis & {
	[LIVE_REGISTRY_HANDLE]?: SessionActiveWorkQueryRegistryHandle;
};

function isQuery(value: unknown): value is SessionActiveWorkQuery {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const query = value as Partial<SessionActiveWorkQuery>;
	return (
		query.version === SESSION_ACTIVE_WORK_QUERY_VERSION &&
		typeof query.ownerSessionId === "string"
	);
}

/**
 * Install the exact-owner live query for one foreground session. Pi's event bus
 * is synchronous, so the caller reads the response from the same request object.
 */
export function installSessionActiveWorkQueryRegistry(
	events: SessionActiveWorkEventBus,
	boundOwnerSessionId: string | undefined,
): SessionActiveWorkQueryRegistryHandle {
	const registryGlobal = globalThis as RegistryGlobal;
	registryGlobal[LIVE_REGISTRY_HANDLE]?.dispose();
	const off = events.on(SESSION_ACTIVE_WORK_QUERY, (payload) => {
		if (!isQuery(payload)) return;
		const status =
			boundOwnerSessionId !== undefined && payload.ownerSessionId === boundOwnerSessionId
				? getSessionLocalActiveWorkStatus(boundOwnerSessionId)
				: "unknown";
		payload.response = {
			version: SESSION_ACTIVE_WORK_QUERY_VERSION,
			status,
		};
	});
	const handle: SessionActiveWorkQueryRegistryHandle = {
		dispose: () => {
			if (registryGlobal[LIVE_REGISTRY_HANDLE] !== handle) return;
			off();
			delete registryGlobal[LIVE_REGISTRY_HANDLE];
		},
	};
	registryGlobal[LIVE_REGISTRY_HANDLE] = handle;
	return handle;
}
