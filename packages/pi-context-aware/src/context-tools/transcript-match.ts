/**
 * How a `context_recall` query matches transcript text.
 *
 * - regex: the caller's regular expression, unchanged.
 * - literal: a query with no whitespace (an issue reference, a SHA, a path) is
 *   one literal substring, as before.
 * - terms: a query with several words matches a session that holds every word
 *   left after stop words, anywhere in it. The exact phrase ranks first, then
 *   the tightest stretch of text holding all words, then recency.
 *
 * A query whose words are all stop words falls back to the literal phrase.
 */

import { STOP_WORDS } from "../cache/recall.js";

export type QueryPlan =
	| { readonly kind: "regex"; readonly pattern: RegExp }
	| { readonly kind: "literal"; readonly pattern: RegExp; readonly needles: readonly string[]; readonly caseSensitive: boolean }
	| { readonly kind: "terms"; readonly phrase: RegExp; readonly terms: readonly string[]; readonly flags: string; readonly needles: readonly string[]; readonly caseSensitive: boolean };

/** How one session matched: the plan's kind, or `phrase` when a terms query met its exact phrase. */
export type MatchKind = "regex" | "literal" | "phrase" | "terms";

export interface TextMatch {
	readonly kind: MatchKind;
	/** terms: characters from the first to the last word of the tightest window holding every word. */
	readonly span?: number;
	readonly snippets: string[];
}

/** A window this short or shorter counts as the words appearing together. */
export const NEAR_SPAN = 400;
/** Occurrences collected per word; bounds the window search on very common words. */
const MAX_OCCURRENCES_PER_TERM = 2_000;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function queryWords(query: string, caseSensitive: boolean): string[] {
	const words = new Set<string>();
	for (const word of query.replace(/[\p{P}\p{S}]+/gu, " ").split(/\s+/u)) {
		const key = word.toLocaleLowerCase();
		if (word.length < 2 || STOP_WORDS.has(key)) continue;
		words.add(caseSensitive ? word : key);
	}
	return [...words];
}

/** Throws on an invalid regular expression, as `new RegExp` does. */
export function planQuery(query: string, regex: boolean, caseSensitive: boolean): QueryPlan {
	const flags = caseSensitive ? "g" : "gi";
	if (regex) return { kind: "regex", pattern: new RegExp(query, flags) };
	const literal = new RegExp(escapeRegExp(query), flags);
	const asLiteral: QueryPlan = { kind: "literal", pattern: literal, needles: [query], caseSensitive };
	if (!/\s/u.test(query.trim())) return asLiteral;
	const terms = queryWords(query, caseSensitive);
	if (terms.length === 0) return asLiteral;
	return { kind: "terms", phrase: literal, terms, flags, needles: terms, caseSensitive };
}

function snippetBetween(text: string, start: number, end: number): string {
	const from = Math.max(0, start);
	const to = Math.min(text.length, end);
	const prefix = from > 0 ? "…" : "";
	const suffix = to < text.length ? "…" : "";
	return `${prefix}${text.slice(from, to)}${suffix}`.replace(/\s+/g, " ").trim();
}

export function extractSnippets(haystack: string, matcher: RegExp, maxSnippets: number, radius: number): string[] {
	const out: string[] = [];
	matcher.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = matcher.exec(haystack)) !== null) {
		out.push(snippetBetween(haystack, m.index - radius, m.index + m[0].length + radius));
		if (out.length >= maxSnippets) break;
		if (m[0].length === 0) matcher.lastIndex++;
	}
	return out;
}

interface Occurrence {
	readonly at: number;
	readonly term: number;
	readonly length: number;
}

function occurrences(text: string, term: string, flags: string): number[] {
	const pattern = new RegExp(escapeRegExp(term), flags);
	const found: number[] = [];
	let m: RegExpExecArray | null;
	while (found.length < MAX_OCCURRENCES_PER_TERM && (m = pattern.exec(text)) !== null) found.push(m.index);
	return found;
}

/** The shortest run of occurrences that holds every term (minimum window over sorted positions). */
function tightestWindow(events: readonly Occurrence[], termCount: number): { from: number; to: number; span: number } | undefined {
	const counts = new Array<number>(termCount).fill(0);
	let have = 0;
	let left = 0;
	let best: { from: number; to: number; span: number } | undefined;
	for (let right = 0; right < events.length; right++) {
		const entering = events[right]!;
		if (counts[entering.term]++ === 0) have++;
		while (have === termCount) {
			const first = events[left]!;
			const span = entering.at + entering.length - first.at;
			if (best === undefined || span < best.span) best = { from: left, to: right, span };
			if (--counts[first.term] === 0) have--;
			left++;
		}
	}
	return best;
}

/** Match one session's text, or undefined when it does not match. */
export function matchText(plan: QueryPlan, text: string, maxSnippets: number, radius: number): TextMatch | undefined {
	if (plan.kind !== "terms") {
		const snippets = extractSnippets(text, plan.pattern, maxSnippets, radius);
		return snippets.length > 0 ? { kind: plan.kind, snippets } : undefined;
	}
	const phrase = extractSnippets(text, plan.phrase, maxSnippets, radius);
	if (phrase.length > 0) return { kind: "phrase", span: 0, snippets: phrase };

	const positions: number[][] = [];
	for (const term of plan.terms) {
		const found = occurrences(text, term, plan.flags);
		if (found.length === 0) return undefined;
		positions.push(found);
	}
	const events: Occurrence[] = [];
	positions.forEach((found, term) => {
		const length = plan.terms[term]!.length;
		for (const at of found) events.push({ at, term, length });
	});
	events.sort((a, b) => a.at - b.at);
	const window = tightestWindow(events, plan.terms.length);
	if (window === undefined) return undefined;

	const start = events[window.from]!.at;
	const end = start + window.span;
	if (window.span <= 2 * radius) {
		const pad = Math.max(40, Math.floor((2 * radius - window.span) / 2));
		return { kind: "terms", span: window.span, snippets: [snippetBetween(text, start - pad, end + pad)] };
	}
	// Too far apart for one snippet: one snippet per word, at its occurrence inside the window.
	const snippets: string[] = [];
	const shown = new Set<number>();
	for (let index = window.from; index <= window.to && snippets.length < maxSnippets; index++) {
		const event = events[index]!;
		if (shown.has(event.term)) continue;
		shown.add(event.term);
		const half = Math.floor(radius / 2);
		snippets.push(snippetBetween(text, event.at - half, event.at + event.length + half));
	}
	return { kind: "terms", span: window.span, snippets };
}

/** Lower ranks first: the exact phrase or a literal or regex hit, then words close together, then words spread out. */
export function matchRank(match: TextMatch): number {
	if (match.kind !== "terms") return 0;
	return (match.span ?? Number.POSITIVE_INFINITY) <= NEAR_SPAN ? 1 : 2;
}
