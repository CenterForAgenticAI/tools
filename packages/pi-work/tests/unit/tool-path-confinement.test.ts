import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import piWork from "../../src/index.ts";
import { REFRESH_BLOCKED_MESSAGE } from "../../src/status/types.ts";

const execFileAsync = promisify(execFile);
const ABSOLUTE_PATHS = ["/tmp/nope.yaml", "//etc/x", "\\etc\\x", "C:\\etc\\x"] as const;
const EXPECTED_PATH_SURFACE = [
	"work_amend_criterion.path",
	"work_dispatch.path",
	"work_dispatch.worktreePath",
	"work_plan.path",
	"work_promote.draftPath",
	"work_promote.specPath",
	"work_status.path",
	"work_status.worktreePath",
	"work_validate.path",
	"work_verify.path",
	"work_verify.worktreePath",
] as const;

interface FindingLike {
	readonly code: string;
	readonly severity?: string;
	readonly path?: readonly (string | number)[];
	readonly message?: string;
	readonly suppliedPath?: string;
}

interface ToolResult {
	readonly content: readonly { readonly type: string; readonly text?: string }[];
	readonly details: Record<string, unknown> & {
		readonly findings?: readonly FindingLike[];
		readonly failure?: { readonly code: string; readonly message: string };
	};
}

interface RegisteredTool {
	readonly name: string;
	readonly parameters: { readonly properties?: Record<string, { readonly type?: string }> };
	execute(...args: unknown[]): Promise<ToolResult>;
}

interface ConfinedPathCase {
	readonly toolName: string;
	readonly parameter: "path" | "draftPath" | "specPath";
}

const CONFINED_PATH_CASES: readonly ConfinedPathCase[] = [
	{ toolName: "work_validate", parameter: "path" },
	{ toolName: "work_promote", parameter: "draftPath" },
	{ toolName: "work_promote", parameter: "specPath" },
	{ toolName: "work_amend_criterion", parameter: "path" },
	{ toolName: "work_plan", parameter: "path" },
	{ toolName: "work_dispatch", parameter: "path" },
	{ toolName: "work_status", parameter: "path" },
	{ toolName: "work_verify", parameter: "path" },
];

function registeredTools(): Map<string, RegisteredTool> {
	const tools = new Map<string, RegisteredTool>();
	piWork({
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool as unknown as RegisteredTool);
		},
		registerCommand() {},
	} as unknown as ExtensionAPI);
	return tools;
}

function pathSurface(tools: ReadonlyMap<string, RegisteredTool>): string[] {
	return [...tools.values()]
		.flatMap((tool) => Object.entries(tool.parameters.properties ?? {})
			.filter(([name, schema]) => schema.type === "string" && (name === "path" || name.endsWith("Path")))
			.map(([name]) => `${tool.name}.${name}`))
		.sort();
}

function paramsFor(toolName: string, parameter: ConfinedPathCase["parameter"], suppliedPath: string): Record<string, unknown> {
	const params: Record<string, Record<string, unknown>> = {
		work_validate: { path: "spec.yaml" },
		work_promote: { draftPath: "draft.md", specPath: "spec.yaml" },
		work_amend_criterion: { path: "spec.yaml", criterionId: "A1", before: "before", after: "after", reason: "test", authority: "test" },
		work_plan: { path: "spec.yaml", nodeAddresses: [["node"]] },
		work_dispatch: { path: "spec.yaml", nodeAddress: ["node"], worktreePath: "/target/worktree", expectedCommit: "f".repeat(40) },
		work_status: { path: "spec.yaml", worktreePath: "/target/worktree", expectedCommit: "f".repeat(40) },
		work_verify: { path: "spec.yaml", nodeId: "node", worktreePath: "/target/worktree", expectedCommit: "f".repeat(40) },
	};
	return { ...params[toolName], [parameter]: suppliedPath };
}

function confinementMessage(suppliedPath: string): string {
	return `tool paths are confined to the working directory; absolute paths are not allowed: ${JSON.stringify(suppliedPath)}`;
}

function expectedRendered(toolName: string, parameter: ConfinedPathCase["parameter"], suppliedPath: string): string {
	const message = confinementMessage(suppliedPath);
	const finding = `error absolute-path at $.${parameter}: ${message}`;
	switch (toolName) {
		case "work_validate":
			return `invalid: 1 error(s), 0 warning(s)\n${finding}`;
		case "work_promote":
			return `not promoted: 1 error(s), 0 warning(s)\n${finding}`;
		case "work_amend_criterion":
			return `not amended: absolute-path: ${message}\n${finding}`;
		case "work_plan":
			return `invalid: 1 error(s), 0 warning(s), 0 plan(s), 0 advisory(s)\nreadiness: work_plan is not the readiness authority; use work_status before execution\n${finding}`;
		case "work_dispatch":
			return `rejected: node\ntree: /target/worktree@${"f".repeat(40)}\n${finding}`;
		case "work_status":
			return `not-done: 0 node(s)\nspec: ${suppliedPath}\ncache: \n${finding}\nrefresh: blocked — ${REFRESH_BLOCKED_MESSAGE}`;
		case "work_verify":
			return `failed: node node\ntree: /target/worktree@${"f".repeat(40)}\n${finding}`;
		default:
			throw new Error(`missing rendered expectation for ${toolName}`);
	}
}

async function invoke(tools: ReadonlyMap<string, RegisteredTool>, toolName: string, params: Record<string, unknown>, cwd: string): Promise<ToolResult> {
	const tool = tools.get(toolName);
	assert.ok(tool, `${toolName} must be registered`);
	return tool.execute("test", params, undefined, undefined, { cwd });
}

function assertNoAbsolutePathFinding(result: ToolResult): void {
	assert.equal(result.details.findings?.some((finding) => finding.code === "absolute-path"), false);
}

test("the registered path inventory covers every top-level path-shaped string parameter", () => {
	assert.deepEqual(pathSurface(registeredTools()), EXPECTED_PATH_SURFACE, "classify and test every path-shaped parameter when the registered tool surface changes");
});

test("every spec-path parameter rejects unprefixed absolute paths through one confinement rule", async () => {
	const tools = registeredTools();
	assert.deepEqual(CONFINED_PATH_CASES.map(({ toolName, parameter }) => `${toolName}.${parameter}`).sort(), [
		"work_amend_criterion.path",
		"work_dispatch.path",
		"work_plan.path",
		"work_promote.draftPath",
		"work_promote.specPath",
		"work_status.path",
		"work_validate.path",
		"work_verify.path",
	]);

	for (const { toolName, parameter } of CONFINED_PATH_CASES) {
		for (const suppliedPath of ABSOLUTE_PATHS) {
			const result = await invoke(tools, toolName, paramsFor(toolName, parameter, suppliedPath), "/caller/worktree");
			const message = confinementMessage(suppliedPath);
			assert.deepEqual(result.details.findings, [{
				code: "absolute-path",
				severity: "error",
				path: [parameter],
				message,
				suppliedPath,
			}], `${toolName}.${parameter} must return the shared typed finding for ${JSON.stringify(suppliedPath)}`);
			assert.equal(result.content[0]?.text, expectedRendered(toolName, parameter, suppliedPath));
			assert.equal(result.content[0]?.text?.includes(JSON.stringify(suppliedPath)), true, `${toolName}.${parameter} must render the caller-supplied path without normalization`);
		}
	}
});

test("every path-taking tool keeps @/ paths relative to the working directory", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-work-tool-paths-"));
	try {
		await writeFile(path.join(root, "draft.md"), "## Acceptance criteria <!-- work:criteria -->\n\n- A1: It works\n");
		await writeFile(path.join(root, ".gitignore"), ".work/.cache/\n");
		await execFileAsync("git", ["init", "-q", "-b", "fixture"], { cwd: root, timeout: 5000 });
		await execFileAsync("git", ["add", "."], { cwd: root, timeout: 5000 });
		await execFileAsync("git", ["-c", "user.name=pi-work", "-c", "user.email=pi-work@example.invalid", "commit", "-qm", "fixture"], { cwd: root, timeout: 5000 });
		const commit = (await execFileAsync("git", ["rev-parse", "HEAD^{commit}"], { cwd: root, timeout: 5000 })).stdout.trim();
		const tools = registeredTools();

		const validated = await invoke(tools, "work_validate", { path: "@/missing.yaml" }, root);
		assertNoAbsolutePathFinding(validated);
		assert.equal(validated.details.findings?.[0]?.code, "read-error");
		assert.equal(validated.details.path, path.join(root, "missing.yaml"));

		const promotedDraft = await invoke(tools, "work_promote", { draftPath: "@/missing.md", specPath: "spec.yaml" }, root);
		assertNoAbsolutePathFinding(promotedDraft);
		assert.equal(promotedDraft.details.findings?.[0]?.code, "read-error");
		assert.equal(promotedDraft.details.draftPath, path.join(root, "missing.md"));

		const promotedSpec = await invoke(tools, "work_promote", { draftPath: "draft.md", specPath: "@/missing/spec.yaml" }, root);
		assertNoAbsolutePathFinding(promotedSpec);
		assert.equal(promotedSpec.details.findings?.at(-1)?.code, "write-error");
		assert.equal(promotedSpec.details.specPath, path.join(root, "missing", "spec.yaml"));

		const amended = await invoke(tools, "work_amend_criterion", paramsFor("work_amend_criterion", "path", "@/missing.yaml"), root);
		assertNoAbsolutePathFinding(amended);
		assert.equal(amended.details.failure?.code, "read-error");
		assert.equal(amended.details.path, path.join(root, "missing.yaml"));

		const planned = await invoke(tools, "work_plan", paramsFor("work_plan", "path", "@/missing.yaml"), root);
		assertNoAbsolutePathFinding(planned);
		assert.equal(planned.details.findings?.[0]?.code, "read-error");
		assert.equal(planned.details.path, path.join(root, "missing.yaml"));

		const dispatched = await invoke(tools, "work_dispatch", {
			...paramsFor("work_dispatch", "path", "@/missing.yaml"),
			worktreePath: root,
			expectedCommit: commit,
		}, root);
		assertNoAbsolutePathFinding(dispatched);
		assert.equal(dispatched.details.findings?.[0]?.code, "dispatch-spec-read-error");
		assert.match(dispatched.content[0]?.text ?? "", new RegExp(`realpath '${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/missing\\.yaml'`));

		// Both tools resolve @/ against the target tree rather than refusing it, and the
		// path they report is the resolved one rather than the supplied prefix form.
		const statused = await invoke(tools, "work_status", { path: "@/missing.yaml", worktreePath: root, expectedCommit: commit }, root);
		assertNoAbsolutePathFinding(statused);
		assert.equal(statused.details.findings?.[0]?.code, "spec-read-error");
		assert.match(statused.content[0]?.text ?? "", /missing\.yaml/);

		const verified = await invoke(tools, "work_verify", { path: "@/missing.yaml", nodeId: "node", worktreePath: root, expectedCommit: commit }, root);
		assertNoAbsolutePathFinding(verified);
		assert.equal(verified.details.findings?.[0]?.code, "read-error");
		// work_verify renders a read-error without its message, so the resolved path is
		// asserted on the typed finding rather than the rendered text.
		assert.match(verified.details.findings?.[0]?.message ?? "", new RegExp(`realpath '${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/missing\\.yaml'`));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
