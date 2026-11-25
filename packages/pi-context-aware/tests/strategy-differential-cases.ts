/**
 * The differential cases of pi-context-aware#468 and pi-context-aware#472: synthetic sessions and the `context_fold`
 * requests recorded against them (tests/fixtures/parity-corpus/cases.json and tests/fixtures/strategy-differential).
 * Shared by the differential tests; not a test file itself.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

import type { FoldHintView, ResolvedFoldHint } from "../src/folds/fold-hints.js";

export interface DifferentialRequest {
	readonly startId: string;
	readonly endId: string;
	readonly summary: string;
	readonly topic?: string;
	readonly summaryMaxChars?: number;
}

export interface DifferentialCase {
	readonly id: string;
	/** `parity`: the parity corpus runner's seed (16 large messages, eight recent ones). Otherwise `messages` alternating user and assistant messages of `repeat` sentences. */
	readonly seed: { readonly parity?: boolean; readonly toolPairs?: boolean; readonly messages?: number; readonly repeat?: number; readonly pairs?: readonly number[] };
	/** Fold hints by 1-based message number. */
	readonly hints?: { readonly verbatim?: readonly number[]; readonly condensed?: readonly number[]; readonly oneLine?: readonly number[] };
	readonly steps: readonly (readonly DifferentialRequest[])[];
}

export const FIXTURES = path.resolve("tests/fixtures");
const SENTENCE = "Invented archive review: keep the numbered decision and its reversible ordering. ";

function parityCases(): DifferentialCase[] {
	const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES, "parity-corpus/cases.json"), "utf8")) as { id: string; toolPairs?: boolean; steps: DifferentialRequest[][] }[];
	return raw.map((item) => ({ id: `parity-${item.id}`, seed: { parity: true, ...(item.toolPairs ? { toolPairs: true } : {}) }, steps: item.steps }));
}

export function differentialCases(): DifferentialCase[] {
	const own = JSON.parse(fs.readFileSync(path.join(FIXTURES, "strategy-differential/cases.json"), "utf8")) as DifferentialCase[];
	return [...parityCases(), ...own];
}

export interface Seeded {
	readonly manager: SessionManager;
	/** Entry id of each seeded message, by 1-based message number. */
	readonly ids: readonly string[];
	readonly modelContextLimit: number;
	readonly hints?: FoldHintView;
}

/** A new session holding the case's synthetic messages. */
export function seedCase(item: DifferentialCase): Seeded {
	const manager = SessionManager.inMemory("/tmp");
	const ids: string[] = [];
	const user = (content: string) => ids.push(manager.appendMessage({ role: "user", content, timestamp: 1 }));
	const assistant = (content: string) => ids.push(manager.appendMessage(fauxAssistantMessage(content, { timestamp: 1 })));
	const call = (id: string, item: number) => ids.push(manager.appendMessage(fauxAssistantMessage(fauxToolCall("archive_probe", { item }, { id }), { stopReason: "toolUse", timestamp: 1 })));
	const result = (id: string, content: string) => ids.push(manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: "archive_probe", content: [{ type: "text", text: content }], isError: false, timestamp: 1 }));
	if (item.seed.parity) {
		// The parity runner's seed (scripts/parity-differential.mjs).
		const text = (i: number) => `Synthetic archive item ${i}.\n${SENTENCE.repeat(2000)}`;
		for (let i = 1; i <= 16; i++) {
			if (item.seed.toolPairs && [2, 5].includes(i)) call(`edge-${i}`, i);
			else if (item.seed.toolPairs && [3, 6].includes(i)) result(`edge-${i - 1}`, text(i));
			else if (i % 2 === 1 || (item.seed.toolPairs && i === 4)) user(text(i));
			else assistant(text(i));
		}
		for (let i = 0; i < 8; i++) user(`Synthetic recent review ${i}.\n${"Keep this recent invented work visible. ".repeat(1600)}`);
	} else {
		const text = (i: number) => `Synthetic archive item ${i}.\n${SENTENCE.repeat(item.seed.repeat ?? 40)}`;
		const pairs = new Set(item.seed.pairs ?? []);
		for (let i = 1; i <= (item.seed.messages ?? 14); i++) {
			if (pairs.has(i)) call(`p${i}`, i);
			else if (pairs.has(i - 1)) result(`p${i - 1}`, text(i));
			else if (i % 2 === 1) user(text(i));
			else assistant(text(i));
		}
	}
	return { manager, ids, modelContextLimit: item.seed.parity ? 2_000_000 : 200_000, ...(item.hints ? { hints: hintView(item.hints, ids) } : {}) };
}

function hintView(hints: NonNullable<DifferentialCase["hints"]>, ids: readonly string[]): FoldHintView {
	const byId = new Map<string, ResolvedFoldHint>();
	const set = (numbers: readonly number[] | undefined, hint: (n: number) => ResolvedFoldHint) => { for (const n of numbers ?? []) byId.set(ids[n - 1]!, hint(n)); };
	set(hints.verbatim, () => ({ policy: "verbatim", key: "differential-verbatim" }));
	set(hints.condensed, (n) => ({ policy: "condensed", key: "differential-condensed", condensed: `Condensed synthetic item ${n}.` }));
	set(hints.oneLine, (n) => ({ policy: "one-line", key: "differential-line", line: `Synthetic item ${n} was read.` }));
	return { forEntry: (entry: SessionEntry) => byId.get(entry.id), forMessage: () => undefined, verbatimTools: () => [] };
}
