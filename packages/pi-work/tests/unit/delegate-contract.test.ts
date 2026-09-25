import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import type { DelegateRuntimeReceipt } from "../../src/dispatch/index.ts";
import { workPlanTool, type WorkPlanDetails } from "../../src/tools/work-plan.ts";
import { withDraftLineage } from "../helpers/workspec-source.ts";

const CONTRACT_SOURCE = withDraftLineage(`title: Delegate contract
description: Cross-package contract fixture
intent: Preserve the authored execution contract
work:
  - id: lane
    task: Implement the lane
    touches: [src/lane/**]
    worker:
      agent: implementer
      skills: [implement-typescript]
      model: test/model
    checklist:
      - preserve the carrier
      - report evidence
    acceptance:
      - id: contract
        statement: The delegate request is accepted.
        evidence:
          kind: command
          run: npm test
          expect:
            exit: 0
            output_includes: pass
`);

async function emittedPlan() {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-work-delegate-contract-"));
	await writeFile(path.join(cwd, "spec.yaml"), withDraftLineage(CONTRACT_SOURCE, { cwd }));
	const result = await workPlanTool.execute("contract", { path: "spec.yaml", nodeAddresses: [["lane"]] }, undefined, undefined, { cwd } as never) as { details: WorkPlanDetails };
	assert.equal(result.details.valid, true);
	assert.equal(result.details.plans.length, 1);
	return { cwd, plan: result.details.plans[0] };
}

function sha256(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

test("work_plan pins canonical runs, task handoff, and the unchanged legacy invocation", async () => {
	const { cwd, plan } = await emittedPlan();
	try {
		assert.deepEqual(Object.keys(plan).sort(), ["briefPath", "briefSha256", "canonicalDelegate", "delegate", "focusSha256", "handoffSha256", "nodeAddress", "nodeId", "schemaPath"]);
		assert.deepEqual(plan.delegate, {
			agent: "implementer",
			skills: ["implement-typescript"],
			model: "test/model",
			cwd,
			reads: [plan.briefPath],
			task: "Execute the assembled work contract for node lane; read the contract from the attached brief.",
			writableRoots: ["src/lane/**"],
			confineWrites: true,
			escalation: "local",
			worktree: false,
		});
		assert.deepEqual(plan.canonicalDelegate, {
			runs: [{
				name: "lane",
				agent: "implementer",
				skills: ["implement-typescript"],
				model: "test/model",
				cwd,
				reads: [plan.briefPath],
				task: "Execute the assembled work contract for node lane; read the contract from the attached brief.",
				writableRoots: ["src/lane/**"],
				confineWrites: true,
				escalation: "local",
				worktree: false,
				mode: "solo",
				handoff: {
					tasks: ["preserve the carrier", "report evidence"],
					focus: {
						objective: "Implement the lane",
						boundaries: ["Confine writes to the declared touches: src/lane/**"],
					},
				},
			}],
		});
		assert.equal(plan.handoffSha256, sha256(plan.canonicalDelegate.runs[0].handoff?.tasks));
		// Digested per namespace over the caller's own bytes, never over the pair:
		// #11's round-1 defect was hashing {tasks, focus} while the runtime hashed
		// the tasks payload alone.
		assert.equal(plan.focusSha256, sha256(plan.canonicalDelegate.runs[0].handoff?.focus));
		assert.notEqual(plan.focusSha256, plan.handoffSha256);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

const delegateCheckout = process.env.PI_DELEGATE_CHECKOUT;
if (delegateCheckout === undefined) {
	test("pi-delegate checkout contract [not run: PI_DELEGATE_CHECKOUT is unset]", { skip: "set PI_DELEGATE_CHECKOUT to a built pi-delegate checkout" }, () => {});
} else {
	test("a real pi-delegate runtime submits tasks to the core and records pi-work's digest", async () => {
		const manifest = JSON.parse(await readFile(path.join(delegateCheckout, "package.json"), "utf8")) as { name?: unknown };
		assert.ok(typeof manifest.name === "string");
		assert.equal(manifest.name.split("/").at(-1), "pi-delegate");
		const packageModule = await import(pathToFileURL(path.join(delegateCheckout, "dist", "index.js")).href) as {
			normalizeDelegateParams?: (value: unknown) => unknown;
			createDelegateRuntimeClient?: (options: { agentDir: string; context: unknown }) => { dispatch(request: unknown): Promise<DelegateRuntimeReceipt> };
			readDelegateRuntimeReceipt?: (agentDir: string, runId: string) => unknown;
		};
		const runtimeApiModule = await import(pathToFileURL(path.join(delegateCheckout, "dist", "runtime-api.js")).href) as {
			installDelegateRuntimeCore?: (core: { invoke(name: string, params: Record<string, unknown>, context: unknown): Promise<{ details: { runId: string } }> } | undefined) => void;
		};
		const runtimeModule = await import(pathToFileURL(path.join(delegateCheckout, "dist", "runtime.js")).href) as {
			registerRun?: (run: Record<string, unknown>) => void;
			__resetRuntimeForTests?: () => void;
		};
		assert.equal(typeof packageModule.normalizeDelegateParams, "function", "the named checkout must expose the #263 capability");
		assert.equal(typeof packageModule.createDelegateRuntimeClient, "function", "the named checkout must expose its runtime client");
		assert.equal(typeof packageModule.readDelegateRuntimeReceipt, "function", "the named checkout must expose durable receipt read-back");
		assert.equal(typeof runtimeApiModule.installDelegateRuntimeCore, "function", "the named checkout must expose its core installation seam");
		assert.equal(typeof runtimeModule.registerRun, "function", "the named checkout must expose runtime registration to its own tests");
		assert.equal(typeof runtimeModule.__resetRuntimeForTests, "function", "the named checkout must expose runtime test reset");

		const { cwd, plan } = await emittedPlan();
		const agentDir = path.join(cwd, "agent");
		await mkdir(agentDir, { recursive: true });
		const request = plan.canonicalDelegate;
		const tasks = request.runs[0].handoff?.tasks;
		assert.ok(tasks);
		assert.equal(typeof plan.handoffSha256, "string");
		const runId = "pi-work-contract";
		const invocations: Array<{ name: string; params: Record<string, unknown> }> = [];
		runtimeModule.__resetRuntimeForTests!();
		runtimeApiModule.installDelegateRuntimeCore!({
			async invoke(name, params) {
				invocations.push({ name, params });
				runtimeModule.registerRun!({
					runId,
					shape: "direct",
					createdAt: 1_700_000_000_000,
					forks: {
						lane: {
							name: "lane",
							agent: "implementer",
							agentSource: "project",
							task: request.runs[0].task,
							workerCwd: cwd,
							status: "pending",
							currentRound: 0,
							maxRounds: 1,
							transcript: [],
							pendingGuidance: [],
							interactive: false,
						},
					},
					abort() {},
				});
				return { details: { runId } };
			},
		});
		try {
			const client = packageModule.createDelegateRuntimeClient!({ agentDir, context: { cwd } });
			const receipt = await client.dispatch(request);
			assert.equal(invocations.length, 1);
			assert.equal(invocations[0]?.name, "delegate");
			assert.equal(invocations[0]?.params.await, false);
			assert.deepEqual(invocations[0]?.params.checklist, tasks, "compileDelegateRuns must submit handoff.tasks to the core slot");
			assert.equal("handoff" in invocations[0]!.params, false, "the assertion must observe the post-compile core parameters");
			const checklistDigests = receipt.forks[0]?.inputDigests.filter((digest) => digest.kind === "checklist") ?? [];
			assert.equal(checklistDigests.length, 1);
			assert.equal(checklistDigests[0]?.name, "checklist");
			assert.equal(checklistDigests[0]?.digest, plan.handoffSha256);
			assert.equal(checklistDigests[0]?.digest, sha256(tasks));

			// #11 dropped focus because it vanished here, at the post-compile core slot,
			// while the dispatch still reported success. Observing it after normalization
			// proves nothing -- that is exactly what passed against the broken carrier.
			const focus = request.runs[0].handoff?.focus;
			assert.ok(focus, "work_plan must emit handoff.focus");
			assert.deepEqual(invocations[0]?.params.focus, focus, "compileDelegateRuns must submit handoff.focus to the core slot");

			// ADR-0019: the verifier recomputes digests independently, so pi-work's digest
			// domain must match the runtime's per namespace, over the caller's own bytes.
			const focusDigests = receipt.forks[0]?.inputDigests.filter((digest) => digest.kind === "focus") ?? [];
			assert.equal(focusDigests.length, 1, "the runtime must record exactly one focus digest");
			assert.equal(focusDigests[0]?.name, "focus");
			assert.equal(focusDigests[0]?.digest, plan.focusSha256, "pi-work's focus digest must match the one the runtime records");
			assert.equal(focusDigests[0]?.digest, sha256(focus));
			assert.deepEqual(packageModule.readDelegateRuntimeReceipt!(agentDir, runId), receipt);
		} finally {
			runtimeApiModule.installDelegateRuntimeCore!(undefined);
			runtimeModule.__resetRuntimeForTests!();
			await rm(cwd, { recursive: true, force: true });
		}
	});
}
