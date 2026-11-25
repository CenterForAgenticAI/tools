import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectRootFromCwd } from "../src/platform/project-root.js";
import { removeFixtureDir } from "./fixture-cleanup.js";

test("project-root walk matches git for roots, nested directories, linked worktrees and submodules", async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "project-root-walk-")));
	const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	try {
		const repo = path.join(root, "repo");
		git("init", "-q", repo);
		git("-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
		const linked = path.join(root, "linked");
		git("-C", repo, "worktree", "add", "--detach", linked);
		const submodule = path.join(repo, "sub");
		git("-C", repo, "-c", "protocol.file.allow=always", "submodule", "add", repo, submodule);
		const nested = path.join(repo, "a", "b");
		const linkedNested = path.join(linked, "nested");
		for (const cwd of [nested, linkedNested]) fs.mkdirSync(cwd, { recursive: true });
		for (const cwd of [repo, nested, linked, linkedNested, submodule]) {
			assert.equal(projectRootFromCwd(cwd), git("-C", cwd, "rev-parse", "--show-toplevel"), cwd);
		}
		assert.equal(projectRootFromCwd(root), root, "non-git cwd is its own config root");
		assert.equal(projectRootFromCwd(path.join(root, "missing")), null);
	} finally {
		await removeFixtureDir(root);
	}
});
