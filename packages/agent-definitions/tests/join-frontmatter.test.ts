import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { joinFrontmatter, splitFrontmatter } from "../src/index.ts";

describe("joinFrontmatter", () => {
	it("writes fences, YAML fields in insertion order and the body", () => {
		assert.equal(
			joinFrontmatter({ name: "reviewer", tools: ["read", "search"] }, "Review one change.\n"),
			"---\nname: reviewer\ntools:\n  - read\n  - search\n---\nReview one change.\n",
		);
	});

	it("leaves out undefined fields", () => {
		assert.equal(joinFrontmatter({ name: "a", model: undefined }, ""), "---\nname: a\n---\n");
	});

	it("writes an empty block when every field is missing", () => {
		assert.equal(joinFrontmatter({ model: undefined }, "Body"), "---\n---\nBody");
	});

	it("does not fold a long description onto several lines", () => {
		const description = "word ".repeat(40).trim();
		const text = joinFrontmatter({ description }, "");
		assert.equal(text.split("\n").length, 4);
	});

	it("round-trips through splitFrontmatter and the YAML parser", () => {
		const fields = {
			name: "scout",
			description: "Finds files: fast, read-only.",
			model: ["provider/a", "provider/b"],
			limits: { maxTurns: 10 },
			invocation: { model: true, user: false },
		};
		const body = "First line.\n\n---\nA rule line inside the body.\n";
		const split = splitFrontmatter(joinFrontmatter(fields, body));
		assert.equal(split.ok, true);
		if (!split.ok) return;
		assert.equal(split.body, body);
		assert.equal(split.bodyLine, 13);
		assert.deepEqual(parse(split.frontmatter), fields);
	});
});
