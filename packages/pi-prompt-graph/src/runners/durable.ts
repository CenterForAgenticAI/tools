import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { EmbeddedRunner, type EmbeddedRunnerConfig, type RunHandle, type StartRunInput } from "./embedded.js";
import { RunOwnedError, RunOwnership, type OwnershipOptions } from "./owner.js";
import type { ExecutableGraph, JsonObject, RunOptions } from "../model.js";

export interface DurableRunnerBoundary {
	run(graph: ExecutableGraph, options: RunOptions): Promise<RunHandle>;
}

export interface DurableRunnerConfig extends EmbeddedRunnerConfig {
	readonly ownership?: OwnershipOptions;
	/** Caps concurrency below the graph's own `maxConcurrency`. Never raises it. */
	readonly maxConcurrency?: number;
}

/**
 * The Mode B runner: a tier-T2 single-writer guard and concurrent steps.
 *
 * Two properties distinguish it from the session runner. It **owns** its run
 * directory, so a second runner on the same `runId` refuses to start while the
 * owner is live. And it runs a batch of scheduled activations at once, applying
 * their results in **scheduled order** — the order the graph chose — rather than
 * the order they happened to finish, so a run's committed history does not depend
 * on which node was quicker.
 *
 * It does not make external effects exactly-once. Nothing does
 * ([0006](../../.spec/0006-runtime-state-and-durability.md) §4).
 */
export class DurableRunner extends EmbeddedRunner implements DurableRunnerBoundary {
	private readonly durable: DurableRunnerConfig;
	private ownership?: RunOwnership;

	constructor(config: DurableRunnerConfig = {}) {
		super(config);
		this.durable = config;
	}

	run(graph: ExecutableGraph, options: RunOptions): Promise<RunHandle> {
		return this.start({ graph, input: {}, options });
	}

	override async start(input: StartRunInput): Promise<RunHandle>;
	override async start(graph: ExecutableGraph, input: JsonObject, options: RunOptions): Promise<RunHandle>;
	override async start(requestOrGraph: StartRunInput | ExecutableGraph, inputValue?: JsonObject, optionsValue?: RunOptions): Promise<RunHandle> {
		const request: StartRunInput = "graph" in requestOrGraph
			? requestOrGraph
			: { graph: requestOrGraph, input: inputValue ?? {}, options: optionsValue! };
		const runId = request.runId ?? this.id();
		return await this.owning(runId, request.options, () => super.start({ ...request, runId }));
	}

	override async resume(runId: string, graph: ExecutableGraph, options: RunOptions): Promise<RunHandle> {
		return await this.owning(runId, options, () => super.resume(runId, graph, options));
	}

	/** The takeover this runner performed when it claimed the directory, if it did. */
	takeover(): RunOwnership["takeover"] {
		return this.ownership?.takeover;
	}

	private async owning(runId: string, options: RunOptions, body: () => Promise<RunHandle>): Promise<RunHandle> {
		const directory = join(options.runsRoot, runId);
		await mkdir(directory, { recursive: true });
		const ownership = await RunOwnership.acquire(directory, runId, this.durable.ownership ?? {});
		this.ownership = ownership;
		ownership.start();
		try {
			return await body();
		} finally {
			await ownership.release().catch(() => undefined);
		}
	}

	/** Concurrency is the graph's, optionally capped by the runner. Never raised by it. */
	protected override batchWidth(graph: ExecutableGraph): number {
		const declared = Math.max(1, graph.limits.maxConcurrency);
		return this.durable.maxConcurrency === undefined ? declared : Math.max(1, Math.min(declared, this.durable.maxConcurrency));
	}

	/**
	 * Refuses to commit once another runner has taken the directory over.
	 *
	 * Takeover cannot be made perfectly safe: an owner that was merely suspended has
	 * a stale heartbeat and may wake believing it still owns the run. This is where
	 * it finds out otherwise, before it writes rather than after.
	 */
	protected override async beforeCommit(): Promise<void> {
		if (!this.ownership) return;
		if (await this.ownership.stillOwner()) return;
		throw new RunOwnedError(this.ownership.record, `Run ${this.ownership.record.runId} was taken over by another runner. Refusing to commit.`);
	}
}

export { RunOwnedError, RunOwnership } from "./owner.js";
export type { OwnerRecord, OwnershipOptions, OwnershipVerdict } from "./owner.js";
