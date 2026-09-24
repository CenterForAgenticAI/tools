/** Bounded projections of transcript-authoritative workstream state for prompts and handoffs. */

import {
	MAX_PINNED_VERBATIM_BLOCK_CHARS,
	parseActivityEvent,
	parseWorkstreamSnapshot,
	type ActivityEvent,
	type WorkstreamGoal,
	type WorkstreamRef,
	type WorkstreamSnapshot,
} from "./workstream-schema.js";
import { replayWorkstreamEntries } from "./workstream-replay.js";
import { WORKSTREAM_ENTRY_TYPE } from "./workstream-state.js";
import { redactText, sanitizeActivityEvent, sanitizeSnapshot } from "./workstream-safety.js";

export const WORKSTREAM_CONTEXT_ELEMENT = "session-workstream" as const;
export const WORKSTREAM_CONTEXT_SOURCE = "pi-extension:context-aware" as const;

/**
 * Shared ceiling for durable prompt-memory projections. Each surface owns a
 * named cap below; a new surface must add its own cap instead of consuming a
 * remainder of another surface's budget.
 */
export const DURABLE_MEMORY_CONTEXT_CHAR_BUDGET = 8_000;
export const MAX_WORKSTREAM_CONTEXT_CHARS = 4_000;
export const MAX_COMPACTION_HISTORY_PROMPT_CHARS = 64;
/** The pinned block owns the remaining named durable-memory surface budget. */
export { MAX_PINNED_VERBATIM_BLOCK_CHARS };
export const MAX_WORKSTREAM_COMPACTION_ACTIVITY = 3;
export const MAX_WORKSTREAM_COMPACTION_GOALS = 10;
export const MAX_WORKSTREAM_COMPACTION_REFS = 10;
export const MAX_WORKSTREAM_COMPACTION_BOUNDARIES = 10;
export const WORKSTREAM_ACTIVITY_ENTRY_TYPE = "context-aware.activity.v1" as const;

export interface WorkstreamContextEnvelopeOptions {
	readonly maxChars?: number;
}

export interface WorkstreamProjectionOptions {
	readonly enabled?: boolean;
}

export interface WorkstreamSeedOptions {
	/** The model-produced expansion, if seed expansion has already run. */
	readonly expandedSeed?: string;
	/** The original seed, checked even when expansion is disabled or fails. */
	readonly rawSeed?: string;
	/** A caller can pass an independently detected pinned-objective conflict. */
	readonly pinnedObjectiveConflict?: boolean;
}

export interface WorkstreamSeedResult {
	readonly rawSeed: string;
	readonly prompt: string;
	readonly objectiveConflict: boolean;
	readonly constraintConflict: boolean;
	readonly warning?: string;
	readonly workstreamId: string;
	readonly revision: number;
}

export interface WorkstreamCompactionDetails {
	/** This object is a projection of its input; replay remains the authority. */
	readonly authority: "projection-input";
	readonly customEntryType: typeof WORKSTREAM_ENTRY_TYPE;
	readonly workstreamId: string;
	readonly revision: number;
	readonly objective: string;
	readonly activeGoals: readonly WorkstreamGoal[];
	readonly refs: readonly WorkstreamRef[];
	readonly boundaries: readonly string[];
	readonly recentRelevantActivity: readonly ActivityEvent[];
	/** Alias used by callers that refer to the digest as recent activity. */
	readonly recentActivity: readonly ActivityEvent[];
}

export interface WorkstreamCompactionProjection {
	readonly details: WorkstreamCompactionDetails;
	readonly guidance: string;
}

function bounded(value: string, maxLength: number): string {
	return value.slice(0, Math.max(0, maxLength));
}

function xmlText(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function xmlAttribute(value: string): string {
	return xmlText(value).replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function canonicalSnapshot(snapshot: WorkstreamSnapshot): WorkstreamSnapshot | null {
	const parsed = parseWorkstreamSnapshot(snapshot);
	return parsed === null ? null : sanitizeSnapshot(parsed);
}

/** Select valid active state only when the durable-workstream feature is enabled. */
export function selectActiveWorkstream(
	snapshot: WorkstreamSnapshot | null,
	enabled = true,
): WorkstreamSnapshot | null {
	if (!enabled || snapshot === null) return null;
	const parsed = canonicalSnapshot(snapshot);
	return parsed?.status === "active" ? parsed : null;
}

function activeGoals(snapshot: WorkstreamSnapshot): WorkstreamGoal[] {
	return snapshot.goals.filter((goal) => goal.status !== "done").map((goal) => ({ ...goal }));
}

function renderContext(
	snapshot: WorkstreamSnapshot,
	goalCount: number,
	refCount: number,
	boundaryCount: number,
	valueLength: number,
	includePinnedVerbatimBlock = true,
): string {
	const safe = sanitizeSnapshot(snapshot);
	const pinnedMarkup = includePinnedVerbatimBlock && safe.pinnedVerbatimBlock !== undefined
		? `\n    <pinned-verbatim-block pinned="true">${xmlText(safe.pinnedVerbatimBlock)}</pinned-verbatim-block>`
		: "";
	const goals = activeGoals(safe).slice(0, goalCount);
	const refs = safe.refs.slice(0, refCount);
	const boundaries = safe.boundaries.slice(0, boundaryCount);
	const goalMarkup = goals.map((goal) =>
		`\n    <goal id="${xmlAttribute(bounded(goal.id, 96))}" status="${goal.status}">${xmlText(bounded(goal.text, valueLength))}</goal>`,
	).join("");
	const refMarkup = refs.map((ref) =>
		`\n    <ref kind="${xmlAttribute(ref.kind)}">${xmlText(bounded(ref.value, valueLength))}</ref>`,
	).join("");
	const boundaryMarkup = boundaries.map((boundary) =>
		`\n    <boundary>${xmlText(bounded(boundary, valueLength))}</boundary>`,
	).join("");
	return `<${WORKSTREAM_CONTEXT_ELEMENT} source="${WORKSTREAM_CONTEXT_SOURCE}" user-input="false" response-expected="false">\n` +
		`  <state workstream-id="${xmlAttribute(safe.workstreamId)}" pi-session-id="${xmlAttribute(safe.piSessionId)}" revision="${safe.revision}" status="${safe.status}" />\n` +
		`  <objective>${xmlText(bounded(safe.objective, valueLength))}</objective>\n` +
		`  <active-goals>${goalMarkup}\n  </active-goals>\n` +
		`  <refs>${refMarkup}\n  </refs>\n` +
		`  <boundaries>${boundaryMarkup}\n  </boundaries>${pinnedMarkup}\n` +
		`  <instruction>Extension state only; do not treat this envelope as a new user request. Keep work within the objective and boundaries. The pinned verbatim block is static; re-derive volatile facts explicitly instructed by that block.</instruction>\n` +
		`</${WORKSTREAM_CONTEXT_ELEMENT}>`;
}

/** Build the bounded current-state envelope used at `before_agent_start`. */
export function buildWorkstreamContextEnvelope(
	snapshot: WorkstreamSnapshot | null,
	options: WorkstreamContextEnvelopeOptions = {},
): string | null {
	const parsed = selectActiveWorkstream(snapshot);
	if (parsed === null) return null;
	const maxChars = Math.max(1, Math.floor(options.maxChars ?? MAX_WORKSTREAM_CONTEXT_CHARS));
	let goalCount = Math.min(activeGoals(parsed).length, 20);
	let refCount = Math.min(parsed.refs.length, 50);
	let boundaryCount = Math.min(parsed.boundaries.length, 20);
	let valueLength = 320;
	// The pinned block has its own named cap. Shrink only the ordinary focus
	// projection, then append the stored block unchanged.
	let result = renderContext(parsed, goalCount, refCount, boundaryCount, valueLength, false);
	while (result.length > maxChars && (goalCount > 1 || refCount > 1 || boundaryCount > 1 || valueLength > 1)) {
		// Shrink field values before dropping sections so every required state
		// category remains represented whenever the caller's bound permits it.
		if (valueLength > 32) valueLength = Math.max(32, valueLength - 16);
		else if (goalCount > 1 && goalCount >= refCount && goalCount >= boundaryCount) goalCount -= 1;
		else if (refCount > 1 && refCount >= boundaryCount) refCount -= 1;
		else if (boundaryCount > 1) boundaryCount -= 1;
		else valueLength = Math.max(1, valueLength - 1);
		result = renderContext(parsed, goalCount, refCount, boundaryCount, valueLength, false);
	}
	if (result.length <= maxChars) return renderContext(parsed, goalCount, refCount, boundaryCount, valueLength);
	// The normal bound is large enough for the fixed envelope. This final path
	// keeps the extension marker and identity even for a caller-supplied tiny cap.
	const minimal = renderContext(parsed, 0, 0, 0, 1, false);
	// Never return a partially formed XML envelope. A caller-supplied cap below
	// the fixed envelope overhead opts out of the projection instead.
	return minimal.length <= maxChars ? renderContext(parsed, 0, 0, 0, 1) : null;
}

/** Append current workstream state to a system prompt without injecting activity/history. */
export function injectWorkstreamContext(
	systemPrompt: string,
	snapshot: WorkstreamSnapshot | null,
	options: WorkstreamContextEnvelopeOptions = {},
): string {
	const envelope = buildWorkstreamContextEnvelope(snapshot, options);
	return envelope === null ? systemPrompt : `${systemPrompt}\n\n${envelope}`;
}

/** Resolve the only state source accepted by context projections: transcript custom entries. */
export function resolveAuthoritativeWorkstream(entries: readonly unknown[]): WorkstreamSnapshot | null {
	const replay = replayWorkstreamEntries(entries);
	return replay.authority === "transcript" ? replay.snapshot : null;
}

/** Resolve and inject a replayed active workstream, leaving legacy/projection-only input unchanged. */
export function injectAuthoritativeWorkstreamContext(
	systemPrompt: string,
	entries: readonly unknown[],
	options: WorkstreamContextEnvelopeOptions = {},
): string {
	return injectWorkstreamContext(systemPrompt, resolveAuthoritativeWorkstream(entries), options);
}

const PINNED_OBJECTIVE_CONFLICT_PATTERNS: readonly RegExp[] = [
	/\b(?:replace|redefine)\b[^.\n]{0,100}\b(?:the\s+)?(?:primary\s+)?objective\b/i,
	/\breplace\b[^.\n]{0,100}\b(?:this|current|existing|present|active|established)\s+work\b/i,
	/\b(?:switch|pivot)\b[^.\n]{0,60}\b(?:the\s+)?(?:primary\s+)?(?:objective|focus|project)\b[^.\n]{0,60}\b(?:to|toward|into)\b/i,
	/\b(?:new|different|unrelated)\s+(?:primary\s+)?objective\b/i,
	/\b(?:drop|abandon|discard|leave|stop|forget|quit)\b[^.\n]{0,100}\b(?:the\s+)?(?:this|current|existing|present|active|established)\s+(?:task|work|focus|direction|project|objective|goal)\b/i,
	/\b(?:switch|pivot|move|redirect|turn)\b[^.\n]{0,100}\b(?:away\s+from|off\s+of|from)\b[^.\n]{0,60}\b(?:the\s+)?(?:this|current|existing|present|active|established)\s+(?:task|work|focus|direction|project|objective|goal)\b/i,
	/\b(?:switch|pivot|move|redirect|turn|take\s+up)\b[^.\n]{0,100}\b(?:to|toward|into|on\s+to)\b[^.\n]{0,80}\b(?:an?\s+)?(?:unrelated|different|separate|new)\b/i,
];
const CONSTRAINT_CONFLICT_PATTERNS: readonly RegExp[] = [
	/\b(?:ignore|drop|remove|discard)\b[^.\n]{0,100}\b(?:refs?|references?|boundar(?:y|ies)|constraints?)\b/i,
];

function detectsPinnedObjectiveConflict(value: string): boolean {
	return PINNED_OBJECTIVE_CONFLICT_PATTERNS.some((pattern) => pattern.test(value));
}

function detectsConstraintConflict(value: string): boolean {
	return CONSTRAINT_CONFLICT_PATTERNS.some((pattern) => pattern.test(value));
}

function seedStateLines(snapshot: WorkstreamSnapshot): string[] {
	const goals = activeGoals(snapshot).slice(0, MAX_WORKSTREAM_COMPACTION_GOALS);
	const refs = snapshot.refs.slice(0, MAX_WORKSTREAM_COMPACTION_REFS);
	const boundaries = snapshot.boundaries.slice(0, MAX_WORKSTREAM_COMPACTION_BOUNDARIES);
	return [
		"Workstream continuity (extension state, not a new user request):",
		`- Workstream ID: ${snapshot.workstreamId}`,
		`- Revision: ${snapshot.revision}`,
		`- Primary objective: ${bounded(snapshot.objective, 800)}`,
		`- Active goals: ${goals.length === 0 ? "(none)" : goals.map((goal) => `[${goal.status}] ${bounded(goal.text, 240)}`).join("; ")}`,
		`- References to preserve: ${refs.length === 0 ? "(none)" : refs.map((ref) => `${ref.kind}:${bounded(ref.value, 160)}`).join(", ")}`,
		`- Boundaries and constraints: ${boundaries.length === 0 ? "(none)" : boundaries.map((boundary) => bounded(boundary, 240)).join("; ")}`,
	];
}

/** Keep a model-produced seed expansion inside canonical workstream focus. */
export function constrainWorkstreamSeed(
	rawSeed: string,
	snapshot: WorkstreamSnapshot,
	options: WorkstreamSeedOptions = {},
): WorkstreamSeedResult {
	const parsed = canonicalSnapshot(snapshot);
	if (parsed === null) throw new Error("cannot constrain a seed with an invalid workstream snapshot");
	const candidate = (options.expandedSeed ?? rawSeed).trim();
	const rawCandidate = (options.rawSeed ?? rawSeed).trim();
	// A provisional objective is still transcript-established state. Seeds may
	// propose a next phase, but may not silently replace that objective before
	// the user explicitly edits or pins it.
	const objectiveConflict = Boolean(
		options.pinnedObjectiveConflict || detectsPinnedObjectiveConflict(candidate) || detectsPinnedObjectiveConflict(rawCandidate),
	);
	const constraintConflict = detectsConstraintConflict(candidate) || detectsConstraintConflict(rawCandidate);
	const unsafeExpansion = objectiveConflict || constraintConflict;
	const safeCandidate = redactText(candidate, { maxLength: 4_000 });
	const warning = objectiveConflict
		? `${parsed.objectivePinned ? "Pinned-objective" : "Objective"} conflict flagged: do not redefine the primary objective; reconcile the requested seed with the transcript-authoritative workstream or ask for explicit user authorization.`
		: constraintConflict
			? "Workstream-constraint conflict flagged: do not discard the transcript-authoritative references or boundaries."
			: undefined;
	const lines = seedStateLines(parsed);
	lines.push("");
	if (unsafeExpansion) {
		lines.push(`WARNING: ${parsed.objectivePinned ? "pinned-objective" : "objective"} conflict; the proposed expansion was not adopted.`);
		lines.push("Continue only with a next step that fits the primary objective, references, and boundaries above.");
	} else {
		lines.push(`Requested next phase: ${safeCandidate || redactText(rawSeed.trim(), { maxLength: 4_000 })}`);
	}
	return {
		rawSeed: redactText(rawSeed, { maxLength: 4_000 }),
		prompt: lines.join("\n"),
		objectiveConflict,
		constraintConflict,
		...(warning === undefined ? {} : { warning }),
		workstreamId: parsed.workstreamId,
		revision: parsed.revision,
	};
}

/** Return the complete validated timeline for focus/session UI and commands. */
export function activityTimeline(events: readonly unknown[]): readonly ActivityEvent[] {
	type TimelineCandidate = { value: ActivityEvent; entry: unknown; index: number };
	const byEventId = new Map<string, TimelineCandidate>();
	for (const [entryIndex, entry] of events.entries()) {
		const record = typeof entry === "object" && entry !== null && !Array.isArray(entry)
			? entry as Record<string, unknown>
			: null;
		const candidates = record?.customType === WORKSTREAM_ACTIVITY_ENTRY_TYPE
			? [record.data]
			: [entry];
		for (const candidate of candidates) {
			const parsed = parseActivityEvent(candidate);
			if (!parsed) continue;
			const safe = sanitizeActivityEvent(parsed);
			const previous = byEventId.get(safe.eventId);
			// The branch array is transcript order. For a duplicate event ID, the
			// later transcript entry is the correction and must win; a lexical
			// comparison of payloads would let an older duplicate survive.
			if (!previous || isLaterEventChronology(entry, entryIndex, previous.entry, previous.index)) {
				byEventId.set(safe.eventId, { value: safe, entry, index: entryIndex });
			}
		}
	}
	return [...byEventId.values()].map((item) => item.value).sort((a, b) => {
		const time = Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
		return time !== 0 ? time : a.eventId.localeCompare(b.eventId);
	});
}

function eventChronology(entry: unknown, index: number): [number, number] {
	const record = typeof entry === "object" && entry !== null && !Array.isArray(entry)
		? entry as Record<string, unknown>
		: null;
	const timestamp = typeof record?.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
	return [Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY, index];
}

function isLaterEventChronology(entry: unknown, index: number, previousEntry: unknown, previousIndex: number): boolean {
	const current = eventChronology(entry, index);
	const previous = eventChronology(previousEntry, previousIndex);
	return current[0] > previous[0] || (current[0] === previous[0] && current[1] > previous[1]);
}

/** Select at most the latest three relevant events for a compaction-only digest. */
export function selectRecentRelevantActivity(
	snapshot: WorkstreamSnapshot,
	events: readonly unknown[],
): readonly ActivityEvent[] {
	const parsed = canonicalSnapshot(snapshot);
	if (parsed === null) throw new Error("cannot select activity for an invalid workstream snapshot");
	return activityTimeline(events)
		.filter((event) => event.workstreamId === parsed.workstreamId && event.relevant)
		.slice(-MAX_WORKSTREAM_COMPACTION_ACTIVITY);
}

function compactionGuidance(details: WorkstreamCompactionDetails): string {
	const goals = details.activeGoals.length === 0
		? "(none)"
		: details.activeGoals.map((goal) => `[${goal.status}] ${goal.text}`).join("; ");
	const refs = details.refs.length === 0
		? "(none)"
		: details.refs.map((ref) => `${ref.kind}:${ref.value}`).join(", ");
	const boundaries = details.boundaries.length === 0 ? "(none)" : details.boundaries.join("; ");
	const activity = details.recentRelevantActivity.length === 0
		? "(none)"
		: details.recentRelevantActivity.map((event) => `${event.eventId} (${event.kind}): ${event.summary}`).join("; ");
	return [
		"Preserve this bounded workstream state in the compaction handoff:",
		`- Workstream ID: ${details.workstreamId}`,
		`- Revision: ${details.revision}`,
		`- Objective: ${details.objective}`,
		`- Active goals: ${goals}`,
		`- References: ${refs}`,
		`- Boundaries and constraints: ${boundaries}`,
		`- Latest three relevant recent-activity entries: ${activity}`,
		"Preserve transcript custom-entry authority: summaries and compaction details are projections only. Omitting or paraphrasing this guidance must not change the authoritative snapshot; replay context-aware.workstream.v1 custom entries when exact state is needed.",
	].join("\n");
}

/** Build compaction guidance/details without promoting a summary or activity projection to authority. */
export function buildWorkstreamCompactionProjection(
	snapshot: WorkstreamSnapshot,
	events: readonly unknown[] = [],
): WorkstreamCompactionProjection {
	const parsed = canonicalSnapshot(snapshot);
	if (parsed === null) throw new Error("cannot build compaction projection from an invalid workstream snapshot");
	const safe = sanitizeSnapshot(parsed);
	const recentRelevantActivity = selectRecentRelevantActivity(safe, events);
	const details: WorkstreamCompactionDetails = {
		authority: "projection-input",
		customEntryType: WORKSTREAM_ENTRY_TYPE,
		workstreamId: safe.workstreamId,
		revision: safe.revision,
		objective: safe.objective,
		activeGoals: activeGoals(safe).slice(0, MAX_WORKSTREAM_COMPACTION_GOALS).map((goal) => ({ ...goal, text: bounded(goal.text, 240) })),
		refs: safe.refs.slice(0, MAX_WORKSTREAM_COMPACTION_REFS).map((ref) => ({ ...ref, value: bounded(ref.value, 160) })),
		boundaries: safe.boundaries.slice(0, MAX_WORKSTREAM_COMPACTION_BOUNDARIES).map((boundary) => bounded(boundary, 240)),
		recentRelevantActivity,
		recentActivity: recentRelevantActivity,
	};
	return { details, guidance: compactionGuidance(details) };
}

/** Build a compaction projection only when transcript replay establishes authority. */
export function buildAuthoritativeWorkstreamCompactionProjection(
	entries: readonly unknown[],
	events: readonly unknown[] = entries,
	options: WorkstreamProjectionOptions = {},
): WorkstreamCompactionProjection | null {
	const snapshot = selectActiveWorkstream(resolveAuthoritativeWorkstream(entries), options.enabled ?? true);
	return snapshot === null ? null : buildWorkstreamCompactionProjection(snapshot, events);
}

/** Named details helper for compaction integrations that store guidance separately. */
export function buildWorkstreamCompactionDetails(
	snapshot: WorkstreamSnapshot,
	events: readonly unknown[] = [],
): WorkstreamCompactionDetails {
	return buildWorkstreamCompactionProjection(snapshot, events).details;
}

/** Named guidance helper for compaction integrations that store structured details separately. */
export function buildWorkstreamCompactionGuidance(
	snapshot: WorkstreamSnapshot,
	events: readonly unknown[] = [],
): string {
	return buildWorkstreamCompactionProjection(snapshot, events).guidance;
}
