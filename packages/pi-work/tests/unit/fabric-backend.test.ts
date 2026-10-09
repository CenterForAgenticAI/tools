import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { createWorkDispatchTool, type WorkDispatchDetails } from "../../src/tools/work-dispatch.ts";
import { childLoaderArgs, REPO_ROOT, sourceModuleUrl } from "../helpers/source-under-test.ts";
import { withDraftLineage } from "../helpers/workspec-source.ts";
import { dispatchPlan } from "../../src/dispatch/index.ts";
import type { PlanReceipt } from "../../src/plan/index.ts";

function receipt() {
	return { schema: "pi-delegate.runtime-receipt", version: 1, runId: "delegate-run", createdAt: "2026-10-06T12:00:00.000Z", shape: "direct", forks: [{ name: "node", agent: "worker", maxRounds: 1, inputDigests: [{ kind: "read", name: briefPath, algorithm: "sha256", digest: "b".repeat(64) }] }], receiptPath: `${root}/receipt.json`, resultPath: `${root}/result.json` };
}

const root = "/tmp/pi-work-backend";
const briefPath = `${root}/brief.md`;
const slot = { agent: "worker", task: "read brief", cwd: root, reads: [briefPath] as const, confineWrites: true as const, escalation: "off" as const, worktree: false as const };
const plan: PlanReceipt = { nodeId: "node", nodeAddress: ["node"], schemaPath: ["work", 0], briefPath, briefSha256: "b".repeat(64), delegate: slot, canonicalDelegate: { runs: [{ ...slot, name: "node", mode: "solo" }] } };
const input = { plan, target: { worktreePath: root, headCommit: "a".repeat(40), branch: "fixture", specPath: `${root}/spec.yaml`, cachePath: `${root}/cache.json` }, context: { cwd: root } as never };

test("backend-selection: defaults to the injected Fabric host without probing delegate", async () => {
	let calls = 0;
	const result = await dispatchPlan(input, {
		fabricHost: { async dispatch(received) {
			calls += 1;
			assert.equal(received.plan.briefPath, briefPath);
			return { outcome: "dispatched", dispatchState: "dispatched", plan: received.plan, receipt: { ...receipt(), schema: "pi-delegate.runtime-receipt", version: 1, forks: [{ name: "node", agent: "worker", maxRounds: 1, inputDigests: [] }] }, cacheWrite: { status: "skipped", reason: "receipt-not-recordable", message: "host owns recording" }, findings: [] };
		} },
		clientProvider: async () => { throw new Error("delegate must not be probed"); },
	});
	assert.equal(calls, 1);
	assert.equal(result.backend, "fabric");
	assert.equal(result.outcome, "dispatched");
});

test("backend-selection: explicit delegate overrides Fabric and preserves receipt handling", async () => {
	let calls = 0;
	const result = await dispatchPlan(input, {
		backend: "pi-delegate",
		fabricHost: { dispatch: async () => { throw new Error("Fabric must not run"); } },
		clientProvider: async () => ({ status: "available", grammar: "legacy", client: { async dispatch(request) { calls += 1; assert.deepEqual(request, { agent: "worker", task: "read brief", cwd: root, reads: [briefPath], confineWrites: true, escalation: "off" }); return receipt(); } } }),
		cacheWriter: async () => ({ status: "written", path: input.target.cachePath, attempts: 1, residualRace: "readback-may-precede-later-overwrite" }),
	});
	assert.equal(calls, 1);
	assert.equal(result.backend, "pi-delegate");
	assert.equal(result.outcome, "dispatched");
	assert.ok(result.outcome === "dispatched");
	assert.equal(result.receipt.runId, "delegate-run");
	assert.equal(result.cacheWrite.status, "written");
});

test("backend-selection: absent executors return the unchanged paste-ready plan", async () => {
	const result = await dispatchPlan(input, { clientProvider: async () => ({ status: "unavailable", message: "absent" }) });
	assert.equal(result.backend, "plan-only");
	assert.equal(result.outcome, "degraded");
	assert.equal(result.plan, plan);
	assert.equal("receipt" in result, false);
});

test("backend-selection: configured unavailable Fabric never silently uses delegate", async () => {
	const result = await dispatchPlan(input, { backend: "fabric", clientProvider: async () => { throw new Error("no fallback"); } });
	assert.equal(result.backend, "plan-only");
	assert.equal(result.outcome, "degraded");
});

test("backend-selection: a failing Fabric dispatch is indeterminate and never retried", async () => {
	let calls = 0;
	const result = await dispatchPlan(input, { fabricHost: { async dispatch() { calls += 1; throw new Error("unknown submission state"); } }, clientProvider: async () => { throw new Error("no fallback"); } });
	assert.equal(calls, 1);
	assert.equal(result.backend, "fabric");
	assert.equal(result.outcome, "indeterminate");
	assert.equal(result.dispatchState, "unknown");
});

test("backend-selection: work_dispatch forwards backend configuration and renders the selected executor", async () => {
	const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-work-backend-")));
	try {
		await writeFile(path.join(cwd, "spec.yaml"), withDraftLineage("title: t\ndescription: d\nintent: i\nwork:\n  - id: node\n    task: run\n    touches: [src/**]\n    acceptance:\n      - id: A\n        statement: signal\n        evidence:\n          kind: command\n          run: printf signal\n          expect:\n            exit: 0\n            output_includes: signal\n", { cwd }));
		await writeFile(path.join(cwd, ".gitignore"), ".work/.cache/\n");
		const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
		git("init", "-q", "-b", "fixture");
		git("add", "-f", "spec.yaml", ".gitignore", ".test-dist");
		git("-c", "user.name=pi-work", "-c", "user.email=pi-work@example.invalid", "commit", "-qm", "fixture");
		let calls = 0;
		const tool = createWorkDispatchTool({ fabricHost: { async dispatch(received) { calls += 1; assert.equal(received.plan.nodeId, "node"); return { outcome: "indeterminate", dispatchState: "unknown", plan: received.plan, findings: [{ code: "delegate-runtime-error", message: "host submission" }] }; } }, clientProvider: async () => ({ status: "unavailable", message: "absent" }) });
		const params = { path: "spec.yaml", nodeAddress: ["node"], worktreePath: cwd, expectedCommit: git("rev-parse", "HEAD") };
		const fabric = await tool.execute("test", params, undefined, undefined, { cwd } as never);
		assert.equal(fabric.details.backend, "fabric", JSON.stringify(fabric.details));
		assert.equal(fabric.content[0].type, "text");
		assert.ok(fabric.content[0].type === "text");
		assert.match(fabric.content[0].text, /backend: fabric/);
		const delegate = await tool.execute("test", { ...params, backend: "pi-delegate" }, undefined, undefined, { cwd } as never);
		const details = delegate.details as WorkDispatchDetails;
		assert.equal(details.outcome, "degraded");
		assert.equal(details.backend, "plan-only");
		assert.ok(delegate.content[0].type === "text");
		assert.match(delegate.content[0].text, /paste-ready plan receipt/);
		assert.equal(calls, 1);
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("no-load-time-coupling: extension loads when resolution of both optional packages is forbidden", () => {
	const code = `import { registerHooks } from 'node:module'; registerHooks({ resolve(specifier, context, next) { if (/^(?:@[^/]+\\/)?pi-(?:fabric|delegate)(?:\\/|$)/.test(specifier)) throw new Error('optional package imported: ' + specifier); return next(specifier, context); } }); await import(${JSON.stringify(sourceModuleUrl("index"))}); console.log('loaded without optional packages');`;
	const output = execFileSync(process.execPath, [...childLoaderArgs(), "--input-type=module", "--eval", code], { cwd: REPO_ROOT, encoding: "utf8", timeout: 30000 });
	assert.match(output, /loaded without optional packages/);
});

test("no-load-time-coupling: every src module excludes static optional-package imports and re-exports", async () => {
	const inspected: string[] = [];
	async function inspect(dir: string): Promise<void> {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const file = path.join(dir, entry.name);
			if (entry.isDirectory()) { await inspect(file); continue; }
			if (!file.endsWith(".ts")) continue;
			inspected.push(path.relative(REPO_ROOT, file));
			const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
			for (const statement of source.statements) {
				if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
					assert.doesNotMatch(statement.moduleSpecifier.text, /^(?:@[^/]+\/)?pi-(?:fabric|delegate)(?:\/|$)/, file);
				}
			}
		}
	}
	await inspect(path.join(REPO_ROOT, "src"));
	assert.ok(inspected.length > 0);
	assert.ok(inspected.includes("src/index.ts"));
	assert.ok(inspected.includes("src/dispatch/backend.ts"));
});

