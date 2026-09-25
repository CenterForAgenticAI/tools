import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import type { ForkRequest } from "./fork-runner.js";
import type { ModelScope } from "./model-selection.js";
import {
	AUTO_TEXT_COMPLETION_MODEL_REF,
	resolveTextCompletionModel,
} from "./model-completion.js";

export type SummaryModelPreflightRequest = Pick<
	ForkRequest,
	"agent" | "collapseMode" | "summaryModelRef"
>;

/**
 * Warn once when configured summary-collapse models cannot resolve at dispatch.
 * This is diagnostic-only: collapse keeps its existing fail-closed behavior.
 */
export function preflightSummaryModels(
	requests: readonly SummaryModelPreflightRequest[],
	registry: ModelRegistry,
	scope: ModelScope | undefined,
	onWarning: (message: string) => void,
): void {
	const unavailableRefs = new Set<string>();

	for (const request of requests) {
		if (request.collapseMode !== "summary") continue;
		const configuredRef = request.summaryModelRef ?? request.agent.summaryModel;
		if (configuredRef === undefined) continue;
		if (!resolveTextCompletionModel(registry, configuredRef, scope)) {
			unavailableRefs.add(configuredRef);
		}
	}

	if (unavailableRefs.size === 0) return;

	const refs = [...unavailableRefs];
	const noun = refs.length === 1 ? "reference" : "references";
	const verb = refs.length === 1 ? "is" : "are";
	const autoExplanation = unavailableRefs.has("auto")
		? ` Literal "auto" resolves only to ${AUTO_TEXT_COMPLETION_MODEL_REF}.`
		: "";
	onWarning(
		`Summary collapse preflight: configured summary model ${noun} ${refs.map((ref) => JSON.stringify(ref)).join(", ")} ` +
			`${verb} unavailable in the active model registry or session scope.${autoExplanation} ` +
			"Collapse will retain the supervisor hint without a summarizer provider call. " +
			"Set per-run summary_model, agent frontmatter summary_model, or " +
			"delegateConfig.agentOverrides.<agent>.summaryModel to an available provider/model.",
	);
}
