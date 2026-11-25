import test from "node:test";
import assert from "node:assert/strict";

import { assessEntryPressure, entriesSinceLastCompaction } from "../src/compaction/entry-pressure.js";
import { pressureActionLine, requestPressure } from "../src/folds/request-pressure.js";

// pi-context-aware#441: a fold-heavy session stays at low token usage while its path grows past
// what Pi can rebuild. The entry count since the last compaction is pressure of its own.

const entries = (n: number, type = "message") => Array.from({ length: n }, (_, index) => ({ type, id: `e${index}` }));

test("#441: entries are counted after the newest compaction, or over the whole path without one", () => {
	assert.equal(entriesSinceLastCompaction([]), 0);
	assert.equal(entriesSinceLastCompaction(entries(7)), 7, "no compaction: the whole path counts");
	const path = [...entries(5), { type: "compaction", id: "c1" }, ...entries(3), { type: "compaction", id: "c2" }, ...entries(4)];
	assert.equal(entriesSinceLastCompaction(path), 4, "only entries after the newest compaction count");
	assert.equal(entriesSinceLastCompaction([...entries(4), { type: "compaction", id: "c" }]), 0, "a compaction at the tip resets the count");
	assert.equal(entriesSinceLastCompaction([null, 3, "compaction", ...entries(2)]), 5, "values that are not entries are counted, never mistaken for a compaction");
});

test("#441: the limit is reached at the configured count, and a disabled check reports nothing", () => {
	const settings = { enabled: true, maxEntriesSinceCompaction: 1_000 };
	assert.deepEqual(assessEntryPressure(entries(999), settings), { entriesSinceCompaction: 999, limit: 1_000, exceeded: false });
	assert.deepEqual(assessEntryPressure(entries(1_000), settings), { entriesSinceCompaction: 1_000, limit: 1_000, exceeded: true });
	const compacted = [...entries(5_000), { type: "compaction", id: "c" }, ...entries(10)];
	assert.equal(assessEntryPressure(compacted, settings)?.exceeded, false, "a compaction starts the count again");
	assert.equal(assessEntryPressure(entries(50_000), { ...settings, enabled: false }), null);
});

// The envelope this test read is gone (pi-context-aware#461); the request's one pressure value carries the limit.
test("#441: past the entry limit the request's pressure is URGENT at low usage and its action line names entry count", () => {
	const at = (entriesSinceCompaction: number) => requestPressure({
		tokens: 10_000,
		window: 200_000,
		measured: true,
		source: "fold-pass",
		entries: assessEntryPressure(entries(entriesSinceCompaction), { enabled: true, maxEntriesSinceCompaction: 30_000 }),
	});
	const line = (entriesSinceCompaction: number, mode: "full" | "band" = "full", compact = true) =>
		pressureActionLine(at(entriesSinceCompaction), { mode, tools: { fold: true, compact }, foldTool: "context_fold" });
	assert.equal(at(29_999).band, "OK", "under the limit nothing changes");
	assert.equal(line(29_999), undefined, "and no line is sent at 5%");
	assert.equal(at(30_000).band, "URGENT", "the limit itself is reached");
	assert.match(line(31_000)!, /Context pressure URGENT \(31000 entries since the last compaction, at the limit of 30000; 5% used, about 190k tokens of headroom\)\. Before the next nontrivial tool call, call `context_compact`/u);
	assert.match(line(31_000, "band")!, /Context pressure URGENT \(entry count at its limit\)\. Before the next nontrivial tool call, call `context_compact`/u);
	const noCompaction = line(31_000, "full", false)!;
	assert.doesNotMatch(noCompaction, /context_compact/u, "the action still follows what the session can do");
	assert.match(noCompaction, /Context pressure URGENT/u);
});
