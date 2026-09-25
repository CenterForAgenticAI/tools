import assert from "node:assert/strict";
import nodePath from "node:path";
import test from "node:test";

import { validateWorkspec } from "../../src/schema/index.ts";
import { runAgent } from "../../src/verify/agent.ts";
import { WorkNodeProjector, type Evidence, type WorkNode, type WorkNodeField, type Workspec } from "../../src/schema/workspec.ts";
import { withDraftLineage } from "../helpers/workspec-source.ts";

const allNodeFields: Record<WorkNodeField, true> = {
	id: true,
	task: true,
	description: true,
	depends_on: true,
	touches: true,
	refs: true,
	worker: true,
	acceptance: true,
	checklist: true,
	work: true,
};
const totalProjector = {
	id: { worker: 1, review: 1, remediation: 1 },
	task: { worker: 1, review: 1, remediation: 1 },
	description: { worker: 1, review: 1, remediation: 1 },
	depends_on: { worker: 1, review: 1, remediation: 1 },
	touches: { worker: 1, review: 1, remediation: 1 },
	refs: { worker: 1, review: 1, remediation: 1 },
	worker: { worker: 1, review: 1, remediation: 1 },
	acceptance: { worker: 1, review: 1, remediation: 1 },
	checklist: { worker: 1, review: 1, remediation: 1 },
	work: { worker: 1, review: 1, remediation: 1 },
} satisfies WorkNodeProjector<number>;
void allNodeFields;
void totalProjector;

type BothNode = { id: string; task: string; checklist: string[]; work: WorkNode[] };
type BothNodeAssignable = BothNode extends WorkNode ? true : false;
const workAndChecklistAreStaticallyExclusive: true = null as unknown as (BothNodeAssignable extends false ? true : false);
void workAndChecklistAreStaticallyExclusive;

function narrowedSpec(result: ReturnType<typeof validateWorkspec>): Workspec | undefined {
	if (result.structuralValid) return result.spec;
	return undefined;
}

function invalidResultHasNoSpec(result: ReturnType<typeof validateWorkspec>): void {
	if (!result.structuralValid) {
		const parsed: unknown = result.value;
		// @ts-expect-error structurally invalid results do not expose a Workspec
		const spec: Workspec = result.spec;
		void parsed;
		void spec;
	}
}

void narrowedSpec;
void invalidResultHasNoSpec;

function assertNever(value: never): never {
	throw new Error(`unexpected evidence ${(value as { kind: string }).kind}`);
}
function evidenceKind(evidence: Evidence): string {
	switch (evidence.kind) {
		case "command": return evidence.expect.exit.toString();
		case "agent": return evidence.agent;
		case "user": return evidence.prompt;
		default: return assertNever(evidence);
	}
}

test("strict schema accepts the three evidence variants and rejects lifecycle fields", () => {
	const source = withDraftLineage(`title: T\ndescription: D\nintent: I\nwork:\n  - id: a\n    task: A\n    acceptance:\n      - id: command\n        statement: S\n        evidence:\n          kind: command\n          run: echo\n          expect:\n            exit: 0\n            output_includes: echo\n      - id: agent\n        statement: S\n        evidence:\n          kind: agent\n          agent: reviewer\n          inputs: [x]\n          rubric: R\n      - id: user\n        statement: S\n        evidence:\n          kind: user\n          prompt: P\n    checklist: [one]\n`);
	const result = validateWorkspec(source);
	assert.equal(result.valid, true);
	assert.equal(result.structuralValid, true);
	assert.deepEqual(result.findings, []);
	if (!result.structuralValid) throw new Error("expected a structurally valid workspec");
	assert.equal(evidenceKind(result.spec.work[0].acceptance![0].evidence), "0");
	const forbidden = validateWorkspec("title: T\ndescription: D\nintent: I\nstatus: done\nwork: []\n");
	assert.ok(forbidden.findings.some((finding) => finding.code === "schema-additional-properties" && finding.path.join(".") === "status"));
	const rootEmpty = validateWorkspec("title: T\ndescription: D\nintent: I\nwork: []\n");
	assert.equal(rootEmpty.valid, true);
	const missingFloor = validateWorkspec("title: T\ndescription: D\nintent: I\nwork:\n  - id: command\n    task: run\n    acceptance:\n      - id: A\n        statement: done\n        evidence:\n          kind: command\n          run: printf x\n          expect:\n            exit: 0\n");
	assert.ok(missingFloor.findings.some((finding) => finding.code === "schema-required" && finding.path.join(".") === "work.0.acceptance.0.evidence.expect.output_includes"));
	const emptyFloor = validateWorkspec("title: T\ndescription: D\nintent: I\nwork:\n  - id: command\n    task: run\n    acceptance:\n      - id: A\n        statement: done\n        evidence:\n          kind: command\n          run: printf x\n          expect:\n            exit: 0\n            output_includes: \"\"\n");
	assert.ok(emptyFloor.findings.some((finding) => finding.code === "schema-invalid" && finding.path.join(".") === "work.0.acceptance.0.evidence.expect.output_includes"));
	const emptyComposite = validateWorkspec("title: T\ndescription: D\nintent: I\nwork:\n  - id: composite\n    task: integrate\n    work: []\n");
	assert.ok(emptyComposite.findings.some((finding) => finding.code === "schema-invalid" && finding.path.join(".") === "work.0.work"));
	const checklistOnly = validateWorkspec("title: T\ndescription: D\nintent: I\nwork:\n  - id: checklist\n    task: complete\n    checklist: [one]\n");
	assert.ok(checklistOnly.findings.some((finding) => finding.code === "schema-required" && finding.path.join(".") === "work.0.acceptance"));
	const emptyChecklist = validateWorkspec(withDraftLineage("title: T\ndescription: D\nintent: I\nwork:\n  - id: checklist\n    task: complete\n    acceptance:\n      - id: A\n        statement: done\n        evidence:\n          kind: command\n          run: printf x\n          expect:\n            exit: 0\n            output_includes: x\n    checklist: []\n"));
	assert.equal(emptyChecklist.valid, true);
	assert.equal(emptyChecklist.structuralValid, true);
});

test("command timeout is optional, bounded to 1s–1h, and never clamped", () => {
	const sourceForTimeout = (timeout?: string): string => withDraftLineage(`title: T\ndescription: D\nintent: I\nwork:\n  - id: command\n    task: run\n    acceptance:\n      - id: A\n        statement: ran\n        evidence:\n          kind: command\n          run: printf ok\n          expect:\n            exit: 0\n            output_includes: ok\n${timeout === undefined ? "" : `          timeout_ms: ${timeout}\n`}`);
	for (const timeout of [undefined, "1000", "30000", "3600000"]) {
		const validated = validateWorkspec(sourceForTimeout(timeout));
		assert.equal(validated.valid, true, String(timeout));
		if (validated.structuralValid) {
			const evidence = validated.spec.work[0]?.acceptance?.[0]?.evidence;
			assert.equal(evidence?.kind === "command" && evidence.timeout_ms, timeout === undefined ? undefined : Number(timeout));
		}
	}
	for (const timeout of ["999", "3600001", "1500.5", "\"30000\"", "null"]) {
		const validated = validateWorkspec(sourceForTimeout(timeout));
		assert.equal(validated.valid, false, timeout);
		assert.ok(validated.findings.some((finding) => finding.code === "schema-invalid" && finding.path.join(".") === "work.0.acceptance.0.evidence.timeout_ms" && finding.message), timeout);
	}
});

test("work and checklist are exclusive and worker is closed", () => {
	const result = validateWorkspec("title: T\ndescription: D\nintent: I\nwork:\n  - id: a\n    task: A\n    checklist: [x]\n    work: []\n    worker:\n      profile: p\n      extra: x\n");
	assert.equal(result.valid, false);
	assert.equal(result.structuralValid, false);
	assert.ok(result.findings.some((finding) => finding.path.join(".") === "work.0.worker.extra"));
	assert.ok(result.findings.some((finding) => finding.path.join(".") === "work.0.checklist"));
	assert.ok(result.findings.some((finding) => finding.path.join(".") === "work.0.work"));
});

test("agent paths reject only statically root-resolving and absolute forms", async () => {
	const sourceForInput = (input: string): string => withDraftLineage(`title: T\ndescription: D\nintent: I\nwork:\n  - id: agent\n    task: inspect\n    acceptance:\n      - id: A\n        statement: inspected\n        evidence:\n          kind: agent\n          agent: reviewer\n          inputs: [${JSON.stringify(input)}]\n          rubric: inspect\n`);
	const root = process.cwd();
	const rootInputs = [".", "./", "foo/..", "./foo/../", "foo/bar/../../"];
	for (const input of rootInputs) {
		assert.equal(nodePath.resolve(root, input), root, input);
		const result = validateWorkspec(sourceForInput(input));
		assert.equal(result.valid, false, input);
		assert.ok(result.findings.some((finding) => finding.code === "schema-invalid" && finding.path.join(".") === "work.0.acceptance.0.evidence.inputs.0"), input);
	}
	const absolute = "/etc/hosts";
	const absoluteResult = validateWorkspec(sourceForInput(absolute));
	assert.equal(absoluteResult.valid, false);
	assert.ok(absoluteResult.findings.some((finding) => finding.code === "schema-invalid" && finding.path.join(".") === "work.0.acceptance.0.evidence.inputs.0"));
	for (const input of ["nested/input.txt", "dir/../file.txt", "../package.json"]) {
		assert.notEqual(nodePath.resolve(root, input), root, input);
		assert.equal(validateWorkspec(sourceForInput(input)).valid, true, input);
	}

	const tree = { kind: "git" as const, worktreePath: root, resolvedCommit: "fixture" };
	for (const input of [absolute, ...rootInputs]) {
		const result = await runAgent({ evidence: { kind: "agent", agent: "reviewer", inputs: [input], rubric: "inspect" }, tree });
		assert.equal(result.outcome, "failed", input);
		if (result.outcome === "failed") assert.equal(result.failures[0]?.code, "input-path-escape", input);
	}
});

test("command exits use the process range while reserved verifier values remain schema-valid", () => {
	const sourceForExit = (exit: number): string => withDraftLineage(`title: T\ndescription: D\nintent: I\nwork:\n  - id: command\n    task: run\n    acceptance:\n      - id: A\n        statement: ran\n        evidence:\n          kind: command\n          run: printf x\n          expect:\n            exit: ${exit}\n            output_includes: x\n`);
	for (const exit of [0, 255, 126, 127, 129, 130, 131, 134, 137, 141, 143]) {
		assert.equal(validateWorkspec(sourceForExit(exit)).valid, true, String(exit));
	}
	for (const exit of [-1, 256, 300]) {
		const result = validateWorkspec(sourceForExit(exit));
		assert.equal(result.valid, false, String(exit));
		assert.ok(result.findings.some((finding) => finding.code === "schema-invalid" && finding.path.join(".") === "work.0.acceptance.0.evidence.expect.exit"), String(exit));
	}
});

test("structural validity is distinct from semantic validity", () => {
	const invalidStructure = validateWorkspec("title: T\ndescription: D\nintent: I\nwork:\n  - id: a\n    task: A\n    acceptance:\n      - id: C\n        statement: S\n        evidence:\n          kind: command\n          run: echo\n          expect:\n            output_includes: x\n");
	assert.equal(invalidStructure.structuralValid, false);
	assert.equal("spec" in invalidStructure, false);
	if (invalidStructure.structuralValid) throw new Error("unexpected structural validity");
	assert.equal(typeof invalidStructure.value, "object");

	const semanticErrors = validateWorkspec(withDraftLineage("title: T\ndescription: D\nintent: I\nwork:\n  - id: a\n    task: A\n    acceptance:\n      - id: A\n        statement: A is green\n        evidence:\n          kind: command\n          run: printf a\n          expect:\n            exit: 0\n            output_includes: a\n  - id: a\n    task: B\n    acceptance:\n      - id: B\n        statement: B is green\n        evidence:\n          kind: command\n          run: printf b\n          expect:\n            exit: 0\n            output_includes: b\n"));
	assert.equal(semanticErrors.structuralValid, true);
	assert.equal(semanticErrors.valid, false);
	if (!semanticErrors.structuralValid) throw new Error("expected a valid structure");
	assert.equal(semanticErrors.spec.work[0].id, "a");
});
