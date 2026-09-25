/**
 * Injected-I/O escalation tools and prompt contracts.
 *
 * Raise verbs hold only the raiser's tool call while the durable request is
 * pending (§2.3-§2.4 / DE-7). Hop verbs enforce declared authority before a
 * holder may resolve (§2.2), while every holder can explicitly pass upward.
 */

import * as crypto from "node:crypto";
import { Type, type TSchema } from "@sinclair/typebox";

import type { ResolvedEscalationConfig } from "./config.js";
import {
	authorityDecides,
	type EscalationChainParticipant,
} from "./escalation-chain.js";
import { passEscalation, raiseAndAwaitEscalation } from "./escalation-runtime.js";
import {
	listMailbox,
	readEscalationRequest,
	readOutcome,
	resolutionOptionsFor,
	resolveEscalation,
	isCustomInstructionOption,
	type EscalationAuthority,
	type EscalationCategory,
	type EscalationCredential,
	type EscalationKind,
	type EscalationOrigin,
	type EscalationOutcome,
	type EscalationPayloadByKind,
	type EscalationRequest,
} from "./escalation-store.js";
import {
	ESCALATE_AMENDMENT_TOOL,
	ESCALATE_BLOCKER_TOOL,
	ESCALATE_DECISION_TOOL,
	ESCALATE_TOOL,
	RESOLVE_ESCALATION_TOOL,
} from "./tool-surface.js";
import type { WorkerChannel } from "./worker-channel.js";
import { isSafeRunId } from "./run-id.js";

export interface EscalationToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

/** Structural AgentTool shape accepted by createAgentSession.customTools. */
export interface EscalationTool {
	name: string;
	label: string;
	description: string;
	parameters: TSchema;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<EscalationToolResult>;
}

export const ESCALATE_DECISION_DESCRIPTION =
	"Escalate a concrete, bounded choice that blocks safe progress and is beyond your authority. " +
	"Required category: use `implementation` for reversible implementation-local choices, `scope-product` for material scope, product, or UX changes, and `security-permission` for security or permission questions. " +
	"Act autonomously on reversible implementation-local choices justified by the task, repository evidence, and established conventions. " +
	"Forward material scope/product/UX changes, conflicting requirements, security or permission questions, compatibility or migration risk, destructive or irreversible actions, external side effects, and meaningful cost. " +
	"Use explicit options (2–5) and recommend one when evidence supports it; escalating is cheaper than guessing wrong.";

export const ESCALATE_BLOCKER_DESCRIPTION =
	"Escalate only when you cannot proceed at all. State the cause, describe the blocking condition precisely, and say what would unblock you; the five well-known causes are env-missing, input-missing, external-failure, upstream-pending, and decision-needed, but a precise free-form cause is accepted. " +
	"Do not use this for reversible implementation-local choices you can decide safely. Forward blockers involving scope/product, security, permissions, irreversible action, external effects, or meaningful cost; escalating is cheaper than guessing wrong.";

export const ESCALATE_AMENDMENT_DESCRIPTION =
	"Escalate when the task, plan, spec, or model itself needs changing rather than when an implementation-local choice is merely difficult. Name the target, propose the exact change, and give the rationale. " +
	"Proceed autonomously on reversible implementation-local details, but forward scope/product changes, conflicting requirements, security or permission implications, compatibility or migration risk, irreversible action, external effects, and meaningful cost. Escalating is cheaper than guessing wrong.";

export const RESOLVE_ESCALATION_DESCRIPTION =
	"Resolve a pending escalation held in this supervisor's mailbox only when declared authority covers its kind and category. Select valid zero-based resolution option indices (one unless a decision explicitly allows multi-select). To give a different answer, select the option carrying `custom: true` exclusively and provide non-empty `customInstruction`; optionally record a separate audit note. If the question is not yours to decide, use `escalate` instead.";

export const ESCALATE_HOP_DESCRIPTION =
	"Not mine; pass up. Forward scope/product, security, permission, destructive or irreversible, external-side-effect, meaningful-cost, and any other question beyond your declared authority. Omit requestIds to pass every pending request in this holder's mailbox, and annotate the trace with useful context plus a recommendation when you have one.";

/** §5 contract appended to every enabled worker system prompt, including restarts. */
export const ESCALATION_WORKER_GUIDANCE =
	"## Escalation contract\n\n" +
	"This slot has escalation enabled. Proceed autonomously on reversible implementation-local choices you can justify from the task, repository evidence, and established conventions. Escalate choices involving scope/product, security, permissions, compatibility or migration risk, destructive or irreversible action, external side effects, meaningful cost, conflicting requirements, or anything else beyond your authority. If the task explicitly requires escalation for a class of choice or condition, use the matching raise tool; do not substitute your own guess.\n" +
	"- `escalate_decision`: a bounded choice blocks safe progress; provide 2–5 explicit options.\n" +
	"  Include the required category: `implementation`, `scope-product`, or `security-permission`.\n" +
	"- `escalate_blocker`: you cannot proceed at all; state the cause, condition, and what would unblock you.\n" +
	"- `escalate_amendment`: the task/plan/spec/model itself needs an exact proposed change and rationale.\n" +
	"Calling a raise tool durably records the request and suspends only this raise tool call without model-token burn. Do not invent an answer or continue around the pending request; the eventual narrated tool result is authoritative. Escalating is cheaper than guessing wrong.";

/** §2.3 guidance appended only to an escalation-enabled supervisor clone. */
export const ESCALATION_SUPERVISOR_GUIDANCE =
	"### Escalation flow\n\n" +
	"When the worker is awaiting escalation, only the worker's raise tool call is held; do not poll, sleep, or keep a model turn open. Act promptly on request ids pending in this supervisor's mailbox. Use `resolve_escalation` only when your declared authority covers the request and you already have enough request context to choose safely. Otherwise use `escalate` for “not mine; pass up,” adding context and a recommendation when useful. Never guess an operator choice or resolve a beyond-authority request. Forward scope/product, security, permission, irreversible, external-side-effect, meaningful-cost, and any other beyond-authority questions.";

export function escalationWorkerInstructions(enabled: boolean): string[] {
	return enabled ? [ESCALATION_WORKER_GUIDANCE] : [];
}

export function appendEscalationSupervisorGuidance(base: string, enabled: boolean): string {
	return enabled ? `${base}\n\n${ESCALATION_SUPERVISOR_GUIDANCE}` : base;
}

/**
 * Stable holder identity: hash the immutable lineage address, not a display
 * label. The prefix keeps mailbox diagnostics human-recognisable; hashing
 * avoids path separators in durable mailbox directory names. [DE-4a]
 */
export function buildSupervisorEscalationHolderId(lineagePath: string): string {
	return `supervisor-${sha256(lineagePath).slice(0, 24)}`;
}

/** Stable originator holder identity for one root delegation run. */
export function buildRootEscalationHolderId(rootRunId: string): string {
	return `root-${sha256(rootRunId).slice(0, 24)}`;
}

/** Build the supervised [fork supervisor, root] candidates; user is appended by the chain core. */
export function buildSupervisedEscalationParticipants(args: {
	rootRunId: string;
	lineagePath: string;
	supervisorConfig: ResolvedEscalationConfig;
	originatorConfig: ResolvedEscalationConfig;
	supervisorLabel?: string;
}): EscalationChainParticipant[] {
	return [
		{
			id: buildSupervisorEscalationHolderId(args.lineagePath),
			kind: "supervisor",
			lineagePath: args.lineagePath,
			label: args.supervisorLabel ?? "fork supervisor",
			authority: args.supervisorConfig.authority,
			intermediate: args.supervisorConfig.intermediate,
		},
		{
			id: buildRootEscalationHolderId(args.rootRunId),
			kind: "root",
			runId: args.rootRunId,
			label: "originator",
			authority: args.originatorConfig.authority,
			intermediate: args.originatorConfig.intermediate,
		},
	];
}

/** Build the direct-mode root candidate; user is appended by the chain core. */
export function buildDirectEscalationParticipants(args: {
	rootRunId: string;
	originatorConfig: ResolvedEscalationConfig;
}): EscalationChainParticipant[] {
	return [{
		id: buildRootEscalationHolderId(args.rootRunId),
		kind: "root",
		runId: args.rootRunId,
		label: "originator",
		authority: args.originatorConfig.authority,
		intermediate: args.originatorConfig.intermediate,
	}];
}

export interface EscalationRaiseToolDeps {
	agentDir: string;
	rootRunId: string;
	runId: string;
	lineagePath: string | (() => string);
	raiserLabel?: string;
	participants: EscalationChainParticipant[] | (() => EscalationChainParticipant[]);
	config: ResolvedEscalationConfig;
	credential: EscalationCredential | (() => EscalationCredential);
	ownerSessionId: string;
	sessionFile?: () => string | undefined;
	sessionId?: () => string | undefined;
	/**
	 * Provenance stamped on every request these verbs raise. Set by the worker
	 * `ask` adapter so a translated question is distinguishable from a native
	 * raise on the durable record, not only in the raiser's tool result.
	 */
	origin?: EscalationOrigin;
	workerChannel?: Pick<WorkerChannel, "enterAwaitingEscalation" | "resolveAwaitingEscalation">;
	pollMs?: number;
	now?: () => Date;
	raiseAndAwait?: typeof raiseAndAwaitEscalation;
}

const OptionSchema = Type.Union([
	Type.String({ minLength: 1 }),
	Type.Object({ label: Type.String({ minLength: 1, description: "Option label shown to the resolver." }) }),
]);

/** Build the three §2.3 per-kind raise verbs with fully injectable runtime IO. */
export function makeEscalationRaiseTools(
	deps: EscalationRaiseToolDeps,
): [EscalationTool, EscalationTool, EscalationTool] {
	const decision: EscalationTool = {
		name: ESCALATE_DECISION_TOOL,
		label: "Escalate decision",
		description: ESCALATE_DECISION_DESCRIPTION,
		parameters: Type.Object({
			header: Type.String({ minLength: 1, description: "Short bounded decision prompt." }),
			category: Type.Union([
				Type.Literal("implementation"),
				Type.Literal("scope-product"),
				Type.Literal("security-permission"),
			], {
				description: "Required classification: implementation for reversible local choices; scope-product for material scope, product, or UX changes; security-permission for security or permission questions.",
			}),
			body: Type.Optional(Type.String({ description: "Additional decision context." })),
			options: Type.Array(OptionSchema, { minItems: 2, maxItems: 5 }),
			recommended: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based recommended option index." })),
			multi: Type.Optional(Type.Boolean({ description: "Allow selecting more than one option." })),
		}),
		execute: async (toolCallId, params, signal) => {
			const decision = normalizeDecisionPayload(params);
			return executeRaise(deps, toolCallId, "decision", decision.payload, signal, decision.category);
		},
	};
	const blocker: EscalationTool = {
		name: ESCALATE_BLOCKER_TOOL,
		label: "Escalate blocker",
		description: ESCALATE_BLOCKER_DESCRIPTION,
		parameters: Type.Object({
			cause: Type.String({
				minLength: 1,
				description: "Blocking cause. Well-known: env-missing, input-missing, external-failure, upstream-pending, decision-needed; precise free-form causes are accepted.",
			}),
			description: Type.String({ minLength: 1, description: "Precise description of why work cannot proceed." }),
			unblock: Type.Optional(Type.String({ description: "What would unblock progress." })),
			options: Type.Optional(Type.Array(OptionSchema, { minItems: 1, maxItems: 5 })),
		}),
		execute: async (toolCallId, params, signal) => {
			const payload = normalizeBlockerPayload(params);
			return executeRaise(deps, toolCallId, "blocker", payload, signal);
		},
	};
	const amendment: EscalationTool = {
		name: ESCALATE_AMENDMENT_TOOL,
		label: "Escalate amendment",
		description: ESCALATE_AMENDMENT_DESCRIPTION,
		parameters: Type.Object({
			target: Type.String({ minLength: 1, description: "Opaque ref for the task, plan, spec, or model to change." }),
			change: Type.String({ minLength: 1, description: "Exact proposed change." }),
			rationale: Type.String({ minLength: 1, description: "Why the amendment is necessary." }),
		}),
		execute: async (toolCallId, params, signal) => {
			const payload = normalizeAmendmentPayload(params);
			return executeRaise(deps, toolCallId, "amendment", payload, signal);
		},
	};
	return [decision, blocker, amendment];
}

async function executeRaise<K extends EscalationKind>(
	deps: EscalationRaiseToolDeps,
	toolCallId: string,
	kind: K,
	payload: EscalationPayloadByKind[K],
	signal: AbortSignal | undefined,
	category?: K extends "decision" ? EscalationCategory : never,
): Promise<EscalationToolResult> {
	const lineagePath = resolveValue(deps.lineagePath);
	if (lineagePath.trim() === "") throw new Error(`${kind} escalation requires a lineagePath`);
	const credential = resolveValue(deps.credential);
	const sessionFile = deps.sessionFile?.();
	const raisedAt = (deps.now ?? (() => new Date()))();
	if (!Number.isFinite(raisedAt.getTime())) throw new Error("escalation clock returned an invalid date");
	const requestId = buildEscalationRequestId({
		rootRunId: deps.rootRunId,
		runId: deps.runId,
		lineagePath,
		kind,
		contentHash: escalationPayloadContentHash(kind, payload, category),
		raisedAt: raisedAt.toISOString(),
	});
	if (!isSafeRunId(requestId)) throw new Error("generated escalation requestId is not filesystem-safe");
	const replyEndpoint = {
		kind: "local-result" as const,
		rootRunId: deps.rootRunId,
		requestId,
		runId: deps.runId,
		lineagePath,
		credential,
	};
	const outcome = await (deps.raiseAndAwait ?? raiseAndAwaitEscalation)({
		agentDir: deps.agentDir,
		requestId,
		rootRunId: deps.rootRunId,
		kind,
		payload,
		...(category !== undefined ? { category } : {}),
		...(deps.origin !== undefined ? { origin: deps.origin } : {}),
		raiser: {
			runId: deps.runId,
			lineagePath,
			...(deps.raiserLabel !== undefined ? { label: deps.raiserLabel } : {}),
		},
		participants: resolveValue(deps.participants),
		config: deps.config,
		replyEndpoint,
		ownerSessionId: deps.ownerSessionId,
		...(sessionFile ? { consumer: { sessionFile, sessionId: deps.sessionId?.(), toolCallId } } : {}),
		now: raisedAt,
		...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}),
		...(signal !== undefined ? { signal } : {}),
		...(deps.workerChannel !== undefined ? { workerChannel: deps.workerChannel } : {}),
	});
	return renderRaiseOutcome(requestId, kind, payload, outcome);
}

export function buildEscalationRequestId(args: {
	rootRunId: string;
	runId: string;
	lineagePath: string;
	kind: EscalationKind;
	contentHash: string;
	raisedAt: string;
}): string {
	const digest = sha256(JSON.stringify({
		rootRunId: args.rootRunId,
		runId: args.runId,
		lineagePath: args.lineagePath,
		kind: args.kind,
		contentHash: args.contentHash,
		raisedAt: args.raisedAt,
	}));
	return `escalation-${digest.slice(0, 32)}`;
}

export function escalationPayloadContentHash<K extends EscalationKind>(
	kind: K,
	payload: EscalationPayloadByKind[K],
	category?: K extends "decision" ? EscalationCategory : never,
): string {
	// Category changes both route eligibility and the authority needed to
	// resolve a decision, so it is part of the request's dedupe identity. The
	// conditional spread preserves the historical hash for unclassified
	// lower-level callers while keeping differently classified decisions apart.
	return sha256(JSON.stringify({
		kind,
		payload,
		...(category !== undefined ? { category } : {}),
	}));
}

export function renderRaiseOutcome<K extends EscalationKind>(
	requestId: string,
	kind: K,
	payload: EscalationPayloadByKind[K],
	outcome: EscalationOutcome,
): EscalationToolResult {
	const options = resolutionOptionsFor(kind, payload);
	const selected = outcome.selected ? [...outcome.selected] : [];
	const selectedLabels = selected.map((index) => options[index]?.label ?? String(index));
	let text: string;
	if (outcome.status === "resolved") {
		text = outcome.customInstruction
			? `Custom instruction: ${outcome.customInstruction}`
			: selectedLabels.length > 0 ? selectedLabels.join(", ") : "(no selection)";
	} else if (outcome.status === "timeout") {
		text = selectedLabels.length > 0
			? `Escalation ${requestId} timed out. Worker resumes with the configured default: ${selectedLabels.join(", ")}.`
			: `Escalation ${requestId} timed out. No selection was produced and no default was applied.`;
	} else {
		text = selectedLabels.length > 0
			? `Escalation ${requestId} was cancelled. Worker resumes with the configured default: ${selectedLabels.join(", ")}.`
			: `Escalation ${requestId} was cancelled. No selection was produced and no default was applied.`;
	}
	if (outcome.note) text += ` Note: ${outcome.note}`;
	return {
		content: [{ type: "text", text }],
		details: {
			requestId,
			selected,
			selectedLabels,
			customInstruction: outcome.customInstruction,
			resolvedBy: outcome.resolvedBy,
			status: outcome.status,
			note: outcome.note,
		},
	};
}

export interface SupervisorEscalationToolDeps {
	agentDir: string;
	rootRunId: string;
	holderId: string;
	holderAuthority: EscalationAuthority;
	config: ResolvedEscalationConfig;
	credential: EscalationCredential;
	listMailbox?: typeof listMailbox;
	readRequest?: typeof readEscalationRequest;
	readOutcome?: typeof readOutcome;
	resolveEscalation?: typeof resolveEscalation;
	passEscalation?: typeof passEscalation;
	now?: () => Date;
}

/** Build the §2.3 resolve/pass pair for any supervisor/agent/root holder. */
export function makeSupervisorEscalationTools(
	deps: SupervisorEscalationToolDeps,
): [EscalationTool, EscalationTool] {
	const resolveTool: EscalationTool = {
		name: RESOLVE_ESCALATION_TOOL,
		label: "Resolve escalation",
		description: RESOLVE_ESCALATION_DESCRIPTION,
		parameters: Type.Object({
			requestId: Type.Optional(Type.String({ minLength: 1, description: "Pending request id; omit only when exactly one request is pending." })),
			selected: Type.Union([
				Type.Integer({ minimum: 0, description: "Zero-based option index." }),
				Type.Array(Type.Integer({ minimum: 0 }), { minItems: 1 }),
			]),
			customInstruction: Type.Optional(Type.String({ description: "Free-text instruction; valid only with the custom instruction option selected exclusively." })),
			note: Type.Optional(Type.String({ description: "Optional audit note." })),
		}),
		execute: async (_toolCallId, params) => executeSupervisorResolve(deps, params),
	};
	const escalateTool: EscalationTool = {
		name: ESCALATE_TOOL,
		label: "Escalate",
		description: ESCALATE_HOP_DESCRIPTION,
		parameters: Type.Object({
			requestIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
			context: Type.Optional(Type.String({ description: "Context to append to each forwarded trace." })),
			recommendation: Type.Optional(Type.String({ description: "Recommendation to append when you have one." })),
		}),
		execute: async (_toolCallId, params) => executeSupervisorPass(deps, params),
	};
	return [resolveTool, escalateTool];
}

async function executeSupervisorResolve(
	deps: SupervisorEscalationToolDeps,
	params: Record<string, unknown>,
): Promise<EscalationToolResult> {
	const mailbox = (deps.listMailbox ?? listMailbox)({
		agentDir: deps.agentDir,
		rootRunId: deps.rootRunId,
		holderId: deps.holderId,
	});
	const pendingIds = mailbox.map((entry) => entry.requestId);
	const requested = optionalTrimmedString(params.requestId, "requestId");
	let requestId = requested;
	if (requestId === undefined && pendingIds.length === 1) requestId = pendingIds[0];
	if (requestId === undefined) {
		return errorResult(
			pendingIds.length === 0
				? "No escalation is pending in this holder's mailbox."
				: `requestId is ambiguous; pending requests: ${pendingIds.join(", ")}.`,
			{ reason: "ambiguous-requestId", pendingRequestIds: pendingIds },
		);
	}
	const request = (deps.readRequest ?? readEscalationRequest)({
		agentDir: deps.agentDir,
		rootRunId: deps.rootRunId,
		requestId,
		credential: deps.credential,
	});
	if (!pendingIds.includes(requestId)) {
		const terminal = (deps.readOutcome ?? readOutcome)({
			agentDir: deps.agentDir,
			rootRunId: deps.rootRunId,
			requestId,
			credential: deps.credential,
		});
		if (terminal) return terminalResult("resolve", requestId, terminal);
		return errorResult(`Escalation ${requestId} is not pending for this holder.`, {
			reason: "not-pending",
			requestId,
			pendingRequestIds: pendingIds,
		});
	}
	if (!request) {
		return errorResult(`Escalation ${requestId} could not be read or authenticated.`, {
			reason: "not-readable",
			requestId,
		});
	}
	if (request.chain[request.holderIndex]?.id !== deps.holderId) {
		return errorResult(`Escalation ${requestId} has already moved beyond this holder. Use the current holder's mailbox.`, {
			reason: "stale-mailbox",
			requestId,
		});
	}
	if (!authorityDecides(deps.holderAuthority, request.kind, request.category)) {
		return errorResult(
			`This holder lacks declared authority to resolve ${request.kind} escalation ${requestId}. Use \`escalate\` to pass it upward.`,
			{ reason: "authority-refused", requestId, kind: request.kind, category: request.category },
		);
	}
	let selected: number[];
	const customInstruction = optionalTrimmedString(params.customInstruction, "customInstruction");
	try {
		selected = normalizeEscalationSelection(params.selected, request, customInstruction);
	} catch (error) {
		return errorResult(errorMessage(error), { reason: "invalid-selection", requestId });
	}
	const note = optionalTrimmedString(params.note, "note");
	try {
		const wrote = (deps.resolveEscalation ?? resolveEscalation)({
			agentDir: deps.agentDir,
			rootRunId: deps.rootRunId,
			requestId,
			credential: deps.credential,
			resolution: {
				selected,
				...(customInstruction !== undefined ? { customInstruction } : {}),
				resolvedBy: deps.holderId,
				...(note !== undefined ? { note } : {}),
			},
			...(deps.now !== undefined ? { at: deps.now() } : {}),
		});
		const labels = selected.map((index) => request.resolutionOptions[index]?.label ?? String(index));
		return {
			content: [{
				type: "text",
				text: wrote.duplicate
					? `Escalation ${requestId} was already terminal: ${wrote.outcome.status}.`
					: `Resolved escalation ${requestId}: ${labels.join(", ")}.`,
			}],
			details: {
				resolved: !wrote.duplicate,
				duplicate: wrote.duplicate,
				requestId,
				selected,
				selectedLabels: labels,
				outcome: wrote.outcome,
			},
		};
	} catch (error) {
		const terminal = (deps.readOutcome ?? readOutcome)({
			agentDir: deps.agentDir,
			rootRunId: deps.rootRunId,
			requestId,
			credential: deps.credential,
		});
		if (terminal) return terminalResult("resolve", requestId, terminal);
		return errorResult(`Could not resolve escalation ${requestId}: ${errorMessage(error)}`, {
			reason: "resolve-failed",
			requestId,
		});
	}
}

async function executeSupervisorPass(
	deps: SupervisorEscalationToolDeps,
	params: Record<string, unknown>,
): Promise<EscalationToolResult> {
	const mailbox = (deps.listMailbox ?? listMailbox)({
		agentDir: deps.agentDir,
		rootRunId: deps.rootRunId,
		holderId: deps.holderId,
	});
	const pendingIds = mailbox.map((entry) => entry.requestId);
	const explicit = optionalStringArray(params.requestIds, "requestIds");
	const requestIds = explicit ?? pendingIds;
	if (requestIds.length === 0) {
		return errorResult("No escalation is pending in this holder's mailbox.", {
			reason: "no-pending-escalations",
			pendingRequestIds: pendingIds,
		});
	}
	const context = optionalTrimmedString(params.context, "context");
	const recommendation = optionalTrimmedString(params.recommendation, "recommendation");
	const forwarded: Array<{ requestId: string; holderId: string; holderLabel?: string; holderKind: string }> = [];
	const terminal: Array<{ requestId: string; status: string }> = [];
	const errors: Array<{ requestId: string; error: string }> = [];
	for (const requestId of requestIds) {
		if (!pendingIds.includes(requestId)) {
			const outcome = (deps.readOutcome ?? readOutcome)({
				agentDir: deps.agentDir,
				rootRunId: deps.rootRunId,
				requestId,
				credential: deps.credential,
			});
			if (outcome) terminal.push({ requestId, status: outcome.status });
			else errors.push({ requestId, error: "not pending for this holder" });
			continue;
		}
		const request = (deps.readRequest ?? readEscalationRequest)({
			agentDir: deps.agentDir,
			rootRunId: deps.rootRunId,
			requestId,
			credential: deps.credential,
		});
		if (!request || request.chain[request.holderIndex]?.id !== deps.holderId) {
			errors.push({ requestId, error: "stale mailbox entry; request already moved" });
			continue;
		}
		try {
			const moved = (deps.passEscalation ?? passEscalation)({
				agentDir: deps.agentDir,
				rootRunId: deps.rootRunId,
				requestId,
				config: deps.config,
				credential: deps.credential,
				...(context !== undefined ? { context } : {}),
				...(recommendation !== undefined ? { recommendation } : {}),
				...(deps.now !== undefined ? { now: deps.now() } : {}),
			});
			const holder = moved.chain[moved.holderIndex];
			forwarded.push({
				requestId,
				holderId: holder.id,
				...(holder.label !== undefined ? { holderLabel: holder.label } : {}),
				holderKind: holder.kind,
			});
		} catch (error) {
			const outcome = (deps.readOutcome ?? readOutcome)({
				agentDir: deps.agentDir,
				rootRunId: deps.rootRunId,
				requestId,
				credential: deps.credential,
			});
			if (outcome) terminal.push({ requestId, status: outcome.status });
			else errors.push({ requestId, error: errorMessage(error) });
		}
	}
	const narration = [
		...forwarded.map((item) =>
			`Escalated ${item.requestId} to ${item.holderLabel ?? item.holderId} (${item.holderKind}).`,
		),
		...terminal.map((item) => `Escalation ${item.requestId} is already terminal (${item.status}); no action taken.`),
		...errors.map((item) => `Could not escalate ${item.requestId}: ${item.error}.`),
	];
	return {
		content: [{ type: "text", text: narration.join("\n") }],
		details: { forwarded, terminal, errors },
		...(forwarded.length === 0 && errors.length > 0 ? { isError: true } : {}),
	};
}

function normalizeDecisionPayload(params: Record<string, unknown>): {
	payload: EscalationPayloadByKind["decision"];
	category: EscalationCategory;
} {
	const header = requiredTrimmedString(params.header, "header");
	const options = normalizeOptions(params.options, "options", 2, 5);
	const body = optionalString(params.body, "body");
	const multi = optionalBoolean(params.multi, "multi");
	const recommended = params.recommended;
	if (recommended !== undefined && (!Number.isInteger(recommended) || (recommended as number) < 0 || (recommended as number) >= options.length)) {
		throw new Error("recommended must be a zero-based index into options");
	}
	return {
		payload: {
			header,
			...(body !== undefined ? { body } : {}),
			options,
			...(recommended !== undefined ? { recommended: recommended as number } : {}),
			...(multi !== undefined ? { multi } : {}),
		},
		// Category is deliberately a sibling of the payload: it controls
		// routing/authority and is not part of the worker's decision body.
		category: normalizeDecisionCategory(params.category),
	};
}

function normalizeDecisionCategory(value: unknown): EscalationCategory {
	if (value === "implementation" || value === "scope-product" || value === "security-permission") {
		return value;
	}
	throw new Error("category must be implementation, scope-product, or security-permission");
}

function normalizeBlockerPayload(params: Record<string, unknown>): EscalationPayloadByKind["blocker"] {
	const options = params.options === undefined ? undefined : normalizeOptions(params.options, "options", 1, 5);
	const unblock = optionalString(params.unblock, "unblock");
	return {
		cause: requiredTrimmedString(params.cause, "cause"),
		description: requiredTrimmedString(params.description, "description"),
		...(unblock !== undefined ? { unblock } : {}),
		...(options !== undefined ? { options } : {}),
	};
}

function normalizeAmendmentPayload(params: Record<string, unknown>): EscalationPayloadByKind["amendment"] {
	return {
		target: requiredTrimmedString(params.target, "target"),
		change: requiredTrimmedString(params.change, "change"),
		rationale: requiredTrimmedString(params.rationale, "rationale"),
	};
}

function normalizeOptions(value: unknown, field: string, min: number, max: number) {
	if (!Array.isArray(value) || value.length < min || value.length > max) {
		throw new Error(`${field} must contain ${min}–${max} options`);
	}
	return value.map((option, index) => {
		const label = typeof option === "string"
			? option.trim()
			: isRecord(option) && typeof option.label === "string"
				? option.label.trim()
				: "";
		if (label === "") throw new Error(`${field}[${index}] must be a non-empty string or {label}`);
		return { label };
	});
}

/** Shared selection validation for supervisor and originator §2.3 adapters. */
export function normalizeEscalationSelection(
	value: unknown,
	request: EscalationRequest,
	customInstruction?: string,
): number[] {
	const raw = Array.isArray(value) ? value : [value];
	if (raw.length === 0) throw new Error("selected must contain at least one option index");
	const selected: number[] = [];
	for (const candidate of raw) {
		if (!Number.isInteger(candidate) || (candidate as number) < 0 || (candidate as number) >= request.resolutionOptions.length) {
			throw new Error(`selected contains an out-of-range option index for ${request.requestId}`);
		}
		if (selected.includes(candidate as number)) throw new Error("selected contains duplicate option indices");
		selected.push(candidate as number);
	}
	const multi = request.kind === "decision" && "multi" in request.payload && request.payload.multi === true;
	if (!multi && selected.length !== 1) throw new Error(`${request.kind} escalation requires exactly one selected option`);
	const customIndex = request.resolutionOptions.findIndex(isCustomInstructionOption);
	const hasCustom = customIndex >= 0 && selected.includes(customIndex);
	if (hasCustom && selected.length !== 1) throw new Error("custom instruction option must be selected exclusively");
	if (hasCustom && customInstruction === undefined) throw new Error("customInstruction must be non-empty when selecting the custom instruction option");
	if (!hasCustom && customInstruction !== undefined) {
		if (customIndex < 0) {
			throw new Error("customInstruction is unsupported for legacy escalation requests without a custom option marker; upgrade pi-delegate or re-raise the request");
		}
		throw new Error("customInstruction requires selecting the custom instruction option");
	}
	return selected;
}

function terminalResult(action: string, requestId: string, outcome: EscalationOutcome): EscalationToolResult {
	return {
		content: [{ type: "text", text: `Escalation ${requestId} is already terminal (${outcome.status}); ${action} was not repeated.` }],
		details: { requestId, terminal: true, outcome },
	};
}

function errorResult(text: string, details: Record<string, unknown>): EscalationToolResult {
	return { content: [{ type: "text", text }], details, isError: true };
}

function requiredTrimmedString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
	return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`${field} must be a string`);
	return value;
}

function optionalTrimmedString(value: unknown, field: string): string | undefined {
	const string = optionalString(value, field);
	if (string === undefined) return undefined;
	const trimmed = string.trim();
	return trimmed === "" ? undefined : trimmed;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new Error(`${field} must be boolean`);
	return value;
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length === 0) throw new Error(`${field} must be a non-empty array of request ids`);
	const result: string[] = [];
	for (const candidate of value) {
		if (typeof candidate !== "string" || candidate.trim() === "") throw new Error(`${field} entries must be non-empty strings`);
		const id = candidate.trim();
		if (!result.includes(id)) result.push(id);
	}
	return result;
}

function resolveValue<T>(value: T | (() => T)): T {
	return typeof value === "function" ? (value as () => T)() : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
	return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
