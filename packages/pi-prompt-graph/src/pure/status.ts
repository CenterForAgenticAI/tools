import type { ExecutableGraph, JsonObject, JsonValue, NodeId, RunFailureCode, RunId, RunStatus, UsageDelta, VerdictName } from "../model.js";
import { isArtifactRef } from "./artifact.js";

/**
 * What a person watching a run is shown, and what a peer reading the snapshot
 * gets. Pure: it projects, it does not observe.
 *
 * Two rules do the work here.
 *
 * **Bounded.** A status line carries the current node, its visit, the last
 * node's verdict, attempts against budget, and tokens
 * ([0006](../../.spec/0006-runtime-state-and-durability.md) §7). Never state
 * bodies, never transcript content.
 *
 * **Cost appears only against a ceiling.** An estimate displayed as money gets
 * read as a bill; against a ceiling it reads as progress towards a limit
 * somebody chose ([0010](../../.spec/0010-decision-log.md) D-024). D-024 said
 * the *graph* must declare it; the ceiling an invocation supplies is enforced
 * just as hard, so the rule is the **effective** ceiling and D-059 records the
 * widening.
 */

/** The running cost and token totals a run accumulates. */
export interface CostLedger {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly costUsd: number;
	/** How many of the recorded outcomes carried a cost the provider reported. */
	readonly pricedResponses: number;
}

export const EMPTY_LEDGER: CostLedger = { inputTokens: 0, outputTokens: 0, costUsd: 0, pricedResponses: 0 };

/** Add one node's reported usage to the ledger. Absent usage changes nothing. */
export function addUsage(ledger: CostLedger, usage: UsageDelta | undefined): CostLedger {
	if (!usage) return ledger;
	return {
		inputTokens: ledger.inputTokens + (Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0),
		outputTokens: ledger.outputTokens + (Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0),
		costUsd: ledger.costUsd + (typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd) ? usage.costUsd : 0),
		pricedResponses: ledger.pricedResponses + (typeof usage.costUsd === "number" ? 1 : 0),
	};
}

/**
 * The cost ceiling actually in force: the lower of what the graph declared and
 * what the invocation supplied. An invocation may lower a ceiling and MUST NOT
 * raise one ([0011](../../.spec/0011-data-contracts.md) §12).
 */
export function effectiveCostCeiling(declared: number | undefined, invoked: number | undefined): number | undefined {
	if (declared === undefined) return invoked;
	if (invoked === undefined) return declared;
	return Math.min(declared, invoked);
}

export interface StatusInput {
	readonly runId: RunId;
	readonly graph: ExecutableGraph;
	readonly graphName?: string;
	readonly status: RunStatus;
	readonly currentNode?: NodeId;
	readonly visit?: number;
	readonly lastVerdict?: VerdictName;
	readonly attemptsUsed: number;
	readonly ledger: CostLedger;
	/** The ceiling in force, from either source. Absent means no ceiling exists. */
	readonly costCeilingUsd?: number;
	readonly failure?: { readonly code: RunFailureCode; readonly detail: string };
	/** Set by a `human` node that is waiting for an answer. */
	readonly question?: string;
}

export interface RunStatusLine {
	readonly runId: RunId;
	readonly graphName: string;
	readonly status: RunStatus;
	readonly currentNode?: NodeId;
	readonly visit?: number;
	readonly lastVerdict?: VerdictName;
	readonly attemptsUsed: number;
	readonly budget: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	/** Present exactly when a cost ceiling is in force (D-024, D-059). */
	readonly costUsd?: number;
	readonly maxCostUsd?: number;
	readonly question?: string;
	readonly failure?: { readonly code: RunFailureCode; readonly detail: string };
	/** One bounded line, for a person rather than a parser. */
	readonly line: string;
}

export function statusLine(input: StatusInput): RunStatusLine {
	const showCost = input.costCeilingUsd !== undefined;
	const graphName = input.graphName ?? input.graph.name;
	const parts = [
		`${graphName} ${input.status}`,
		input.currentNode ? `node ${input.currentNode}${input.visit === undefined ? "" : ` (visit ${input.visit})`}` : undefined,
		input.lastVerdict ? `last verdict ${input.lastVerdict}` : undefined,
		`${input.attemptsUsed}/${input.graph.limits.budget} attempts`,
		`${input.ledger.inputTokens + input.ledger.outputTokens} tokens`,
		// Only against a ceiling, and never as a bare number: "$0.42 of $5.00"
		// is progress towards a limit, "$0.42" is a claim about a bill.
		showCost ? `${formatUsd(input.ledger.costUsd)} of ${formatUsd(input.costCeilingUsd!)}` : undefined,
		input.question ? `waiting: ${input.question}` : undefined,
		input.failure ? `failed ${input.failure.code}` : undefined,
	].filter((part): part is string => part !== undefined);
	return {
		runId: input.runId,
		graphName,
		status: input.status,
		...(input.currentNode ? { currentNode: input.currentNode } : {}),
		...(input.visit === undefined ? {} : { visit: input.visit }),
		...(input.lastVerdict ? { lastVerdict: input.lastVerdict } : {}),
		attemptsUsed: input.attemptsUsed,
		budget: input.graph.limits.budget,
		inputTokens: input.ledger.inputTokens,
		outputTokens: input.ledger.outputTokens,
		...(showCost ? { costUsd: input.ledger.costUsd, maxCostUsd: input.costCeilingUsd } : {}),
		...(input.question ? { question: input.question } : {}),
		...(input.failure ? { failure: input.failure } : {}),
		line: parts.join(" · "),
	};
}

function formatUsd(value: number): string {
	return `$${value.toFixed(2)}`;
}

export interface StatePathSize {
	readonly path: string;
	readonly bytes: number;
	/** An artifact reference is a pointer, so its size is not the body's size. */
	readonly artifact: boolean;
}

/**
 * The largest paths in committed state, biggest first.
 *
 * The view [0006](../../.spec/0006-runtime-state-and-durability.md) §6 promised
 * and nothing built. It answers the only question worth asking when a run halts
 * on `RUN-STATE-BYTES` — which path grew — and it answers it without dumping
 * state, which is the whole point of a projection.
 *
 * Leaves only. Reporting a parent beside its children would count the same bytes
 * repeatedly and put the root at the top of every inventory.
 */
export function largestStatePaths(state: JsonObject, limit = 10): StatePathSize[] {
	const sizes: StatePathSize[] = [];
	const walk = (value: JsonValue, path: string): void => {
		if (isArtifactRef(value)) {
			sizes.push({ path, bytes: value.bytes, artifact: true });
			return;
		}
		if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			const entries = Object.entries(value);
			if (entries.length > 0) {
				for (const [key, child] of entries) walk(child, path ? `${path}.${key}` : key);
				return;
			}
		}
		if (path) sizes.push({ path, bytes: new TextEncoder().encode(JSON.stringify(value)).length, artifact: false });
	};
	walk(state, "");
	return sizes.sort((left, right) => right.bytes - left.bytes || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)).slice(0, Math.max(0, limit));
}
