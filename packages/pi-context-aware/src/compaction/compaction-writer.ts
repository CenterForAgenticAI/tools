import { COMPACTION_OWNER_NAME } from "./owner-identity.js";

export const CONTEXT_AWARE_COMPACTOR_VERSION = 1 as const;

export type CompactionWriterKind = "context-aware" | "fabric" | "extension" | "pi" | "malformed" | "none";

export interface CompactionWriterObservation {
	readonly kind: CompactionWriterKind;
	readonly name: string;
}

interface CompactionEntryView {
	readonly type?: unknown;
	readonly fromHook?: unknown;
	readonly details?: unknown;
}

const NONE: CompactionWriterObservation = Object.freeze({ kind: "none", name: "none" });
const MALFORMED: CompactionWriterObservation = Object.freeze({ kind: "malformed", name: "unknown (malformed metadata)" });
const PI: CompactionWriterObservation = Object.freeze({ kind: "pi", name: "Pi's own summarizer" });
const FABRIC: CompactionWriterObservation = Object.freeze({ kind: "fabric", name: "Fabric" });
const CONTEXT_AWARE: CompactionWriterObservation = Object.freeze({ kind: "context-aware", name: COMPACTION_OWNER_NAME });

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const UNSAFE_WRITER_NAME = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}]/u;

function isWriterName(value: unknown): value is string {
	return typeof value === "string"
		&& value.length >= 1
		&& value.length <= 128
		&& value.trim() === value
		&& !UNSAFE_WRITER_NAME.test(value);
}

function isEntryRange(value: unknown): boolean {
	return isRecord(value) && typeof value.first === "string" && typeof value.last === "string";
}

function isStringArray(value: unknown): boolean {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function hasFiniteNumbers(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return keys.every((key) => typeof value[key] === "number" && Number.isFinite(value[key]));
}

function isFabricV1Details(value: Record<string, unknown>): boolean {
	return isStringArray(value.sections)
		&& isEntryRange(value.summarizedEntryRange)
		&& typeof value.sourceEntryCount === "number"
		&& Number.isFinite(value.sourceEntryCount)
		&& typeof value.firstKeptEntryId === "string"
		&& typeof value.timestamp === "string";
}

function isCompactionBudgetDetails(value: unknown): boolean {
	if (!isRecord(value) || (value.strategy !== "adaptive" && value.strategy !== "continuity")) return false;
	if (!hasFiniteNumbers(value, [
		"contextWindow", "targetContextRatio", "targetContextTokens", "reserveTokens", "keepRecentTokens",
		"rawTokensBefore", "tokenScale", "fixedOverheadTokens", "retainedRawTokens", "projectedTokensAfter",
	])) return false;
	if (value.strategy === "adaptive") return true;
	return hasFiniteNumbers(value, [
		"continuityTargetTokens", "occupancyCeilingTokens", "safeCeilingTokens", "reductionCeilingTokens", "rawTailTokenBudget",
	]) && ["continuity", "occupancy", "reserve", "reduction"].includes(String(value.bindingConstraint));
}

function isFabricV2Details(value: Record<string, unknown>): boolean {
	if (!isStringArray(value.sections) || !isRecord(value.coverage) || !isRecord(value.counts)) return false;
	if (!isRecord(value.omittedCounts) || !isRecord(value.instructionPolicy) || !isRecord(value.stableAddresses)) return false;
	const instructionModes = new Set(["none", "plain", "typed-v1", "malformed-typed-prefix"]);
	return isEntryRange(value.coverage.cumulativeSourceRange)
		&& isEntryRange(value.coverage.liveCutRange)
		&& hasFiniteNumbers(value.counts, [
			"branchEntries", "cumulativeSourceEntries", "sourceEvents", "liveCutEntries", "priorFabricV1", "priorFabricV2",
		])
		&& hasFiniteNumbers(value.omittedCounts, ["goal", "files", "outstanding", "earlierTurns", "transcript", "preserve"])
		&& (value.omittedCounts.activity === undefined || (typeof value.omittedCounts.activity === "number" && Number.isFinite(value.omittedCounts.activity)))
		&& (value.omittedCounts.commits === undefined || (typeof value.omittedCounts.commits === "number" && Number.isFinite(value.omittedCounts.commits)))
		&& (value.omittedCounts.thinking === undefined || (typeof value.omittedCounts.thinking === "number" && Number.isFinite(value.omittedCounts.thinking)))
		&& (value.omittedCounts.dialogueBytes === undefined || (typeof value.omittedCounts.dialogueBytes === "number" && Number.isFinite(value.omittedCounts.dialogueBytes) && value.omittedCounts.dialogueBytes >= 0))
		&& (value.instructionPolicy.renderedOmittedBytes === undefined || (typeof value.instructionPolicy.renderedOmittedBytes === "number" && Number.isFinite(value.instructionPolicy.renderedOmittedBytes) && value.instructionPolicy.renderedOmittedBytes >= 0))
		&& typeof value.instructionPolicy.mode === "string"
		&& instructionModes.has(value.instructionPolicy.mode)
		&& typeof value.instructionPolicy.canonicalized === "boolean"
		&& typeof value.instructionPolicy.truncated === "boolean"
		&& hasFiniteNumbers(value.instructionPolicy, ["sourceBytes", "preserveCount", "omittedPreserveCount"])
		&& typeof value.stableAddresses.firstKeptEntryId === "string"
		&& isEntryRange(value.stableAddresses.cumulativeSourceRange)
		&& value.stableAddresses.recall === "session-entry-id-range"
		&& (value.budget === undefined || isCompactionBudgetDetails(value.budget))
		&& typeof value.timestamp === "string";
}

function fabricCompactionVersion(details: Record<string, unknown>): 1 | 2 | undefined {
	if (details.version === 1 && isFabricV1Details(details)) return 1;
	if (details.version === 2 && isFabricV2Details(details)) return 2;
	return undefined;
}

/** Classify only durable fields from the committed compaction entry. */
function classifyCompactionWriter(entry: unknown): CompactionWriterObservation {
	if (!isRecord(entry)) return MALFORMED;
	const view = entry as CompactionEntryView;
	if (view.fromHook !== undefined && typeof view.fromHook !== "boolean") return MALFORMED;

	if (view.details === undefined) return view.fromHook === true ? { kind: "extension", name: "another extension" } : PI;
	if (!isRecord(view.details)) return view.fromHook === true ? { kind: "extension", name: "another extension" } : MALFORMED;
	const details = view.details;
	const compactor = details.compactor;

	if (compactor === "fabric") {
		if (fabricCompactionVersion(details) === undefined) return MALFORMED;
		if (details.claimOwner !== undefined && !isWriterName(details.claimOwner)) return MALFORMED;
		return details.claimOwner === COMPACTION_OWNER_NAME ? CONTEXT_AWARE : FABRIC;
	}
	if (compactor === COMPACTION_OWNER_NAME) {
		return details.compactorVersion === CONTEXT_AWARE_COMPACTOR_VERSION ? CONTEXT_AWARE : MALFORMED;
	}
	if (compactor !== undefined && !isWriterName(compactor)) {
		return view.fromHook === true ? { kind: "extension", name: "another extension" } : MALFORMED;
	}
	if (view.fromHook === true) {
		return { kind: "extension", name: isWriterName(compactor) ? compactor : "another extension" };
	}
	return compactor === undefined ? PI : MALFORMED;
}

/** Treat all hostile or malformed object access as malformed metadata. */
export function compactionWriterOf(entry: unknown): CompactionWriterObservation {
	try {
		return classifyCompactionWriter(entry);
	} catch {
		return MALFORMED;
	}
}

/** Read the newest committed compaction entry from the active branch. */
export function newestCommittedCompactionEntry(entries: readonly unknown[]): unknown {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		try {
			if (isRecord(entry) && entry.type === "compaction") return entry;
		} catch {
			// A hostile entry at the newest position is itself the committed malformed entry.
			return entry;
		}
	}
	return undefined;
}

/** Read the newest committed compaction so status survives extension reloads and process restarts. */
export function observedCompactionWriter(entries: readonly unknown[]): CompactionWriterObservation {
	const entry = newestCommittedCompactionEntry(entries);
	return entry === undefined ? NONE : compactionWriterOf(entry);
}

export function compactionWriterWarning(writer: CompactionWriterObservation): string | undefined {
	if (writer.kind !== "fabric" && writer.kind !== "extension") return undefined;
	return `Unexpected committed compaction writer: ${writer.name}. Context-aware held the compaction claim, but another writer won. Check the loaded compaction extensions and their order.`;
}

/** One warning per Pi session id, even when several foreign compactions commit. */
export class CompactionWriterObserver {
	readonly #warnedSessions = new Set<string>();

	observe(sessionId: string, entry: unknown, expectedContextAwareWriter: boolean): {
		readonly writer: CompactionWriterObservation;
		readonly warning?: string;
	} {
		const writer = compactionWriterOf(entry);
		if (!expectedContextAwareWriter || this.#warnedSessions.has(sessionId)) return { writer };
		// Pi's summarizer is the intentional last fallback when our hook yields or cancels.
		// The committed entry cannot distinguish that expected path after a restart, so only
		// competing extension writers warn; this avoids false alarms for every deliberate yield.
		const warning = compactionWriterWarning(writer);
		if (warning === undefined) return { writer };
		this.#warnedSessions.add(sessionId);
		return { writer, warning };
	}

}
