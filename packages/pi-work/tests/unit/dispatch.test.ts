import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";

import {
	decodeDelegateRuntimeReceipt,
	dispatchPlan,
	loadDelegateClient,
	validateDelegateDispatchRequest,
	type DelegateDispatchRequest,
	type DelegateRuntimeReceipt,
	type DispatchDependencies,
} from "../../src/dispatch/index.ts";
import { importDelegateRuntime } from "../../src/dispatch/runtime.ts";
import type { PlanReceipt } from "../../src/plan/index.ts";
import type { StatusCacheDispatchEntry } from "../../src/status/types.ts";

const ROOT = "/tmp/pi-work-dispatch";
const INTERNAL_DELEGATE_MODULE_ID = ["@", "caair", "/pi-delegate"].join("");
const BRIEF = path.join(ROOT, ".work", ".cache", "briefs", `${"b".repeat(64)}.md`);
const CACHE = path.join(ROOT, ".work", ".cache", "status.json");
const SPEC = path.join(ROOT, "spec.yaml");
function plan(worktree = false): PlanReceipt {
	return {
		nodeId: "node",
		nodeAddress: ["node"],
		schemaPath: ["work", 0],
		briefPath: BRIEF,
		briefSha256: "b".repeat(64),
		delegate: {
			agent: "implementer",
			skills: ["implement-typescript"],
			model: "test/model",
			cwd: ROOT,
			reads: [BRIEF],
			task: "Execute the assembled work contract for node node; read the contract from the attached brief.",
			writableRoots: ["src/**"],
			confineWrites: true,
			escalation: "local",
			worktree,
		},
		canonicalDelegate: {
			runs: [{
				name: "node",
				agent: "implementer",
				task: "Execute the assembled work contract for node node; read the contract from the attached brief.",
				mode: "solo",
				skills: ["implement-typescript"],
				model: "test/model",
				cwd: ROOT,
				reads: [BRIEF],
				writableRoots: ["src/**"],
				confineWrites: true,
				escalation: "local",
				worktree,
			}],
		},
	};
}

function planWithTasks(): PlanReceipt {
	const base = plan();
	const handoff = { tasks: ["first", "second"] } as const;
	return {
		...base,
		handoffSha256: createHash("sha256").update(JSON.stringify(handoff.tasks)).digest("hex"),
		canonicalDelegate: { runs: [{ ...base.canonicalDelegate.runs[0], handoff }] },
	};
}

function receipt(overrides: Partial<DelegateRuntimeReceipt> = {}): DelegateRuntimeReceipt {
	return {
		schema: "pi-delegate.runtime-receipt",
		version: 1,
		runId: "run-1",
		createdAt: "2026-08-13T12:00:00.000Z",
		shape: "direct",
		forks: [{
			name: "node-fork",
			agent: "implementer",
			workerCwd: ROOT,
			branch: "fixture",
			maxRounds: 5,
			confineWrites: true,
			requestedModel: "test/model",
			resolvedModel: "resolved/model",
			skills: ["implement-typescript"],
			inputDigests: [
				{ kind: "task", name: "task", algorithm: "sha256", digest: "a".repeat(64) },
				{ kind: "read", name: BRIEF, algorithm: "sha256", digest: "b".repeat(64) },
			],
		}],
		receiptPath: path.join(ROOT, "delegate", "run-1", "receipt.json"),
		resultPath: path.join(ROOT, "delegate", "run-1", "result.json"),
		...overrides,
	};
}

const target = { worktreePath: ROOT, headCommit: "a".repeat(40), branch: "fixture", specPath: SPEC, cachePath: CACHE };
const context = { cwd: ROOT } as never;

function available(dispatch: (request: DelegateDispatchRequest) => Promise<unknown>, cacheWriter?: DispatchDependencies["cacheWriter"], grammar: "legacy" | "canonical" = "legacy"): DispatchDependencies {
	return { clientProvider: async () => ({ status: "available", grammar, client: { dispatch } }), ...(cacheWriter === undefined ? {} : { cacheWriter }) };
}

test("runtime loading probes canonical support without dispatching", async () => {
	let factoryCalls = 0;
	let dispatchCalls = 0;
	const runtimeClient = {
		async dispatch() {
			dispatchCalls += 1;
			return receipt();
		},
	};
	const oldRuntime = await loadDelegateClient(context, async () => ({
		createDelegateRuntimeClient() {
			factoryCalls += 1;
			return runtimeClient;
		},
	}));
	assert.equal(oldRuntime.status, "available");
	if (oldRuntime.status === "available") assert.equal(oldRuntime.grammar, "legacy");

	const newRuntime = await loadDelegateClient(context, async () => ({
		normalizeDelegateParams(value: unknown) { return value; },
		createDelegateRuntimeClient() {
			factoryCalls += 1;
			return runtimeClient;
		},
	}));
	assert.equal(newRuntime.status, "available");
	if (newRuntime.status === "available") assert.equal(newRuntime.grammar, "canonical");

	const absent = await loadDelegateClient(context, async () => { throw new Error("module absent"); });
	assert.equal(absent.status, "unavailable");
	assert.equal(factoryCalls, 2);
	assert.equal(dispatchCalls, 0, "the capability probe must never dispatch");
});

test("the default loader reaches the live pi-delegate handle before any module import", async () => {
	const key = Symbol.for("pi-delegate.runtime-api.v1");
	const slot = globalThis as Record<symbol, unknown>;
	assert.equal(slot[key], undefined, "no handle leaks in from another test");
	const handle = Object.freeze({ createDelegateRuntimeClient() { return { async dispatch() { return receipt(); } }; } });
	try {
		slot[key] = handle;
		const loaded = await importDelegateRuntime(async () => { throw new Error("module import must not run"); });
		assert.equal(loaded, handle);
	} finally {
		delete slot[key];
	}
});

test("loadDelegateClient validates the live handle without dispatching", async () => {
	const key = Symbol.for("pi-delegate.runtime-api.v1");
	const slot = globalThis as Record<symbol, unknown>;
	assert.equal(slot[key], undefined, "no handle leaks in from another test");
	let factoryCalls = 0;
	let dispatchCalls = 0;
	try {
		slot[key] = Object.freeze({
			normalizeDelegateParams(value: unknown) { return value; },
			createDelegateRuntimeClient() {
				factoryCalls += 1;
				return { async dispatch() { dispatchCalls += 1; return receipt(); } };
			},
		});
		const live = await loadDelegateClient(context);
		assert.equal(live.status, "available", "the default loader uses the live handle");
		if (live.status === "available") assert.equal(live.grammar, "canonical");
		assert.equal(factoryCalls, 1);
		assert.equal(dispatchCalls, 0, "the capability probe must never dispatch");

		slot[key] = { createDelegateRuntimeClient: "not a function" };
		const malformed = await loadDelegateClient(context);
		assert.equal(malformed.status, "unavailable", "a malformed handle fails closed instead of dispatching");
	} finally {
		delete slot[key];
	}

	let fallbackCalls = 0;
	const absent = await loadDelegateClient(context, async () => { fallbackCalls += 1; throw new Error("module absent"); });
	assert.equal(absent.status, "unavailable", "with no handle and no importable package the client is unavailable");
	assert.equal(fallbackCalls, 1);
});

test("the default loader uses the internal pi-delegate package when it resolves", async () => {
	const internal = { createDelegateRuntimeClient() { return { async dispatch() { return receipt(); } }; } };
	const imports: string[] = [];
	const loaded = await importDelegateRuntime(async (moduleId) => {
		imports.push(moduleId);
		if (moduleId === INTERNAL_DELEGATE_MODULE_ID) return internal;
		throw Object.assign(new Error(`Cannot find package '${moduleId}'`), { code: "ERR_MODULE_NOT_FOUND" });
	});
	assert.equal(loaded, internal);
	assert.deepEqual(imports, [INTERNAL_DELEGATE_MODULE_ID]);
});

test("the default loader tries the public pi-delegate package after the internal package is missing", async () => {
	const publicRuntime = { createDelegateRuntimeClient() { return { async dispatch() { return receipt(); } }; } };
	const imports: string[] = [];
	const loaded = await importDelegateRuntime(async (moduleId) => {
		imports.push(moduleId);
		if (moduleId === "@centerforagenticai/pi-delegate") return publicRuntime;
		throw Object.assign(new Error(`Cannot find package '${moduleId}'`), { code: "ERR_MODULE_NOT_FOUND" });
	});
	assert.equal(loaded, publicRuntime);
	assert.deepEqual(imports, [INTERNAL_DELEGATE_MODULE_ID, "@centerforagenticai/pi-delegate"]);
});

test("the default loader preserves the final module-not-found error when both pi-delegate packages are missing", async () => {
	const errors = new Map([
		[INTERNAL_DELEGATE_MODULE_ID, Object.assign(new Error(`Cannot find module '${INTERNAL_DELEGATE_MODULE_ID}'`), { code: "MODULE_NOT_FOUND" })],
		["@centerforagenticai/pi-delegate", Object.assign(new Error("Cannot find package '@centerforagenticai/pi-delegate'"), { code: "ERR_MODULE_NOT_FOUND" })],
	]);
	const imports: string[] = [];
	await assert.rejects(importDelegateRuntime(async (moduleId) => {
		imports.push(moduleId);
		throw errors.get(moduleId);
	}), (error) => error === errors.get("@centerforagenticai/pi-delegate"));
	assert.deepEqual(imports, [INTERNAL_DELEGATE_MODULE_ID, "@centerforagenticai/pi-delegate"]);
});

test("the default loader propagates a non-not-found import error without trying the public package", async () => {
	const failure = Object.assign(new Error("package initialization failed"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
	const imports: string[] = [];
	await assert.rejects(importDelegateRuntime(async (moduleId) => {
		imports.push(moduleId);
		throw failure;
	}), (error) => error === failure);
	assert.deepEqual(imports, [INTERNAL_DELEGATE_MODULE_ID]);
});

test("the default loader does not hide a missing transitive module behind the public fallback", async () => {
	const failure = Object.assign(new Error("Cannot find package 'transitive-dependency'"), { code: "ERR_MODULE_NOT_FOUND" });
	const imports: string[] = [];
	await assert.rejects(importDelegateRuntime(async (moduleId) => {
		imports.push(moduleId);
		throw failure;
	}), (error) => error === failure);
	assert.deepEqual(imports, [INTERNAL_DELEGATE_MODULE_ID]);
});

test("the default loader ignores an attempted package name mentioned only as the importer", async () => {
	const failure = Object.assign(new Error(`Cannot find package 'transitive-dependency' imported from '${INTERNAL_DELEGATE_MODULE_ID}'`), { code: "ERR_MODULE_NOT_FOUND" });
	const imports: string[] = [];
	await assert.rejects(importDelegateRuntime(async (moduleId) => {
		imports.push(moduleId);
		throw failure;
	}), (error) => error === failure);
	assert.deepEqual(imports, [INTERNAL_DELEGATE_MODULE_ID]);
});

test("the default loader propagates a missing filesystem target inside a nested package copy", async () => {
	const nestedTarget = `/tmp/node_modules/${INTERNAL_DELEGATE_MODULE_ID}/dist/index.js`;
	const failure = Object.assign(new Error(`Cannot find module '${nestedTarget}' required by '${INTERNAL_DELEGATE_MODULE_ID}'`), { code: "MODULE_NOT_FOUND" });
	const imports: string[] = [];
	await assert.rejects(importDelegateRuntime(async (moduleId) => {
		imports.push(moduleId);
		throw failure;
	}), (error) => error === failure);
	assert.deepEqual(imports, [INTERNAL_DELEGATE_MODULE_ID]);
});

test("dispatchPlan submits one validated direct request and records the applied receipt fields", async () => {
	const requests: DelegateDispatchRequest[] = [];
	let written: StatusCacheDispatchEntry | undefined;
	const result = await dispatchPlan({ plan: plan(), target, context }, available(
		async (request) => { requests.push(request); return receipt(); },
		async (_cachePath, _specPath, _worktreePath, entry) => {
			written = entry;
			return { status: "written", path: CACHE, attempts: 1, residualRace: "readback-may-precede-later-overwrite" };
		},
	));
	assert.equal(result.outcome, "dispatched");
	assert.equal(requests.length, 1);
	assert.deepEqual(requests[0], {
		agent: "implementer",
		task: plan().delegate.task,
		cwd: ROOT,
		reads: [BRIEF],
		skills: ["implement-typescript"],
		model: "test/model",
		writableRoots: ["src/**"],
		confineWrites: true,
		escalation: "local",
	});
	assert.equal("worktree" in requests[0]!, false);
	assert.equal("await" in requests[0]!, false);
	assert.equal(written?.runId, "run-1");
	assert.equal(written?.forkName, "node-fork");
	assert.equal(written?.slot.resolvedModel, "resolved/model");
	assert.equal(written?.worktreePath, ROOT);
	assert.equal(written?.branch, "fixture");
	assert.equal(written?.briefSha256, "b".repeat(64));
});

test("dispatchPlan sends the work_plan canonical run when the capability is present", async () => {
	const requests: DelegateDispatchRequest[] = [];
	let written: StatusCacheDispatchEntry | undefined;
	const canonicalReceipt = receipt({ forks: [{ ...receipt().forks[0]!, name: "node" }] });
	const result = await dispatchPlan({ plan: plan(), target, context }, available(
		async (request) => { requests.push(request); return canonicalReceipt; },
		async (_cachePath, _specPath, _worktreePath, entry) => {
			written = entry;
			return { status: "written", path: CACHE, attempts: 1, residualRace: "readback-may-precede-later-overwrite" };
		},
		"canonical",
	));
	assert.equal(result.outcome, "dispatched");
	assert.equal(requests.length, 1);
	assert.deepEqual(requests[0], plan().canonicalDelegate);
	assert.equal(written?.forkName, "node");
});

test("canonical tasks reach the runtime receipt with a reproducible namespace digest", async () => {
	const taskPlan = planWithTasks();
	const expectedTasks = taskPlan.canonicalDelegate.runs[0].handoff?.tasks;
	assert.ok(expectedTasks);
	const requests: DelegateDispatchRequest[] = [];
	const runtimeReceipt = (request: DelegateDispatchRequest, digestOverride?: string): DelegateRuntimeReceipt => {
		requests.push(request);
		assert.ok("runs" in request, "canonical capability must submit runs");
		const submittedTasks = request.runs[0].handoff?.tasks;
		assert.deepEqual(submittedTasks, expectedTasks, "the dispatched request must carry the compiled tasks");
		assert.ok(submittedTasks);
		const checklist = {
			kind: "checklist" as const,
			name: "checklist",
			algorithm: "sha256" as const,
			digest: digestOverride ?? createHash("sha256").update(JSON.stringify(submittedTasks)).digest("hex"),
		};
		const fork = receipt().forks[0]!;
		return receipt({ forks: [{ ...fork, name: request.runs[0].name, inputDigests: [...fork.inputDigests, checklist] }] });
	};
	let writes = 0;
	const accepted = await dispatchPlan({ plan: taskPlan, target, context }, available(async (request) => runtimeReceipt(request), async () => {
		writes += 1;
		return { status: "written", path: CACHE, attempts: 1, residualRace: "readback-may-precede-later-overwrite" };
	}, "canonical"));
	assert.equal(accepted.outcome, "dispatched");
	assert.equal(requests.length, 1);
	assert.equal(writes, 1);

	const rejectedDigest = await dispatchPlan({ plan: taskPlan, target, context }, available(async (request) => runtimeReceipt(request, "0".repeat(64)), async () => {
		writes += 1;
		throw new Error("must not cache mismatched tasks");
	}, "canonical"));
	assert.equal(rejectedDigest.outcome, "dispatched");
	if (rejectedDigest.outcome === "dispatched") {
		assert.equal(rejectedDigest.cacheWrite.status, "skipped");
		assert.equal(rejectedDigest.findings[0]?.code, "delegate-receipt-mismatch");
	}
	assert.equal(requests.length, 2);
	assert.equal(writes, 1);
});

test("temporary-worktree and mismatched persistent-target plans fail closed before loading the client", async () => {
	for (const candidate of [
		plan(true),
		{ ...plan(), delegate: { ...plan().delegate, cwd: "/tmp/other-worktree" } },
		{ ...plan(), delegate: { ...plan().delegate, reads: [path.join(ROOT, "other-brief.md")] as [string] } },
	]) {
		let providerCalls = 0;
		const result = await dispatchPlan({ plan: candidate, target, context }, {
			clientProvider: async () => { providerCalls += 1; return { status: "unavailable", message: "must not load" }; },
		});
		assert.equal(result.outcome, "rejected");
		assert.equal(result.dispatchState, "not-dispatched");
		assert.equal(providerCalls, 0);
		assert.ok(result.findings[0].code === "dispatch-worktree-incompatible" || result.findings[0].code === "dispatch-request-invalid");
	}
});

test("unavailable clients and core-unavailable errors return plan-only degraded results", async () => {
	const unavailable = await dispatchPlan({ plan: plan(), target, context }, { clientProvider: async () => ({ status: "unavailable", message: "module absent" }) });
	assert.equal(unavailable.outcome, "degraded");
	assert.equal(unavailable.dispatchState, "not-dispatched");
	assert.equal("receipt" in unavailable, false);
	assert.equal(unavailable.plan.delegate.reads[0], BRIEF);

	let calls = 0;
	const coreUnavailable = await dispatchPlan({ plan: plan(), target, context }, available(async () => {
		calls += 1;
		throw Object.assign(new Error("core absent"), { code: "core-unavailable" });
	}));
	assert.equal(coreUnavailable.outcome, "degraded");
	assert.equal(coreUnavailable.dispatchState, "not-dispatched");
	assert.equal("receipt" in coreUnavailable, false);
	assert.equal(calls, 1);
});

test("post-invocation errors and malformed receipts are indeterminate and never retried", async () => {
	for (const operation of [
		async () => { throw Object.assign(new Error("receipt publication failed"), { code: "provenance-unavailable" }); },
		async () => ({ schema: "wrong" }),
	]) {
		let calls = 0;
		const result = await dispatchPlan({ plan: plan(), target, context }, available(async () => { calls += 1; return operation(); }));
		assert.equal(result.outcome, "indeterminate");
		assert.equal(result.dispatchState, "unknown");
		assert.equal(calls, 1);
		assert.equal("receipt" in result, false);
	}
});

test("a durable receipt is returned even when it cannot be cached or the bounded cache write fails", async () => {
	let writes = 0;
	const mismatchReceipt = receipt({ forks: [{ ...receipt().forks[0]!, inputDigests: [{ kind: "read", name: BRIEF, algorithm: "sha256", digest: "0".repeat(64) }] }] });
	const mismatch = await dispatchPlan({ plan: plan(), target, context }, available(async () => mismatchReceipt, async () => {
		writes += 1;
		throw new Error("must not write");
	}));
	assert.equal(mismatch.outcome, "dispatched");
	if (mismatch.outcome === "dispatched") {
		assert.equal(mismatch.receipt.runId, "run-1");
		assert.equal(mismatch.cacheWrite.status, "skipped");
	}
	assert.equal(writes, 0);

	for (const cacheWrite of [
		{ status: "contended" as const, path: CACHE, attempts: 8, residualRace: "readback-may-precede-later-overwrite" as const, message: "entry absent eight times" },
		{ status: "failed" as const, path: CACHE, attempts: 1, reason: "cache-write-error" as const, message: "disk full" },
	]) {
		const result = await dispatchPlan({ plan: plan(), target, context }, available(async () => receipt(), async () => cacheWrite));
		assert.equal(result.outcome, "dispatched");
		if (result.outcome === "dispatched") {
			assert.equal(result.receipt.runId, "run-1");
			assert.equal(result.cacheWrite.status, cacheWrite.status);
			assert.equal(result.findings.length, 1);
		}
	}

	const rejectedWriter = await dispatchPlan({ plan: plan(), target, context }, available(async () => receipt(), async () => { throw new Error("unexpected writer rejection"); }));
	assert.equal(rejectedWriter.outcome, "dispatched");
	if (rejectedWriter.outcome === "dispatched") {
		assert.equal(rejectedWriter.receipt.runId, "run-1");
		assert.deepEqual(rejectedWriter.cacheWrite, { status: "failed", path: CACHE, attempts: 0, reason: "cache-write-error", message: "unexpected writer rejection" });
		assert.equal(rejectedWriter.findings[0]?.code, "cache-write-failed");
	}
});

test("a multi-fork runtime receipt stays visible as dispatched but is not recorded as one node join", async () => {
	let writes = 0;
	const fork = receipt().forks[0]!;
	const multiFork = receipt({ forks: [fork, { ...fork, name: "other-fork" }] });
	const result = await dispatchPlan({ plan: plan(), target, context }, available(async () => multiFork, async () => {
		writes += 1;
		throw new Error("must not write an ambiguous join");
	}));
	assert.equal(result.outcome, "dispatched");
	if (result.outcome === "dispatched") {
		assert.deepEqual(result.receipt, multiFork);
		assert.deepEqual(result.cacheWrite, {
			status: "skipped",
			reason: "receipt-not-recordable",
			message: "direct dispatch returned 2 forks instead of exactly one",
		});
		assert.equal(result.findings[0]?.code, "delegate-receipt-mismatch");
	}
	assert.equal(writes, 0);
});

test("optional upstream receipt fields remain honestly absent while the validated target is still recorded", async () => {
	let written: StatusCacheDispatchEntry | undefined;
	const fork = receipt().forks[0]!;
	const minimal = receipt({
		forks: [{ name: fork.name, agent: fork.agent, maxRounds: fork.maxRounds, inputDigests: fork.inputDigests }],
	});
	const completePlan = plan();
	const minimalPlan: PlanReceipt = {
		...completePlan,
		delegate: {
			agent: completePlan.delegate.agent,
			...(completePlan.delegate.cwd === undefined ? {} : { cwd: completePlan.delegate.cwd }),
			reads: completePlan.delegate.reads,
			task: completePlan.delegate.task,
			confineWrites: true,
			escalation: "local",
			worktree: false,
		},
	};
	const result = await dispatchPlan({ plan: minimalPlan, target, context }, available(async () => minimal, async (_cachePath, _specPath, _worktreePath, entry) => {
		written = entry;
		return { status: "written", path: CACHE, attempts: 1, residualRace: "readback-may-precede-later-overwrite" };
	}));
	assert.equal(result.outcome, "dispatched");
	assert.equal(written?.worktreePath, ROOT);
	assert.equal(written?.branch, "fixture");
	assert.equal(written?.slot.workerCwd, undefined);
	assert.equal(written?.slot.branch, undefined);
	assert.equal(written?.slot.resolvedModel, undefined);
});

test("request and receipt decoders reject unknown and mistyped values", () => {
	const request = {
		agent: "implementer",
		task: "task",
		cwd: ROOT,
		reads: [BRIEF],
		confineWrites: true,
		escalation: "local",
	};
	assert.equal(validateDelegateDispatchRequest(request), true);
	for (const invalid of [
		null,
		[],
		"request",
		{ ...request, worktree: false },
		{ ...request, writableRoot: ["src/**"] },
		{ ...request, agent: "" },
		{ ...request, task: "" },
		{ ...request, cwd: "relative" },
		{ ...request, cwd: `${ROOT}/../pi-work-dispatch` },
		{ ...request, reads: "brief.md" },
		{ ...request, reads: [] },
		{ ...request, reads: [BRIEF, BRIEF] },
		{ ...request, reads: [1] },
		{ ...request, confineWrites: false },
		{ ...request, escalation: "off" },
		{ ...request, skills: "implement-typescript" },
		{ ...request, skills: [] },
		{ ...request, skills: [1] },
		{ ...request, model: 1 },
		{ ...request, model: "" },
		{ ...request, writableRoots: "src/**" },
		{ ...request, writableRoots: [] },
		{ ...request, writableRoots: [1] },
	]) assert.equal(validateDelegateDispatchRequest(invalid), false);

	const canonical = plan().canonicalDelegate;
	assert.equal(validateDelegateDispatchRequest(canonical), true);
	const run = canonical.runs[0];
	// Each namespace stands alone: tasks-only and focus-only carriers are both
	// valid. An empty tasks list is not -- pi-delegate refuses it outright rather
	// than accepting a carrier that would seed nothing.
	assert.equal(validateDelegateDispatchRequest({ runs: [{ ...run, handoff: { tasks: ["one"] } }] }), true);
	assert.equal(validateDelegateDispatchRequest({ runs: [{ ...run, handoff: { focus: { objective: "seed the worker" } } }] }), true);
	assert.equal(validateDelegateDispatchRequest({ runs: [{ ...run, handoff: { focus: { objective: "seed", boundaries: ["stay in src/**"] } } }] }), true);
	for (const invalid of [
		{ ...canonical, extra: true },
		{ runs: [] },
		{ runs: [run, run] },
		{ runs: [{ ...run, unknown: true }] },
		{ runs: [{ ...run, name: "" }] },
		{ runs: [{ ...run, mode: "supervised" }] },
		{ runs: [{ ...run, worktree: true }] },
		{ runs: [{ ...run, handoff: {} }] },
		{ runs: [{ ...run, handoff: { tasks: [1] } }] },
		{ runs: [{ ...run, handoff: { tasks: [], focus: { objective: "discarded" } } }] },
		{ runs: [{ ...run, handoff: { focus: {} } }] },
		{ runs: [{ ...run, handoff: { focus: { objective: "" } } }] },
		{ runs: [{ ...run, handoff: { focus: { objective: 1 } } }] },
		{ runs: [{ ...run, handoff: { focus: { objective: "ok", unknown: true } } }] },
		{ runs: [{ ...run, handoff: { focus: { objective: "ok", boundaries: "stay in src" } } }] },
		{ runs: [{ ...run, handoff: { focus: { objective: "ok", boundaries: [""] } } }] },
		{ runs: [{ ...run, handoff: { focus: { objective: "ok", boundaries: [1] } } }] },
	]) assert.equal(validateDelegateDispatchRequest(invalid), false);
	assert.deepEqual(decodeDelegateRuntimeReceipt(receipt()), receipt());
	assert.equal(decodeDelegateRuntimeReceipt({ ...receipt(), unknown: true }), undefined);
	assert.equal(decodeDelegateRuntimeReceipt({ ...receipt(), forks: [{ ...receipt().forks[0]!, extra: true }] }), undefined);
	assert.equal(decodeDelegateRuntimeReceipt({ ...receipt(), receiptPath: "relative/receipt.json" }), undefined);
	assert.equal(decodeDelegateRuntimeReceipt({ ...receipt(), forks: [{ ...receipt().forks[0]!, workerCwd: "relative" }] }), undefined);
});

test("dispatchPlan calls the injected dispatch port at most once across every result path and grammar", async () => {
	type Grammar = "legacy" | "canonical";
	type Scenario = {
		readonly name: string;
		readonly grammars?: readonly Grammar[];
		readonly candidatePlan?: (grammar: Grammar) => PlanReceipt;
		readonly unavailable?: boolean;
		readonly operation?: (grammar: Grammar) => Promise<unknown>;
		readonly cacheWriter?: DispatchDependencies["cacheWriter"];
		readonly outcome: "rejected" | "degraded" | "indeterminate" | "dispatched";
		readonly calls: 0 | 1;
		readonly writes: 0 | 1;
	};
	const matchingReceipt = (grammar: Grammar): DelegateRuntimeReceipt => grammar === "canonical"
		? receipt({ forks: [{ ...receipt().forks[0]!, name: "node" }] })
		: receipt();
	const successfulWrite: NonNullable<DispatchDependencies["cacheWriter"]> = async () => ({
		status: "written",
		path: CACHE,
		attempts: 1,
		residualRace: "readback-may-precede-later-overwrite",
	});
	const scenarios: readonly Scenario[] = [
		{ name: "worktree rejection", candidatePlan: () => plan(true), outcome: "rejected", calls: 0, writes: 0 },
		{ name: "persistent target rejection", candidatePlan: () => ({ ...plan(), delegate: { ...plan().delegate, cwd: "/tmp/other" } }), outcome: "rejected", calls: 0, writes: 0 },
		{ name: "request validation rejection", candidatePlan: () => ({ ...plan(), delegate: { ...plan().delegate, task: "" } }), outcome: "rejected", calls: 0, writes: 0 },
		{
			name: "canonical name rejection",
			grammars: ["canonical"],
			candidatePlan: () => ({ ...plan(), canonicalDelegate: { runs: [{ ...plan().canonicalDelegate.runs[0], name: "other" }] } }),
			outcome: "rejected",
			calls: 0,
			writes: 0,
		},
		{
			name: "canonical digest rejection",
			grammars: ["canonical"],
			candidatePlan: () => ({ ...plan(), handoffSha256: "0".repeat(64) }),
			outcome: "rejected",
			calls: 0,
			writes: 0,
		},
		{ name: "client unavailable", unavailable: true, outcome: "degraded", calls: 0, writes: 0 },
		{ name: "core unavailable after invocation", operation: async () => { throw Object.assign(new Error("core absent"), { code: "core-unavailable" }); }, outcome: "degraded", calls: 1, writes: 0 },
		{ name: "runtime failure", operation: async () => { throw new Error("runtime failed"); }, outcome: "indeterminate", calls: 1, writes: 0 },
		{ name: "malformed receipt", operation: async () => ({ schema: "wrong" }), outcome: "indeterminate", calls: 1, writes: 0 },
		{
			name: "receipt mismatch",
			operation: async (grammar) => {
				const base = matchingReceipt(grammar);
				return receipt({ ...base, forks: [{ ...base.forks[0]!, branch: "other" }] });
			},
			outcome: "dispatched",
			calls: 1,
			writes: 0,
		},
		{
			name: "multi-fork receipt",
			operation: async (grammar) => {
				const base = matchingReceipt(grammar);
				return receipt({ ...base, forks: [base.forks[0]!, { ...base.forks[0]!, name: "other" }] });
			},
			outcome: "dispatched",
			calls: 1,
			writes: 0,
		},
		{ name: "cache write success", cacheWriter: successfulWrite, outcome: "dispatched", calls: 1, writes: 1 },
		{
			name: "cache write contention",
			cacheWriter: async () => ({ status: "contended", path: CACHE, attempts: 8, residualRace: "readback-may-precede-later-overwrite", message: "entry stayed absent" }),
			outcome: "dispatched",
			calls: 1,
			writes: 1,
		},
		{
			name: "cache write failure",
			cacheWriter: async () => ({ status: "failed", path: CACHE, attempts: 1, reason: "cache-write-error", message: "disk full" }),
			outcome: "dispatched",
			calls: 1,
			writes: 1,
		},
		{
			name: "cache writer rejection",
			cacheWriter: async () => { throw new Error("writer rejected"); },
			outcome: "dispatched",
			calls: 1,
			writes: 1,
		},
	];
	for (const scenario of scenarios) {
		for (const grammar of scenario.grammars ?? ["legacy", "canonical"] as const) {
			let calls = 0;
			let writes = 0;
			const countedWriter: DispatchDependencies["cacheWriter"] = scenario.cacheWriter === undefined
				? undefined
				: async (...args) => {
					writes += 1;
					return scenario.cacheWriter!(...args);
				};
			const dependencies: DispatchDependencies = scenario.unavailable
				? { clientProvider: async () => ({ status: "unavailable", message: "module absent" }) }
				: available(async () => {
					calls += 1;
					return (scenario.operation ?? (async (selected: Grammar) => matchingReceipt(selected)))(grammar);
				}, countedWriter, grammar);
			const label = `${grammar}: ${scenario.name}`;
			const result = await dispatchPlan({ plan: scenario.candidatePlan?.(grammar) ?? plan(), target, context }, dependencies);
			assert.equal(result.outcome, scenario.outcome, label);
			assert.equal(calls, scenario.calls, label);
			assert.equal(writes, scenario.writes, label);
		}
	}
});
