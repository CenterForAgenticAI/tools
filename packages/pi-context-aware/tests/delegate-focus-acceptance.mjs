#!/usr/bin/env node
/**
 * Cross-package acceptance probe for delegated focus seeding (issue #62).
 * Run with: ../pi-delegate/node_modules/.bin/tsx tests/delegate-focus-acceptance.mjs
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const defaultDelegateRoots = [
	path.resolve(import.meta.dirname, "..", "..", "pi-delegate"),
	path.resolve(import.meta.dirname, "..", "..", "..", "..", "pi-delegate"),
];
const delegateRoot = path.resolve(
	process.env.PI_DELEGATE_ROOT ?? defaultDelegateRoots.find((candidate) => existsSync(candidate)) ?? defaultDelegateRoots[0],
);
const contextAware = path.resolve(import.meta.dirname, "..", "index.ts");
const requiredDelegateFiles = [
	"src/agents.ts",
	"src/delegate-runs.ts",
	"src/direct-runner.ts",
	"src/fork-runner.ts",
	"src/pending-wakes.ts",
	"tests/integration/mock-provider.ts",
	"tests/integration/adaptive-thinking-fixture.ts",
];
for (const relative of requiredDelegateFiles) {
	const candidate = path.join(delegateRoot, relative);
	if (!existsSync(candidate)) {
		throw new Error(`pi-delegate acceptance input is missing: ${candidate}. Set PI_DELEGATE_ROOT to its checkout.`);
	}
}

function delegateImport(relative) {
	return import(pathToFileURL(path.join(delegateRoot, relative)).href);
}

const [
	{ compileDelegateRuns },
	{ runDirectWorker },
	{ runFork },
	{ clearLiveWakeSink, getLiveWakeSink },
	{ mkMockEnv },
	{ readSessionEntries },
] = await Promise.all([
	delegateImport("src/delegate-runs.ts"),
	delegateImport("src/direct-runner.ts"),
	delegateImport("src/fork-runner.ts"),
	delegateImport("src/pending-wakes.ts"),
	delegateImport("tests/integration/mock-provider.ts"),
	delegateImport("tests/integration/adaptive-thinking-fixture.ts"),
]);

const objective = "Verify delegated focus reaches the real worker lifecycle";
const callerBoundary = "Read-only acceptance probe";
const taskTitle = "Inspect the seeded focus before replying";

function writableRoot(cwd) {
	return path.join(cwd, "allowed-writes");
}

function expectedBoundaries(cwd) {
	return [
		callerBoundary,
		`Worker cwd: ${cwd}`,
		`Writable root: ${writableRoot(cwd)}`,
		"Write confinement: enabled",
	];
}

function renderedBoundaryChecks() {
	return [callerBoundary, "Worker cwd:", "Writable root:", "Write confinement: enabled"];
}

function textOfToolResult(context, toolName) {
	const result = context.messages.find((message) => message.role === "toolResult" && message.toolName === toolName);
	assert.ok(result, `expected ${toolName} result before the final worker response`);
	if (typeof result.content === "string") return result.content;
	assert.ok(Array.isArray(result.content), `${toolName} must return text content`);
	return result.content.map((block) => block?.type === "text" ? block.text : "").join("\n");
}

function assertInitialContext(context) {
	const systemPrompt = context.systemPrompt ?? "";
	assert.match(systemPrompt, /<session-workstream/u);
	assert.match(systemPrompt, new RegExp(objective));
	for (const boundary of renderedBoundaryChecks()) {
		assert.ok(systemPrompt.includes(boundary), `initial model context must include boundary: ${boundary}`);
	}
	assert.match(systemPrompt, /<session-tasks/u);
	assert.match(systemPrompt, new RegExp(taskTitle));
}

function agent() {
	return {
		name: "focus-worker",
		description: "Cross-package focus acceptance worker",
		systemPrompt: "Inspect the durable session state, then reply concisely.",
		model: "mock-worker/mock-worker-model",
		source: "user",
		filePath: "/tmp/fake/focus-worker.md",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		extensions: [contextAware],
		tools: [
			`ext:${contextAware}/session_focus`,
			`ext:${contextAware}/session_tasks`,
		],
	};
}

function directContext(env, cwd) {
	return {
		cwd,
		mainModel: { provider: env.cloneModel.provider, id: env.cloneModel.id },
		...(env.authStorage ? { authStorage: env.authStorage } : {}),
		modelRuntime: env.modelRuntime,
		modelRegistry: env.registry,
		agentDir: cwd,
		ownerSessionId: "acceptance-parent-session",
	};
}

function forkContext(env, cwd) {
	return {
		cwd,
		mainBranchEntries: [],
		fromToolCallId: "cross-package-delegate-call",
		mainModel: { provider: env.cloneModel.provider, id: env.cloneModel.id },
		mainSystemPrompt: "Supervise the acceptance worker.",
		...(env.authStorage ? { authStorage: env.authStorage } : {}),
		modelRuntime: env.modelRuntime,
		modelRegistry: env.registry,
		agentDir: cwd,
		ownerSessionId: "acceptance-parent-session",
		runId: "supervised-acceptance-run",
		forkName: "focus-worker1",
		childIndex: 0,
	};
}

function compiledSlot(mode) {
	const output = compileDelegateRuns({
		runs: [{
			agent: "focus-worker",
			mode,
			task: "Inspect session_tasks and session_focus, then report success.",
			handoff: {
				tasks: [taskTitle],
				focus: { objective, boundaries: [callerBoundary] },
			},
		}],
	});
	const slot = mode === "solo" ? output : output.agents[0];
	assert.equal(slot.focus.objective, objective, "compileDelegateRuns must carry focus");
	assert.deepEqual(slot.checklist, [taskTitle], "compileDelegateRuns must carry tasks");
	return slot;
}

function setWorkerScript(env) {
	env.setScript("worker", [
		{
			toolCall: { name: "session_focus", arguments: { action: "get" } },
			assertContext: assertInitialContext,
		},
		{
			toolCall: { name: "session_tasks", arguments: { action: "list" } },
			assertContext: (context) => {
				const focusText = textOfToolResult(context, "session_focus");
				assert.match(focusText, new RegExp(objective));
				for (const boundary of renderedBoundaryChecks()) {
					assert.ok(focusText.includes(boundary), `session_focus get must include boundary: ${boundary}`);
				}
			},
		},
		{
			text: "WORKER_FOCUS_AND_TASKS_OK",
			assertContext: (context) => {
				assert.match(textOfToolResult(context, "session_focus"), new RegExp(objective));
				assert.match(textOfToolResult(context, "session_tasks"), new RegExp(taskTitle));
			},
		},
	]);
}

function acceptanceEvidence(sessionFile, cwd) {
	const entries = readSessionEntries(sessionFile);
	const seedIndex = entries.findIndex((entry) => entry.customType === "context-aware.focus-seed.v1");
	const workstreamIndex = entries.findIndex((entry) => entry.customType === "context-aware.workstream.v1");
	const assistantIndex = entries.findIndex((entry) => entry.message?.role === "assistant");
	assert.ok(seedIndex >= 0, "worker transcript must retain the producer seed");
	assert.ok(workstreamIndex > seedIndex, "the consumer snapshot must follow its seed");
	assert.ok(assistantIndex < 0 || workstreamIndex < assistantIndex, "the consumer snapshot must precede the first assistant message");
	assert.equal(entries.filter((entry) => entry.customType === "context-aware.workstream.v1").length, 1);
	const focusResult = entries.find((entry) => entry.message?.role === "toolResult" && entry.message.toolName === "session_focus");
	const tasksResult = entries.find((entry) => entry.message?.role === "toolResult" && entry.message.toolName === "session_tasks");
	assert.ok(focusResult);
	assert.ok(tasksResult);
	const snapshot = focusResult.message.details?.snapshot;
	assert.ok(snapshot, "session_focus get must return its authoritative snapshot details");
	assert.equal(snapshot.objective, objective);
	assert.equal(snapshot.objectivePinned, false);
	assert.deepEqual(snapshot.boundaries, expectedBoundaries(cwd));
	assert.deepEqual(snapshot.provenance, {
		source: "host",
		parentPiSessionId: "acceptance-parent-session",
		host: "pi-delegate",
	});
	return {
		ordering: `seed=${seedIndex} workstream=${workstreamIndex} first-assistant=${assistantIndex}`,
		focus: focusResult.message.content.map((block) => block.type === "text" ? block.text : "").join("\n"),
		tasks: tasksResult.message.content.map((block) => block.type === "text" ? block.text : "").join("\n"),
	};
}

function printEvidence(mode, evidence) {
	console.log(`${mode}: pass`);
	console.log(`${mode} ordering: ${evidence.ordering}`);
	console.log(`${mode} session_focus output:\n${evidence.focus}`);
	console.log(`${mode} session_tasks output:\n${evidence.tasks}`);
}

const root = mkdtempSync(path.join(tmpdir(), "context-aware-cross-package-"));
try {
	const directCwd = path.join(root, "direct");
	const supervisedCwd = path.join(root, "supervised");
	mkdirSync(writableRoot(directCwd), { recursive: true });
	mkdirSync(writableRoot(supervisedCwd), { recursive: true });

	const directSlot = compiledSlot("solo");
	const directEnv = mkMockEnv();
	setWorkerScript(directEnv);
	const direct = await runDirectWorker({
		name: directSlot.name,
		agent: agent(),
		task: directSlot.task,
		tasks: { tasks: [{ title: taskTitle }] },
		focus: directSlot.focus,
		writableRoots: [writableRoot(directCwd)],
	}, directContext(directEnv, directCwd));
	assert.equal(direct.status, "completed", direct.error);
	assert.equal(direct.collapsedContent, "WORKER_FOCUS_AND_TASKS_OK");
	printEvidence("direct", acceptanceEvidence(direct.workerSessionFile, directCwd));

	const supervisedSlot = compiledSlot("supervised");
	const supervisedEnv = mkMockEnv();
	setWorkerScript(supervisedEnv);
	supervisedEnv.setScript("clone", [
		{ toolCall: { name: "message_subagent", arguments: { text: "Inspect the seeded session state now." } } },
		{ toolCall: { name: "finish_delegation", arguments: { final_output: "SUPERVISED_FOCUS_OK" } } },
	]);
	const supervised = await runFork({
		name: supervisedSlot.name,
		agent: agent(),
		task: supervisedSlot.task,
		tasks: { tasks: [{ title: taskTitle }] },
		focus: supervisedSlot.focus,
		writableRoots: [writableRoot(supervisedCwd)],
		cloneMode: "task_only",
		maxRounds: 2,
		collapseMode: "final_output",
	}, forkContext(supervisedEnv, supervisedCwd));
	assert.equal(supervised.status, "completed", supervised.error);
	assert.equal(supervised.collapsedContent, "SUPERVISED_FOCUS_OK");
	printEvidence("supervised", acceptanceEvidence(supervised.workerSessionFile, supervisedCwd));
	console.log("cross-package acceptance: pass");
} finally {
	const sink = getLiveWakeSink();
	if (sink) clearLiveWakeSink(sink);
	rmSync(root, { recursive: true, force: true });
}
