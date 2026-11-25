/**
 * The context strategy contract, version 1 (pi-context-aware#467, parent pi-context-aware#465).
 *
 * A strategy reads one frozen `ContextView` per request and returns plans as data. Only the runtime
 * (src/strategy-runtime) builds views, checks a plan and writes the session; nothing under src/strategy
 * can, and a structural test holds src/strategy to importing only itself. Internal to this package: no
 * package entry point re-exports it, and nothing live calls it yet (pi-context-aware#472 wires it).
 *
 * Version 1 has no hook for per-turn notes written at write time or for plans prepared ahead of a
 * request. Adding either bumps `STRATEGY_CONTRACT_VERSION`.
 */

export const STRATEGY_CONTRACT_VERSION = 1 as const;
export type StrategyContractVersion = typeof STRATEGY_CONTRACT_VERSION;

/** The role of the message an entry contributes to the request, as Pi projects it. `other` for any role this version does not name. */
export type ViewRole = "user" | "assistant" | "toolResult" | "custom" | "bashExecution" | "compactionSummary" | "branchSummary" | "other";

/** The fold hint an entry resolves to (pi-context-aware#281); `null` when none applies. */
export type ViewHint = "verbatim" | "one-line" | "condensed" | "drop-after-read";

/** One model-visible entry of the request, in request order. */
export interface ViewEntry {
	/** Session entry id. Plans name entries by this id. */
	readonly id: string;
	readonly role: ViewRole;
	/**
	 * Estimated tokens of what the model sees for this entry: its text and tool-call arguments, after
	 * context edits, plus the fold pass's fixed estimate for each image part. Same units as `pressure`:
	 * see `ContextView.unownedTokens`.
	 */
	readonly tokens: number;
	readonly hint: ViewHint | null;
	/** Tool results: the tool's name and the call id it answers. */
	readonly toolName?: string;
	readonly toolCallId?: string;
	/** Assistant entries: ids of the tool calls they make, in order. A plan must not separate a call from its result. */
	readonly toolCallIds?: readonly string[];
}

/** A fold in effect on the branch: not absorbed by a later, higher-tier fold. */
export interface ViewFold {
	readonly blockId: string;
	readonly tier: number;
	readonly topic: string | null;
	/** Entry whose model-visible content the fold's summary replaces. */
	readonly carrierId: string;
	/** Covered entries the fold leaves out of the request, in branch order. */
	readonly hiddenIds: readonly string[];
	readonly startId: string;
	readonly endId: string;
	readonly compressedTokens: number;
}

/** A recoverable hide in effect on the branch (pi-context-aware#268). */
export interface ViewHide {
	readonly hideId: string;
	readonly targetId: string;
	readonly originalTokens: number;
}

/**
 * Everything a strategy may read for one request. Deep-frozen: no field can be changed, and no field
 * is a function or a reference to the session, the extension API or the input it was built from.
 */
export interface ContextView {
	readonly entries: readonly ViewEntry[];
	/**
	 * The request's one pressure value: the fold pass's token count over the model's context window.
	 * Every strategy reads this value and no other measure of fullness (REQ-STRAT-009).
	 */
	readonly pressure: number;
	/**
	 * Tokens of the request no entry owns: the system prompt, tool schemas, and what the host-usage floor
	 * adds over the estimate. The relation is exact: the sum of `entries[i].tokens` plus `unownedTokens`
	 * is the fold pass's token count, which is `pressure * model.contextWindow`. It can be negative when
	 * the fold pass counts less than the entries hold, for example when it drops images from the request.
	 */
	readonly unownedTokens: number;
	/** Milliseconds since the branch's latest assistant message, the last request that could have filled the prompt cache; `null` before the first. */
	readonly cacheAgeMs: number | null;
	readonly model: { readonly id: string; readonly contextWindow: number };
	/** Tool names the session can call now, sorted. A `say` may name only these. */
	readonly tools: readonly string[];
	/**
	 * Every tool name the session has registered, reachable now or not, sorted; it holds every name in
	 * `tools`. A `say` that names one of these outside `tools` is refused (REQ-STRAT-008); a word that
	 * is no registered tool's name is prose.
	 */
	readonly registeredTools: readonly string[];
	readonly folds: readonly ViewFold[];
	readonly hides: readonly ViewHide[];
	/**
	 * Entries of `entries` no plan may change, in request order: the protected zone of recent turns kept
	 * word for word (pi-context-aware#284), with the entries and tool-call partners a fold would withdraw
	 * beside it, exactly as `planFold` refuses them; the opening user message the fold policy keeps; and
	 * entries a `verbatim` fold hint keeps.
	 */
	readonly protectedEntryIds: readonly string[];
	/**
	 * Who holds the compaction-owner claim (src/compaction/owner-claim.ts): this package (`self`), another
	 * owner that holds it against this package (`other`), or nobody (`none`). While another owner holds
	 * it, the runtime refuses a compaction, so that owner writes the summary (the one-writer rule). Folds, stubs
	 * and says are not compactions and the claim does not refuse them.
	 */
	readonly compactionOwner: ViewCompactionOwner;
}

export type ViewCompactionOwner = "self" | "other" | "none";

/** Who writes a summary: the plan itself, or a runtime writer the plan names (pi-context-aware#436). */
export type SummaryWriter = "plan" | "main" | "cheap" | "mechanical";

/**
 * Replace the entries from `startId` to `endId`, inclusive, with one summary, under an optional topic. An
 * active fold's `blockId` may stand for an end: the fold is folded again, at the next tier.
 */
export type SummarizeOp =
	| { readonly kind: "summarize"; readonly startId: string; readonly endId: string; readonly topic?: string; readonly writer: "plan"; readonly summary: string }
	| { readonly kind: "summarize"; readonly startId: string; readonly endId: string; readonly topic?: string; readonly writer: Exclude<SummaryWriter, "plan"> };

/** Replace one entry's content with short text. The runtime appends the `context_recall` pointer; the plan does not write it. */
export interface StubOp {
	readonly kind: "stub";
	readonly entryId: string;
	readonly text: string;
}

/**
 * A message sent with this request only and never persisted, such as a nudge. Of the tools in
 * `ContextView.registeredTools`, it may name only those in `ContextView.tools`.
 *
 * `quoted` lists parts of `text` the message quotes from the session, such as a line that prints a fold's
 * topic as the model wrote it. The checker does not read tool names inside them, so a topic that names a
 * tool is not an offer of it; the rest of the text is checked as usual.
 */
export interface SayOp {
	readonly kind: "say";
	readonly text: string;
	readonly quoted?: readonly string[];
}

export type PlanOp = SummarizeOp | StubOp | SayOp;

/** What a stage asks the runtime to do, in order. An empty plan does nothing. */
export type ContextPlan = readonly PlanOp[];

/**
 * The rules the runtime checks every plan against (pi-context-aware#465). `range` covers a plan that names
 * entries or refs the request does not hold, or too little content to fold; `engine` covers a fold engine
 * refusal that names no rule.
 */
export type RefusalRule =
	| "tool-pairs" | "protected-zone" | "recoverable" | "fold-hints" | "summary-bounds" | "already-folded"
	| "one-writer" | "reachable-tools" | "provenance" | "range" | "engine";

/** Stable reason codes: a refusal's code does not change when its message is reworded. */
export type RefusalCode =
	| "split-pair"
	| "protected-zone" | "first-user-kept"
	| "unrecoverable" | "forged-pointer"
	| "kept-verbatim" | "condenses-instead"
	| "summary-empty" | "summary-short" | "summary-long" | "summary-stub" | "summary-unwritten"
	| "already-folded"
	| "owner-claimed"
	| "unreachable-tool"
	| "forged-role-turn"
	| "unknown-ref" | "dangling-ref" | "too-small" | "too-large"
	| "no-fold" | "header-missing" | "unrecognized";

/** The rule each code belongs to. */
export const REFUSAL_RULES: Readonly<Record<RefusalCode, RefusalRule>> = Object.freeze({
	"split-pair": "tool-pairs",
	"protected-zone": "protected-zone",
	"first-user-kept": "protected-zone",
	"unrecoverable": "recoverable",
	"forged-pointer": "recoverable",
	"kept-verbatim": "fold-hints",
	"condenses-instead": "fold-hints",
	"summary-empty": "summary-bounds",
	"summary-short": "summary-bounds",
	"summary-long": "summary-bounds",
	"summary-stub": "summary-bounds",
	"summary-unwritten": "summary-bounds",
	"already-folded": "already-folded",
	"owner-claimed": "one-writer",
	"unreachable-tool": "reachable-tools",
	"forged-role-turn": "provenance",
	"unknown-ref": "range",
	"dangling-ref": "range",
	"too-small": "range",
	"too-large": "range",
	"no-fold": "engine",
	"header-missing": "engine",
	"unrecognized": "engine",
});

/** Why the runtime refused one operation of a plan. */
export interface PlanRefusal {
	/** Index of the refused operation in the plan. */
	readonly op: number;
	readonly rule: RefusalRule;
	readonly code: RefusalCode;
	readonly message: string;
}

/** When a stage wants to act: on this request, at the next turn boundary, or once the prompt cache has gone cold. */
export type StageTiming = "now" | "at-boundary" | "when-cache-cold";

/** One step of a recipe. It owns its trigger (`wants`) and its nudge. */
export interface Stage {
	readonly id: string;
	/** `null`: the stage has nothing to do on this request. */
	readonly wants: (view: ContextView) => StageTiming | null;
	readonly plan: (view: ContextView) => ContextPlan;
	readonly nudge?: (view: ContextView) => SayOp | null;
	/** Tool names this stage exposes to the model. */
	readonly offers: readonly string[];
}

/** A strategy: ordered stages under one id. A session runs one recipe, chosen at start. */
export interface Recipe {
	readonly id: string;
	readonly contractVersion: StrategyContractVersion;
	readonly stages: readonly Stage[];
}
