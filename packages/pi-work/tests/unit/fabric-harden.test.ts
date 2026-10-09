import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WorkDispatchDetails } from "../../src/tools/work-dispatch.ts";
import piWork from "../../src/index.ts";
import { dispatchFabricRun } from "../../src/dispatch/fabric/run.ts";
import type { FabricProgramRunRequest } from "../../src/dispatch/fabric/transport.ts";
import { withDraftLineage } from "../helpers/workspec-source.ts";

async function fixture(touches = "src/owned.ts") {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-work-harden-")));
	await mkdir(path.join(root, "src"));
	await writeFile(path.join(root, "src/owned.ts"), "original\n");
	await writeFile(path.join(root, "src/sibling.ts"), "original\n");
	await writeFile(path.join(root, "spec.yaml"), withDraftLineage(`title: harden\ndescription: d\nintent: i\nwork:\n  - id: node\n    task: compose\n    touches: [${touches}]\n    acceptance:\n      - id: A\n        statement: confirm\n        evidence:\n          kind: user\n          prompt: confirm\n`, { cwd: root }));
	await writeFile(path.join(root, ".gitignore"), ".work/\n.pi/\n");
	const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 10000 });
	git(["init", "-q", "-b", "fixture"]);
	git(["add", "."]);
	git(["-c", "user.name=pi-work", "-c", "user.email=pi-work@example.invalid", "commit", "-qm", "fixture"]);
	return { root, git, commit: git(["rev-parse", "HEAD"]).trim() };
}

function registered(repo: Awaited<ReturnType<typeof fixture>>, available: () => boolean, run: (request: FabricProgramRunRequest) => void) {
	const tools: ToolDefinition[] = [];
	piWork({
		getAllTools: () => available() ? [{ name: "fabric_exec" }] : [],
		events: { emit(channel: string, data: unknown) { if (channel === "pi-fabric:program:run:v1") run(data as FabricProgramRunRequest); }, on() { return () => {}; } },
		registerTool(tool: ToolDefinition) { tools.push(tool); }, registerCommand() {}, on() {},
	} as unknown as ExtensionAPI);
	return async (signal?: AbortSignal) => {
		const result = await tools.find(tool => tool.name === "work_dispatch")!.execute("harden", {
		path: "spec.yaml", nodeAddress: ["node"], worktreePath: repo.root, expectedCommit: repo.commit,
	}, signal, undefined, { cwd: repo.root, modelRegistry: { getAvailable: () => [] } } as never);
		return { details: result.details as WorkDispatchDetails };
	};
}

function reply(request: FabricProgramRunRequest, commit: string, changedPaths: string[] = []) {
	request.reply({ ok: true, program: request.ref, logs: [], value: {
		id: "harden-run", status: "completed", model: "test/model",
		value: { changedPaths, commit, evidence: "probe exit 0", checklist: [], gaps: "" },
	} });
}

async function isolated<T>(body: (repo: Awaited<ReturnType<typeof fixture>>) => Promise<T>, touches?: string) {
	const repo = await fixture(touches);
	const home = process.env.HOME;
	const project = process.env.PI_FABRIC_PROJECT_ROOT;
	process.env.HOME = repo.root;
	process.env.PI_FABRIC_PROJECT_ROOT = repo.root;
	try { return await body(repo); }
	finally {
		if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
		if (project === undefined) delete process.env.PI_FABRIC_PROJECT_ROOT; else process.env.PI_FABRIC_PROJECT_ROOT = project;
		await rm(repo.root, { recursive: true, force: true });
	}
}

test("fabric-availability: registered dispatch with a bare event bus falls back to delegate then plan-only", async () => isolated(async repo => {
	const key = Symbol.for("pi-delegate.runtime-api.v1");
	const globals = globalThis as Record<symbol, unknown>;
	const previous = globals[key];
	let delegateCalls = 0;
	let fabricCalls = 0;
	globals[key] = { createDelegateRuntimeClient() { return { dispatch() { delegateCalls++; throw Object.assign(new Error("absent"), { code: "core-unavailable" }); } }; } };
	try {
		const controller = new AbortController();
		const result = await registered(repo, () => false, () => { fabricCalls++; controller.abort(); })(controller.signal);
		assert.equal(result.details.outcome, "degraded");
		assert.equal(result.details.backend, "plan-only");
		assert.equal(delegateCalls, 1);
		assert.equal(fabricCalls, 0);
	} finally { if (previous === undefined) delete globals[key]; else globals[key] = previous; }
}));

test("fabric-availability: late registered capability selects Fabric and uncertain submission never retries", async () => isolated(async repo => {
	let available = false;
	let calls = 0;
	const controller = new AbortController();
	const dispatch = registered(repo, () => available, () => { calls++; controller.abort(); });
	available = true;
	const result = await dispatch(controller.signal);
	assert.equal(result.details.backend, "fabric");
	assert.equal(result.details.outcome, "indeterminate");
	assert.equal(calls, 1);
}));

for (const mode of ["committed", "dirty", "untracked", "rename", "file-to-directory"] as const) {
	test(`confinement-file-level: registered dispatch rejects an unreported ${mode} sibling write`, async () => isolated(async repo => {
		const result = await registered(repo, () => true, request => {
			assert.deepEqual(request.input.writableRoots, [path.join(repo.root, "src")]);
			if (mode === "file-to-directory") {
				execFileSync("node", ["-e", "const fs=require('fs');const p=process.argv[1];fs.unlinkSync(p);fs.mkdirSync(p);fs.writeFileSync(p+'/escape.ts', 'unauthorized')", path.join(repo.root, "src/owned.ts")], { timeout: 10000 });
			}
			else if (mode === "rename") repo.git(["mv", "src/sibling.ts", "src/owned.ts-renamed"]);
			else execFileSync("node", ["-e", "require('fs').writeFileSync(process.argv[1], 'unauthorized\\n')", path.join(repo.root, mode === "untracked" ? "src/new.ts" : "src/sibling.ts")], { timeout: 10000 });
			if (mode === "committed") {
				repo.git(["add", "."]);
				repo.git(["-c", "user.name=pi-work", "-c", "user.email=pi-work@example.invalid", "commit", "-qm", "sibling"]);
			}
			reply(request, repo.git(["rev-parse", "HEAD"]).trim(), ["src/owned.ts"]);
		})( );
		assert.equal(result.details.outcome, "indeterminate");
		assert.match(JSON.stringify(result.details.findings), /outside.*touches/i);
		assert.equal("receipt" in result.details, false);
	}));
}

for (const touches of ["src/owned.ts", "src/*.ts", "src/"]) {
	test(`confinement-file-level: registered dispatch accepts a write within ${touches}`, async () => isolated(async repo => {
		const result = await registered(repo, () => true, request => {
			execFileSync("node", ["-e", "require('fs').writeFileSync(process.argv[1], 'authorized\\n')", path.join(repo.root, "src/owned.ts")], { timeout: 10000 });
			reply(request, repo.commit, ["src/owned.ts"]);
		})( );
		assert.equal(result.details.outcome, "dispatched", JSON.stringify(result.details));
	}, touches));
}

for (const source of ["project", "global", "global-with-project-cancel"] as const) {
	test(`escalation-trusted-config: registered dispatch blocks ${source} route before submission`, async () => isolated(async repo => {
		await mkdir(path.join(repo.root, ".pi/agent"), { recursive: true });
		const global = source !== "project";
		await writeFile(path.join(repo.root, global ? ".pi/agent/fabric.json" : ".pi/fabric.json"), JSON.stringify({ agents: { childQuestions: "route" } }));
		if (source === "global-with-project-cancel") await writeFile(path.join(repo.root, ".pi/fabric.json"), JSON.stringify({ agents: { childQuestions: "cancel" } }));
		let calls = 0;
		const result = await registered(repo, () => true, request => { calls++; reply(request, repo.commit); })( );
		assert.equal(result.details.outcome, "rejected");
		assert.match(JSON.stringify(result.details.findings), /fabric-escalation-enabled/);
		assert.equal(calls, 0);
	}));
}
for (const trustedProject of [true, false]) {
	test(`escalation-trusted-config: project route is blocked with trustedProject=${trustedProject}`, async () => {
		let calls = 0;
		const result = await dispatchFabricRun({ ref: "digest", projectRoot: "/project", trustedProject,
			invocation: { name: "node", task: "compose", confineWrites: true, worktree: false },
		}, {
			async readConfig(file) { return file === "/project/.pi/fabric.json" ? { agents: { childQuestions: "route" } } : undefined; },
			events: { emit() { calls++; } },
		});
		assert.ok("status" in result && result.status === "rejected");
		assert.equal(result.finding.code, "fabric-escalation-enabled");
		assert.equal(calls, 0);
	});
}
