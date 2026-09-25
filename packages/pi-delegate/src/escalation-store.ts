/**
 * Durable escalation records and mailbox arbitration for the escalation rebuild.
 *
 * The request is canonical and is persisted before its initial mailbox index
 * (invariant 1). Outcomes use exclusive creation (invariant 2), mailbox claims
 * are leased (invariant 4), and forwarding never rewrites the reply endpoint
 * (invariant 7). The chain is supplied by the routing layer and frozen here;
 * this module deliberately performs no wake delivery or chain walking.
 *
 * Lean trace: the frozen chain is the store substrate for DE-4a (filtered-chain
 * liveness); `holdStrategy` records DE-7's pending ⇒ only raiser held seam; the
 * timeout record carries the per-kind policy data required by DE-8.
 *
 * [spec §2.1, §2.4, §3 invariants 1/2/4/7, §4]
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { readRouteRecord } from "./control-route.js";
import { currentLineageFrame } from "./depth-guard.js";
import type { DepthFrame } from "./depth-guard.js";
import { resolveEventSinkDir } from "./event-bus.js";
import { deserializeLineage, lineagePath, verifyCapToken } from "./lineage.js";
import {
	preserveCorruptFile,
	readJsonFile,
	replaceJsonFile,
	replaceTextFile,
	withStateFileLock,
} from "./state-io.js";

export type EscalationKind = "decision" | "blocker" | "amendment";

export interface EscalationOption {
	label: string;
	/** Structural discriminator for the synthesized custom-instruction option. */
	custom?: true;
}

export interface DecisionEscalationPayload {
	header: string;
	body?: string;
	options: EscalationOption[];
	recommended?: number;
	multi?: boolean;
}

export type WellKnownBlockerCause =
	| "env-missing"
	| "input-missing"
	| "external-failure"
	| "upstream-pending"
	| "decision-needed";

export interface BlockerEscalationPayload {
	cause: WellKnownBlockerCause | (string & {});
	description: string;
	unblock?: string;
	options?: EscalationOption[];
}

export interface AmendmentEscalationPayload {
	target: string;
	change: string;
	rationale: string;
}

/** Canonical prefix-form aliases for downstream escalation modules. */
export type EscalationDecisionPayload = DecisionEscalationPayload;
export type EscalationBlockerPayload = BlockerEscalationPayload;
export type EscalationAmendmentPayload = AmendmentEscalationPayload;

export type EscalationPayload =
	| DecisionEscalationPayload
	| BlockerEscalationPayload
	| AmendmentEscalationPayload;

export interface EscalationPayloadByKind {
	decision: DecisionEscalationPayload;
	blocker: BlockerEscalationPayload;
	amendment: AmendmentEscalationPayload;
}

export interface EscalationResolution {
	selected: number[];
	/** Free-text instruction selected through the synthetic custom option. */
	customInstruction?: string;
	note?: string;
}

export type EscalationRouteNodeKind = "raiser" | "supervisor" | "agent" | "root" | "user";

export interface EscalationAuthority {
	decision?: "none" | "implementation" | "all";
	blocker?: "none" | "all";
	amendment?: "none" | "all";
	/** Reserved schema data. v1 routing must not match on these tags. */
	tags?: string[];
}

export type EscalationCategory = "implementation" | "scope-product" | "security-permission";

export interface EscalationRouteNode {
	id: string;
	kind: EscalationRouteNodeKind;
	runId?: string;
	lineagePath?: string;
	label?: string;
	authority?: EscalationAuthority;
	intermediate?: boolean;
}

export interface EscalationTimeoutSpec {
	behavior: "useDefault" | "noDefaultError" | "cancel";
	deadlineAt?: string;
	defaultSelection?: number[];
}

export type EscalationHoldStrategy = "hold-open" | "park";
export type EscalationCredential = { capToken: string } | { controlSecret: string };

/** Stable continuation address. Forwarding must preserve this object verbatim. */
export interface EscalationReplyEndpoint {
	kind: "local-result";
	rootRunId: string;
	requestId: string;
	runId: string;
	lineagePath: string;
	credential: EscalationCredential;
}

export interface EscalationTraceEntry {
	at: string;
	event:
		| "raised"
		| "forwarded"
		| "auto-passed"
		| "claimed"
		| "lease-expired"
		| "resolved"
		| "timeout"
		| "cancelled";
	holderId?: string;
	note?: string;
	recommendation?: string;
}

export interface EscalationRaiser {
	runId: string;
	lineagePath: string;
	label?: string;
}

/**
 * How the request entered the escalation system. Absent means a native raise
 * verb. Recorded on the durable request so an operator surface or audit trail
 * can tell a translated `ask` from a first-class `escalate_decision`; readers
 * ignore unknown/absent values, so this is safe across a rolling upgrade.
 */
export type EscalationOrigin = "ask";

export interface EscalationRequest<K extends EscalationKind = EscalationKind> {
	requestId: string;
	rootRunId: string;
	ownerSessionId?: string;
	consumer?: { sessionFile: string; sessionId?: string; toolCallId: string };
	kind: K;
	payload: EscalationPayloadByKind[K];
	category?: EscalationCategory;
	/** Provenance of the raise. Omitted for native raise verbs. */
	origin?: EscalationOrigin;
	resolutionOptions: EscalationOption[];
	/** Frozen at raise; forwarding changes only holderIndex. [DE-4a] */
	chain: EscalationRouteNode[];
	holderIndex: number;
	timeout: EscalationTimeoutSpec;
	hopDeadlineAt?: string;
	/** `park` is schema-reserved; raise accepts only `hold-open`. [DE-7] */
	holdStrategy: EscalationHoldStrategy;
	replyEndpoint: EscalationReplyEndpoint;
	trace: EscalationTraceEntry[];
	raisedAt: string;
	raiser: EscalationRaiser;
}

export interface EscalationOutcome {
	requestId: string;
	/** Persisted outcome shape understood by this reader; absent means legacy. */
	outcomeVersion?: 1;
	status: "resolved" | "timeout" | "cancelled";
	selected?: number[];
	/** Distinct from `note`: the authority's selected custom instruction. */
	customInstruction?: string;
	note?: string;
	/** Holder id that supplied the terminal outcome. */
	resolvedBy?: string;
	at: string;
}

/** Version of the durable outcome shape emitted by this implementation. */
export const ESCALATION_OUTCOME_VERSION = 1 as const;

export class UnsupportedEscalationOutcomeVersionError extends Error {
	constructor(version: unknown) {
		super(`unsupported escalation outcome version ${String(version)}; upgrade pi-delegate before reading this outcome`);
		this.name = "UnsupportedEscalationOutcomeVersionError";
	}
}

/** Raised when an idempotent raise reuses an id for different immutable data. */
export class EscalationRequestCollisionError extends Error {
	constructor(requestId: string) {
		super(`escalation request id collision: ${requestId} already contains different immutable content`);
		this.name = "EscalationRequestCollisionError";
	}
}

/** Signals that the canonical request exists but its mailbox publication failed. */
export class EscalationMailboxPublicationError extends Error {
	readonly requestId: string;

	constructor(requestId: string, cause: unknown) {
		super(`escalation mailbox publication failed for ${requestId}: ${cause instanceof Error ? cause.message : String(cause)}`);
		this.name = "EscalationMailboxPublicationError";
		this.requestId = requestId;
	}
}

/** Signals that a terminal writer no longer owns the live mailbox lease. */
export class EscalationLeaseLostError extends Error {
	constructor(requestId: string) {
		super(`escalation lease was lost before terminal publication: ${requestId}`);
		this.name = "EscalationLeaseLostError";
	}
}

export interface EscalationMailboxEntry {
	requestId: string;
	rootRunId: string;
	holderId: string;
	createdAt: string;
	updatedAt: string;
	claimedBy?: string;
	leaseExpiresAt?: string;
}

export interface RaiseEscalationArgs<K extends EscalationKind = EscalationKind> {
	agentDir: string;
	requestId: string;
	rootRunId: string;
	ownerSessionId?: string;
	consumer?: EscalationRequest["consumer"];
	kind: K;
	payload: EscalationPayloadByKind[K];
	category?: EscalationCategory;
	origin?: EscalationOrigin;
	chain: EscalationRouteNode[];
	holderIndex: number;
	timeout: EscalationTimeoutSpec;
	hopDeadlineAt?: string;
	holdStrategy: EscalationHoldStrategy;
	replyEndpoint: EscalationReplyEndpoint;
	raiser: EscalationRaiser;
	raisedAt?: Date | number | string;
}

export interface ReadEscalationArgs {
	agentDir: string;
	rootRunId: string;
	requestId: string;
	/** Optional caller credential; the stored credential is always verified too. */
	credential?: EscalationCredential;
}

export interface ListEscalationArgs {
	agentDir: string;
	rootRunId: string;
}

export interface ListMailboxArgs extends ListEscalationArgs {
	holderId: string;
}

export interface ClaimEscalationArgs extends ReadEscalationArgs {
	holderId: string;
	claimedBy: string;
	leaseMs: number;
	now?: Date | number | string;
}

export interface ClaimEscalationResult {
	claimed: boolean;
	entry?: EscalationMailboxEntry;
}

export interface ReleaseClaimArgs extends ReadEscalationArgs {
	holderId: string;
	claimedBy: string;
}

export interface ResolveEscalationArgs extends ReadEscalationArgs {
	resolution: EscalationResolution & { resolvedBy?: string };
	credential: EscalationCredential;
	at?: Date | number | string;
}

export interface ResolveClaimedEscalationArgs extends ResolveEscalationArgs {
	holderId: string;
	claimedBy: string;
	now?: Date | number | string;
}

export interface TerminalOutcomeArgs extends ReadEscalationArgs {
	status: "timeout" | "cancelled";
	selected?: number[];
	note?: string;
	resolvedBy?: string;
	credential: EscalationCredential;
	at?: Date | number | string;
}

export interface WriteOutcomeResult {
	outcome: EscalationOutcome;
	duplicate: boolean;
}

export interface ForwardEscalationArgs extends ReadEscalationArgs {
	toIndex: number;
	context?: string;
	recommendation?: string;
	auto?: boolean;
	/** Fresh auto-pass deadline for the destination hop (Q2). */
	hopDeadlineAt?: string;
	at?: Date | number | string;
}

/** Rebuild only the current-holder mailbox for a durable pending request. */
export function repairEscalationPublication(args: ReadEscalationArgs): EscalationRequest | null {
	const requestFile = requestFileFor(args.agentDir, args.rootRunId, args.requestId);
	return withStateFileLock(requestFile, () => {
		const request = readRequestFile(requestFile);
		if (!request || readOutcomeUnchecked(args.agentDir, args.rootRunId, args.requestId) !== null) return null;
		const holder = request.chain[request.holderIndex];
		const mailboxDir = resolveEscalationMailboxDir(args.agentDir, args.rootRunId, holder.id);
		ensureOwnerOnlyDir(mailboxDir);
		const mailboxFile = path.join(mailboxDir, `${args.requestId}.json`);
		withStateFileLock(mailboxFile, () => writeMailboxEntryLocked(
			mailboxFile,
			request,
			holder.id,
			request.raisedAt,
		));
		return freezeRequestChain(request);
	});
}

export interface AwaitOutcomeArgs extends ReadEscalationArgs {
	pollMs?: number;
	signal?: AbortSignal;
}

const MAX_ARTIFACT_BYTES = 1024 * 1024;
const verifiedCapCredentials = new Set<string>();

/** Internal failure/race injection seam; production callers must not set it. */
export const __testHooks: {
	beforeExclusiveOutcomeWrite?: () => void;
} = {};

const BLOCKER_DEFAULT_OPTIONS: readonly EscalationOption[] = [
	{ label: "Fixed — retry" },
	{ label: "Skip this part" },
	{ label: "Abort task" },
];
const AMENDMENT_DEFAULT_OPTIONS: readonly EscalationOption[] = [
	{ label: "Approve" },
	{ label: "Approve with modifications (see note)" },
	{ label: "Reject" },
];
export const CUSTOM_INSTRUCTION_OPTION_LABEL = "Other — custom instruction";

export function isCustomInstructionOption(option: EscalationOption | undefined): boolean {
	return option?.custom === true;
}

/** Return fresh synthesized options so callers cannot mutate shared defaults. */
export function resolutionOptionsFor<K extends EscalationKind>(
	kind: K,
	payload: EscalationPayloadByKind[K],
): EscalationOption[] {
	let options: EscalationOption[];
	if (kind === "decision") options = cloneOptions((payload as DecisionEscalationPayload).options);
	else if (kind === "blocker") {
		const blocker = payload as BlockerEscalationPayload;
		options = cloneOptions(blocker.options ?? BLOCKER_DEFAULT_OPTIONS);
	} else if (kind === "amendment") options = cloneOptions(AMENDMENT_DEFAULT_OPTIONS);
	else throw new Error(`unsupported escalation kind: ${String(kind)}`);
	options.push({ label: CUSTOM_INSTRUCTION_OPTION_LABEL, custom: true });
	return options;
}

export function resolveEscalationsDir(agentDir: string, rootRunId: string): string {
	assertSafeStem(rootRunId, "rootRunId");
	return path.join(resolveEventSinkDir(agentDir, rootRunId), "escalations");
}

export function resolveEscalationRequestsDir(agentDir: string, rootRunId: string): string {
	return path.join(resolveEscalationsDir(agentDir, rootRunId), "requests");
}

export function resolveEscalationResultsDir(agentDir: string, rootRunId: string): string {
	return path.join(resolveEscalationsDir(agentDir, rootRunId), "results");
}

export function resolveEscalationMailboxesDir(agentDir: string, rootRunId: string): string {
	return path.join(resolveEscalationsDir(agentDir, rootRunId), "mailboxes");
}

export function resolveEscalationMailboxDir(
	agentDir: string,
	rootRunId: string,
	holderId: string,
): string {
	return path.join(
		resolveEscalationMailboxesDir(agentDir, rootRunId),
		safeMailboxSegment(holderId),
	);
}

/**
 * Validate, freeze, and durably persist an escalation before indexing delivery.
 * This module emits no wake: durable state is the source of truth (invariant 1).
 */
export function raiseEscalation<K extends EscalationKind>(
	args: RaiseEscalationArgs<K>,
): EscalationRequest<K> {
	assertStoreAddress(args.agentDir, args.rootRunId, args.requestId);
	validateProvenance(args);
	validatePayload(args.kind, args.payload);
	if (args.category !== undefined && args.kind !== "decision") {
		throw new Error("category is valid only for decision escalations");
	}
	if (args.category !== undefined) validateCategory(args.category);
	if (args.origin !== undefined) validateOrigin(args.origin);
	if (args.holdStrategy !== "hold-open") {
		throw new Error('holdStrategy "park" is reserved; only "hold-open" may be raised');
	}
	validateChain(args.chain, args.holderIndex);
	validateTimeout(args.timeout);
	validateReplyEndpoint(args.replyEndpoint, args.rootRunId, args.requestId, args.raiser);
	if (!verifyEscalationCredential(args.agentDir, args.replyEndpoint, args.replyEndpoint.credential)) {
		throw new Error("invalid escalation credential");
	}
	const raisedAt = toDate(args.raisedAt).toISOString();
	const resolutionOptions = resolutionOptionsFor(args.kind, args.payload);
	validateSelection(
		args.timeout.defaultSelection,
		resolutionOptions.length,
		args.kind === "decision" && (args.payload as DecisionEscalationPayload).multi === true,
		"timeout defaultSelection",
	);
	const chain = freezeChain(args.chain);
	const holder = chain[args.holderIndex];
	const request: EscalationRequest<K> = {
		requestId: args.requestId,
		rootRunId: args.rootRunId,
		...(args.ownerSessionId !== undefined ? { ownerSessionId: args.ownerSessionId } : {}),
		...(args.consumer !== undefined ? { consumer: { ...args.consumer } } : {}),
		kind: args.kind,
		payload: clonePayload(args.kind, args.payload),
		// Preserve an omitted category as unclassified. Do not synthesize the
		// permissive implementation tier for legacy/lower-level callers.
		...(args.kind === "decision" && args.category !== undefined ? { category: args.category } : {}),
		// Provenance is metadata, not part of the decision body, and deliberately
		// outside `escalationPayloadContentHash` so the same question dedupes
		// identically whether it arrived through `ask` or a native raise verb.
		...(args.origin !== undefined ? { origin: args.origin } : {}),
		resolutionOptions,
		chain,
		holderIndex: args.holderIndex,
		timeout: cloneTimeout(args.timeout),
		...(args.hopDeadlineAt !== undefined ? { hopDeadlineAt: validDateString(args.hopDeadlineAt, "hopDeadlineAt") } : {}),
		holdStrategy: "hold-open",
		replyEndpoint: cloneReplyEndpoint(args.replyEndpoint),
		trace: [{ at: raisedAt, event: "raised", holderId: holder.id }],
		raisedAt,
		raiser: { ...args.raiser },
	};

	const requestFile = requestFileFor(args.agentDir, args.rootRunId, args.requestId);
	ensureOwnerOnlyDir(path.dirname(requestFile));
	return withStateFileLock(requestFile, () => {
		const persisted = readJsonFile(requestFile);
		if (persisted.kind === "absent") {
			// Invariant 1 ordering: canonical request first, mailbox delivery second.
			atomicWriteJson(requestFile, request);
			writeMailboxEntry(args.agentDir, request, holder.id, raisedAt);
			return request;
		}
		const existing = readRequestFile(requestFile);
		if (!existing) {
			throw new Error(`escalation request exists but is unreadable: ${args.requestId}`);
		}
		if (!sameRequestIdentity(existing, request)) {
			throw new EscalationRequestCollisionError(args.requestId);
		}
		const existingHolder = existing.chain[existing.holderIndex];
		writeMailboxEntry(args.agentDir, existing, existingHolder.id, existing.raisedAt);
		return freezeRequestChain(existing);
	}) as EscalationRequest<K>;
}

/** Read one authenticated request, or null for absent/malformed/forged state. */
export function readEscalationRequest(args: ReadEscalationArgs): EscalationRequest | null {
	try {
		assertStoreAddress(args.agentDir, args.rootRunId, args.requestId);
		const request = readRequestFile(requestFileFor(args.agentDir, args.rootRunId, args.requestId));
		if (!request || request.rootRunId !== args.rootRunId || request.requestId !== args.requestId) {
			return null;
		}
		if (!credentialAuthorizes(args.agentDir, request, args.credential)) return null;
		return freezeRequestChain(request);
	} catch {
		return null;
	}
}

/** List authenticated requests in stable request-id order. */
export function listEscalationRequests(args: ListEscalationArgs): EscalationRequest[] {
	try {
		const dir = resolveEscalationRequestsDir(args.agentDir, args.rootRunId);
		return listJsonFiles(dir)
			.map((file) => readRequestFile(file))
			.filter((request): request is EscalationRequest =>
				request !== null &&
				request.rootRunId === args.rootRunId &&
				credentialAuthorizes(args.agentDir, request),
			)
			.map(freezeRequestChain)
			.sort((a, b) => a.requestId.localeCompare(b.requestId));
	} catch {
		return [];
	}
}

/** List a holder's durable mailbox entries in stable request-id order. */
export function listMailbox(args: ListMailboxArgs): EscalationMailboxEntry[] {
	try {
		const dir = resolveEscalationMailboxDir(args.agentDir, args.rootRunId, args.holderId);
		return listJsonFiles(dir)
			.map(readMailboxFile)
			.filter((entry): entry is EscalationMailboxEntry =>
				entry !== null && entry.rootRunId === args.rootRunId && entry.holderId === args.holderId,
			)
			.filter((entry) => {
				const request = readEscalationRequest({
					agentDir: args.agentDir,
					rootRunId: args.rootRunId,
					requestId: entry.requestId,
				});
				return request !== null && readOutcomeUnchecked(args.agentDir, args.rootRunId, entry.requestId) === null;
			})
			.sort((a, b) => a.requestId.localeCompare(b.requestId));
	} catch {
		return [];
	}
}

/** Claim a mailbox delivery while no other live lease owns it (invariant 4). */
export function claimEscalation(args: ClaimEscalationArgs): ClaimEscalationResult {
	assertPositiveFinite(args.leaseMs, "leaseMs");
	if (args.claimedBy.trim() === "") throw new Error("claimedBy must not be empty");
	const request = requireRequest(args);
	const holder = request.chain[request.holderIndex];
	if (holder.id !== args.holderId) return { claimed: false };
	const requestFile = requestFileFor(args.agentDir, args.rootRunId, args.requestId);
	const file = mailboxFileFor(args.agentDir, args.rootRunId, args.holderId, args.requestId);
	// Keep lock ordering request → mailbox. Forwarding publishes the destination
	// mailbox after its request transition, so claim cannot deadlock it by taking
	// the mailbox first.
	return withStateFileLock(requestFile, () => withStateFileLock(file, () => {
		const latest = readRequestFile(requestFile);
		if (!latest || latest.chain[latest.holderIndex]?.id !== args.holderId) return { claimed: false };
		const current = readMailboxFile(file);
		if (!current || current.holderId !== args.holderId) return { claimed: false };
		const now = toDate(args.now);
		const expiresAt = Date.parse(current.leaseExpiresAt ?? "");
		const live = current.claimedBy !== undefined && Number.isFinite(expiresAt) && now.getTime() < expiresAt;
		if (live && current.claimedBy !== args.claimedBy) return { claimed: false };
		const renewing = live && current.claimedBy === args.claimedBy;

		const expiredClaimant = current.claimedBy;
		const at = now.toISOString();
		const entry: EscalationMailboxEntry = {
			...current,
			updatedAt: at,
			claimedBy: args.claimedBy,
			leaseExpiresAt: new Date(now.getTime() + Math.max(1, args.leaseMs)).toISOString(),
		};
		replaceJsonFile(file, entry);
		applyRequestMutation(requestFile, latest, (currentRequest) => ({
			...currentRequest,
			...(renewing ? {} : {
				trace: [
					...currentRequest.trace,
					...(expiredClaimant !== undefined && !live
						? [{ at, event: "lease-expired" as const, holderId: args.holderId, note: expiredClaimant }]
						: []),
					{ at, event: "claimed" as const, holderId: args.holderId, note: args.claimedBy },
				],
			}),
		}));
		return { claimed: true, entry };
	}));
}

/** Release a claim only when the named claimant owns it. */
export function releaseClaim(args: ReleaseClaimArgs): boolean {
	if (args.claimedBy.trim() === "") return false;
	const request = requireRequest(args);
	if (request.chain[request.holderIndex].id !== args.holderId) return false;
	const requestFile = requestFileFor(args.agentDir, args.rootRunId, args.requestId);
	const file = mailboxFileFor(args.agentDir, args.rootRunId, args.holderId, args.requestId);
	return withStateFileLock(requestFile, () => withStateFileLock(file, () => {
		const latest = readRequestFile(requestFile);
		if (!latest || latest.chain[latest.holderIndex]?.id !== args.holderId) return false;
		const current = readMailboxFile(file);
		if (!current || current.claimedBy !== args.claimedBy) return false;
		const released: EscalationMailboxEntry = {
			requestId: current.requestId,
			rootRunId: current.rootRunId,
			holderId: current.holderId,
			createdAt: current.createdAt,
			updatedAt: new Date().toISOString(),
		};
		replaceJsonFile(file, released);
		return true;
	}));
}

/** Resolve with first-writer-wins exclusive outcome creation (invariant 2). */
export function resolveEscalation(args: ResolveEscalationArgs): WriteOutcomeResult {
	const request = requireRequest(args);
	const existing = readOutcomeUnchecked(args.agentDir, args.rootRunId, args.requestId);
	if (existing) return { outcome: existing, duplicate: true };
	validateResolutionSelection(request, args.resolution.selected);
	validateCustomInstruction(request, args.resolution.selected, args.resolution.customInstruction);
	return writeCanonicalOutcome(
		args,
		resolvedOutcomeFor(args),
		"resolved",
	);
}

/** Resolve only while the named live mailbox lease is held. */
export function resolveClaimedEscalation(args: ResolveClaimedEscalationArgs): WriteOutcomeResult {
	const request = requireRequest(args);
	const existing = readOutcomeUnchecked(args.agentDir, args.rootRunId, args.requestId);
	if (existing) return { outcome: existing, duplicate: true };
	validateResolutionSelection(request, args.resolution.selected);
	validateCustomInstruction(request, args.resolution.selected, args.resolution.customInstruction);
	return writeCanonicalOutcome(
		args,
		resolvedOutcomeFor(args),
		"resolved",
		{ holderId: args.holderId, claimedBy: args.claimedBy, now: toDate(args.now) },
	);
}

/** Write a timeout/cancel terminal through the same exclusive-create path. */
export function writeTerminalOutcome(args: TerminalOutcomeArgs): WriteOutcomeResult {
	const request = requireRequest(args);
	const existing = readOutcomeUnchecked(args.agentDir, args.rootRunId, args.requestId);
	if (existing) return { outcome: existing, duplicate: true };
	if (args.selected !== undefined) validateResolutionSelection(request, args.selected);
	const outcome: EscalationOutcome = {
		requestId: args.requestId,
		outcomeVersion: ESCALATION_OUTCOME_VERSION,
		status: args.status,
		...(args.selected !== undefined ? { selected: [...args.selected] } : {}),
		...(args.note !== undefined ? { note: args.note } : {}),
		...(args.resolvedBy !== undefined ? { resolvedBy: args.resolvedBy } : {}),
		at: toDate(args.at).toISOString(),
	};
	return writeCanonicalOutcome(args, outcome, args.status === "timeout" ? "timeout" : "cancelled");
}

/** Convenience cancellation entry point used by terminal lifecycle cleanup. */
export function cancelEscalation(
	args: Omit<TerminalOutcomeArgs, "status">,
): WriteOutcomeResult {
	return writeTerminalOutcome({ ...args, status: "cancelled" });
}

/** Read an authenticated canonical outcome. */
export function readOutcome(args: ReadEscalationArgs): EscalationOutcome | null {
	const request = readEscalationRequest(args);
	if (!request) return null;
	return readOutcomeUnchecked(args.agentDir, args.rootRunId, args.requestId);
}

/**
 * Raiser-side hold-open primitive (DE-7). Polling consumes no agent execution
 * and aborts promptly when the caller's signal is cancelled.
 */
export async function awaitOutcome(args: AwaitOutcomeArgs): Promise<EscalationOutcome> {
	const pollMs = args.pollMs ?? 50;
	assertPositiveFinite(pollMs, "pollMs");
	for (;;) {
		if (args.signal?.aborted) throw abortError(args.signal.reason);
		const outcome = readOutcome(args);
		if (outcome) return outcome;
		await abortableDelay(pollMs, args.signal);
	}
}

/** Move to a later frozen-chain holder while preserving request/reply identity. */
export function forwardEscalation(args: ForwardEscalationArgs): EscalationRequest {
	const request = requireRequest(args);
	if (readOutcomeUnchecked(args.agentDir, args.rootRunId, args.requestId) !== null) {
		throw new Error(`cannot forward terminal escalation request: ${args.requestId}`);
	}
	if (!Number.isInteger(args.toIndex) || args.toIndex <= request.holderIndex || args.toIndex >= request.chain.length) {
		if (args.toIndex === request.holderIndex) {
			const currentHolder = request.chain[request.holderIndex];
			const at = toDate(args.at).toISOString();
			writeMailboxEntry(args.agentDir, request, currentHolder.id, at);
			return freezeRequestChain(request);
		}
		throw new Error("toIndex must identify a later node in the frozen escalation chain");
	}
	const oldHolder = request.chain[request.holderIndex];
	const newHolder = request.chain[args.toIndex];
	const at = toDate(args.at).toISOString();
	const updated = mutateRequest(args.agentDir, args.rootRunId, args.requestId, (latest) => {
		if (args.toIndex <= latest.holderIndex || args.toIndex >= latest.chain.length) {
			throw new Error("escalation was already forwarded past toIndex");
		}
		return {
			...latest,
			holderIndex: args.toIndex,
			...(args.hopDeadlineAt !== undefined
				? { hopDeadlineAt: validDateString(args.hopDeadlineAt, "hopDeadlineAt") }
				: {}),
			trace: [
				...latest.trace,
				{
					at,
					event: args.auto ? "auto-passed" : "forwarded",
					holderId: newHolder.id,
					...(args.context !== undefined ? { note: args.context } : {}),
					...(args.recommendation !== undefined ? { recommendation: args.recommendation } : {}),
				},
			],
		};
	});
	// New index is durable before the obsolete delivery hint disappears.
	writeMailboxEntry(args.agentDir, updated, newHolder.id, at);
	try {
		fs.rmSync(mailboxFileFor(args.agentDir, args.rootRunId, oldHolder.id, args.requestId), {
			force: true,
		});
	} catch {
		/* A stale mailbox is harmless: holderIndex is canonical. */
	}
	return freezeRequestChain(updated);
}

/** Best-effort terminal cleanup for all escalation state under one root run. */
export function purgeEscalations(agentDir: string, rootRunId: string): void;
export function purgeEscalations(args: ListEscalationArgs): void;
export function purgeEscalations(
	agentDirOrArgs: string | ListEscalationArgs,
	rootRunId?: string,
): void {
	const args = typeof agentDirOrArgs === "string"
		? { agentDir: agentDirOrArgs, rootRunId: rootRunId ?? "" }
		: agentDirOrArgs;
	if (!args.agentDir) return;
	try {
		fs.rmSync(resolveEscalationsDir(args.agentDir, args.rootRunId), {
			recursive: true,
			force: true,
		});
	} catch {
		/* terminal cleanup is best-effort */
	}
}

/** Test/reset seam for the successful-cap credential cache inherited from v1. */
export function __resetEscalationStoreForTests(): void {
	verifiedCapCredentials.clear();
	delete __testHooks.beforeExclusiveOutcomeWrite;
}

function validatePayload<K extends EscalationKind>(
	kind: K,
	payload: EscalationPayloadByKind[K],
): void {
	if (!isRecord(payload)) throw new Error(`invalid ${kind} escalation payload`);
	if (kind === "decision") {
		assertOnlyKeys(payload, ["header", "body", "options", "recommended", "multi"], "decision payload");
		const value = payload as DecisionEscalationPayload;
		assertNonEmptyString(value.header, "decision.header");
		validateOptions(value.options, "decision.options");
		if (value.body !== undefined && typeof value.body !== "string") throw new Error("decision.body must be a string");
		if (value.multi !== undefined && typeof value.multi !== "boolean") throw new Error("decision.multi must be boolean");
		if (value.recommended !== undefined) {
			validateSelection([value.recommended], value.options.length, true, "decision.recommended");
		}
		return;
	}
	if (kind === "blocker") {
		assertOnlyKeys(payload, ["cause", "description", "unblock", "options"], "blocker payload");
		const value = payload as BlockerEscalationPayload;
		assertNonEmptyString(value.cause, "blocker.cause");
		assertNonEmptyString(value.description, "blocker.description");
		if (value.unblock !== undefined && typeof value.unblock !== "string") throw new Error("blocker.unblock must be a string");
		if (value.options !== undefined) validateOptions(value.options, "blocker.options");
		return;
	}
	if (kind === "amendment") {
		assertOnlyKeys(payload, ["target", "change", "rationale"], "amendment payload");
		const value = payload as AmendmentEscalationPayload;
		assertNonEmptyString(value.target, "amendment.target");
		assertNonEmptyString(value.change, "amendment.change");
		assertNonEmptyString(value.rationale, "amendment.rationale");
		return;
	}
	throw new Error(`unsupported escalation kind: ${String(kind)}`);
}

function validateOptions(options: readonly EscalationOption[], field: string): void {
	if (!Array.isArray(options) || options.length === 0) throw new Error(`${field} must be a non-empty array`);
	for (const option of options) {
		if (!isRecord(option)) throw new Error(`${field} entries must be objects`);
		assertNonEmptyString(option.label, `${field}.label`);
		if (option.custom !== undefined && option.custom !== true) {
			throw new Error(`${field}.custom must be true when present`);
		}
	}
}

function validateResolutionOptions(options: readonly EscalationOption[]): void {
	validateOptions(options, "resolutionOptions");
	if (options.filter((option) => isCustomInstructionOption(option)).length > 1) {
		throw new Error("resolutionOptions must contain at most one custom instruction option");
	}
}

function validateChain(chain: EscalationRouteNode[], holderIndex: number): void {
	if (!Array.isArray(chain) || chain.length === 0) throw new Error("escalation chain must not be empty");
	if (!Number.isInteger(holderIndex) || holderIndex < 0 || holderIndex >= chain.length) {
		throw new Error("holderIndex is outside the escalation chain");
	}
	const kinds: readonly EscalationRouteNodeKind[] = ["raiser", "supervisor", "agent", "root", "user"];
	for (const node of chain) {
		if (!isRecord(node)) throw new Error("escalation chain nodes must be objects");
		assertNonEmptyString(node.id, "chain node id");
		if (!kinds.includes(node.kind)) throw new Error(`invalid route node kind: ${String(node.kind)}`);
		if (node.runId !== undefined && typeof node.runId !== "string") throw new Error("route node runId must be a string");
		if (node.lineagePath !== undefined && typeof node.lineagePath !== "string") throw new Error("route node lineagePath must be a string");
		if (node.label !== undefined && typeof node.label !== "string") throw new Error("route node label must be a string");
		if (node.intermediate !== undefined && typeof node.intermediate !== "boolean") throw new Error("route node intermediate must be boolean");
		if (node.authority !== undefined) validateAuthority(node.authority);
	}
}

function validateAuthority(authority: EscalationAuthority): void {
	if (!isRecord(authority)) throw new Error("route authority must be an object");
	if (authority.decision !== undefined && !(["none", "implementation", "all"] as unknown[]).includes(authority.decision)) {
		throw new Error("invalid decision authority");
	}
	if (authority.blocker !== undefined && !(["none", "all"] as unknown[]).includes(authority.blocker)) {
		throw new Error("invalid blocker authority");
	}
	if (authority.amendment !== undefined && !(["none", "all"] as unknown[]).includes(authority.amendment)) {
		throw new Error("invalid amendment authority");
	}
	if (authority.tags !== undefined && (!Array.isArray(authority.tags) || authority.tags.some((tag) => typeof tag !== "string"))) {
		throw new Error("authority tags must be strings");
	}
}

function validateCategory(category: EscalationCategory): void {
	if (!["implementation", "scope-product", "security-permission"].includes(category)) {
		throw new Error(`invalid escalation category: ${String(category)}`);
	}
}

function validateOrigin(origin: EscalationOrigin): void {
	if (origin !== "ask") throw new Error(`invalid escalation origin: ${String(origin)}`);
}

function validateTimeout(timeout: EscalationTimeoutSpec): void {
	if (!isRecord(timeout) || !["useDefault", "noDefaultError", "cancel"].includes(timeout.behavior)) {
		throw new Error("invalid escalation timeout behavior");
	}
	if (timeout.deadlineAt !== undefined) validDateString(timeout.deadlineAt, "timeout.deadlineAt");
	if (timeout.defaultSelection !== undefined && !Array.isArray(timeout.defaultSelection)) {
		throw new Error("timeout.defaultSelection must be an array");
	}
}

function validateReplyEndpoint(
	endpoint: EscalationReplyEndpoint,
	rootRunId: string,
	requestId: string,
	raiser: EscalationRaiser,
): void {
	if (!isRecord(endpoint) || endpoint.kind !== "local-result") throw new Error("invalid escalation reply endpoint");
	if (endpoint.rootRunId !== rootRunId || endpoint.requestId !== requestId) {
		throw new Error("reply endpoint identity does not match escalation request");
	}
	if (endpoint.runId !== raiser.runId || endpoint.lineagePath !== raiser.lineagePath) {
		throw new Error("reply endpoint does not address the escalation raiser");
	}
	assertNonEmptyString(raiser.runId, "raiser.runId");
	assertNonEmptyString(raiser.lineagePath, "raiser.lineagePath");
	if (!isCredential(endpoint.credential)) throw new Error("invalid escalation credential shape");
}

function validateResolutionSelection(request: EscalationRequest, selected: number[]): void {
	validateSelection(
		selected,
		request.resolutionOptions.length,
		request.kind === "decision" && (request.payload as DecisionEscalationPayload).multi === true,
		"selected",
	);
}

function validateCustomInstruction(
	request: EscalationRequest,
	selected: number[],
	customInstruction: string | undefined,
): void {
	const customIndex = request.resolutionOptions.findIndex(isCustomInstructionOption);
	const hasCustom = customIndex >= 0 && selected.includes(customIndex);
	if (hasCustom && selected.length !== 1) {
		throw new Error("custom instruction option must be selected exclusively");
	}
	if (hasCustom && (customInstruction === undefined || customInstruction.trim() === "")) {
		throw new Error("customInstruction must be non-empty when selecting the custom instruction option");
	}
	if (!hasCustom && customInstruction !== undefined) {
		if (customIndex < 0) {
			throw new Error("customInstruction is unsupported for legacy escalation requests without a custom option marker; upgrade pi-delegate or re-raise the request");
		}
		throw new Error("customInstruction requires selecting the custom instruction option");
	}
}

function validateSelection(
	selected: number[] | undefined,
	optionCount: number,
	multi: boolean,
	field: string,
): void {
	if (selected === undefined) return;
	if (!Array.isArray(selected) || selected.length === 0) throw new Error(`${field} must select at least one option`);
	if (!multi && selected.length !== 1) throw new Error(`${field} allows exactly one option`);
	const seen = new Set<number>();
	for (const index of selected) {
		if (!Number.isInteger(index) || index < 0 || index >= optionCount) {
			throw new Error(`${field} contains an out-of-range option index`);
		}
		if (seen.has(index)) throw new Error(`${field} contains duplicate option indices`);
		seen.add(index);
	}
}

function resolvedOutcomeFor(args: ResolveEscalationArgs): EscalationOutcome {
	return {
		requestId: args.requestId,
		outcomeVersion: ESCALATION_OUTCOME_VERSION,
		status: "resolved",
		selected: [...args.resolution.selected],
		...(args.resolution.customInstruction !== undefined
			? { customInstruction: args.resolution.customInstruction.trim() }
			: {}),
		...(args.resolution.note !== undefined ? { note: args.resolution.note } : {}),
		...(args.resolution.resolvedBy !== undefined
			? { resolvedBy: args.resolution.resolvedBy }
			: {}),
		at: toDate(args.at).toISOString(),
	};
}

interface LeaseFence {
	holderId: string;
	claimedBy: string;
	now: Date;
}

function writeCanonicalOutcome(
	args: ResolveEscalationArgs | TerminalOutcomeArgs,
	outcome: EscalationOutcome,
	event: "resolved" | "timeout" | "cancelled",
	leaseFence?: LeaseFence,
): WriteOutcomeResult {
	const request = requireRequest(args);
	if (!credentialAuthorizes(args.agentDir, request, args.credential)) {
		throw new Error("invalid escalation credential");
	}
	const file = resultFileFor(args.agentDir, args.rootRunId, args.requestId);
	ensureOwnerOnlyDir(path.dirname(file));
	__testHooks.beforeExclusiveOutcomeWrite?.();
	const publish = (): WriteOutcomeResult => withStateFileLock(file, () => {
		const existing = readOutcomeUnchecked(args.agentDir, args.rootRunId, args.requestId);
		if (existing) return { outcome: existing, duplicate: true };
		const current = readJsonFile(file);
		if (current.kind === "corrupt") preserveCorruptFile(file);
		replaceTextFile(file, serializeArtifact(outcome));
		return { outcome, duplicate: false };
	});
	if (leaseFence === undefined) {
		const result = publish();
		if (result.duplicate) return result;
		mutateRequest(args.agentDir, args.rootRunId, args.requestId, (latest) => appendOutcomeTrace(latest, outcome, event));
		removeMailboxEntries(args.agentDir, args.rootRunId, args.requestId);
		return result;
	}

	const requestFile = requestFileFor(args.agentDir, args.rootRunId, args.requestId);
	return withStateFileLock(requestFile, () => {
		const latest = readRequestFile(requestFile);
		const holder = latest?.chain[latest.holderIndex];
		if (
			!latest ||
			holder?.id !== leaseFence.holderId ||
			!credentialAuthorizes(args.agentDir, latest, args.credential)
		) {
			throw new EscalationLeaseLostError(args.requestId);
		}
		const mailboxFile = mailboxFileFor(args.agentDir, args.rootRunId, leaseFence.holderId, args.requestId);
		return withStateFileLock(mailboxFile, () => {
			const mailbox = readMailboxFile(mailboxFile);
			if (!isLiveClaim(mailbox, leaseFence.claimedBy, leaseFence.now)) {
				throw new EscalationLeaseLostError(args.requestId);
			}
			const result = publish();
			if (result.duplicate) return result;
			applyRequestMutation(requestFile, latest, (currentRequest) => appendOutcomeTrace(currentRequest, outcome, event));
			removeMailboxEntries(args.agentDir, args.rootRunId, args.requestId);
			return result;
		});
	});
}

function appendOutcomeTrace(
	request: EscalationRequest,
	outcome: EscalationOutcome,
	event: "resolved" | "timeout" | "cancelled",
): EscalationRequest {
	return {
		...request,
		trace: [
			...request.trace,
			{
				at: outcome.at,
				event,
				...(outcome.resolvedBy !== undefined ? { holderId: outcome.resolvedBy } : {}),
				...(outcome.note !== undefined ? { note: outcome.note } : {}),
			},
		],
	};
}

function isLiveClaim(
	entry: EscalationMailboxEntry | null,
	claimedBy: string,
	now = new Date(),
): entry is EscalationMailboxEntry & { claimedBy: string; leaseExpiresAt: string } {
	if (!entry || entry.claimedBy !== claimedBy || entry.leaseExpiresAt === undefined) return false;
	const expiresAt = Date.parse(entry.leaseExpiresAt);
	return Number.isFinite(expiresAt) && now.getTime() < expiresAt;
}

function requireRequest(args: ReadEscalationArgs): EscalationRequest {
	const request = readEscalationRequest(args);
	if (!request) throw new Error(`escalation request not found or credential rejected: ${args.requestId}`);
	return request;
}

function mutateRequest(
	agentDir: string,
	rootRunId: string,
	requestId: string,
	mutate: (request: EscalationRequest) => EscalationRequest,
): EscalationRequest {
	const file = requestFileFor(agentDir, rootRunId, requestId);
	return withStateFileLock(file, () => {
		const current = readRequestFile(file);
		if (!current) throw new Error(`escalation request not found: ${requestId}`);
		return applyRequestMutation(file, current, mutate);
	});
}

function applyRequestMutation(
	file: string,
	current: EscalationRequest,
	mutate: (request: EscalationRequest) => EscalationRequest,
): EscalationRequest {
	const next = mutate(current);
	if (next.requestId !== current.requestId || next.rootRunId !== current.rootRunId) {
		throw new Error("escalation mutation cannot change request identity");
	}
	if (JSON.stringify(next.chain) !== JSON.stringify(current.chain)) {
		throw new Error("escalation mutation cannot change the frozen chain");
	}
	if (JSON.stringify(next.replyEndpoint) !== JSON.stringify(current.replyEndpoint)) {
		throw new Error("escalation mutation cannot change the stable reply endpoint");
	}
	if (next.ownerSessionId !== current.ownerSessionId || JSON.stringify(next.consumer) !== JSON.stringify(current.consumer)) {
		throw new Error("escalation mutation cannot change its owner or consumer");
	}
	replaceJsonFile(file, next);
	return next;
}

function credentialAuthorizes(
	agentDir: string,
	request: EscalationRequest,
	presented?: EscalationCredential,
): boolean {
	const endpoint = request.replyEndpoint;
	// A persisted request was authenticated at raise. Explicit possession of its
	// bearer credential survives process replacement; implicit access still needs lineage.
	if (presented !== undefined && "capToken" in presented) return credentialsEqual(endpoint.credential, presented);
	if (!verifyEscalationCredential(agentDir, endpoint, endpoint.credential)) return false;
	return presented === undefined || credentialsEqual(endpoint.credential, presented);
}

function verifyEscalationCredential(
	agentDir: string,
	endpoint: EscalationReplyEndpoint,
	credential: EscalationCredential,
): boolean {
	try {
		if ("capToken" in credential) {
			if (credential.capToken.trim() === "") return false;
			if (capTokenVerifies(credential.capToken, endpoint.lineagePath)) {
				verifiedCapCredentials.add(capCredentialKey(endpoint.lineagePath, credential.capToken));
				return true;
			}
			return verifiedCapCredentials.has(capCredentialKey(endpoint.lineagePath, credential.capToken));
		}
		if (credential.controlSecret.trim() === "") return false;
		const route = readRouteRecord(agentDir, endpoint.runId);
		return constantTimeEqual(credential.controlSecret, route?.controlSecret);
	} catch {
		return false;
	}
}

function capTokenVerifies(capToken: string, expectedPath: string): boolean {
	const live = currentLineageFrame();
	if (live && frameMatchesPath(live, expectedPath) && verifyCapToken(live, capToken)) return true;
	const fromEnvironment = deserializeLineage();
	return Boolean(
		fromEnvironment &&
		frameMatchesPath(fromEnvironment, expectedPath) &&
		verifyCapToken(fromEnvironment, capToken),
	);
}

function frameMatchesPath(frame: DepthFrame, expectedPath: string): boolean {
	return lineagePath(frame) === expectedPath;
}

function capCredentialKey(lineagePathValue: string, capToken: string): string {
	return `${lineagePathValue}\u0000${capToken}`;
}

function credentialsEqual(left: EscalationCredential, right: EscalationCredential): boolean {
	if ("capToken" in left && "capToken" in right) return constantTimeEqual(left.capToken, right.capToken);
	if ("controlSecret" in left && "controlSecret" in right) {
		return constantTimeEqual(left.controlSecret, right.controlSecret);
	}
	return false;
}

function constantTimeEqual(left: string | undefined, right: string | undefined): boolean {
	if (!left || !right) return false;
	const a = Buffer.from(left, "utf8");
	const b = Buffer.from(right, "utf8");
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function writeMailboxEntry(
	agentDir: string,
	request: EscalationRequest,
	holderId: string,
	at: string,
): EscalationMailboxEntry {
	try {
		const dir = resolveEscalationMailboxDir(agentDir, request.rootRunId, holderId);
		ensureOwnerOnlyDir(dir);
		const file = path.join(dir, `${request.requestId}.json`);
		return withStateFileLock(file, () => writeMailboxEntryLocked(file, request, holderId, at));
	} catch (error) {
		if (error instanceof EscalationMailboxPublicationError) throw error;
		throw new EscalationMailboxPublicationError(request.requestId, error);
	}
}

function writeMailboxEntryLocked(
	file: string,
	request: EscalationRequest,
	holderId: string,
	at: string,
): EscalationMailboxEntry {
	const current = readMailboxFile(file);
	const entry: EscalationMailboxEntry = {
		requestId: request.requestId,
		rootRunId: request.rootRunId,
		holderId,
		createdAt: at,
		updatedAt: at,
	};
	const expiresAt = Date.parse(current?.leaseExpiresAt ?? "");
	const sameEntry = current?.requestId === request.requestId &&
		current?.rootRunId === request.rootRunId &&
		current?.holderId === holderId;
	const live = sameEntry && current.claimedBy !== undefined && Number.isFinite(expiresAt) && Date.now() < expiresAt;
	const published = live && current
		? { ...entry, createdAt: current.createdAt, updatedAt: current.updatedAt, claimedBy: current.claimedBy, leaseExpiresAt: current.leaseExpiresAt }
		: entry;
	removeMalformedMailboxElement(file);
	serializeArtifact(published);
	replaceJsonFile(file, published);
	return published;
}

function removeMailboxEntries(agentDir: string, rootRunId: string, requestId: string): void {
	let holders: fs.Dirent[];
	try {
		holders = fs.readdirSync(resolveEscalationMailboxesDir(agentDir, rootRunId), {
			withFileTypes: true,
		});
	} catch {
		return;
	}
	for (const holder of holders) {
		if (!holder.isDirectory()) continue;
		try {
			fs.rmSync(
				path.join(resolveEscalationMailboxesDir(agentDir, rootRunId), holder.name, `${requestId}.json`),
				{ force: true },
			);
		} catch {
			/* canonical outcome makes stale delivery harmless */
		}
	}
}

function requestFileFor(agentDir: string, rootRunId: string, requestId: string): string {
	assertSafeStem(requestId, "requestId");
	return path.join(resolveEscalationRequestsDir(agentDir, rootRunId), `${requestId}.json`);
}

function resultFileFor(agentDir: string, rootRunId: string, requestId: string): string {
	assertSafeStem(requestId, "requestId");
	return path.join(resolveEscalationResultsDir(agentDir, rootRunId), `${requestId}.json`);
}

function mailboxFileFor(
	agentDir: string,
	rootRunId: string,
	holderId: string,
	requestId: string,
): string {
	assertSafeStem(requestId, "requestId");
	return path.join(resolveEscalationMailboxDir(agentDir, rootRunId, holderId), `${requestId}.json`);
}

function readRequestFile(file: string): EscalationRequest | null {
	const value = readJson(file);
	if (!isRecord(value)) return null;
	try {
		const request = value as unknown as EscalationRequest;
		validateProvenance(request);
		assertSafeStem(request.requestId, "requestId");
		assertSafeStem(request.rootRunId, "rootRunId");
		validatePayload(request.kind, request.payload);
		validateChain(request.chain, request.holderIndex);
		validateTimeout(request.timeout);
		validateReplyEndpoint(request.replyEndpoint, request.rootRunId, request.requestId, request.raiser);
		validateResolutionOptions(request.resolutionOptions);
		if (!Array.isArray(request.trace)) return null;
		return request;
	} catch {
		return null;
	}
}

function readMailboxFile(file: string): EscalationMailboxEntry | null {
	const value = readJson(file);
	if (!isRecord(value)) return null;
	if (
		typeof value.requestId !== "string" ||
		typeof value.rootRunId !== "string" ||
		typeof value.holderId !== "string" ||
		typeof value.createdAt !== "string" ||
		typeof value.updatedAt !== "string" ||
		(value.claimedBy !== undefined && typeof value.claimedBy !== "string") ||
		(value.leaseExpiresAt !== undefined && typeof value.leaseExpiresAt !== "string")
	) return null;
	return value as unknown as EscalationMailboxEntry;
}

function readOutcomeFile(file: string): EscalationOutcome | null {
	const value = readJson(file);
	if (!isRecord(value)) return null;
	if (value.outcomeVersion !== undefined && value.outcomeVersion !== ESCALATION_OUTCOME_VERSION) {
		throw new UnsupportedEscalationOutcomeVersionError(value.outcomeVersion);
	}
	if (
		typeof value.requestId !== "string" ||
		!["resolved", "timeout", "cancelled"].includes(String(value.status)) ||
		typeof value.at !== "string" ||
		(value.selected !== undefined &&
			(!Array.isArray(value.selected) || value.selected.some((index) => !Number.isInteger(index)))) ||
		(value.customInstruction !== undefined &&
			(typeof value.customInstruction !== "string" || value.customInstruction.trim() === "")) ||
		(value.note !== undefined && typeof value.note !== "string") ||
		(value.resolvedBy !== undefined && typeof value.resolvedBy !== "string")
	) return null;
	return value as unknown as EscalationOutcome;
}

function readOutcomeUnchecked(
	agentDir: string,
	rootRunId: string,
	requestId: string,
): EscalationOutcome | null {
	try {
		return readOutcomeFile(resultFileFor(agentDir, rootRunId, requestId));
	} catch (error) {
		if (error instanceof UnsupportedEscalationOutcomeVersionError) throw error;
		return null;
	}
}

function readJson(file: string): unknown {
	const result = readJsonFile(file);
	return result.kind === "ok" ? result.value : null;
}

function listJsonFiles(dir: string): string[] {
	try {
		return fs.readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
			.map((entry) => path.join(dir, entry.name))
			.sort();
	} catch {
		return [];
	}
}

function atomicWriteJson(file: string, value: unknown): void {
	replaceTextFile(file, serializeArtifact(value));
}

function serializeArtifact(value: unknown): string {
	const serialized = JSON.stringify(value);
	if (Buffer.byteLength(serialized, "utf8") > MAX_ARTIFACT_BYTES) {
		throw new Error(`serialized escalation artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`);
	}
	return serialized;
}

/**
 * Compare the immutable request identity while excluding retry-time timestamps.
 * The payload, routing chain, policy, and reply credential define one request;
 * `raisedAt`, `hopDeadlineAt`, and trace entries describe this attempt's timing.
 */
function sameRequestIdentity(left: EscalationRequest, right: EscalationRequest): boolean {
	const identity = (request: EscalationRequest): unknown => ({
		requestId: request.requestId,
		rootRunId: request.rootRunId,
		ownerSessionId: request.ownerSessionId,
		consumer: request.consumer,
		kind: request.kind,
		payload: request.payload,
		category: request.category,
		resolutionOptions: request.resolutionOptions,
		chain: request.chain,
		timeout: {
			behavior: request.timeout.behavior,
			deadlineAt: request.timeout.deadlineAt,
			defaultSelection: request.timeout.defaultSelection,
		},
		holdStrategy: request.holdStrategy,
		replyEndpoint: request.replyEndpoint,
		raiser: request.raiser,
	});
	return JSON.stringify(canonicalize(identity(left))) === JSON.stringify(canonicalize(identity(right)));
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
	);
}

function removeMalformedMailboxElement(file: string): void {
	try {
		if (!fs.lstatSync(file).isFile()) fs.rmSync(file, { recursive: true, force: true });
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return;
		throw error;
	}
}

function ensureOwnerOnlyDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.chmodSync(dir, 0o700);
}

function safeMailboxSegment(value: string): string {
	if (isSafeStem(value)) return value;
	return `holder-${crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32)}`;
}

function isSafeStem(value: string): boolean {
	return value !== "" && value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\");
}

function assertSafeStem(value: string, field: string): void {
	if (typeof value !== "string" || !isSafeStem(value)) throw new Error(`unsafe ${field}`);
}

function assertStoreAddress(agentDir: string, rootRunId: string, requestId: string): void {
	assertNonEmptyString(agentDir, "agentDir");
	assertSafeStem(rootRunId, "rootRunId");
	assertSafeStem(requestId, "requestId");
}

function assertOnlyKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	field: string,
): void {
	const allowedKeys = new Set(allowed);
	const unexpected = Object.keys(value).find((key) => !allowedKeys.has(key));
	if (unexpected !== undefined) throw new Error(`${field} contains unexpected field: ${unexpected}`);
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must not be empty`);
}

function validateProvenance(request: Pick<EscalationRequest, "ownerSessionId" | "consumer">): void {
	if (request.ownerSessionId !== undefined) assertNonEmptyString(request.ownerSessionId, "ownerSessionId");
	if (request.consumer === undefined) return;
	if (!isRecord(request.consumer)) throw new Error("invalid escalation consumer");
	assertNonEmptyString(request.consumer.sessionFile, "consumer.sessionFile");
	assertNonEmptyString(request.consumer.toolCallId, "consumer.toolCallId");
	if (request.consumer.sessionId !== undefined) assertNonEmptyString(request.consumer.sessionId, "consumer.sessionId");
}

function assertPositiveFinite(value: number, field: string): void {
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${field} must be positive`);
}

function validDateString(value: string, field: string): string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
		throw new Error(`${field} must be an ISO date string`);
	}
	return value;
}

function toDate(value?: Date | number | string): Date {
	const date = value === undefined ? new Date() : value instanceof Date ? value : new Date(value);
	if (!Number.isFinite(date.getTime())) throw new Error("invalid date");
	return date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCredential(value: unknown): value is EscalationCredential {
	if (!isRecord(value)) return false;
	const hasCap = typeof value.capToken === "string";
	const hasControl = typeof value.controlSecret === "string";
	return hasCap !== hasControl;
}

function cloneOptions(options: readonly EscalationOption[]): EscalationOption[] {
	return options.map((option) => ({ label: option.label }));
}

function clonePayload<K extends EscalationKind>(
	kind: K,
	payload: EscalationPayloadByKind[K],
): EscalationPayloadByKind[K] {
	if (kind === "decision") {
		const value = payload as DecisionEscalationPayload;
		return {
			header: value.header,
			...(value.body !== undefined ? { body: value.body } : {}),
			options: cloneOptions(value.options),
			...(value.recommended !== undefined ? { recommended: value.recommended } : {}),
			...(value.multi !== undefined ? { multi: value.multi } : {}),
		} as EscalationPayloadByKind[K];
	}
	if (kind === "blocker") {
		const value = payload as BlockerEscalationPayload;
		return {
			cause: value.cause,
			description: value.description,
			...(value.unblock !== undefined ? { unblock: value.unblock } : {}),
			...(value.options !== undefined ? { options: cloneOptions(value.options) } : {}),
		} as EscalationPayloadByKind[K];
	}
	const value = payload as AmendmentEscalationPayload;
	return {
		target: value.target,
		change: value.change,
		rationale: value.rationale,
	} as EscalationPayloadByKind[K];
}

function cloneTimeout(timeout: EscalationTimeoutSpec): EscalationTimeoutSpec {
	return {
		behavior: timeout.behavior,
		...(timeout.deadlineAt !== undefined ? { deadlineAt: timeout.deadlineAt } : {}),
		...(timeout.defaultSelection !== undefined
			? { defaultSelection: [...timeout.defaultSelection] }
			: {}),
	};
}

function cloneReplyEndpoint(endpoint: EscalationReplyEndpoint): EscalationReplyEndpoint {
	return {
		kind: "local-result",
		rootRunId: endpoint.rootRunId,
		requestId: endpoint.requestId,
		runId: endpoint.runId,
		lineagePath: endpoint.lineagePath,
		credential: "capToken" in endpoint.credential
			? { capToken: endpoint.credential.capToken }
			: { controlSecret: endpoint.credential.controlSecret },
	};
}

function freezeChain(chain: EscalationRouteNode[]): EscalationRouteNode[] {
	return Object.freeze(chain.map((node) => {
		const authority = node.authority === undefined
			? undefined
			: Object.freeze({
				...node.authority,
				...(node.authority.tags !== undefined
					? { tags: Object.freeze([...node.authority.tags]) as unknown as string[] }
					: {}),
			});
		return Object.freeze({ ...node, ...(authority !== undefined ? { authority } : {}) });
	})) as unknown as EscalationRouteNode[];
}

function freezeRequestChain(request: EscalationRequest): EscalationRequest {
	return { ...request, chain: freezeChain(request.chain) };
}

function abortError(reason: unknown): Error {
	if (reason instanceof Error) return reason;
	const error = new Error(reason === undefined ? "The operation was aborted" : String(reason));
	error.name = "AbortError";
	return error;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError(signal.reason));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(abortError(signal?.reason));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
