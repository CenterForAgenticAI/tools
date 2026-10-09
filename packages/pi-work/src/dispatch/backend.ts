import type { DispatchPlanInput } from "./index.js";
import type { DispatchResult } from "./types.js";

export type DispatchBackendName = "fabric" | "pi-delegate";
export type DispatchBackendResult = DispatchResult & { readonly backend: DispatchBackendName | "plan-only" };

/** An injected host adapter; this module never discovers or imports Fabric. */
export interface FabricHost {
	dispatch(input: DispatchPlanInput): Promise<DispatchResult>;
}

export interface DispatchBackend extends FabricHost {
	readonly name: DispatchBackendName | "plan-only";
}

export interface DispatchBackendOptions {
	readonly backend?: DispatchBackendName;
	readonly fabricHost?: FabricHost;
}

/** Explicit selection never falls back to a different executor. */
export function selectDispatchBackend(options: DispatchBackendOptions, delegate: DispatchBackend): DispatchBackend {
	if (options.backend === "pi-delegate") return delegate;
	const host = options.fabricHost;
	if (host !== undefined) return { name: "fabric", dispatch: (input) => host.dispatch(input) };
	if (options.backend !== "fabric") return delegate;
	return {
		name: "plan-only",
		async dispatch(input) {
			return { outcome: "degraded", dispatchState: "not-dispatched", plan: input.plan, findings: [{ code: "delegate-client-unavailable", message: "configured Fabric host is unavailable; use the paste-ready plan receipt" }] };
		},
	};
}
