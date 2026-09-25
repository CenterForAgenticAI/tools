import type { AgentConfig } from "./agents.js";
import { resolveChildCwd } from "./cwd-resolution.js";
import { savedChainContextForStep } from "./saved-chain-context.js";
import {
	isPathWithinRoots,
	resolveWriteConfinementRoot,
	type WriteConfinementPolicy,
} from "./write-confinement.js";

export interface NestedDelegateCallerPolicy {
	/** Name of the delegated worker agent attempting the nested delegate call. */
	agentName: string;
	/** True only when the worker agent explicitly opted into nested delegation. */
	allowNestedDelegate?: boolean;
	/** Optional allow-list of child agent names this worker may delegate to. Empty/absent means unrestricted. */
	nestedDelegateAgents?: readonly string[];
	/**
	 * The write authority this caller itself runs under, when it is a confined
	 * worker. Present so a nested dispatch cannot hand its child more filesystem
	 * authority than the caller holds: without it, a worker confined to one
	 * worktree could dispatch a child with `confineWrites: false` or
	 * `writableRoots: ["/"]` and write anywhere through that child.
	 */
	confinement?: WriteConfinementPolicy;
	/** Read-only callers may only delegate explicitly read-only children. */
	readOnly?: boolean;
	/** Immutable absolute deadline inherited by an explicitly nested direct call. */
	parentDeadlineAtMs?: number;
}

/** One slot's requested filesystem authority, for the nested clamp. */
export interface NestedConfinementRequest {
	/** Human-readable slot label used in refusal messages. */
	label: string;
	cwd?: unknown;
	writableRoots?: unknown;
	confineWrites?: unknown;
	readOnly?: unknown;
}

export type NestedDelegateShape =
	| "supervised"
	| "parallel-direct"
	| "single-direct"
	| "orchestrate"
	| "chain"
	| "chain-by-name"
	| "action"
	| "unknown"
	| "ambiguous";

/**
 * Build the delegate-owned runtime policy snapshot for a worker agent.
 *
 * `confinement` is the write policy actually installed for this worker, so a
 * nested dispatch can be clamped to it. Omitting it means the caller is
 * unconfined and its children are governed only by their own settings.
 */
export function nestedDelegatePolicyForAgent(
	agent: Pick<AgentConfig, "name" | "allowNestedDelegate" | "nestedDelegateAgents">,
	confinement?: WriteConfinementPolicy,
): NestedDelegateCallerPolicy {
	const allowedAgents = Array.isArray(agent.nestedDelegateAgents) ? agent.nestedDelegateAgents : undefined;
	return {
		agentName: agent.name,
		allowNestedDelegate: agent.allowNestedDelegate === true,
		...(allowedAgents && allowedAgents.length > 0
			? { nestedDelegateAgents: [...allowedAgents] }
			: {}),
		...(confinement ? { confinement } : {}),
		...(confinement?.readOnly === true ? { readOnly: true } : {}),
	};
}

/** Return every child-agent name a delegate run shape is trying to start. */
export function collectDelegateTargetAgentNames(shape: NestedDelegateShape, params: any): string[] {
	const names: string[] = [];
	const add = (value: unknown): void => {
		if (typeof value === "string" && value.trim().length > 0) names.push(value.trim());
	};
	const addChainStep = (step: any): void => {
		if (!step || typeof step !== "object") return;
		if (Array.isArray(step.parallel)) {
			for (const slot of step.parallel) add(slot?.agent);
		} else {
			add(step.agent);
		}
	};

	switch (shape) {
		case "supervised":
			for (const item of Array.isArray(params?.agents) ? params.agents : []) add(item?.agent);
			break;
		case "parallel-direct":
			for (const item of Array.isArray(params?.tasks) ? params.tasks : []) add(item?.agent);
			break;
		case "single-direct":
			add(params?.agent);
			break;
		case "orchestrate":
			add(params?.orchestrate?.agent);
			break;
		case "chain":
			for (const step of Array.isArray(params?.chain) ? params.chain : []) addChainStep(step);
			break;
		case "chain-by-name":
		case "action":
		case "unknown":
		case "ambiguous":
			break;
	}

	return [...new Set(names)];
}

/** Return every slot's requested filesystem authority for this run shape. */
export function collectDelegateConfinementRequests(
	shape: NestedDelegateShape,
	params: any,
): NestedConfinementRequest[] {
	const requests: NestedConfinementRequest[] = [];
	const add = (label: string, slot: any, includeDefaults = false): void => {
		if (!slot || typeof slot !== "object") return;
		if (
			!includeDefaults &&
			slot.cwd === undefined &&
			slot.writableRoots === undefined &&
			slot.confineWrites === undefined &&
			slot.readOnly === undefined
		) return;
		requests.push({
			label,
			...(slot.cwd !== undefined ? { cwd: slot.cwd } : {}),
			...(slot.writableRoots !== undefined ? { writableRoots: slot.writableRoots } : {}),
			...(slot.confineWrites !== undefined ? { confineWrites: slot.confineWrites } : {}),
			...(slot.readOnly !== undefined ? { readOnly: slot.readOnly } : {}),
		});
	};

	switch (shape) {
		case "supervised":
			(Array.isArray(params?.agents) ? params.agents : []).forEach((item: any, index: number) =>
				add(`agents[${index}]`, item));
			break;
		case "parallel-direct":
			(Array.isArray(params?.tasks) ? params.tasks : []).forEach((item: any, index: number) =>
				add(`tasks[${index}]`, item));
			break;
		case "single-direct":
			add("this invocation", params);
			break;
		case "orchestrate":
			add("orchestrate", params?.orchestrate);
			break;
		case "chain":
			(Array.isArray(params?.chain) ? params.chain : []).forEach((step: any, stepIndex: number) => {
				if (Array.isArray(step?.parallel)) {
					step.parallel.forEach((slot: any, slotIndex: number) =>
						add(`chain[${stepIndex}].parallel[${slotIndex}]`, slot));
					return;
				}
				const resolvedSavedLeaf =
					typeof step?.agent === "string" &&
					savedChainContextForStep(step) !== undefined;
				add(`chain[${stepIndex}]`, step, resolvedSavedLeaf);
			});
			break;
		case "chain-by-name":
		case "action":
		case "unknown":
		case "ambiguous":
			break;
	}

	return requests;
}

/**
 * Clamp a nested dispatch to the caller's own write authority.
 *
 * A confined worker is still a delegate caller, so every per-slot field that
 * widens or waives confinement is an escalation path unless it is checked here:
 * the runners install exactly the policy the request asks for, and nothing
 * downstream intersects it with the caller's roots.
 *
 * Refusals are explicit rather than silent narrowing, so a caller learns that
 * its request exceeded its authority instead of quietly getting less than it
 * asked for.
 */
export function validateNestedDelegateConfinement(
	policy: NestedDelegateCallerPolicy | undefined,
	shape: NestedDelegateShape,
	params: any,
	baseCwd: string,
): string | undefined {
	const confinement = policy?.confinement;
	if (!confinement) return undefined;
	if (shape === "unknown" || shape === "ambiguous" || shape === "action") return undefined;

	const caller = `agent '${policy!.agentName}'`;
	const rootList = confinement.roots.join(", ");
	const nativeRunStep = shape === "chain" && Array.isArray(params?.chain)
		? params.chain.find((step: unknown) =>
			typeof step === "object" && step !== null && typeof (step as { run?: unknown }).run === "string")
		: undefined;
	if (nativeRunStep) {
		const runLabel = (nativeRunStep as { run: string }).run;
		return (
			`delegate: ${caller} runs under writable-root confinement (${rootList}), so it may not execute ` +
			`native run stage '${runLabel}': the command starts in a separate process outside the caller's write guard. ` +
			"Have an unconfined caller own this saved chain."
		);
	}
	if (confinement.readOnly === true) {
		const slots: Array<{ readOnly?: unknown }> = [];
		if (shape === "supervised") slots.push(...(Array.isArray(params?.agents) ? params.agents : []));
		else if (shape === "parallel-direct") slots.push(...(Array.isArray(params?.tasks) ? params.tasks : []));
		else if (shape === "single-direct") slots.push(params);
		else if (shape === "chain") {
			for (const step of Array.isArray(params?.chain) ? params.chain : []) {
				if (Array.isArray(step?.parallel)) slots.push(...step.parallel);
				else slots.push(step);
			}
		}
		if (slots.some((slot) => slot?.readOnly !== true)) {
			// #288: state the remedy, not just the rule. The location differs by
			// dispatch shape, and naming the wrong one is worse than naming none:
			// a legacy single-direct caller sets `readOnly` at the top level, not
			// on any entry. A saved chain is resolved to its leaves before this
			// check, so its remedy lives in the chain definition, not the call.
			const remedy =
				shape === "single-direct"
					? "Set `readOnly: true` on the dispatch."
					: shape === "chain"
						? "Set `readOnly: true` on every chain step (in the saved chain definition when the chain is named)."
						: "Set `readOnly: true` on every run entry.";
			return `delegate: ${caller} is read-only and may dispatch only child slots with readOnly: true. ${remedy}`;
		}
	}

	// A detached driver runs as a separate `pi` process, so delegate
	// cannot install a write guard in it at all. A confined caller must not be
	// able to obtain an unconfined writer by going through that shape.
	if (shape === "orchestrate") {
		return (
			`delegate: ${caller} runs under writable-root confinement (${rootList}), so it may not dispatch the ` +
			"`driver` mode: the detached driver is a separate process that delegate cannot confine. " +
			"Dispatch a direct or supervised worker instead, or have an unconfined caller own the driver run."
		);
	}

	// A chain-level cwd becomes the execution base for every sequential and
	// parallel leaf. Validate that explicit base itself, then resolve per-step
	// cwd values against it exactly as chain execution does. Writable roots stay
	// caller-relative below because their runtime normalization uses ctx.cwd.
	let childCwdBase = baseCwd;
	if (shape === "chain" && typeof params?.cwd === "string" && params.cwd !== "") {
		childCwdBase = resolveChildCwd(baseCwd, params.cwd);
		if (!isPathWithinRoots(childCwdBase, confinement)) {
			return (
				`delegate: ${caller} runs under writable-root confinement (${rootList}), so chain may not ` +
				`use cwd ${childCwdBase}: a child confined to a directory outside the caller's roots would still be ` +
				"an escape. Choose a cwd inside the caller's roots."
			);
		}
	}

	for (const request of collectDelegateConfinementRequests(shape, params)) {
		if (request.confineWrites === false) {
			return (
				`delegate: ${caller} runs under writable-root confinement (${rootList}), so it may not set ` +
				"`confineWrites: false` on " + request.label + ". A confined caller cannot grant a child more " +
				"filesystem authority than it holds itself."
			);
		}

		const childCwd = resolveChildCwd(
			childCwdBase,
			typeof request.cwd === "string" ? request.cwd : undefined,
		);
		if (!isPathWithinRoots(childCwd, confinement)) {
			return (
				`delegate: ${caller} runs under writable-root confinement (${rootList}), so ${request.label} may not ` +
				`use cwd ${childCwd}: a child confined to a directory outside the caller's roots would still be ` +
				"an escape. Choose a cwd inside the caller's roots."
			);
		}

		const requestedRoots = Array.isArray(request.writableRoots) ? request.writableRoots : [];
		for (const raw of requestedRoots) {
			if (typeof raw !== "string" || raw.length === 0) continue;
			const childRoot = resolveWriteConfinementRoot(baseCwd, raw);
			if (!isPathWithinRoots(childRoot, confinement)) {
				return (
					`delegate: ${caller} runs under writable-root confinement (${rootList}), so ${request.label} may not ` +
					`add writable root ${childRoot}: a child's roots must be inside the caller's own roots.`
				);
			}
		}
	}

	return undefined;
}

/**
 * Validate a nested worker's delegate call against its agent-level policy.
 * Returns a clear user-facing error string when the call should be denied.
 */
export function validateNestedDelegateAgentPolicy(
	policy: NestedDelegateCallerPolicy | undefined,
	shape: NestedDelegateShape,
	params: any,
): string | undefined {
	if (!policy) return undefined;
	if (shape === "unknown" || shape === "ambiguous") return undefined;

	if (policy.allowNestedDelegate !== true) {
		return (
			`delegate: nested delegation is not enabled for agent '${policy.agentName}'. ` +
			"Add `allowNestedDelegate: true` to that agent and explicitly list any requested delegate tools in `tools:`."
		);
	}

	const allowed = (policy.nestedDelegateAgents ?? [])
		.map((name) => name.trim())
		.filter(Boolean);
	if (allowed.length === 0) return undefined;

	const allowedSet = new Set(allowed);
	const requested = collectDelegateTargetAgentNames(shape, params);
	const denied = requested.filter((name) => !allowedSet.has(name));
	if (denied.length === 0) return undefined;

	return (
		`delegate: agent '${policy.agentName}' may only nested-delegate to ` +
		`nestedDelegateAgents [${allowed.join(", ")}]; denied child agent(s): ${denied.join(", ")}.`
	);
}
