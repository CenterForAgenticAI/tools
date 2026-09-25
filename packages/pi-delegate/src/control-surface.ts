/**
 * The consolidated control and escalation surface (#265, spec §2/§6).
 *
 * Eleven separately advertised tools become two action tools:
 *
 *   delegate_control     action: status | result | prompt_status | steer | follow_up | ui_answer | cancel | recover
 *   delegate_escalation  action: list | resolve | pass_up
 *
 * Three properties this module is responsible for:
 *
 * 1. **Routing, not reimplementation.** Each action forwards to the existing
 *    per-name executor. The legacy executors are unchanged, so behaviour,
 *    authority checks, and error handling move verbatim rather than being
 *    re-derived. The legacy names also remain the internal invoke keys used by
 *    the runtime API, at zero model-visible cost.
 *
 * 2. **Per-action requiredness at runtime.** One flat schema cannot express
 *    "runId is required for result but optional for status", so the schema
 *    stays permissive and this module enforces requiredness with a usage-help
 *    error naming the action and the missing field.
 *
 * 3. **Action-level authority.** A worker that may inspect its own run must
 *    still never recover one, so authorization is keyed by action rather than
 *    by tool name.
 */

import { hasSessionControlGrants, lookupSessionControlGrants } from "./control-grant-registry.js";
import { getActiveDelegateOnlyMode } from "./delegate-only/runtime-state.js";

/** Actions routed by `delegate_control`, in the order they are advertised. */
export const CONTROL_ACTIONS = [
	"status",
	"result",
	"prompt_status",
	"steer",
	"follow_up",
	"ui_answer",
	"cancel",
	"recover",
] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];

/** Control actions retained by a delegate-only supervised worker. */
export const DELEGATE_ONLY_STEERING_ACTIONS: readonly ControlAction[] = [
	"status",
	"result",
	"prompt_status",
	"steer",
	"follow_up",
	"ui_answer",
	"cancel",
];

/** Actions routed by `delegate_escalation`. */
export const ESCALATION_ACTIONS = ["list", "resolve", "pass_up"] as const;
export type EscalationAction = (typeof ESCALATION_ACTIONS)[number];

/**
 * Action → the legacy tool name whose executor implements it.
 *
 * These names remain the internal routing keys. They are also accepted
 * indefinitely as `tools:` allowlist aliases, so an agent definition written
 * against the old surface keeps working without an edit.
 */
export const CONTROL_ROUTE: Record<ControlAction, string> = {
	status: "delegate_status",
	result: "delegate_result",
	prompt_status: "delegate_prompt_status",
	steer: "delegate_steer",
	follow_up: "delegate_follow_up",
	ui_answer: "delegate_ui_answer",
	cancel: "delegate_cancel",
	recover: "delegate_recover",
};

export const ESCALATION_ROUTE: Record<EscalationAction, string> = {
	list: "delegate_escalations",
	resolve: "delegate_resolve_escalation",
	pass_up: "delegate_escalate",
};

/**
 * The eleven legacy tool names the two action tools replace.
 *
 * These keep working as internal invoke keys and as `tools:` allowlist aliases,
 * but they are no longer advertised to the model — that is where the context
 * saving comes from. `delegate` itself is deliberately absent: it remains a
 * first-class advertised tool.
 */
export const LEGACY_CONTROL_TOOL_NAMES: ReadonlySet<string> = new Set([
	...Object.values(CONTROL_ROUTE),
	...Object.values(ESCALATION_ROUTE),
]);

/**
 * Fields each action requires, enforced at runtime because the flat schema
 * cannot express per-action requiredness. Everything else is optional.
 */
const CONTROL_REQUIRED: Record<ControlAction, string[]> = {
	status: [],
	result: ["runId"],
	prompt_status: ["runId"],
	steer: ["runId", "message"],
	follow_up: ["runId", "message"],
	ui_answer: ["runId", "questionId", "answer"],
	cancel: ["runId"],
	recover: ["runId"],
};

const ESCALATION_REQUIRED: Record<EscalationAction, string[]> = {
	list: [],
	resolve: ["requestId", "selected"],
	pass_up: [],
};

/**
 * Actions a delegated worker may never invoke on its own runs.
 *
 * `recover` re-dispatches workers, so it stays foreground-only; this replaces
 * the previous name-level strip of `delegate_recover` with an equivalent
 * action-level rule. Every other action remains subject to the same authority
 * checks the legacy executors already perform.
 */
export const WORKER_DENIED_CONTROL_ACTIONS: readonly ControlAction[] = ["recover"];

/**
 * Is this process a delegated worker rather than the originating session?
 *
 * Two independent markers, either of which is sufficient:
 *
 * - `PI_DELEGATE_LINEAGE_DEPTH` is exported into every delegated session, so a
 *   depth above zero means this session was itself dispatched.
 * - `PI_DELEGATE_WORKER_TOOL_SCOPE_V1` is the detached-worker tool-scope
 *   envelope, present only in a hosted worker.
 *
 * Read from the environment rather than from session state so the answer is the
 * same on the in-process and detached paths, and so it cannot be spoofed by a
 * tool argument. Defaults to "not a worker": the originating foreground session
 * has neither marker, and a false positive there would strip an authority the
 * operator legitimately holds.
 */
export function isDelegatedWorkerEnv(
	env: NodeJS.ProcessEnv = process.env,
	options: { lineageDepth?: number | undefined } = {},
): boolean {
	// An IN-PROCESS worker shares the foreground process and therefore its
	// environment: the env markers below are absent, and only the async-context
	// lineage frame identifies it. Reading env alone fails open for exactly the
	// sessions that run inside the dispatching process.
	if (typeof options.lineageDepth === "number" && options.lineageDepth > 0) return true;
	const scope = env.PI_DELEGATE_WORKER_TOOL_SCOPE_V1;
	if (typeof scope === "string" && scope.length > 0) return true;
	const depth = Number.parseInt(env.PI_DELEGATE_LINEAGE_DEPTH ?? "", 10);
	return Number.isFinite(depth) && depth > 0;
}

/**
 * Action grants in force for this call.
 *
 * Read from the trusted session registry when the session was constructed as
 * action-scoped, and otherwise from the detached tool-scope envelope. Returns `undefined` when the process carries no grant map, meaning
 * "unrestricted" — a foreground session, or a worker whose surface granted the
 * tool by bare name.
 *
 * Parsed defensively: a malformed envelope yields no restriction rather than
 * throwing inside a tool call, because the surface layer has already decided
 * whether this process may hold the tool at all. The grant narrows an
 * already-granted tool; it is not the thing that grants it.
 */
export function workerControlGrants(
	toolName: string,
	env: NodeJS.ProcessEnv = process.env,
	sessionId?: string,
): readonly string[] | undefined {
	const sessionScoped = hasSessionControlGrants(sessionId);
	const raw = env.PI_DELEGATE_WORKER_TOOL_SCOPE_V1;
	const detachedScoped = typeof raw === "string" && raw.length > 0;
	const constrainDelegateOnlyWorker = (actions: readonly string[] | undefined): readonly string[] | undefined => {
		// The foreground has neither a session grant nor a detached scope. Do not
		// narrow its control surface merely because delegate-only mode is active.
		if (!getActiveDelegateOnlyMode() || (!sessionScoped && !detachedScoped)) return actions;
		if (toolName === "delegate_control") {
			// `undefined` is the existing spelling for an unrestricted grant. The
			// delegate-only policy turns that into the seven inspection/steering actions.
			return actions === undefined
				? [...DELEGATE_ONLY_STEERING_ACTIONS]
				: DELEGATE_ONLY_STEERING_ACTIONS.filter((action) => actions.includes(action));
		}
		if (toolName === "delegate" || toolName === "delegate_escalation" || toolName === "delegate_recover") return [];
		return actions;
	};

	// Session-local state first. It is written by the PARENT while constructing
	// the worker and covers in-process direct and supervised workers, whose
	// static allowlists never produce an env envelope — carrying grants only in
	// the envelope left exactly those workers unrestricted.
	if (sessionScoped) return constrainDelegateOnlyWorker(lookupSessionControlGrants(sessionId, toolName));
	if (!detachedScoped) return undefined;
	try {
		const parsed = JSON.parse(raw) as { controlActionGrants?: Record<string, string[] | null> };
		const grants = parsed?.controlActionGrants;
		if (!grants || !(toolName in grants)) return constrainDelegateOnlyWorker(undefined);
		const actions = grants[toolName];
		// `null` is the wire spelling of an unrestricted grant.
		return constrainDelegateOnlyWorker(actions === null ? undefined : actions);
	} catch {
		return undefined;
	}
}

export class ControlUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ControlUsageError";
	}
}

/** A required field counts as supplied only when it is present and non-empty. */
function isMissing(value: unknown): boolean {
	if (value === undefined || value === null) return true;
	if (typeof value === "string") return value.length === 0;
	return false;
}

/**
 * Validate one action call and return the legacy tool name to route to.
 *
 * The error text names the tool, the action, and the missing field, so a model
 * that guessed the shape can correct itself in one round-trip instead of
 * probing. `known` is listed on an unknown action for the same reason.
 */
export function resolveControlCall(
	params: Record<string, unknown> | undefined,
	options: { workerDenied?: boolean; grantedActions?: readonly string[] } = {},
): { action: ControlAction; route: string } {
	const action = params?.action;
	if (typeof action !== "string" || action.length === 0) {
		throw new ControlUsageError(
			`delegate_control requires an action; known actions: ${CONTROL_ACTIONS.join(", ")}`,
		);
	}
	if (!(CONTROL_ACTIONS as readonly string[]).includes(action)) {
		throw new ControlUsageError(
			`delegate_control: unknown action \`${action}\`; known actions: ${CONTROL_ACTIONS.join(", ")}`,
		);
	}
	const typed = action as ControlAction;
	if (options.workerDenied && WORKER_DENIED_CONTROL_ACTIONS.includes(typed)) {
		throw new ControlUsageError(
			`delegate_control: action \`${typed}\` is not available to a delegated worker; it dispatches new work and stays with the originating session`,
		);
	}
	// An action-scoped `tools:` grant restricts this call. Enforced here because
	// the surface can only grant or withhold the whole tool: without this, a
	// worker granted `delegate_control:status` could invoke `cancel`.
	if (options.grantedActions !== undefined && !options.grantedActions.includes(typed)) {
		throw new ControlUsageError(
			`delegate_control: action \`${typed}\` is not granted to this worker; granted: ${
				options.grantedActions.length > 0 ? options.grantedActions.join(", ") : "(none)"
			}`,
		);
	}
	for (const field of CONTROL_REQUIRED[typed]) {
		if (isMissing(params?.[field])) {
			throw new ControlUsageError(
				`delegate_control: action \`${typed}\` requires \`${field}\``,
			);
		}
	}
	return { action: typed, route: CONTROL_ROUTE[typed] };
}

export function resolveEscalationCall(
	params: Record<string, unknown> | undefined,
	options: { grantedActions?: readonly string[] } = {},
): { action: EscalationAction; route: string } {
	const action = params?.action;
	if (typeof action !== "string" || action.length === 0) {
		throw new ControlUsageError(
			`delegate_escalation requires an action; known actions: ${ESCALATION_ACTIONS.join(", ")}`,
		);
	}
	if (!(ESCALATION_ACTIONS as readonly string[]).includes(action)) {
		throw new ControlUsageError(
			`delegate_escalation: unknown action \`${action}\`; known actions: ${ESCALATION_ACTIONS.join(", ")}`,
		);
	}
	const typed = action as EscalationAction;
	if (options.grantedActions !== undefined && !options.grantedActions.includes(typed)) {
		throw new ControlUsageError(
			`delegate_escalation: action \`${typed}\` is not granted to this worker; granted: ${
				options.grantedActions.length > 0 ? options.grantedActions.join(", ") : "(none)"
			}`,
		);
	}
	for (const field of ESCALATION_REQUIRED[typed]) {
		if (isMissing(params?.[field])) {
			throw new ControlUsageError(
				`delegate_escalation: action \`${typed}\` requires \`${field}\``,
			);
		}
	}
	return { action: typed, route: ESCALATION_ROUTE[typed] };
}

/** Reverse of the route tables: legacy tool name → the action that replaced it. */
const LEGACY_NAME_TO_GRANT = new Map<string, { tool: string; action: string }>([
	...Object.entries(CONTROL_ROUTE).map(
		([action, legacy]) => [legacy, { tool: "delegate_control", action }] as const,
	),
	...Object.entries(ESCALATION_ROUTE).map(
		([action, legacy]) => [legacy, { tool: "delegate_escalation", action }] as const,
	),
]);

const ACTIONS_BY_TOOL: Record<string, readonly string[]> = {
	delegate_control: CONTROL_ACTIONS,
	delegate_escalation: ESCALATION_ACTIONS,
};

export interface ToolGrant {
	/** The advertised tool this entry grants. */
	tool: string;
	/**
	 * Actions granted on it. `undefined` means every action — a bare tool name
	 * is an unrestricted grant, matching how `tools:` behaved before actions
	 * existed.
	 */
	actions?: string[];
}

/**
 * Parse one `tools:` entry into a grant.
 *
 * Three accepted forms, all of which appear in agent files today:
 *
 *   delegate_control              every action (bare name = unrestricted)
 *   delegate_control:status       one action
 *   delegate_status               legacy name, mapped to delegate_control:status
 *
 * One grant per CSV entry, deliberately: `splitCsv` splits on commas, so a
 * multi-action form like `delegate_control:status|result` would either collide
 * with that split or invent a second delimiter. Repeating the entry is
 * unambiguous and needs no new syntax.
 *
 * Returns `undefined` for an entry this module does not own, so the caller can
 * pass it through untouched.
 */
export function parseToolGrant(entry: string): ToolGrant | undefined {
	const trimmed = entry.trim();
	if (trimmed.length === 0) return undefined;
	const colon = trimmed.indexOf(":");
	const name = colon === -1 ? trimmed : trimmed.slice(0, colon);
	const action = colon === -1 ? undefined : trimmed.slice(colon + 1).trim();

	const legacy = LEGACY_NAME_TO_GRANT.get(name);
	if (legacy) {
		// A legacy name is an alias for exactly the action that replaced it, so it
		// grants no more than it used to. Any suffix on it is ignored rather than
		// honoured: `delegate_status:cancel` must not become a cancel grant.
		return { tool: legacy.tool, actions: [legacy.action] };
	}

	const known = ACTIONS_BY_TOOL[name];
	if (!known) return undefined;
	if (action === undefined) return { tool: name };
	if (action.length === 0 || !known.includes(action)) {
		// An unknown action grants nothing on this tool rather than everything:
		// a typo must fail closed.
		return { tool: name, actions: [] };
	}
	return { tool: name, actions: [action] };
}

/**
 * Fold a parsed `tools:` list into one grant per tool.
 *
 * A bare name anywhere in the list wins over action-scoped entries for the same
 * tool, because it is the broader grant and narrowing it would silently ignore
 * what the author wrote.
 */
export function mergeToolGrants(entries: readonly string[]): Map<string, ToolGrant> {
	const merged = new Map<string, ToolGrant>();
	for (const entry of entries) {
		const grant = parseToolGrant(entry);
		if (!grant) continue;
		const existing = merged.get(grant.tool);
		if (!existing) {
			merged.set(grant.tool, { tool: grant.tool, actions: grant.actions ? [...grant.actions] : undefined });
			continue;
		}
		if (existing.actions === undefined || grant.actions === undefined) {
			existing.actions = undefined; // unrestricted wins
			continue;
		}
		for (const action of grant.actions) {
			if (!existing.actions.includes(action)) existing.actions.push(action);
		}
	}
	return merged;
}

/** Is `action` permitted by a merged grant map? Absent tool means no grant. */
export function grantPermits(grants: Map<string, ToolGrant>, tool: string, action: string): boolean {
	const grant = grants.get(tool);
	if (!grant) return false;
	return grant.actions === undefined || grant.actions.includes(action);
}

/** Fields accepted by one of the legacy executors behind the two action tools. */
const FORWARDED_FIELDS = [
	"runId",
	"forkName",
	"message",
	"questionId",
	"answer",
	"reason",
	"deliverAs",
	"strategy",
	"tail",
	"tailLines",
	"targetLineagePath",
	"capToken",
	"rootRunId",
	"requestId",
	"requestIds",
	"selected",
	"customInstruction",
	"note",
	"onBehalfOfUser",
	"context",
	"recommendation",
] as const;

/** Copy only named executor fields; caller-only input must not cross the routing boundary. */
export function forwardedParams(params: Record<string, unknown> | undefined): Record<string, unknown> {
	if (params === undefined) return {};
	const out: Record<string, unknown> = {};
	for (const field of FORWARDED_FIELDS) {
		if (Object.hasOwn(params, field) && params[field] !== undefined) out[field] = params[field];
	}
	return out;
}
