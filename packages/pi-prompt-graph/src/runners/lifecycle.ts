import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterCompaction, anchorAt, canCollapseTo, NO_ANCHOR, type AnchorState, type Interruption, type InterruptionSource } from "../pure/lifecycle.js";

/**
 * The live half of Stage 3's lifecycle: what a real Pi session does to a run.
 *
 * Every decision is in `src/pure/lifecycle.ts` and tested without a session.
 * This file only observes — it subscribes to Pi's events and records what
 * happened, so a run can read it at the next node boundary.
 *
 * The split matters here more than usual, because the events themselves cannot
 * be summoned in a test: a person typing and a session ending are not things a
 * test can stage honestly.
 */

/** The slice of Pi this needs, declared structurally so a test can supply a plain object. */
export interface LifecycleHost {
	on(event: string, listener: (payload: unknown, ctx?: unknown) => unknown): unknown;
}

/**
 * Watches a live session and reports, synchronously, whether a run should stop
 * at its next node boundary.
 *
 * **First one wins.** Once an interruption is recorded it is not overwritten:
 * if a person types and the session then ends, the run is already stopping and
 * the second event would only change what it is called. Reporting the later
 * event would also be wrong in the worse direction — an operator pause that a
 * session end turned into a suspension would look, to the next session, like
 * something nobody asked for.
 */
export class SessionInterruptions implements InterruptionSource {
	private interruption: Interruption | undefined;

	constructor(host: LifecycleHost) {
		// A host with no event surface can never interrupt anything, and that is a
		// legitimate host: `/graph check` needs no session lifecycle at all. It
		// degrades to "nothing ever interrupts" rather than refusing to load, which
		// is the degrade-do-not-fail rule (.spec/0009 §1).
		if (typeof host?.on !== "function") return;
		// A person typed. This fires before templates and skills expand, and
		// before the agent processes anything, which is what makes it usable as
		// "the operator is about to say something" rather than "the operator has
		// said something to a node".
		host.on("input", (payload: unknown) => {
			// ...but only when a PERSON typed it. Pi reports `source` as
			// "interactive" (typed), "rpc" (an API client) or "extension" (another
			// extension calling sendUserMessage). PTM starts every template node by
			// injecting a message, which arrives here as an "extension" input.
			//
			// Without this check Mode A pauses itself: the first template node the
			// graph runs looks exactly like an operator interrupting, so the run
			// stops at the very next boundary, every time. The first real run of
			// this package did precisely that and got one node in (#30). The tests
			// missed it because a synthetic input event carries no `source` at all.
			if (readString(payload, "source") === "extension") return;
			const text = readString(payload, "text");
			this.record({ kind: "operator-input", ...(text ? { detail: `operator typed: ${truncate(text)}` } : {}) });
			// Deliberately returns nothing: the graph does not intercept, transform,
			// or swallow the person's message. It stops running nodes and gets out of
			// the way, which is the whole point of pausing at a boundary (D-021).
		});

		host.on("session_shutdown", () => {
			this.record({ kind: "session-ended", detail: "the session ended while the run was active" });
		});
	}

	pending(): Interruption | undefined {
		return this.interruption;
	}

	/** Clear a recorded interruption, for an operator resuming a paused run. */
	clear(): void {
		this.interruption = undefined;
	}

	private record(interruption: Interruption): void {
		if (this.interruption) return;
		this.interruption = interruption;
	}
}

/**
 * Tracks the collapse anchor across a live session's compactions.
 *
 * The rule it enforces is one line in `.spec/0009` C1 — **stale anchors are
 * discarded, not repaired** — and the reason it needs a live session at all is
 * that only the session knows a compaction happened.
 *
 * When `pi-context-aware` is absent the graph cannot be told, which is why
 * `collapseEnabled` refuses collapse outright in that case rather than holding
 * an anchor it cannot protect.
 */
export class SessionAnchor {
	private state: AnchorState = NO_ANCHOR;
	private compactions = 0;

	constructor(host: LifecycleHost) {
		// Same tolerance as SessionInterruptions: a host with no events never
		// reports a compaction, so the anchor simply never goes stale.
		if (typeof host?.on !== "function") return;
		// `session_compact` fires after the compaction is saved, which is the
		// point at which any anchor taken before it is a weak reference.
		host.on("session_compact", () => {
			this.compactions += 1;
			this.state = afterCompaction(this.state);
		});
	}

	/** Remember the current session leaf as the point a back edge folds back to. */
	set(anchorId: string): void {
		this.state = anchorAt(anchorId);
	}

	/**
	 * The anchor a back edge may collapse to, or `undefined`.
	 *
	 * `undefined` after a compaction until the run re-anchors: the back edge then
	 * proceeds without collapsing, which costs context and loses nothing else.
	 */
	target(): string | undefined {
		return canCollapseTo(this.state);
	}

	/** How many compactions this session has seen, for the journal. */
	compactionCount(): number {
		return this.compactions;
	}
}

/**
 * A suspended run waiting in this working directory, if there is one.
 *
 * Read at `session_start` so the operator can be told **once** that a run is
 * waiting. Reading the journal rather than keeping a registry is deliberate:
 * the journal is the durable record, and a registry would be a second source of
 * truth that could disagree with it.
 *
 * Returns the most recently suspended run. More than one is possible and only
 * the newest is reported: the notice exists to prompt a decision, not to be an
 * inventory, and `/graph status` lists them all.
 */
export async function suspendedRunIn(runsRoot: string): Promise<{ runId: string; graphName?: string } | undefined> {
	let entries: string[];
	try {
		entries = await readdir(runsRoot);
	} catch {
		// No runs directory at all is the common case, not an error.
		return undefined;
	}
	const found: Array<{ runId: string; graphName?: string; at: string }> = [];
	for (const runId of entries) {
		const records = await readJournalTail(join(runsRoot, runId, "journal.jsonl"));
		if (!records.length) continue;
		// The LAST lifecycle record decides. A run that suspended and was later
		// resumed and finished must not be reported as waiting.
		const last = records[records.length - 1]!;
		if (last.type !== "run-suspended") continue;
		// `graphName` is written on `run-started` only, so the name comes from the
		// first record rather than the one that decided.
		const graphName = records.find((record) => record.graphName)?.graphName;
		found.push({ runId, ...(graphName ? { graphName } : {}), at: last.at ?? "" });
	}
	if (!found.length) return undefined;
	// ISO-8601 timestamps, so lexicographic order is chronological order.
	found.sort((left, right) => right.at.localeCompare(left.at));
	const newest = found[0]!;
	return { runId: newest.runId, ...(newest.graphName ? { graphName: newest.graphName } : {}) };
}

interface TailRecord {
	type: string;
	at?: string;
	graphName?: string;
}

/**
 * The journal's lifecycle records, in order.
 *
 * Only the record types that decide whether a run is waiting are kept, so a
 * long run's journal does not have to be held in memory to answer one question
 * at session start.
 */
async function readJournalTail(path: string): Promise<TailRecord[]> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return [];
	}
	const keep = new Set(["run-started", "run-suspended", "run-resumed", "run-finished", "run-paused"]);
	const records: TailRecord[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as Record<string, unknown>;
			const type = typeof parsed.type === "string" ? parsed.type : undefined;
			if (!type || !keep.has(type)) continue;
			records.push({
				type,
				...(typeof parsed.at === "string" ? { at: parsed.at } : {}),
				...(typeof parsed.graphName === "string" ? { graphName: parsed.graphName } : {}),
			});
		} catch {
			// A torn final line is expected after a kill; earlier records still count.
			continue;
		}
	}
	return records;
}

function readString(payload: unknown, key: string): string | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	const value = (payload as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}

function truncate(text: string, max = 80): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
