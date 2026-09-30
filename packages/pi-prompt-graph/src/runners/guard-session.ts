import { checkTool, checkTransition, legalTargets, TOOL_ENFORCING_KINDS } from "../pure/guard.js";
import type { CompiledNode, ExecutableGraph, NodeId } from "../model.js";
import type { CurrentNodes } from "./embedded.js";

/**
 * The live half of the guard surface: Mode A, where the graph constrains the
 * agent sharing its session.
 *
 * Every decision is in `src/pure/guard.ts` and already tested — what a node
 * allows, which transitions are legal, which policies cannot be enforced. This
 * file holds the one thing a test cannot supply: knowing which node is current
 * in a running session, and saying no at the moment a tool is about to run.
 */

/** What a blocked tool call returns to Pi. `block` is Pi's own contract. */
export interface ToolBlock {
	readonly block: true;
	readonly reason: string;
}

/** Journalled so a later reading of the run can see what was refused, and why. */
export interface GuardRefusal {
	readonly nodeId: NodeId;
	readonly tool: string;
	readonly reason: string;
}

/**
 * Holds which nodes are current, and decides whether a tool may run.
 *
 * Implements `CurrentNodes`, so the runner publishes into it directly.
 *
 * **Nothing current means nothing refused.** Between nodes the agent is working
 * for the person, not for the graph, and a graph that policed the whole session
 * would be a very surprising thing to have installed.
 */
export class SessionGuard implements CurrentNodes {
	private current: readonly CompiledNode[] = [];
	private readonly refusals: GuardRefusal[] = [];

	enter(nodes: readonly CompiledNode[]): void {
		this.current = nodes;
	}

	leave(): void {
		this.current = [];
	}

	/** The nodes currently running, for a status line or a test. */
	currentNodeIds(): string[] {
		return this.current.map((node) => node.id);
	}

	/** Every refusal so far, oldest first. */
	recorded(): readonly GuardRefusal[] {
		return this.refusals;
	}

	/**
	 * Decide whether `tool` may run right now.
	 *
	 * Returns `undefined` to allow, which is what Pi's `tool_call` hook expects
	 * from a handler with no opinion.
	 *
	 * Three rules, in order:
	 *
	 * 1. **No node current: allowed.** The graph is not running, or is between
	 *    nodes.
	 * 2. **A node with no `tools.allow`: allowed.** Absence is not an empty list.
	 * 3. **Otherwise the declared allowlists decide.** With a concurrent batch a
	 *    tool is allowed if **any node that declared a list** permits it.
	 *
	 * The mixed case is the subtle one and the filter below is what decides it:
	 * when one running node declares `allow: [read]` and another declares
	 * nothing, `write` is **refused**. Counting the unrestricted node as a
	 * permission would let its presence silently cancel a restriction the other
	 * node's author wrote down, and silently ignoring a declared restriction is
	 * the one outcome §3.3.1 forbids outright. Nodes that declared nothing are
	 * therefore not consulted, rather than treated as allowing everything.
	 *
	 * Only kinds with a tool surface are consulted at all. A `command` node
	 * cannot declare `tools.allow` — the compiler rejects it — so nothing here
	 * has to reason about what its allowlist would have meant.
	 */
	check(tool: string): ToolBlock | undefined {
		const enforcing = this.current.filter((node) => TOOL_ENFORCING_KINDS.has(node.kind) && node.tools?.allow);
		if (!enforcing.length) return undefined;
		const verdicts = enforcing.map((node) => ({ node, verdict: checkTool(node, tool) }));
		if (verdicts.some((entry) => entry.verdict.allowed)) return undefined;
		// Every current node refused. The message names the node whose declaration
		// is being enforced, because "a tool was blocked" with no node is not
		// something an author can act on.
		const first = verdicts[0]!;
		const reason = verdicts.length === 1
			? first.verdict.refusal!
			: `${verdicts.map((entry) => entry.verdict.refusal).join(" ")} No node running right now allows ${tool}.`;
		this.refusals.push({ nodeId: first.node.id, tool, reason });
		return { block: true, reason };
	}
}

/**
 * What the agent asked for when it called `graph_transition`.
 *
 * The graph delegates a routing decision to the agent by giving it this tool.
 * The request is checked against the compiled edges and **refused rather than
 * corrected** when it is illegal (D-057): a graph that quietly reinterprets a
 * request has stopped being a description of what will happen.
 */
export interface TransitionRequest {
	readonly to: string;
}

export interface TransitionOutcome {
	readonly ok: boolean;
	/** Present when refused, naming the legal targets so the agent can choose again. */
	readonly reason?: string;
	readonly legal?: string[];
}

/**
 * Decide an agent's requested transition, from whichever node is current.
 *
 * Refuses when nothing is current: a transition request outside a run has no
 * "from" to be legal relative to, and inventing one would let the agent move a
 * run that is not happening.
 *
 * With a concurrent batch it refuses too, and says so. Which of two running
 * nodes the agent meant to move is genuinely ambiguous, and guessing is the
 * failure D-057 exists to prevent.
 */
export function decideTransition(graph: ExecutableGraph, current: readonly CompiledNode[], request: TransitionRequest): TransitionOutcome {
	if (!current.length) return { ok: false, reason: "No graph node is running, so there is no transition to make." };
	if (current.length > 1) {
		return {
			ok: false,
			reason: `${current.length} nodes are running concurrently (${current.map((node) => node.id).join(", ")}), so a transition request is ambiguous. It is refused rather than guessed.`,
		};
	}
	const from = current[0]!;
	const verdict = checkTransition(graph, from.id, request.to);
	if (verdict.ok) return { ok: true };
	return { ok: false, ...(verdict.refusal ? { reason: verdict.refusal } : {}), legal: verdict.legal ?? legalTargets(graph, from.id) };
}
