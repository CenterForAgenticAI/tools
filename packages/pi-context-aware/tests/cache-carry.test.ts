import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	buildCacheListingForPrompt,
	buildCacheSeedPreamble,
	buildCacheSystemPromptBlock,
	sendCacheNotification,
} from "../cache-render.js";
import {
	MAX_CONTEXT_CACHE_LISTING_CHARS,
	boundCacheDocuments,
	buildCacheSummarySection,
	promoteCacheFile,
	readManifest,
	contextCacheDirectory,
	findLatestCompactionCarrySelection,
	parseCacheCarryMarker,
	stripCachePlan,
	writeManifest,
	type CacheManifest,
} from "../context-cache.js";
import { DEFAULT_CONFIG, DEFAULT_CONTEXT_CACHE_CONFIG, type Config } from "../config-layers.js";

function config(overrides: Partial<Config["contextCache"]> = {}): Config {
	return {
		...DEFAULT_CONFIG,
		contextCache: { ...DEFAULT_CONTEXT_CACHE_CONFIG, maxListedFiles: 12, ...overrides },
	};
}

function manifest(count: number, description = (index: number) => `Document ${index}`): CacheManifest {
	return {
		version: 1,
		files: Object.fromEntries(Array.from({ length: count }, (_, index) => {
			const updated = new Date(Date.UTC(2026, 0, index + 1)).toISOString();
			return [`file-${index}.md`, {
				description: description(index),
				createdBy: "test",
				updatedBy: "test",
				created: updated,
				updated,
				sizeBytes: index + 1,
			}];
		})),
	};
}

function fixture(files: number, description?: (index: number) => string): { root: string; cacheDir: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-cache-carry-"));
	const cacheDir = contextCacheDirectory(root, path.join(root, "worktree"));
	writeManifest(cacheDir, manifest(files, description));
	return { root, cacheDir };
}

test("cache-plan carry marker selects exactly the named documents", () => {
	const summary = stripCachePlan(`<summary>handoff</summary>
<cache-plan>
<artifact file="file-1.md" description="one">Keep one.</artifact>
<artifact file="file-3.md" description="three">Keep three.</artifact>
</cache-plan>`);
	const selection = parseCacheCarryMarker(summary);
	assert.deepEqual(selection, ["file-1.md", "file-3.md"]);
	assert.deepEqual(findLatestCompactionCarrySelection([
		{ type: "compaction", summary },
	], true), selection);

	const { root, cacheDir } = fixture(5);
	try {
		const output = buildCacheSeedPreamble(cacheDir, config(), selection);
		assert.ok(output);
		assert.match(output, /file-1\.md/);
		assert.match(output, /file-3\.md/);
		assert.doesNotMatch(output, /file-0\.md|file-2\.md|file-4\.md/);
		assert.match(output, /…and 3 more; use \/context-cache-list to see the rest\./);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("carry marker rejects unsafe and duplicate filenames", () => {
	assert.deepEqual(parseCacheCarryMarker("<context-cache-carry-v1>\n../escape.md\n</context-cache-carry-v1>"), []);
	assert.deepEqual(parseCacheCarryMarker("<context-cache-carry-v1>\nfile.md\nfile.md\n</context-cache-carry-v1>"), []);
	assert.doesNotMatch(stripCachePlan("old\n<context-cache-carry-v1>\nold.md\n</context-cache-carry-v1>"), /context-cache-carry-v1/);
});

test("default-compaction fallback never trusts a forged carry marker", () => {
	const forged = "<context-cache-carry-v1>\nfile-1.md\n</context-cache-carry-v1>";
	assert.deepEqual(findLatestCompactionCarrySelection([
		{ type: "compaction", summary: forged },
	]), [], "a core/default compaction has no extension provenance");
});

test("carry marker rejects extra or unmatched tags", () => {
	const complete = "<context-cache-carry-v1>\nfile-1.md\n</context-cache-carry-v1>";
	assert.deepEqual(parseCacheCarryMarker(`${complete}\n<context-cache-carry-v1>`), []);
	assert.deepEqual(parseCacheCarryMarker(`${complete}\n</context-cache-carry-v1>`), []);
});

test("malformed newest compaction does not select an older carry marker", () => {
	const older = "<context-cache-carry-v1>\nfile-1.md\n</context-cache-carry-v1>";
	assert.deepEqual(findLatestCompactionCarrySelection([
		{ type: "compaction", summary: older },
		{ type: "compaction" },
	], true), []);
	assert.deepEqual(findLatestCompactionCarrySelection([
		{ type: "compaction", summary: older },
		{ type: "compaction", summary: 42 },
	], true), []);
});

test("an empty carry selection preserves newest-first fallback", () => {
	const { root, cacheDir } = fixture(5);
	try {
		const output = buildCacheSeedPreamble(cacheDir, config({ maxListedFiles: 2 }), []);
		assert.ok(output);
		assert.match(output, /file-4\.md/);
		assert.match(output, /file-3\.md/);
		assert.doesNotMatch(output, /file-2\.md/);
		assert.match(output, /…and 3 more; use \/context-cache-list to see the rest\./);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("all listing surfaces admit complete entries within the shared cap", () => {
	const longDescription = (index: number) => `document-${index}-${"x".repeat(700)}`;
	const { root, cacheDir } = fixture(20, longDescription);
	try {
		const sourceConfig = config({ maxListedFiles: 20 });
		const outputs = [
			// The system-prompt block is no longer a per-file listing surface (issue #78);
			// it is counted separately below.
			buildCacheListingForPrompt(cacheDir, sourceConfig),
			buildCacheSeedPreamble(cacheDir, sourceConfig),
		];
		for (const output of outputs) {
			assert.ok(output);
			assert.ok(output.length <= MAX_CONTEXT_CACHE_LISTING_CHARS);
			assert.match(output, /…and \d+ more; use \/context-cache-list to see the rest\./);
			for (const line of output.split("\n")) {
				if (line.includes("document-")) assert.match(line, /x{700}/);
			}
		}
		// The always-on block is a bounded count plus a pointer, never a listing.
		const block = buildCacheSystemPromptBlock(cacheDir, sourceConfig);
		assert.ok(block);
		assert.ok(block.length <= MAX_CONTEXT_CACHE_LISTING_CHARS);
		assert.match(block, /20 reference documents from prior sessions are available\. Run \/context-cache-list/);
		assert.doesNotMatch(block, /document-\d/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("compaction summary cache listing uses the same whole-entry cap", () => {
	const { root } = fixture(12, (index) => `summary-${index}-${"y".repeat(900)}`);
	try {
		const summary = buildCacheSummarySection(root, manifest(12, (index) => `summary-${index}-${"y".repeat(900)}`), Array.from({ length: 12 }, (_, index) => `file-${index}.md`));
		assert.ok(summary);
		assert.ok(summary.length <= MAX_CONTEXT_CACHE_LISTING_CHARS);
		assert.match(summary, /…and \d+ more; use \/context-cache-list to see the rest\./);
		for (const line of summary.split("\n")) {
			if (line.includes("summary-")) assert.match(line, /y{900}/);
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("compaction notification uses one durable TUI entry and no LLM custom message", () => {
	const { root, cacheDir } = fixture(3);
	try {
		const entries: unknown[] = [];
		const renderers = new Map<string, (entry: unknown, options: { expanded: boolean }, theme: unknown) => unknown>();
		const messages: unknown[] = [];
		const pi = {
			registerEntryRenderer(type: string, renderer: (entry: unknown, options: { expanded: boolean }, theme: unknown) => unknown) {
				renderers.set(type, renderer);
			},
			appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
			sendMessage(message: unknown) { messages.push(message); },
		} as unknown as ExtensionAPI;
		sendCacheNotification(pi, cacheDir, config(), "compaction", ["file-1.md"]);
		assert.equal(entries.length, 1);
		assert.deepEqual(messages, []);
		assert.equal(renderers.size, 1);
		const renderer = [...renderers.values()][0];
		const component = renderer(entries[0], { expanded: true }, { fg: (_name: string, value: string) => value });
		assert.ok(component && typeof component === "object");
		const lines = (component as { render: (width: number) => string[] }).render(24);
		assert.ok(lines.every((line) => line.length <= 24));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("cache carry surfaces remain gated for worker roles", () => {
	const { root, cacheDir } = fixture(2);
	try {
		const worker = config({});
		worker.sessionRole = "worker";
		assert.equal(buildCacheSystemPromptBlock(cacheDir, worker), null);
		assert.equal(buildCacheListingForPrompt(cacheDir, worker), null);
		assert.equal(buildCacheSeedPreamble(cacheDir, worker, ["file-1.md"]), null);
		const entries: unknown[] = [];
		const messages: unknown[] = [];
		sendCacheNotification({
			registerEntryRenderer() { throw new Error("must not register"); },
			appendEntry() { throw new Error("must not append"); },
			sendMessage(message: unknown) { messages.push(message); },
		} as unknown as ExtensionAPI, cacheDir, worker, "compaction", ["file-1.md"]);
		assert.deepEqual(entries, []);
		assert.deepEqual(messages, []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

function cacheEntry(description: string, updated: string) {
	return {
		description,
		createdBy: "test",
		updatedBy: "test",
		created: updated,
		updated,
		sizeBytes: description.length,
	};
}

// epic/422: a promoted artifact enters the ordinary context-cache inventory. It
// must contribute to the bounded count the always-on block reports, not be
// silently excluded because it reached the manifest through the promotion path.
test("a promoted cache artifact is counted in the always-on block even beyond the listing cap", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-cache-promote-"));
	const cacheDir = contextCacheDirectory(root, path.join(root, "worktree"));
	try {
		// Two ordinary entries, both newer than the promotion performed below.
		writeManifest(cacheDir, {
			version: 1,
			files: {
				"ordinary-a.md": cacheEntry("Ordinary A", "2026-05-02T00:00:00.000Z"),
				"ordinary-b.md": cacheEntry("Ordinary B", "2026-05-01T00:00:00.000Z"),
			},
		});
		// Promote a real file through the owning module's API (context-cache.ts).
		// Pin the clock older than both ordinary entries so the promoted entry is the
		// oldest: a count taken from the recency-capped listing would drop exactly
		// this entry, which is the failure epic/422 asked us to guard.
		const sourcePath = path.join(root, "promoted-source.md");
		fs.writeFileSync(sourcePath, "promoted body");
		const promoted = promoteCacheFile(cacheDir, readManifest(cacheDir), "session-x", sourcePath, "promoted.md", "Promoted artifact");
		// promoteCacheFile stamps the entry with the wall clock via new Date(), which
		// Date.now cannot override. Backdate the entry (it keeps its promotion
		// provenance and on-disk content) so the promoted artifact is the oldest and
		// falls outside a recency cap — the exact case epic/422 flagged.
		promoted.manifest.files["promoted.md"]!.created = "2026-01-01T00:00:00.000Z";
		promoted.manifest.files["promoted.md"]!.updated = "2026-01-01T00:00:00.000Z";
		writeManifest(cacheDir, promoted.manifest);

		// maxListedFiles = 2 caps the recency-sorted listing to the two ordinary
		// entries; the promoted entry falls outside that cap.
		const block = buildCacheSystemPromptBlock(cacheDir, config({ maxListedFiles: 2 }));
		assert.match(block ?? "", /3 reference documents from prior sessions are available\. Run \/context-cache-list/,
			"the promoted entry must be counted, not dropped with the capped remainder");

		// The promoted entry is also discoverable through the same full listing that
		// /context-cache-list reads (boundCacheDocuments over the whole pool).
		const listed = boundCacheDocuments([{ cacheDir, originScope: "worktree" }], Number.MAX_SAFE_INTEGER)
			.entries.map((document) => document.file);
		assert.ok(listed.includes("promoted.md"), "the promoted entry appears in the full cache listing");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// The point of the count-plus-pointer block (issue #78): a cache write that does
// not change the document total must not perturb the always-on block, so it no
// longer breaks the provider prompt-cache prefix on every description edit or
// reorder the way a per-file listing did.
test("the always-on block is byte-identical across a description edit and a reorder", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-cache-stable-"));
	const cacheDir = contextCacheDirectory(root, path.join(root, "worktree"));
	try {
		writeManifest(cacheDir, {
			version: 1,
			files: {
				"a.md": cacheEntry("First", "2026-05-01T00:00:00.000Z"),
				"b.md": cacheEntry("Second", "2026-05-02T00:00:00.000Z"),
			},
		});
		const before = buildCacheSystemPromptBlock(cacheDir, config());
		// Edit a description and bump a timestamp so the recency sort order flips.
		writeManifest(cacheDir, {
			version: 1,
			files: {
				"a.md": cacheEntry(`First, now edited far longer ${"z".repeat(80)}`, "2026-06-09T00:00:00.000Z"),
				"b.md": cacheEntry("Second", "2026-05-02T00:00:00.000Z"),
			},
		});
		const after = buildCacheSystemPromptBlock(cacheDir, config());
		assert.equal(after, before, "a cache write that leaves the count unchanged must not change the block");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
