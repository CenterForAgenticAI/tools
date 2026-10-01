import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rm, chmod, mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { removeTempTree } from "../helpers/temp-tree.ts";

import { inspectTree, monitorTree, resolveSpecPath, verifyTreeUnchanged } from "../../src/verify/tree.ts";
import { runCommand } from "../../src/verify/command.ts";
import { deterministicCommandOptions } from "../helpers/verifier-command.ts";

const execFileAsync = promisify(execFile);

async function repo(): Promise<{ root: string; commit: string }> {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-work-tree-"));
	await writeFile(path.join(root, "tracked"), "one\n");
	const git = (args: string[]) => execFileAsync("git", args, { cwd: root, timeout: 5000 });
	await git(["init", "-q"]);
	await git(["add", "tracked"]);
	await git(["-c", "user.name=pi-work", "-c", "user.email=pi-work@example.invalid", "commit", "-qm", "one"]);
	const commit = (await git(["rev-parse", "HEAD^{commit}"])).stdout.trim();
	return { root, commit };
}

test("tree identity rejects missing, non-repository, nested, and mismatched targets", async () => {
	assert.equal((await inspectTree("", "")).ok, false);
	assert.equal(resolveSpecPath("/tmp/work", "@/spec.yaml"), "/tmp/work/spec.yaml");
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-work-not-repo-"));
	assert.equal((await inspectTree(directory, "a".repeat(40))).ok, false);
	const fixture = await repo();
	assert.equal((await inspectTree(path.join(fixture.root, "tracked"), fixture.commit)).ok, false);
	await mkdir(path.join(fixture.root, "nested"));
	const nested = await inspectTree(path.join(fixture.root, "nested"), fixture.commit);
	assert.equal(nested.ok, false);
	if (!nested.ok) assert.equal(nested.failure.code, "tree-identity-unavailable");
	await execFileAsync("git", ["-c", "user.name=pi-work", "-c", "user.email=pi-work@example.invalid", "commit", "--allow-empty", "-qm", "two"], { cwd: fixture.root, timeout: 5000 });
	const mismatch = await inspectTree(fixture.root, fixture.commit);
	assert.equal(mismatch.ok, false);
	if (!mismatch.ok) assert.equal(mismatch.failure.code, "tree-mismatch");
	await removeTempTree(directory);
	await removeTempTree(fixture.root);
});

test("tree inspection does not execute repo-local fsmonitor", async () => {
	const fixture = await repo();
	const marker = path.join(fixture.root, "fsmonitor-ran");
	const monitor = path.join(fixture.root, "fsmonitor.sh");
	try {
		await writeFile(monitor, '#!/bin/sh\nprintf ran > ' + JSON.stringify(marker) + '\n');
		await chmod(monitor, 0o755);
		await execFileAsync("git", ["config", "--local", "core.fsmonitor", monitor], { cwd: fixture.root });
		const inspected = await inspectTree(fixture.root, fixture.commit, { allowUntracked: true });
		assert.equal(inspected.ok, true);
		await assert.rejects(readFile(marker, "utf8"), { code: "ENOENT" });
	} finally {
		await removeTempTree(fixture.root);
	}
});

test("tree inspection refuses a repo-local clean filter before it can run", async () => {
	const fixture = await repo();
	const marker = path.join(fixture.root, "filter-ran");
	const filter = path.join(fixture.root, "filter.sh");
	try {
		await writeFile(filter, '#!/bin/sh\nprintf ran > ' + JSON.stringify(marker) + '\ncat\n');
		await chmod(filter, 0o755);
		await writeFile(path.join(fixture.root, ".gitattributes"), "tracked filter=attack\n");
		await execFileAsync("git", ["add", ".gitattributes"], { cwd: fixture.root });
		await execFileAsync("git", ["-c", "user.name=pi-work", "-c", "user.email=pi-work@example.invalid", "commit", "-qm", "attributes"], { cwd: fixture.root });
		const commit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: fixture.root })).stdout.trim();
		await execFileAsync("git", ["config", "--local", "filter.attack.clean", filter], { cwd: fixture.root });
		const inspected = await inspectTree(fixture.root, commit, { allowUntracked: true });
		assert.equal(inspected.ok, false);
		if (!inspected.ok) assert.match(inspected.failure.message, /repository-local Git filters/);
		await assert.rejects(readFile(marker, "utf8"), { code: "ENOENT" });
	} finally { await removeTempTree(fixture.root); }
});

test("tree monitor launches git from the selected worktree", async () => {
	const fixture = await repo();
	const canonicalRoot = await realpath(fixture.root);
	const observedCwdPath = path.join(canonicalRoot, "observed-cwd");
	const fakeGitPath = path.join(canonicalRoot, "fake-git.mjs");
	await writeFile(fakeGitPath, `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(observedCwdPath)}, process.cwd());\nprocess.stdout.write("tracked\\0");\n`);
	await chmod(fakeGitPath, 0o755);
	const monitor = await monitorTree({ identity: { kind: "git", worktreePath: canonicalRoot, resolvedCommit: fixture.commit }, clean: true, gitPath: fakeGitPath });
	assert.equal(monitor.ok, true);
	if (monitor.ok) monitor.stop();
	assert.equal(await readFile(observedCwdPath, "utf8"), canonicalRoot);
	await removeTempTree(fixture.root);
});

test("tree monitor streams tracked manifests larger than the former fixed buffer", async () => {
	const fixture = await repo();
	const fakeGitPath = path.join(fixture.root, "fake-large-git.mjs");
	await writeFile(fakeGitPath, `#!${process.execPath}\nfor (let index = 0; index < 5_000; index += 1) process.stdout.write(\`tracked-\${index.toString().padStart(5, "0")}-\${"x".repeat(48)}\\0\`);\n`);
	await chmod(fakeGitPath, 0o755);
	const monitor = await monitorTree({ identity: { kind: "git", worktreePath: fixture.root, resolvedCommit: fixture.commit }, clean: true, gitPath: fakeGitPath });
	assert.equal(monitor.ok, true);
	if (monitor.ok) monitor.stop();
	await removeTempTree(fixture.root);
});

test("tree identity streams status output larger than the former fixed buffer", async () => {
	const fixture = await repo();
	const untrackedDirectory = path.join(fixture.root, "untracked");
	await mkdir(untrackedDirectory);
	await Promise.all(Array.from({ length: 3_000 }, (_, index) => writeFile(path.join(untrackedDirectory, `${index.toString().padStart(4, "0")}-${"x".repeat(80)}`), "")));
	const checked = await inspectTree(fixture.root, fixture.commit);
	assert.equal(checked.ok, false);
	if (!checked.ok) {
		assert.equal(checked.failure.code, "tree-dirty");
		assert.match(checked.failure.message, /untracked\/0000-/);
		assert.match(checked.failure.message, /2990 more; 3000 total/);
		assert.ok(checked.failure.message.length < 1400);
	}
	await removeTempTree(fixture.root);
});

test("tree identity is canonical, explicit, and clean", async () => {
	const fixture = await repo();
	const checked = await inspectTree(fixture.root, fixture.commit);
	assert.equal(checked.ok, true);
	if (checked.ok) {
		assert.equal(checked.snapshot.identity.resolvedCommit, fixture.commit);
		const unchanged = await verifyTreeUnchanged(checked.snapshot);
		assert.equal(unchanged.ok, true);
		const alias = `${fixture.root}-alias`;
		await symlink(fixture.root, alias);
		const aliased = await verifyTreeUnchanged({ identity: { kind: "git", worktreePath: alias, resolvedCommit: fixture.commit }, clean: true, gitPath: checked.snapshot.gitPath });
		assert.equal(aliased.ok, false);
		if (!aliased.ok) assert.equal(aliased.failure.code, "tree-changed");
		await rm(alias, { force: true });
	}
	const nested = await inspectTree(path.join(fixture.root, "missing"), fixture.commit);
	assert.equal(nested.ok, false);
	await removeTempTree(fixture.root);
});

test("command cwd follows the selected tree when two repositories differ", async () => {
	const first = await repo();
	const second = await repo();
	await writeFile(path.join(first.root, "tracked"), "first\n");
	await writeFile(path.join(second.root, "tracked"), "second\n");
	const firstResult = await runCommand({ evidence: { kind: "command", run: "cat tracked", expect: { exit: 0, output_includes: "first" } }, tree: { kind: "git", worktreePath: first.root, resolvedCommit: first.commit } }, deterministicCommandOptions());
	const secondResult = await runCommand({ evidence: { kind: "command", run: "cat tracked", expect: { exit: 0, output_includes: "second" } }, tree: { kind: "git", worktreePath: second.root, resolvedCommit: second.commit } }, deterministicCommandOptions());
	assert.equal(firstResult.outcome, "observed");
	assert.equal(secondResult.outcome, "observed");
	await removeTempTree(first.root);
	await removeTempTree(second.root);
});

test("dirty failures name bounded paths without truncating a stream mid-record", async () => {
	const fixture = await repo();
	const odd = "a\nquoted\tname";
	await writeFile(path.join(fixture.root, odd), "untracked");
	const dirty = await inspectTree(fixture.root, fixture.commit);
	assert.equal(dirty.ok, false);
	if (!dirty.ok) {
		assert.equal(dirty.failure.code, "tree-dirty");
		assert.ok(dirty.failure.message.includes(JSON.stringify(odd)));
	}
	await removeTempTree(fixture.root);
});

test("only the global excludes file crosses into isolated verifier Git calls", async () => {
	const fixture = await repo();
	const home = await mkdtemp(path.join(os.tmpdir(), "pi-work-git-home-"));
	const xdg = path.join(home, "xdg");
	await mkdir(path.join(xdg, "git"), { recursive: true });
	const ignore = path.join(xdg, "git", "ignored");
	const monitorMarker = path.join(home, "fsmonitor-ran");
	const monitor = path.join(home, "fsmonitor.sh");
	await writeFile(ignore, "private-artifact\n");
	await writeFile(monitor, `#!/bin/sh\ntouch ${JSON.stringify(monitorMarker)}\nexit 1\n`);
	await chmod(monitor, 0o755);
	await writeFile(path.join(home, ".gitconfig"), `[core]\n\texcludesFile = ${ignore}\n\tfsmonitor = ${monitor}\n\tbare = true\n`);
	await writeFile(path.join(fixture.root, "private-artifact"), "private");
	const originalHome = process.env.HOME;
	const originalXdg = process.env.XDG_CONFIG_HOME;
	process.env.HOME = home;
	process.env.XDG_CONFIG_HOME = xdg;
	try {
		const clean = await inspectTree(fixture.root, fixture.commit);
		assert.equal(clean.ok, true, JSON.stringify(clean));
		if (clean.ok) {
			const watched = await monitorTree(clean.snapshot);
			assert.equal(watched.ok, true);
			if (watched.ok) watched.stop();
			assert.equal((await verifyTreeUnchanged(clean.snapshot)).ok, true);
		}
		assert.equal(await readFile(monitorMarker).then(() => true, () => false), false, "global fsmonitor must not run");
		await writeFile(path.join(fixture.root, "real-untracked"), "visible");
		const dirty = await inspectTree(fixture.root, fixture.commit);
		assert.equal(dirty.ok, false);
		if (!dirty.ok) {
			assert.equal(dirty.failure.code, "tree-dirty");
			assert.match(dirty.failure.message, /real-untracked/);
			assert.ok(!dirty.failure.message.includes("private-artifact"));
		}
		await rm(path.join(home, ".gitconfig"));
		await rm(path.join(fixture.root, "real-untracked"));
		await writeFile(path.join(xdg, "git", "ignore"), "private-artifact\n");
		assert.equal((await inspectTree(fixture.root, fixture.commit)).ok, true, "XDG fallback must be honored");
	} finally {
		if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
		if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = originalXdg;
		await removeTempTree(fixture.root);
		await removeTempTree(home);
	}
});
test("tree identity rejects dirty and moved trees", async () => {
	const fixture = await repo();
	const clean = await inspectTree(fixture.root, fixture.commit);
	assert.equal(clean.ok, true);
	if (!clean.ok) {
		await removeTempTree(fixture.root);
		return;
	}
	await writeFile(path.join(fixture.root, "untracked"), "dirty\n");
	const dirty = await inspectTree(fixture.root, fixture.commit);
	assert.equal(dirty.ok, false);
	if (!dirty.ok) assert.equal(dirty.failure.code, "tree-dirty");
	await rm(path.join(fixture.root, "untracked"));
	await writeFile(path.join(fixture.root, "tracked"), "two\n");
	const moved = await verifyTreeUnchanged({ identity: { kind: "git", worktreePath: fixture.root, resolvedCommit: fixture.commit }, clean: true, gitPath: clean.snapshot.gitPath });
	assert.equal(moved.ok, false);
	if (!moved.ok) assert.equal(moved.failure.code, "tree-dirty");
	await removeTempTree(fixture.root);
});
