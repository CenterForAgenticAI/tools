/**
 * Boundary runtime for native folds.
 *
 * Fold requests are planned when they arrive, so a caller gets the engine's
 * errors and the valid refs at once. Pi accepts new session entries only from
 * `turn_end` and `agent_before_settle`, so accepted requests wait in a queue
 * and are planned again, against the branch at that moment, when one of those
 * events fires.
 *
 * While billion-context-pi is loaded the runtime is in shadow mode: it plans,
 * but queues nothing and returns no entries, so the session file is not
 * changed. This module registers no tools.
 *
 * In live mode a `context` handler runs billion-context-pi's per-turn pass on
 * the request (fold-turn.ts, pi-context-aware#201): ref tags, hidden absorbed
 * fold calls and the nudge. It also shows each earlier fold tool call with a
 * block pointer in place of the summary its fold already carries (see
 * fold-call-render.ts). The session file keeps the call as the model wrote it.
 *
 * The invariant: a fold is written only (a) to the branch it was accepted on,
 * and (b) over exactly the source it was accepted over: the same covered entry
 * ids and the same content for any fold those entries already belong to. Live
 * and recovered requests take the same check (`replanAcceptedFold` in
 * fold-recovery.ts); there is no second path.
 *
 * A request may carry an id, `<fold tool call id>#<item index>`. The fold
 * written for it records that id. A request whose id is already queued, already
 * written, or saved as a record on the branch is a replay (a durable worker ran
 * the tool call again). It never plans a second, different fold: when it would
 * cover the same entries over the same source, it gets the existing result and
 * nothing new is queued; otherwise it fails with `coverage-changed` or
 * `source-changed`.
 *
 * Restart recovery: when a live request with an id is accepted, the result
 * carries a `recovery` record. The fold tool saves it in its tool result
 * `details`. At `session_start` and after every tree navigation
 * (`session_tree`) the in-memory queue is discarded and rebuilt from the
 * records on the branch that is now current. See fold-recovery.ts.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { DEFAULT_FOLDS_CONFIG, readConfigLayer, readPolicyEntryLayers, resolveConfigLayers, type FoldsConfig } from "../platform/config-layers.js";
import {
	getAgentDir,
	SessionManager,
	type ExtensionAPI,
	type CustomMessageEntryDraft,
	type ExtensionContext,
	type SessionBoundaryDraft,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";

import type { RegisteredToolView } from "../compaction/compaction-blocker.js";
import {
	engineOverrideContradictsPresence,
	foldModeForEngine,
	resolveContextEngine,
	type ContextEngine,
	type ContextEngineOverride,
} from "./engine-resolver.js";
import { foldStateFromBranch, planFold, summaryLimitOf, validFoldRefs, type FoldCondenser } from "./fold-adapter.js";
import { FOLD_NOTICE_TYPE, type FoldHintView } from "./fold-hints.js";
import { renderEarlierFoldCalls } from "./fold-call-render.js";
import type { PressureLadderConfig } from "../policy/context-policy.js";
import { cloneFoldTurnMemory, createFoldTurnMemory, prepareFoldTurn, type FoldEmergency, type FoldTurnMemory, type FoldTurnResult } from "./fold-turn.js";
import { planHides } from "./hide-entries.js";
import {
	checkFoldRequestId,
	foldRecordsOnBranch,
	foldRequestIdsOnBranch,
	stampRequestId,
} from "./fold-entries.js";
import {
	MAX_RECOVERY_COVERED_IDS_PER_RECORD,
	MAX_REQUEST_REF_LENGTH,
	acceptedFoldOf,
	acceptedSourceOf,
	buildFoldRequestRecovery,
	compareFoldSources,
	findFoldRequestRecord,
	queuedRequestId,
	replanAcceptedFold,
	scanFoldRequests,
	type FoldDropCode,
	type FoldRequestRecovery,
	type RecoveredFoldRequest,
	type SourceDifference,
	type QueuedFold,
	type QueuedFoldRequest,
	type RecoveryDrop,
} from "./fold-recovery.js";
import { defaultCountTokens, type Config } from "./kernel/index.js";

/** A fold request, optionally with the id that makes writing it idempotent. */
export type FoldRequest = Omit<QueuedFoldRequest, "accepted">;

/** Resolve the fold-only leaves locally: the extension's root resolver is private.
 * No fold CLI flags exist. Files are re-read; session/host values follow the current branch.
 */
export function resolveFoldConfig(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">, agentDir = getAgentDir()): FoldsConfig {
	const read = (file: string) => {
		try { return JSON.parse(readFileSync(file, "utf8")) as unknown; } catch { return undefined; }
	};
	let root = ctx.cwd;
	try { root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd, encoding: "utf8", timeout: 1_000, stdio: ["ignore", "pipe", "ignore"] }).trim() || root; } catch { /* Non-Git projects use cwd. */ }
	return resolveConfigLayers([
		readConfigLayer(read(path.join(agentDir, "context-aware.json")), "global"),
		readConfigLayer(read(path.join(root, ".pi", "context-aware.json")), "project"),
		...readPolicyEntryLayers(ctx.sessionManager.getBranch()),
	]).config.folds ?? DEFAULT_FOLDS_CONFIG;
}

export type FoldMode = "live" | "shadow";

/** Shadow while billion-context-pi owns context management; live otherwise. */
export function foldModeFor(tools: readonly RegisteredToolView[], override: ContextEngineOverride = "auto"): FoldMode {
	return foldModeForEngine(resolveContextEngine({ tools, override }));
}

/** What `context_status` reports about the engine. */
export interface EngineReport {
	readonly engine: ContextEngine;
	/** The override forces `folds` while billion-context-pi is loaded. */
	readonly contradictsPresence: boolean;
}

/** A request the engine refused. `code` is set when the refusal is not a planner error. */
export interface FoldRequestFailure {
	readonly ok: false;
	readonly errors: string[];
	readonly validRefs: string[];
	/**
	 * `coverage-changed` / `source-changed`: a replay of an accepted request id that
	 * would cover other entries, or other content, than the request accepted
	 * first. `too-large`: the request covers more entries than a recovery record may name.
	 */
	readonly code?: "coverage-changed" | "source-changed" | "too-large";
}

export type FoldRequestResult =
	| FoldRequestFailure
	| {
		readonly ok: true;
		readonly mode: FoldMode;
		readonly queued: boolean;
		readonly blockIds: string[];
		readonly warnings: string[];
		/** True when this request id was already accepted; nothing new was planned or queued. */
		readonly replayed?: true;
		/**
		 * Present when a live request with an id was queued, and again on a replay
		 * of a request that is still queued. The fold tool must save it in its tool
		 * result `details` (see `foldRequestDetails`), or a restart before the drain
		 * loses the fold. Absent in shadow mode, for a request without an id, and
		 * for a request whose fold is already written.
		 */
		readonly recovery?: FoldRequestRecovery;
	};

export interface FoldEngineOptions {
	/** Engine settings that differ from its defaults. */
	readonly config?: Partial<Config>;
	/** Context window used for the engine's limits when the model does not report one. */
	readonly fallbackContextWindow?: number;
	/**
	 * Condensed skill swaps (pi-context-aware#181). Returns the condenser
	 * for a branch, or `undefined` when the feature is off or nothing condenses.
	 */
	readonly condenser?: (ctx: ExtensionContext, branch: readonly SessionEntry[]) => FoldCondenser | undefined;
	/**
	 * The pressure ladder in force for this session. The per-turn pass takes its nudge,
	 * emergency-nudge and truncation thresholds from it (pi-context-aware#244). Without it the
	 * starting ladder applies.
	 */
	readonly ladder?: (ctx: ExtensionContext) => PressureLadderConfig;
	/** Called on every request at or above the ladder's last step, with what emergency truncation did. */
	readonly onEmergency?: (ctx: ExtensionContext, emergency: FoldEmergency) => void;
	/** Fold hints for this session (pi-context-aware#281). Every plan of one request reads the same view. */
	readonly hints?: (ctx: ExtensionContext) => FoldHintView | undefined;
	/** Observers for the per-turn metrics log (pi-context-aware#286). They only read; a throw never changes a request. */
	readonly metrics?: FoldEngineMetrics;
}

/** What the engine reports to the per-turn metrics recorder. */
export interface FoldEngineMetrics {
	/** Once per live model request, with the pass result; undefined when the pass failed or did not line up. */
	readonly onTurn?: (ctx: ExtensionContext, turn: FoldTurnResult | undefined) => void;
	/** Once per fold request, with the engine's answer. */
	readonly onRequest?: (ctx: ExtensionContext, result: FoldRequestResult) => void;
	/** Once per turn boundary at which queued folds were planned, with the requests that were not written. */
	readonly onDrain?: (ctx: ExtensionContext, dropped: readonly DroppedFold[]) => void;
}

export interface DroppedFold {
	/** The refs named by the request. A request read back after a restart shows the entry ids it recorded. */
	readonly startRef: string;
	readonly endRef: string;
	readonly errors: readonly string[];
	/** Request id, when the request had one. */
	readonly requestId?: string;
	/** Set for an accepted request that was not written: why. */
	readonly code?: FoldDropCode;
}

export interface QueuedFoldPlan {
	readonly drafts: SessionBoundaryDraft[];
	readonly dropped: DroppedFold[];
}
export interface FoldEngine {
	mode(ctx: ExtensionContext): FoldMode;
	/** The resolved context engine for this session, cached with the mode. */
	engine(ctx: ExtensionContext): EngineReport;
	/** Copy the state the next live per-turn pass would read, without creating or changing it. */
	snapshotTurnMemory(ctx: ExtensionContext): FoldTurnMemory;
	/** Plan a fold now; in live mode, queue it for the next boundary. */
	request(ctx: ExtensionContext, request: FoldRequest): FoldRequestResult;
	/** Requests waiting for the next boundary. */
	pending(ctx: ExtensionContext): number;
	/** Requests dropped in the last drained batch (and records too large to recover), with the reason. */
	dropped(ctx: ExtensionContext): readonly DroppedFold[];
}

type SessionKey = ExtensionContext["sessionManager"];

/** Register the boundary handlers. Returns the engine handle for a later tool surface. */
export function registerFoldEngine(pi: ExtensionAPI, options: FoldEngineOptions = {}): FoldEngine {
	const modes = new WeakMap<SessionKey, FoldMode>();
	const reports = new WeakMap<SessionKey, EngineReport>();
	const queues = new WeakMap<SessionKey, QueuedFold[]>();
	const dropped = new WeakMap<SessionKey, DroppedFold[]>();
	/** Drops a restart or tree change found that no notice on the branch names yet; the next drain reports them. */
	const scanNotices = new WeakMap<SessionKey, DroppedFold[]>();
	/** Records the last queue rebuild could not queue. Kept until the next rebuild. */
	const scanDrops = new WeakMap<SessionKey, DroppedFold[]>();
	/** What the per-turn pass carries between turns. Reset with the queue. */
	const turnMemory = new WeakMap<SessionKey, FoldTurnMemory>();
	/**
	 * Entries the last step shortened in a request and no hide covers yet (pi-context-aware#268). The next
	 * boundary writes them as recoverable hides. Not durable: a request that is shortened again re-queues.
	 */
	const hideQueues = new WeakMap<SessionKey, Set<string>>();

	const modeOf = (ctx: ExtensionContext): FoldMode => {
		const known = modes.get(ctx.sessionManager);
		if (known) return known;
		let tools: readonly RegisteredToolView[];
		try {
			tools = pi.getAllTools();
		} catch {
			// Pi rejects tool lookups while extensions load. Stay in shadow mode
			// until the tools can be read, so nothing is written by mistake.
			return "shadow";
		}
		const override = resolveFoldConfig(ctx).engine ?? "auto";
		const engine = resolveContextEngine({ tools, override });
		const mode = foldModeForEngine(engine);
		modes.set(ctx.sessionManager, mode);
		reports.set(ctx.sessionManager, { engine, contradictsPresence: engineOverrideContradictsPresence({ tools, override }) });
		return mode;
	};
	const engineOf = (ctx: ExtensionContext): EngineReport => {
		const mode = modeOf(ctx);
		return reports.get(ctx.sessionManager) ?? { engine: mode === "live" ? "folds" : "compaction-only", contradictsPresence: false };
	};
	const contextWindow = (ctx: ExtensionContext): number =>
		ctx.model?.contextWindow && ctx.model.contextWindow > 0 ? ctx.model.contextWindow : (options.fallbackContextWindow ?? 200_000);

	const condenserFor = (ctx: ExtensionContext): ((branch: readonly SessionEntry[]) => FoldCondenser | undefined) | undefined => {
		const make = options.condenser;
		return make ? (branch) => make(ctx, branch) : undefined;
	};

	/**
	 * Drop the queue and read it again from the records on the branch that is
	 * current now. Shadow mode never queues. In live mode, accepted requests that
	 * were saved but never written (the process died before the drain) go back
	 * in the queue; requests accepted on another branch do not.
	 */
	const rebuildQueue = (ctx: ExtensionContext): void => {
		const manager = ctx.sessionManager;
		queues.delete(manager);
		dropped.delete(manager);
		scanDrops.delete(manager);
		scanNotices.delete(manager);
		turnMemory.delete(manager);
		hideQueues.delete(manager);
		if (modeOf(ctx) !== "live") return;
		const scan = scanFoldRequests(manager.getBranch());
		if (scan.recovered.length > 0) queues.set(manager, scan.recovered);
		if (scan.dropped.length > 0) {
			const drops = scan.dropped.map(droppedFromScan);
			scanDrops.set(manager, drops);
			// Report a restart or tree-change drop once in the next turn, as a drained drop is (pi-context-aware#284).
			// A drop an earlier notice on this branch already named is not reported again on every restart.
			const told = noticedDropKeys(manager.getBranch());
			const fresh = drops.filter((drop) => !told.has(dropKey(drop)));
			if (fresh.length > 0) scanNotices.set(manager, fresh);
		}
	};

	pi.on("session_start", (_event, ctx) => {
		modes.delete(ctx.sessionManager);
		reports.delete(ctx.sessionManager);
		rebuildQueue(ctx);
	});
	// Moving to another point of the session tree changes the branch. Requests
	// queued for the old branch must not be written to the new one.
	pi.on("session_tree", (_event, ctx) => rebuildQueue(ctx));

	/**
	 * The drafts that store the recoverable hides queued since the last boundary (pi-context-aware#268). The
	 * queue is emptied whatever happens: a hide that is not written is queued again by the next request that
	 * shortens the entry. Each hide is written on a copy of the branch first; one Pi would refuse is left out,
	 * so a refused hide never takes the fold drafts or another hide down with it.
	 */
	const hideDrafts = (ctx: ExtensionContext, pending: readonly SessionBoundaryDraft[]): SessionBoundaryDraft[] => {
		const manager = ctx.sessionManager;
		const queued = hideQueues.get(manager);
		hideQueues.delete(manager);
		if (!queued || queued.size === 0) return [];
		try {
			const branch = manager.getBranch();
			const plans = planHides(branch, [...queued], pending);
			const header = manager.getHeader();
			if (plans.length === 0 || !header) return [];
			const preview = SessionManager.inMemory(manager.getCwd(), undefined, [header, ...branch]);
			applyFoldDrafts(preview, pending.filter((draft) => draft.type === "custom" || draft.type === "context_edit"));
			const accepted: SessionBoundaryDraft[] = [];
			for (const plan of plans) {
				try {
					applyFoldDrafts(preview, plan.drafts);
					accepted.push(...plan.drafts);
				} catch {
					// Pi would refuse this hide. The preview may hold its metadata entry; it is only a copy.
				}
			}
			return accepted;
		} catch {
			return [];
		}
	};
	const drain = (entries: readonly SessionBoundaryDraft[], ctx: ExtensionContext) => {
		const queued = queues.get(ctx.sessionManager);
		queues.delete(ctx.sessionManager);
		if (modeOf(ctx) !== "live") return undefined;
		let planned: QueuedFoldPlan | undefined;
		if (queued && queued.length > 0) {
			planned = planQueuedFolds(ctx.sessionManager, queued, contextWindow(ctx), options.config, resolveFoldConfig(ctx), condenserFor(ctx), options.hints?.(ctx));
			dropped.set(ctx.sessionManager, planned.dropped);
			try { options.metrics?.onDrain?.(ctx, planned.dropped); } catch { /* Metrics never change a boundary. */ }
		}
		const earlier = Array.isArray(entries) ? entries : [];
		const hides = hideDrafts(ctx, [...earlier, ...(planned?.drafts ?? [])]);
		// The caller was told these folds were accepted; say in the next turn that they were not written (pi-context-aware#282).
		const unreported = scanNotices.get(ctx.sessionManager) ?? [];
		scanNotices.delete(ctx.sessionManager);
		const notice = foldDropNotice([...unreported, ...(planned?.dropped ?? [])]);
		const added = [...(planned?.drafts ?? []), ...hides, ...(notice ? [notice] : [])];
		return added.length > 0 ? { entries: [...earlier, ...added] } : undefined;
	};
	pi.on("turn_end", (event, ctx) => drain(event.entries, ctx));
	pi.on("agent_before_settle", (event, ctx) => drain(event.entries, ctx));
	// billion-context-pi renders its own compress calls; a shadow session has no native fold calls.
	pi.on("context", (event, ctx) => {
		if (modeOf(ctx) !== "live") return undefined;
		const manager = ctx.sessionManager;
		const branch = manager.getBranch();
		try {
			let memory = turnMemory.get(manager);
			if (!memory) turnMemory.set(manager, memory = createFoldTurnMemory());
			const usage = ctx.getContextUsage?.();
			const turn = prepareFoldTurn({
				messages: event.messages,
				projection: manager.buildSessionProjection(),
				branch,
				contextEntries: manager.buildContextEntries(),
				model: {
					contextWindow: contextWindow(ctx),
					...(ctx.model?.maxTokens ? { maxOutputTokens: ctx.model.maxTokens } : {}),
					...(ctx.model?.api ? { api: ctx.model.api } : {}),
					vision: Array.isArray(ctx.model?.input) && ctx.model.input.includes("image"),
				},
				systemPromptTokens: defaultCountTokens(ctx.getSystemPrompt?.() ?? ""),
				...(typeof usage?.tokens === "number" ? { hostTokens: usage.tokens } : {}),
				memory,
				...(options.config ? { config: options.config } : {}),
				...(options.ladder ? { ladder: options.ladder(ctx) } : {}),
			});
			if (turn?.emergency?.hideCandidates.length) {
				const queued = hideQueues.get(manager) ?? new Set<string>();
				for (const id of turn.emergency.hideCandidates) queued.add(id);
				hideQueues.set(manager, queued);
			}
			if (turn?.emergency) {
				try { options.onEmergency?.(ctx, turn.emergency); } catch { /* A failed notice never changes the request. */ }
			}
			try { options.metrics?.onTurn?.(ctx, turn); } catch { /* Metrics never change a request. */ }
			if (turn) return { messages: turn.messages };
		} catch {
			// The pass failed: still send the block pointers, so no summary is repeated.
			try { options.metrics?.onTurn?.(ctx, undefined); } catch { /* Metrics never change a request. */ }
		}
		const records = foldRecordsOnBranch(branch).map(({ record }) => record);
		const messages = renderEarlierFoldCalls(event.messages, records);
		return messages === event.messages ? undefined : { messages };
	});

	const fail = (ctx: ExtensionContext, errors: string[], code?: FoldRequestFailure["code"]): FoldRequestFailure => {
		const state = foldStateFromBranch(ctx.sessionManager.getBranch(), ctx.sessionManager.buildContextEntries());
		return { ok: false, errors, validRefs: validFoldRefs(state), ...(code ? { code } : {}) };
	};

	/**
	 * Answer a request whose id is already queued, written, or saved on the
	 * branch. `undefined` when the id is new. Never plans a second, different fold:
	 * the replay gets the existing result when it is the same request, and an
	 * explicit error when it is not.
	 */
	const answerReplay = (ctx: ExtensionContext, request: FoldRequest, requestId: string): FoldRequestResult | undefined => {
		const manager = ctx.sessionManager;
		const branch = manager.getBranch();
		const written = foldRecordsOnBranch(branch).filter(({ record }) => record.requestId === requestId);
		const queuedItem = (queues.get(manager) ?? []).find((item) => queuedRequestId(item) === requestId);
		const found = findFoldRequestRecord(branch, requestId);
		if (found?.kind === "too-large") {
			return fail(ctx, [`too-large: the saved fold request ${requestId} names ${found.covered} entries; at most ${MAX_RECOVERY_COVERED_IDS_PER_RECORD} are supported, so it cannot be repeated.`], "too-large");
		}
		const saved = found?.kind === "record" ? found : undefined;
		if (written.length > 0) {
			// The fold hides its range, so the replay's refs no longer mean what they meant
			// (refs are numbered over what is visible). The replay is the same request when
			// it names the same refs, summary and topic as the saved record.
			const difference = saved ? compareRequestText(saved.recovery, request) : undefined;
			if (difference) return fail(ctx, [`${difference.message} (replay of request ${requestId})`], difference.code);
			return { ok: true, mode: "live", queued: false, blockIds: written.map(({ record }) => record.blockId), warnings: [], replayed: true };
		}
		const existing = queuedItem
			? acceptedFoldOf(queuedItem)
			: saved ? acceptedFoldOf({ recovery: saved.recovery, toolResultEntryId: saved.toolResultEntryId }) : undefined;
		if (!existing) return undefined;
		const recovery = queuedItem ? (isRecoveredItem(queuedItem) ? queuedItem.recovery : queuedItem.accepted?.recovery) : saved?.recovery;
		const contextEntries = manager.buildContextEntries();
		const plan = planFold({
			startRef: request.startRef,
			endRef: request.endRef,
			summary: request.summary,
			...(request.topic ? { topic: request.topic } : {}),
			...limitOf(request),
			branch,
			contextEntries,
			modelContextLimit: contextWindow(ctx),
			folds: resolveFoldConfig(ctx),
			...condenserField(condenserFor(ctx)?.(branch)),
			...hintsField(options.hints?.(ctx)),
			...(options.config ? { config: options.config } : {}),
		});
		if (!plan.ok) {
			// The same request cannot plan over the same entries any more (a later fold took part of the range).
			return fail(ctx, [`coverage-changed: the replayed request ${requestId} cannot cover the entries it was accepted over: ${plan.errors.join(" ")}`], "coverage-changed");
		}
		const now = acceptedSourceOf({ request, plan, branch, contextEntries });
		if (!now) return fail(ctx, ["The replayed request covers no session entry."], "coverage-changed");
		const difference = compareFoldSources(existing.source, now.coveredEntryIds, () => now.sourceDigest)
			?? compareContent(existing.summary, existing.topic, request);
		if (difference) return fail(ctx, [`${difference.message} (replay of request ${requestId})`], difference.code);
		if (!queuedItem && saved) {
			// Dropped earlier, or never recovered, and still the same fold: queue it
			// again. The drain applies the same checks as for any other item.
			queues.set(manager, [...(queues.get(manager) ?? []), { recovery: saved.recovery, toolResultEntryId: saved.toolResultEntryId }]);
		}
		return {
			ok: true,
			mode: "live",
			queued: true,
			blockIds: plan.records.map((record) => record.blockId),
			warnings: plan.warnings,
			replayed: true,
			...(recovery ? { recovery } : {}),
		};
	};

	return {
		mode: modeOf,
		engine: engineOf,
		snapshotTurnMemory: (ctx) => {
			const memory = turnMemory.get(ctx.sessionManager);
			return memory ? cloneFoldTurnMemory(memory) : createFoldTurnMemory();
		},
		pending: (ctx) => queues.get(ctx.sessionManager)?.length ?? 0,
		dropped: (ctx) => [...(scanDrops.get(ctx.sessionManager) ?? []), ...(dropped.get(ctx.sessionManager) ?? [])],
		request(ctx, request) {
			const result = requestFold(ctx, request);
			try { options.metrics?.onRequest?.(ctx, result); } catch { /* Metrics never change an answer. */ }
			return result;
		},
	};

	function requestFold(ctx: ExtensionContext, request: FoldRequest): FoldRequestResult {
		{
			let requestId: string | undefined;
			if (request.requestId !== undefined) {
				const checked = checkFoldRequestId(request.requestId);
				if (!checked.ok) return fail(ctx, [checked.error]);
				requestId = request.requestId;
			}
			const mode = modeOf(ctx);
			if (requestId && mode === "live") {
				const answered = answerReplay(ctx, request, requestId);
				if (answered) return answered;
			}
			const branch = ctx.sessionManager.getBranch();
			const contextEntries = ctx.sessionManager.buildContextEntries();
			const folds = resolveFoldConfig(ctx);
			// One condenser for every plan of this request (see FoldPlanInput.condenser).
			const condenser = { ...condenserField(condenserFor(ctx)?.(branch)), ...hintsField(mode === "live" ? options.hints?.(ctx) : undefined) };
			const plan = planFold({
				startRef: request.startRef,
				endRef: request.endRef,
				summary: request.summary,
				...(request.topic ? { topic: request.topic } : {}),
				...limitOf(request),
				branch,
				contextEntries,
				modelContextLimit: contextWindow(ctx),
				folds,
				...condenser,
				...(options.config ? { config: options.config } : {}),
			});
			if (!plan.ok) return plan;
			let recovery: FoldRequestRecovery | undefined;
			if (mode === "live") {
				const source = acceptedSourceOf({ request, plan, branch, contextEntries });
				if (!source) return fail(ctx, ["The fold covers no session entry."]);
				if (requestId && source.coveredEntryIds.length > MAX_RECOVERY_COVERED_IDS_PER_RECORD) {
					return fail(ctx, [`too-large: this request covers ${source.coveredEntryIds.length} entries; at most ${MAX_RECOVERY_COVERED_IDS_PER_RECORD} are supported for a request with an id, because a larger record could not be recovered.`], "too-large");
				}
				const copy: QueuedFoldRequest = {
					startRef: request.startRef,
					endRef: request.endRef,
					summary: request.summary,
					...(request.topic ? { topic: request.topic } : {}),
					...limitOf(request),
					...(requestId ? { requestId } : {}),
				};
				// The leaf the request is made on binds it to this branch, live and after a restart (pi-context-aware#176).
				const leafId = ctx.sessionManager.getLeafId();
				if (requestId) recovery = buildFoldRequestRecovery({ requestId, request: copy, source, leafId });
				const accepted: QueuedFoldRequest = {
					...copy,
					accepted: { source, leafId, ...(recovery ? { recovery } : {}) },
				};
				// Run the check the boundary runs, now (pi-context-aware#282). The plan above counts the
				// whole named range toward the size minimum; the boundary plans again over only the
				// entries this fold would hide, so a range the protected zone trims below the minimum
				// passed above and was dropped there. Accept only what the branch as it is now would write.
				const acceptedFold = acceptedFoldOf(accepted);
				const probe = acceptedFold ? replanAcceptedFold({
					accepted: acceptedFold,
					branch,
					contextEntries,
					modelContextLimit: contextWindow(ctx),
					folds,
					...condenser,
					...(options.config ? { config: options.config } : {}),
				}) : undefined;
				if (probe && !probe.ok) return fail(ctx, probe.errors.map(withoutRefusedPrefix));
				queues.set(ctx.sessionManager, [...(queues.get(ctx.sessionManager) ?? []), accepted]);
			}
			return {
				ok: true,
				mode,
				queued: mode === "live",
				blockIds: plan.records.map((record) => record.blockId),
				warnings: plan.warnings,
				...(recovery ? { recovery } : {}),
			};
		}
	}
}

function isRecoveredItem(item: QueuedFold): item is RecoveredFoldRequest {
	return "recovery" in item;
}

/** The request's summary limit, copied by name and only when it is a finite number (pi-context-aware#183). */
function limitOf(request: { readonly summaryMaxChars?: number }): { summaryMaxChars?: number } {
	const summaryMaxChars = summaryLimitOf(request.summaryMaxChars);
	return summaryMaxChars === undefined ? {} : { summaryMaxChars };
}

const normalRef = (ref: string): string => ref.trim().toLowerCase().slice(0, MAX_REQUEST_REF_LENGTH);

/** A replay with another summary or topic is another fold, even over the same entries. */
function compareContent(summary: string, topic: string | undefined, request: FoldRequest): SourceDifference | undefined {
	return summary === request.summary && (topic ?? "") === (request.topic ?? "")
		? undefined
		: { code: "source-changed", message: "source-changed: the replayed request carries a different summary or topic than the one accepted." };
}

/** For a request whose fold is written: same refs, summary and topic as the saved record. */
function compareRequestText(saved: FoldRequestRecovery, request: FoldRequest): SourceDifference | undefined {
	const content = compareContent(saved.summary, saved.topic, request);
	if (content) return content;
	return saved.startRef === normalRef(request.startRef) && saved.endRef === normalRef(request.endRef)
		? undefined
		: { code: "coverage-changed", message: "coverage-changed: the replayed request names other refs than the one accepted, and its fold is already written." };
}

function droppedFromScan(drop: RecoveryDrop): DroppedFold {
	return { startRef: drop.startRef, endRef: drop.endRef, errors: drop.errors, ...(drop.requestId ? { requestId: drop.requestId } : {}), code: drop.code };
}

/**
 * Plan queued requests in order against a preview of the branch, so each fold
 * sees the folds before it. Requests that no longer resolve are reported.
 * A request whose id is already on the branch, or already planned in this
 * batch, is skipped without a report: its fold exists.
 *
 * Every request the engine accepted (live or read back after a restart) is
 * planned again from its recorded entry ids against the branch as it is now,
 * and is written only if that branch holds the entry it was accepted on and the
 * fold would hide exactly the recorded entries over the recorded source (see
 * `replanAcceptedFold`). Otherwise it is dropped with a code. A request that
 * carries no acceptance (a preview built by a caller, such as the parity
 * comparison) is planned from its refs.
 *
 * Each request is planned on its own: one that throws is dropped as
 * `plan-failed` and the rest are still planned.
 */
export function planQueuedFolds(
	manager: Pick<SessionManager, "getHeader" | "getBranch" | "getCwd">,
	requests: readonly QueuedFold[],
	modelContextLimit: number,
	config?: Partial<Config>,
	folds?: FoldsConfig,
	condenserFor?: (branch: readonly SessionEntry[]) => FoldCondenser | undefined,
	hints?: FoldHintView,
): QueuedFoldPlan {
	const header = manager.getHeader();
	if (!header) return { drafts: [], dropped: requests.map((request) => ({
		...droppedRefs(request), errors: ["Session header is unavailable."],
	})) };
	const drafts: SessionBoundaryDraft[] = [];
	const dropped: DroppedFold[] = [];
	const makePreview = (): SessionManager => {
		const preview = SessionManager.inMemory(manager.getCwd(), undefined, [header, ...manager.getBranch()]);
		applyFoldDrafts(preview, drafts);
		return preview;
	};
	const failedAll = (list: readonly QueuedFold[], error: unknown) => list.map((request): DroppedFold => ({
		...droppedRefs(request), errors: [planFailure(error)], code: "plan-failed", ...optionalId(queuedRequestId(request)),
	}));
	let preview: SessionManager;
	try {
		preview = makePreview();
	} catch (error) {
		return { drafts: [], dropped: failedAll(requests, error) };
	}
	for (const [index, request] of requests.entries()) {
		const requestId = queuedRequestId(request);
		try {
			if (!("recovery" in request) && requestId !== undefined) {
				const checked = checkFoldRequestId(requestId);
				if (!checked.ok) {
					dropped.push({ startRef: request.startRef, endRef: request.endRef, errors: [checked.error], requestId });
					continue;
				}
			}
			if (requestId && foldRequestIdsOnBranch(preview.getBranch()).has(requestId)) continue;
			const accepted = acceptedFoldOf(request);
			let stamped: SessionBoundaryDraft[];
			if (accepted) {
				const replanned = replanAcceptedFold({
					accepted,
					branch: preview.getBranch(),
					contextEntries: preview.buildContextEntries(),
					modelContextLimit,
					...(folds ? { folds } : {}),
					...condenserField(condenserFor?.(preview.getBranch())),
					...hintsField(hints),
					...(config ? { config } : {}),
				});
				if (!replanned.ok) {
					dropped.push({ startRef: replanned.startRef, endRef: replanned.endRef, errors: replanned.errors, code: replanned.code, ...optionalId(requestId) });
					continue;
				}
				stamped = requestId ? stampRequestId(replanned.plan.drafts, requestId) : replanned.plan.drafts;
			} else {
				const plain = request as QueuedFoldRequest;
				const plan = planFold({
					startRef: plain.startRef,
					endRef: plain.endRef,
					summary: plain.summary,
					...(plain.topic ? { topic: plain.topic } : {}),
					...limitOf(plain),
					branch: preview.getBranch(),
					contextEntries: preview.buildContextEntries(),
					modelContextLimit,
					...(folds ? { folds } : {}),
					...condenserField(condenserFor?.(preview.getBranch())),
					...hintsField(hints),
					...(config ? { config } : {}),
				});
				if (!plan.ok) {
					dropped.push({ startRef: plain.startRef, endRef: plain.endRef, errors: [...plan.errors], ...optionalId(requestId) });
					continue;
				}
				stamped = requestId ? stampRequestId(plan.drafts, requestId) : plan.drafts;
			}
			applyFoldDrafts(preview, stamped);
			drafts.push(...stamped);
		} catch (error) {
			dropped.push(...failedAll([request], error));
			try {
				// The preview may hold half of this request's drafts; start again from what was accepted.
				preview = makePreview();
			} catch (previewError) {
				dropped.push(...failedAll(requests.slice(index + 1), previewError));
				break;
			}
		}
	}
	return { drafts, dropped };
}

/** Custom message type of the notice that accepted folds were not written (pi-context-aware#282). */
export { FOLD_NOTICE_TYPE };
/** Dropped folds named one by one in a notice; the rest are counted. */
const MAX_NOTICE_FOLDS = 3;
const MAX_NOTICE_REASON_CHARS = 300;
const MAX_NOTICE_REF_CHARS = 40;

/** The planner's refusal without the drop-code prefix the boundary adds. */
function withoutRefusedPrefix(error: string): string {
	return error.startsWith("refused: ") ? error.slice("refused: ".length) : error;
}

function clip(text: string, max: number): string {
	return text.length > max ? text.slice(0, max - 3) + "..." : text;
}

/** Most drop keys one notice records, so a later restart does not report the same drops again. */
const MAX_NOTICE_KEYS = 64;
const MAX_DROP_KEY_CHARS = 300;

/** What identifies one drop across restarts: its request id, else its refs and code. */
function dropKey(drop: DroppedFold): string {
	return clip(drop.requestId ?? `${drop.startRef}..${drop.endRef}:${drop.code ?? ""}`, MAX_DROP_KEY_CHARS);
}

/** The drop keys earlier notices on this branch recorded. A notice without well-formed details names none. */
function noticedDropKeys(branch: readonly SessionEntry[]): Set<string> {
	const keys = new Set<string>();
	for (const entry of branch) {
		if (entry.type !== "custom_message" || entry.customType !== FOLD_NOTICE_TYPE) continue;
		const details = entry.details as { version?: unknown; drops?: unknown } | undefined;
		if (!details || details.version !== 1 || !Array.isArray(details.drops)) continue;
		for (const key of details.drops.slice(0, MAX_NOTICE_KEYS)) if (typeof key === "string") keys.add(key);
	}
	return keys;
}

/**
 * One custom message for a drained batch that dropped folds, or `undefined` when it dropped none.
 * The fold tool told the caller these folds were accepted. The message reaches the model with the
 * next request and is never a user turn. It names at most MAX_NOTICE_FOLDS folds and counts the rest.
 */
export function foldDropNotice(dropped: readonly DroppedFold[]): CustomMessageEntryDraft | undefined {
	if (dropped.length === 0) return undefined;
	const lines = dropped.slice(0, MAX_NOTICE_FOLDS).map((drop) => {
		const span = clip(drop.startRef, MAX_NOTICE_REF_CHARS) + ".." + clip(drop.endRef, MAX_NOTICE_REF_CHARS);
		const reason = drop.errors.map(withoutRefusedPrefix).join(" ").trim() || drop.code || "no reason was given";
		return "Fold " + span + " was not written: " + clip(reason, MAX_NOTICE_REASON_CHARS);
	});
	const more = dropped.length - lines.length;
	if (more > 0) lines.push(more + " more fold" + (more === 1 ? " was" : "s were") + " not written; context_status({ view: \"folds\" }) lists them.");
	const keys = dropped.slice(0, MAX_NOTICE_KEYS).map(dropKey);
	return { type: "custom_message", customType: FOLD_NOTICE_TYPE, content: lines.join("\n"), display: true, details: { version: 1, drops: keys } };
}

function condenserField(condenser: FoldCondenser | undefined): { condenser?: FoldCondenser } {
	return condenser ? { condenser } : {};
}

function hintsField(hints: FoldHintView | undefined): { hints?: FoldHintView } {
	return hints ? { hints } : {};
}

function optionalId(requestId: string | undefined): { requestId?: string } {
	return requestId ? { requestId } : {};
}

function planFailure(error: unknown): string {
	return `plan-failed: ${error instanceof Error ? error.message : String(error)}`;
}

function droppedRefs(request: QueuedFold): { startRef: string; endRef: string } {
	if ("recovery" in request) {
		return { startRef: request.recovery.startBlockId ?? request.recovery.startEntryId, endRef: request.recovery.endBlockId ?? request.recovery.endEntryId };
	}
	return { startRef: request.startRef, endRef: request.endRef };
}

/** Append fold drafts the way Pi appends boundary drafts, the drop notice included. Used for previews and tests. */
export function applyFoldDrafts(
	manager: Pick<SessionManager, "appendContextEdit" | "appendCustomEntry" | "appendCustomMessageEntry">,
	drafts: readonly SessionBoundaryDraft[],
): void {
	for (const draft of drafts) {
		if (draft.type === "context_edit") manager.appendContextEdit(draft.targetId, draft.replacement);
		else if (draft.type === "custom") manager.appendCustomEntry(draft.customType, draft.data);
		else if (draft.type === "custom_message") manager.appendCustomMessageEntry(draft.customType, draft.content, draft.display, draft.details);
		else throw new Error(`fold drafts never contain ${draft.type} entries`);
	}
}

export type { SessionEntry };
