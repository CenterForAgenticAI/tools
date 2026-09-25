export interface LaunchModeInput {
	/** Preferred public spelling: block until the delegate completes. */
	await?: boolean;
	/** @deprecated Compatibility alias for `await`. */
	sync?: boolean;
}

export interface OrchestrateModeInput extends LaunchModeInput {
	worktree?: boolean;
}

/** Orchestrate is always detached and cannot honor turn-blocking or worktree options. */
export function hasUnsupportedOrchestrateOptions(input: OrchestrateModeInput): boolean {
	return input.await !== undefined || input.sync !== undefined || input.worktree !== undefined;
}

/**
 * Resolve whether a delegate invocation should block its originating turn.
 *
 * Contract: explicit invocation intent is authoritative; omission means
 * background dispatch. Conflicting aliases are an error because silently
 * choosing one would make cancellation and delivery semantics unpredictable.
 */
export function resolveAwaitMode(input: LaunchModeInput): boolean {
	if (input.await !== undefined && input.sync !== undefined && input.await !== input.sync) {
		throw new Error(
			"delegate: `await` and deprecated `sync` disagree; provide only `await`, or give both the same value during migration.",
		);
	}

	return input.await ?? input.sync ?? false;
}
