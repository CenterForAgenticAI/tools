import type { SessionThinkingPolicy } from "./thinking-policy.js";
import { THINKING_POLICY_ENTRY_TYPE } from "./thinking-policy.js";
import {
	FOCUS_ENTRY_TYPE,
	FOCUS_TOOL_NAME,
	buildFocusSeed,
	type FocusSeedSessionOptions,
} from "./focus-seam.js";
import {
	TASKS_ENTRY_TYPE,
	TASKS_TOOL_NAME,
	buildSessionTasksSeed,
	type SeedSessionOptions,
	type TasksSeed,
} from "./task-seam.js";
import { SESSION_POLICY_ENTRY_TYPE, workerSessionRolePolicy } from "./session-role-seam.js";
import { PROMPT_REPAIR_DELEGATE_ENTRY_TYPE, type PromptRepairDelegateSeed } from "./prompt-repair-seam.js";

/** Durable producer-owned origin, independent of operational run retention. */
export const WORKER_ORIGIN_ENTRY_TYPE = "delegate.worker-origin";
export interface WorkerOrigin {
	readonly version: 1;
	readonly ownerSessionId: string;
	readonly runId: string;
	readonly forkName: string;
	readonly agent: string;
}

export type WorkerSeedAbsencePolicy = "skip" | "write-unread" | "prompt-fallback";

/** The closed, ordered set of pre-turn entries owned by a worker session. */
export const WORKER_SEED_DESCRIPTORS = [
	{ id: "worker-origin", entryType: WORKER_ORIGIN_ENTRY_TYPE, absencePolicy: "skip" },
	{ id: "thinking-policy", entryType: THINKING_POLICY_ENTRY_TYPE, absencePolicy: "skip" },
	{ id: "worker-role", entryType: SESSION_POLICY_ENTRY_TYPE, absencePolicy: "write-unread" },
	{ id: "prompt-repair", entryType: PROMPT_REPAIR_DELEGATE_ENTRY_TYPE, absencePolicy: "skip" },
	{ id: "tasks", entryType: TASKS_ENTRY_TYPE, absencePolicy: "prompt-fallback" },
	{ id: "focus", entryType: FOCUS_ENTRY_TYPE, absencePolicy: "prompt-fallback" },
] as const satisfies readonly {
	readonly id: string;
	readonly entryType: string;
	readonly absencePolicy: WorkerSeedAbsencePolicy;
}[];

export type WorkerSeedId = (typeof WORKER_SEED_DESCRIPTORS)[number]["id"];
export type WorkerSeedOutcome = "written" | "prompt-fallback" | "absent";

export interface WorkerSeedAuditRow {
	readonly id: WorkerSeedId;
	readonly entryType: string;
	readonly outcome: WorkerSeedOutcome;
}

export interface WorkerSeedSession {
	appendCustomEntry(customType: string, data?: unknown): void;
}

export interface WorkerSeedExtension {
	readonly tools?: ReadonlySet<string> | ReadonlyMap<string, unknown>;
}

export interface WorkerSeedInputs {
	readonly origin?: Omit<WorkerOrigin, "version" | "ownerSessionId" | "runId"> & {
		readonly ownerSessionId?: string;
		readonly runId?: string;
	};
	readonly thinkingPolicy?: SessionThinkingPolicy;
	readonly promptRepair?: PromptRepairDelegateSeed;
	readonly extensions?: readonly WorkerSeedExtension[];
	readonly tasks?: {
		readonly seed: TasksSeed;
		readonly options: SeedSessionOptions;
	};
	readonly focus?: {
		readonly value: unknown;
		readonly options: FocusSeedSessionOptions;
	};
	/**
	 * Tool names the worker session will actually be able to call.
	 *
	 * A loaded claimant is not sufficient: a least-privilege `tools:` allowlist
	 * can still keep the tool out of the worker's surface, which seeded a durable
	 * entry nothing could update (#338). When supplied, a seed is written only if
	 * the tool survives into this list. Omitted means "do not check", preserving
	 * the behaviour of callers that have no surface in hand.
	 */
	readonly usableToolNames?: readonly string[];
}

/** Return whether one loaded extension owns the named tool. */
export function hasToolClaimant(extensions: readonly WorkerSeedExtension[] | undefined, toolName: string): boolean {
	return extensions?.some((extension) => extension.tools?.has(toolName) === true) ?? false;
}

/**
 * Which session-declaration tools a loaded extension set actually claims.
 *
 * Reported from the live extension set rather than assumed, so a surface is only
 * ever widened for a tool that something is really going to register (#338).
 */
export function claimedSessionToolNames(
	extensions: readonly WorkerSeedExtension[] | undefined,
): string[] {
	return [TASKS_TOOL_NAME, FOCUS_TOOL_NAME].filter((name) => hasToolClaimant(extensions, name));
}

/**
 * What the worker can actually call, for deciding whether a seed is usable.
 *
 * The resolved surface is the REQUEST; the tool scope is what the worker ends
 * up with. They differ whenever an `ext:` selector is involved: a selector's
 * tools never appear in `surface.tools`, so reading the surface alone both
 * missed a tool the worker really had (a false "stripped" warning telling the
 * reader to edit a `tools:` list that is already correct) and missed a tool the
 * worker really lacked (a seed written for a checklist it could not move).
 *
 * @param scope The prepared worker tool scope.
 * @param session The worker session, when one exists yet.
 * @returns Callable tool names, or undefined when the scope cannot say.
 */
export function usableToolNamesFromScope(
	scope: { currentActiveToolNames?: (session?: never) => string[] } | undefined,
	session?: never,
): string[] | undefined {
	if (typeof scope?.currentActiveToolNames !== "function") return undefined;
	try {
		const names = scope.currentActiveToolNames(session);
		// An empty list is a real answer ("nothing is callable"), but a scope that
		// cannot enumerate must stay undefined so seeding does not refuse on a
		// guess. Only a non-array is treated as "cannot say".
		return Array.isArray(names) ? names : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether a seed for `toolName` can actually be acted on by the worker.
 *
 * Two conditions, because either one alone was wrong before: an extension must
 * claim the tool, AND the tool must survive into the worker's usable surface.
 * Checking only the first is what let a dispatch seed a durable checklist into a
 * worker whose allowlist had already stripped the tool (#338).
 */
function seedableToolIsUsable(inputs: WorkerSeedInputs, toolName: string): boolean {
	if (!hasToolClaimant(inputs.extensions, toolName)) return false;
	return inputs.usableToolNames === undefined || inputs.usableToolNames.includes(toolName);
}

/** Apply every worker-session seed once, in the descriptor order. */
export function applyWorkerSeeds(session: WorkerSeedSession, inputs: WorkerSeedInputs): WorkerSeedAuditRow[] {
	const audit: WorkerSeedAuditRow[] = [];
	for (const current of WORKER_SEED_DESCRIPTORS) {
		let outcome: WorkerSeedOutcome;
		switch (current.id) {
			case "worker-origin": {
				const origin = inputs.origin;
				if (!origin?.ownerSessionId?.trim() || !origin.runId?.trim()) {
					outcome = "absent";
				} else {
					const data: WorkerOrigin = { version: 1, ownerSessionId: origin.ownerSessionId, runId: origin.runId, forkName: origin.forkName, agent: origin.agent };
					session.appendCustomEntry(current.entryType, data);
					outcome = "written";
				}
				break;
			}
			case "thinking-policy":
				if (inputs.thinkingPolicy === undefined) {
					outcome = "absent";
				} else {
					session.appendCustomEntry(current.entryType, inputs.thinkingPolicy);
					outcome = "written";
				}
				break;
			case "worker-role":
				session.appendCustomEntry(current.entryType, workerSessionRolePolicy());
				outcome = "written";
				break;
			case "prompt-repair":
				if (inputs.promptRepair === undefined) {
					outcome = "absent";
				} else {
					session.appendCustomEntry(current.entryType, inputs.promptRepair);
					outcome = "written";
				}
				break;
			case "tasks":
				if (inputs.tasks === undefined) {
					outcome = "absent";
				} else if (!seedableToolIsUsable(inputs, TASKS_TOOL_NAME)) {
					outcome = "prompt-fallback";
				} else {
					session.appendCustomEntry(current.entryType, buildSessionTasksSeed(inputs.tasks.seed, inputs.tasks.options));
					outcome = "written";
				}
				break;
			case "focus":
				if (inputs.focus === undefined) {
					outcome = "absent";
				} else {
					const seed = buildFocusSeed(inputs.focus.value, inputs.focus.options);
					if (seed === undefined) {
						outcome = "absent";
					} else if (!seedableToolIsUsable(inputs, FOCUS_TOOL_NAME)) {
						outcome = "prompt-fallback";
					} else {
						session.appendCustomEntry(current.entryType, seed);
						outcome = "written";
					}
				}
				break;
		}
		audit.push({ id: current.id, entryType: current.entryType, outcome });
	}
	return audit;
}

export function workerSeedOutcome(audit: readonly WorkerSeedAuditRow[], id: WorkerSeedId): WorkerSeedOutcome {
	return audit.find((candidate) => candidate.id === id)?.outcome ?? "absent";
}

export function isWorkerSeedPromptFallback(audit: readonly WorkerSeedAuditRow[], id: WorkerSeedId): boolean {
	return workerSeedOutcome(audit, id) === "prompt-fallback";
}

/**
 * Warn when a seed degraded even though an extension claimed its tool.
 *
 * This is the case that used to be silent and is the whole of #338: the
 * capability was present in the runtime and removed by the worker's own
 * allowlist. An ordinary degradation — nothing loaded, nothing claimed — is
 * expected and stays quiet, so this only fires on a real misconfiguration.
 *
 * Returns null when there is nothing to say.
 */
export function formatStrippedClaimantWarning(
	audit: readonly WorkerSeedAuditRow[],
	inputs: Pick<WorkerSeedInputs, "extensions" | "usableToolNames">,
): string | null {
	if (inputs.usableToolNames === undefined) return null;
	const stripped = ([["tasks", TASKS_TOOL_NAME], ["focus", FOCUS_TOOL_NAME]] as const)
		.filter(([id, toolName]) =>
			isWorkerSeedPromptFallback(audit, id)
			&& hasToolClaimant(inputs.extensions, toolName)
			&& !inputs.usableToolNames!.includes(toolName))
		.map(([, toolName]) => toolName);
	if (stripped.length === 0) return null;
	return `worker-session-seeds: ${stripped.join(", ")} ${stripped.length === 1 ? "is" : "are"} registered by a loaded extension but absent from this worker's tool surface; `
		+ `the seed degraded to a prompt checklist. Add ${stripped.length === 1 ? "it" : "them"} to the agent's \`tools:\` list, or dispatch without a seed.`;
}

/** Stable local diagnostic text. It contains no payload, timestamps, or runtime identities. */
export function formatWorkerSeedAudit(audit: readonly WorkerSeedAuditRow[]): string {
	return `worker-session-seeds audit: ${JSON.stringify(audit)}`;
}
