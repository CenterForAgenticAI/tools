import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { sourceModuleUrl } from "../helpers/source-under-test.ts";
import { withDraftLineage } from "../helpers/workspec-source.ts";

const execFileAsync = promisify(execFile);

async function fixtureRepo(): Promise<{ root: string; commit: string }> {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-work-extension-host-"));
	await writeFile(path.join(root, "spec.yaml"), withDraftLineage(`title: Host\ndescription: d\nintent: i\nwork:\n  - id: node\n    task: confirm\n    acceptance:\n      - id: U\n        statement: confirmation\n        evidence:\n          kind: user\n          prompt: confirm this result\n`, { cwd: root }));
	await execFileAsync("git", ["init", "-q"], { cwd: root });
	await execFileAsync("git", ["add", "-f", "spec.yaml", ".test-dist"], { cwd: root });
	await execFileAsync("git", ["-c", "user.name=pi-work", "-c", "user.email=pi-work@example.invalid", "commit", "-qm", "fixture"], { cwd: root });
	const commit = (await execFileAsync("git", ["rev-parse", "HEAD^{commit}"], { cwd: root })).stdout.trim();
	return { root, commit };
}

test("registered work_verify receives host UI and session capabilities and fails closed without them", async () => {
	const extension = (await import(sourceModuleUrl("index"))).default as (pi: ExtensionAPI) => void;
	let verify: ToolDefinition | undefined;
	const pi = {
		registerTool(tool: ToolDefinition) {
			if (tool.name === "work_verify") verify = tool;
		},
		registerCommand() {},
	} as unknown as ExtensionAPI;
	extension(pi);
	assert.ok(verify);

	const repo = await fixtureRepo();
	try {
		const confirmations: string[] = [];
		const sessionManager = {
			getSessionId: () => "session-1",
			getSessionFile: () => undefined,
			getBranch: () => [],
		};
		const passed = await verify.execute("host", { path: "spec.yaml", nodeId: "node", worktreePath: repo.root, expectedCommit: repo.commit }, undefined, undefined, {
			hasUI: true,
			ui: { confirm: async (_title: string, message: string) => { confirmations.push(message); return true; } },
			sessionManager,
		} as never);
		assert.equal((passed.details as { outcome: string }).outcome, "passed");
		assert.equal(confirmations.length, 1);
		assert.match(confirmations[0]!, /I confirm [a-f0-9]{32}/);

		const closed = await verify.execute("closed", { path: "spec.yaml", nodeId: "node", worktreePath: repo.root, expectedCommit: repo.commit }, undefined, undefined, {
			hasUI: false,
			ui: {},
			sessionManager: undefined,
		} as never);
		const details = closed.details as { outcome: string; failures: { code: string }[] };
		assert.equal(details.outcome, "failed");
		assert.equal(details.failures[0]?.code, "session-unavailable");
	} finally {
		await rm(repo.root, { recursive: true, force: true });
	}
});
