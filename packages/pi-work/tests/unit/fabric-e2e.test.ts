import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { FabricProgramRunReply, FabricProgramRunRequest } from "../../src/dispatch/fabric/transport.ts";
import type { WorkDispatchDetails } from "../../src/tools/work-dispatch.ts";
import type { WorkPlanDetails } from "../../src/tools/work-plan.ts";
import type { WorkStatusToolDetails } from "../../src/tools/work-status.ts";
import type { WorkVerifyDetails } from "../../src/tools/work-verify.ts";
import { forgetSessionVerifications } from "../../src/status/session-verification.ts";
import { REPO_ROOT, sourceModuleUrl } from "../helpers/source-under-test.ts";
import { withDraftLineage } from "../helpers/workspec-source.ts";
import { systemdContainmentPrerequisite } from "../helpers/verifier-command.ts";

// The real command verifier needs systemd user scopes on Linux; skip like the other host-verifier tests.
const verifierPrerequisite = process.platform === "linux" ? await systemdContainmentPrerequisite() : { available: true, reason: "" };

// Deny delegate resolution rather than relying on the developer's installed packages.
// Keep the real pi-work implementation, filesystem, Git and command verifier.
async function flow(live = false) {
	const scratch = path.join(REPO_ROOT, ".scratch", "tmp");
	await mkdir(scratch, { recursive: true });
	const root = await realpath(await mkdtemp(path.join(scratch, "fabric-e2e-")));
	const previousRoot = process.env.PI_FABRIC_PROJECT_ROOT;
	process.env.PI_FABRIC_PROJECT_ROOT = root;
	let delegateResolutions = 0;
	const hooks = registerHooks({ resolve(specifier, context, next) {
		if (/^(?:@[^/]+\/)?pi-delegate(?:\/|$)/.test(specifier)) {
			delegateResolutions++;
			throw new Error("pi-delegate is uninstalled for this end-to-end scenario");
		}
		return next(specifier, context);
	} });
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 10000 }).trim();
	try {
		await mkdir(path.join(root, "src"));
		await writeFile(path.join(root, "spec.yaml"), withDraftLineage(`title: Fabric end to end
description: Prove the registered workflow without delegate
intent: Only independent command verification establishes done
work:
  - id: node
    task: Write src/signal.txt containing end-to-end and commit it
    worker:
      model: ${live ? JSON.stringify(process.env.PI_WORK_FABRIC_LIVE_MODEL) : "test/model"}
    touches: [src/signal.txt]
    acceptance:
      - id: signal
        statement: The committed signal is end-to-end
        evidence:
          kind: command
          run: cat src/signal.txt
          expect:
            exit: 0
            output_includes: end-to-end
          timeout_ms: 5000
`, { cwd: root }));
		await writeFile(path.join(root, ".gitignore"), ".work/\n.pi/\nprobe-*\n");
		git("init", "-q", "-b", "fixture");
		git("config", "user.name", "pi-work");
		git("config", "user.email", "pi-work@example.invalid");
		git("add", "-f", "spec.yaml", ".gitignore", ".test-dist");
		git("commit", "-qm", "fixture");
		const base = git("rev-parse", "HEAD");
		const tools = new Map<string, ToolDefinition>();
		const requests: FabricProgramRunRequest[] = [];
		const pending: Promise<void>[] = [];
		const events = {
			on() { return () => {}; },
			emit(channel: string, data: unknown) {
				if (channel !== "pi-fabric:program:run:v1") return;
				const request = data as FabricProgramRunRequest;
				requests.push(request);
				pending.push((async () => {
					try {
						if (live) {
							request.reply(await liveRun(root, request));
							return;
						}
						// Faithful terminal host double: consume the referenced brief, make
						// a real scoped change and commit, then return an AgentRunRecord.
						await readFile(plan.briefPath, "utf8");
						await writeFile(path.join(root, "src", "signal.txt"), "end-to-end\n");
						git("add", "src/signal.txt");
						git("commit", "-qm", "feat(fixture): add signal");
						request.reply({ ok: true, program: request.ref, logs: [], value: {
							id: "e2e-run", status: "completed", model: "test/model",
							worktreeResult: { path: root, branch: "fixture", baseRef: base },
							value: { changedPaths: ["src/signal.txt"], commit: git("rev-parse", "HEAD"), evidence: "cat src/signal.txt: exit 0", checklist: [], gaps: "" },
						} });
					} catch (error) { request.reply({ ok: false, error: String(error) }); }
				})());
			},
		};
		const { default: piWork } = await import(sourceModuleUrl("index"));
		piWork({ events, getAllTools: () => [{ name: "fabric_exec" }], registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); }, registerCommand() {}, on() {} } as unknown as ExtensionAPI);
		const ctx = { cwd: root, modelRegistry: { getAvailable: () => {
			const model = live ? process.env.PI_WORK_FABRIC_LIVE_MODEL! : "test/model";
			const slash = model.indexOf("/");
			return [{ provider: model.slice(0, slash), id: model.slice(slash + 1) }];
		} } } as never;
		const invoke = (name: string, args: Record<string, unknown>) => tools.get(name)!.execute("e2e", args, undefined, undefined, ctx);
		const planned = (await invoke("work_plan", { path: "spec.yaml", nodeAddresses: [["node"]] })).details as WorkPlanDetails;
		assert.equal(planned.valid, true, JSON.stringify(planned.findings));
		assert.equal(planned.plans.length, 1);
		const plan = planned.plans[0]!;
		const brief = await readFile(plan.briefPath, "utf8");
		assert.equal(createHash("sha256").update(brief).digest("hex"), plan.briefSha256);
		assert.match(brief, /src\/signal\.txt/);
		const dispatched = (await invoke("work_dispatch", { path: "spec.yaml", nodeAddress: ["node"], worktreePath: root, expectedCommit: base })).details as WorkDispatchDetails;
		await Promise.all(pending);
		assert.equal(dispatched.outcome, "dispatched", JSON.stringify(dispatched));
		assert.equal(dispatched.backend, "fabric");
		assert.equal(requests.length, 1);
		assert.equal(requests[0]!.input.worktree, false);
		assert.deepEqual(requests[0]!.input.writableRoots, [path.join(root, "src")]);
		assert.equal(requests[0]!.input.shell, "unconfined");
		assert.match(requests[0]!.input.task, new RegExp(plan.briefSha256));
		const commit = git("rev-parse", "HEAD");
		assert.notEqual(commit, base);
		const target = { path: "spec.yaml", worktreePath: root, expectedCommit: commit };
		const before = (await invoke("work_status", target)).details as WorkStatusToolDetails;
		assert.equal(before.specState, "not-done", "worker success must not establish verification authority");
		assert.notEqual(before.nodes[0]!.lifecycle, "done");
		assert.equal(before.nodes[0]!.dispatches.length, 1);
		assert.equal(before.nodes[0]!.dispatches[0]!.briefSha256, plan.briefSha256);
		const verified = (await invoke("work_verify", { ...target, nodeId: "node" })).details as WorkVerifyDetails;
		assert.equal(verified.outcome, "passed", JSON.stringify(verified));
		assert.equal(verified.cacheWrite?.status, "written");
		const after = (await invoke("work_status", target)).details as WorkStatusToolDetails;
		assert.equal(after.specState, "done");
		assert.equal(after.nodes[0]!.lifecycle, "done");
		assert.equal(after.nodes[0]!.verification, "verified-this-session");
		assert.equal(after.nodes[0]!.dispatches.length, 1);
		// A fresh session can read the receipt, but persisted green is not authority.
		forgetSessionVerifications();
		const fresh = (await invoke("work_status", target)).details as WorkStatusToolDetails;
		assert.equal(fresh.specState, "not-done");
		assert.equal(fresh.nodes[0]!.verification, "observed-green-not-verified-this-session");
		assert.equal(fresh.nodes[0]!.dispatches.length, 1);
		assert.equal(delegateResolutions, 0, "Fabric must never probe the absent delegate");
	} finally {
		hooks.deregister();
		forgetSessionVerifications();
		if (previousRoot === undefined) delete process.env.PI_FABRIC_PROJECT_ROOT;
		else process.env.PI_FABRIC_PROJECT_ROOT = previousRoot;
		await rm(root, { recursive: true, force: true });
	}
}

// Opt-in prerequisites: PI_WORK_FABRIC_LIVE=1, PI_WORK_FABRIC_LIVE_EXTENSION
// (installed Fabric entry), PI_WORK_FABRIC_LIVE_MODEL (provider/id), pi CLI and
// credentials. Explicit -e plus --no-extensions excludes pi-delegate entirely.
async function liveRun(root: string, request: FabricProgramRunRequest): Promise<FabricProgramRunReply> {
	assert.ok(process.env.PI_WORK_FABRIC_LIVE_EXTENSION, "set PI_WORK_FABRIC_LIVE_EXTENSION");
	const inputPath = path.join(root, "probe-input.json");
	const replyPath = path.join(root, "probe-reply.json");
	const extensionPath = path.join(root, "probe-extension.mjs");
	await writeFile(inputPath, JSON.stringify({ ref: request.ref, input: request.input }));
	await writeFile(extensionPath, `import { readFile, writeFile } from 'node:fs/promises';
export default function(pi) {
  pi.on('session_start', async (_event, ctx) => {
    const request = JSON.parse(await readFile(${JSON.stringify(inputPath)}, 'utf8'));
    const reply = await new Promise(resolve => {
      const timer = setTimeout(() => resolve({ok:false,error:'live Fabric timeout'}), 150000);
      pi.events.emit('pi-fabric:program:run:v1', {...request, reply(value) { clearTimeout(timer); resolve(value); }});
    });
    await writeFile(${JSON.stringify(replyPath)}, JSON.stringify(reply));
    ctx.shutdown();
  });
}`);
	execFileSync("pi", ["--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-session", "-e", process.env.PI_WORK_FABRIC_LIVE_EXTENSION!, "-e", extensionPath, "--print", ""], { cwd: root, timeout: 170000, maxBuffer: 1024 * 1024, env: { ...process.env, PI_FABRIC_PROJECT_ROOT: root } });
	return JSON.parse(await readFile(replyPath, "utf8")) as FabricProgramRunReply;
}

test("end-to-end: registered plan, default Fabric dispatch, independent verify and status without pi-delegate", { timeout: 180000, skip: verifierPrerequisite.available ? false : verifierPrerequisite.reason }, async () => {
	await flow();
});

test("end-to-end: live Fabric worker probe without pi-delegate", {
	skip: process.env.PI_WORK_FABRIC_LIVE === "1" ? false : "opt in with PI_WORK_FABRIC_LIVE=1; requires installed Fabric and model credentials",
	timeout: 180000,
}, async () => {
	assert.match(process.env.PI_WORK_FABRIC_LIVE_MODEL ?? "", /^[^/]+\/.+/);
	await flow(true);
});
