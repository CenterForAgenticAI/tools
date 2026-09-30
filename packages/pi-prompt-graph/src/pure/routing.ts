import type {
	Activation,
	CompiledNode,
	Condition,
	Destination,
	EdgeReason,
	ExecutableGraph,
	JoinToken,
	JsonObject,
	JsonPrimitive,
	JsonValue,
	NodeId,
	NodeResult,
	RoutingInput,
	RunFailureCode,
	StepPlan,
} from "../model.js";

export type { RoutingInput, StepPlan } from "../model.js";

export interface RoutingBoundary {
	readonly input: unknown;
	readonly plan: unknown;
}

const absent = Symbol("absent");
type PathValue = JsonValue | typeof absent;

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function compareActivation(left: Activation, right: Activation): number {
	return compareText(left.node, right.node) || left.visit - right.visit;
}

function compareResult(left: NodeResult, right: NodeResult): number {
	return compareActivation(left.activation, right.activation) || left.attempt - right.attempt;
}

function compareOptionalActivation(left: Activation | undefined, right: Activation | undefined): number {
	if (left && right) return compareActivation(left, right);
	return left ? -1 : right ? 1 : 0;
}

function compareToken(left: JoinToken, right: JoinToken): number {
	return compareActivation(left.from, right.from) || compareOptionalActivation(left.fanOut, right.fanOut) || compareText(left.at, right.at);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPrimitive(value: unknown): value is JsonPrimitive {
	return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function equalJson(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (typeof left !== typeof right || left === null || right === null) return false;
	if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, index) => equalJson(item, right[index]));
	if (isRecord(left) && isRecord(right)) {
		const leftKeys = Object.keys(left).sort(compareText);
		const rightKeys = Object.keys(right).sort(compareText);
		return equalJson(leftKeys, rightKeys) && leftKeys.every((key) => equalJson(left[key], right[key]));
	}
	return false;
}

function valueAt(state: JsonObject, path: string): PathValue {
	let value: unknown = state;
	for (const part of path.split(".")) {
		if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, part)) return absent;
		value = value[part];
	}
	return value as JsonValue;
}

function truthy(value: PathValue): boolean {
	if (value === absent || value === null || value === false || value === 0 || value === "") return false;
	if (Array.isArray(value) || isRecord(value)) return Object.keys(value).length > 0;
	return true;
}

type OrderingOperator = "gt" | "gte" | "lt" | "lte";

function orderedComparison(op: OrderingOperator, left: PathValue, right: JsonValue): boolean {
	if (left === absent) return false;
	if (typeof left === "number" && typeof right === "number") {
		if (op === "gt") return left > right;
		if (op === "gte") return left >= right;
		if (op === "lt") return left < right;
		return left <= right;
	}
	if (typeof left === "string" && typeof right === "string") {
		if (op === "gt") return left > right;
		if (op === "gte") return left >= right;
		if (op === "lt") return left < right;
		return left <= right;
	}
	return false;
}

/** Evaluate one compiled condition without observing anything beyond committed state. */
export function evaluateCondition(condition: Condition, state: JsonObject): boolean {
	try {
		if (condition.op === "all") return condition.of.every((item) => evaluateCondition(item, state));
		if (condition.op === "any") return condition.of.some((item) => evaluateCondition(item, state));
		if (condition.op === "not") return !evaluateCondition(condition.of, state);

		if (!("path" in condition)) return false;
		const value = valueAt(state, condition.path);
		switch (condition.op) {
			case "exists": return value !== absent;
			case "truthy": return truthy(value);
			case "eq": return value !== absent && equalJson(value, condition.value);
			case "ne": return value === absent || !equalJson(value, condition.value);
			case "gt":
			case "gte":
			case "lt":
			case "lte": return orderedComparison(condition.op, value, condition.value);
			case "includes":
				if (Array.isArray(value)) return isPrimitive(condition.value) && value.some((item) => isPrimitive(item) && item === condition.value);
				return typeof value === "string" && typeof condition.value === "string" && value.includes(condition.value);
			case "matches":
				if (typeof value !== "string") return false;
				return new RegExp(condition.pattern, condition.flags).test(value.slice(0, 65536));
			default: return false;
		}
	} catch {
		// Conditions are total even when handed malformed runtime data.
		return false;
	}
}

function destinationsFor(node: CompiledNode, result: NodeResult, state: JsonObject): Array<{ destination: Destination; via: EdgeReason }> {
	if (result.outcome.kind === "engine") {
		if (node.onError.kind === "route") return [{ destination: node.onError.to, via: { kind: "on-error" } }];
		if (node.onError.kind === "continue") return (node.transitions.next ?? []).map((destination) => ({ destination, via: { kind: "on-error" } }));
		return [];
	}
	if (node.transitions.kind === "next") return (node.transitions.next ?? []).map((destination) => ({ destination, via: { kind: "next" } }));
	for (const [index, clause] of node.transitions.when.entries()) if (evaluateCondition(clause.condition, state)) return [{ destination: clause.to, via: { kind: "when", index } }];
	const routed = node.transitions.on[result.outcome.verdict];
	if (routed !== undefined) return [{ destination: routed, via: { kind: "on", verdict: result.outcome.verdict } }];
	return node.transitions.default === undefined ? [] : [{ destination: node.transitions.default, via: { kind: "default" } }];
}

function incomingSources(graph: ExecutableGraph, target: NodeId): Set<NodeId> {
	const sources = new Set<NodeId>();
	for (const node of Object.values(graph.nodes)) {
		const destinations = [
			...(node.transitions.next ?? []),
			...Object.values(node.transitions.on),
			...(node.transitions.default === undefined ? [] : [node.transitions.default]),
			...node.transitions.when.map((clause) => clause.to),
			...(node.limit === undefined ? [] : [node.limit.onLimit]),
			...(node.onError.kind === "route" ? [node.onError.to] : []),
		];
		if (destinations.includes(target)) sources.add(node.id);
	}
	return sources;
}

function joinNeed(node: CompiledNode, sources: Set<NodeId>): number {
	if (node.join === "any") return 1;
	if (typeof node.join === "object") return node.join.quorum;
	return Math.max(sources.size, 1);
}

interface TokenGroup {
	readonly fanOut?: Activation;
	readonly visit?: number;
	readonly tokens: JoinToken[];
}

function groupedTokens(tokens: JoinToken[]): TokenGroup[] {
	const groups = new Map<string, TokenGroup>();
	for (const token of tokens) {
		const key = token.fanOut ? `fan-out:${JSON.stringify([token.fanOut.node, token.fanOut.visit])}` : `visit:${token.from.visit}`;
		const group = groups.get(key) ?? (token.fanOut ? { fanOut: { ...token.fanOut }, tokens: [] } : { visit: token.from.visit, tokens: [] });
		group.tokens.push(token);
		groups.set(key, group);
	}
	for (const group of groups.values()) group.tokens.sort(compareToken);
	return [...groups.values()].sort((left, right) => compareOptionalActivation(left.fanOut, right.fanOut) || (left.visit ?? 0) - (right.visit ?? 0));
}

function detailBudget(budget: number, used: number, cost: number): string {
	return `Budget ${budget} would be exceeded: ${used} attempts used, ${cost} more planned.`;
}

function detailLimit(node: NodeId): string {
	return `Limit destination for ${node} is exhausted.`;
}

/**
 * Build one deterministic routing plan from one committed batch.
 * The input objects are never mutated.
 */
export function step(input: RoutingInput): StepPlan {
	const plan: StepPlan = { schedule: [], retry: [], awaiting: [], consumed: [], arrivals: [] };
	const results = [...input.results].sort(compareResult);
	const pending = [...input.arrivals].map((token) => ({
		...token,
		from: { ...token.from },
		...(token.fanOut ? { fanOut: { ...token.fanOut } } : {}),
	}));
	const consumed = new Set<JoinToken>();
	const scheduled = new Set<NodeId>();
	const requested = new Set<NodeId>();
	const plannedVisits = new Map<NodeId, number>();
	const haltCandidates: Array<{ code: RunFailureCode; detail: string }> = [];
	const terminals = new Map<"done" | "fail", EdgeReason>();

	const addHalt = (code: RunFailureCode, detail: string) => haltCandidates.push({ code, detail });
	const addTerminal = (destination: "done" | "fail", via: EdgeReason) => {
		if (!terminals.has(destination)) terminals.set(destination, via);
	};
	const visitsUsed = (node: NodeId) => input.visits[node] ?? 0;
	const nextVisit = (node: NodeId) => visitsUsed(node) + (plannedVisits.get(node) ?? 0) + 1;

	const scheduleNode = (nodeId: NodeId, via: EdgeReason, source?: Activation, fanOut?: Activation, deduplicate = true): void => {
		const node = input.graph.nodes[nodeId];
		if (!node) return;
		if (deduplicate && requested.has(nodeId)) return;
		if (deduplicate) requested.add(nodeId);
		const visit = nextVisit(nodeId);
		if (node.limit && visit > node.limit.max) {
			const limitDestination = node.limit.onLimit;
			const limitNode = input.graph.nodes[limitDestination];
			if (limitDestination === "done" || limitDestination === "fail") {
				addTerminal(limitDestination, { kind: "on-limit", node: nodeId });
				return;
			}
			if (!limitNode) return;
			const limitVisit = nextVisit(limitDestination);
			if (limitNode.limit && limitVisit > limitNode.limit.max) {
				addHalt("RUN-LIMIT-UNRESOLVABLE", detailLimit(nodeId));
				return;
			}
			if (limitNode.join) {
				if (!source) {
					addHalt("RUN-LIMIT-UNRESOLVABLE", detailLimit(nodeId));
					return;
				}
				pending.push({ at: limitDestination, from: { ...source }, ...(fanOut ? { fanOut: { ...fanOut } } : {}), via: { kind: "on-limit", node: nodeId } });
				return;
			}
			if (scheduled.has(limitDestination)) return;
			scheduled.add(limitDestination);
			plannedVisits.set(limitDestination, (plannedVisits.get(limitDestination) ?? 0) + 1);
			plan.schedule.push({ node: limitDestination, visit: limitVisit, via: { kind: "on-limit", node: nodeId }, ...(fanOut ? { fanOut: { ...fanOut } } : {}) });
			return;
		}
		if (scheduled.has(nodeId)) return;
		scheduled.add(nodeId);
		plannedVisits.set(nodeId, (plannedVisits.get(nodeId) ?? 0) + 1);
		plan.schedule.push({ node: nodeId, visit, via, ...(fanOut ? { fanOut: { ...fanOut } } : {}) });
	};

	const emit = (destination: Destination, via: EdgeReason, source: Activation, fanOut?: Activation): void => {
		if (destination === "done" || destination === "fail") {
			addTerminal(destination, via);
			return;
		}
		const node = input.graph.nodes[destination];
		if (!node) return;
		if (node.join) {
			pending.push({ at: destination, from: { ...source }, ...(fanOut ? { fanOut: { ...fanOut } } : {}), via });
			return;
		}
		scheduleNode(destination, via, source, fanOut);
	};

	for (const result of results) {
		const node = input.graph.nodes[result.activation.node];
		if (!node) continue;
		// `terminal` is what makes "never retried into the same wall" real rather
		// than aspirational: an unknown template stays unknown however many
		// attempts the node declares, and a second ask spends budget to be told
		// the same thing (§2.4, §11.5.4).
		if (result.outcome.kind === "engine" && !result.terminal && result.attempt < node.retry.attempts) {
			plan.retry.push({
				activation: { ...result.activation },
				attempt: result.attempt + 1,
				delayMs: node.retry.backoffMs * node.retry.multiplier ** (result.attempt - 1),
				...(result.fanOut ? { fanOut: { ...result.fanOut } } : {}),
			});
			continue;
		}
		if (result.outcome.kind === "engine" && node.onError.kind === "fail") {
			addHalt("RUN-NODE-FAILED", `${node.id} ended with engine verdict ${result.outcome.verdict}.`);
			continue;
		}
		const routes = destinationsFor(node, result, input.state);
		const fanOut = routes.length > 1 ? result.activation : result.fanOut;
		for (const route of routes) emit(route.destination, route.via, result.activation, fanOut);
	}

	const joinIds = [...new Set(pending.map((token) => token.at))].sort(compareText);
	for (const joinId of joinIds) {
		const node = input.graph.nodes[joinId];
		if (!node?.join) continue;
		const sources = incomingSources(input.graph, joinId);
		const need = joinNeed(node, sources);
		const groups = groupedTokens(pending.filter((token) => token.at === joinId));
		for (const group of groups) {
			while (true) {
				const candidates = group.tokens.filter((token) => !consumed.has(token));
				let matched: JoinToken[] | undefined;
				if (node.join === "all") {
					const bySource = new Map<NodeId, JoinToken>();
					for (const token of candidates) if (sources.has(token.from.node) && !bySource.has(token.from.node)) bySource.set(token.from.node, token);
					if (bySource.size >= need) matched = [...bySource.values()].sort(compareToken);
				} else if (candidates.length >= need) {
					matched = candidates.slice(0, need);
				}
				if (!matched) break;
				for (const token of matched) {
					consumed.add(token);
					plan.consumed.push(token);
				}
				const first = matched[0];
				const via = first.via;
				const visit = nextVisit(joinId);
				if (node.limit && visit > node.limit.max) {
					const limitDestination = node.limit.onLimit;
					if (limitDestination === "done" || limitDestination === "fail") addTerminal(limitDestination, { kind: "on-limit", node: joinId });
					else {
						const limitNode = input.graph.nodes[limitDestination];
						const limitVisit = limitNode ? nextVisit(limitDestination) : 0;
						if (!limitNode || (limitNode.limit && limitVisit > limitNode.limit.max)) addHalt("RUN-LIMIT-UNRESOLVABLE", detailLimit(joinId));
						else if (limitNode.join) pending.push({ at: limitDestination, from: { ...first.from }, via: { kind: "on-limit", node: joinId } });
						else if (!scheduled.has(limitDestination)) {
							scheduled.add(limitDestination);
							plannedVisits.set(limitDestination, (plannedVisits.get(limitDestination) ?? 0) + 1);
							plan.schedule.push({ node: limitDestination, visit: limitVisit, via: { kind: "on-limit", node: joinId } });
						}
					}
				} else {
					plannedVisits.set(joinId, (plannedVisits.get(joinId) ?? 0) + 1);
					plan.schedule.push({ node: joinId, visit, via });
				}
			}
		}
		const remaining = groups.flatMap((group) => group.tokens).filter((token) => !consumed.has(token));
		if (remaining.length) {
			const have = Math.max(...groupedTokens(remaining).map((group) => node.join === "all" ? new Set(group.tokens.filter((token) => sources.has(token.from.node)).map((token) => token.from.node)).size : group.tokens.length), 0);
			plan.awaiting.push({ at: joinId, have, need });
		}
	}

	plan.consumed.sort(compareToken);
	plan.arrivals = pending.filter((token) => !consumed.has(token)).sort(compareToken);
	const cost = plan.schedule.length + plan.retry.length;
	if (haltCandidates.length) {
		plan.schedule = [];
		plan.retry = [];
		plan.halt = haltCandidates[0];
		return plan;
	}
	if (cost + input.attemptsUsed > input.graph.limits.budget) {
		plan.schedule = [];
		plan.retry = [];
		plan.halt = { code: "RUN-BUDGET-EXCEEDED", detail: detailBudget(input.graph.limits.budget, input.attemptsUsed, cost) };
		return plan;
	}
	if (terminals.has("fail") || terminals.has("done")) {
		plan.schedule = [];
		plan.retry = [];
		const terminal = terminals.has("fail") ? "fail" : "done";
		plan.terminal = { terminal, via: terminals.get(terminal)! };
	}
	return plan;
}
