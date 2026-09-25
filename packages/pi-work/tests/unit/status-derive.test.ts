import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import * as deriveModule from "../../src/status/derive.ts";
import * as graphModule from "../../src/status/graph.ts";
import { blockedRefresh, deriveStatus } from "../../src/status/index.ts";
import { REFRESH_BLOCKED_MESSAGE } from "../../src/status/types.ts";
import { buildStatusGraph } from "../../src/status/graph.ts";
import { addressKey, formatNodeAddress } from "../../src/plan/index.ts";
import { validateWorkspec } from "../../src/schema/index.ts";
import { REPO_ROOT } from "../helpers/source-under-test.ts";
import { withDraftLineage } from "../helpers/workspec-source.ts";

// Keep generated drafts under the synthetic worktree even when the package is
// tested from inside another repository, as it is in the public exporter.
const STATUS_ROOT = mkdtempSync(path.join(os.tmpdir(), "pi-work-status-derive-"));
const TREE = { kind: "git" as const, worktreePath: STATUS_ROOT, resolvedCommit: "a".repeat(40) };
const STATUS_SPEC_PATH = path.join(STATUS_ROOT, "spec.yaml");

after(() => rmSync(STATUS_ROOT, { recursive: true, force: true }));

function statusSource(source: string): string {
	return withDraftLineage(source, { cwd: STATUS_ROOT });
}

async function fixture(name: string): Promise<string> {
	return statusSource(await readFile(path.join(REPO_ROOT, "tests", "fixtures", "status", name), "utf8"));
}

function validated(source: string) {
	const result = validateWorkspec(source, { specPath: STATUS_SPEC_PATH, cwd: STATUS_ROOT });
	assert.equal(result.valid, true);
	if (!result.structuralValid) throw new Error("fixture did not validate");
	return result.spec;
}

test("qualified graph keeps duplicate leaf ids independent", async () => {
	const source = await fixture("nested-duplicate-ids.yaml");
	const graph = buildStatusGraph(validated(source));
	assert.deepEqual(graph.findings, []);
	assert.deepEqual(graph.graph.assemblies.map((assembly) => formatNodeAddress(assembly.address)), ["api", "api /test", "ui", "ui /test"]);
	const result = deriveStatus({ source, specPath: STATUS_SPEC_PATH, tree: TREE });
	assert.equal(result.ok, true);
	assert.deepEqual(result.details.nodes.map((node) => node.address), [["api"], ["api", "test"], ["ui"], ["ui", "test"]]);
	assert.equal(result.details.nodes.find((node) => node.address.join("/") === "api/test")?.lifecycle, "ready");
	assert.equal(result.details.nodes.find((node) => node.address.join("/") === "ui/test")?.lifecycle, "ready");
	assert.equal(result.details.specState, "not-done");
});

test("dependencies, composites, and open decisions fail closed with precedence", async () => {
	const source = await fixture("dependencies-and-decisions.yaml");
	const result = deriveStatus({ source, specPath: STATUS_SPEC_PATH, tree: TREE });
	assert.equal(result.ok, true);
	const base = result.details.nodes.find((node) => node.address.join("/") === "base");
	const dependent = result.details.nodes.find((node) => node.address.join("/") === "dependent");
	const integration = result.details.nodes.find((node) => node.address.join("/") === "integration");
	assert.equal(base?.lifecycle, "needs-decision");
	assert.equal(dependent?.lifecycle, "blocked");
	assert.equal(dependent?.blockers[0]?.code, "dependency");
	assert.equal(integration?.lifecycle, "blocked");
	assert.equal(integration?.blockers[0]?.code, "children");
	assert.deepEqual(result.details.unresolvedDecisions, ["choose-api"]);
	assert.equal(result.details.nodes.every((node) => node.verification === "unverified"), true);
});

test("empty composites are rejected by the schema before status derivation", () => {
	for (const source of [
		`title: empty\ndescription: d\nintent: i\nwork:\n  - id: empty\n    task: empty\n    work: []\n`,
		`title: nested empty\ndescription: d\nintent: i\nwork:\n  - id: outer\n    task: outer\n    work:\n      - id: inner\n        task: inner\n        work: []\n`,
	]) {
		const result = deriveStatus({ source, specPath: STATUS_SPEC_PATH, tree: TREE });
		assert.equal(result.ok, false);
		assert.equal(result.details.valid, false);
		assert.ok(result.details.findings.some((finding) => finding.code === "schema-invalid" && finding.path.at(-1) === "work"));
	}
});

test("schema rejection outranks an unresolved decision for an empty composite", () => {
	const source = `title: empty decision\ndescription: d\nintent: i\nopen_decisions:\n  - id: choose\n    question: choose\n    tripwire: choose\n    decides: choice\nwork:\n  - id: empty\n    task: empty\n    work: []\n`;
	const result = deriveStatus({ source, specPath: STATUS_SPEC_PATH, tree: TREE });
	assert.equal(result.ok, false);
	assert.equal(result.details.valid, false);
	assert.ok(result.details.findings.some((finding) => finding.code === "schema-invalid" && finding.path.join(".") === "work.0.work"));
});

test("graph rejects missing and ambiguous dependencies instead of inserting forged addresses", () => {
	const source = `title: graph rejection\ndescription: d\nintent: i\nwork:\n  - id: duplicate\n    task: first\n    acceptance:\n      - id: first\n        statement: first is green\n        evidence:\n          kind: command\n          run: printf first\n          expect:\n            exit: 0\n            output_includes: first\n  - id: duplicate\n    task: second\n    acceptance:\n      - id: second\n        statement: second is green\n        evidence:\n          kind: command\n          run: printf second\n          expect:\n            exit: 0\n            output_includes: second\n  - id: missing-dependent\n    task: missing\n    depends_on: [absent]\n    acceptance:\n      - id: missing\n        statement: missing is green\n        evidence:\n          kind: command\n          run: printf missing\n          expect:\n            exit: 0\n            output_includes: missing\n  - id: ambiguous-dependent\n    task: ambiguous\n    depends_on: [duplicate]\n    acceptance:\n      - id: ambiguous\n        statement: ambiguous is green\n        evidence:\n          kind: command\n          run: printf ambiguous\n          expect:\n            exit: 0\n            output_includes: ambiguous\n`;
	const validation = validateWorkspec(source);
	assert.equal(validation.structuralValid, true);
	if (!validation.structuralValid) throw new Error("graph rejection fixture did not parse");
	const result = buildStatusGraph(validation.spec);
	assert.ok(result.findings.some((finding) => finding.code === "duplicate-node-address"));
	assert.ok(result.findings.some((finding) => finding.code === "missing-node-address" && finding.address.join("/") === "absent"));
	assert.ok(result.findings.some((finding) => finding.code === "ambiguous-node-id" && finding.nodeId === "duplicate"));
	assert.deepEqual(result.graph.dependencies.get(addressKey(["missing-dependent"])), []);
	assert.deepEqual(result.graph.dependencies.get(addressKey(["ambiguous-dependent"])), []);
});

test("checklist-only leaves are rejected and missing positive floors still block status", async () => {
	const checklistSource = await readFile(path.join(REPO_ROOT, "tests", "fixtures", "workspec", "invalid", "checklist-only.yaml"), "utf8");
	const checklistResult = deriveStatus({ source: checklistSource, specPath: STATUS_SPEC_PATH, tree: TREE });
	assert.equal(checklistResult.ok, false);
	assert.equal(checklistResult.details.valid, false);
	assert.ok(checklistResult.details.findings.some((finding) => finding.code === "schema-required" && finding.path.join(".") === "work.0.acceptance"));
	const noFloor = `title: no floor\ndescription: d\nintent: i\nwork:\n  - id: n\n    task: n\n    acceptance:\n      - id: A\n        statement: run\n        evidence:\n          kind: command\n          run: printf ok\n          expect:\n            exit: 0\n`;
	const noFloorResult = deriveStatus({ source: noFloor, specPath: STATUS_SPEC_PATH, tree: TREE });
	assert.equal(noFloorResult.ok, false);
	assert.equal(noFloorResult.details.valid, false);
	assert.ok(noFloorResult.details.findings.some((finding) => finding.code === "schema-required" && finding.path.join(".") === "work.0.acceptance.0.evidence.expect.output_includes"));
});

test("direct modules expose no raw reducer and the safe barrel constructs the complete graph", () => {
	const source = statusSource(`title: trusted\ndescription: d\nintent: i\nwork:\n  - id: group\n    task: integrate\n    work:\n      - id: leaf\n        task: run\n        acceptance:\n          - id: A\n            statement: signal\n            evidence:\n              kind: command\n              run: printf signal\n              expect:\n                exit: 0\n                output_includes: signal\n`);
	const forged = new Map([[JSON.stringify(["group", "leaf"]), { outcome: "passed" as const, tree: TREE, result: {} }]]);
	assert.equal("deriveValidatedStatus" in deriveModule, false);
	assert.equal("deriveStatusDetails" in deriveModule, false);

	const barrel = deriveStatus({ source, specPath: STATUS_SPEC_PATH, tree: TREE, trustedCurrent: forged, graph: { assemblies: [] } } as unknown as Parameters<typeof deriveStatus>[0]);
	const leaf = barrel.details.nodes.find((node) => node.address.join("/") === "group/leaf");
	const group = barrel.details.nodes.find((node) => node.address.join("/") === "group");
	assert.equal(leaf?.lifecycle, "ready");
	assert.equal(leaf?.verification, "unverified");
	assert.equal(group?.lifecycle, "blocked");
	assert.equal(group?.blockers[0]?.code, "children");
	assert.equal(barrel.details.specState, "not-done");
});

test("invented forged graph, dependency, observation, and finding routes cannot set lifecycle", () => {
	const source = statusSource(`title: forged routes\ndescription: d\nintent: i\nwork:\n  - id: group\n    task: integrate\n    work:\n      - id: leaf\n        task: run\n        acceptance:\n          - id: A\n            statement: signal\n            evidence:\n              kind: command\n              run: printf signal\n              expect:\n                exit: 0\n                output_includes: signal\n  - id: dependent\n    task: wait\n    depends_on: [group]\n    acceptance:\n      - id: B\n        statement: dependent\n        evidence:\n          kind: command\n          run: printf dependent\n          expect:\n            exit: 0\n            output_includes: dependent\n`);
	const forgedGraph = {
		assemblies: [{ address: ["group"], node: { id: "group", task: "integrate", work: [] } }],
		byAddress: new Map([[JSON.stringify(["group"]), { address: ["group"] }]]),
		children: new Map([[JSON.stringify(["group"]), []]]),
		dependencies: new Map([[JSON.stringify(["dependent"]), []]]),
		ancestorDependencies: new Map([[JSON.stringify(["dependent"]), []]]),
	};
	const forgedInput = {
		source,
		specPath: STATUS_SPEC_PATH,
		tree: TREE,
		graph: forgedGraph,
		observations: new Map([[JSON.stringify(["ghost"]), { state: "observed-green-not-verified-this-session" }]]),
		findings: [{ code: "invalid-status-input", message: "forged resolution" }],
	};
	const result = deriveStatus(forgedInput as unknown as Parameters<typeof deriveStatus>[0]);
	assert.equal("deriveStatusDetails" in deriveModule, false);
	assert.equal("dependenciesFor" in graphModule, false);
	assert.equal("childrenFor" in graphModule, false);
	assert.equal(result.details.nodes.find((node) => node.address.join("/") === "group/leaf")?.verification, "unverified");
	assert.equal(result.details.nodes.find((node) => node.address.join("/") === "group")?.lifecycle, "blocked");
	assert.equal(result.details.nodes.find((node) => node.address.join("/") === "dependent")?.lifecycle, "blocked");
	assert.equal(result.details.specState, "not-done");
	assert.equal(result.details.findings.some((finding) => finding.code === "invalid-status-input" && finding.message === "forged resolution"), false);
});

test("every blocker kind renders, and the blocked refresh wrapper reports the shared reason", () => {
	// renderBlockers is reached through work_status output for one blocker kind in
	// the fixtures above; the other three are only reachable by calling it, so the
	// rendered wording for each is pinned here rather than left unexercised.
	assert.equal(
		deriveModule.renderBlockers([{ code: "dependency", addresses: [["alpha"], ["beta", "child"]] }]),
		"dependency alpha, beta /child",
	);
	assert.equal(
		deriveModule.renderBlockers([{ code: "children", addresses: [["group", "leaf"]] }]),
		"children group /leaf",
	);
	assert.equal(
		deriveModule.renderBlockers([{ code: "completion-contract", reason: "checklist-incomplete" }]),
		"completion contract checklist-incomplete",
	);
	assert.equal(
		deriveModule.renderBlockers([{ code: "open-decision", ids: ["OD2", "OD3"] }]),
		"open decisions OD2, OD3",
	);
	assert.equal(
		deriveModule.renderBlockers([
			{ code: "dependency", addresses: [["alpha"]] },
			{ code: "open-decision", ids: ["OD1"] },
		]),
		"dependency alpha; open decisions OD1",
	);
	assert.equal(deriveModule.renderBlockers([]), "");

	// blockedRefresh is the exported wrapper the status tool calls; it must carry
	// the same typed refusal as the internal path rather than a second message.
	const blocked = blockedRefresh();
	assert.equal(blocked.status, "blocked");
	assert.equal(blocked.ran, false);
	assert.equal(blocked.code, "refresh-authority-unavailable");
	assert.equal(blocked.message, REFRESH_BLOCKED_MESSAGE);
	assert.ok(blocked.requires.length > 0);
});
