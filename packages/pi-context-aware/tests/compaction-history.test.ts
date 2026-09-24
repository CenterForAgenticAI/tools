import test from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { collectCompactionHistory, formatCompactionCountPrompt, formatCompactionHistory } from "../compaction-history.js";

function compaction(id: string, priorTranscriptPath: unknown = "~/session.jsonl", details: unknown = undefined): Record<string, unknown> {
	return {
		type: "compaction",
		id,
		parentId: `${id}-parent`,
		timestamp: `2026-08-12T00:00:0${id.slice(-1)}.000Z`,
		firstKeptEntryId: `${id}-kept`,
		tokensBefore: 1000,
		fromHook: false,
		details: details === undefined
			? {
				priorTranscriptPath,
				summary: "must not be exposed",
				rawSeedPrompt: "must not be exposed",
				expandedSeedPrompt: "must not be exposed",
				compactionAccounting: { secret: "must not be exposed" },
				unrelated: "must not be exposed",
			}
			: details,
	};
}

test("collects ordered current-branch boundaries without exposing entry details", () => {
	const result = collectCompactionHistory([
		{ type: "message", id: "off-branch" },
		compaction("c1"),
		compaction("c2", "/different/project/session.jsonl"),
		compaction("c3"),
	]);
	assert.deepEqual(result.compactions.map(({ ordinal, id, firstKeptEntryId }) => ({ ordinal, id, firstKeptEntryId })), [
		{ ordinal: 1, id: "c1", firstKeptEntryId: "c1-kept" },
		{ ordinal: 2, id: "c2", firstKeptEntryId: "c2-kept" },
		{ ordinal: 3, id: "c3", firstKeptEntryId: "c3-kept" },
	]);
	assert.equal(result.compactions[1]?.priorTranscriptPath, "/different/project/session.jsonl");
	assert.deepEqual(result.priorTranscriptPaths, [
		path.join(os.homedir(), "session.jsonl"),
		"/different/project/session.jsonl",
		path.join(os.homedir(), "session.jsonl"),
	]);
	assert.equal("summary" in result.compactions[0]!, false);
	assert.equal("details" in result.compactions[0]!, false);
	assert.equal("rawSeedPrompt" in result.compactions[0]!, false);
	assert.equal("expandedSeedPrompt" in result.compactions[0]!, false);
	assert.equal("compactionAccounting" in result.compactions[0]!, false);
	const rendered = formatCompactionHistory(result);
	assert.match(rendered, /1\. id=c1; parentId=c1-parent; firstKeptEntryId=c1-kept/);
	assert.doesNotMatch(rendered, /must not be exposed|unrelated|compactionAccounting/);
});

test("renders a bounded count without retaining summary text", () => {
	const history = collectCompactionHistory([compaction("c1"), compaction("c2"), compaction("c3")]);
	const rendered = formatCompactionCountPrompt(history);
	assert.equal(rendered, "Current session branch compaction count: 3.");
	assert.ok((rendered?.length ?? 0) <= 64);
	assert.doesNotMatch(rendered ?? "", /must not be exposed|summary|seed/i);
});

test("counts only the selected leaf branch and restarts ordinals per branch", () => {
	const firstBranch = collectCompactionHistory([compaction("first-1"), compaction("first-2"), compaction("first-3")]);
	const secondBranch = collectCompactionHistory([compaction("second-1")]);

	assert.equal(formatCompactionCountPrompt(firstBranch), "Current session branch compaction count: 3.");
	assert.equal(formatCompactionCountPrompt(secondBranch), "Current session branch compaction count: 1.");
	assert.deepEqual(secondBranch.compactions.map(({ ordinal, id }) => ({ ordinal, id })), [{ ordinal: 1, id: "second-1" }]);
});

test("counts malformed and detail-less compactions while nulling malformed fields", () => {
	const result = collectCompactionHistory([
		{ type: "compaction", id: 42, parentId: [], timestamp: "not-a-timestamp", firstKeptEntryId: {}, tokensBefore: -1, fromHook: "no" },
		{ type: "compaction", timestamp: "2026-08-12T00:00:00.000Z", tokensBefore: 1.5 },
		{ type: "compaction", details: undefined },
		{ type: "compaction", details: null },
		{ type: "compaction", details: "not-an-object" },
		{ type: "compaction", details: [] },
		{ type: "compaction", details: { priorTranscriptPath: 42 } },
		{ type: "message" },
	]);
	assert.equal(result.compactions.length, 7);
	assert.deepEqual(result.compactions[0], {
		ordinal: 1,
		id: null,
		parentId: null,
		timestamp: null,
		firstKeptEntryId: null,
		tokensBefore: null,
		fromHook: null,
		priorTranscriptPath: null,
	});
	assert.equal(result.compactions[1]?.timestamp, "2026-08-12T00:00:00.000Z");
	assert.equal(result.compactions[1]?.tokensBefore, null);
	assert.deepEqual(result.compactions.map(({ ordinal, priorTranscriptPath }) => ({ ordinal, priorTranscriptPath })), [
		{ ordinal: 1, priorTranscriptPath: null },
		{ ordinal: 2, priorTranscriptPath: null },
		{ ordinal: 3, priorTranscriptPath: null },
		{ ordinal: 4, priorTranscriptPath: null },
		{ ordinal: 5, priorTranscriptPath: null },
		{ ordinal: 6, priorTranscriptPath: null },
		{ ordinal: 7, priorTranscriptPath: null },
	]);
	assert.deepEqual(collectCompactionHistory([]), { compactions: [], priorTranscriptPaths: [] });
});

test("invalid branch input degrades to empty history", () => {
	assert.deepEqual(collectCompactionHistory(null as unknown as readonly unknown[]), { compactions: [], priorTranscriptPaths: [] });
});
