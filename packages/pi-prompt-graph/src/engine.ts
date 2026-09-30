import { step } from "./pure/routing.js";
export type { RoutingInput, StepPlan } from "./model.js";
export { EmbeddedRunner } from "./runners/embedded.js";
export type { EmbeddedRunnerConfig, RunHandle, StartRunInput } from "./runners/embedded.js";

export interface EngineBoundary {
	readonly step: typeof step;
}

export const engine: EngineBoundary = { step };
