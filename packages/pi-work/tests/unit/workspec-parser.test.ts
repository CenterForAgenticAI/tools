import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { REPO_ROOT } from "../helpers/source-under-test.ts";
import { withDraftLineage } from "../helpers/workspec-source.ts";
import { parseYaml } from "../../src/schema/parser.ts";
import { validateWorkspec } from "../../src/schema/index.ts";

const validDir = path.join(REPO_ROOT, "tests", "fixtures", "workspec", "valid");
const invalidDir = path.join(REPO_ROOT, "tests", "fixtures", "workspec", "invalid");

test("design and all-fields fixtures parse, preserve source, and preserve tags", () => {
	for (const filename of ["design-section-2.yaml", "folded-tagged.yaml"]) {
		const source = readFileSync(path.join(validDir, filename), "utf8");
		const parsed = parseYaml(source);
		assert.equal(parsed.source, source);
		assert.deepEqual(parsed.findings, []);
		assert.ok(parsed.value);
	}
	const all = parseYaml(readFileSync(path.join(invalidDir, "all-fields-and-tags.yaml"), "utf8"));
	assert.equal(new Set(all.tags.map((tag) => tag.tag)).size, 17);
	assert.ok(all.tags.every((tag) => tag.style === "literal" || tag.style === "folded"));
});

test("schema-tightening boundaries accept verifier-valid minimums and root-empty work", () => {
	for (const filename of ["positive-output-floor.yaml", "one-child-composite.yaml", "one-item-checklist.yaml", "empty-checklist.yaml", "one-criterion-leaf.yaml", "evidence-minimums.yaml", "agent-relative-paths.yaml", "exit-boundaries.yaml"]) {
		const result = validateWorkspec(withDraftLineage(readFileSync(path.join(validDir, filename), "utf8")));
		assert.equal(result.valid, true, `${filename}: ${JSON.stringify(result.findings)}`);
	}
	const rootEmpty = validateWorkspec("title: T\ndescription: D\nintent: I\nwork: []\n");
	assert.equal(rootEmpty.valid, true);
	const nodeEmpty = validateWorkspec("title: T\ndescription: D\nintent: I\nwork:\n  - id: composite\n    task: integrate\n    work: []\n");
	assert.ok(nodeEmpty.findings.some((finding) => finding.code === "schema-invalid" && finding.path.join(".") === "work.0.work"));
});

test("folded tagged scalars retain exact source, metadata, and semantic content", () => {
	const source = readFileSync(path.join(validDir, "folded-tagged.yaml"), "utf8");
	const parsed = parseYaml(source);
	assert.equal(parsed.source, source);
	assert.deepEqual(parsed.findings, []);
	assert.deepEqual(parsed.tags, [{ path: ["title"], tag: "!md", style: "folded" }]);
	assert.equal(parsed.value && (parsed.value as { title: string }).title, "Folded title line one and line two\n\n");
});

test("unknown and non-block tags fail at their YAML paths", () => {
	const unknown = parseYaml("title: !wat hi\ndescription: D\nintent: I\nwork: []\n");
	assert.deepEqual(unknown.findings[0], { code: "yaml-unknown-tag", severity: "error", path: ["title"], tag: "!wat" });
	const plain = parseYaml("title: !md hi\ndescription: D\nintent: I\nwork: []\n");
	assert.deepEqual(plain.findings[0], { code: "yaml-tag-style", severity: "error", path: ["title"], tag: "!md", style: "PLAIN" });
	const flow = parseYaml("title: T\ndescription: D\nintent: I\nwork:\n  - id: a\n    task: !md [x]\n");
	assert.ok(flow.findings.some((finding) => finding.code === "yaml-tag-style" && finding.path.join(".") === "work.0.task"));
});

test("every invalid fixture has a manifest entry and expected typed finding", () => {
	const expectations = JSON.parse(readFileSync(path.join(invalidDir, "expectations.json"), "utf8")) as Record<string, { code: string; path: (string | number)[] }>;
	const files = readdirSync(invalidDir).filter((filename) => filename.endsWith(".yaml")).sort();
	assert.deepEqual(Object.keys(expectations).sort(), files);
	for (const filename of files) {
		const result = validateWorkspec(readFileSync(path.join(invalidDir, filename), "utf8"));
		const expectation = expectations[filename];
		assert.ok(result.findings.some((finding) => finding.code === expectation.code && JSON.stringify(finding.path) === JSON.stringify(expectation.path)), `${filename}: ${JSON.stringify(result.findings)}`);
	}
});
