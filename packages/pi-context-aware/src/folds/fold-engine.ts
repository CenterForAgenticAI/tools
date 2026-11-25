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

import { projectRootFromCwd } from "../platform/project-root.js";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { DEFAULT_FOLDS_CONFIG, DEFAULT_STRATEGY_CONFIG, readConfigLayer, readPolicyEntryLayers, resolveConfigLayers, withoutUntrustedOwnership, type Config as ContextAwareConfig, type FoldsConfig, type StrategyConfig } from "../platform/config-layers.js";
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
	engineOfMethods,
	foldModeForEngine,
	resolveContextEngine,
	resolveSessionStrategy,
	strategyDebugLines,
	strategyErrorLines,
	type ContextEngine,
	type ContextEngineOverride,
	type MethodsSource,
	type SessionStrategy,
	type StrategySettings,
} from "./engine-resolver.js";
import { foldStateFromBranch, keptFirstUserId, offeredFoldRanges, planFold, planFoldCoded, summarizeEngine, summaryLimitOf, validFoldRefs, verbatimEntryIds, type FoldCondenser, type FoldPlan, type FoldPlanInput, type OfferedRange } from "./fold-adapter.js";
import { FOLD_NOTICE_TYPE, oneLine, type FoldHintView } from "./fold-hints.js";
import { renderEarlierFoldCalls } from "./fold-call-render.js";
import type { PressureLadderConfig } from "../policy/context-policy.js";
import { cloneFoldTurnMemory, createFoldTurnMemory, FOLD_TOOL_NAME, prepareFoldTurn, type FoldEmergency, type FoldTurnInput, type FoldTurnMemory, type FoldTurnResult } from "./fold-turn.js";
import { planHides } from "./hide-entries.js";
import { FOLD_ONLY, type NudgeTools } from "./nudge-tools.js";
import { foldsFreedTokens } from "./fold-savings.js";
import { pressureActionLine, requestPressure, withoutRetiredUsageMarkers, type RequestPressure } from "./request-pressure.js";
import type { EntryPressure } from "../compaction/entry-pressure.js";
import type { PressureTelemetryMode } from "../platform/config-layers.js";
import { buildSessionContext, type ContextEvent } from "@earendil-works/pi-coding-agent";

type Message = ContextEvent["messages"][number];
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
import { buildContextView } from "../strategy-runtime/context-view.js";
import { checkPlan, type SummarizeEngine } from "../strategy-runtime/check-plan.js";
import { runStages, type StageRecord, type StageRun } from "../strategy-runtime/live/stage-loop.js";
import { ASSIGNMENT_ENTRY_TYPE, assignmentEntryData, assignmentOnBranch, retiredAssignmentsOnBranch } from "../strategy-runtime/live/assignment.js";
import type { ContextView, SummaryWriter, ViewCompactionOwner } from "../strategy/contract.js";
import { steerFor, type GuidanceVariant, type Steer } from "../strategy/guidance.js";
import { composeRecipe, wantsOnlyOnSignals, type RequestSignals } from "../strategy/live.js";
import { DEFAULT_METHODS, hasMethod, toMethodSet, type ContextMethod } from "../strategy/methods.js";


/** A fold request, optionally with the id that makes writing it idempotent. */
export type FoldRequest = Omit<QueuedFoldRequest, "accepted">;

/** Resolve the fold-only leaves locally: the extension's root resolver is private.
 * No fold CLI flags exist. Files are re-read; session/host values follow the current branch.
 */
export function resolveFoldConfig(ctx: StrategyContext, agentDir = getAgentDir()): FoldsConfig {
	return resolveLocalConfig(ctx, agentDir).config.folds ?? DEFAULT_FOLDS_CONFIG;
}

/** The strategy settings (pi-context-aware#472), read the way `resolveFoldConfig` reads the fold settings. */
export function resolveStrategyConfig(ctx: StrategyContext, agentDir = getAgentDir()): StrategyConfig {
	return resolveLocalConfig(ctx, agentDir).config.strategy ?? DEFAULT_STRATEGY_CONFIG;
}

/** A context the fold and strategy settings are read for; `isProjectTrusted` decides whether the project file may set them. */
export type StrategyContext = Pick<ExtensionContext, "cwd" | "sessionManager"> & Partial<Pick<ExtensionContext, "isProjectTrusted">>;

/** True only when the host says the project is trusted; a missing or throwing lookup is untrusted. */
function projectTrusted(ctx: StrategyContext): boolean {
	try { return typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted() === true; } catch { return false; }
}

function resolveLocalConfig(ctx: StrategyContext, agentDir: string): { readonly config: ContextAwareConfig; readonly rejected: readonly string[] } {
	const read = (file: string) => {
		try { return JSON.parse(readFileSync(file, "utf8")) as unknown; } catch { return undefined; }
	};
	const root = projectRootFromCwd(ctx.cwd) ?? ctx.cwd;
	const project = readConfigLayer(read(path.join(root, ".pi", "context-aware.json")), "project");
	// An untrusted project's checked-in file must not choose how its sessions manage context or which get which
	// guidance (pi-context-aware#473, pi-context-aware#525): the same leaves the extension's own layers drop.
	const projectLayer = projectTrusted(ctx) ? project : withoutUntrustedOwnership(project);
	const resolved = resolveConfigLayers([
		readConfigLayer(read(path.join(agentDir, "context-aware.json")), "global"),
		projectLayer,
		...readPolicyEntryLayers(ctx.sessionManager.getBranch()),
	]);
	return { config: resolved.config, rejected: resolved.rejected.map((entry) => entry.path) };
}

export type FoldMode = "live" | "shadow";

/** The session's strategy from its settings and the registered tools (pi-context-aware#472, pi-context-aware#526). */
export function sessionStrategyFor(ctx: StrategyContext, tools: readonly RegisteredToolView[], agentDir = getAgentDir()): SessionStrategy {
	return resolveSessionStrategy({ tools, settings: strategySettingsFor(ctx, agentDir) });
}

/**
 * The strategy settings of a session: the config layers, and the session itself (pi-context-aware#473): its id,
 * whether it is new (no message on its branch yet), the assignment recorded on its branch and the retired ones.
 */
export function strategySettingsFor(ctx: StrategyContext, agentDir = getAgentDir()): StrategySettings {
	const { config, rejected } = resolveLocalConfig(ctx, agentDir);
	const strategy = config.strategy ?? DEFAULT_STRATEGY_CONFIG;
	const branch = ctx.sessionManager.getBranch() as readonly { readonly type?: string }[];
	let id: string | undefined;
	try { id = typeof ctx.sessionManager.getSessionId === "function" ? ctx.sessionManager.getSessionId() : undefined; } catch { /* No id: nothing is drawn. */ }
	const recorded = assignmentOnBranch(branch);
	const fresh = !branch.some((entry) => entry.type === "message");
	const retired = retiredAssignmentsOnBranch(branch);
	const session = id !== undefined ? { id, fresh, recorded, retired } : recorded ? { id: recorded.drawnFor, fresh: false, recorded, retired } : undefined;
	return {
		methods: strategy.methods,
		shadow: strategy.shadow,
		engine: config.folds?.engine ?? "auto",
		...(strategy.assign ? { assign: { guidance: strategy.assign.guidance, seed: strategy.assign.seed } } : {}),
		rejected: rejected.filter((key) => key.startsWith("strategy.")),
		...(session ? { session } : {}),
	};
}

/** Shadow while billion-context-pi owns context management; live otherwise. */
export function foldModeFor(tools: readonly RegisteredToolView[], override: ContextEngineOverride = "auto"): FoldMode {
	return foldModeForEngine(resolveContextEngine({ tools, override }));
}

/** What `context_status` reports about the engine. */
export interface EngineReport {
	readonly engine: ContextEngine;
	/** The override forces `folds` while billion-context-pi is loaded. */
	readonly contradictsPresence: boolean;
	/** The methods this session runs, the method lists beside them in shadow, its guidance and the setting errors (pi-context-aware#526). */
	readonly strategy: SessionStrategy;
}

/** A request the engine refused. `code` is set when the refusal is not a planner error. */
export interface FoldRequestFailure {
	readonly ok: false;
	readonly errors: string[];
	readonly validRefs: string[];
	/**
	 * Ranges a fold of the branch as it is now would accept, as the fold nudge offers them
	 * (pi-context-aware#457). Set by the engine's `request`; empty when nothing can be folded.
	 */
	readonly offeredRanges?: readonly OfferedRange[];
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
	/**
	 * `pressureTelemetry.mode` for this session: what the pressure action line shows (pi-context-aware#461).
	 * Without it the line shows the band, percent and headroom.
	 */
	readonly telemetryMode?: (ctx: ExtensionContext) => PressureTelemetryMode;
	/**
	 * How the model calls the tool that still reduces context when another package cancels every compaction
	 * (billion-context-pi's `compress`), when this session can call it. The action line names it when neither
	 * context tool is reachable.
	 */
	readonly replacementTool?: (ctx: ExtensionContext) => string | undefined;
	/**
	 * The branch's entries since the last compaction against their limit, or null when the check is off
	 * (pi-context-aware#441). At the limit every request's pressure is URGENT, with entry count as the reason.
	 * A throw counts as off.
	 */
	readonly entries?: (ctx: ExtensionContext) => EntryPressure | null;
	/**
	 * Called once per session start when the strategy settings cannot be used: an unknown method, a removed setting
	 * (pi-context-aware#472, pi-context-aware#526, REQ-STRAT-011), with one bounded line per error (`strategyErrorLines`).
	 * A throw is ignored.
	 */
	readonly onStrategyErrors?: (ctx: ExtensionContext, lines: readonly string[]) => void;
	/** Called once per session start with debug notes that are not errors (`strategyDebugLines`). A throw is ignored. */
	readonly onStrategyDebug?: (ctx: ExtensionContext, lines: readonly string[]) => void;
	/**
	 * Tool names for the strategy view (pi-context-aware#472): those the session can call now and every one it
	 * registered. A stage names only the context tools among the reachable ones (pi-context-aware#458). Without it
	 * the fold tool alone is reachable. A throw counts as none reachable.
	 */
	readonly tools?: (ctx: ExtensionContext) => { readonly reachable: readonly string[]; readonly registered: readonly string[] };
	/** Who holds the compaction-owner claim, for the view's one-writer rule (pi-context-aware#472). Without it, nobody. */
	readonly compactionOwner?: (ctx: ExtensionContext) => ViewCompactionOwner;
	/**
	 * Called when the strategy view of a request or a compaction cannot be built (CR-VIEW-FAIL-SILENT), with one
	 * clipped line: the trigger, then the error. A throw is ignored.
	 */
	readonly onViewError?: (ctx: ExtensionContext, line: string) => void;
}

/** What the session's recipe stages did (pi-context-aware#472): the latest request's records, and counts since the session started. */
export interface StrategyReport {
	readonly last: readonly StageRecord[];
	/** `<role> <recipe>/<stage> <outcome>` to the number of requests. */
	readonly counts: Readonly<Record<string, number>>;
}

/** One stage's outcome as the metrics log records it (pi-context-aware#473): a `StageRecord` with its trigger. */
export interface StageReport {
	readonly trigger: "request" | "compaction";
	readonly recipe: string;
	readonly role: StageRecord["role"];
	readonly stage: string;
	readonly outcome: StageRecord["outcome"];
	readonly codes: readonly string[];
}

/** The session's methods and what their stages did on one request (pi-context-aware#473, pi-context-aware#526). */
export interface RequestStrategyReport {
	readonly strategy: { readonly methods: readonly ContextMethod[]; readonly source: MethodsSource; readonly shadow: readonly (readonly ContextMethod[])[]; readonly guidance: GuidanceVariant };
	readonly stages: readonly StageReport[];
	/** The wording the request's nudge and fold guideline were chosen in (pi-context-aware#459). */
	readonly steer: Steer;
}

/** What the engine reports to the per-turn metrics recorder. */
export interface FoldEngineMetrics {
	/**
	 * Once per model request, with the pass result (undefined when the pass failed, did not line up, or did not
	 * run), the request's pressure, the one value every consumer reads (pi-context-aware#461), or null when
	 * nothing could count the request, and whether the pass failed. A request in shadow mode runs no pass, so it
	 * is not a failed pass.
	 */
	readonly onTurn?: (ctx: ExtensionContext, turn: FoldTurnResult | undefined, pressure: RequestPressure | null, passFailed: boolean, strategy?: RequestStrategyReport) => void;
	/** Stage outcomes of a compaction a plan source asked for, which belong to the request in flight. */
	readonly onStages?: (ctx: ExtensionContext, stages: readonly StageReport[]) => void;
	/** Once per fold request, with the engine's answer. */
	readonly onRequest?: (ctx: ExtensionContext, result: FoldRequestResult) => void;
	/**
	 * Once per turn boundary at which queued folds were planned, with the requests that were not written and the
	 * tokens the written folds free (pi-context-aware#459, `foldsFreedTokens`).
	 */
	readonly onDrain?: (ctx: ExtensionContext, dropped: readonly DroppedFold[], written?: { readonly freedTokens: number }) => void;
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
	/**
	 * The pressure of the latest request in this session (pi-context-aware#461): the fold pass's count of the
	 * request it built, or Pi's usage when the pass did not run. Before the first request, and after a compaction, a model switch
	 * or a branch change, it is Pi's usage now. Null when the session has no context window or usage to read.
	 */
	pressure(ctx: ExtensionContext): RequestPressure | null;
	/**
	 * The pressure of the request this session would send now, counted by the same pass as a live request without
	 * changing anything (pi-context-aware#461). Compaction decisions between requests read it. It reads the current
	 * branch, not a request: at a prompt boundary it leaves out the new prompt, the messages before_agent_start
	 * adds and any other extension's context rewrite, so it is lower than the next request's count.
	 */
	nextPressure(ctx: ExtensionContext): RequestPressure | null;
	/** The text the latest request injected (the nudge and the action line), which is never persisted; undefined when none. */
	injection(ctx: ExtensionContext): string | undefined;
	mode(ctx: ExtensionContext): FoldMode;
	/** The resolved context engine for this session, cached with the mode. */
	engine(ctx: ExtensionContext): EngineReport;
	/**
	 * The wording the session's guidance chooses for its current model (pi-context-aware#459): `steerFor` of the
	 * guidance and `ctx.model.id` while the session runs both methods, else `default`, because with one method
	 * there is nothing to choose between. It changes only with the guidance, the methods or the model.
	 */
	steer(ctx: ExtensionContext): Steer;
	/** Copy the state the next live per-turn pass would read, without creating or changing it. */
	snapshotTurnMemory(ctx: ExtensionContext): FoldTurnMemory;
	/** Plan a fold now; in live mode, queue it for the next boundary. */
	request(ctx: ExtensionContext, request: FoldRequest): FoldRequestResult;
	/** Requests waiting for the next boundary. */
	pending(ctx: ExtensionContext): number;
	/** Requests dropped in the last drained batch (and records too large to recover), with the reason. */
	dropped(ctx: ExtensionContext): readonly DroppedFold[];
	/** What the recipe's stages did on the latest request and since the session started (pi-context-aware#472). */
	strategy(ctx: ExtensionContext): StrategyReport;
	/**
	 * A compaction a plan source asks for (Pi's preparation, the model's `context_compact`), as a plan for the
	 * recipe's compaction stage, checked before its summary is written (pi-context-aware#472). `undefined` when it
	 * cannot be checked (no view and no rival owner, or no entry to replace), so the compaction goes ahead as asked.
	 * The range names the entries the summary replaces; without it, every entry of the view.
	 */
	compaction(ctx: ExtensionContext, request: { readonly writer: Exclude<SummaryWriter, "plan">; readonly firstKeptEntryId?: string }): StageRun["compaction"] | undefined;
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
	/**
	 * The latest request's pressure (pi-context-aware#461), with what it measured: the newest compaction on the
	 * branch and the window. It is read only while both still hold.
	 */
	const pressures = new WeakMap<SessionKey, { readonly pressure: RequestPressure; readonly compactionId: string | undefined; readonly window: number }>();
	/** The latest request's non-persisted injection, so the provider payload can keep the cache breakpoint before it. */
	const injections = new WeakMap<SessionKey, string>();
	const noteInjection = (ctx: ExtensionContext, text: string | undefined): void => {
		if (text) injections.set(ctx.sessionManager, text);
		else injections.delete(ctx.sessionManager);
	};

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
		const strategy = sessionStrategyFor(ctx, tools);
		const engine = engineOfMethods(strategy.methods);
		const mode = foldModeForEngine(engine);
		modes.set(ctx.sessionManager, mode);
		reports.set(ctx.sessionManager, { engine, contradictsPresence: strategy.contradictsPresence, strategy });
		return mode;
	};
	/**
	 * A new session whose guidance `strategy.assign` drew records the draw on its branch (pi-context-aware#473), so a
	 * resume or a fork keeps it. The entry is never sent to the model. Read again after writing, so the report says
	 * the assignment is recorded.
	 */
	const recordAssignment = (ctx: ExtensionContext): void => {
		const strategy = engineOf(ctx).strategy;
		const assignment = strategy.assignment;
		if (!assignment || assignment.recorded) return;
		const append = (pi as unknown as { appendEntry?: (customType: string, data?: unknown) => void }).appendEntry;
		if (typeof append !== "function") return;
		try {
			append.call(pi, ASSIGNMENT_ENTRY_TYPE, assignmentEntryData({ guidance: strategy.guidance, seed: assignment.seed, variants: assignment.variants, drawnFor: assignment.drawnFor }));
		} catch (error) {
			try { options.onViewError?.(ctx, `assignment: ${oneLine(error instanceof Error ? error.message : String(error), MAX_VIEW_ERROR_CHARS)}`); } catch { /* A log never changes the session. */ }
			return;
		}
		modes.delete(ctx.sessionManager);
		reports.delete(ctx.sessionManager);
		modeOf(ctx);
	};
	const engineOf = (ctx: ExtensionContext): EngineReport => {
		const mode = modeOf(ctx);
		return reports.get(ctx.sessionManager) ?? {
			engine: mode === "live" ? "folds" : "compaction-only",
			contradictsPresence: false,
			strategy: { methods: mode === "live" ? DEFAULT_METHODS : toMethodSet(["compact"])!, source: "auto", shadow: [], guidance: "default", contradictsPresence: false, errors: [] },
		};
	};
	const steerOf = (ctx: ExtensionContext): Steer => {
		const strategy = engineOf(ctx).strategy;
		if (!hasMethod(strategy.methods, "fold") || !hasMethod(strategy.methods, "compact")) return "default";
		return steerFor(strategy.guidance, ctx.model?.id);
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
		pressures.delete(manager);
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
		recordAssignment(ctx);
		// An unknown method or a removed setting fails clearly at load (REQ-STRAT-011): reported once, here.
		const strategy = engineOf(ctx).strategy;
		const lines = strategyErrorLines(strategy);
		if (lines.length > 0) {
			try { options.onStrategyErrors?.(ctx, lines); } catch { /* A failed notice never changes the session. */ }
		}
		const notes = strategyDebugLines(strategy);
		if (notes.length > 0) {
			try { options.onStrategyDebug?.(ctx, notes); } catch { /* A log never changes the session. */ }
		}
	});
	// Moving to another point of the session tree changes the branch. Requests
	// queued for the old branch must not be written to the new one.
	pi.on("session_tree", (_event, ctx) => rebuildQueue(ctx));

	/** The newest compaction on the branch: a compaction after a request changes what its pressure measured. */
	const latestCompactionId = (ctx: ExtensionContext): string | undefined => {
		try {
			const branch = ctx.sessionManager.getBranch();
			for (let i = branch.length - 1; i >= 0; i--) if (branch[i]?.type === "compaction") return branch[i]!.id;
		} catch { /* A branch that cannot be read has no compaction to compare. */ }
		return undefined;
	};
	const ladderOf = (ctx: ExtensionContext): PressureLadderConfig | undefined => options.ladder?.(ctx);
	/** The entry count every request pressure carries (pi-context-aware#441); a lookup that throws reports none. */
	const entriesOf = (ctx: ExtensionContext): EntryPressure | null => {
		try { return options.entries?.(ctx) ?? null; } catch { return null; }
	};
	/** Pi's usage as a request pressure: the count of the view Pi sends when the fold pass does not change it. */
	const hostPressure = (ctx: ExtensionContext): RequestPressure | null => {
		let tokens: number | null | undefined;
		try {
			const usage = ctx.getContextUsage?.();
			if (!usage) return null;
			tokens = usage.tokens;
		} catch {
			return null;
		}
		const measured = typeof tokens === "number" && Number.isFinite(tokens);
		return requestPressure({ tokens: measured ? tokens! : 0, window: contextWindow(ctx), measured, source: "host", entries: entriesOf(ctx) }, ladderOf(ctx));
	};
	/** The action line for a request's pressure, naming only `named`, or else the tools this session can call. */
	const actionLine = (ctx: ExtensionContext, pressure: RequestPressure, named?: NudgeTools): string | undefined => {
		let mode: PressureTelemetryMode = "full";
		try { mode = options.telemetryMode?.(ctx) ?? "full"; } catch { /* The default mode. */ }
		if (mode === "off" || (pressure.band !== "WARN" && pressure.band !== "URGENT")) return undefined;
		const tools = named ?? FOLD_ONLY;
		let replacementTool: string | undefined;
		try { replacementTool = options.replacementTool?.(ctx); } catch { /* A lookup that throws names no replacement. */ }
		return pressureActionLine(pressure, { mode, tools, foldTool: FOLD_TOOL_NAME, ...(replacementTool ? { replacementTool } : {}) });
	};
	/**
	 * Record the request's pressure, when something counted it, and report the request to the metrics log, which
	 * writes one record per request even when nothing counted it.
	 */
	const settle = (ctx: ExtensionContext, turn: FoldTurnResult | undefined, pressure: RequestPressure | null, passFailed: boolean): void => {
		if (pressure) pressures.set(ctx.sessionManager, { pressure, compactionId: latestCompactionId(ctx), window: contextWindow(ctx) });
		// The request's stage outcomes (pi-context-aware#473): each path runs the stages before it settles.
		const stages = requestStages.get(ctx.sessionManager) ?? [];
		requestStages.delete(ctx.sessionManager);
		try {
			const strategy = engineOf(ctx).strategy;
			options.metrics?.onTurn?.(ctx, turn, pressure, passFailed, { strategy: { methods: strategy.methods, source: strategy.source, shadow: strategy.shadow, guidance: strategy.guidance }, stages, steer: steerOf(ctx) });
		} catch { /* Metrics never change a request. */ }
	};
	/** The request with the action line appended, when there is one. Not persisted: it lives in this request only. */
	const withLine = (messages: Message[], line: string | undefined): Message[] =>
		line === undefined ? messages : [...messages, { role: "user", content: [{ type: "text", text: line }], timestamp: Date.now() } as Message];

	// -- The session recipe's stages (pi-context-aware#472) ---------------------------------
	const strategyRuns = new WeakMap<SessionKey, { last: readonly StageRecord[]; counts: Map<string, number> }>();
	/** The stage outcomes of the request being prepared, for its metrics record; `settle` takes them. */
	const requestStages = new WeakMap<SessionKey, readonly StageReport[]>();
	const reportOf = (trigger: StageReport["trigger"], records: readonly StageRecord[]): StageReport[] =>
		records.map((record) => ({ trigger, recipe: record.recipe, role: record.role, stage: record.stage, outcome: record.outcome, codes: record.codes }));
	/** Most distinct record keys counted per session; the recipes' stages are few, so this only bounds a misbehaving one. */
	const MAX_COUNTED_KEYS = 64;
	const noteRun = (ctx: ExtensionContext, records: readonly StageRecord[]): void => {
		const manager = ctx.sessionManager;
		const state = strategyRuns.get(manager) ?? { last: [], counts: new Map<string, number>() };
		state.last = records;
		for (const record of records) {
			const key = `${record.role} ${record.recipe}/${record.stage} ${record.outcome}`;
			if (state.counts.has(key) || state.counts.size < MAX_COUNTED_KEYS) state.counts.set(key, (state.counts.get(key) ?? 0) + 1);
		}
		strategyRuns.set(manager, state);
	};
	/** A compaction's stage outcomes, for the metrics record of the request in flight (pi-context-aware#473). */
	const reportStages = (ctx: ExtensionContext, stages: readonly StageReport[]): void => {
		try { options.metrics?.onStages?.(ctx, stages); } catch { /* Metrics never change a compaction. */ }
	};
	/** The view's tool names; a lookup that throws reaches no tool. */
	const viewTools = (ctx: ExtensionContext): { readonly reachable: readonly string[]; readonly registered: readonly string[] } => {
		let registered: string[] = [];
		try { registered = pi.getAllTools().map((tool) => tool.name); } catch { /* None can be read while extensions load. */ }
		if (options.tools) {
			try { return options.tools(ctx); } catch { return { reachable: [], registered }; }
		}
		return { reachable: [FOLD_TOOL_NAME], registered };
	};
	const ownerOf = (ctx: ExtensionContext): ViewCompactionOwner => {
		try { return options.compactionOwner?.(ctx) ?? "none"; } catch { return "none"; }
	};
	/** The frozen view of a request of `tokens` tokens over the branch as it is now, or over `parts` the pass already read. */
	const viewOf = (ctx: ExtensionContext, tokens: number, parts?: { readonly branch: readonly SessionEntry[]; readonly contextEntries: readonly SessionEntry[]; readonly projection: ReturnType<SessionManager["buildSessionProjection"]> }): ContextView => {
		const manager = ctx.sessionManager;
		const tools = viewTools(ctx);
		const hints = options.hints?.(ctx);
		return buildContextView({
			branch: parts?.branch ?? manager.getBranch(),
			// A host without the projection readers (an older Pi, a test double) gives a view with no entries; its pressure and tools still hold.
			contextEntries: parts?.contextEntries ?? (typeof manager.buildContextEntries === "function" ? manager.buildContextEntries() : manager.getBranch()),
			projection: parts?.projection ?? (typeof manager.buildSessionProjection === "function" ? manager.buildSessionProjection() : { entries: [] }),
			model: { id: String(ctx.model?.id ?? "unknown"), contextWindow: contextWindow(ctx) },
			tokens,
			reachableTools: tools.reachable,
			registeredTools: tools.registered,
			...(hints ? { hints } : {}),
			...(options.config ? { config: options.config } : {}),
			folds: resolveFoldConfig(ctx),
			now: Date.now(),
			compactionOwner: ownerOf(ctx),
		});
	};
	/**
	 * A view with no entries: the request's pressure and tools only. When the full view cannot be built, a request's
	 * says are checked on it, so the nudge and the pressure note still reach the request as they did before the
	 * strategy contract. Only says apply on a request, so the entries, hints and owner it leaves out decide nothing.
	 */
	const bareViewOf = (ctx: ExtensionContext, tokens: number): ContextView => {
		const tools = viewTools(ctx);
		return buildContextView({
			branch: [],
			contextEntries: [],
			projection: { entries: [] },
			model: { id: String(ctx.model?.id ?? "unknown"), contextWindow: contextWindow(ctx) },
			tokens,
			reachableTools: tools.reachable,
			registeredTools: tools.registered,
			folds: resolveFoldConfig(ctx),
			now: Date.now(),
			compactionOwner: "none",
		});
	};
	/** The record of a view that could not be built, and the log line for it. */
	const viewFailed = (ctx: ExtensionContext, recipe: string, trigger: "request" | "compaction", error: unknown): StageRecord => {
		const line = `${trigger}: ${oneLine(error instanceof Error ? error.message : String(error), MAX_VIEW_ERROR_CHARS)}`;
		try { options.onViewError?.(ctx, line); } catch { /* A log never changes the request. */ }
		return { recipe, role: "active", stage: "view", timing: null, ops: [], outcome: "failed", codes: [] };
	};
	/** Plans a stage's `summarize` on the branch as it is now; built only when a plan holds one. */
	const lazySummarize = (ctx: ExtensionContext): SummarizeEngine => {
		let engine: SummarizeEngine | undefined;
		return (op) => {
			engine ??= summarizeEngine({
				branch: ctx.sessionManager.getBranch(),
				contextEntries: ctx.sessionManager.buildContextEntries(),
				modelContextLimit: contextWindow(ctx),
				folds: resolveFoldConfig(ctx),
				...condenserField(condenserFor(ctx)?.(ctx.sessionManager.getBranch())),
				...hintsField(options.hints?.(ctx)),
				...(options.config ? { config: options.config } : {}),
			});
			return engine(op);
		};
	};
	/** The pressure line as a signal: present at WARN or URGENT, rendered for the tools a stage names. */
	const lineSignal = (ctx: ExtensionContext, pressure: RequestPressure | null | undefined): RequestSignals["pressureLine"] =>
		pressure && actionLine(ctx, pressure) !== undefined ? { render: (tools) => actionLine(ctx, pressure, tools) } : undefined;
	/**
	 * The texts the session's recipe injects into a request of `tokens` tokens: run its request stages, and its
	 * shadow recipes', on one view. The view is built only when a stage could want something.
	 */
	const requestSays = (ctx: ExtensionContext, tokens: number, signals: RequestSignals, parts?: Parameters<typeof viewOf>[2]): string[] => {
		const strategy = engineOf(ctx).strategy;
		const active = composeRecipe(strategy.methods, () => signals);
		const shadow = strategy.shadow.map((methods) => composeRecipe(methods, () => signals));
		const signalled = signals.growthNudge !== undefined || signals.pressureLine !== undefined;
		if (!signalled && [active, ...shadow].every(wantsOnlyOnSignals)) {
			noteRun(ctx, []);
			requestStages.set(ctx.sessionManager, []);
			return [];
		}
		let view: ContextView;
		const failed: StageRecord[] = [];
		try {
			view = viewOf(ctx, tokens, parts);
		} catch (error) {
			// The failure is recorded and logged, and the says are checked on a view with no entries, so the
			// nudge and the pressure note still reach the request. Without even that view nothing is injected.
			failed.push(viewFailed(ctx, active.id, "request", error));
			try {
				view = bareViewOf(ctx, tokens);
			} catch {
				noteRun(ctx, failed);
				requestStages.set(ctx.sessionManager, reportOf("request", failed));
				return [];
			}
		}
		const run = runStages({ active, shadow, view, engine: lazySummarize(ctx), trigger: { kind: "request" } });
		noteRun(ctx, [...failed, ...run.records]);
		requestStages.set(ctx.sessionManager, reportOf("request", [...failed, ...run.records]));
		return [...run.says];
	};

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
			const preview = SessionManager.inMemory(manager.getCwd(), undefined, [header, ...hidePreviewChain(branch, plans, pending)]);
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
			try { options.metrics?.onDrain?.(ctx, planned.dropped, { freedTokens: foldsFreedTokens(planned.drafts) }); } catch { /* Metrics never change a boundary. */ }
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
		if (modeOf(ctx) !== "live") {
			// No fold pass, and no failed one: the request is Pi's view, and Pi's usage counts it.
			const pressure = hostPressure(ctx);
			const messages = withoutRetiredUsageMarkers(event.messages);
			if (!Array.isArray(messages)) {
				settle(ctx, undefined, pressure, false);
				noteInjection(ctx, undefined);
				return undefined;
			}
			// The recipe's pressure-note stage says the line (pi-context-aware#472), before the request settles so
			// its metrics record carries the stage outcomes (pi-context-aware#473).
			const line = joinSays(pressure ? requestSays(ctx, pressure.tokens, { ...optionalSignal("pressureLine", lineSignal(ctx, pressure)) }) : []);
			settle(ctx, undefined, pressure, false);
			noteInjection(ctx, line);
			const sent = withLine(messages, line);
			return sent === event.messages ? undefined : { messages: sent };
		}
		const manager = ctx.sessionManager;
		const branch = manager.getBranch();
		try {
			let memory = turnMemory.get(manager);
			if (!memory) turnMemory.set(manager, memory = createFoldTurnMemory());
			const { turn, pressure } = runPass(ctx, event.messages, memory, branch);
			if (turn?.emergency?.hideCandidates.length) {
				const queued = hideQueues.get(manager) ?? new Set<string>();
				for (const id of turn.emergency.hideCandidates) queued.add(id);
				hideQueues.set(manager, queued);
			}
			if (turn?.emergency) {
				try { options.onEmergency?.(ctx, turn.emergency); } catch { /* A failed notice never changes the request. */ }
			}
			if (turn && pressure) {
				settle(ctx, turn, pressure, false);
				noteInjection(ctx, joinSays(turn.says ?? []));
				// The pass ran over Pi's whole view, so its entries line up; retired markers leave only the request.
				return { messages: withoutRetiredUsageMarkers(turn.messages) };
			}
		} catch {
			// The pass failed: still send the block pointers, so no summary is repeated.
		}
		// No pass result: the request is Pi's view with block pointers, and Pi's usage counts it.
		const fallback = hostPressure(ctx);
		// A stage run of the failed pass is not this request's; the fallback's own run, if any, replaces it.
		requestStages.delete(manager);
		try {
			const records = foldRecordsOnBranch(branch).map(({ record }) => record);
			const rendered = renderEarlierFoldCalls(withoutRetiredUsageMarkers(event.messages), records);
			if (!Array.isArray(rendered)) {
				noteInjection(ctx, undefined);
				return undefined;
			}
			const line = joinSays(fallback ? requestSays(ctx, fallback.tokens, { ...optionalSignal("pressureLine", lineSignal(ctx, fallback)) }) : []);
			noteInjection(ctx, line);
			const messages = withLine(rendered, line);
			return messages === event.messages ? undefined : { messages };
		} catch {
			// This path exists for things going wrong: a request it cannot render goes as Pi built it.
			noteInjection(ctx, undefined);
			return undefined;
		} finally {
			settle(ctx, undefined, fallback, true);
		}
	});

	/**
	 * The per-turn pass over `messages`, the request Pi sends. Its count of that request, before it truncates or
	 * hides anything, is the request's pressure, returned with the result; the pass injects the pressure's action
	 * line with the nudge.
	 */
	const runPass = (ctx: ExtensionContext, messages: Message[], memory: FoldTurnMemory, branch: readonly SessionEntry[], stages = true): { turn: FoldTurnResult | undefined; pressure: RequestPressure | undefined } => {
		const manager = ctx.sessionManager;
		const usage = ctx.getContextUsage?.();
		let pressure: RequestPressure | undefined;
		const projection = manager.buildSessionProjection();
		const contextEntries = manager.buildContextEntries();
		const measure = (tokenCount: number): RequestPressure =>
			pressure = requestPressure({ tokens: tokenCount, window: contextWindow(ctx), measured: typeof usage?.tokens === "number", source: "fold-pass", entries: entriesOf(ctx) }, ladderOf(ctx));
		// The recipe's stages say every text the request carries (pi-context-aware#472); a preview runs none.
		const injection: Pick<FoldTurnInput, "stages"> = {
			stages: (request) => {
				const measured = measure(request.tokenCount);
				if (!stages) return [];
				return requestSays(ctx, request.tokenCount, {
					...optionalSignal("growthNudge", request.growthNudge),
					...optionalSignal("pressureLine", lineSignal(ctx, measured)),
				}, { branch, contextEntries, projection });
			},
		};
		const turn = prepareFoldTurn({
			messages,
			projection,
			branch,
			contextEntries,
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
			offerExclusions: offerExclusions(ctx, branch),
			steer: steerOf(ctx),
			...injection,
		});
		return { turn, pressure };
	};

	/**
	 * The pressure of the request the session would send now (pi-context-aware#461): the same pass over the current
	 * branch, on a copy of the turn memory, so it changes nothing. A compaction decision between requests reads it.
	 * Within a tool loop the next request's pass computes the same count; at a prompt boundary that pass also
	 * counts the new prompt and what other hooks add. Recorded as the latest pressure.
	 */
	const nextPressure = (ctx: ExtensionContext): RequestPressure | null => {
		let pressure: RequestPressure | null | undefined;
		if (modeOf(ctx) === "live") {
			try {
				const manager = ctx.sessionManager;
				const memory = cloneFoldTurnMemory(turnMemory.get(manager) ?? createFoldTurnMemory());
				const messages = buildSessionContext(manager.getEntries(), manager.getLeafId()).messages as Message[];
				pressure = runPass(ctx, messages, memory, manager.getBranch(), false).pressure;
			} catch {
				// The pass failed: the request would be Pi's view, which Pi's usage counts.
			}
		}
		pressure ??= hostPressure(ctx);
		if (pressure) pressures.set(ctx.sessionManager, { pressure, compactionId: latestCompactionId(ctx), window: contextWindow(ctx) });
		return pressure;
	};

	/** Entries no range may be offered over: those queued folds take, those a `verbatim` hint keeps, and the kept opening user message (pi-context-aware#457). */
	const offerExclusions = (ctx: ExtensionContext, branch: readonly SessionEntry[]): string[] => {
		const pending = (queues.get(ctx.sessionManager) ?? []).flatMap((item) =>
			isRecoveredItem(item) ? item.recovery.coveredEntryIds : item.accepted?.source.coveredEntryIds ?? []);
		// A fold keeps the opening user message visible under the default policy, so it is never offered either.
		const keptFirst = keptFirstUserId(branch, resolveFoldConfig(ctx));
		return [...new Set([...pending, ...verbatimEntryIds(branch, options.hints?.(ctx)), ...(keptFirst ? [keptFirst] : [])])];
	};

	/** A refusal with the ranges the model can fold instead. A failure to compute them leaves the refusal as it is. */
	const withOfferedRanges = (ctx: ExtensionContext, failure: FoldRequestFailure): FoldRequestFailure => {
		try {
			const branch = ctx.sessionManager.getBranch();
			const offeredRanges = offeredFoldRanges({
				branch,
				contextEntries: ctx.sessionManager.buildContextEntries(),
				modelContextLimit: contextWindow(ctx),
				...(options.config ? { config: options.config } : {}),
				excludedEntryIds: offerExclusions(ctx, branch),
			});
			return { ...failure, offeredRanges };
		} catch {
			return failure;
		}
	};

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
		steer: steerOf,
		pressure: (ctx) => {
			const latest = pressures.get(ctx.sessionManager);
			// After a compaction or a model switch the latest request no longer describes the context: Pi's usage does.
			return latest && latest.compactionId === latestCompactionId(ctx) && latest.window === contextWindow(ctx) ? latest.pressure : hostPressure(ctx);
		},
		nextPressure,
		injection: (ctx) => injections.get(ctx.sessionManager),
		snapshotTurnMemory: (ctx) => {
			const memory = turnMemory.get(ctx.sessionManager);
			return memory ? cloneFoldTurnMemory(memory) : createFoldTurnMemory();
		},
		pending: (ctx) => queues.get(ctx.sessionManager)?.length ?? 0,
		dropped: (ctx) => [...(scanDrops.get(ctx.sessionManager) ?? []), ...(dropped.get(ctx.sessionManager) ?? [])],
		request(ctx, request) {
			const planned = requestFold(ctx, request);
			const result = planned.ok ? planned : withOfferedRanges(ctx, planned);
			try { options.metrics?.onRequest?.(ctx, result); } catch { /* Metrics never change an answer. */ }
			return result;
		},
		strategy: (ctx) => {
			const state = strategyRuns.get(ctx.sessionManager);
			return { last: state?.last ?? [], counts: Object.fromEntries([...(state?.counts ?? new Map<string, number>())].sort(([a], [b]) => a.localeCompare(b))) };
		},
		compaction(ctx, request) {
			const strategy = engineOf(ctx).strategy;
			const signals: RequestSignals = {};
			const active = composeRecipe(strategy.methods, () => signals);
			let view: ContextView;
			try {
				view = viewOf(ctx, currentTokens(ctx));
			} catch (error) {
				// No view: recorded and logged. A rival that holds the compaction claim still gets the compaction;
				// otherwise it goes ahead as the host asked, since a compaction the host needs is never blocked by a failed read.
				const failed = [viewFailed(ctx, active.id, "compaction", error)];
				noteRun(ctx, failed);
				reportStages(ctx, reportOf("compaction", failed));
				return ownerOf(ctx) === "other" ? "refused" : undefined;
			}
			const kept = request.firstKeptEntryId === undefined ? -1 : view.entries.findIndex((entry) => entry.id === request.firstKeptEntryId);
			const covered = kept >= 0 ? view.entries.slice(0, kept) : view.entries;
			const first = covered[0];
			const last = covered[covered.length - 1];
			if (!first || !last) return undefined;
			const run = runStages({
				active,
				shadow: strategy.shadow.map((methods) => composeRecipe(methods, () => signals)),
				view,
				engine: lazySummarize(ctx),
				trigger: { kind: "compaction", startId: first.id, endId: last.id, writer: request.writer },
			});
			noteRun(ctx, run.records);
			reportStages(ctx, reportOf("compaction", run.records));
			return run.compaction;
		},
	};

	/** The latest request's count, else Pi's usage, else nothing measured. */
	function currentTokens(ctx: ExtensionContext): number {
		return pressures.get(ctx.sessionManager)?.pressure.tokens ?? hostPressure(ctx)?.tokens ?? 0;
	}

	/**
	 * A `context_fold` request as a plan (pi-context-aware#472): one `summarize` operation with the model's summary,
	 * checked by `checkPlan` against the view of the branch as it is now. The fold engine plans it with the
	 * request's refs, which stand for the entries they name; its refusals and records are `planFold`'s. A view
	 * that cannot be built refuses the request.
	 */
	function checkedFold(ctx: ExtensionContext, input: FoldPlanInput): FoldPlan {
		let planned: ReturnType<typeof planFoldCoded> | undefined;
		const engine: SummarizeEngine = () => {
			planned = planFoldCoded(input);
			return planned.ok ? planned : { ok: false, refusals: planned.refusals };
		};
		const validRefs = (): string[] => (planned && !planned.ok ? planned.validRefs : validFoldRefs(foldStateFromBranch(input.branch, input.contextEntries)));
		let view: ContextView;
		try {
			view = viewOf(ctx, currentTokens(ctx), { branch: input.branch, contextEntries: input.contextEntries ?? ctx.sessionManager.buildContextEntries(), projection: ctx.sessionManager.buildSessionProjection() });
		} catch (error) {
			// The host's error reaches the model: one clipped line, with the next step after it (CR-REFUSAL-TEXT).
			const reason = oneLine(error instanceof Error ? error.message : String(error), MAX_VIEW_ERROR_CHARS);
			return { ok: false, errors: [`The session could not be read for the plan check, so nothing was folded (${reason}). Continue the task and fold this range again on a later turn.`], validRefs: validRefs() };
		}
		const check = checkPlan(view, [{ kind: "summarize", startId: input.startRef, endId: input.endRef, ...(input.topic ? { topic: input.topic } : {}), writer: "plan", summary: input.summary }], engine);
		if (check.ok && planned?.ok) return planned;
		return { ok: false, errors: check.ok ? ["The engine created no fold for this range."] : check.refusals.map((refusal) => refusal.message), validRefs: validRefs() };
	}

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
			const input: FoldPlanInput = {
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
				compactOffered: hasMethod(engineOf(ctx).strategy.methods, "compact"),
			};
			// The model's fold is a plan the plan checker checks, like any other (pi-context-aware#472).
			const plan = checkedFold(ctx, input);
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

/** The stages' says as the one injected message's text; undefined when there are none. */
function joinSays(says: readonly string[]): string | undefined {
	return says.length > 0 ? says.join("\n\n") : undefined;
}

function optionalSignal<K extends keyof RequestSignals>(key: K, signal: RequestSignals[K] | undefined): Partial<Pick<RequestSignals, K>> {
	return (signal === undefined ? {} : { [key]: signal }) as Partial<Pick<RequestSignals, K>>;
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
/** The longest host error a fold refusal quotes when the session could not be read for the plan check. */
const MAX_VIEW_ERROR_CHARS = 200;
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

/**
 * The entries a hide preview needs, relinked into one short chain. Pi checks a context edit by walking the
 * whole active branch, once per edit; on a long session a full-branch preview made each hide cost a branch
 * walk. Pi's check only asks whether the target exists, sits on the active branch and is editable, so a
 * chain of the edit targets alone gives the same answers in time bounded by the number of edits.
 */
export function hidePreviewChain(
	branch: readonly SessionEntry[],
	plans: readonly { readonly targetId: string }[],
	pending: readonly SessionBoundaryDraft[],
): SessionEntry[] {
	const targets = new Set<string>(plans.map((plan) => plan.targetId));
	for (const draft of pending) if (draft.type === "context_edit") targets.add(draft.targetId);
	const chain: SessionEntry[] = [];
	let parentId: string | null = null;
	for (const entry of branch) {
		if (!targets.has(entry.id)) continue;
		chain.push({ ...entry, parentId } as SessionEntry);
		parentId = entry.id;
	}
	return chain;
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
