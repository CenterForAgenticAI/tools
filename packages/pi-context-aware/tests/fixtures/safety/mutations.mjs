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
	// Native planning keeps whole entries through the engine's turn groups and the withdrawal of split
	// entries (pi-context-aware#186); coverage widening still decides what a sparse legacy import folds.
	{ name: "C3 whole-entry and pair widening", file: "src/folds/fold-coverage.js", from: "const selected = new Set(ids);", to: "return [...ids];\n    const selected = new Set(ids);", test: "folds", pattern: "ACP import widens a partial entry" },
	{ name: "C3 call/result identity mapping", file: "src/folds/fold-adapter.js", from: "toolCallId: callId,", to: "", test: "safety-tool-history", pattern: "one result endpoint" },
	{ name: "C3 protected partial-entry withdrawal", file: "src/folds/fold-adapter.js", from: "const selected = withdrawSplitEntries(state.messages, block.effectiveMessageIds);", to: "const selected = new Set(block.effectiveMessageIds);", test: "safety-tool-history", pattern: "protected sibling" },
	// A summary limit that is not a finite number must not reach the engine: NaN or Infinity would switch its length check off (pi-context-aware#183).
	{ name: "C3 finite summary limit", file: "src/folds/fold-adapter.js", from: 'return typeof value === "number" && Number.isFinite(value) ? value : undefined;', to: "return value;", test: "fold-summary-max-chars", pattern: "not a finite number is ignored" },
	// A queued fold is written only while the selected branch holds the leaf it was requested on, live and after a restart (pi-context-aware#176).
	{ name: "C2 queued fold branch leaf", file: "src/folds/fold-recovery.js", from: "const offBranch = accepted.anchors.find((anchor) => !onBranch.has(anchor.entryId));", to: "const offBranch = undefined;", test: "safety-queued-branch", pattern: "REQ-176-1" },
	{ name: "C2 saved fold request branch leaf", file: "src/folds/fold-recovery.js", from: '...(recovery.leafEntryId !== undefined ? [{ entryId: recovery.leafEntryId, label: "branch leaf" }] : []),', to: "", test: "safety-queued-branch", pattern: "tool result landed" },
	{ name: "C4 context edit disk replay", file: sdk, from: "this.fileEntries = entries;", to: "this.fileEntries = entries.map(e => e.type === 'context_edit' ? { ...e, type: 'custom', customType: 'mutation-ignored-edit' } : e);", test: "safety-restart" },
	{ name: "C5 side-file error reporting", file: "src/parity/side-file.js", from: "export function snapshotSideFile(sessionFile) {", to: "export function snapshotSideFile(sessionFile) {\n    return { ok: true, text: '{\"schemaVersion\":1,\"blocks\":[]}', byRef: {}, blocks: [] };", test: "safety-corruption" },
	{ name: "C5 recorder diagnostic propagation", file: "src/parity/recorder.js", from: "const diffs = [call.diff, ...(after.ok ? [] : [after.diff])];", to: "const diffs = [];", test: "safety-corruption" },
	{ name: "C5 newer import schema refusal", file: "src/folds/acp-import.js", from: "!SUPPORTED_ACP_SCHEMA_VERSIONS.includes(schemaVersion)", to: "![1, 2].includes(schemaVersion)", test: "safety-corruption", pattern: "newer-schema" },
	{ name: "C5 malformed import refusal", file: "src/folds/acp-import.js", from: 'return { status: "unsupported", reason: "not JSON" };', to: 'return { status: "skipped", reason: "no-blocks" };', test: "safety-corruption", pattern: "malformed" },
	{ name: "C6 summary carrier persistence", file: "src/folds/fold-entries.js", from: "return [carrier, ...hidden, metadata];", to: "return [...hidden, metadata];", test: "safety-summary-visibility" },
	{ name: "C6 full summary rather than 200-char preview", file: "src/folds/fold-entries.js", from: "replacement: { content: summaryText },", to: "replacement: { content: summaryText.slice(0, 200) },", test: "safety-summary-visibility" },
	// Recoverable hide (pi-context-aware#268): each guard in planHides, the whole-entry filter and the id bounds has a test that goes red without it.
	{ name: "C7 hide skips non-editable entries", file: "src/folds/hide-entries.js", from: "!isEditableEntry(entry) || ", to: "", test: "recoverable-hide", pattern: "would not let a context edit" },
	{ name: "C7 hide skips tool-call entries", file: "src/folds/hide-entries.js", from: '(core.contentType !== "text" && core.contentType !== "tool-result")', to: "false", test: "recoverable-hide", pattern: "one tool call" },
	{ name: "C7 hide skips multi-call entries", file: "src/folds/hide-entries.js", from: 'cores.length !== 1 || !core || core.id !== entry.id || (core.contentType !== "text" && core.contentType !== "tool-result")', to: "!core", test: "recoverable-hide", pattern: "several tool calls" },
	{ name: "C7 hide skips already shortened text", file: "src/folds/hide-entries.js", from: "text.length <= 2 * HIDE_KEEP_CHARS || text.includes(TRUNCATION_MARKER)", to: "text.length <= 2 * HIDE_KEEP_CHARS", test: "recoverable-hide", pattern: "already shortened" },
	{ name: "C7 hide queues whole entries only", file: "src/folds/fold-turn.js", from: "messages.filter((message) => baseIdOf(message.id) === message.id)", to: "messages.filter(() => true)", test: "recoverable-hide", pattern: "wholeEntryIds" },
	{ name: "C7 hide id bound", file: "src/folds/hide-entries.js", from: "/^h[1-9]\\d{0,8}$/u", to: "/^h[1-9]\\d*$/u", test: "recoverable-hide", pattern: "never hInfinity" },
	{ name: "C7 fold block id bound", file: "src/folds/fold-entries.js", from: "/^b[1-9]\\d{0,8}$/u", to: "/^b[1-9]\\d*$/u", test: "recoverable-hide", pattern: "never bInfinity" },
	{ name: "C7 acp import block id bound", file: "src/folds/acp-import.js", from: "/^b[1-9]\\d{0,8}$/u", to: "/^b[1-9]\\d*$/u", test: "acp-startup-import", pattern: "bounds block and run ids" },
	{ name: "C7 acp import run id bound", file: "src/folds/acp-import.js", from: "/^r[1-9]\\d{0,8}$/u", to: "/^r[1-9]\\d*$/u", test: "acp-startup-import", pattern: "bounds block and run ids" },
	// Native tool guards (pi-context-aware#255). Each control is removed in the compiled copy; the named test must go red.
	{ name: "G1 tool-output cap threshold", file: "src/guards/tool-guards.js", from: "if (total <= maxBytes)", to: "if (true)", test: "tool-guards", pattern: "cap: 49,999" },
	{ name: "G1 tool-output cap skipTools", file: "src/guards/tool-guards.js", from: "return !config.skipTools.includes(event.toolName);", to: "return true;", test: "tool-guards", pattern: "skipTools moves" },
	{ name: "G1 tool-output cap hook", file: "src/index.js", from: "if (shouldCapToolResult(cap, event)) {", to: "if (false) {", test: "index-registration", pattern: "toolOutputCap: default" },
	{ name: "G1 untrusted project cannot raise the cap", file: "src/index.js", from: '    "toolOutputCap.maxBytes",\n', to: "", test: "index-registration", pattern: "untrusted project cannot raise" },
	{ name: "G2 repetition run count", file: "src/guards/tool-guards.js", from: "run = fingerprint === last ? run + 1 : 1;", to: "run = 1;", test: "tool-guards", pattern: "repetition: counts" },
	{ name: "G2 component: ids are nested", file: "src/skills/skill-registry.js", from: ' || toolCallId.startsWith("component:")', to: "", test: "tool-guards", pattern: "component: is nested" },
	{ name: "G2 repetition key", file: "src/index.js", from: "if (typeof event.toolCallId !== \"string\" || !getRepetitionGuardConfig(readConfig(ctx)).enabled)\n            return;", to: "", test: "index-registration", pattern: "turns the guard off" },
	{ name: "G2 repetition warning delivery", file: "src/index.js", from: "if (count >= REPETITION_WARN_AT)", to: "if (false)", test: "index-registration", pattern: "repetitionGuard: warns" },
	{ name: "G3 overflow classification", file: "src/index.js", from: "if (!isContextOverflow(reply, contextWindow))", to: "if (false)", test: "index-registration", pattern: "overflowRecovery: not an overflow" },
	{ name: "G3 overflow single attempt", file: "src/index.js", from: "if (overflowRecoveryAttempted.has(sessionKey))\n        return;", to: "", test: "index-registration", pattern: "overflowRecovery: a real" },
	{ name: "G3 overflow key", file: "src/index.js", from: "if (!getOverflowRecoveryConfig(readConfig(ctx)).enabled)\n        return;\n    if (overflowRecoveryAttempted", to: "if (overflowRecoveryAttempted", test: "index-registration", pattern: "overflowRecovery: not an overflow" },
	{ name: "G3 overflow ignores another model", file: "src/index.js", from: "if (activeModel?.provider && reply.provider && activeModel.provider !== reply.provider)", to: "if (false)", test: "index-registration", pattern: "from another model" },
	{ name: "G3 overflow ignores another model id", file: "src/index.js", from: "if (activeModel?.id && reply.model && activeModel.id !== reply.model)", to: "if (false)", test: "index-registration", pattern: "from another model" },
	{ name: "G3 overflow ignores a stale request", file: "src/index.js", from: "reply.timestamp < turnStartedAt", to: "false", test: "index-registration", pattern: "from a stale request" },
	{ name: "G3 overflow never aborts a Fabric program", file: "src/index.js", from: "overflowRecoveryAttempted.add(sessionKey);\n    try {", to: "overflowRecoveryAttempted.add(sessionKey);\n    ctx.abort();\n    try {", test: "index-registration", pattern: "Fabric program runs" },
	{ name: "G3 overflow arm with the fold engine", file: "src/index.js", from: "overflowRecoveryArmed.add(sessionKey);", to: "", test: "index-registration", pattern: "fold engine registered" },
	{ name: "G1 output cap with the fold engine", file: "src/index.js", from: "if (shouldCapToolResult(cap, event)) {", to: "if (false) {", test: "index-registration", pattern: "fold engine registered" },
	{ name: "G1 hook honours Pi truncation flag", file: "src/index.js", from: "alreadyTruncated: details?.truncation?.truncated === true", to: "alreadyTruncated: false", test: "index-registration", pattern: "already truncated" },
	{ name: "G3 success ends the overflow episode", file: "src/index.js", from: "// A reply that went through ends the episode.\n        overflowRecoveryAttempted.delete(sessionKey);", to: "", test: "index-registration", pattern: "ends the episode" },
	{ name: "G4 summary unicode decode", file: "src/folds/fold-adapter.js", from: "const summary = sanitizeSummary(input.summary).text;", to: "const summary = input.summary;", test: "tool-guards", pattern: "planFold decodes" },
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
