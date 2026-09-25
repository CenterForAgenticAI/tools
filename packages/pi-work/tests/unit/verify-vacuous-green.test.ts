import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createObservationalVerifier, isCriterionPassed, isNodePassed, makeCacheUpdate, runCommand, userChallenge, confirmationLine, verificationFailures, verifyNode, verifyNodeAndCache, type VerifyNodeRequest } from "../../src/verify/index.ts";
import { createVerifier } from "../../src/verify/internal.ts";
import { REPO_ROOT } from "../helpers/source-under-test.ts";
import { deterministicCommandOptions, systemdContainmentPrerequisite } from "../helpers/verifier-command.ts";

const execFileAsync = promisify(execFile);
const systemdPrerequisite = await systemdContainmentPrerequisite();

async function currentCommit(cwd: string): Promise<string> {
	const result = await execFileAsync("git", ["rev-parse", "HEAD^{commit}"], { cwd, timeout: 5000 });
	return result.stdout.trim();
}

async function cleanRepo(includeArtifact = false, includeNested = false): Promise<{ root: string; commit: string }> {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-work-verify-repo-"));
	await writeFile(path.join(root, "spec.yaml"), "placeholder\n");
	await writeFile(path.join(root, "tracked"), "COMMITTED\n");
	if (includeArtifact) await writeFile(path.join(root, "diagram.bin"), Buffer.from([0, 255, 1, 2]));
	if (includeNested) {
		await mkdir(path.join(root, "nested"));
		await writeFile(path.join(root, "nested", "tracked"), "NESTED-COMMITTED\n");
	}
	const git = (args: string[]) => execFileAsync("git", args, { cwd: root, timeout: 5000 });
	await git(["init", "-q"]);
	await git(["add", "."]);
	await git(["-c", "user.name=pi-work", "-c", "user.email=pi-work@example.invalid", "commit", "-qm", "fixture"]);
	return { root, commit: await currentCommit(root) };
}

function target(repo: { root: string; commit: string }) {
	return { worktreePath: repo.root, expectedCommit: repo.commit };
}

test("observational verifier honors an authored timeout over its adapter default while monitoring the execution", async () => {
	const repo = await cleanRepo();
	try {
		const verifier = createObservationalVerifier({ command: { ...deterministicCommandOptions(), timeoutMs: 1_000 } });
		const node = (timeout_ms?: number) => ({ id: "gate", task: "run", acceptance: [{ id: "A", statement: "done", evidence: { kind: "command" as const, run: "sleep 1.2; printf done", expect: { exit: 0, output_includes: "done" }, ...(timeout_ms === undefined ? {} : { timeout_ms }) } }] });
		const verify = (timeout_ms?: number) => verifier.verifyNode({ node: node(timeout_ms), specPath: "spec.yaml", target: target(repo) });
		const timedOut = await verify();
		assert.equal(timedOut.outcome, "failed");
		if (timedOut.outcome === "failed") assert.ok(timedOut.criteria.some((criterion) => criterion.failures.some((failure) => failure.code === "timeout" && failure.message === "command exceeded 1000ms")));
		const passed = await verify(3_000);
		assert.equal(passed.outcome, "passed");
		if (passed.outcome === "passed") {
			const proof = passed.criteria[0].proof;
			assert.equal(proof.kind, "command-proof");
			if (proof.kind === "command-proof") {
				assert.equal(proof.timeout_ms, 3_000);
				assert.ok(proof.monitoring.window.durationMs >= 1_000);
			}
		}
	} finally {
		await rm(repo.root, { recursive: true, force: true });
	}
});

test("graft #521 shape fails an exit-zero skipped-test output and passes only a perturbed floor", async () => {
	const fixture = await readFile(`${REPO_ROOT}/tests/fixtures/verify/vacuous-filter.yaml`, "utf8");
	const skipped = await runCommand({ evidence: { kind: "command", run: "cat tests/fixtures/verify/vacuous-filter.yaml", expect: { exit: 0, output_includes: "1 passed" } }, tree: { kind: "git", worktreePath: REPO_ROOT, resolvedCommit: "fixture" } }, deterministicCommandOptions());
	assert.equal(skipped.outcome, "failed");
	if (skipped.outcome === "failed") {
		assert.equal(skipped.failures[0]?.code, "output-mismatch");
		assert.match(skipped.attempt.stdout ?? "", /10 skipped/);
		assert.match(fixture, /10 skipped/);
	}
	const control = await runCommand({ evidence: { kind: "command", run: "printf '1 passed\\n'", expect: { exit: 0, output_includes: "1 passed" } }, tree: { kind: "git", worktreePath: REPO_ROOT, resolvedCommit: "fixture" } }, deterministicCommandOptions());
	assert.equal(control.outcome, "observed");
});

test("graft #546 shape rejects zero paths while a one-path observation passes", async () => {
	const fixture = await readFile(`${REPO_ROOT}/tests/fixtures/verify/zero-paths.yaml`, "utf8");
	const zero = await runCommand({ evidence: { kind: "command", run: "cat tests/fixtures/verify/zero-paths.yaml", expect: { exit: 0, output_includes: "1 paths" } }, tree: { kind: "git", worktreePath: REPO_ROOT, resolvedCommit: "fixture" } }, deterministicCommandOptions());
	assert.equal(zero.outcome, "failed");
	if (zero.outcome === "failed") {
		assert.equal(zero.failures[0]?.code, "output-mismatch");
		assert.match(zero.attempt.stdout ?? "", /clean \(0 paths\)/);
		assert.match(fixture, /clean \(0 paths\)/);
	}
	const one = await runCommand({ evidence: { kind: "command", run: "printf 'clean (1 paths)\\n'", expect: { exit: 0, output_includes: "1 paths" } }, tree: { kind: "git", worktreePath: REPO_ROOT, resolvedCommit: "fixture" } }, deterministicCommandOptions());
	assert.equal(one.outcome, "observed");
});

test("constructed authority requires real tree ownership and rejects empty evidence", async () => {
	const repo = await cleanRepo();
	const verifier = createVerifier({ hasUI: false });
	const emptyNode = { id: "empty", task: "nothing" } as unknown as VerifyNodeRequest["node"];
	const empty = await verifier.verifyNode({ node: emptyNode, specPath: "spec.yaml", target: target(repo) });
	assert.equal(empty.outcome, "failed");
	assert.equal(verifier.isNodePassed(empty), false);
	const mismatch = await verifier.verifyNode({ node: emptyNode, specPath: "spec.yaml", target: { worktreePath: repo.root, expectedCommit: "0".repeat(40) } });
	assert.equal(mismatch.outcome, "failed");
	await rm(repo.root, { recursive: true, force: true });
});

test("legacy public verification routes remain observational", async () => {
	const request = { node: { id: "legacy", task: "observe" } as unknown as VerifyNodeRequest["node"], specPath: "spec.yaml", target: { worktreePath: "", expectedCommit: "" } } satisfies VerifyNodeRequest;
	const result = await verifyNode(request);
	assert.equal(result.outcome, "failed");
	assert.equal(isNodePassed(result), false);
	assert.ok(verificationFailures(result).some((failure) => failure.code === "no-execution-evidence"));
	const cached = await verifyNodeAndCache(request);
	assert.equal(cached.result.outcome, "failed");
	assert.ok(cached.cacheUpdate);
});

test("authority aborts before evidence and observational adapters fail closed on user and tree changes", async () => {
	const repo = await cleanRepo();
	const authority = createVerifier({ hasUI: false });
	const aborted = new AbortController();
	aborted.abort();
	const abortedResult = await authority.verifyNode({ node: { id: "aborted", task: "stop", acceptance: [{ id: "A", statement: "not run", evidence: { kind: "command" as const, run: "printf never", expect: { exit: 0, output_includes: "never" } } }] }, specPath: "spec.yaml", target: target(repo), signal: aborted.signal });
	assert.equal(abortedResult.outcome, "failed");
	assert.equal(authority.verificationFailures(abortedResult)[0]?.code, "verification-aborted");
	const observed = createObservationalVerifier({ command: deterministicCommandOptions() });
	const observedAbort = new AbortController();
	observedAbort.abort();
	const observedAbortedResult = await observed.verifyNode({ node: { id: "observed-aborted", task: "stop", acceptance: [{ id: "A", statement: "not run", evidence: { kind: "command" as const, run: "printf never", expect: { exit: 0, output_includes: "never" } } }] }, specPath: "spec.yaml", target: target(repo), signal: observedAbort.signal });
	assert.equal(observedAbortedResult.outcome, "failed");
	assert.equal(observed.verificationFailures(observedAbortedResult)[0]?.code, "verification-aborted");
	const userResult = await observed.verifyNode({ node: { id: "user", task: "confirm", acceptance: [{ id: "U", statement: "confirmed", evidence: { kind: "user" as const, prompt: "confirm" } }] }, specPath: "spec.yaml", target: target(repo) });
	assert.equal(userResult.outcome, "failed");
	assert.equal(observed.verificationFailures(userResult)[0]?.code, "session-unavailable");
	const dirtyResult = await observed.verifyNode({ node: { id: "dirty-observed", task: "observe", acceptance: [{ id: "A", statement: "tracked change", evidence: { kind: "command" as const, run: "printf DIRTY > tracked; cat tracked; printf 'COMMITTED\\n' > tracked", expect: { exit: 0, output_includes: "DIRTY" } } }] }, specPath: "spec.yaml", target: target(repo) });
	assert.equal(dirtyResult.outcome, "failed");
	assert.ok(observed.verificationFailures(dirtyResult).some((failure) => failure.code === "tree-changed"));
	await rm(repo.root, { recursive: true, force: true });
});

test("a PATH shadow of a verifier executable fails closed before the authored command can run", async () => {
	const repo = await cleanRepo();
	const fakeDirectory = await mkdtemp(path.join(os.tmpdir(), "pi-work-fake-executor-"));
	const marker = path.join(repo.root, "fake-executor-marker");
	const executable = process.platform === "darwin" ? "sh" : "systemd-run";
	await writeFile(path.join(fakeDirectory, executable), "#!/bin/sh\nprintf AUTHORED_RAN\n");
	await chmod(path.join(fakeDirectory, executable), 0o755);
	const originalPath = process.env.PATH;
	process.env.PATH = `${fakeDirectory}:${originalPath ?? ""}`;
	try {
		const verifier = createVerifier({ hasUI: false });
		const verified = await verifier.verifyNodeAndCache({ node: { id: "fake-path", task: "must not use a shadow", acceptance: [{ id: "A", statement: "authored marker", evidence: { kind: "command" as const, run: `touch ${marker}; printf AUTHORED_RAN`, expect: { exit: 0, output_includes: "AUTHORED_RAN" } } }] }, specPath: "spec.yaml", target: target(repo) });
		assert.equal(verified.result.outcome, "failed");
		assert.equal(verifier.isNodePassed(verified.result), false);
		assert.equal(verified.cacheUpdate, undefined);
		assert.ok(verifier.verificationFailures(verified.result).some((failure) => failure.code === "executable-unavailable"));
		assert.ok(!(await access(marker).then(() => true, () => false)));
	} finally {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		await rm(fakeDirectory, { recursive: true, force: true });
		await rm(repo.root, { recursive: true, force: true });
	}
});

test("agent authority is unavailable while observational adapters remain usable but untrusted", async () => {
	const repo = await cleanRepo(true);
	const node = { id: "mixed", task: "judge", acceptance: [{ id: "A", statement: "judged", evidence: { kind: "agent" as const, agent: "reviewer", inputs: ["diagram.bin"], rubric: "inspect" } }] };
	const authority = createVerifier({ hasUI: false });
	const unavailable = await authority.verifyNode({ node, specPath: "spec.yaml", target: target(repo) });
	assert.equal(unavailable.outcome, "failed");
	if (unavailable.outcome === "failed") assert.equal(unavailable.criteria[0]?.failures[0]?.code, "agent-unavailable");
	const observed = createObservationalVerifier({ judge: async (request) => ({ verdict: "approve" as const, dispatchReceipt: "receipt", inputDigests: request.inputs.map((input) => input.digest) }) });
	const result = await observed.verifyNode({ node, specPath: "spec.yaml", target: target(repo) });
	assert.equal(result.outcome, "passed");
	assert.equal(observed.isNodePassed(result), false);
	assert.equal(isNodePassed(result), false);
	await rm(repo.root, { recursive: true, force: true });
});

test("host-captured user evidence can pass only through the constructed authority", async () => {
	const repo = await cleanRepo();
	const user = { kind: "user" as const, prompt: "The letter was sent." };
	const session = { getSessionId: () => "session-1", getSessionFile: () => undefined, getBranch: () => [] };
	let received = "";
	const verifier = createVerifier({ hasUI: true, sessionManager: session, confirm: async (_title, message) => { received = message; return true; } });
	const request = { node: { id: "letter", task: "confirm", acceptance: [{ id: "U", statement: "sent", evidence: user }] }, specPath: "spec.yaml", target: target(repo) };
	const result = await verifier.verifyNode(request);
	assert.equal(result.outcome, "passed");
	assert.match(received, new RegExp(confirmationLine(userChallenge({ evidence: user, specPath: "spec.yaml", nodeId: "letter", criterionId: "U", tree: { kind: "git", worktreePath: repo.root, resolvedCommit: repo.commit } }, "session-1"))));
	assert.equal(verifier.isNodePassed(result), true);
	assert.equal(isNodePassed(result), false);
	await rm(repo.root, { recursive: true, force: true });
});

test("host integration: graft #548 shape proves the authoritative verifier calls its executor and caches only its own result", { skip: systemdPrerequisite.available ? false : systemdPrerequisite.reason }, async () => {
	const marker = `/tmp/pi-work-verify-marker-${process.pid}`;
	await rm(marker, { force: true });
	const repo = await cleanRepo();
	const verifier = createVerifier({ hasUI: false });
	const node = { id: "marker", task: "observe", acceptance: [{ id: "A", statement: "signal", evidence: { kind: "command" as const, run: `sh ${REPO_ROOT}/tests/fixtures/verify/dead-replay.sh ${marker}`, expect: { exit: 0, output_includes: "signal" } } }] };
	const verified = await verifier.verifyNodeAndCache({ node, specPath: "spec.yaml", target: target(repo) });
	assert.equal(verified.result.outcome, "passed");
	assert.equal(verifier.isNodePassed(verified.result), true);
	assert.ok(verified.cacheUpdate);
	assert.equal(verified.cacheUpdate ? verifier.isCacheUpdate(verified.cacheUpdate) : false, true);
	await access(marker);
	await rm(marker, { force: true });
	const observed = makeCacheUpdate("spec.yaml", verified.result);
	assert.equal(isNodePassed(verified.result), false);
	assert.equal(isCriterionPassed(verified.result.criteria[0]!), false);
	assert.equal(Object.isFrozen(observed), true);
	await rm(repo.root, { recursive: true, force: true });
});

test("substituted launchers are observational and cannot reach authority", async () => {
	const repo = await cleanRepo();
	const marker = path.join(os.tmpdir(), `pi-work-verify-substitution-${process.pid}`);
	await rm(marker, { force: true });
	const node = { id: "substituted", task: "observe", acceptance: [{ id: "A", statement: "authored command must run", evidence: { kind: "command" as const, run: `touch ${marker}; printf AUTHORED_RAN`, expect: { exit: 0, output_includes: "AUTHORED_RAN" } } }] };
	const observed = createObservationalVerifier({ command: { ...deterministicCommandOptions(), launcher: (_file, _args, options) => spawn(process.execPath, ["-e", "process.stdout.write('AUTHORED_RAN')"], options) } });
	const result = await observed.verifyNode({ node, specPath: "spec.yaml", target: target(repo) });
	assert.equal(result.outcome, "passed");
	assert.equal(observed.isNodePassed(result), false);
	assert.ok(!(await access(marker).then(() => true, () => false)));
	await rm(repo.root, { recursive: true, force: true });
});

test("dirty-then-clean execution is observed and rejected", async () => {
	const repo = await cleanRepo();
	const verifier = createObservationalVerifier({ command: deterministicCommandOptions() });
	const node = { id: "dirty", task: "observe", acceptance: [{ id: "A", statement: "must bind to commit", evidence: { kind: "command" as const, run: "printf DIRTY > tracked; cat tracked; printf COMMITTED\\n > tracked", expect: { exit: 0, output_includes: "DIRTY" } } }] };
	const result = await verifier.verifyNode({ node, specPath: "spec.yaml", target: target(repo) });
	assert.equal(result.outcome, "failed");
	assert.equal(verifier.isNodePassed(result), false);
	await rm(repo.root, { recursive: true, force: true });
});

test("nested tracked restoration fails while nested untracked churn is reported and allowed", async () => {
	const repo = await cleanRepo(false, true);
	const verifier = createObservationalVerifier({ command: deterministicCommandOptions() });
	const trackedNode = { id: "nested-tracked", task: "observe", acceptance: [{ id: "A", statement: "nested tracked content", evidence: { kind: "command" as const, run: "printf NESTED-MUTATED > nested/tracked; cat nested/tracked; printf 'NESTED-COMMITTED\\n' > nested/tracked", expect: { exit: 0, output_includes: "NESTED-MUTATED" } } }] };
	const trackedResult = await verifier.verifyNode({ node: trackedNode, specPath: "spec.yaml", target: target(repo) });
	assert.equal(trackedResult.outcome, "failed");
	assert.ok(verifier.verificationFailures(trackedResult).some((failure) => failure.code === "tree-changed"));
	const untrackedNode = { id: "nested-untracked", task: "observe", acceptance: [{ id: "A", statement: "nested untracked content", evidence: { kind: "command" as const, run: "mkdir -p nested/ephemeral; printf EPHEMERAL > nested/ephemeral/file; cat nested/ephemeral/file; rm -rf nested/ephemeral; printf OK", expect: { exit: 0, output_includes: "EPHEMERAL" } } }] };
	const untrackedResult = await verifier.verifyNode({ node: untrackedNode, specPath: "spec.yaml", target: target(repo) });
	assert.equal(untrackedResult.outcome, "passed");
	if (untrackedResult.outcome === "passed" && untrackedResult.criteria[0]?.proof.kind === "command-proof") {
		assert.ok(untrackedResult.criteria[0].proof.untrackedPaths?.some((item) => item.includes("nested/ephemeral")));
		assert.equal(untrackedResult.criteria[0].proof.monitoring.method, "fs.watch");
		assert.ok(untrackedResult.criteria[0].proof.monitoring.mode === "recursive" || untrackedResult.criteria[0].proof.monitoring.mode === "directory-fallback");
		assert.ok(untrackedResult.criteria[0].proof.monitoring.window.durationMs >= 0);
		assert.equal(untrackedResult.criteria[0].proof.monitoring.residualRace, "events-after-final-drain-may-be-missed");
	}
	await rm(repo.root, { recursive: true, force: true });
});

test("host integration: authority snapshots request identity before slow evidence can await", { skip: systemdPrerequisite.available ? false : systemdPrerequisite.reason }, async () => {
	const repo = await cleanRepo();
	const verifier = createVerifier({ hasUI: false });
	const request = {
		node: { id: "PRE-NODE", task: "snapshot", acceptance: [{ id: "PRE-ID", statement: "pre statement", evidence: { kind: "command" as const, run: "sleep 0.45; printf PRETOKEN", expect: { exit: 0, output_includes: "PRETOKEN" } } }] },
		specPath: "pre-spec.yaml",
		target: target(repo),
	} satisfies VerifyNodeRequest;
	const verification = verifier.verifyNodeAndCache(request);
	await new Promise((resolve) => setTimeout(resolve, 80));
	Object.assign(request.node, { id: "POST-NODE" });
	const criterion = request.node.acceptance?.[0];
	if (criterion) Object.assign(criterion, { id: "POST-ID", statement: "post statement" });
	const verified = await verification;
	assert.equal(verified.result.outcome, "passed");
	assert.equal(verified.result.nodeId, "PRE-NODE");
	if (verified.result.outcome === "passed") {
		assert.equal(verified.result.criteria[0]?.criterion.id, "PRE-ID");
		assert.equal(verified.result.criteria[0]?.criterion.statement, "pre statement");
		assert.equal(verified.result.criteria[0]?.proof.kind, "command-proof");
		if (verified.result.criteria[0]?.proof.kind === "command-proof") assert.equal(verified.result.criteria[0].proof.authoredCommand, "sleep 0.45; printf PRETOKEN");
	}
	assert.equal(verified.cacheUpdate?.specPath, "pre-spec.yaml");
	await rm(repo.root, { recursive: true, force: true });
});
