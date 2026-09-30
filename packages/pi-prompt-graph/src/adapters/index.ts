import type { CompiledNode, JsonObject, NodeOutcome } from "../model.js";
import type { ProcessIdentity } from "../runners/process-identity.js";

export interface NodeExecutionContext {
	readonly state?: JsonObject;
	readonly signal?: globalThis.AbortSignal;
	/**
	 * Called with a process group this node started, as soon as it exists. The
	 * runner journals it against **this** node, which is why it is per-execution
	 * rather than per-adapter: a concurrent batch would otherwise be unable to
	 * say which node a process belonged to (#16, D-062).
	 */
	readonly onSpawn?: (identity: ProcessIdentity) => void | Promise<void>;
	/**
	 * Which activation this execution is. An adapter that leaves durable evidence of
	 * its work names it after this, so a resume can tell **this** activation's
	 * evidence from an earlier visit's (#17, D-063).
	 */
	readonly activation?: { readonly visit: number; readonly attempt: number };
}

export interface NodeAdapter {
	run(node: CompiledNode, context?: NodeExecutionContext): Promise<NodeOutcome>;
	/**
	 * Durable evidence that an activation already completed, for a resume to adopt
	 * instead of re-running it.
	 *
	 * Optional because most kinds have none: a `command` node leaves no trace the
	 * runner can attribute to an activation, and an adapter that cannot prove what
	 * happened MUST NOT guess. Returning `undefined` means "no evidence", which is
	 * not evidence of failure — the node then re-runs, exactly as before (#17,
	 * D-063).
	 */
	recoveredResult?(nodeId: string, activation: { visit: number; attempt: number }): Promise<NodeOutcome | undefined>;
}

export type { NodeOutcome } from "../model.js";
export { AgentAdapter, GitWorktreeAllocator } from "./agent.js";
export type { AgentAdapterConfig, DelegateDispatch, DelegateDispatcher, DelegateOutcome, WorktreeAllocator } from "./agent.js";
export { CommandAdapter, runCommand } from "./command.js";
export { HumanAdapter, runHuman } from "./human.js";
export type { HumanExecutionContext } from "./human.js";
export { interpolate } from "./interpolate.js";
export { SetAdapter, runSet } from "./set.js";
export { TemplateAdapter, missingTemplateCapabilities } from "./template.js";
export type { TemplateAck, TemplateAdapterConfig, TemplateCapabilities, TemplateCompletion, TemplateInvocation, TemplateRefusalReason, TemplateSession } from "./template.js";
export { LiveTemplateSession, probeCapabilities, PROMPT_INVOKE_EVENT, PROMPT_INVOKE_ACK_EVENT, PROMPT_STARTED_EVENT, PROMPT_FINISHED_EVENT, PROMPT_PROTOCOL_VERSION } from "./live-template.js";
export type { EventBus, LiveTemplateSessionOptions, TurnSource } from "./live-template.js";
export { captureIdentity, reapIfSame, verifyIdentity } from "../runners/process-identity.js";
export type { IdentityVerdict, ProcessIdentity } from "../runners/process-identity.js";
