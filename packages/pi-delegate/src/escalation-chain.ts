/**
 * Pure escalation-chain and timeout-policy computation.
 *
 * Callers supply raiser-adjacent → root participant descriptors explicitly;
 * this module never discovers authority from mutable runtime state. The
 * returned route is the raise-time snapshot: later topology changes do not
 * re-route it. [spec §2.2, §4; Lean DE-4a]
 */

import type { ResolvedEscalationConfig } from "./config.js";
import {
	resolutionOptionsFor,
	type EscalationAuthority,
	type EscalationCategory,
	type EscalationKind,
	type EscalationRouteNode,
	type EscalationTimeoutSpec,
} from "./escalation-store.js";

/** An explicitly supplied holder candidate, ordered raiser-adjacent → root. */
export interface EscalationChainParticipant {
	id: string;
	kind: "supervisor" | "agent" | "root";
	runId?: string;
	lineagePath?: string;
	label?: string;
	authority?: EscalationAuthority;
	intermediate?: boolean;
}

/** Resolve the v1 kind × category authority matrix. Reserved tags never match. */
export function authorityDecides(
	authority: EscalationAuthority | undefined,
	kind: EscalationKind,
	category: EscalationCategory | undefined,
): boolean {
	if (kind === "decision") {
		if (authority?.decision === "all") return true;
		// An absent category is unclassified, not implementation. Fail closed so
		// legacy/lower-level callers cannot route broader decisions to a narrow
		// implementation authority.
		return authority?.decision === "implementation" &&
			category === "implementation";
	}
	if (kind === "blocker") return authority?.blocker === "all";
	return authority?.amendment === "all";
}

/**
 * Filter silent participants into a frozen-at-raise holder route. [invariant 8]
 *
 * Lean DE-4a trace: non-authoritative/non-intermediate nodes are omitted,
 * while the human root is appended unconditionally and therefore can never
 * be filtered. This preserves liveness after silent-hop filtering.
 */
export function computeEscalationChain(args: {
	raiser: { runId: string; lineagePath: string; label?: string };
	participants: EscalationChainParticipant[];
	kind: EscalationKind;
	category?: EscalationCategory;
	includeUser?: boolean;
}): { chain: EscalationRouteNode[]; holderIndex: number } {
	// Raiser identity deliberately does not enter the holder chain. Reading it
	// here makes that contract explicit and prevents accidental route synthesis.
	void args.raiser;
	const chain: EscalationRouteNode[] = [];
	for (const participant of args.participants) {
		const isStop = participant.kind === "supervisor" ||
			participant.intermediate === true ||
			authorityDecides(participant.authority, args.kind, args.category);
		if (!isStop) continue;
		chain.push(cloneParticipant(participant));
	}
	if (args.includeUser !== false) chain.push({ id: "user", kind: "user" });
	if (chain.length === 0) {
		throw new Error("escalation chain must contain at least one holder");
	}
	return { chain, holderIndex: 0 };
}

/**
 * Materialize invariant-3 / Lean DE-8 timeout policy data for one request.
 *
 * Decisions leave `defaultSelection` absent so the timeout sweep can use the
 * request's recommended option. Blockers receive twice their configured base
 * timeout because remediation commonly needs external action. Amendments
 * encode reject-on-timeout by selecting the synthesized "Reject" option.
 */
export function defaultTimeoutSpecFor(
	kind: EscalationKind,
	config: ResolvedEscalationConfig,
	now: Date = new Date(),
): EscalationTimeoutSpec {
	const timeoutMs = config.timeoutMs[kind] * (kind === "blocker" ? 2 : 1);
	const configuredBehavior = config.timeoutBehavior[kind];
	// Config's built-in "useDefault" marker resolves to each kind's DE-8
	// policy; an explicit non-default per-kind value wins unchanged.
	const behavior = configuredBehavior === "useDefault" && kind === "blocker"
		? "cancel"
		: configuredBehavior;
	const spec: EscalationTimeoutSpec = {
		behavior,
		deadlineAt: new Date(now.getTime() + timeoutMs).toISOString(),
	};
	if (kind === "amendment" && behavior === "useDefault") {
		const options = resolutionOptionsFor("amendment", {
			target: "timeout-policy",
			change: "timeout-policy",
			rationale: "timeout-policy",
		});
		const rejectIndex = options.findIndex((option) => option.label === "Reject");
		if (rejectIndex < 0) throw new Error('synthesized amendment options lack "Reject"');
		spec.defaultSelection = [rejectIndex];
	}
	return spec;
}

/**
 * Compute the ratified per-hop auto-pass deadline (Q2).
 *
 * An explicit hop timeout wins. Otherwise use one tenth of the request's
 * remaining timeout with a 30-second floor. Either path is capped at the
 * terminal request deadline, so a hop can never outlive the request itself.
 */
export function hopDeadlineFor(
	config: ResolvedEscalationConfig,
	timeoutSpec: EscalationTimeoutSpec,
	now: Date = new Date(),
): string | undefined {
	const requestDeadlineMs = timeoutSpec.deadlineAt === undefined
		? undefined
		: Date.parse(timeoutSpec.deadlineAt);
	if (requestDeadlineMs !== undefined && !Number.isFinite(requestDeadlineMs)) return undefined;

	const fallbackRequestMs = Math.min(...Object.values(config.timeoutMs));
	const remainingMs = requestDeadlineMs === undefined
		? fallbackRequestMs
		: Math.max(0, requestDeadlineMs - now.getTime());
	const hopMs = config.hopTimeoutMs ?? Math.max(30_000, remainingMs / 10);
	const candidateMs = now.getTime() + hopMs;
	const deadlineMs = requestDeadlineMs === undefined
		? candidateMs
		: Math.min(candidateMs, requestDeadlineMs);
	return new Date(deadlineMs).toISOString();
}

function cloneParticipant(participant: EscalationChainParticipant): EscalationRouteNode {
	return {
		...participant,
		...(participant.authority !== undefined
			? {
				authority: {
					...participant.authority,
					...(participant.authority.tags !== undefined
						? { tags: [...participant.authority.tags] }
						: {}),
				},
			}
			: {}),
	};
}
