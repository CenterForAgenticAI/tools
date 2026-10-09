import type { DelegateInvocation } from "../../plan/types.js";
import type { DispatchFinding } from "../types.js";

export type FabricModelRequest = Pick<DelegateInvocation, "model" | "fallbackModels">;

/** The canonical key returned by Fabric's agents.models({ runner: "pi" }). */
export interface FabricAvailableModel {
	readonly key: string;
}

/** Named fields ready for the Fabric dispatch receipt; absent means inherited. */
export interface FabricModelSelection {
	readonly status: "resolved";
	readonly requestedModel?: string;
	readonly resolvedModel?: string;
	readonly chosenModel?: string;
}

export interface FabricModelRejected {
	readonly status: "rejected";
	readonly dispatchState: "not-dispatched";
	readonly finding: Extract<DispatchFinding, { code: "delegate-runtime-error" }> & { readonly runtimeCode: "model-unavailable" };
}

export type FabricModelResolution = FabricModelSelection | FabricModelRejected;

/**
 * Select exact catalog keys, never Fabric's fuzzy nearest-model substitution.
 * This preserves the explicit fallback order and prevents a misspelled request
 * from silently choosing a different model ahead of an available fallback.
 */
export function resolveFabricDispatchModel(request: FabricModelRequest, available: readonly FabricAvailableModel[]): FabricModelResolution {
	const candidates = [
		...(request.model === undefined ? [] : [request.model]),
		...(request.fallbackModels ?? []),
	];
	if (candidates.length === 0) return { status: "resolved" };
	const keys = new Set(available.map((model) => model.key));
	for (const candidate of candidates) {
		if (!keys.has(candidate)) continue;
		return {
			status: "resolved",
			...(request.model === undefined ? {} : { requestedModel: request.model }),
			resolvedModel: candidate,
			chosenModel: candidate,
		};
	}
	return {
		status: "rejected",
		dispatchState: "not-dispatched",
		finding: {
			code: "delegate-runtime-error",
			runtimeCode: "model-unavailable",
			message: `No requested Fabric model is available: ${candidates.map((model) => JSON.stringify(model)).join(", ")}`,
		},
	};
}

export interface FabricModelDispatchDependencies<T> {
	models(options: { readonly runner: "pi" }): Promise<readonly FabricAvailableModel[]>;
	run(model: string | undefined, selection: FabricModelSelection): Promise<T>;
}

export type FabricModelDispatchResult<T> = FabricModelRejected | {
	readonly status: "dispatched";
	readonly selection: FabricModelSelection;
	readonly result: T;
};

/** Resolve before submission; availability failures and run failures never retry. */
export async function dispatchWithFabricModel<T>(request: FabricModelRequest, dependencies: FabricModelDispatchDependencies<T>): Promise<FabricModelDispatchResult<T>> {
	const explicit = request.model !== undefined || (request.fallbackModels?.length ?? 0) > 0;
	const available = explicit ? await dependencies.models({ runner: "pi" }) : [];
	const selection = resolveFabricDispatchModel(request, available);
	if (selection.status === "rejected") return selection;
	const result = await dependencies.run(selection.chosenModel, selection);
	return { status: "dispatched", selection, result };
}
