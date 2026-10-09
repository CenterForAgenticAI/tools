import { isAccountGroupMemberReference, type AccountGroupMemberAvailability } from "./account-group-members.js";
import { MANAGED_FAMILIES } from "./config.js";
import type { EffectiveAccountGroupResolution } from "./group-policy.js";

export type AccountGroupFailureBlockReason =
	| "delegate-origin-unresolved" | "context-unavailable"
	| "driver-origin-unresolved" | "delegate-resolution-unavailable"
	| "driver-resolution-unavailable" | "config-invalid" | "resolution-failed" | "store-busy";
const BLOCK_REASONS: readonly AccountGroupFailureBlockReason[] = [
	"delegate-origin-unresolved", "context-unavailable", "driver-origin-unresolved",
	"delegate-resolution-unavailable", "driver-resolution-unavailable", "config-invalid", "resolution-failed", "store-busy",
];

/** Bounded cause of a `resolution-failed` block; raw error text never leaves the classifier. */
export type AccountGroupResolutionFailureCause = "store-invalid" | "filesystem" | "policy" | "unknown";
const RESOLUTION_FAILURE_CAUSES: readonly string[] = ["store-invalid", "filesystem", "policy", "unknown"];

/** Already-authorized policy only; never resolve a cwd or a delegate identity here. */
export type AccountGroupFailurePolicy =
	| { readonly kind: "resolved"; readonly resolution: EffectiveAccountGroupResolution; readonly members: readonly string[] }
	| {
		readonly kind: "blocked";
		readonly reason: AccountGroupFailureBlockReason;
		/** Read only for `resolution-failed`; missing or unrecognized formats as `unknown`. */
		readonly cause?: AccountGroupResolutionFailureCause;
	};

/** Copied availability facts, not credentials, status metadata or raw provider errors. */
export interface AccountGroupFailureCandidate extends Pick<AccountGroupMemberAvailability, "providerId" | "eligible"> {
	readonly servesModel: boolean;
	readonly authenticated?: boolean;
	readonly exhausted?: boolean;
	readonly coolingDown?: boolean;
	readonly reason?: AccountGroupMemberAvailability["reason"];
}

export type AccountGroupFailureReason =
	| AccountGroupFailureBlockReason | "policy-unavailable"
	| "no-serving-members" | "no-managed-serving-members"
	| "authentication-unavailable" | "cooldown" | "exhausted"
	| "authorization-snapshot-unavailable" | "availability-unresolved";

export interface AccountGroupFailureView {
	readonly reason: AccountGroupFailureReason;
	readonly cause?: AccountGroupResolutionFailureCause;
	readonly source?: EffectiveAccountGroupResolution["source"];
	readonly groupId?: string;
	readonly outsideEligible: boolean;
	readonly message: string;
	readonly help: string;
}

export interface AccountGroupFailureInput {
	readonly policy: AccountGroupFailurePolicy;
	readonly modelId: string;
	readonly accountLimit: number;
	readonly candidates: readonly AccountGroupFailureCandidate[];
}

// Pinned pi-ai retry.js/overflow.js act on error prose, not a group error code.
// Plain labels cannot contain the space-bearing patterns. Exclude the remaining
// compact patterns too; never manufacture an AssistantMessage to validate text.
const HOST_TRIGGER_LABEL = /overloaded|rate.?limit|429|500|502|503|504|524|service.?unavailable|server.?error|internal.?error|provider.?returned.?error|network.?error|connection.?(?:error|refused|lost)|getaddrinfo|ENOTFOUND|EAI_AGAIN|upstream.?connect|timeout|terminated|websocket.?(?:closed|error)|ResourceExhausted|request_too_large|model_context_window_exceeded|context[_]length[_]exceeded/i;

function safeLabel(value: string, maxLength: number, fallback: string): string {
	return typeof value === "string" && value.length <= maxLength &&
		/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !HOST_TRIGGER_LABEL.test(value)
		? value : fallback;
}

function managedProvider(providerId: string): boolean {
	return MANAGED_FAMILIES.some((family) => providerId === family || providerId.startsWith(`${family}-account-`));
}

// Each cause names a recovery that exists. None tells the operator to repair
// the store: no command does that, and the store may not be at fault.
const CAUSE_TEXT: Readonly<Record<AccountGroupResolutionFailureCause, readonly [string, string]>> = {
	"store-invalid": ["resolution-failed (store-invalid): the session account-group store failed validation", "Move session-account-groups.json aside (this clears saved group choices), then run /multi-account reload."],
	"filesystem": ["resolution-failed (filesystem): the session account-group store could not be read or written", "Check the file's permissions and free disk space; this session retries the store automatically."],
	"policy": ["resolution-failed (policy): two accountGroupCwdDefaults entries resolve to the same directory with different groups", "Correct accountGroupCwdDefaults in the global configuration and run /multi-account reload."],
	"unknown": ["resolution-failed (unknown): the session policy could not be read safely", "Run /multi-account reload; if it still fails, check /multi-account log and restart Pi."],
};

const REASON_TEXT: Readonly<Record<AccountGroupFailureReason, readonly [string, string]>> = {
	"delegate-origin-unresolved": ["delegate-origin-unresolved: the delegate parent could not be verified", "Start a worker from a verified parent session."],
	"context-unavailable": ["context-unavailable: the session policy context is unavailable", "Wait for the session context, then try again."],
	"driver-origin-unresolved": ["driver-origin-unresolved: the durable delegate parent could not be verified", "Start a child from a verified parent session."],
	"delegate-resolution-unavailable": ["delegate-resolution-unavailable: the parent policy is unavailable", "Restore the verified parent session policy before starting a worker."],
	"driver-resolution-unavailable": ["driver-resolution-unavailable: the durable parent policy is unavailable", "Restore the verified parent session policy before starting a child."],
	"config-invalid": ["config-invalid: the account policy configuration is invalid", "Correct the global configuration and run /multi-account reload."],
	"resolution-failed": CAUSE_TEXT.unknown,
	// A transient lease conflict, not damage: never tell the operator to repair.
	"store-busy": ["store-busy: other sessions held the account-group store for too long", "Try again in a moment; this session retries the store automatically."],
	"policy-unavailable": ["the authorized account-group policy is unavailable", "Check /multi-account group status before trying again."],
	"no-serving-members": ["no listed member serves this model", "Select a model served by a listed member or choose another group."],
	"no-managed-serving-members": ["no eligible managed member serves this unified model", "Select a listed physical model or choose a group with managed members."],
	"authentication-unavailable": ["serving managed members need usable authorization; sign in", "Sign in with /login, then run /multi-account rediscover, or choose another group."],
	"cooldown": ["serving managed members are cooling down", "Wait for recovery or choose another group."],
	"exhausted": ["serving managed members have exhausted their available usage", "Wait for usage to recover or choose another group."],
	"authorization-snapshot-unavailable": ["the authorization snapshot is unavailable", "Check provider availability, then try again or choose another group."],
	"availability-unresolved": ["no eligible managed member is available; the cause is not established", "Check /multi-account group status, sign in if needed, or choose another group."],
};

/** A cause applies only to `resolution-failed`; anything unrecognized is `unknown`. */
function blockCause(reason: AccountGroupFailureReason, cause: unknown): AccountGroupResolutionFailureCause | undefined {
	if (reason !== "resolution-failed") return undefined;
	return typeof cause === "string" && RESOLUTION_FAILURE_CAUSES.includes(cause)
		? cause as AccountGroupResolutionFailureCause : "unknown";
}

function blockReason(reason: unknown): AccountGroupFailureReason {
	return typeof reason === "string" && Object.hasOwn(REASON_TEXT, reason) &&
		(BLOCK_REASONS as readonly string[]).includes(reason)
		? reason as AccountGroupFailureBlockReason : "policy-unavailable";
}

function failureView(
	reason: AccountGroupFailureReason,
	modelId: string,
	outsideEligible: boolean,
	resolution?: Exclude<EffectiveAccountGroupResolution, { readonly source: "unrestricted" }>,
	cause?: AccountGroupResolutionFailureCause,
): AccountGroupFailureView {
	const [text, help] = cause === undefined ? REASON_TEXT[reason] : CAUSE_TEXT[cause];
	const model = safeLabel(modelId, 128, "selected-model");
	const groupId = resolution === undefined ? undefined : safeLabel(resolution.groupId, 64, "selected-group");
	const source = resolution?.source;
	const heading = groupId === undefined ? "Account group scope" : `Account group "${groupId}" (${source})`;
	const message = `${heading} cannot serve ${model}: ${text}. ${help}${outsideEligible ? " Eligible accounts exist outside this group; they remain excluded." : ""}`;
	// Only named output facts; never return caller policy, candidate objects or prose.
	if (groupId === undefined || source === undefined) {
		return Object.freeze({ reason, ...(cause === undefined ? {} : { cause }), outsideEligible, message, help });
	}
	return Object.freeze({ reason, groupId, source, outsideEligible, message, help });
}

/**
 * Format a failed unified selection from one call's already-authorized facts.
 * This observes nothing, changes no policy and grants no dispatch permission.
 * Undefined preserves the caller's existing unrestricted error byte-for-byte.
 * Mixed or unobserved causes stay unresolved, never guessed as missing auth.
 */
export function formatAccountGroupFailure(input: AccountGroupFailureInput): AccountGroupFailureView | undefined {
	const policy = input.policy;
	if (policy.kind === "blocked") {
		const reason = blockReason(policy.reason);
		return failureView(reason, input.modelId, false, undefined, blockCause(reason, policy.cause));
	}
	if (policy.kind !== "resolved") return failureView("policy-unavailable", input.modelId, false);
	const resolution = policy.resolution;
	if (resolution.source === "unrestricted") return undefined;
	if (resolution.source !== "session-override" && resolution.source !== "cwd-default" && resolution.source !== "global-default") {
		return failureView("policy-unavailable", input.modelId, false);
	}
	if (!Number.isInteger(input.accountLimit) || input.accountLimit < 1 || input.accountLimit > 32) {
		return failureView("policy-unavailable", input.modelId, false, resolution);
	}
	const validId = (id: string): boolean => isAccountGroupMemberReference(id, input.accountLimit, MANAGED_FAMILIES);
	const members = new Set(policy.members.filter(validId));
	const candidates = input.candidates.filter((row) => validId(row.providerId)).map((row) => ({
		providerId: row.providerId,
		servesModel: row.servesModel === true,
		eligible: row.eligible === true,
		authenticated: row.authenticated === false ? false : undefined,
		exhausted: row.exhausted === true,
		coolingDown: row.coolingDown === true,
		reason: row.reason === "authentication unavailable" || row.reason === "authorization snapshot unavailable" ? row.reason : undefined,
	}));
	const inside = candidates.filter((row) => members.has(row.providerId));
	const serving = inside.filter((row) => row.servesModel === true);
	const managed = serving.filter((row) => managedProvider(row.providerId));
	if (managed.some((row) => row.eligible === true)) return undefined;
	const outsideEligible = candidates.some((row) => !members.has(row.providerId) && row.servesModel === true && row.eligible === true);
	let reason: AccountGroupFailureReason;
	if (inside.some((row) => row.reason === "authorization snapshot unavailable")) reason = "authorization-snapshot-unavailable";
	else if (serving.length === 0) reason = "no-serving-members";
	else if (managed.length === 0 || serving.some((row) => !managedProvider(row.providerId) && row.eligible === true)) reason = "no-managed-serving-members";
	else if (managed.every((row) => row.authenticated === false || row.reason === "authentication unavailable")) reason = "authentication-unavailable";
	else if (managed.every((row) => row.exhausted === true)) reason = "exhausted";
	else if (managed.every((row) => row.coolingDown === true)) reason = "cooldown";
	else reason = "availability-unresolved";
	return failureView(reason, input.modelId, outsideEligible, resolution);
}
/**
 * Operator text for a blocked scope outside a unified call, such as
 * `group status` and direct-provider notices. Same closed text as the
 * unified error; never caller prose.
 */
export function describeAccountGroupBlock(
	policy: {
		readonly reason: AccountGroupFailureBlockReason;
		readonly cause?: AccountGroupResolutionFailureCause | undefined;
	},
): string {
	const reason = blockReason(policy.reason);
	const cause = blockCause(reason, policy.cause);
	const [text, help] = cause === undefined ? REASON_TEXT[reason] : CAUSE_TEXT[cause];
	return `${text}. ${help}`;
}
