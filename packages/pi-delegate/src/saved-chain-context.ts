import type { AgentSource } from "./agents.js";

/** One invocation-task scope in an eagerly resolved saved-chain composition. */
export interface SavedChainScopeDescriptor {
	id: string;
	chainName: string;
	source: AgentSource;
	parentScopeId?: string;
	parentStepIndex?: number;
	invocationTaskTemplate?: string;
}

/** Per-step scope position retained after recursive saved-chain expansion. */
export interface SavedChainStepContext {
	scopePath: SavedChainScopeDescriptor[];
	scopeId: string;
	localStepIndex: number;
	/** Scope boundaries completed by this step, ordered inner to outer. */
	exitScopeIds: string[];
}

// A symbol keeps saved-chain execution metadata outside the user-addressable
// inline-chain object surface while remaining enumerable so object spreads used
// by chain preflight preserve it. JSON and the persisted chain serializer ignore
// symbol keys.
const SAVED_CHAIN_CONTEXT = Symbol("delegate.saved-chain-context");

type SavedChainContextCarrier = {
	[SAVED_CHAIN_CONTEXT]?: SavedChainStepContext;
};

/** Attach resolver-owned metadata that cannot be supplied through tool JSON. */
export function attachSavedChainContext(step: object, context: SavedChainStepContext): void {
	(step as SavedChainContextCarrier)[SAVED_CHAIN_CONTEXT] = context;
}

/** Read resolver-owned saved-chain metadata from an executable step. */
export function savedChainContextForStep(step: object): SavedChainStepContext | undefined {
	return (step as SavedChainContextCarrier)[SAVED_CHAIN_CONTEXT];
}
