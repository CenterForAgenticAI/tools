#!/usr/bin/env node
/** Run after npm run test:compile. Never mutate checkout sources or installed
 * dependencies: each control is removed in a disposable compiled replay tree,
 * restored in finally, and its named test must then pass again. Offline only.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "safety-mutations-"));
const sdk = "node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";
const mutations = [
	{ name: "C1 task prompt regeneration", file: "src/index.js", from: "buildTasksContextEnvelope(tasksSnapshot, {", to: "buildTasksContextEnvelope(null, {", test: "safety-task-focus-authority" },
	{ name: "C1 focus prompt regeneration", file: "src/index.js", from: "[PROMPT_SECTION.sessionFocus]: workstreamEnvelope,", to: "[PROMPT_SECTION.sessionFocus]: null,", test: "safety-task-focus-authority" },
	{ name: "C1 task transcript authority", file: "src/session-tasks/session-tasks.js", from: "const replay = replayTasksEntries(entries);", to: "const replay = replayTasksEntries([]);", test: "safety-task-focus-authority" },
	{ name: "C1 focus transcript authority", file: "src/workstream/workstream-context.js", from: "const replay = replayWorkstreamEntries(entries);", to: "const replay = replayWorkstreamEntries([]);", test: "safety-task-focus-authority" },
	{ name: "C2 branch-scoped context edits", file: sdk, from: "for (const entry of contextEntries) {\n        if (entry.type === \"context_edit\")", to: "for (const entry of entries) {\n        if (entry.type === \"context_edit\")", test: "safety-branch-leakage" },
	{ name: "C3 whole-entry and pair widening", file: "src/folds/fold-coverage.js", from: "const selected = new Set(ids);", to: "return [...ids];\n    const selected = new Set(ids);", test: "safety-tool-history" },
	{ name: "C3 call/result identity mapping", file: "src/folds/fold-adapter.js", from: "toolCallId: part.id,", to: "", test: "safety-tool-history", pattern: "one result endpoint" },
	{ name: "C3 protected partial-entry refusal", file: "src/folds/fold-adapter.js", from: "widenFoldCoverage(state.messages, block.effectiveMessageIds).some((id) => !selected.has(id))", to: "false", test: "safety-tool-history", pattern: "protected sibling" },
	{ name: "C4 context edit disk replay", file: sdk, from: "this.fileEntries = entries;", to: "this.fileEntries = entries.map(e => e.type === 'context_edit' ? { ...e, type: 'custom', customType: 'mutation-ignored-edit' } : e);", test: "safety-restart" },
	{ name: "C5 side-file error reporting", file: "src/parity/side-file.js", from: "export function snapshotSideFile(sessionFile) {", to: "export function snapshotSideFile(sessionFile) {\n    return { ok: true, text: '{\"schemaVersion\":1,\"blocks\":[]}', byRef: {}, blocks: [] };", test: "safety-corruption" },
	{ name: "C5 recorder diagnostic propagation", file: "src/parity/recorder.js", from: "const diffs = [call.diff, ...(after.ok ? [] : [after.diff])];", to: "const diffs = [];", test: "safety-corruption" },
	{ name: "C5 newer import schema refusal", file: "src/folds/acp-import.js", from: "!SUPPORTED_ACP_SCHEMA_VERSIONS.includes(schemaVersion)", to: "![1, 2].includes(schemaVersion)", test: "safety-corruption", pattern: "newer-schema" },
	{ name: "C5 malformed import refusal", file: "src/folds/acp-import.js", from: 'return { status: "unsupported", reason: "not JSON" };', to: 'return { status: "skipped", reason: "no-blocks" };', test: "safety-corruption", pattern: "malformed" },
	{ name: "C6 summary carrier persistence", file: "src/folds/fold-entries.js", from: "return [carrier, ...hidden, metadata];", to: "return [...hidden, metadata];", test: "safety-summary-visibility" },
	{ name: "C6 full summary rather than 200-char preview", file: "src/folds/fold-entries.js", from: "replacement: { content: summaryText },", to: "replacement: { content: summaryText.slice(0, 200) },", test: "safety-summary-visibility" },
];

function run(mutation) {
	const args = ["--test", ...(mutation.pattern ? [`--test-name-pattern=${mutation.pattern}`] : []), `tests/${mutation.test}.test.js`];
	const result = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", timeout: 60_000,
		env: { ...process.env, HOME: path.join(root, "home"), PI_CODING_AGENT_DIR: path.join(root, "agent"), TMPDIR: root } });
	assert.equal(result.error, undefined, `${mutation.name}: replay did not terminate normally`);
	assert.equal(result.signal, null, `${mutation.name}: replay was killed`);
	return result;
}

try {
	fs.cpSync(path.join(project, ".test-dist"), root, { recursive: true });
	fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
	fs.mkdirSync(path.join(root, "home"));
	const deps = path.join(project, "node_modules");
	fs.mkdirSync(path.join(root, "node_modules"));
	// Copy only the SDK whose replay controls are mutated; all other dependencies
	// are read-only links. No kernel file is ever a mutation target.
	for (const name of fs.readdirSync(deps)) {
		if (name === "@earendil-works") {
			fs.mkdirSync(path.join(root, "node_modules", name));
			for (const pkg of fs.readdirSync(path.join(deps, name))) {
				const source = path.join(deps, name, pkg);
				const dest = path.join(root, "node_modules", name, pkg);
				if (pkg === "pi-coding-agent") fs.cpSync(source, dest, { recursive: true });
				else fs.symlinkSync(source, dest);
			}
		} else fs.symlinkSync(path.join(deps, name), path.join(root, "node_modules", name));
	}
	for (const mutation of mutations) {
		const target = path.join(root, mutation.file);
		const original = fs.readFileSync(target, "utf8");
		assert.equal(original.split(mutation.from).length, 2, `${mutation.name}: control must match exactly once`);
		let red;
		try {
			fs.writeFileSync(target, original.replace(mutation.from, mutation.to));
			red = run(mutation);
			assert.equal(red.status, 1, `${mutation.name}: mutant survived\n${red.stdout}\n${red.stderr}`);
			assert.match(red.stdout + red.stderr, /AssertionError/, `${mutation.name}: must fail an assertion, not setup`);
		} finally { fs.writeFileSync(target, original); }
		const green = run(mutation);
		assert.equal(green.status, 0, `${mutation.name}: restoration did not pass\n${green.stdout}\n${green.stderr}`);
		console.log(`CONTROL REMOVED: ${mutation.name}\n${red.stdout}${red.stderr}\nRESTORED: exit 0\n`);
	}
	console.log(`Mutation checks passed: ${mutations.length} controls; every restored replay passed.`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
