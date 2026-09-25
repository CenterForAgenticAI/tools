/**
 * Originator/root adapters over the durable escalation plane.
 *
 * Agent-mediated recovery (§2.3) and native UI (§2.5) share the canonical
 * request/outcome files and the invariant-4 mailbox lease. Wake files are
 * owner-scoped hints only (invariant 5); every delivery re-reads the request.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
	DEFAULT_ESCALATION_CONFIG,
	loadConfig,
	loadConfigReadOnly,
	type ResolvedEscalationConfig,
} from "./config.js";
import { claimPendingResult, consumePendingResult, unclaimPendingResult } from "./detached-spawn.js";
import { authorityDecides } from "./escalation-chain.js";
import { passEscalation } from "./escalation-runtime.js";
import {
	claimEscalation,
	ESCALATION_OUTCOME_VERSION,
	EscalationLeaseLostError,
	isCustomInstructionOption,
	listEscalationRequests,
	readEscalationRequest,
	readOutcome,
	releaseClaim,
	resolveClaimedEscalation,
	resolveEscalation,
	resolveEscalationRequestsDir,
	resolveEscalationResultsDir,
	type AmendmentEscalationPayload,
	type BlockerEscalationPayload,
	type DecisionEscalationPayload,
	type EscalationOutcome,
	type EscalationRequest,
	type EscalationRouteNode,
} from "./escalation-store.js";
import {
	buildRootEscalationHolderId,
	normalizeEscalationSelection,
} from "./escalation-tools.js";
import {
	buildEscalationPendingMessage,
	getProcessNonce,
	removePendingEscalationWake,
	scanPendingWakes,
	type EscalationPendingMessage,
	type PendingEscalationWakeRecord,
} from "./pending-wakes.js";

const DEFAULT_LEASE_MS = 60_000;
const DISMISS_LABEL = "Dismiss — decide later";

class LeaseLostError extends Error {
	constructor(message = "Escalation lease was lost; the pending operator decision was discarded.") {
		super(message);
		this.name = "LeaseLostError";
	}
}

interface LeaseGuard {
	lost: Promise<never>;
	revalidate(): void;
	stop(): void;
}

function startLeaseGuard(
	args: {
		agentDir: string;
		rootRunId: string;
		requestId: string;
		holderId: string;
		claimedBy: string;
		leaseMs: number;
		credential: EscalationRequest["replyEndpoint"]["credential"];
	},
	deps: EscalationSurfaceDeps,
): LeaseGuard {
	let lostError: LeaseLostError | undefined;
	let rejectLost: ((reason: LeaseLostError) => void) | undefined;
	let stopped = false;
	const lost = new Promise<never>((_resolve, reject) => {
		rejectLost = reject;
	});
	// This promise can only ever settle by rejecting, and `awaitWithLease` races
	// it, abandoning whichever side loses. If the pending answer wins, nothing
	// settles `lost` and it stays pending for the life of the process — which
	// Node's test runner reports as "Promise resolution is still pending but the
	// event loop has already resolved", cancelling whichever test happens to be
	// in flight when it notices. `stop()` settles it; this pre-attached handler
	// means that settle can never surface as an unhandled rejection.
	void lost.catch(() => undefined);
	const lose = (reason?: unknown): void => {
		if (lostError || stopped) return;
		lostError = reason instanceof LeaseLostError
			? reason
			: new LeaseLostError(reason instanceof Error ? `${reason.message}; the pending operator decision was discarded.` : undefined);
		rejectLost?.(lostError);
	};
	const renew = (): void => {
		if (stopped || lostError) return;
		try {
			const result = deps.claim({
				agentDir: args.agentDir,
				rootRunId: args.rootRunId,
				requestId: args.requestId,
				holderId: args.holderId,
				claimedBy: args.claimedBy,
				leaseMs: args.leaseMs,
				now: deps.now(),
				credential: args.credential,
			});
			if (!result.claimed) lose();
		} catch (error) {
			lose(error);
		}
	};
	const interval = setInterval(renew, Math.max(1, Math.floor(args.leaseMs / 3)));
	interval.unref?.();
	return {
		lost,
		revalidate: () => {
			if (lostError) throw lostError;
			renew();
			if (lostError) throw lostError;
		},
		stop: () => {
			if (stopped) return;
			stopped = true;
			clearInterval(interval);
			// Settle the race loser so the guard leaves nothing pending behind it.
			// `stop()` is called from a `finally` after every `awaitWithLease` has
			// already completed, so nothing is racing this promise by now.
			rejectLost?.(new LeaseLostError("lease guard stopped"));
		},
	};
}

async function awaitWithLease<T>(pending: Promise<T>, guard: LeaseGuard): Promise<T> {
	return Promise.race([pending, guard.lost]);
}

export type EscalationHolderPosition = "below-root" | "root-held" | "user-held";

export interface HeldEscalation {
	requestId: string;
	rootRunId: string;
	kind: EscalationRequest["kind"];
	payloadSummary: string;
	category?: EscalationRequest["category"];
	/** Provenance of the raise; `"ask"` means a translated worker ask. */
	origin?: EscalationRequest["origin"];
	holder: EscalationRouteNode & {
		position: EscalationHolderPosition;
		isRootHolder: boolean;
		isUser: boolean;
	};
	resolutionOptions: Array<{ index: number; label: string }>;
	raisedAt: string;
	deadlines: {
		request?: string;
		hop?: string;
	};
	traceLength: number;
	latestAnnotation?: {
		context?: string;
		recommendation?: string;
	};
}

export interface EscalationSurfaceResult {
	ok: boolean;
	text: string;
	details: Record<string, unknown>;
}

export interface EscalationSurfaceDeps {
	listRoots(agentDir: string): string[];
	listRequests(agentDir: string, rootRunId: string): EscalationRequest[];
	readRequest(agentDir: string, rootRunId: string, requestId: string): EscalationRequest | null;
	readOutcome(agentDir: string, rootRunId: string, requestId: string): EscalationOutcome | null;
	claim: typeof claimEscalation;
	release: typeof releaseClaim;
	resolve: typeof resolveEscalation;
	pass: typeof passEscalation;
	removeWake: typeof removePendingEscalationWake;
	config(agentDir: string): ResolvedEscalationConfig;
	now(): Date;
}

function defaultListRoots(agentDir: string): string[] {
	const busRoot = path.join(agentDir, "extensions", "pi-delegate", "event-bus");
	try {
		return fs.readdirSync(busRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.filter((rootRunId) => {
				try {
					return fs.statSync(resolveEscalationRequestsDir(agentDir, rootRunId)).isDirectory();
				} catch {
					return false;
				}
			})
			.sort();
	} catch {
		return [];
	}
}

/**
 * Read requests as the originator process that owns this 0700 namespace.
 *
 * Store reads are attempted first. A cap-token request raised in another
 * process may not be verifiable in the root's current lineage frame; v1's
 * originator recovery surface intentionally read its own request files without
 * a worker credential. The fallback below mirrors that ownership boundary for
 * reads only. Mutations still go through the store and its credential checks.
 */
function defaultListRequests(agentDir: string, rootRunId: string): EscalationRequest[] {
	const authenticated = listEscalationRequests({ agentDir, rootRunId });
	const byId = new Map(authenticated.map((request) => [request.requestId, request]));
	for (const request of readOwnedRequestFiles(agentDir, rootRunId)) {
		if (!byId.has(request.requestId)) byId.set(request.requestId, request);
	}
	return [...byId.values()].sort((left, right) => left.requestId.localeCompare(right.requestId));
}

function defaultReadRequest(agentDir: string, rootRunId: string, requestId: string): EscalationRequest | null {
	const authenticated = readEscalationRequest({ agentDir, rootRunId, requestId });
	if (authenticated) return authenticated;
	return readOwnedRequestFiles(agentDir, rootRunId).find((request) => request.requestId === requestId) ?? null;
}

function defaultReadOutcome(agentDir: string, rootRunId: string, requestId: string): EscalationOutcome | null {
	if (!isSafeStem(requestId)) return null;
	const authenticated = readOutcome({ agentDir, rootRunId, requestId });
	if (authenticated) return authenticated;
	try {
		const value = JSON.parse(
			fs.readFileSync(path.join(resolveEscalationResultsDir(agentDir, rootRunId), `${requestId}.json`), "utf8"),
		) as unknown;
		return isOwnedOutcome(value, requestId) ? value : null;
	} catch {
		return null;
	}
}

const DEFAULT_DEPS: EscalationSurfaceDeps = {
	listRoots: defaultListRoots,
	listRequests: defaultListRequests,
	readRequest: defaultReadRequest,
	readOutcome: defaultReadOutcome,
	claim: claimEscalation,
	release: releaseClaim,
	resolve: resolveEscalation,
	pass: passEscalation,
	removeWake: removePendingEscalationWake,
	config: (agentDir) => loadConfig(agentDir).escalation ?? cloneDefaultConfig(),
	now: () => new Date(),
};

function depsFor(overrides?: Partial<EscalationSurfaceDeps>): EscalationSurfaceDeps {
	return { ...DEFAULT_DEPS, ...overrides };
}

export function listEscalationRootRunIds(
	agentDir: string,
	deps?: Pick<EscalationSurfaceDeps, "listRoots">,
): string[] {
	return (deps ?? DEFAULT_DEPS).listRoots(agentDir);
}

/** Originator-owned canonical read, including the documented credential fallback. */
export function readHeldEscalationRequest(args: {
	agentDir: string;
	rootRunId: string;
	requestId: string;
	deps?: Partial<EscalationSurfaceDeps>;
}): EscalationRequest | null {
	return depsFor(args.deps).readRequest(args.agentDir, args.rootRunId, args.requestId);
}

/** List pending requests from canonical state, never from wake payloads. */
export function listHeldEscalations(args: {
	agentDir: string;
	rootRunId?: string;
	requestIds?: readonly string[];
	deps?: Partial<EscalationSurfaceDeps>;
}): HeldEscalation[] {
	const deps = depsFor(args.deps);
	const roots = args.rootRunId === undefined ? deps.listRoots(args.agentDir) : [args.rootRunId];
	const filter = args.requestIds === undefined ? undefined : new Set(args.requestIds);
	const held: HeldEscalation[] = [];
	for (const rootRunId of [...new Set(roots)].sort()) {
		for (const request of deps.listRequests(args.agentDir, rootRunId)) {
			if (filter && !filter.has(request.requestId)) continue;
			if (deps.readOutcome(args.agentDir, rootRunId, request.requestId)) continue;
			const holder = request.chain[request.holderIndex];
			if (!holder) continue;
			const rootHolderId = buildRootEscalationHolderId(rootRunId);
			const isRootHolder = holder.id === rootHolderId || holder.kind === "root";
			const isUser = holder.kind === "user";
			const annotation = latestAnnotation(request);
			held.push({
				requestId: request.requestId,
				rootRunId,
				kind: request.kind,
				payloadSummary: summarizePayload(request),
				...(request.category !== undefined ? { category: request.category } : {}),
				...(request.origin !== undefined ? { origin: request.origin } : {}),
				holder: {
					...holder,
					position: isUser ? "user-held" : isRootHolder ? "root-held" : "below-root",
					isRootHolder,
					isUser,
				},
				resolutionOptions: request.resolutionOptions.map((option, index) => ({ index, label: option.label })),
				raisedAt: request.raisedAt,
				deadlines: {
					...(request.timeout.deadlineAt !== undefined ? { request: request.timeout.deadlineAt } : {}),
					...(request.hopDeadlineAt !== undefined ? { hop: request.hopDeadlineAt } : {}),
				},
				traceLength: request.trace.length,
				...(annotation !== undefined ? { latestAnnotation: annotation } : {}),
			});
		}
	}
	return held.sort((left, right) =>
		left.rootRunId.localeCompare(right.rootRunId) || left.requestId.localeCompare(right.requestId),
	);
}

/** Root/user resolver adapter. Both surfaces use the current holder lease. */
export function resolveHeldEscalation(args: {
	agentDir: string;
	rootRunId?: string;
	requestId: string;
	selected: number | number[];
	customInstruction?: string;
	note?: string;
	claimedBy: string;
	leaseMs?: number;
	onBehalfOfUser?: boolean;
	deps?: Partial<EscalationSurfaceDeps>;
}): EscalationSurfaceResult {
	const deps = depsFor(args.deps);
	const located = locateRequest(args.agentDir, args.requestId, args.rootRunId, deps);
	if ("error" in located) return located.error;
	const { request, rootRunId } = located;
	const existing = deps.readOutcome(args.agentDir, rootRunId, request.requestId);
	if (existing) return terminalSurfaceResult("resolve", rootRunId, request.requestId, existing);
	const holder = request.chain[request.holderIndex];
	if (!holder) return errorResult(`Escalation ${request.requestId} has no current holder.`, "invalid-holder", { rootRunId });
	const isRoot = holder.id === buildRootEscalationHolderId(rootRunId) || holder.kind === "root";
	const isUser = holder.kind === "user";
	if (!isRoot && !isUser) {
		return errorResult(
			`Escalation ${request.requestId} is still held below the root by ${holder.label ?? holder.id} (${holder.kind}).`,
			"below-root",
			{ rootRunId, holder },
		);
	}
	if (isRoot && !authorityDecides(deps.config(args.agentDir).authority, request.kind, request.category)) {
		return errorResult(
			`The root agent lacks declared authority to resolve ${request.kind} escalation ${request.requestId}. Use \`delegate_escalation\` with action "pass_up" to pass it to the operator.`,
			"authority-refused",
			{ rootRunId, requestId: request.requestId, kind: request.kind, category: request.category },
		);
	}
	if (isUser && args.onBehalfOfUser !== true) {
		return errorResult(
			`Escalation ${request.requestId} is at the operator surface. Resolve it only after the user has chosen, with onBehalfOfUser=true.`,
			"operator-choice-required",
			{ rootRunId, requestId: request.requestId },
		);
	}
	let selected: number[];
	const customInstruction = args.customInstruction?.trim();
	try {
		selected = normalizeEscalationSelection(args.selected, request, customInstruction || undefined);
	} catch (error) {
		return errorResult(errorMessage(error), "invalid-selection", { rootRunId, requestId: request.requestId });
	}
	const credential = request.replyEndpoint.credential;
	let claimed = false;
	try {
		const claim = deps.claim({
			agentDir: args.agentDir,
			rootRunId,
			requestId: request.requestId,
			holderId: holder.id,
			claimedBy: args.claimedBy,
			leaseMs: args.leaseMs ?? DEFAULT_LEASE_MS,
			now: deps.now(),
			credential,
		});
		if (!claim.claimed) {
			const terminal = deps.readOutcome(args.agentDir, rootRunId, request.requestId);
			if (terminal) return terminalSurfaceResult("resolve", rootRunId, request.requestId, terminal);
			return errorResult(
				`Escalation ${request.requestId} is busy: another resolver holds the current mailbox lease. Retry after that lease expires.`,
				"lease-busy",
				{ rootRunId, requestId: request.requestId, holderId: holder.id },
			);
		}
		claimed = true;
		const note = args.note?.trim();
		const wrote = deps.resolve({
			agentDir: args.agentDir,
			rootRunId,
			requestId: request.requestId,
			credential,
			resolution: {
				selected,
				...(customInstruction ? { customInstruction } : {}),
				// v1 attributed agent-mediated answers to originator-agent and
				// native/operator answers to user. Keep those semantic actors rather
				// than leaking an implementation-specific holder id into audit data.
				resolvedBy: args.onBehalfOfUser === true || isUser ? "user" : "originator-agent",
				...(note ? { note } : {}),
			},
			at: deps.now(),
		});
		deps.removeWake(args.agentDir, rootRunId, request.requestId);
		const labels = selected.map((index) => request.resolutionOptions[index]?.label ?? String(index));
		return {
			ok: true,
			text: wrote.duplicate
				? `Escalation ${request.requestId} was already terminal (${wrote.outcome.status}); resolution was not repeated.`
				: `Resolved escalation ${request.requestId}: ${labels.join(", ")}.`,
			details: {
				resolved: !wrote.duplicate,
				duplicate: wrote.duplicate,
				rootRunId,
				requestId: request.requestId,
				selected,
				selectedLabels: labels,
				outcome: wrote.outcome,
			},
		};
	} catch (error) {
		const terminal = deps.readOutcome(args.agentDir, rootRunId, request.requestId);
		if (terminal) return terminalSurfaceResult("resolve", rootRunId, request.requestId, terminal);
		return errorResult(
			`Could not resolve escalation ${request.requestId}: ${errorMessage(error)}`,
			"resolve-failed",
			{ rootRunId, requestId: request.requestId },
		);
	} finally {
		if (claimed) {
			try {
				deps.release({
					agentDir: args.agentDir,
					rootRunId,
					requestId: request.requestId,
					holderId: holder.id,
					claimedBy: args.claimedBy,
					credential,
				});
			} catch {
				/* resolution removes the mailbox; release is best-effort thereafter */
			}
		}
	}
}

/** Root agent's symmetric §2.3 pass verb. */
export function passHeldEscalation(args: {
	agentDir: string;
	rootRunId?: string;
	requestIds?: readonly string[];
	context?: string;
	recommendation?: string;
	deps?: Partial<EscalationSurfaceDeps>;
}): EscalationSurfaceResult {
	const deps = depsFor(args.deps);
	const explicit = args.requestIds === undefined ? undefined : [...new Set(args.requestIds)];
	const candidates: Array<{ request: EscalationRequest; rootRunId: string }> = [];
	if (explicit) {
		for (const requestId of explicit) {
			const located = locateRequest(args.agentDir, requestId, args.rootRunId, deps);
			if ("error" in located) return located.error;
			candidates.push(located);
		}
	} else {
		for (const item of listHeldEscalations({ agentDir: args.agentDir, rootRunId: args.rootRunId, deps: args.deps })) {
			if (item.holder.position !== "root-held") continue;
			const request = deps.readRequest(args.agentDir, item.rootRunId, item.requestId);
			if (request) candidates.push({ request, rootRunId: item.rootRunId });
		}
	}
	if (candidates.length === 0) {
		return errorResult("No root-held escalation is pending.", "no-pending-escalations", {});
	}
	const forwarded: Array<Record<string, unknown>> = [];
	const noops: Array<Record<string, unknown>> = [];
	const errors: Array<Record<string, unknown>> = [];
	for (const { request, rootRunId } of candidates) {
		const terminal = deps.readOutcome(args.agentDir, rootRunId, request.requestId);
		if (terminal) {
			noops.push({ requestId: request.requestId, rootRunId, status: terminal.status });
			continue;
		}
		const holder = request.chain[request.holderIndex];
		if (!holder) {
			errors.push({ requestId: request.requestId, rootRunId, error: "missing current holder" });
			continue;
		}
		if (holder.kind === "user") {
			noops.push({ requestId: request.requestId, rootRunId, holderKind: "user", reason: "already-operator" });
			continue;
		}
		if (holder.id !== buildRootEscalationHolderId(rootRunId) && holder.kind !== "root") {
			errors.push({ requestId: request.requestId, rootRunId, error: `still held by ${holder.label ?? holder.id} (${holder.kind})` });
			continue;
		}
		try {
			const moved = deps.pass({
				agentDir: args.agentDir,
				rootRunId,
				requestId: request.requestId,
				config: deps.config(args.agentDir),
				credential: request.replyEndpoint.credential,
				...(args.context?.trim() ? { context: args.context.trim() } : {}),
				...(args.recommendation?.trim() ? { recommendation: args.recommendation.trim() } : {}),
				now: deps.now(),
			});
			const destination = moved.chain[moved.holderIndex];
			forwarded.push({
				requestId: request.requestId,
				rootRunId,
				holderId: destination.id,
				holderKind: destination.kind,
				holderLabel: destination.label,
				hopDeadlineAt: moved.hopDeadlineAt,
			});
		} catch (error) {
			errors.push({ requestId: request.requestId, rootRunId, error: errorMessage(error) });
		}
	}
	const lines = [
		...forwarded.map((item) => `Escalated ${item.requestId as string} to ${String(item.holderLabel ?? item.holderId)} (${item.holderKind as string}).`),
		...noops.map((item) => item.reason === "already-operator"
			? `Escalation ${item.requestId as string} is already at the operator surface; no action taken.`
			: `Escalation ${item.requestId as string} is already terminal (${item.status as string}); no action taken.`),
		...errors.map((item) => `Could not escalate ${item.requestId as string}: ${item.error as string}.`),
	];
	return {
		ok: forwarded.length > 0 || errors.length === 0,
		text: lines.join("\n"),
		details: { forwarded, noops, errors },
	};
}

/** Side effects the foreground process supplies for canonical delivery. */
export interface EscalationHolderDeliveryDeps {
	/** Hops already delivered in this process; keyed per holder and trace depth. */
	delivered: Set<string>;
	/** Agent directory whose config decides `nativeEscalationUi`, read once per delivery. */
	agentDir: string;
	/** A native UI when a live interactive foreground exists. */
	ui: () => EscalationSurfaceUI | undefined;
	/** Prompt the operator natively for this one request. */
	promptUser: (ui: EscalationSurfaceUI) => Promise<DrainUserEscalationsReport>;
	/** Steer a live same-process mid-level holder; false when none is live. */
	steerMidLevel: (message: EscalationPendingMessage) => Promise<boolean>;
	/** Wake the root agent so it can use the originator tools. */
	wakeRoot: (message: EscalationPendingMessage) => void;
}

/**
 * Deliver a durable request to its current holder. Returns false only when
 * the wake hint should be kept for a retry.
 *
 * With `nativeEscalationUi: false` a host's operator surface owns user-held
 * answers. The request is then neither prompted natively nor handed to the
 * root agent: a root wake would give the agent its own way to ask the user
 * and resolve on their behalf, which competes with the host. That holds with
 * or without a native UI. The final user hop never auto-passes; the request
 * timeout still settles it. The hop is not recorded as delivered, so
 * re-enabling native prompts applies on the next scan.
 */
export async function deliverEscalationToHolder(
	request: EscalationRequest,
	message: EscalationPendingMessage,
	deps: EscalationHolderDeliveryDeps,
): Promise<boolean> {
	const holder = request.chain[request.holderIndex];
	if (!holder) return false;
	const hopKey = `${request.rootRunId}\u0000${request.requestId}\u0000${holder.id}\u0000${request.trace.length}`;
	if (deps.delivered.has(hopKey)) return true;
	if (holder.kind === "user") {
		if (loadConfigReadOnly(deps.agentDir).nativeEscalationUi === false) return true;
		// Native UI and agent mediation are adapters over the same mailbox
		// lease (§2.5). Prefer UI only while a live foreground UI exists.
		const ui = deps.ui();
		if (ui) {
			const report = await deps.promptUser(ui);
			if (report.busy.length > 0) return true;
			if (report.prompted.length > 0 || report.resolved.length > 0 || report.dismissed.length > 0) {
				deps.delivered.add(hopKey);
				return true;
			}
			return false;
		}
	}
	if (holder.kind === "supervisor" || holder.kind === "agent") {
		// Cross-process supervisor delivery remains a transport seam. Consume
		// only the hint (not durable state); maintenance retries the in-process
		// case and never misroutes a mid-level question to the root.
		if (await deps.steerMidLevel(message)) deps.delivered.add(hopKey);
		return true;
	}
	deps.wakeRoot(message);
	deps.delivered.add(hopKey);
	return true;
}

export interface EscalationSurfaceUI {
	select(title: string, options: string[]): Promise<string | string[] | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
}

export interface DrainUserEscalationsReport {
	prompted: string[];
	resolved: string[];
	dismissed: string[];
	busy: string[];
	skipped: string[];
	errors: Array<{ requestId: string; message: string }>;
}

/** Sequential native-UI adapter over the same invariant-4 lease. */
export async function drainUserEscalations(args: {
	agentDir: string;
	ui?: EscalationSurfaceUI;
	claimedBy: string;
	leaseMs?: number;
	rootRunId?: string;
	requestIds?: readonly string[];
	deps?: Partial<EscalationSurfaceDeps>;
}): Promise<DrainUserEscalationsReport> {
	const report: DrainUserEscalationsReport = {
		prompted: [], resolved: [], dismissed: [], busy: [], skipped: [], errors: [],
	};
	if (!args.ui) return report;
	const deps = depsFor(args.deps);
	const items = listHeldEscalations({
		agentDir: args.agentDir,
		rootRunId: args.rootRunId,
		requestIds: args.requestIds,
		deps: args.deps,
	}).filter((item) => item.holder.position === "user-held");
	for (const item of items) {
		const request = deps.readRequest(args.agentDir, item.rootRunId, item.requestId);
		if (!request || deps.readOutcome(args.agentDir, item.rootRunId, item.requestId)) {
			report.skipped.push(item.requestId);
			continue;
		}
		const holder = request.chain[request.holderIndex];
		if (!holder || holder.kind !== "user") {
			report.skipped.push(item.requestId);
			continue;
		}
		const credential = request.replyEndpoint.credential;
		let claimed = false;
		let leaseGuard: LeaseGuard | undefined;
		try {
			const leaseMs = args.leaseMs ?? DEFAULT_LEASE_MS;
			const claim = deps.claim({
				agentDir: args.agentDir,
				rootRunId: item.rootRunId,
				requestId: item.requestId,
				holderId: holder.id,
				claimedBy: args.claimedBy,
				leaseMs,
				now: deps.now(),
				credential,
			});
			if (!claim.claimed) {
				report.busy.push(item.requestId);
				continue;
			}
			claimed = true;
			leaseGuard = startLeaseGuard({
				agentDir: args.agentDir,
				rootRunId: item.rootRunId,
				requestId: item.requestId,
				holderId: holder.id,
				claimedBy: args.claimedBy,
				leaseMs,
				credential,
			}, deps);
			const choices = uiChoices(request);
			report.prompted.push(item.requestId);
			const answer = await awaitWithLease(
				args.ui.select(buildPrompt(request), [...choices.labels, DISMISS_LABEL]),
				leaseGuard,
			);
			leaseGuard.revalidate();
			if (answer === undefined || answer === DISMISS_LABEL || (Array.isArray(answer) && answer.includes(DISMISS_LABEL))) {
				report.dismissed.push(item.requestId);
				continue;
			}
			const selected = choices.selectionFor(answer);
			if (selected === undefined) {
				report.errors.push({ requestId: item.requestId, message: "UI returned an unknown escalation option" });
				continue;
			}
			const customIndex = request.resolutionOptions.findIndex(isCustomInstructionOption);
			let customInstruction: string | undefined;
			if (customIndex >= 0 && selected.includes(customIndex)) {
				customInstruction = (await awaitWithLease(
					args.ui.input(
						`${buildPrompt(request)}\n\nEnter the custom instruction (cancel to leave pending):`,
						"Custom instruction",
					),
					leaseGuard,
				))?.trim();
				leaseGuard.revalidate();
				if (!customInstruction) {
					report.dismissed.push(item.requestId);
					continue;
				}
			}
			// The final synchronous claim refreshes and revalidates ownership just
			// before the terminal write. Release remains owner-guarded in the store.
			leaseGuard.revalidate();
			const resolutionAt = deps.now();
			let wrote: ReturnType<typeof resolveEscalation>;
			if (args.deps?.resolve !== undefined) {
				wrote = deps.resolve({
					agentDir: args.agentDir,
					rootRunId: item.rootRunId,
					requestId: item.requestId,
					credential,
					resolution: {
						selected,
						...(customInstruction ? { customInstruction } : {}),
						resolvedBy: "user",
					},
					at: resolutionAt,
				});
			} else {
				try {
					wrote = resolveClaimedEscalation({
						agentDir: args.agentDir,
						rootRunId: item.rootRunId,
						requestId: item.requestId,
						holderId: holder.id,
						claimedBy: args.claimedBy,
						credential,
						resolution: {
							selected,
							...(customInstruction ? { customInstruction } : {}),
							resolvedBy: "user",
						},
						at: resolutionAt,
						now: resolutionAt,
					});
				} catch (error) {
					if (error instanceof EscalationLeaseLostError) throw new LeaseLostError();
					throw error;
				}
			}
			if (!wrote.duplicate) report.resolved.push(item.requestId);
			else report.skipped.push(item.requestId);
			deps.removeWake(args.agentDir, item.rootRunId, item.requestId);
		} catch (error) {
			if (error instanceof LeaseLostError) {
				report.skipped.push(item.requestId);
				report.errors.push({ requestId: item.requestId, message: error.message });
			} else {
				report.errors.push({ requestId: item.requestId, message: errorMessage(error) });
			}
		} finally {
			leaseGuard?.stop();
			if (claimed) {
				try {
					deps.release({
						agentDir: args.agentDir,
						rootRunId: item.rootRunId,
						requestId: item.requestId,
						holderId: holder.id,
						claimedBy: args.claimedBy,
						credential,
					});
				} catch {
					/* resolution removes the mailbox; dismissal releases it */
				}
			}
		}
	}
	return report;
}

export interface EscalationWakeDeliveryReport {
	delivered: string[];
	consumedTerminal: string[];
	skippedOwner: string[];
	deferred: string[];
	errors: Array<{ requestId: string; message: string }>;
}

/**
 * Owner-scoped escalation wake adapter (invariant 5).
 *
 * The stale hint's holder/kind are never used for routing: canonical state is
 * re-read after the atomic wake claim. `deliver` decides between native UI,
 * root-agent triggerTurn, and an in-process mid-level supervisor channel.
 */
export async function redeliverEscalationWakes(args: {
	agentDir: string;
	currentSessionId?: string;
	deliver: (request: EscalationRequest, message: EscalationPendingMessage) => boolean | Promise<boolean>;
	deps?: Partial<EscalationSurfaceDeps>;
	wakeIO?: {
		scan?: typeof scanPendingWakes;
		processNonce?: () => string;
		pidAlive?: (pid: number) => boolean;
		claim?: typeof claimPendingResult;
		consume?: typeof consumePendingResult;
		unclaim?: typeof unclaimPendingResult;
	};
}): Promise<EscalationWakeDeliveryReport> {
	const report: EscalationWakeDeliveryReport = {
		delivered: [], consumedTerminal: [], skippedOwner: [], deferred: [], errors: [],
	};
	const deps = depsFor(args.deps);
	const scan = args.wakeIO?.scan ?? scanPendingWakes;
	const nonce = (args.wakeIO?.processNonce ?? getProcessNonce)();
	const isPidAlive = args.wakeIO?.pidAlive ?? pidAlive;
	const claim = args.wakeIO?.claim ?? claimPendingResult;
	const consume = args.wakeIO?.consume ?? consumePendingResult;
	const unclaim = args.wakeIO?.unclaim ?? unclaimPendingResult;
	for (const pending of scan(args.agentDir)) {
		if (pending.record.kind !== "escalation-pending") continue;
		const record = pending.record as PendingEscalationWakeRecord;
		const ours = record.owningPid === process.pid && record.owningNonce === nonce;
		const ownerAlive = isPidAlive(record.owningPid);
		const sameSession = args.currentSessionId !== undefined && record.ownerSessionId === args.currentSessionId;
		const adoptable = args.currentSessionId !== undefined && args.currentSessionId.length > 0 && (ours || !ownerAlive);
		if ((!sameSession && !adoptable) || (!ours && ownerAlive)) {
			report.skippedOwner.push(record.payload.requestId);
			continue;
		}
		const claimed = claim(pending.file);
		if (!claimed) {
			report.deferred.push(record.payload.requestId);
			continue;
		}
		try {
			const request = deps.readRequest(
				args.agentDir,
				record.payload.rootRunId,
				record.payload.requestId,
			);
			if (!request || deps.readOutcome(args.agentDir, record.payload.rootRunId, record.payload.requestId)) {
				consume(claimed);
				report.consumedTerminal.push(record.payload.requestId);
				continue;
			}
			const holder = request.chain[request.holderIndex];
			if (!holder) {
				unclaim(claimed);
				report.deferred.push(request.requestId);
				continue;
			}
			const message = buildEscalationPendingMessage({
				rootRunId: request.rootRunId,
				requestId: request.requestId,
				holderId: holder.id,
				kind: request.kind,
			});
			if (!await args.deliver(request, message)) {
				unclaim(claimed);
				report.deferred.push(request.requestId);
				continue;
			}
			consume(claimed);
			report.delivered.push(request.requestId);
		} catch (error) {
			unclaim(claimed);
			report.errors.push({ requestId: record.payload.requestId, message: errorMessage(error) });
		}
	}
	return report;
}

export function formatHeldEscalations(items: readonly HeldEscalation[]): string {
	if (items.length === 0) return "No pending held escalations.";
	return items.map((item, index) => {
		const lines = [
			`${index + 1}. [${item.kind}] ${item.payloadSummary}`,
			`   requestId: ${item.requestId}`,
			`   rootRunId: ${item.rootRunId}`,
			`   holder: ${item.holder.label ?? item.holder.id} (${item.holder.kind}, ${item.holder.position})`,
			...item.resolutionOptions.map((option) => `   [${option.index}] ${option.label}`),
		];
		if (item.latestAnnotation?.context) lines.push(`   forwarded context: ${item.latestAnnotation.context}`);
		if (item.latestAnnotation?.recommendation) lines.push(`   recommendation: ${item.latestAnnotation.recommendation}`);
		return lines.join("\n");
	}).join("\n\n");
}

function locateRequest(
	agentDir: string,
	requestId: string,
	rootRunId: string | undefined,
	deps: EscalationSurfaceDeps,
): { request: EscalationRequest; rootRunId: string } | { error: EscalationSurfaceResult } {
	const id = requestId.trim();
	if (id === "") return { error: errorResult("Provide an escalation requestId.", "missing-requestId", {}) };
	const roots = rootRunId === undefined ? deps.listRoots(agentDir) : [rootRunId];
	const matches = roots.sort().flatMap((root) => {
		const request = deps.readRequest(agentDir, root, id);
		return request ? [{ request, rootRunId: root }] : [];
	});
	if (rootRunId === undefined && matches.length > 1) {
		return {
			error: errorResult(
				`Escalation request ${id} exists in multiple root runs; provide rootRunId.`,
				"ambiguous-rootRunId",
				{ requestId: id, rootRunIds: matches.map((match) => match.rootRunId).sort() },
			),
		};
	}
	if (matches.length === 0) {
		return {
			error: errorResult(
				`Escalation request ${id} was not found${rootRunId ? ` in rootRunId=${rootRunId}` : ""}.`,
				"not-found",
				{ requestId: id, rootRunId },
			),
		};
	}
	return matches[0]!;
}

function latestAnnotation(request: EscalationRequest): HeldEscalation["latestAnnotation"] {
	for (let index = request.trace.length - 1; index >= 0; index -= 1) {
		const entry = request.trace[index]!;
		if (entry.note !== undefined || entry.recommendation !== undefined) {
			return {
				...(entry.note !== undefined ? { context: entry.note } : {}),
				...(entry.recommendation !== undefined ? { recommendation: entry.recommendation } : {}),
			};
		}
	}
	return undefined;
}

export function summarizePayload(request: EscalationRequest): string {
	if (request.kind === "decision") {
		const payload = request.payload as DecisionEscalationPayload;
		return payload.body ? `${payload.header} — ${payload.body}` : payload.header;
	}
	if (request.kind === "blocker") {
		const payload = request.payload as BlockerEscalationPayload;
		return `${payload.cause}: ${payload.description}`;
	}
	const payload = request.payload as AmendmentEscalationPayload;
	return `${payload.target}: ${payload.change}`;
}

function buildPrompt(request: EscalationRequest): string {
	const lines = [`Delegate ${request.kind} escalation`, summarizePayload(request)];
	if (request.kind === "blocker") {
		const payload = request.payload as BlockerEscalationPayload;
		if (payload.unblock) lines.push(`Would unblock: ${payload.unblock}`);
	}
	if (request.kind === "amendment") {
		lines.push(`Rationale: ${(request.payload as AmendmentEscalationPayload).rationale}`);
	}
	const annotation = latestAnnotation(request);
	if (annotation?.context) lines.push(`Forwarded context: ${annotation.context}`);
	if (annotation?.recommendation) lines.push(`Recommendation: ${annotation.recommendation}`);
	if (request.kind === "decision") {
		const payload = request.payload as DecisionEscalationPayload;
		if (payload.recommended !== undefined) {
			lines.push(`Recommended: ${request.resolutionOptions[payload.recommended]?.label ?? payload.recommended}`);
		}
		if (payload.multi === true) lines.push("Choose one option combination.");
	}
	return lines.join("\n\n");
}

function uiChoices(request: EscalationRequest): {
	labels: string[];
	selectionFor(answer: string | string[]): number[] | undefined;
} {
	const decision = request.kind === "decision" ? request.payload as DecisionEscalationPayload : undefined;
	const customIndex = request.resolutionOptions.findIndex(isCustomInstructionOption);
	const hasCustom = customIndex >= 0;
	const customOption = hasCustom ? request.resolutionOptions[customIndex] : undefined;
	const optionEntries = request.resolutionOptions
		.map((option, index) => ({ index, label: option.label }))
		.filter((option) => option.index !== customIndex);
	const customLabel = customOption?.label;
	const customLabelCollides = customLabel !== undefined && optionEntries.some((option) => option.label === customLabel);
	const displayOptionEntries = optionEntries.map((option) => ({
		index: option.index,
		label: customLabelCollides && option.label === customLabel
			? `${option.label} (option ${option.index})`
			: option.label,
	}));
	const displayCustomLabel = customLabelCollides && customLabel !== undefined
		? `${customLabel} (custom instruction)`
		: customLabel;
	const optionLabels = displayOptionEntries.map((option) => option.label);
	const multi = decision?.multi === true;
	if (!multi) {
		return {
			labels: displayCustomLabel ? [...optionLabels, displayCustomLabel] : optionLabels,
			selectionFor: (answer) => {
				const first = Array.isArray(answer) ? answer[0] : answer;
				if (displayCustomLabel && first === displayCustomLabel) return [customIndex];
				const option = displayOptionEntries.find((entry) => entry.label === first);
				return option === undefined ? undefined : [option.index];
			},
		};
	}
	const subsets: Array<{ label: string; selected: number[] }> = [];
	for (let mask = 1; mask < 2 ** optionLabels.length; mask += 1) {
		const selected = optionEntries.map((_option, index) => index).filter((index) => (mask & (1 << index)) !== 0);
		const selectedIndexes = selected.map((index) => optionEntries[index]!.index);
		subsets.push({ label: selected.map((index) => optionLabels[index]).join(" + "), selected: selectedIndexes });
	}
	return {
		labels: [...subsets.map((subset) => subset.label), ...(displayCustomLabel ? [displayCustomLabel] : [])],
		selectionFor: (answer) => {
			if (Array.isArray(answer)) {
				if (displayCustomLabel && answer.includes(displayCustomLabel)) {
					return [customIndex];
				}
				const selected = answer
					.map((label) => displayOptionEntries.find((entry) => entry.label === label)?.index)
					.filter((index): index is number => index !== undefined);
				return selected.length > 0 ? [...new Set(selected)] : undefined;
			}
			if (displayCustomLabel && answer === displayCustomLabel) return [customIndex];
			return subsets.find((subset) => subset.label === answer)?.selected;
		},
	};
}

function terminalSurfaceResult(
	action: string,
	rootRunId: string,
	requestId: string,
	outcome: EscalationOutcome,
): EscalationSurfaceResult {
	return {
		ok: true,
		text: `Escalation ${requestId} is already terminal (${outcome.status}); ${action} was not repeated.`,
		details: { rootRunId, requestId, terminal: true, outcome },
	};
}

function errorResult(
	text: string,
	reason: string,
	details: Record<string, unknown>,
): EscalationSurfaceResult {
	return { ok: false, text, details: { ...details, reason } };
}

function readOwnedRequestFiles(agentDir: string, rootRunId: string): EscalationRequest[] {
	let files: string[];
	try {
		files = fs.readdirSync(resolveEscalationRequestsDir(agentDir, rootRunId))
			.filter((name) => name.endsWith(".json"))
			.sort();
	} catch {
		return [];
	}
	const requests: EscalationRequest[] = [];
	for (const name of files) {
		try {
			const value = JSON.parse(
				fs.readFileSync(path.join(resolveEscalationRequestsDir(agentDir, rootRunId), name), "utf8"),
			) as unknown;
			if (isOwnedRequest(value, rootRunId)) requests.push(value);
		} catch {
			/* malformed owner files are ignored, matching store list semantics */
		}
	}
	return requests;
}

function isOwnedRequest(value: unknown, rootRunId: string): value is EscalationRequest {
	if (!isRecord(value)) return false;
	if (
		typeof value.requestId !== "string" ||
		!isSafeStem(value.requestId) ||
		value.rootRunId !== rootRunId ||
		!["decision", "blocker", "amendment"].includes(String(value.kind)) ||
		!isRecord(value.payload) ||
		!Array.isArray(value.chain) ||
		!Number.isInteger(value.holderIndex) ||
		(value.holderIndex as number) < 0 ||
		(value.holderIndex as number) >= value.chain.length ||
		!Array.isArray(value.resolutionOptions) ||
		value.resolutionOptions.some((option) => !isRecord(option) || typeof option.label !== "string") ||
		!Array.isArray(value.trace) ||
		typeof value.raisedAt !== "string" ||
		!isRecord(value.replyEndpoint) ||
		!isRecord(value.replyEndpoint.credential)
	) return false;
	if (value.kind === "decision" && typeof value.payload.header !== "string") return false;
	if (value.kind === "blocker" && (typeof value.payload.cause !== "string" || typeof value.payload.description !== "string")) return false;
	if (value.kind === "amendment" && (typeof value.payload.target !== "string" || typeof value.payload.change !== "string")) return false;
	const holder = value.chain[value.holderIndex as number] as unknown;
	return isRecord(holder) && typeof holder.id === "string" && typeof holder.kind === "string";
}

function isOwnedOutcome(value: unknown, requestId: string): value is EscalationOutcome {
	return isRecord(value) &&
		value.requestId === requestId &&
		(value.outcomeVersion === undefined || value.outcomeVersion === ESCALATION_OUTCOME_VERSION) &&
		["resolved", "timeout", "cancelled"].includes(String(value.status)) &&
		typeof value.at === "string";
}

function cloneDefaultConfig(): ResolvedEscalationConfig {
	return {
		...DEFAULT_ESCALATION_CONFIG,
		authority: { ...DEFAULT_ESCALATION_CONFIG.authority, tags: [...DEFAULT_ESCALATION_CONFIG.authority.tags] },
		timeoutMs: { ...DEFAULT_ESCALATION_CONFIG.timeoutMs },
		timeoutBehavior: { ...DEFAULT_ESCALATION_CONFIG.timeoutBehavior },
	};
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function isSafeStem(value: string): boolean {
	return value !== "" && value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
