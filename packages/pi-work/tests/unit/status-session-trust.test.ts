/**
 * The one route from an executed verification to a trusted status answer.
 *
 * `work_verify` holds the production authority; `work_status` owns done-ness.
 * Before this route existed the two never met: status created its trusted map
 * empty and never wrote it, so `done` was unreachable and every node with a
 * `depends_on` stayed blocked forever. These tests exercise the real chain --
 * a real spec in a real git tree, the real tools, real command evidence -- and
 * pin the boundary that route must not cross: nothing decoded from disk, and
 * nothing a caller supplies, may reach the same trusted state.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { deriveStatus } from "../../src/status/index.ts";
import { statusCachePath, writeVerificationCacheEntry } from "../../src/status/cache.ts";
import { buildStatusGraph } from "../../src/status/graph.ts";
import { classifyStatusCache } from "../../src/status/cache.ts";
import { validateWorkspec } from "../../src/schema/index.ts";
import { createVerifier } from "../../src/verify/internal.ts";
import { addressKey } from "../../src/plan/index.ts";
import { digestSpecSource, forgetSessionVerifications, sessionVerifications } from "../../src/status/session-verification.ts";
import * as sessionLedger from "../../src/status/session-verification.ts";
import { workStatusTool, type WorkStatusDetails } from "../../src/tools/work-status.ts";
import { workVerifyTool, type WorkVerifyDetails } from "../../src/tools/work-verify.ts";
import { REPO_ROOT } from "../helpers/source-under-test.ts";
import { withDraftLineage } from "../helpers/workspec-source.ts";
import { systemdContainmentPrerequisite } from "../helpers/verifier-command.ts";

const execFileAsync = promisify(execFile);
const systemdPrerequisite = process.platform === "linux" ? await systemdContainmentPrerequisite() : undefined;
const requiresCommand = process.platform === "darwin" || systemdPrerequisite?.available === true;
const commandSkip = requiresCommand ? false : systemdPrerequisite?.reason ?? "host integration requires macOS or Linux systemd user scopes";

const DEPENDENCY_SPEC = `title: Session trust\ndescription: d\nintent: i\nwork:\n  - id: node\n    task: run\n    acceptance:\n      - id: A\n        statement: signal\n        evidence:\n          kind: command\n          run: printf signal\n          expect:\n            exit: 0\n            output_includes: signal\n  - id: dependent\n    task: wait for node\n    depends_on: [node]\n    acceptance:\n      - id: B\n        statement: dependent signal\n        evidence:\n          kind: command\n          run: printf dependent\n          expect:\n            exit: 0\n            output_includes: dependent\n`;

async function fixtureRepo(spec = DEPENDENCY_SPEC): Promise<{ root: string; commit: string }> {
	// realpath first: macOS hands out /var/folders/... from mkdtemp while the
	// verifier's own tree identity is canonical, and a TreeIdentity is compared
	// by exact string.
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-work-session-trust-")));
	await writeFile(path.join(root, "spec.yaml"), withDraftLineage(spec, { cwd: root }));
	const git = (args: string[]) => execFileAsync("git", args, { cwd: root, timeout: 5000 });
	await git(["init", "-q"]);
	await git(["add", "-f", "spec.yaml", ".test-dist"]);
	await git(["-c", "user.name=pi-work", "-c", "user.email=pi-work@example.invalid", "commit", "-qm", "fixture"]);
	return { root, commit: (await git(["rev-parse", "HEAD^{commit}"])).stdout.trim() };
}

function verify(params: Record<string, unknown>) {
	return workVerifyTool.execute("test", params, undefined, undefined, { cwd: REPO_ROOT, sessionManager: undefined } as never) as Promise<{ content: { type: string; text?: string }[]; details: WorkVerifyDetails }>;
}

function status(params: Record<string, unknown>) {
	return workStatusTool.execute("test", params, undefined, undefined, {} as never) as Promise<{ content: [{ type: "text"; text: string }]; details: WorkStatusDetails }>;
}

function nodeReport(details: WorkStatusDetails, id: string) {
	return details.nodes.find((node) => node.address.join("/") === id);
}

function classifiedNodeTrust(source: string, specPath: string, tree: { kind: "git"; worktreePath: string; resolvedCommit: string }) {
	const validation = validateWorkspec(source, { specPath, cwd: tree.worktreePath });
	assert.equal(validation.valid, true);
	return classifyStatusCache(undefined, buildStatusGraph(validation.spec).graph, tree, specPath, tree.worktreePath, source).trusted.get(addressKey(["node"]));
}

test("a verified node reaches done, its dependent becomes ready, and the pass names its own containment", { skip: commandSkip }, async () => {
	forgetSessionVerifications();
	const repo = await fixtureRepo();
	try {
		const before = await status({ path: "spec.yaml", worktreePath: repo.root, expectedCommit: repo.commit });
		assert.equal(nodeReport(before.details, "node")?.lifecycle, "ready");
		assert.equal(nodeReport(before.details, "node")?.verification, "unverified");
		assert.equal(nodeReport(before.details, "dependent")?.lifecycle, "blocked");
		assert.equal(nodeReport(before.details, "dependent")?.blockers[0]?.code, "dependency");
		assert.equal(before.details.specState, "not-done");

		const verified = await verify({ path: "spec.yaml", nodeId: "node", worktreePath: repo.root, expectedCommit: repo.commit });
		assert.equal(verified.details.outcome, "passed");

		const after = await status({ path: "spec.yaml", worktreePath: repo.root, expectedCommit: repo.commit });
		const done = nodeReport(after.details, "node");
		assert.equal(done?.lifecycle, "done");
		assert.equal(done?.verification, "verified-this-session");
		assert.deepEqual(done?.blockers, []);
		// The dependency cleared: this is the gate that was permanently shut.
		assert.equal(nodeReport(after.details, "dependent")?.lifecycle, "ready");
		assert.deepEqual(nodeReport(after.details, "dependent")?.blockers, []);
		assert.equal(after.details.specState, "not-done");

		// A pass carries the containment it actually ran under. On a host without
		// systemd user scopes that is a process group, which is weaker, and the
		// rendered claim has to say so rather than reading as an equivalent green.
		const proof = verified.details.result?.outcome === "passed" ? verified.details.result.criteria[0]?.proof : undefined;
		assert.equal(proof?.kind, "command-proof");
		const containment = proof?.kind === "command-proof" ? proof.containment : undefined;
		assert.deepEqual(done?.containment, [{ method: containment ?? "unknown" }]);
		if (containment === "process-group") {
			assert.match(done?.lifecycleText ?? "", /process group, not a systemd user scope/);
			assert.match(done?.verificationText ?? "", /weaker than one contained by a control group/);
			assert.match(after.content[0].text, /process group, not a systemd user scope/);
		} else {
			assert.equal(containment, "systemd-scope");
			assert.doesNotMatch(done?.lifecycleText ?? "", /process group/);
		}

		const dependent = await verify({ path: "spec.yaml", nodeId: "dependent", worktreePath: repo.root, expectedCommit: repo.commit });
		assert.equal(dependent.details.outcome, "passed");
		const complete = await status({ path: "spec.yaml", worktreePath: repo.root, expectedCommit: repo.commit });
		assert.equal(nodeReport(complete.details, "dependent")?.lifecycle, "done");
		assert.equal(complete.details.specState, "done");
	} finally {
		forgetSessionVerifications();
		await rm(repo.root, { recursive: true, force: true });
	}
});

test("a failing node stays blocked, says so this session, and still blocks its dependent", { skip: commandSkip }, async () => {
	forgetSessionVerifications();
	const repo = await fixtureRepo(`title: Session trust\ndescription: d\nintent: i\nwork:\n  - id: node\n    task: run\n    acceptance:\n      - id: A\n        statement: signal\n        evidence:\n          kind: command\n          run: printf wrong\n          expect:\n            exit: 0\n            output_includes: signal\n  - id: dependent\n    task: wait for node\n    depends_on: [node]\n    acceptance:\n      - id: B\n        statement: dependent signal\n        evidence:\n          kind: command\n          run: printf dependent\n          expect:\n            exit: 0\n            output_includes: dependent\n`);
	try {
		const verified = await verify({ path: "spec.yaml", nodeId: "node", worktreePath: repo.root, expectedCommit: repo.commit });
		assert.equal(verified.details.outcome, "failed");
		const after = await status({ path: "spec.yaml", worktreePath: repo.root, expectedCommit: repo.commit });
		const failed = nodeReport(after.details, "node");
		assert.equal(failed?.verification, "failed-this-session");
		assert.notEqual(failed?.lifecycle, "done");
		assert.deepEqual(failed?.containment, []);
		assert.equal(nodeReport(after.details, "dependent")?.lifecycle, "blocked");
		assert.equal(after.details.specState, "not-done");
	} finally {
		forgetSessionVerifications();
		await rm(repo.root, { recursive: true, force: true });
	}
});

test("a session pass is refused once the tree moves or the criterion contract drifts", { skip: commandSkip }, async () => {
	forgetSessionVerifications();
	const repo = await fixtureRepo();
	try {
		assert.equal(nodeReport((await status({ path: "spec.yaml", worktreePath: repo.root, expectedCommit: repo.commit })).details, "node")?.lifecycle, "ready");
		assert.equal((await verify({ path: "spec.yaml", nodeId: "node", worktreePath: repo.root, expectedCommit: repo.commit })).details.outcome, "passed");
		assert.equal(nodeReport((await status({ path: "spec.yaml", worktreePath: repo.root, expectedCommit: repo.commit })).details, "node")?.lifecycle, "done");

		const git = (args: string[]) => execFileAsync("git", args, { cwd: repo.root, timeout: 5000 });
		await git(["-c", "user.name=pi-work", "-c", "user.email=pi-work@example.invalid", "commit", "--allow-empty", "-qm", "moved"]);
		const moved = (await git(["rev-parse", "HEAD^{commit}"])).stdout.trim();
		const afterMove = await status({ path: "spec.yaml", worktreePath: repo.root, expectedCommit: moved });
		assert.equal(nodeReport(afterMove.details, "node")?.lifecycle, "ready");
		assert.equal(nodeReport(afterMove.details, "node")?.verification, "stale-observation");
		assert.equal(nodeReport(afterMove.details, "dependent")?.lifecycle, "blocked");

		// Same tree, different authored criterion: the run proved something the
		// workspec no longer asks for, so it is reported and refused.
		const entry = sessionVerifications()[0];
		assert.ok(entry);
		const update = entry.update;
		const drifted = withDraftLineage(DEPENDENCY_SPEC.replace("run: printf signal", "run: printf other").replace("output_includes: signal", "output_includes: other"), { cwd: repo.root });
		const conflicted = deriveStatus({ source: drifted, specPath: path.join(repo.root, "spec.yaml"), tree: update.tree });
		assert.equal(nodeReport(conflicted.details, "node")?.lifecycle, "ready");
		assert.equal(nodeReport(conflicted.details, "node")?.verification, "unverified");
	} finally {
		forgetSessionVerifications();
		await rm(repo.root, { recursive: true, force: true });
	}
});

test("authority binds node and criteria to validated source before running evidence", { skip: commandSkip }, async () => {
	forgetSessionVerifications();
	const repo = await fixtureRepo();
	try {
		const source = await readFile(path.join(repo.root, "spec.yaml"), "utf8");
		const specPath = path.join(repo.root, "spec.yaml");
		const verifier = createVerifier({ hasUI: false });
		const target = { worktreePath: repo.root, expectedCommit: repo.commit };
		const node = { id: "node", task: "run", acceptance: [{ id: "A", statement: "signal", evidence: { kind: "command" as const, run: "printf signal", expect: { exit: 0, output_includes: "signal" } } }] };
		const sourceB = source.replace("run: printf signal", "run: printf different").replace("output_includes: signal", "output_includes: different");
		let wrote = false;
		await assert.rejects(() => verifier.verifyNodeAndCache({ node, specPath, source: sourceB, target }, async () => { wrote = true; return { status: "written" as const, path: "cache", attempts: 1, residualRace: "readback-may-precede-later-overwrite" as const }; }), /node.*source|source.*node/);
		assert.equal(wrote, false);
		assert.deepEqual(sessionVerifications(), []);
	} finally {
		forgetSessionVerifications();
		await rm(repo.root, { recursive: true, force: true });
	}
});

test("authority attests only after a successful cache write", { skip: commandSkip }, async () => {
	forgetSessionVerifications();
	const repo = await fixtureRepo();
	try {
		const source = await readFile(path.join(repo.root, "spec.yaml"), "utf8");
		const specPath = path.join(repo.root, "spec.yaml");
		const validation = validateWorkspec(source, { specPath, cwd: repo.root });
		assert.equal(validation.valid, true);
		const node = validation.spec.work[0]!;
		const verifier = createVerifier({ hasUI: false });
		const request = { node, specPath, source, target: { worktreePath: repo.root, expectedCommit: repo.commit } };
		const unpersisted = await verifier.verifyNodeAndCache(request);
		assert.equal(unpersisted.result.outcome, "passed");
		assert.deepEqual(sessionVerifications(), [], "a result alone cannot attest without persistence");
		const refused = await verifier.verifyNodeAndCache(request, async () => ({ status: "failed" as const, path: "cache", attempts: 1, reason: "cache-write-error" as const, message: "simulated persistence failure" }));
		assert.equal(refused.result.outcome, "passed");
		assert.equal(refused.cacheWrite?.status, "failed");
		assert.deepEqual(sessionVerifications(), []);
		assert.equal(nodeReport((await status({ path: "spec.yaml", worktreePath: repo.root, expectedCommit: repo.commit })).details, "node")?.lifecycle, "ready");
		await assert.rejects(() => verifier.verifyNodeAndCache(request, async () => { throw new Error("simulated rejected write"); }), /simulated rejected write/);
		assert.deepEqual(sessionVerifications(), []);
		assert.equal(nodeReport((await status({ path: "spec.yaml", worktreePath: repo.root, expectedCommit: repo.commit })).details, "node")?.lifecycle, "ready", "a rejected write cannot make the node done");
		const persisted = await verifier.verifyNodeAndCache(request, (update) => writeVerificationCacheEntry(statusCachePath(repo.root, specPath), specPath, repo.root, { address: [node.id], update }));
		assert.equal(persisted.cacheWrite?.status, "written");
		assert.equal(sessionVerifications().length, 1);
		assert.equal(classifiedNodeTrust(source, specPath, persisted.result.tree), "passed");
		assert.equal(nodeReport((await status({ path: "spec.yaml", worktreePath: repo.root, expectedCommit: repo.commit })).details, "node")?.lifecycle, "done");
	} finally {
		forgetSessionVerifications();
		await rm(repo.root, { recursive: true, force: true });
	}
});

test("session ledger readers cannot change an attested source, update, or nested proof", { skip: commandSkip }, async () => {
	forgetSessionVerifications();
	const repo = await fixtureRepo();
	try {
		assert.equal((await verify({ path: "spec.yaml", nodeId: "node", worktreePath: repo.root, expectedCommit: repo.commit })).details.outcome, "passed");
		const sourceA = await readFile(path.join(repo.root, "spec.yaml"), "utf8");
		const sourceB = sourceA + "\n# a different source\n";
		const entry = sessionVerifications()[0];
		assert.ok(entry);
		assert.equal(entry.sourceDigest, digestSpecSource(sourceA));
		const tamper = entry as unknown as { sourceDigest: string; update: { specPath: string; tree: { resolvedCommit: string }; record: { criteria: { criterion: { statement: string } }[] } } };
		try { tamper.sourceDigest = digestSpecSource(sourceB); } catch { /* frozen reads are also safe */ }
		const specPath = path.join(repo.root, "spec.yaml");
		const tree = { kind: "git" as const, worktreePath: repo.root, resolvedCommit: repo.commit };
		assert.equal(classifiedNodeTrust(sourceB, specPath, tree), undefined, "mutating the entry must not trust source B");
		try { tamper.update.specPath = path.join(repo.root, "another.yaml"); } catch { /* frozen reads are also safe */ }
		try { tamper.update.tree.resolvedCommit = "0".repeat(40); } catch { /* frozen reads are also safe */ }
		try { tamper.update.record.criteria[0]!.criterion.statement = "forged"; } catch { /* frozen reads are also safe */ }
		assert.equal(classifiedNodeTrust(sourceB, specPath, tree), undefined, "nested mutation must not trust source B");
		assert.equal(classifiedNodeTrust(sourceA, specPath, tree), "passed");
		assert.equal(nodeReport((await status({ path: "spec.yaml", worktreePath: repo.root, expectedCommit: repo.commit })).details, "node")?.lifecycle, "done");
	} finally {
		forgetSessionVerifications();
		await rm(repo.root, { recursive: true, force: true });
	}
});

async function sourceFiles(directory: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...await sourceFiles(entryPath));
		else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(entryPath);
	}
	return files;
}

test("only the work-verify composition root writes this session's trusted results", async () => {
	const sources = new Map<string, string>();
	for (const file of await sourceFiles(path.join(REPO_ROOT, "src"))) sources.set(path.relative(REPO_ROOT, file), await readFile(file, "utf8"));
	const importers = [...sources.entries()].filter(([file, text]) => file !== "src/status/session-verification.ts" && text.includes("session-verification.js")).map(([file]) => file).sort();
	// The ledger is the one route an executed result takes into done-ness. Its
	// reachable surface is reviewed the same way the authority factory's is: the
	// status boundary reads it, the tool that holds the authority writes it, and
	// nothing else names it at all.
	assert.deepEqual(importers, ["src/status/cache.ts"]);
	assert.doesNotMatch(sources.get("src/status/session-verification.ts") ?? "", /export function recordSessionVerification/);
	assert.doesNotMatch(sources.get("src/tools/work-verify.ts") ?? "", /recordSessionVerification/);
});

test("only an attested authority result becomes trusted, and a forged trusted map is ignored", { skip: commandSkip }, async () => {
	forgetSessionVerifications();
	const repo = await fixtureRepo();
	try {
		const verified = await verify({ path: "spec.yaml", nodeId: "node", worktreePath: repo.root, expectedCommit: repo.commit });
		assert.equal(verified.details.outcome, "passed");
		const entry = sessionVerifications()[0];
		assert.ok(entry);
		const genuine = entry.update;
		const source = withDraftLineage(DEPENDENCY_SPEC, { cwd: repo.root });
		const specPath = path.join(repo.root, "spec.yaml");
		forgetSessionVerifications();

		// The same value, replayed as serialized cache data, is only an observation.
		const replayed = deriveStatus({
			source,
			specPath,
			tree: genuine.tree,
			cache: { kind: "pi-work-status-cache", version: 1, specPath, verification: { [addressKey(["node"])]: { address: ["node"], update: JSON.parse(JSON.stringify(genuine)) as unknown } }, review: {}, dispatch: {} },
		});
		assert.equal(nodeReport(replayed.details, "node")?.verification, "observed-green-not-verified-this-session");
		assert.equal(nodeReport(replayed.details, "node")?.lifecycle, "ready");
		assert.equal(nodeReport(replayed.details, "dependent")?.lifecycle, "blocked");

		// The reviewer imported this module and passed a serialized real pass with
		// a predicate accepting exactly that object. No such registration exists.
		const replay = JSON.parse(JSON.stringify(genuine)) as unknown;
		const ledger = sessionLedger as Record<string, unknown>;
		for (const value of [replay, structuredClone(genuine), { ...genuine }]) {
			const candidate = ledger.recordSessionVerification;
			if (typeof candidate === "function") (candidate as (value: unknown, predicate: (input: unknown) => boolean, source: string) => unknown)(value, (input) => input === value, source);
			assert.deepEqual(sessionVerifications(), [], "serialized or hand-built green data must remain untrusted");
			assert.equal(nodeReport(deriveStatus({ source, specPath, tree: genuine.tree }).details, "node")?.lifecycle, "ready");
		}
		assert.equal(typeof ledger.recordSessionVerification, "undefined");
		assert.equal(nodeReport(deriveStatus({ source, specPath, tree: genuine.tree }).details, "node")?.lifecycle, "ready");
		// A caller-supplied trusted map is not a route to done either.
		const forged = deriveStatus({ source, specPath, tree: genuine.tree, trusted: new Map([[addressKey(["node"]), "passed"]]) } as unknown as Parameters<typeof deriveStatus>[0]);
		assert.equal(nodeReport(forged.details, "node")?.lifecycle, "ready");
		assert.equal(nodeReport(forged.details, "node")?.verification, "unverified");
		assert.equal(forged.details.specState, "not-done");
	} finally {
		forgetSessionVerifications();
		await rm(repo.root, { recursive: true, force: true });
	}
});
