import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveFoldConfig, type FoldEngine } from "../folds/fold-engine.js";
import { configuredFoldFingerprint } from "./fingerprint.js";
import { budgetDiff, estimateBytes, ParityBudget, processParityBudget, shareLease, type BudgetLimit, type FoldParityLimits, type Lease, type ParityRetention, type ParityTask } from "./budget.js";
import { compareBatchRequestWithMemory, compareCompressCall, hashRequestMessages, MAX_BRANCH_ENTRIES, previewShadowTurnMemory, shortHash, type BatchCall, type BatchComparison, type PreviewInput, type PreviewTurn, type ShadowCall } from "./compare.js";
import { cloneFoldTurnMemory, createFoldTurnMemory, type FoldTurnMemory } from "../folds/fold-turn.js";
import { defaultCountTokens } from "../folds/kernel/index.js";
import { bcpOutcome, classifyBcpResult, rejectedUnknownRef, type ObservedResult } from "./outcome.js";
import { isRefusalOutcome, PARITY_RECORD_VERSION, verdictFor, type CompressRecord, type NextRequestRecord, type ParityDiff, type ParityRecord, type RefusalOutcome } from "./records.js";
import { registerFoldParityCommand } from "./report.js";
import { snapshotSideFile, type SideSnapshot } from "./side-file.js";

export { ParityBudget } from "./budget.js";
export type { FoldParityLimits, ParityRetention } from "./budget.js";

interface CallIdentity {
	readonly fingerprint: string;
	readonly toolCallId: string;
	readonly at: string;
	readonly nested: boolean;
	readonly parentToolCallId?: string;
}
/**
 * A started call that holds a branch snapshot for its own comparison. Its input and pre-state have
 * two owners, the call comparison and the next-request preview; each holds one share of their lease.
 */
interface FullCall extends CallIdentity {
	readonly kind: "full";
	readonly snapshot: PreviewInput;
	readonly snapshotLease: Lease;
	readonly evidence: ShadowCall;
	readonly compareLease: Lease;
	readonly previewLease: Lease;
	/** Outstanding-work reservation, carried into the comparison job. */
	readonly work: Lease;
}
/** A started call that cannot be compared; it holds no conversation content. */
interface SlimCall extends CallIdentity {
	readonly kind: "slim";
	readonly diff: ParityDiff;
}
interface WaitingCall extends CallIdentity {
	evidence?: ShadowCall;
	evidenceLease?: Lease;
	/** billion-context-pi refused the call with an ending only it has; the counterfactual preview omits it. */
	readonly refusal?: RefusalOutcome;
}
interface SessionState {
	readonly pending: Map<string, FullCall | SlimCall>;
	/** Shadow replay state only; live mode never reads or mutates it. */
	turnMemory: FoldTurnMemory | undefined;
	readonly waiting: WaitingCall[];
	/** Reasons the next-request preview for the current batch cannot be valid. */
	readonly batchDiffs: ParityDiff[];
	/** Calls started while the call bound was full; their results are recorded without identities. */
	untracked: number;
}
export interface FoldParityOptions {
	readonly engine: Pick<FoldEngine, "mode"> & Partial<Pick<FoldEngine, "snapshotTurnMemory">>;
	readonly agentDir: string;
	readonly fingerprint: string;
	readonly now?: () => Date;
	/** Private bounds for this recorder alone (tests, embedders). Without `limits` or `budget`, the process-wide budget applies. */
	readonly limits?: FoldParityLimits;
	/** A budget shared with other recorders. Takes precedence over `limits`. */
	readonly budget?: ParityBudget;
}
export interface FoldParityRecorder {
	/** Resolves when every queued diagnostics job in this recorder's budget has been written. */
	flush(): Promise<void>;
	/** Current retention, for bounds checks and diagnostics. `calls` is this recorder's; the rest is the budget's. */
	retained(): ParityRetention;
}

const MAX_BATCH_DIFFS = 10;
const CANCELLED: ParityDiff = { kind: "recorder-error", reason: "session ended before the comparison ran" };
const RECORDER_ERROR: ParityDiff = { kind: "recorder-error", reason: "shadow recorder failed" };
const REPLAY_UNKNOWN: ParityDiff = { kind: "recorder-error", reason: "hypothetical live turn memory is unknown" };
const releaseWaiting = (calls: readonly WaitingCall[]) => {
	for (const call of calls) { call.evidenceLease?.release(); delete call.evidence; delete call.evidenceLease; }
};

/**
 * Build a comparison task in its own scope, so the job closes over exactly the content it charges for.
 * `release` drops that content; the writer calls it once the record is produced or cancelled.
 */
function comparisonTask(content: { snapshot: PreviewInput; evidence: ShadowCall; after: SideSnapshot }, leases: readonly Lease[], records: {
	readonly compared: (compared: ReturnType<typeof compareCompressCall>) => CompressRecord;
	readonly failed: () => ParityRecord;
	readonly cancelled: () => ParityRecord;
}, observed: ObservedResult): ParityTask {
	let held: typeof content | undefined = content;
	return {
		run: () => {
			if (!held) throw new Error("comparison content released");
			return records.compared(compareCompressCall({ ...held.snapshot, toolCallId: held.evidence.toolCallId, input: held.evidence.input, before: held.evidence.before, after: held.after, observed }));
		},
		failed: records.failed,
		cancelled: records.cancelled,
		release: () => { held = undefined; for (const lease of leases) lease.release(); },
	};
}
function previewTask(comparison: BatchComparison, leases: readonly Lease[], records: {
	readonly previewed: (compared: BatchComparison) => NextRequestRecord;
	readonly failed: () => ParityRecord;
	readonly cancelled: () => ParityRecord;
}): ParityTask {
	let held: BatchComparison | undefined = comparison;
	return {
		run: () => { if (!held) throw new Error("preview result released"); return records.previewed(held); },
		failed: records.failed,
		cancelled: records.cancelled,
		release: () => { held = undefined; for (const lease of leases) lease.release(); },
	};
}

/** What the live per-turn pass would read from this request's context: model limits, prompt size, host usage. */
function previewTurn(ctx: ExtensionContext): PreviewTurn {
	const usage = ctx.getContextUsage?.();
	return {
		...(ctx.model?.maxTokens ? { maxOutputTokens: ctx.model.maxTokens } : {}),
		...(ctx.model?.api ? { api: ctx.model.api } : {}),
		vision: Array.isArray(ctx.model?.input) && ctx.model.input.includes("image"),
		systemPromptTokens: defaultCountTokens(ctx.getSystemPrompt?.() ?? ""),
		...(typeof usage?.tokens === "number" ? { hostTokens: usage.tokens } : {}),
	};
}

/**
 * Observe only. No tool registrations, returned transforms, or persisted session writes.
 * Memory and outstanding work are bounded before anything is cloned: over a bound, a call keeps only
 * its identity and its comparison is recorded as inconclusive. Content is released when its last owner
 * finishes; a session reset cancels queued comparisons and drops their content at once.
 */
export function registerFoldParityRecorder(pi: ExtensionAPI, options: FoldParityOptions): FoldParityRecorder {
	const budget = options.budget ?? (options.limits ? new ParityBudget(options.limits) : processParityBudget());
	const limits = budget.limits;
	const states = new Map<string, SessionState>();
	const fingerprints = new Map<string, string>();
	const fingerprintFor = (ctx: ExtensionContext) => configuredFoldFingerprint(options.fingerprint, resolveFoldConfig(ctx, options.agentDir));
	const now = () => (options.now?.() ?? new Date()).toISOString();
	const stateFor = (id: string, ctx?: ExtensionContext) => {
		let state = states.get(id);
		if (!state) {
			let turnMemory: FoldTurnMemory | undefined = createFoldTurnMemory();
			try { if (ctx && options.engine.snapshotTurnMemory) turnMemory = options.engine.snapshotTurnMemory(ctx); } catch { turnMemory = undefined; }
			state = { pending: new Map(), turnMemory, waiting: [], batchDiffs: [], untracked: 0 };
			states.set(id, state);
		}
		return state;
	};
	const callCount = () => { let count = 0; for (const state of states.values()) count += state.pending.size + state.waiting.length; return count; };
	const base = (sessionId: string) => ({ v: PARITY_RECORD_VERSION, fingerprint: fingerprints.get(sessionId) ?? options.fingerprint, sessionId, at: now() });
	const failureRecord = (sessionId: string, toolCallId: string, nested: boolean, toolCallIds?: readonly string[]): ParityRecord => {
		const error = { ...base(sessionId), verdict: "inconclusive" as const, diffs: [RECORDER_ERROR] };
		return toolCallIds ? { ...error, kind: "next-request", toolCallIds } : { ...error, kind: "compress", toolCallId, nested };
	};
	const marker = (sessionId: string) => (toolCallId: string, dropped: number): ParityRecord => ({ ...base(sessionId), kind: "compress", toolCallId, nested: false, verdict: "inconclusive", diffs: [budgetDiff("queue", `${dropped} records dropped`)] });
	/** Queue a small record under an existing reservation, or reserve one; a full queue counts it as dropped. */
	const record = (state: SessionState, sessionId: string, item: ParityRecord, reserved?: Lease) => {
		const work = reserved ?? budget.reserve();
		if (!work) return budget.drop({ agentDir: options.agentDir, sessionId, marker: marker(sessionId) });
		budget.enqueue({ owner: state, agentDir: options.agentDir, sessionId, work, task: item });
	};
	const flush = () => budget.idle();
	const releaseFull = (call: FullCall) => { call.snapshotLease.release(); call.compareLease.release(); call.previewLease.release(); call.work.release(); };
	/** A batch with an unusable call cannot be previewed; drop the preview's share of its evidence now. */
	const spoilBatch = (state: SessionState, diff: ParityDiff) => {
		if (state.batchDiffs.length < MAX_BATCH_DIFFS && !state.batchDiffs.some((seen) => seen.kind === diff.kind && seen.reason === diff.reason)) state.batchDiffs.push(diff);
		releaseWaiting(state.waiting);
	};
	const safeShadow = (ctx: ExtensionContext) => {
		try { return options.engine.mode(ctx) === "shadow"; } catch { return false; }
	};
	/** Check every count bound before cloning; returns the limit that would be exceeded. */
	const snapshotBlocked = (): BudgetLimit | undefined => budget.snapshotsFull ? "snapshots" : budget.workFull ? "queue" : undefined;
	const bytesDiff = (estimate: number) => budgetDiff("bytes", Number.isFinite(estimate) ? undefined : "value cannot be sized before copying");
	const clear = (_event: unknown, ctx: ExtensionContext) => {
		try {
			const id = ctx.sessionManager.getSessionId();
			const state = states.get(id);
			if (!state) return;
			for (const call of state.pending.values()) if (call.kind === "full") releaseFull(call);
			releaseWaiting(state.waiting);
			// Queued comparisons become small cancellation records; running ones keep their leases until done.
			budget.cancel(state);
			// Queued jobs keep their owner as a cancellation key; it must not keep any content alive.
			state.pending.clear();
			state.waiting.length = 0;
			state.batchDiffs.length = 0;
			states.delete(id);
			fingerprints.delete(id);
		} catch { /* observe only */ }
	};
	pi.on("session_start", clear);
	pi.on("session_shutdown", clear);
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "compress" || !safeShadow(ctx)) return;
		let id = "unknown";
		const nested = Boolean(event.parentToolCallId) || event.toolCallId.startsWith("fabric_");
		try {
			id = ctx.sessionManager.getSessionId();
			const state = stateFor(id, ctx);
			if (callCount() >= limits.maxCalls) { state.untracked++; return; }
			const folds = resolveFoldConfig(ctx, options.agentDir);
			const fingerprint = configuredFoldFingerprint(options.fingerprint, folds);
			fingerprints.set(id, fingerprint);
			const identity: CallIdentity = { fingerprint, toolCallId: event.toolCallId, at: now(), nested, ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}) };
			const slim = (diff: ParityDiff) => { state.pending.set(event.toolCallId, { ...identity, kind: "slim", diff }); };
			const branch = ctx.sessionManager.getBranch();
			if (branch.length > MAX_BRANCH_ENTRIES) return slim({ kind: "too-large", reason: "branch exceeds 50,000 entries" });
			const blocked = snapshotBlocked();
			if (blocked) return slim(budgetDiff(blocked));
			const before: SideSnapshot = snapshotSideFile(ctx.sessionManager.getSessionFile());
			if (!before.ok) return slim(before.diff);
			const header = ctx.sessionManager.getHeader();
			const evidenceBytes = estimateBytes([event.input, before], budget.remainingBytes);
			const snapshotBytes = estimateBytes([header, branch], budget.remainingBytes - evidenceBytes);
			if (!(evidenceBytes + snapshotBytes <= budget.remainingBytes)) return slim(bytesDiff(evidenceBytes + snapshotBytes));
			const work = budget.reserve();
			if (!work) return slim(budgetDiff("queue"));
			let snapshot: PreviewInput, input: unknown;
			try {
				snapshot = { sessionId: id, cwd: ctx.cwd, header: structuredClone(header), branch: structuredClone(branch), contextWindow: ctx.model?.contextWindow ?? 200_000, folds };
				input = structuredClone(event.input);
			} catch (error) { work.release(); throw error; }
			const [compareLease, previewLease] = shareLease(budget.lease(evidenceBytes, false), 2) as [Lease, Lease];
			state.pending.set(event.toolCallId, { ...identity, kind: "full", snapshot, snapshotLease: budget.lease(snapshotBytes, true), evidence: { toolCallId: event.toolCallId, input, before }, compareLease, previewLease, work });
		} catch {
			const state = stateFor(id);
			spoilBatch(state, RECORDER_ERROR);
			record(state, id, failureRecord(id, event.toolCallId, nested));
		}
	});
	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "compress" || !safeShadow(ctx)) return;
		let id = "unknown";
		try {
			id = ctx.sessionManager.getSessionId();
			const state = states.get(id);
			if (!state) return;
			const call = state.pending.get(event.toolCallId);
			const isError = event.isError;
			const text = event.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
			const resultHash = shortHash(text.slice(0, 200));
			// Classify before hashing; only the typed category is kept, never the text.
			const observed = classifyBcpResult(text, isError);
			const observedOutcome = bcpOutcome(observed, observed.kind === "panel" ? observed.blocks : 0);
			const nested = Boolean(event.parentToolCallId) || event.toolCallId.startsWith("fabric_");
			if (!call) {
				if (state.untracked <= 0) return;
				state.untracked--;
				const diff = budgetDiff("calls");
				spoilBatch(state, diff);
				record(state, id, { ...base(id), kind: "compress", toolCallId: event.toolCallId, ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}), nested, awaitingNextRequest: true, verdict: "inconclusive", diffs: [diff], isError, resultHash, bcpOutcome: observedOutcome });
				return;
			}
			state.pending.delete(event.toolCallId);
			const after = snapshotSideFile(ctx.sessionManager.getSessionFile());
			const identity: CallIdentity = { fingerprint: call.fingerprint, toolCallId: call.toolCallId, at: call.at, nested: call.nested, ...(call.parentToolCallId ? { parentToolCallId: call.parentToolCallId } : {}) };
			const recordBase = { ...base(id), fingerprint: call.fingerprint, at: call.at, kind: "compress" as const, toolCallId: call.toolCallId, ...(call.parentToolCallId ? { parentToolCallId: call.parentToolCallId } : {}), nested: call.nested, awaitingNextRequest: true };
			if (call.kind === "slim") {
				const diffs = [call.diff, ...(after.ok ? [] : [after.diff])];
				spoilBatch(state, call.diff);
				state.waiting.push(identity);
				record(state, id, { ...recordBase, verdict: verdictFor(diffs), diffs, isError, resultHash, bcpOutcome: observedOutcome, ...(after.ok && after.producer ? { producer: after.producer } : {}) });
				return;
			}
			// Queue the identity synchronously: the context event can precede the deferred comparison.
			// The next-request preview judges a ref unknown to both engines the same way the call comparison does.
			const evidence: ShadowCall = rejectedUnknownRef(observed) ? { ...call.evidence, bcpUnknownRef: true } : call.evidence;
			const waiting: WaitingCall = { ...identity, evidence, evidenceLease: call.previewLease, ...(isRefusalOutcome(observedOutcome.type) ? { refusal: observedOutcome.type } : {}) };
			state.waiting.push(waiting);
			if (state.batchDiffs.length) releaseWaiting([waiting]);
			const afterBytes = estimateBytes(after, budget.remainingBytes);
			if (!(afterBytes <= budget.remainingBytes)) {
				call.snapshotLease.release();
				call.compareLease.release();
				const diffs = [bytesDiff(afterBytes)];
				record(state, id, { ...recordBase, verdict: verdictFor(diffs), diffs, isError, resultHash, bcpOutcome: observedOutcome }, call.work);
				return;
			}
			const producer = after.ok && after.producer ? { producer: after.producer } : {};
			const task = comparisonTask({ snapshot: call.snapshot, evidence: call.evidence, after }, [call.snapshotLease, call.compareLease, budget.lease(afterBytes, false)], {
				compared: (compared) => ({ ...recordBase, ...compared, isError, resultHash, ...producer }),
				failed: () => failureRecord(id, recordBase.toolCallId, recordBase.nested),
				cancelled: () => ({ ...recordBase, verdict: "inconclusive", diffs: [CANCELLED], isError, resultHash, bcpOutcome: observedOutcome }),
			}, observed);
			budget.enqueue({ owner: state, agentDir: options.agentDir, sessionId: id, work: call.work, task });
		} catch {
			const state = stateFor(id);
			spoilBatch(state, RECORDER_ERROR);
			record(state, id, failureRecord(id, event.toolCallId, Boolean(event.parentToolCallId)));
		}
	});
	pi.on("context", (event, ctx) => {
		if (!safeShadow(ctx)) return;
		let id = "unknown";
		let calls: WaitingCall[] = [];
		let state: SessionState | undefined;
		try {
			id = ctx.sessionManager.getSessionId();
			state = stateFor(id, ctx);
			const owner = state;
			calls = state.waiting.splice(0).sort((a, b) => a.at.localeCompare(b.at));
			const batchDiffs = state.batchDiffs.splice(0);
			const folds = resolveFoldConfig(ctx, options.agentDir);
			fingerprints.set(id, configuredFoldFingerprint(options.fingerprint, folds));
			if (!calls.length) {
				if (!state.turnMemory) return;
				const branch = ctx.sessionManager.getBranch();
				const header = ctx.sessionManager.getHeader();
				const before = snapshotSideFile(ctx.sessionManager.getSessionFile());
				const bytes = estimateBytes([header, branch, before], limits.maxRetainedBytes);
				if (branch.length > MAX_BRANCH_ENTRIES || !before.ok || !(bytes <= limits.maxRetainedBytes)) { state.turnMemory = undefined; return; }
				const snapshot: PreviewInput = { sessionId: id, cwd: ctx.cwd, header: structuredClone(header), branch: structuredClone(branch), contextWindow: ctx.model?.contextWindow ?? 200_000, folds, turn: previewTurn(ctx), turnMemory: cloneFoldTurnMemory(state.turnMemory) };
				state.turnMemory = previewShadowTurnMemory(snapshot, before);
				return;
			}
			const toolCallIds = calls.map((call) => call.toolCallId);
			const bcp = hashRequestMessages(event.messages);
			const at = now();
			const requestBase = { ...base(id), at };
			const inconclusive = (diffs: readonly ParityDiff[]) => {
				owner.turnMemory = undefined;
				releaseWaiting(calls);
				const all = [...diffs, ...(bcp.tagsSeen ? [] : [{ kind: "tags-absent" as const }])];
				record(owner, id, { ...base(id), at, kind: "next-request", toolCallIds, bcp, verdict: verdictFor(all), diffs: all });
			};
			if (batchDiffs.length) return inconclusive(batchDiffs);
			if (!state.turnMemory) return inconclusive([REPLAY_UNKNOWN]);
			const blocked = snapshotBlocked();
			if (blocked) return inconclusive([budgetDiff(blocked)]);
			const branch = ctx.sessionManager.getBranch();
			if (branch.length > MAX_BRANCH_ENTRIES) return inconclusive([{ kind: "too-large", reason: "branch exceeds 50,000 entries" }]);
			const header = ctx.sessionManager.getHeader();
			const bytes = estimateBytes([header, branch], budget.remainingBytes);
			if (!(bytes <= budget.remainingBytes)) return inconclusive([bytesDiff(bytes)]);
			const work = budget.reserve();
			if (!work) return inconclusive([budgetDiff("queue")]);
			let snapshot: PreviewInput;
			try {
				snapshot = { sessionId: id, cwd: ctx.cwd, header: structuredClone(header), branch: structuredClone(branch), contextWindow: ctx.model?.contextWindow ?? 200_000, folds, turn: previewTurn(ctx) };
			} catch (error) { work.release(); throw error; }
			const shadowCalls: BatchCall[] = calls.map((call) => ({
				...(call.evidence ?? { toolCallId: call.toolCallId, input: undefined, before: { ok: false, diff: { kind: "recorder-error", reason: "call evidence released" } } }),
				...(call.refusal ? { refusal: call.refusal } : {}),
			}));
			let previewed: ReturnType<typeof compareBatchRequestWithMemory>;
			try {
				previewed = compareBatchRequestWithMemory({ ...snapshot, turnMemory: cloneFoldTurnMemory(state.turnMemory) }, shadowCalls, bcp);
			} catch (error) { work.release(); throw error; }
			if (!previewed.turnMemoryKnown) { work.release(); return inconclusive([REPLAY_UNKNOWN]); }
			state.turnMemory = previewed.turnMemory;
			// The queued writer owns only the completed comparison and the evidence leases; replay already advanced synchronously.
			const leases = [budget.lease(bytes, true), ...calls.flatMap((call) => call.evidenceLease ? [call.evidenceLease] : [])];
			for (const call of calls) { delete call.evidence; delete call.evidenceLease; }
			const task = previewTask(previewed.comparison, leases, {
				previewed: (compared) => ({ ...requestBase, kind: "next-request", toolCallIds, bcp, ...compared }),
				failed: () => failureRecord(id, "next-request", false, toolCallIds),
				cancelled: () => ({ ...requestBase, kind: "next-request", toolCallIds, bcp, verdict: "inconclusive", diffs: [CANCELLED] }),
			});
			budget.enqueue({ owner, agentDir: options.agentDir, sessionId: id, work, task });
		} catch {
			releaseWaiting(calls);
			const target = state ?? stateFor(id);
			target.turnMemory = undefined;
			if (calls.length) record(target, id, failureRecord(id, "next-request", false, calls.map((call) => call.toolCallId)));
		}
	});
	registerFoldParityCommand(pi, { agentDir: options.agentDir, fingerprint: fingerprintFor, build: (ctx) => ({ engine: options.fingerprint, folds: resolveFoldConfig(ctx, options.agentDir) }), flush });
	return {
		flush,
		retained: () => ({ bytes: budget.bytes, snapshots: budget.snapshots, calls: callCount(), queued: budget.work }),
	};
}
