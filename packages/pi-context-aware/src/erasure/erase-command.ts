import path from "node:path";
import { validateSessionId } from "./database.js";
import { derivedStoresHolding } from "./derived.js";
import { eraseText, findForkCopies, searchable, type EraseTextResult } from "./erase-text.js";
import { rewriteSession, type RewriteSelector } from "./session-rewrite.js";
import type { ErasureSession } from "./session-erasure.js";

/**
 * `/session-erase --range <ref>..<ref>` and `/session-erase --match <literal>`: preview, confirm, erase, receipt.
 * The preview and the receipt hold entry ids, hashes and paths only. They never hold the erased text.
 */

export type TextSelector = Extract<RewriteSelector, { kind: "range" | "match" }>;
export type EraseRequest =
	| { readonly kind: "text"; readonly session: string; readonly selector: TextSelector }
	| { readonly kind: "usage"; readonly message: string };

export const TEXT_USAGE = "Usage: /session-erase <session-id> --range <ref>..<ref> | /session-erase <session-id> --match <literal> (or --session <id-or-path>). Interactive Pi only; the session must be closed.";

/** Documented limits, listed in every receipt. */
export const TEXT_ERASURE_LIMITS = [
	"Fabric memory index: not cleaned (requires Fabric deletion support).",
	"Live sessions are refused; close the session first.",
	"Copies outside profile stores, backups, exported task plans, other extensions' stores and unrelated sessions: not searched; remove separately.",
	"Shared context-aware-debug.log: not erased.",
];

const FLAG = /(?:^|\s)--(session|range|match)(?=\s|$)/gu;

/** undefined means the old `/session-erase <session-id>` form: the caller keeps its existing path. */
export function parseEraseArgs(args: string): EraseRequest | undefined {
	const hits = [...args.matchAll(FLAG)];
	if (hits.length === 0) return undefined;
	const usage = (message = TEXT_USAGE): EraseRequest => ({ kind: "usage", message });
	const values = new Map<string, string>();
	for (const [index, hit] of hits.entries()) {
		const name = hit[1]!;
		if (values.has(name)) return usage(`--${name} given twice. ${TEXT_USAGE}`);
		const end = hits[index + 1]?.index ?? args.length;
		values.set(name, args.slice(hit.index + hit[0].length, end).trim());
	}
	const lead = args.slice(0, hits[0]!.index).trim();
	if (/\s/u.test(lead)) return usage();
	const named = values.get("session");
	if (lead && named !== undefined) return usage();
	const session = lead || named;
	if (!session) return usage(`Name the closed session. ${TEXT_USAGE}`);
	const range = values.get("range");
	const match = values.get("match");
	if (range !== undefined && match !== undefined) return usage(`Use --range or --match, not both. ${TEXT_USAGE}`);
	if (range) return { kind: "text", session, selector: { kind: "range", range } };
	if (match) return { kind: "text", session, selector: { kind: "match", text: match } };
	return usage();
}

export interface TextErasureOptions {
	readonly agentDir: string;
	readonly request: Extract<EraseRequest, { kind: "text" }>;
	readonly currentSessionId: string;
	/** All sessions of the profile. */
	readonly sessions: readonly ErasureSession[];
	readonly confirm: (title: string, message: string) => Promise<boolean>;
	readonly now?: () => Date;
}

export interface TextErasureOutcome {
	readonly status: "complete" | "incomplete" | "refused" | "cancelled";
	/** Shown to the user. Ids, hashes and paths only. */
	readonly text: string;
}

function resolveSession(value: string, sessions: readonly ErasureSession[]): ErasureSession | string {
	if (/[\\/]/u.test(value) || value.endsWith(".jsonl")) {
		const resolved = path.resolve(value);
		// A path nobody listed goes on to the rewrite, whose confinement check refuses anything outside the sessions directory.
		return sessions.find((session) => path.resolve(session.path) === resolved) ?? { id: "", path: value };
	}
	try { validateSessionId(value); } catch { return "Not a valid session id"; }
	return sessions.find((session) => session.id === value) ?? "Session id not found in this profile";
}

const listIds = (ids: readonly string[], cap = 40) => ids.length > cap ? `${ids.slice(0, cap).join(", ")} and ${ids.length - cap} more` : ids.join(", ");
const refusal = (reason: string): TextErasureOutcome => ({ status: "refused", text: `Session erasure: refused. ${reason}. Nothing was written.` });

const WITHHELD = "[line withheld: it contains the erased text]";
/** A path or an error can quote the erased text. No line shown to the user may hold it. */
function withhold(text: string, needle: string | undefined): string {
	if (!needle) return text;
	return text.split("\n").map((line) => line.includes(needle) ? WITHHELD : line).join("\n");
}

/** A store label is its path. The reason after it can quote file content (a parse error does), so it is dropped. */
const storeLabel = (entry: string) => entry.split(": ")[0]!;

function describe(selector: TextSelector): string {
	return selector.kind === "range" ? `range ${selector.range}` : `match of ${selector.text.length} characters (the text is not shown)`;
}

export async function runTextErasure(options: TextErasureOptions): Promise<TextErasureOutcome> {
	const needle = options.request.selector.kind === "match" ? options.request.selector.text : undefined;
	const outcome = await runUnfiltered({ ...options, confirm: (title, message) => options.confirm(withhold(title, needle), withhold(message, needle)) });
	return { ...outcome, text: withhold(outcome.text, needle) };
}

async function runUnfiltered(options: TextErasureOptions): Promise<TextErasureOutcome> {
	const { agentDir, request } = options;
	const target = resolveSession(request.session, options.sessions);
	if (typeof target === "string") return refusal(target);
	const collected: string[] = [];
	const base = { agentDir, currentSessionId: options.currentSessionId, ...(options.now ? { now: options.now } : {}) };
	const preview = rewriteSession({ ...base, sessionFile: target.path, selector: request.selector, dryRun: true, collectErasedText: (strings) => { collected.push(...strings); } });
	if ("reason" in preview) return refusal(preview.reason);
	if (preview.status === "nothing-to-erase") return { status: "complete", text: "Session erasure: nothing to erase. No entry matched; nothing was written." };
	const ids = preview.entries.map((entry) => entry.entryId);
	const texts = searchable(request.selector, collected);
	const stores = derivedStoresHolding(agentDir, preview.sessionId, target.path, texts);
	const forks = findForkCopies(agentDir, target, options.sessions, request.selector.kind === "match" ? { text: request.selector.text } : { ids });
	const lines = [
		`Erase from session ${preview.sessionId}: ${describe(request.selector)}`,
		`Entries to erase in this session (${ids.length}): ${listIds(ids)}`,
		"Their message text, tool-call arguments and tool output become a dated marker. Ids, parent links, roles and tool-call ids stay.",
		...(stores.length ? [`Derived stores that hold a copy (${stores.length}), cleaned next:`, ...stores] : ["Derived stores that hold a copy: none found."]),
		...(forks.length ? [`Forks that hold a copy (${forks.length}); each is asked separately afterwards:`, ...forks.map((fork) => `${fork.session.id}: ${fork.entryIds.length} entries (${listIds(fork.entryIds, 10)}) in ${fork.session.path}`)] : ["Forks that hold a copy: none."]),
		...(preview.unreached.length ? [`A match also sits outside erasable content in: ${listIds(preview.unreached)} (not changed).`] : []),
		"Direct rewrite, no trash; it cannot be undone.",
		...TEXT_ERASURE_LIMITS,
	];
	if (!await options.confirm("Permanently erase from this session?", lines.join("\n"))) return { status: "cancelled", text: "Session erasure: cancelled. Nothing was written." };
	const result = await eraseText({
		agentDir, session: target, selector: request.selector, currentSessionId: options.currentSessionId, sessions: options.sessions, ...(options.now ? { now: options.now } : {}),
		confirmFork: (fork) => options.confirm(`Also erase from fork ${fork.session.id}?`, `${fork.entryIds.length} entries (${listIds(fork.entryIds, 20)}) in ${fork.session.path}. Declining leaves the fork untouched.`),
	});
	return receiptOf(result);
}

function receiptOf(result: EraseTextResult): TextErasureOutcome {
	const { rewrite } = result;
	if ("reason" in rewrite) return refusal(rewrite.reason);
	if (rewrite.status === "nothing-to-erase") return { status: "complete", text: "Session erasure: nothing to erase. Nothing was written." };
	const erased = [`Session ${rewrite.sessionId}: ${rewrite.entries.length} entries (${listIds(rewrite.entries.map((entry) => entry.entryId))})`];
	const failed: string[] = [];
	const untouched: string[] = [];
	for (const { fork, outcome, reason } of result.forks) {
		if (outcome === "erased") erased.push(`Fork ${fork.session.id}: ${fork.entryIds.length} entries (${listIds(fork.entryIds)})`);
		else if (outcome === "declined") untouched.push(`Declined fork ${fork.session.id}: ${fork.session.path}`);
		else if (outcome === "nothing-to-erase") untouched.push(`Fork ${fork.session.id}: nothing to erase`);
		else { failed.push(`Fork ${fork.session.id}: ${outcome}${reason ? ` (${reason})` : ""}`); }
	}
	for (const store of result.derived.removed) erased.push(`Derived store removed: ${store}`);
	for (const store of result.derived.redacted) erased.push(`Derived store redacted: ${store}`);
	for (const store of result.derived.failed) failed.push(`Store not cleaned: ${storeLabel(store)}`);
	for (const store of result.remaining) untouched.push(`Store still holds the erased text: ${store}`);
	if (rewrite.unreached.length) untouched.push(`Match outside erasable content, not changed: ${listIds(rewrite.unreached)}`);
	const lines = [
		`Session erasure: ${failed.length || result.remaining.length ? "incomplete" : "complete"}`,
		"Erased:", ...erased,
		"Failed:", ...failed,
		"Untouched:", ...untouched, ...TEXT_ERASURE_LIMITS,
		"Ledger: entry ids and content hashes only (erased_entries). No text is stored.",
	];
	return { status: failed.length || result.remaining.length ? "incomplete" : "complete", text: lines.join("\n") };
}
