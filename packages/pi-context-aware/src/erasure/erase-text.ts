import path from "node:path";
import { cleanDerivedStores, derivedStoresHolding, holdsText, type DerivedCleanResult } from "./derived.js";
import { readStoreFile, withStoreDirectory } from "./files.js";
import { rewriteSession, type RewriteOptions, type RewriteResult, type RewriteSelector } from "./session-rewrite.js";
import type { ErasureSession } from "./session-erasure.js";
import { erasableStrings, isObject, type JsonObject } from "./tombstone.js";

/**
 * Erase from a session, clear the derived stores, and find the forks that hold a copy.
 * A fork is rewritten only when the caller confirms it; a declined fork is not opened for writing.
 */

/** Range strings shorter than this are not searched for in derived stores: "ok" would remove every document that says ok. A match needle is always searched whole. */
export const MIN_DERIVED_TEXT = 12;

export interface ForkCopy {
	readonly session: ErasureSession;
	/** Why this fork is listed. */
	readonly reason: "entries" | "match";
	/** Entry ids in the fork that are copies of erased entries, or that hold the match. */
	readonly entryIds: readonly string[];
}

function readEntries(agentDir: string, file: string): JsonObject[] {
	const raw = withStoreDirectory(agentDir, path.dirname(file), (held) => readStoreFile(path.join(held, path.basename(file))));
	return raw.split("\n").flatMap((line) => { try { const v: unknown = JSON.parse(line); return isObject(v) && typeof v.id === "string" && v.type !== "session" ? [v] : []; } catch { return []; } });
}

/** Transitive forks of `target`, by parent link. */
export function forksOf(target: ErasureSession, sessions: readonly ErasureSession[]): ErasureSession[] {
	const paths = new Set([path.resolve(target.path)]);
	const forks: ErasureSession[] = [];
	for (let changed = true; changed;) {
		changed = false;
		for (const session of sessions) {
			if (session.parentSessionPath && paths.has(path.resolve(session.parentSessionPath)) && !paths.has(path.resolve(session.path))) { forks.push(session); paths.add(path.resolve(session.path)); changed = true; }
		}
	}
	return forks;
}

/** Read-only: the forks that hold a copy of the given entry ids or of the match text. */
export function findForkCopies(agentDir: string, target: ErasureSession, sessions: readonly ErasureSession[], selector: { readonly ids: readonly string[] } | { readonly text: string }): ForkCopy[] {
	const found: ForkCopy[] = [];
	for (const session of forksOf(target, sessions)) {
		let entries: JsonObject[];
		try { entries = readEntries(agentDir, session.path); } catch { continue; }
		const entryIds = "ids" in selector
			? entries.filter((entry) => (selector.ids as readonly unknown[]).includes(entry.id)).map((entry) => String(entry.id))
			: entries.filter((entry) => erasableStrings(entry).some((text) => text.includes(selector.text))).map((entry) => String(entry.id));
		if (entryIds.length) found.push({ session, reason: "ids" in selector ? "entries" : "match", entryIds });
	}
	return found;
}

export interface EraseTextOptions {
	readonly agentDir: string;
	readonly session: ErasureSession;
	readonly selector: Extract<RewriteSelector, { kind: "range" | "match" }>;
	readonly currentSessionId?: string;
	/** All sessions of the profile, to find forks. */
	readonly sessions: readonly ErasureSession[];
	/** Asked once per fork that holds a copy. Anything but `true` leaves the fork untouched. */
	readonly confirmFork: (fork: ForkCopy) => Promise<boolean>;
	readonly now?: () => Date;
}

export interface EraseTextResult {
	readonly rewrite: RewriteResult;
	readonly forks: readonly { readonly fork: ForkCopy; readonly outcome: "erased" | "declined" | "nothing-to-erase" | "refused" | "failed"; readonly reason?: string }[];
	readonly derived: DerivedCleanResult;
	/** Derived stores that still hold the erased text after cleaning. Empty means clean. */
	readonly remaining: readonly string[];
}

export function searchable(selector: EraseTextOptions["selector"], collected: readonly string[]): string[] {
	return selector.kind === "match" ? [selector.text] : [...new Set(collected.filter((text) => text.length >= MIN_DERIVED_TEXT))];
}

export async function eraseText(options: EraseTextOptions): Promise<EraseTextResult> {
	const collected: string[] = [];
	const base: Omit<RewriteOptions, "sessionFile" | "selector"> = { agentDir: options.agentDir, ...(options.currentSessionId ? { currentSessionId: options.currentSessionId } : {}), ...(options.now ? { now: options.now } : {}), collectErasedText: (strings) => { collected.push(...strings); } };
	const rewrite = rewriteSession({ ...base, sessionFile: options.session.path, selector: options.selector });
	if (rewrite.status !== "erased") return { rewrite, forks: [], derived: { removed: [], redacted: [], failed: [] }, remaining: [] };
	const erasedIds = rewrite.entries.map((entry) => entry.entryId);
	const copies = findForkCopies(options.agentDir, options.session, options.sessions, options.selector.kind === "match" ? { text: options.selector.text } : { ids: erasedIds });
	const forks: EraseTextResult["forks"][number][] = [];
	const rewritten: ErasureSession[] = [{ id: rewrite.sessionId, path: options.session.path }];
	for (const fork of copies) {
		if (await options.confirmFork(fork) !== true) { forks.push({ fork, outcome: "declined" }); continue; }
		const selector: RewriteSelector = options.selector.kind === "match" ? options.selector : { kind: "entries", ids: fork.entryIds };
		const outcome = rewriteSession({ ...base, sessionFile: fork.session.path, selector });
		if (outcome.status === "erased") { rewritten.push(fork.session); forks.push({ fork, outcome: "erased" }); }
		else forks.push({ fork, outcome: outcome.status, ...("reason" in outcome ? { reason: outcome.reason } : {}) });
	}
	const texts = searchable(options.selector, collected);
	const derived: DerivedCleanResult = { removed: [], redacted: [], failed: [] };
	const remaining: string[] = [];
	for (const session of rewritten) {
		const result = cleanDerivedStores({ agentDir: options.agentDir, sessionId: session.id, sessionFile: session.path, texts });
		(derived.removed as string[]).push(...result.removed); (derived.redacted as string[]).push(...result.redacted); (derived.failed as string[]).push(...result.failed);
		remaining.push(...derivedStoresHolding(options.agentDir, session.id, session.path, texts));
	}
	return { rewrite, forks, derived, remaining: [...new Set(remaining)] };
}

export { holdsText };
