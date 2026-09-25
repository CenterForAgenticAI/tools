import {
	resolveEscalationConfig,
	type EscalationConfig,
	type EscalationMode,
	type EscalationTimeoutBehavior,
	type ResolvedEscalationConfig,
} from "./config.js";
import type { EscalationAuthority, EscalationKind } from "./escalation-store.js";

/** The highest-precedence layer that explicitly selected escalation mode. */
export type EscalationPolicySource = "default" | "global" | "agent" | "invocation";

export type EscalationPolicyShape =
	| "supervised"
	| "direct"
	| "parallel-direct"
	| "chain"
	| "orchestrate";

/** Immutable, once-per-slot escalation preflight result. [spec §5, Q4] */
export interface EffectiveEscalationPolicy {
	readonly enabled: boolean;
	readonly mode: EscalationMode;
	readonly config: ResolvedEscalationConfig;
	readonly source: EscalationPolicySource;
	readonly shape: EscalationPolicyShape;
}

const KINDS: readonly EscalationKind[] = ["decision", "blocker", "amendment"];

/** The only escalation route a worker may use to change a dispatched task. */
export const TASK_AMENDMENT_ESCALATION_KIND: Extract<EscalationKind, "amendment"> = "amendment";

export function dispatchedTaskEditRefusal(taskId: string): string {
	return `dispatched task ${taskId} is owned by the owner; request a scope change through the amendment escalation route`;
}
const CONFIG_FIELDS = new Set([
	"mode",
	"authority",
	"intermediate",
	"hopTimeoutMs",
	"timeoutMs",
	"timeoutBehavior",
	"holdStrategy",
]);
const AUTHORITY_FIELDS = new Set(["decision", "blocker", "amendment", "tags"]);

/** Resolve one slot exactly once using invocation > agent > global > default. */
export function resolveEscalationPolicy(args: {
	shape: EscalationPolicyShape;
	globalLayer?: EscalationConfig;
	agentLayer?: EscalationConfig;
	invocationLayer?: EscalationConfig;
}): EffectiveEscalationPolicy {
	const config = freezeResolvedConfig(resolveEscalationConfig({
		global: args.globalLayer,
		agent: args.agentLayer,
		invocation: args.invocationLayer,
	}));
	const source: EscalationPolicySource = args.invocationLayer?.mode !== undefined
		? "invocation"
		: args.agentLayer?.mode !== undefined
			? "agent"
			: args.globalLayer?.mode !== undefined
				? "global"
				: "default";
	return Object.freeze({
		enabled: config.mode === "local",
		mode: config.mode,
		config,
		source,
		shape: args.shape,
	});
}

/**
 * Parse the strict tool-argument form of the §5 escalation binding.
 * String mode shorthand is accepted; reserved `park` fails before dispatch.
 */
export function parseEscalationInvocationValue(
	value: unknown,
	fieldPath: string,
): EscalationConfig {
	if (value === "off" || value === "local") return { mode: value };
	if (!isRecord(value)) {
		throw new Error(`${fieldPath} must be "off", "local", or a partial escalation object; received ${render(value)}`);
	}
	for (const field of Object.keys(value)) {
		if (!CONFIG_FIELDS.has(field)) throw new Error(`${fieldPath}.${field} is not a supported escalation field`);
	}

	const out: EscalationConfig = {};
	if (value.mode !== undefined) {
		if (value.mode !== "off" && value.mode !== "local") {
			throw new Error(`${fieldPath}.mode must be "off" or "local"; received ${render(value.mode)}`);
		}
		out.mode = value.mode;
	}
	if (value.intermediate !== undefined) {
		if (typeof value.intermediate !== "boolean") {
			throw new Error(`${fieldPath}.intermediate must be a boolean; received ${render(value.intermediate)}`);
		}
		out.intermediate = value.intermediate;
	}
	if (value.hopTimeoutMs !== undefined) {
		const hopTimeoutMs = value.hopTimeoutMs;
		if (hopTimeoutMs === null) {
			out.hopTimeoutMs = null;
		} else {
			if (!isPositiveSafeInteger(hopTimeoutMs)) {
				throw new Error(`${fieldPath}.hopTimeoutMs must be null or a positive safe integer; received ${render(hopTimeoutMs)}`);
			}
			out.hopTimeoutMs = hopTimeoutMs;
		}
	}
	if (value.timeoutMs !== undefined) {
		out.timeoutMs = parsePerKind(
			value.timeoutMs,
			isPositiveSafeInteger,
			`${fieldPath}.timeoutMs`,
			"a positive safe integer",
		);
	}
	if (value.timeoutBehavior !== undefined) {
		out.timeoutBehavior = parsePerKind(
			value.timeoutBehavior,
			isTimeoutBehavior,
			`${fieldPath}.timeoutBehavior`,
			'"useDefault", "noDefaultError", or "cancel"',
		);
	}
	if (value.holdStrategy !== undefined) {
		if (value.holdStrategy === "park") {
			throw new Error(`${fieldPath}.holdStrategy "park" is reserved and not implemented; use "hold-open"`);
		}
		if (value.holdStrategy !== "hold-open") {
			throw new Error(`${fieldPath}.holdStrategy must be "hold-open"; received ${render(value.holdStrategy)}`);
		}
		out.holdStrategy = value.holdStrategy;
	}
	if (value.authority !== undefined) {
		out.authority = parseAuthority(value.authority, `${fieldPath}.authority`);
	}
	return out;
}

/**
 * Enforce the background-only blocking invariant before dispatch. [spec §2.4]
 * Every enabled offender is named so callers can fix a mixed batch at once.
 */
export function assertAwaitEscalationCompatibility(args: {
	awaitRequested: boolean;
	slots: Array<{ name: string; policy: EffectiveEscalationPolicy }>;
}): void {
	if (!args.awaitRequested) return;
	const offenders = args.slots.filter(({ policy }) => policy.enabled).map(({ name }) => name);
	if (offenders.length === 0) return;
	throw new Error(
		`delegate: await:true (deprecated alias: sync:true) is incompatible with escalation-enabled ` +
		`slot${offenders.length === 1 ? "" : "s"}: ${offenders.join(", ")}. ` +
		`Drop await:true (run in the background) or set escalation to "off" for every listed slot.`,
	);
}

function parseAuthority(value: unknown, fieldPath: string): EscalationAuthority {
	if (!isRecord(value)) throw new Error(`${fieldPath} must be an object; received ${render(value)}`);
	for (const field of Object.keys(value)) {
		if (!AUTHORITY_FIELDS.has(field)) throw new Error(`${fieldPath}.${field} is not a supported authority field`);
	}
	const out: EscalationAuthority = {};
	if (value.decision !== undefined) {
		if (value.decision !== "none" && value.decision !== "implementation" && value.decision !== "all") {
			throw new Error(`${fieldPath}.decision must be "none", "implementation", or "all"; received ${render(value.decision)}`);
		}
		out.decision = value.decision;
	}
	for (const kind of ["blocker", "amendment"] as const) {
		const candidate = value[kind];
		if (candidate === undefined) continue;
		if (candidate !== "none" && candidate !== "all") {
			throw new Error(`${fieldPath}.${kind} must be "none" or "all"; received ${render(candidate)}`);
		}
		out[kind] = candidate;
	}
	if (value.tags !== undefined) {
		if (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === "string")) {
			throw new Error(`${fieldPath}.tags must be an array of strings; received ${render(value.tags)}`);
		}
		out.tags = [...value.tags];
	}
	return out;
}

function parsePerKind<T>(
	value: unknown,
	isValue: (candidate: unknown) => candidate is T,
	fieldPath: string,
	expected: string,
): T | Partial<Record<EscalationKind, T>> {
	if (isValue(value)) return value;
	if (!isRecord(value)) throw new Error(`${fieldPath} must be ${expected} or a per-kind map; received ${render(value)}`);
	for (const field of Object.keys(value)) {
		if (!KINDS.includes(field as EscalationKind)) throw new Error(`${fieldPath}.${field} is not a supported escalation kind`);
	}
	const out: Partial<Record<EscalationKind, T>> = {};
	for (const kind of KINDS) {
		const candidate = value[kind];
		if (candidate === undefined) continue;
		if (!isValue(candidate)) throw new Error(`${fieldPath}.${kind} must be ${expected}; received ${render(candidate)}`);
		out[kind] = candidate;
	}
	return out;
}

function freezeResolvedConfig(config: ResolvedEscalationConfig): ResolvedEscalationConfig {
	Object.freeze(config.authority.tags);
	Object.freeze(config.authority);
	Object.freeze(config.timeoutMs);
	Object.freeze(config.timeoutBehavior);
	return Object.freeze(config);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isTimeoutBehavior(value: unknown): value is EscalationTimeoutBehavior {
	return value === "useDefault" || value === "noDefaultError" || value === "cancel";
}

function render(value: unknown): string {
	const rendered = JSON.stringify(value);
	return rendered === undefined ? String(value) : rendered;
}
