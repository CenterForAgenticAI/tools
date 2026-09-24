import { readFileSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import { Type, type Static } from "typebox";
import { frameCacheReference } from "./seed-authority.js";
import { redactText } from "./workstream-safety.js";

/** Public recall controls. Unknown properties are intentionally rejected. */
export const recallSchema = Type.Object({
	question: Type.String({ minLength: 1, maxLength: 2_000 }),
	all_projects: Type.Optional(Type.Boolean()),
	include_current: Type.Optional(Type.Boolean()),
	include_worktrees: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

export type RecallRequest = Static<typeof recallSchema>;

/** The only session fields the extractor needs. Transcript text is evidence. */
export interface RecallSession {
	readonly path: string;
	readonly cwd?: string;
	readonly allMessagesText?: string;
}

/** A cache pool resolved by the registration layer without migration. */
export interface RecallCachePool {
	readonly cacheDir: string;
	readonly originScope: string;
}

export interface RecallSources {
	readonly cachePools: readonly RecallCachePool[];
	readonly sessions: readonly RecallSession[];
	readonly currentSessionPath?: string | null;
	readonly home?: string;
	readonly cwd?: string;
}

export interface RecallCitation {
	readonly store: "context-cache" | "prior-session";
	readonly sourcePath: string;
	readonly excerpt: string;
}

export interface RecallDetails {
	readonly non_authoritative: true;
	readonly scanned_cache_documents: number;
	readonly omitted_cache_documents: number;
	readonly scanned_sessions: number;
	readonly omitted_sessions: number;
	readonly citations: readonly RecallCitation[];
	readonly stores: readonly ("context-cache" | "prior-session")[];
	readonly scope: {
		readonly all_projects: boolean;
		readonly include_current: boolean;
		readonly include_worktrees: boolean;
	};
	readonly error?: "blank question";
}

export interface RecallResult {
	readonly content: Array<{ readonly type: "text"; readonly text: string }>;
	readonly details: RecallDetails;
	readonly isError?: boolean;
}

const MAX_SESSIONS = 100;
const MAX_CACHE_DOCUMENTS = 100;
const MAX_CITATIONS = 6;
const MAX_EXCERPT_CHARACTERS = 320;
const MAX_RENDERED_CHARACTERS = 4_000;
const STOP_WORDS = new Set([
	"a", "about", "after", "again", "all", "also", "an", "and", "any", "are", "as", "at", "be", "been", "before", "being", "between", "but", "by", "can", "could", "did", "do", "does", "for", "from", "has", "have", "how", "i", "if", "in", "into", "is", "it", "its", "just", "may", "me", "more", "most", "my", "no", "not", "of", "on", "or", "our", "out", "should", "so", "some", "such", "than", "that", "the", "their", "there", "these", "they", "this", "to", "too", "under", "use", "using", "was", "were", "what", "when", "where", "which", "who", "why", "will", "with", "without", "would", "you", "your",
]);

interface Passage {
	readonly text: string;
	readonly offset: number;
}

interface Candidate {
	readonly store: "context-cache" | "prior-session";
	readonly sourcePath: string;
	readonly passage: Passage;
	readonly score: number;
	readonly coverage: number;
	readonly phraseMatch: boolean;
}

interface CacheEntry {
	readonly file: string;
	readonly updated: string;
	readonly cacheDir: string;
	readonly originScope: string;
}

function normalized(value: string): string {
	return value
		.toLocaleLowerCase()
		.replace(/[\p{P}\p{S}]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
}

function queryTerms(value: string): readonly string[] {
	const terms = new Set<string>();
	for (const term of normalized(value).split(" ")) {
		if (term.length >= 2 && !STOP_WORDS.has(term)) terms.add(term);
	}
	return [...terms].sort((a, b) => a.localeCompare(b));
}

function safePath(value: string): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	try {
		return realpathSync.native(value);
	} catch {
		return undefined;
	}
}

function isWithin(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function isRegularFile(value: string): boolean {
	try {
		const info = statSync(value) as { isFile?: () => boolean };
		return typeof info.isFile === "function" ? info.isFile() : true;
	} catch {
		return false;
	}
}

function sourcePassages(text: string): readonly Passage[] {
	const passages: Passage[] = [];
	const lines = /[^\n]+/gu;
	for (const lineMatch of text.matchAll(lines)) {
		const line = lineMatch[0] ?? "";
		const lineOffset = lineMatch.index ?? 0;
		const sentencePattern = /[^.!?]+(?:[.!?]+|$)/gu;
		let foundSentence = false;
		for (const sentenceMatch of line.matchAll(sentencePattern)) {
			const sentence = sentenceMatch[0] ?? "";
			const trimmed = sentence.trim();
			if (!trimmed) continue;
			foundSentence = true;
			const leftTrim = sentence.search(/\S/u);
			passages.push({ text: trimmed, offset: lineOffset + (sentenceMatch.index ?? 0) + Math.max(0, leftTrim) });
		}
		if (!foundSentence && line.trim()) passages.push({ text: line.trim(), offset: lineOffset + line.search(/\S/u) });
	}
	return passages;
}

function candidateFor(
	store: Candidate["store"],
	sourcePath: string,
	passage: Passage,
	phrase: string,
	terms: readonly string[],
): Candidate | undefined {
	const candidateText = normalized(passage.text);
	if (!candidateText) return undefined;
	const phraseMatch = phrase.length > 0 && candidateText.includes(phrase);
	const coverage = terms.filter((term) => candidateText.split(" ").includes(term)).length;
	const completeTermMatch = terms.length > 0 && coverage === terms.length;
	if (!phraseMatch && !completeTermMatch) return undefined;
	const score = (phraseMatch ? 1_000_000 : 0) + coverage * 10_000 - passage.text.length;
	return { store, sourcePath, passage, score, coverage, phraseMatch };
}

function candidateOrder(left: Candidate, right: Candidate): number {
	return right.score - left.score
		|| (right.phraseMatch ? 1 : 0) - (left.phraseMatch ? 1 : 0)
		|| right.coverage - left.coverage
		|| left.store.localeCompare(right.store)
		|| left.sourcePath.localeCompare(right.sourcePath)
		|| left.passage.offset - right.passage.offset;
}

function readCacheEntries(pools: readonly RecallCachePool[]): {
	entries: readonly CacheEntry[];
	scanned: number;
	omitted: number;
} {
	const byFile = new Map<string, CacheEntry>();
	for (const pool of pools) {
		const poolPath = safePath(pool.cacheDir);
		if (!poolPath || !isRegularFile(path.join(poolPath, "_manifest.json"))) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(path.join(poolPath, "_manifest.json"), "utf8"));
		} catch {
			continue;
		}
		if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 1) continue;
		const files = (parsed as { files?: unknown }).files;
		if (!files || typeof files !== "object" || Array.isArray(files)) continue;
		for (const [file, rawEntry] of Object.entries(files)) {
			if (!/^[\w][\w.-]{0,98}\.[a-z]{1,10}$/iu.test(file) || file === "_manifest.json" || file.includes("..")) continue;
			if (byFile.has(file)) continue;
			const entry = rawEntry && typeof rawEntry === "object" ? rawEntry as { updated?: unknown } : undefined;
			const sourcePath = path.resolve(poolPath, file);
			const resolvedSource = safePath(sourcePath);
			if (!resolvedSource || !isWithin(poolPath, resolvedSource) || !isRegularFile(resolvedSource)) continue;
			byFile.set(file, {
				file,
				updated: typeof entry?.updated === "string" ? entry.updated : "",
				cacheDir: resolvedSource,
				originScope: pool.originScope,
			});
		}
	}
	const allEntries = [...byFile.values()].sort((left, right) => Date.parse(right.updated) - Date.parse(left.updated) || left.file.localeCompare(right.file));
	return {
		entries: allEntries.slice(0, MAX_CACHE_DOCUMENTS),
		scanned: allEntries.length,
		omitted: Math.max(0, allEntries.length - MAX_CACHE_DOCUMENTS),
	};
}

function renderExcerpt(text: string, home: string | undefined, cwd: string | undefined): string {
	return redactText(text, { home, cwd, maxLength: MAX_EXCERPT_CHARACTERS }).replaceAll("\n", " ").trim();
}

function renderSourcePath(sourcePath: string, home: string | undefined, cwd: string | undefined): string {
	const redacted = redactText(sourcePath, { home, cwd, maxLength: 240 });
	// redactText also shortens ordinary absolute paths. Probe for credentials
	// separately so an ordinary citation can remain directly checkable.
	const credentialProbe = redactText(sourcePath.replace(/[\\/]+/gu, " "), { maxLength: sourcePath.length });
	return credentialProbe.includes("[REDACTED]") ? redacted : sourcePath;
}

function renderResult(
	candidates: readonly Candidate[],
	details: Omit<RecallDetails, "citations">,
	home: string | undefined,
	cwd: string | undefined,
): RecallResult {
	const citations: RecallCitation[] = [];
	const lines: string[] = [];
	const title = (count: number): string => `Recall found ${count} extractive evidence excerpt${count === 1 ? "" : "s"}.`;
	for (const candidate of candidates) {
		if (citations.length >= MAX_CITATIONS) break;
		const excerpt = renderExcerpt(candidate.passage.text, home, cwd);
		if (!excerpt) continue;
		const sourcePath = renderSourcePath(candidate.sourcePath, home, cwd);
		const citation: RecallCitation = {
			store: candidate.store,
			sourcePath,
			excerpt,
		};
		const line = `- ${citation.store} | ${citation.sourcePath} | "${citation.excerpt}"`;
		const prospective = [title(lines.length + 1), ...lines, line].join("\n");
		const framed = frameCacheReference(prospective);
		if (framed.length > MAX_RENDERED_CHARACTERS) {
			if (lines.length > 0) break;
			continue;
		}
		lines.push(line);
		citations.push(citation);
	}
	const body = lines.length > 0
		? [title(lines.length), ...lines].join("\n")
		: "No matching evidence found in either context-cache documents or prior-session transcripts. No inference was made.";
	const framed = frameCacheReference(body);
	return {
		content: [{ type: "text", text: framed }],
		details: { ...details, citations },
	};
}

/** Perform one bounded, fresh, local lexical search over supplied stores. */
export function answerRecall(request: RecallRequest, sources: RecallSources): RecallResult {
	const question = typeof request.question === "string" ? request.question.trim() : "";
	const baseDetails: Omit<RecallDetails, "citations"> = {
		non_authoritative: true,
		scanned_cache_documents: 0,
		omitted_cache_documents: 0,
		scanned_sessions: 0,
		omitted_sessions: 0,
		stores: ["context-cache", "prior-session"],
		scope: {
			all_projects: request.all_projects ?? false,
			include_current: request.include_current ?? false,
			include_worktrees: request.include_worktrees ?? true,
		},
	};
	if (!question) {
		return {
			content: [{ type: "text", text: frameCacheReference("Recall requires a non-blank question. No source was read.") }],
			details: { ...baseDetails, error: "blank question", citations: [] },
			isError: true,
		};
	}

	const cache = readCacheEntries(sources.cachePools);
	const currentSessionPath = sources.currentSessionPath ? safePath(sources.currentSessionPath) : undefined;
	const eligibleSessions = (request.include_current ?? false)
		? sources.sessions
		: sources.sessions.filter((session) => !currentSessionPath || safePath(session.path) !== currentSessionPath);
	const sessions = eligibleSessions.slice(0, MAX_SESSIONS);
	const omittedSessions = Math.max(0, eligibleSessions.length - MAX_SESSIONS);
	const candidates: Candidate[] = [];
	const safeQuestion = redactText(question, { home: sources.home, cwd: sources.cwd, maxLength: 2_000 });
	const phrase = normalized(safeQuestion);
	const terms = queryTerms(safeQuestion);

	for (const entry of cache.entries) {
		let content: string;
		try {
			content = readFileSync(entry.cacheDir, "utf8");
		} catch {
			continue;
		}
		for (const passage of sourcePassages(content)) {
			const candidate = candidateFor("context-cache", entry.cacheDir, passage, phrase, terms);
			if (candidate) candidates.push(candidate);
		}
	}

	let scannedSessions = 0;
	for (const session of sessions) {
		const sessionPath = safePath(session.path);
		if (!sessionPath || !isRegularFile(sessionPath)) continue;
		scannedSessions++;
		let content: string;
		try {
			content = readFileSync(sessionPath, "utf8");
		} catch {
			continue;
		}
		for (const passage of sourcePassages(content)) {
			const candidate = candidateFor("prior-session", sessionPath, passage, phrase, terms);
			if (candidate) candidates.push(candidate);
		}
	}

	const deduplicated = new Map<string, Candidate>();
	for (const candidate of candidates) {
		const key = `${candidate.store}\u0000${candidate.sourcePath}\u0000${candidate.passage.offset}`;
		const existing = deduplicated.get(key);
		if (!existing || candidateOrder(candidate, existing) < 0) deduplicated.set(key, candidate);
	}
	const ordered = [...deduplicated.values()].sort(candidateOrder);
	return renderResult(
		ordered,
		{
			...baseDetails,
			scanned_cache_documents: cache.scanned,
			omitted_cache_documents: cache.omitted,
			scanned_sessions: scannedSessions,
			omitted_sessions: omittedSessions,
		},
		sources.home,
		sources.cwd,
	);
}

// ---------------------------------------------------------------------------
// Cost model (REQ-RECALL-007)
//
// recall exists to spend fewer of the caller's context tokens than the caller
// would spend reading the source directly. These helpers are pure — they read
// nothing and write nothing — so they do not weaken recall's read-only
// guarantee. They let a caller, a test, or the bench harness decide honestly
// whether one recall call is cheaper than the direct read it replaces.
// ---------------------------------------------------------------------------

/**
 * Rough characters-per-token ratio. This is a heuristic, not a tokenizer: the
 * exact, defensible measured quantity is characters. Four characters per token
 * is the usual English-text approximation and is only used to report an
 * order-of-magnitude token figure alongside the exact character counts.
 */
export const RECALL_CHARACTERS_PER_TOKEN = 4;

/** Estimate tokens from characters with the heuristic above. Never negative. */
export function estimateRecallTokens(characters: number): number {
	return Math.ceil(Math.max(0, characters) / RECALL_CHARACTERS_PER_TOKEN);
}

/**
 * Characters a recall result injects into the caller's context. This is the
 * rendered answer text the model actually reads — the sum of every content
 * block, which for recall is one framed block.
 */
export function recallOutputCharacters(result: RecallResult): number {
	return result.content.reduce((total, block) => total + block.text.length, 0);
}

/**
 * The distinct source paths a recall result cited, in first-seen order. These
 * are the files a caller would have to read directly to obtain the same
 * evidence, and so define the direct-read baseline.
 */
export function citedSourcePaths(result: RecallResult): readonly string[] {
	const seen = new Set<string>();
	const ordered: string[] = [];
	for (const citation of result.details.citations) {
		if (seen.has(citation.sourcePath)) continue;
		seen.add(citation.sourcePath);
		ordered.push(citation.sourcePath);
	}
	return ordered;
}

export interface RecallCostComparison {
	/** Characters and estimated tokens recall injected into the caller. */
	readonly recallCharacters: number;
	readonly recallTokens: number;
	/** Full size of the file(s) the caller would read directly instead. */
	readonly baselineCharacters: number;
	readonly baselineTokens: number;
	/**
	 * recallCharacters / baselineCharacters. Below 1 means recall is cheaper.
	 * When the baseline is empty (no cited file has a known size) the ratio is
	 * Infinity if recall returned anything and 0 if it returned nothing, so a
	 * divide-by-zero never hides a real cost.
	 */
	readonly contextRatio: number;
	/** True when the recall output is strictly smaller than the direct read. */
	readonly savesContext: boolean;
}

/**
 * Compare the context cost of one recall call against reading the cited
 * file(s) directly. Both inputs are character counts the caller has already
 * measured; this function only does the arithmetic, so it is deterministic and
 * side-effect free.
 */
export function compareRecallCost(recallCharacters: number, baselineCharacters: number): RecallCostComparison {
	const recall = Math.max(0, recallCharacters);
	const baseline = Math.max(0, baselineCharacters);
	const contextRatio = baseline > 0 ? recall / baseline : (recall > 0 ? Infinity : 0);
	return {
		recallCharacters: recall,
		recallTokens: estimateRecallTokens(recall),
		baselineCharacters: baseline,
		baselineTokens: estimateRecallTokens(baseline),
		contextRatio,
		savesContext: baseline > 0 && recall < baseline,
	};
}
