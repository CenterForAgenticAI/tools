import {
	resolveChainByName,
	type ChainFileConfig,
	isChainReferenceStepFileConfig,
} from "./agents.js";
import {
	chainFileStepToRuntimeStep,
	type ChainRunStep,
	type ChainSequentialStep,
} from "./chain-execution.js";
import {
	attachSavedChainContext,
	savedChainContextForStep,
	type SavedChainScopeDescriptor,
} from "./saved-chain-context.js";

export type SavedChainResolutionErrorCode = "not-found" | "cycle" | "empty-reference";

export type SavedChainResolutionResult =
	| {
		ok: true;
		chain: ChainFileConfig;
		steps: Array<ChainSequentialStep | ChainRunStep>;
	}
	| {
		ok: false;
		code: SavedChainResolutionErrorCode;
		message: string;
		/** Present only when a resolved chain contains a missing nested reference. */
		referencePath?: string[];
	};


/**
 * Resolve a complete saved-chain composition into executable worker steps.
 *
 * Resolution is deliberately pure and eager: every reference uses the shared
 * discovery-precedence resolver, and missing/cyclic references fail before the
 * caller can construct a worker. Scope annotations retain the task boundary
 * needed by the executor without dispatching a nested delegate run.
 */
export function resolveSavedChainPlan(
	name: string,
	candidates: readonly ChainFileConfig[],
): SavedChainResolutionResult {
	const root = resolveChainByName(name, candidates);
	if (!root) {
		return {
			ok: false,
			code: "not-found",
			message: `delegate: chain '${name}' not found.`,
		};
	}

	const steps: Array<ChainSequentialStep | ChainRunStep> = [];
	const rootScope: SavedChainScopeDescriptor = {
		id: "saved:root",
		chainName: root.name,
		source: root.source,
	};

	const expand = (
		chain: ChainFileConfig,
		scopePath: readonly SavedChainScopeDescriptor[],
		activeChains: readonly ChainFileConfig[],
	): SavedChainResolutionResult | undefined => {
		for (let stepIndex = 0; stepIndex < chain.steps.length; stepIndex += 1) {
			const step = chain.steps[stepIndex]!;
			if (!isChainReferenceStepFileConfig(step)) {
				const runtime = chainFileStepToRuntimeStep(step);
				attachSavedChainContext(runtime, {
					scopePath: [...scopePath],
					scopeId: scopePath[scopePath.length - 1]!.id,
					localStepIndex: stepIndex,
					exitScopeIds: [],
				});
				steps.push(runtime);
				continue;
			}

			const referenced = resolveChainByName(step.chain, candidates);
			if (!referenced) {
				return {
					ok: false,
					code: "not-found",
					referencePath: [...activeChains.map((item) => item.name), step.chain],
					message:
						`delegate: saved chain '${chain.name}' references unknown chain '${step.chain}' ` +
						`(resolution path: ${[...activeChains.map((item) => item.name), step.chain].join(" -> ")}).`,
				};
			}
			const cycleStart = activeChains.findIndex((item) => item.filePath === referenced.filePath);
			if (cycleStart >= 0) {
				const cycle = [...activeChains.slice(cycleStart), referenced];
				return {
					ok: false,
					code: "cycle",
					message:
						"delegate: saved-chain reference cycle: " +
						cycle.map((item) => `${item.name} (${item.filePath})`).join(" -> ") +
						".",
				};
			}

			const childScope: SavedChainScopeDescriptor = {
				id: `${scopePath[scopePath.length - 1]!.id}/${stepIndex}:${referenced.name}`,
				chainName: referenced.name,
				source: referenced.source,
				parentScopeId: scopePath[scopePath.length - 1]!.id,
				parentStepIndex: stepIndex,
				...(step.task ? { invocationTaskTemplate: step.task } : {}),
			};
			const before = steps.length;
			const error = expand(referenced, [...scopePath, childScope], [...activeChains, referenced]);
			if (error) return error;
			if (steps.length === before) {
				return {
					ok: false,
					code: "empty-reference",
					message: `delegate: saved chain '${chain.name}' references '${referenced.name}', which resolves to no executable steps.`,
				};
			}
			savedChainContextForStep(steps[steps.length - 1]!)!.exitScopeIds.push(childScope.id);
		}
		return undefined;
	};

	const error = expand(root, [rootScope], [root]);
	if (error) return error;
	return { ok: true, chain: root, steps };
}
