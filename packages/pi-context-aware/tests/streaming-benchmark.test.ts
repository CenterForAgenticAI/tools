import test from "node:test";
import assert from "node:assert/strict";
import { parseSeedExpansionResult, seedExpansionPreview, type SeedExpansionProgress } from "../seed-expansion.js";

interface ReplayResult {
	firstAnyDeltaIndex: number | null;
	firstPreviewIndex: number | null;
	previewUpdates: SeedExpansionProgress[];
	finalText: string;
}

function replayChunks(chunks: string[]): ReplayResult {
	let text = "";
	let firstAnyDeltaIndex: number | null = null;
	let firstPreviewIndex: number | null = null;
	const previewUpdates: SeedExpansionProgress[] = [];

	chunks.forEach((chunk, index) => {
		if (firstAnyDeltaIndex === null && chunk.length > 0) firstAnyDeltaIndex = index;
		text += chunk;
		const progress = seedExpansionPreview(text);
		previewUpdates.push(progress);
		if (firstPreviewIndex === null && progress.kind !== "raw_json" && progress.preview.length > 0) {
			firstPreviewIndex = index;
		}
	});

	return { firstAnyDeltaIndex, firstPreviewIndex, previewUpdates, finalText: text };
}

test("tagged replay exposes prompt preview before the final chunk", () => {
	const chunks = [
		`<result action="proceed" confidence="high">\n`,
		`<expanded_seed_prompt>\n`,
		`Continue`,
		` with item #3`,
		` by writing sequencing tests.`,
		`\n</expanded_seed_prompt>\n`,
		`<summary_focus_hints>\n- Preserve sequencing.\n</summary_focus_hints>\n</result>`,
	];
	const replay = replayChunks(chunks);
	assert.equal(replay.firstAnyDeltaIndex, 0);
	assert.equal(replay.firstPreviewIndex, 2);
	const firstPreviewIndex = replay.firstPreviewIndex;
	assert.notEqual(firstPreviewIndex, null);
	if (firstPreviewIndex === null) throw new Error("expected first preview index");
	assert.ok(firstPreviewIndex < chunks.length - 1, "preview should appear before final/done chunk");
	assert.equal(replay.previewUpdates[2].preview, "Continue");
	assert.equal(replay.previewUpdates[4].preview, "Continue with item #3 by writing sequencing tests.");
	const parsed = parseSeedExpansionResult(replay.finalText);
	assert.ok(parsed);
	assert.equal(parsed.action, "proceed");
});

test("question replay exposes clarification preview before final chunk", () => {
	const chunks = [
		`<result action="clarify" confidence="low">\n`,
		`<question>\n`,
		`Which`,
		` item #3 should continue?`,
		`\n</question>\n`,
		`<blocking_reason>Two lists exist.</blocking_reason>\n</result>`,
	];
	const replay = replayChunks(chunks);
	assert.equal(replay.firstPreviewIndex, 2);
	assert.equal(replay.previewUpdates[3].kind, "question");
	assert.equal(replay.previewUpdates[3].preview, "Which item #3 should continue?");
	const parsed = parseSeedExpansionResult(replay.finalText);
	assert.ok(parsed);
	assert.equal(parsed.action, "clarify");
});

test("deterministic benchmark result includes required timing/update dimensions", () => {
	const chunks = [
		`<result action="proceed" confidence="medium">\n<expanded_seed_prompt>`,
		`Implement parser tests`,
		` and command/tool harness tests.`,
		`</expanded_seed_prompt></result>`,
	];
	const syntheticChunkMs = 25;
	const replay = replayChunks(chunks);
	assert.notEqual(replay.firstPreviewIndex, null);
	const firstPreviewIndex = replay.firstPreviewIndex ?? 0;
	const benchmark = {
		fixture: "synthetic-streaming",
		timeToFirstAnyDeltaMs: (replay.firstAnyDeltaIndex ?? 0) * syntheticChunkMs,
		timeToFirstPreviewTokenMs: firstPreviewIndex * syntheticChunkMs,
		rewriteDurationMs: chunks.length * syntheticChunkMs,
		previewUpdateCount: replay.previewUpdates.length,
		previewCharsAtTTFP: replay.previewUpdates[firstPreviewIndex].preview.length,
	};
	assert.deepEqual(Object.keys(benchmark), [
		"fixture",
		"timeToFirstAnyDeltaMs",
		"timeToFirstPreviewTokenMs",
		"rewriteDurationMs",
		"previewUpdateCount",
		"previewCharsAtTTFP",
	]);
	assert.equal(benchmark.timeToFirstPreviewTokenMs, 25);
	assert.equal(benchmark.previewUpdateCount, 4);
	assert.ok(benchmark.previewCharsAtTTFP > 0);
});
