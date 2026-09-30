import type { ExecutableGraph, RunOptions } from "../model.js";
import { EmbeddedRunner, type EmbeddedRunnerConfig, type RunHandle, type StartRunInput } from "./embedded.js";

export interface SessionRunnerBoundary {
	run(graph: ExecutableGraph, options: RunOptions): Promise<RunHandle>;
}

/** Stage-2 session runner: one activation at a time, backed by the embedded runner. */
export class SessionRunner extends EmbeddedRunner implements SessionRunnerBoundary {
	constructor(config: EmbeddedRunnerConfig = {}) {
		super(config);
	}

	run(graph: ExecutableGraph, options: RunOptions): Promise<RunHandle> {
		const input: StartRunInput = { graph, input: {}, options };
		return this.start(input);
	}

	/** Mode A stays sequential even when the graph permits a wider batch. */
	protected override batchWidth(_graph: ExecutableGraph): number {
		return 1;
	}
}

export { EmbeddedRunner } from "./embedded.js";
export type { EmbeddedRunnerConfig, RunHandle, StartRunInput } from "./embedded.js";
