import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { splitFrontmatter } from "../src/index.ts";

describe("splitFrontmatter", () => {
	it("splits a Claude Code subagent file into frontmatter and body", () => {
		const source = [
			"---",
			"name: reviewer",
			"description: Use after a change passes its tests.",
			"---",
			"You review one change.",
			"",
		].join("\n");
		assert.deepEqual(splitFrontmatter(source), {
			ok: true,
			frontmatter: "name: reviewer\ndescription: Use after a change passes its tests.",
			body: "You review one change.\n",
			bodyLine: 5,
		});
	});

	it("reads Windows line endings as Unix ones", () => {
		assert.deepEqual(splitFrontmatter("---\r\nname: a\r\n---\r\nLine one.\r\nLine two.\r\n"), {
			ok: true,
			frontmatter: "name: a",
			body: "Line one.\nLine two.\n",
			bodyLine: 4,
		});
	});

	it("drops a leading byte order mark without shifting line numbers", () => {
		assert.deepEqual(splitFrontmatter("\uFEFF---\nname: a\n---\nBody"), {
			ok: true,
			frontmatter: "name: a",
			body: "Body",
			bodyLine: 4,
		});
	});

	it("ends the frontmatter at the first fence and keeps later --- lines in the body", () => {
		assert.deepEqual(splitFrontmatter("---\nname: a\n---\nPart one.\n---\nPart two.\n"), {
			ok: true,
			frontmatter: "name: a",
			body: "Part one.\n---\nPart two.\n",
			bodyLine: 4,
		});
	});

	it("does not treat four dashes or an indented fence as a closing fence", () => {
		assert.deepEqual(splitFrontmatter("---\nname: a\n----\n  ---\nb: c\n---\nBody"), {
			ok: true,
			frontmatter: "name: a\n----\n  ---\nb: c",
			body: "Body",
			bodyLine: 7,
		});
	});

	it("accepts trailing spaces and tabs after either fence", () => {
		assert.deepEqual(splitFrontmatter("--- \t\nname: a\n---  \nBody"), {
			ok: true,
			frontmatter: "name: a",
			body: "Body",
			bodyLine: 4,
		});
	});

	it("returns empty strings for empty frontmatter and a missing body", () => {
		assert.deepEqual(splitFrontmatter("---\n---"), { ok: true, frontmatter: "", body: "", bodyLine: 3 });
	});

	for (const [label, source] of [
		["an empty file", ""],
		["a file with no frontmatter", "You review one change.\n"],
		["a blank line before the fence", "\n---\nname: a\n---\n"],
		["an indented opening fence", " ---\nname: a\n---\n"],
		["four dashes as the opening fence", "----\nname: a\n---\n"],
		["text after the opening dashes", "--- name: a\n---\n"],
	] as const) {
		it(`reports a missing opening fence for ${label}`, () => {
			assert.deepEqual(splitFrontmatter(source), {
				ok: false,
				code: "missing-opening-fence",
				line: 1,
				message: "An agent definition must start with a line that contains only ---.",
			});
		});
	}

	for (const [label, source] of [
		["a lone fence", "---"],
		["frontmatter that never closes", "---\nname: a\ndescription: b\n"],
	] as const) {
		it(`reports a missing closing fence for ${label}`, () => {
			assert.deepEqual(splitFrontmatter(source), {
				ok: false,
				code: "missing-closing-fence",
				line: 1,
				message: "The frontmatter that starts on line 1 has no closing line that contains only ---.",
			});
		});
	}
});
