import type { CompiledNode, ExecutableGraph, NodeId } from "../model.js";

/**
 * The guard surface: what a node is allowed to do while it is current, and where
 * it is allowed to go next.
 *
 * Pure. It decides; a runner or an adapter carries the decision out.
 */

/** Node kinds whose work has an agent tool surface that can be narrowed at all. */
export const TOOL_ENFORCING_KINDS: ReadonlySet<CompiledNode["kind"]> = new Set(["template", "agent"]);

export interface ToolVerdict {
	readonly allowed: boolean;
	/** Present when refused. Always names the node, so the refusal can be acted on. */
	readonly refusal?: string;
}

/**
 * Whether `tool` may run while `node` is current.
 *
 * A node that declares no allowlist restricts nothing: absence is not an empty
 * list. An empty list is a real restriction and refuses everything.
 */
export function checkTool(node: CompiledNode, tool: string): ToolVerdict {
	const allow = node.tools?.allow;
	if (!allow) return { allowed: true };
	if (allow.includes(tool)) return { allowed: true };
	return {
		allowed: false,
		refusal: `Node ${node.id} does not allow the ${tool} tool. It allows ${allow.length ? allow.join(", ") : "no tools"}.`,
	};
}

/** Every destination the compiled graph permits from `from`, terminals included. */
export function legalTargets(graph: ExecutableGraph, from: NodeId): string[] {
	const node = graph.nodes[from];
	if (!node) return [];
	const targets = new Set<string>();
	for (const target of node.transitions.next ?? []) targets.add(target);
	for (const branch of node.transitions.when) targets.add(branch.to);
	for (const target of Object.values(node.transitions.on)) targets.add(target);
	if (node.transitions.default) targets.add(node.transitions.default);
	if (node.limit?.onLimit) targets.add(node.limit.onLimit);
	if (node.onError.kind === "route") targets.add(node.onError.to);
	return [...targets];
}

export interface TransitionVerdict {
	readonly ok: boolean;
	/** Present when refused. A refusal is never rewritten into a legal move. */
	readonly refusal?: string;
	readonly legal?: string[];
}

/**
 * Whether the agent may move the run from `from` to `to`.
 *
 * An illegal target is refused and never corrected to the nearest legal one: a
 * graph that silently reinterprets a request stops being a description of what
 * will happen ([0005](../../.spec/0005-node-adapters.md) §7).
 */
export function checkTransition(graph: ExecutableGraph, from: NodeId, to: string): TransitionVerdict {
	const legal = legalTargets(graph, from);
	if (!graph.nodes[from]) return { ok: false, refusal: `Node ${from} is not part of this graph.`, legal: [] };
	if (legal.includes(to)) return { ok: true };
	return {
		ok: false,
		refusal: `Node ${from} has no edge to ${to}. Legal targets: ${legal.length ? legal.join(", ") : "none"}.`,
		legal,
	};
}

export interface UnenforceableNode {
	readonly node: NodeId;
	readonly kind: CompiledNode["kind"];
	readonly detail: string;
}

/**
 * Nodes whose declared `tools.allow` nothing present can enforce.
 *
 * Silently ignoring a declared restriction is the one outcome that must not
 * happen ([0011](../../.spec/0011-data-contracts.md) §3.3.1), so a run whose
 * assembled adapters cannot honour a list fails at start rather than part way
 * through, when the unrestricted work has already run.
 */
export function unenforceableToolPolicies(graph: ExecutableGraph, canEnforce: (kind: CompiledNode["kind"]) => boolean): UnenforceableNode[] {
	const found: UnenforceableNode[] = [];
	for (const node of Object.values(graph.nodes)) {
		if (!node.tools?.allow) continue;
		if (!TOOL_ENFORCING_KINDS.has(node.kind)) {
			found.push({ node: node.id, kind: node.kind, detail: `a ${node.kind} node has no tool surface to restrict` });
			continue;
		}
		if (!canEnforce(node.kind)) found.push({ node: node.id, kind: node.kind, detail: `no installed ${node.kind} adapter can narrow a tool surface` });
	}
	return found;
}

/** The message a run fails with when a declared allowlist cannot be honoured. */
export function unenforceableDetail(found: readonly UnenforceableNode[]): string {
	return `A declared tools.allow cannot be enforced: ${found.map((item) => `${item.node} (${item.detail})`).join("; ")}.`;
}
