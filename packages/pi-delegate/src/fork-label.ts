/**
 * Fork display labels — GitLab issues #151 and #152.
 *
 * A run entry carries two independent identifiers:
 *
 *   `name`          the ADDRESSING key. Predictable, unique within a run,
 *                   caller-guessable, and stable for the entry's lifetime. It
 *                   keys `DelegateDispatchState.forks`, `delegate_control` action `steer` /
 *                   `cancel` / `recover`, run-history rows,
 *                   and the sha256-derived pending-wake filename. Nothing in
 *                   this module may change how it is minted.
 *
 *   `displayLabel`  a DERIVED, NON-ADDRESSING description shown to humans in
 *                   the status widget and transcript overlay. Uniqueness
 *                   matters only within one run, and only so the alias
 *                   resolver below can map a label a human read back onto the
 *                   entry that owns it.
 *
 * Everything here is pure and total. Derivation runs on the dispatch path, so
 * it must never throw and never block: every branch either returns a label or
 * falls through to the agent name.
 */

/**
 * Hard cap on a derived label. The status widget budgets 48 columns for the
 * whole `agent(label)` string, so the label itself has to leave room for the
 * agent name.
 */
export const MAX_DERIVED_LABEL_CHARS = 32;

/** Task characters scanned for an identifier. Measured hit rate: 45%. */
const IDENTIFIER_SCAN_CHARS = 400;

/** Task characters read at all, so a megabyte brief cannot cost more than a glance. */
const MAX_SCANNED_CHARS = 4000;

/** Lines inspected while skipping boilerplate, so a pathological brief cannot spin. */
const MAX_SCANNED_LINES = 40;

/** Content words kept when an identifier anchors the label. */
const WORDS_WITH_IDENTIFIER = 2;

/** Content words kept when the label is prose only. */
const WORDS_WITHOUT_IDENTIFIER = 3;

/**
 * Minimum content words for a prose-only label. Below this the label would be
 * a single generic verb, which is worse than saying nothing — fall through to
 * the agent name instead of shipping a misleading slug.
 */
const MIN_PROSE_WORDS = 2;

/** A markdown heading. Its identifier still counts; its prose does not. */
const HEADING_LINE = /^\s{0,3}#{1,6}\s+/;

/** `Read|Load|Open <path>` — a pointer to the real brief, not the brief. */
const POINTER_LINE = /^\s*(?:read|load|open)\b/i;

/** Path-ish token, used to confirm a pointer line really points somewhere. */
const PATH_TOKEN = /(?:[\w.-]+\/[\w./-]+|[\w-]+\.(?:md|txt|json|ya?ml|ts|tsx|js|mjs|py|rs|sh))\b/;

/** Role framing that describes the worker rather than the work. */
const FRAMING_LINE =
	/^\s*(?:you\s+are\b|your\s+(?:job|task|goal|mission|role)\b|please\b|this\s+is\b|we\s+need\b|i\s+need\b)/i;

/**
 * The framing itself, so a task that is NOTHING BUT framing can still be
 * mined for its remainder rather than falling all the way through.
 */
const FRAMING_PREFIX =
	/^\s*(?:you\s+are\s+|your\s+(?:job|task|goal|mission|role)\s+(?:is\s+)?(?:to\s+)?|please\s+|this\s+is\s+|we\s+need\s+to\s+|i\s+need\s+(?:you\s+to\s+)?)/i;

/** Horizontal rule or fence. */
const SEPARATOR_LINE = /^\s*(?:[-=_*]{3,}|`{3,}|~{3,})\s*$/;

/**
 * A machine header such as `run_id: 2026-07-16T20:57:08Z-4d5139`, `commit:
 * 936b930…`, or `branch: epic-137/agentcfg`. One fifth of real briefs open with
 * one. The value must be a single token: `Goal: fix the widget crash` is prose
 * and stays eligible as content.
 */
const METADATA_LINE = /^\s*[A-Za-z][A-Za-z0-9_-]{0,20}:\s*\S+\s*$/;

/** `#128`, `owner/project#128`, `!42` is deliberately excluded (merge requests are not work items here). */
const ISSUE_REF = /(?:^|[\s([<"'`])((?:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)?#(\d{1,5}))\b/;

/** `spec 0033`, `spec-0033`, `spec0033`. */
const SPEC_ID = /\b(spec[\s._/-]?(\d{2,4}))\b/i;

/** A repository-relative or absolute file path with an extension. */
const FILE_PATH = /(?:^|[\s([<"'`])((?:[A-Za-z0-9._-]+\/)+([A-Za-z0-9._-]+)\.[A-Za-z]{1,5})\b/;

/**
 * Words that carry no identity. Deliberately includes the carrier words that
 * sit next to an identifier (`gitlab`, `issue`) because they describe the
 * reference, not the work.
 */
const STOPWORDS = new Set([
	"a", "about", "above", "after", "again", "all", "also", "an", "and", "any", "are", "as", "at",
	"be", "been", "before", "being", "below", "between", "both", "but", "by",
	"can", "could", "did", "do", "does", "doing", "done", "down", "during",
	"each", "else", "every", "few", "first", "for", "from", "full", "fully", "further",
	"get", "gets", "getting", "gitlab", "had", "has", "have", "having", "he", "her", "here", "hers",
	"him", "his", "how", "however", "i", "if", "in", "into", "is", "issue", "issues", "it", "its", "itself",
	"just", "keep", "kindly", "let", "make", "makes", "many", "may", "me", "might", "more", "most",
	"much", "must", "my", "no", "nor", "not", "now", "of", "off", "on", "once", "one", "only",
	"onto", "or", "other", "others", "our", "ours", "out", "over", "own",
	"per", "please", "same", "she", "should", "so", "some", "such",
	"than", "that", "the", "their", "theirs", "them", "then", "there", "these", "they", "this",
	"those", "through", "to", "too", "two", "under", "until", "up", "us", "use", "used", "using",
	"very", "via", "was", "we", "were", "what", "when", "where", "which", "while", "who", "whom",
	"why", "will", "with", "within", "without", "would", "you", "your", "yours",
]);

/** Tokens shorter than this are noise (`a`, `it`, stray letters). */
const MIN_WORD_CHARS = 2;

/** Tokens longer than this are paths, URLs, or hashes rather than words. */
const MAX_WORD_CHARS = 20;

/**
 * A hyphenated compound such as `reviewed-draft-lifecycle` still reads as
 * words, so it earns more room than an unbroken run of the same length, which
 * is far more likely to be a hash or an opaque id.
 */
const MAX_COMPOUND_WORD_CHARS = 28;

/**
 * Cap on the identifier fragment alone, so a long path basename still leaves
 * room for the content words that say what is being done to it.
 */
const MAX_IDENTIFIER_CHARS = 20;

function isBlank(line: string): boolean {
	return line.trim().length === 0;
}

function isPointerLine(line: string): boolean {
	return POINTER_LINE.test(line) && PATH_TOKEN.test(line);
}

/**
 * A line that frames, points, or decorates rather than describing the work.
 * Headings count here for CONTENT purposes only — their identifiers are still
 * scanned, because a heading is where a brief most often names its issue.
 */
function isBoilerplateLine(line: string): boolean {
	return (
		isBlank(line) ||
		HEADING_LINE.test(line) ||
		SEPARATOR_LINE.test(line) ||
		METADATA_LINE.test(line) ||
		isPointerLine(line) ||
		FRAMING_LINE.test(line)
	);
}

/** Strip markdown emphasis, inline code, and list markers before tokenizing. */
function cleanLine(line: string): string {
	return line
		.replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/, "")
		.replace(/[`*_~>]/g, " ")
		.trim();
}

interface ExtractedIdentifier {
	/** Slug fragment to lead the label with, e.g. `#128`, `spec0033`, `fork-label`. */
	readonly slug: string;
	/** The exact matched text, removed from the line before content words are taken. */
	readonly matched: string;
}

function extractIdentifier(scanText: string): ExtractedIdentifier | undefined {
	const issue = ISSUE_REF.exec(scanText);
	if (issue?.[2]) return { slug: `#${issue[2]}`, matched: issue[1] ?? issue[0] };
	const spec = SPEC_ID.exec(scanText);
	if (spec?.[2]) return { slug: `spec${spec[2]}`, matched: spec[1] ?? spec[0] };
	const file = FILE_PATH.exec(scanText);
	if (file?.[2]) {
		const slug = capSlug(slugifyWord(file[2]), MAX_IDENTIFIER_CHARS);
		if (slug.length >= MIN_WORD_CHARS) return { slug, matched: file[1] ?? file[0] };
	}
	return undefined;
}

function slugifyWord(word: string): string {
	return word
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function contentWords(
	line: string,
	identifier: ExtractedIdentifier | undefined,
	limit: number,
): string[] {
	let text = cleanLine(line);
	if (identifier) text = text.split(identifier.matched).join(" ");
	// The identifier may have been found on a different line, so also refuse any
	// word it already says: `#128-fix-128` helps nobody.
	const seen = new Set<string>(
		identifier ? slugifyWord(identifier.slug).split("-").filter(Boolean) : [],
	);
	const lowered = text.toLowerCase();
	const out: string[] = [];
	for (const match of lowered.matchAll(/[a-z0-9][a-z0-9_-]*/g)) {
		const raw = match[0];
		const maxChars = raw.includes("-") ? MAX_COMPOUND_WORD_CHARS : MAX_WORD_CHARS;
		if (raw.length < MIN_WORD_CHARS || raw.length > maxChars) continue;
		if (STOPWORDS.has(raw)) continue;
		const word = slugifyWord(raw);
		if (word.length < MIN_WORD_CHARS || seen.has(word)) continue;
		seen.add(word);
		out.push(word);
		if (out.length >= limit) break;
	}
	return out;
}

/** Cap a slug at a character budget, cutting on a `-` boundary when possible. */
function capSlug(slug: string, max: number): string {
	if (slug.length <= max) return slug;
	const cut = slug.slice(0, max);
	const boundary = cut.lastIndexOf("-");
	const trimmed = boundary > 0 ? cut.slice(0, boundary) : cut;
	return trimmed.replace(/-+$/, "");
}

/**
 * Derive a label from the task text alone. Returns `undefined` when the task
 * yields nothing better than the agent name — the caller falls through.
 *
 * The ladder is identifier-first because identifiers are both the most
 * available signal in real briefs (45% carry an issue reference or path in
 * their first 400 characters) and the most recognisable one to the person
 * reading the row.
 */
function deriveFromTask(task: string): string | undefined {
	const lines = task.slice(0, MAX_SCANNED_CHARS).split("\n", MAX_SCANNED_LINES);

	// Identifier scan: headings and framing stay in, pointer lines come out —
	// a `Read …/BRIEF.md` line would otherwise label every run entry in an
	// identically-briefed fan-out after the same shared file.
	const scanText = lines
		.filter((line) => !isPointerLine(line))
		.join("\n")
		.slice(0, IDENTIFIER_SCAN_CHARS);
	const identifier = extractIdentifier(scanText);

	let contentLine = lines.find((line) => !isBoilerplateLine(line));
	if (contentLine === undefined) {
		// Nothing but framing: use what the framing wraps rather than giving up.
		// Headings, pointers, and separators stay excluded — they genuinely carry
		// no description of this run entry's work.
		const framed = lines.find(
			(line) =>
				!isBlank(line) &&
				!HEADING_LINE.test(line) &&
				!SEPARATOR_LINE.test(line) &&
				!isPointerLine(line) &&
				FRAMING_LINE.test(line),
		);
		if (framed !== undefined) contentLine = framed.replace(FRAMING_PREFIX, "");
	}

	if (identifier) {
		const words = contentLine
			? contentWords(contentLine, identifier, WORDS_WITH_IDENTIFIER)
			: [];
		return capSlug([identifier.slug, ...words].join("-"), MAX_DERIVED_LABEL_CHARS);
	}

	if (!contentLine) return undefined;
	const words = contentWords(contentLine, undefined, WORDS_WITHOUT_IDENTIFIER);
	if (words.length < MIN_PROSE_WORDS) return undefined;
	return capSlug(words.join("-"), MAX_DERIVED_LABEL_CHARS);
}

/**
 * Resolve one run entry's display label.
 *
 * `explicitLabel` — normally the entry's final addressing name — always wins.
 * Callers rely on being able to predict the name they passed, and a caller who
 * named an entry has already said what it should be called.
 */
export function deriveRunEntryDisplayLabel(input: {
	explicitLabel?: string | undefined;
	task?: string | undefined;
	agentName: string;
}): string {
	const explicit = typeof input.explicitLabel === "string" ? input.explicitLabel.trim() : "";
	if (explicit.length > 0) return explicit;
	const agentName = typeof input.agentName === "string" && input.agentName.length > 0
		? input.agentName
		: "entry";
	if (typeof input.task !== "string" || input.task.trim().length === 0) return agentName;
	try {
		const derived = deriveFromTask(input.task);
		if (derived && derived.length >= MIN_WORD_CHARS) return derived;
	} catch {
		// Naming must never be able to fail a dispatch.
	}
	return agentName;
}

/** @deprecated Use {@link deriveRunEntryDisplayLabel}; retained for dispatch callers. */
export function deriveForkDisplayLabel(input: {
	explicitLabel?: string | undefined;
	task?: string | undefined;
	agentName: string;
}): string {
	return deriveRunEntryDisplayLabel(input);
}

/** One slot's naming inputs, as the dispatch shapes see them. */
export interface RunEntryLabelInput {
	/** Final addressing name, after any `#N` disambiguation. */
	readonly name: string;
	/** True when the caller supplied `name:` for this slot. */
	readonly named: boolean;
	readonly task?: string | undefined;
	readonly agentName: string;
}

/** @deprecated Use {@link RunEntryLabelInput}; retained for dispatch callers. */
export type ForkLabelInput = RunEntryLabelInput;

/**
 * Compute display labels for one run's entries, in slot order.
 *
 * Labels only have to be unique WITHIN a run: every control surface is already
 * scoped by `runId`, so that is exactly enough for the alias resolver below to
 * be deterministic. Duplicates read as `label i/N` — a `count:` fan-out shows
 * `worker 1/3`, `worker 2/3`, `worker 3/3` — rather than borrowing the `#N`
 * convention that belongs to the addressing key.
 *
 * A label that equals its own entry's name is never rewritten: a caller-supplied
 * name is fixed, and names are unique, so at most one member of a duplicate
 * group is pinned this way.
 */
export function computeRunEntryDisplayLabels(entries: readonly RunEntryLabelInput[]): string[] {
	const labels = entries.map((entry) =>
		deriveRunEntryDisplayLabel({
			explicitLabel: entry.named ? entry.name : undefined,
			task: entry.task,
			agentName: entry.agentName,
		}),
	);
	const counts = new Map<string, number>();
	for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
	const seen = new Map<string, number>();
	return labels.map((label, index) => {
		const total = counts.get(label) ?? 1;
		if (total < 2) return label;
		const position = (seen.get(label) ?? 0) + 1;
		seen.set(label, position);
		// A caller-supplied name is fixed; only derived labels take a suffix.
		if (entries[index]?.named) return label;
		return `${label} ${position}/${total}`;
	});
}

/** @deprecated Use {@link computeRunEntryDisplayLabels}; retained for dispatch callers. */
export function computeForkDisplayLabels(entries: readonly RunEntryLabelInput[]): string[] {
	return computeRunEntryDisplayLabels(entries);
}

/** The label to display for one run entry, defaulting to its name for legacy records. */
export function runEntryDisplayLabel(entry: {
	name?: unknown;
	displayLabel?: unknown;
}): string {
	const label = typeof entry?.displayLabel === "string" ? entry.displayLabel.trim() : "";
	if (label.length > 0) return label;
	return typeof entry?.name === "string" ? entry.name : "";
}

/** @deprecated Use {@link runEntryDisplayLabel}; retained for control-surface compatibility. */
export function forkDisplayLabel(entry: {
	name?: unknown;
	displayLabel?: unknown;
}): string {
	return runEntryDisplayLabel(entry);
}

function tokenize(value: string): string[] {
	return value.toLowerCase().split(/[^a-z0-9]+/).filter((part) => part.length > 0);
}

function containsRun(haystack: readonly string[], needle: readonly string[]): boolean {
	if (needle.length === 0 || needle.length > haystack.length) return false;
	for (let start = 0; start + needle.length <= haystack.length; start++) {
		let all = true;
		for (let offset = 0; offset < needle.length; offset++) {
			if (haystack[start + offset] !== needle[offset]) {
				all = false;
				break;
			}
		}
		if (all) return true;
	}
	return false;
}

/**
 * Whether a row should show both the agent and label.
 *
 * Suppressed when the label already says the agent's name — the defaulted case
 * that renders as `delegate` rather than `delegate(delegate)`, and the chain
 * case where a sequential step is already named `step1-planner`.
 */
export function shouldShowAgentSuffix(label: string, agent: string): boolean {
	const agentName = typeof agent === "string" ? agent.trim() : "";
	if (agentName.length === 0) return false;
	const labelText = typeof label === "string" ? label.trim() : "";
	if (labelText.length === 0) return false;
	if (labelText.toLowerCase() === agentName.toLowerCase()) return false;
	return !containsRun(tokenize(labelText), tokenize(agentName));
}

/** `agent(label)`, or just `label` when the agent name would be redundant. */
export function renderRunEntryIdentity(entry: {
	name?: unknown;
	displayLabel?: unknown;
	agent?: unknown;
}): string {
	const label = runEntryDisplayLabel(entry);
	const agent = typeof entry?.agent === "string" ? entry.agent : "";
	return shouldShowAgentSuffix(label, agent) ? `${agent}(${label})` : label;
}

/** @deprecated Use {@link renderRunEntryIdentity}; retained for presentation consumers. */
export function renderForkIdentity(entry: {
	name?: unknown;
	displayLabel?: unknown;
	agent?: unknown;
}): string {
	return renderRunEntryIdentity(entry);
}

/**
 * Outcome of mapping a caller-supplied `forkName` onto a real run entry.
 *
 * `exact` and `resolved` carry a name the caller may act on. `ambiguous` and
 * `unknown` never do: a control tool that cannot identify its target must
 * change nothing, and must never fall back to the omitted-`forkName`
 * broadcast — cancelling every run entry because one label was misspelled would
 * destroy work.
 */
export type RunEntryAliasResolution =
	| { kind: "exact"; name: string }
	| { kind: "resolved"; name: string; label: string }
	| { kind: "ambiguous"; label: string; candidates: string[] }
	| { kind: "unknown"; inactive: string[] };

/**
 * Map a caller-supplied `forkName` onto a run entry, failing closed.
 *
 * 1. An exact `name` match wins unconditionally. This keeps today's contract
 *    byte-for-byte and settles the one real ambiguity — a display label that
 *    happens to equal another entry's name.
 * 2. Otherwise match display labels, restricted to entries this tool can act on
 *    (live for steer/cancel, failed for recover). A terminal entry was never a
 *    steer target.
 * 3. Exactly one candidate resolves; zero or several do not.
 */
export function resolveRunEntryAlias(args: {
	requested: string;
	forks: Record<string, unknown> | undefined;
	/** Whether an entry in this state is a legitimate target for the calling tool. */
	actionable: (entry: { status?: unknown }) => boolean;
}): RunEntryAliasResolution {
	const { requested, forks } = args;
	if (forks && Object.prototype.hasOwnProperty.call(forks, requested)) {
		return { kind: "exact", name: requested };
	}
	const matches: string[] = [];
	const inactive: string[] = [];
	for (const [name, value] of Object.entries(forks ?? {})) {
		const entry = (value ?? {}) as { status?: unknown; displayLabel?: unknown };
		if (runEntryDisplayLabel({ name, displayLabel: entry.displayLabel }) !== requested) continue;
		if (args.actionable(entry)) matches.push(name);
		else inactive.push(name);
	}
	if (matches.length === 1) return { kind: "resolved", name: matches[0]!, label: requested };
	if (matches.length > 1) return { kind: "ambiguous", label: requested, candidates: matches };
	return { kind: "unknown", inactive };
}

/** @deprecated Use {@link RunEntryAliasResolution}; retained for control tools. */
export type ForkAliasResolution = RunEntryAliasResolution;

/** @deprecated Use {@link resolveRunEntryAlias}; retained for control tools. */
export function resolveForkAlias(args: {
	requested: string;
	forks: Record<string, unknown> | undefined;
	actionable: (entry: { status?: unknown }) => boolean;
}): ForkAliasResolution {
	return resolveRunEntryAlias(args);
}

/**
 * Retry-oriented error text for a resolution that produced no target. The
 * caller is told the real addressing names, because those are what a retry
 * has to use.
 */
export function forkAliasErrorText(args: {
	verb: string;
	runId: string;
	requested: string;
	resolution: RunEntryAliasResolution;
	/** Shape-aware noun for generic worker/step control; omitted keeps the v1 fork wording. */
	entryNoun?: "fork" | "worker" | "step" | "run entry";
}): string {
	const { verb, runId, requested, resolution } = args;
	const noun = args.entryNoun ?? "fork";
	const article = "a";
	if (resolution.kind === "ambiguous") {
		return `Cannot ${verb} "${requested}" in runId=${runId}: it is not ${article} ${noun} name and matches ${resolution.candidates.length} display labels. Retry with one of: ${resolution.candidates.join(", ")}.`;
	}
	if (resolution.kind === "unknown" && resolution.inactive.length > 0) {
		return `Unknown ${noun} "${requested}" in runId=${runId}: it matches the display label of ${resolution.inactive.join(", ")}, which cannot be ${verb === "recover" ? "recovered" : `${verb}ed`} in its current state.`;
	}
	return `Unknown ${noun} "${requested}" in runId=${runId}.`;
}
