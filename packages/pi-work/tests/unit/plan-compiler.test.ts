import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { compileWorkPlan } from "../../src/plan/compiler.ts";
import { validateWorkspec } from "../../src/schema/index.ts";
import type { Workspec } from "../../src/schema/workspec.ts";
import { REPO_ROOT } from "../helpers/source-under-test.ts";
import { withDraftLineage } from "../helpers/workspec-source.ts";

async function spec(name: string): Promise<Workspec> {
	const result = validateWorkspec(withDraftLineage(await readFile(path.join(REPO_ROOT, "tests/fixtures/plan", name), "utf8")));
	assert.equal(result.structuralValid, true);
	assert.equal(result.valid, true);
	return result.spec;
}

async function invalidSpec(name: string): Promise<Workspec> {
	const result = validateWorkspec(withDraftLineage(await readFile(path.join(REPO_ROOT, "tests/fixtures/workspec/invalid", name), "utf8")));
	assert.equal(result.structuralValid, true);
	assert.equal(result.valid, false);
	return result.spec;
}

test("compiles exact single-direct delegate options and regenerates hashed by-reference briefs", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-work-plan-"));
	const result = await compileWorkPlan(await spec("design-section-2-no-profile-with-acceptance.yaml"), { cwd: root, nodeAddresses: [["schema"]] });
	assert.equal(result.ok, true);
	assert.equal(result.worktree, false);
	const receipt = result.plans[0];
	assert.equal(receipt.delegate.agent, "implementer");
	assert.deepEqual(receipt.delegate.skills, ["implement-typescript"]);
	assert.equal(receipt.delegate.model, "openai/gpt-5.6-sol");
	assert.equal(receipt.delegate.cwd, root);
	assert.deepEqual(receipt.delegate.writableRoots, ["src/import/schema/**"]);
	assert.equal(receipt.delegate.confineWrites, true);
	assert.equal(receipt.delegate.escalation, "local");
	assert.deepEqual(receipt.delegate.reads, [receipt.briefPath]);
	assert.deepEqual(receipt.canonicalDelegate, {
		runs: [{
			name: "schema",
			agent: "implementer",
			task: "Execute the assembled work contract for node schema; read the contract from the attached brief.",
			mode: "solo",
			skills: ["implement-typescript"],
			model: "openai/gpt-5.6-sol",
			cwd: root,
			reads: [receipt.briefPath],
			writableRoots: ["src/import/schema/**"],
			confineWrites: true,
			escalation: "local",
			worktree: false,
			// This node declares no checklist, so the carrier holds focus alone.
			// pi-delegate rejects an empty tasks list rather than accepting one that
			// would seed nothing, so `tasks` is omitted rather than sent empty.
			handoff: {
				focus: {
					objective: "Define the import schema and validators",
					boundaries: ["Confine writes to the declared touches: src/import/schema/**"],
				},
			},
		}],
	});
	assert.equal("tasks" in (receipt.canonicalDelegate.runs[0].handoff ?? {}), false);
	assert.equal("handoffSha256" in receipt, false);
	assert.equal(receipt.focusSha256, createHash("sha256").update(JSON.stringify(receipt.canonicalDelegate.runs[0].handoff?.focus)).digest("hex"));
	await writeFile(receipt.briefPath, "stale brief", "utf8");
	const second = await compileWorkPlan(await spec("design-section-2-no-profile-with-acceptance.yaml"), { cwd: root, nodeAddresses: [["schema"]] });
	assert.equal(second.ok, true);
	const bytes = await readFile(second.plans[0].briefPath);
	assert.notEqual(bytes.toString(), "stale brief");
	assert.equal(createHash("sha256").update(bytes).digest("hex"), second.plans[0].briefSha256);
	assert.equal(path.basename(second.plans[0].briefPath), `${second.plans[0].briefSha256}.md`);
	assert.equal(second.plans[0].delegate.reads[0], second.plans[0].briefPath);
	const builtin = await compileWorkPlan(await spec("design-section-2-no-profile-with-acceptance.yaml"), { cwd: root, nodeAddresses: [["docs"]] });
	assert.equal(builtin.ok, true);
	assert.equal(builtin.plans[0].delegate.agent, "worker");
	// This node declares a checklist but no touches, so focus carries an objective
	// with no boundaries rather than an empty boundaries array.
	assert.deepEqual(builtin.plans[0].canonicalDelegate.runs[0].handoff, {
		tasks: ["document the fixture workflow", "add troubleshooting section", "link from README"],
		focus: { objective: "Update the importer runbook" },
	});
	assert.equal(builtin.plans[0].handoffSha256, createHash("sha256").update(JSON.stringify(builtin.plans[0].canonicalDelegate.runs[0].handoff?.tasks)).digest("hex"));
	assert.equal(builtin.plans[0].focusSha256, createHash("sha256").update(JSON.stringify(builtin.plans[0].canonicalDelegate.runs[0].handoff?.focus)).digest("hex"));
	assert.notEqual(builtin.plans[0].focusSha256, builtin.plans[0].handoffSha256);
});

test("profile fails closed before creating a brief", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-work-profile-"));
	const result = await compileWorkPlan(await spec("design-section-2-with-acceptance.yaml"), { cwd: root, nodeAddresses: [["schema"], ["docs"]] });
	assert.equal(result.ok, false);
	assert.equal(result.plans.length, 0);
	assert.equal(result.findings[0].code, "worker-profile-unsupported");
	assert.equal(result.findings[0].path.join("."), "work.0.worker.profile");
	await assert.rejects(access(path.join(root, ".work", ".cache", "briefs")));
});

test("mixed parallel selection emits one overlap advisory and the worktree flag", async () => {
	const source = `title: t\ndescription: d\nintent: i\nwork:\n  - id: a\n    task: a\n    touches: [src/shared/**]\n    acceptance:\n      - id: A\n        statement: a is green\n        evidence:\n          kind: command\n          run: printf a\n          expect:\n            exit: 0\n            output_includes: a\n  - id: b\n    task: b\n    touches: [./src/shared/**]\n    acceptance:\n      - id: B\n        statement: b is green\n        evidence:\n          kind: command\n          run: printf b\n          expect:\n            exit: 0\n            output_includes: b\n`;
	const parsed = validateWorkspec(withDraftLineage(source));
	assert.equal(parsed.structuralValid, true);
	const result = await compileWorkPlan(parsed.spec, { cwd: await mkdtemp(path.join(os.tmpdir(), "pi-work-overlap-")), nodeAddresses: [["a"], ["b"]] });
	assert.equal(result.ok, true);
	assert.equal(result.worktree, true);
	assert.equal(result.plans.length, 2);
	assert.deepEqual(result.plans.map((plan) => plan.delegate.cwd), [undefined, undefined]);
	assert.equal(result.advisories.length, 1);
	assert.equal(result.advisories[0].overlaps[0].target, "src/shared/**");
	assert.deepEqual(result.advisories[0].overlaps[0].nodeIds, ["a", "b"]);
});

test("duplicate and missing selections fail without plans", async () => {
	const source = await spec("design-section-2-no-profile-with-acceptance.yaml");
	const duplicate = await compileWorkPlan(source, { cwd: os.tmpdir(), nodeAddresses: [["schema"], ["schema"]] });
	assert.equal(duplicate.ok, false);
	assert.equal(duplicate.findings[0].code, "duplicate-node-address");
	const missing = await compileWorkPlan(source, { cwd: os.tmpdir(), nodeAddresses: [["missing"]] });
	assert.equal(missing.ok, false);
	assert.equal(missing.findings[0].code, "node-address-not-found");
});

for (const [fixture, nodeAddress] of [["cyclic-dependency.yaml", ["a"]], ["cross-scope-dependency.yaml", ["parent"]]] as const) {
	test(`semantic-invalid ${fixture} fails before writing briefs`, async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-work-invalid-spec-"));
		const result = await compileWorkPlan(await invalidSpec(fixture), { cwd: root, nodeAddresses: [nodeAddress] });
		assert.equal(result.ok, false);
		assert.deepEqual(result.plans, []);
		assert.deepEqual(result.advisories, []);
		assert.equal(result.worktree, false);
		assert.ok(result.findings.length > 0);
		assert.ok(result.findings.every((finding) => finding.code === "invalid-spec"));
		await assert.rejects(access(path.join(root, ".work", ".cache", "briefs")));
	});
}
