import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { deriveStatus } from "../../src/status/index.ts";
import {
	decodeStatusCache,
	emptyStatusCache,
	readStatusCache,
	sameTreeIdentity,
	STATUS_CACHE_DISPATCH_WRITE_MAX_ATTEMPTS,
	STATUS_CACHE_READBACK_RESIDUAL,
	statusCachePath,
	writeDispatchCacheEntry,
} from "../../src/status/cache.ts";
import { addressKey } from "../../src/plan/index.ts";
import { createObservationalVerifier } from "../../src/verify/index.ts";
import type { StatusCacheDispatchEntry, StatusCacheV1 } from "../../src/status/types.ts";
import { REPO_ROOT } from "../helpers/source-under-test.ts";
import { withDraftLineage } from "../helpers/workspec-source.ts";
import { deterministicCommandOptions } from "../helpers/verifier-command.ts";

const execFileAsync = promisify(execFile);

const SPEC = withDraftLineage(`title: Cache\ndescription: d\nintent: i\nwork:\n  - id: node\n    task: run\n    acceptance:\n      - id: A\n        statement: signal\n        evidence:\n          kind: command\n          run: printf signal\n          expect:\n            exit: 0\n            output_includes: signal\n  - id: dependent\n    task: dependent\n    depends_on: [node]\n    acceptance:\n      - id: B\n        statement: dependent\n        evidence:\n          kind: command\n          run: printf dependent\n          expect:\n            exit: 0\n            output_includes: dependent\n`);

async function repo(source = SPEC): Promise<{ root: string; commit: string }> {
	// Cache tree identities use the canonical git root, not macOS /var -> /private/var.
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-work-status-cache-")));
	await writeFile(path.join(root, "spec.yaml"), withDraftLineage(source, { cwd: root }));
	await execFileAsync("git", ["init", "-q"], { cwd: root });
	await execFileAsync("git", ["add", "-f", "spec.yaml", ".test-dist"], { cwd: root });
	await execFileAsync("git", ["-c", "user.name=pi-work", "-c", "user.email=pi-work@example.invalid", "commit", "-qm", "fixture"], { cwd: root });
	const commit = (await execFileAsync("git", ["rev-parse", "HEAD^{commit}"], { cwd: root })).stdout.trim();
	return { root, commit };
}

async function observedCache(root: string, commit: string): Promise<StatusCacheV1> {
	const verifier = createObservationalVerifier({ command: deterministicCommandOptions() });
	const result = await verifier.verifyNodeAndCache({
		node: {
			id: "node",
			task: "run",
			acceptance: [{ id: "A", statement: "signal", evidence: { kind: "command", run: "printf signal", expect: { exit: 0, output_includes: "signal" } } }],
		},
		specPath: "spec.yaml",
		target: { worktreePath: root, expectedCommit: commit },
	});
	assert.ok(result.cacheUpdate);
	return {
		kind: "pi-work-status-cache",
		version: 1,
		specPath: "spec.yaml",
		verification: { [addressKey(["node"])]: { address: ["node"], update: result.cacheUpdate } },
		review: {},
		dispatch: {},
	};
}

function dispatchEntry(root: string, commit: string, runId: string, nodeId = "node", address: readonly string[] = ["node"]): StatusCacheDispatchEntry {
	const briefPath = path.join(root, ".work", ".cache", "briefs", `${runId}.md`);
	const briefSha256 = "b".repeat(64);
	return {
		runId,
		forkName: `${nodeId}-fork`,
		nodeId,
		address,
		createdAt: "2026-08-13T12:00:00.000Z",
		worktreePath: root,
		headCommit: commit,
		branch: "fixture",
		briefPath,
		briefSha256,
		slot: {
			agent: "implementer",
			workerCwd: root,
			maxRounds: 5,
			confineWrites: true,
			resolvedModel: "test/model",
			skills: ["implement-typescript"],
			inputDigests: [{ kind: "read", name: briefPath, algorithm: "sha256", digest: briefSha256 }],
		},
		receiptPath: path.join(root, "delegate", runId, "receipt.json"),
		resultPath: path.join(root, "delegate", runId, "result.json"),
	};
}

test("cache decoding is strict and deletion-safe", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-work-status-cache-io-"));
	try {
		const cache = emptyStatusCache(path.join(root, "spec.yaml"));
		assert.equal(sameTreeIdentity({ kind: "git", worktreePath: root, resolvedCommit: "a".repeat(40) }, { kind: "git", worktreePath: root, resolvedCommit: "a".repeat(40) }), true);
		assert.equal(statusCachePath(root, path.join(root, "spec.yaml")).startsWith(path.join(root, ".work", ".cache")), true);
		assert.ok(decodeStatusCache(null).findings.some((finding) => finding.code === "malformed-cache"));
		assert.ok(decodeStatusCache({ version: 99 }).findings.some((finding) => finding.code === "unsupported-cache-version"));
		assert.ok(decodeStatusCache({ ...cache, lifecycle: "done" }).findings.some((finding) => finding.code === "malformed-cache"));
		assert.ok(decodeStatusCache({ ...cache, verification: { wrong: { address: ["node"], update: {} } } }).findings.some((finding) => finding.code === "malformed-cache-entry"));
		assert.ok(decodeStatusCache({ ...cache, review: { [addressKey(["node"])]: {} } }).findings.some((finding) => finding.code === "malformed-cache-entry"));
		assert.ok(decodeStatusCache({ ...cache, dispatch: { status: "open" } }).findings.some((finding) => finding.code === "malformed-cache-entry"));
		assert.deepEqual(await readStatusCache(path.join(root, "nested", "status.json")), { findings: [] });
		const directoryRead = await readStatusCache(root);
		assert.equal(directoryRead.cache, undefined);
		assert.ok(directoryRead.findings.some((finding) => finding.code === "cache-read-error"));
		await writeFile(path.join(root, "bad.json"), "{");
		assert.ok((await readStatusCache(path.join(root, "bad.json"))).findings.some((finding) => finding.code === "cache-parse-error"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("dispatch cache decoding accepts the exact receipt contract and rejects unknown or malformed entries", () => {
	const root = path.resolve(os.tmpdir(), "pi-work-dispatch-decode");
	const cache = emptyStatusCache(path.join(root, "spec.yaml"));
	const entry = dispatchEntry(root, "a".repeat(40), "run-1");
	const valid = decodeStatusCache({ ...cache, dispatch: { [entry.runId]: entry } });
	assert.deepEqual(valid.findings, []);
	assert.deepEqual(valid.cache?.dispatch[entry.runId], entry);

	for (const dispatch of [
		{ wrong: entry },
		{ [entry.runId]: { ...entry, unknown: true } },
		{ [entry.runId]: { ...entry, briefSha256: "short" } },
		{ [entry.runId]: { ...entry, slot: { ...entry.slot, maxRounds: 0 } } },
	]) {
		const decoded = decodeStatusCache({ ...cache, dispatch });
		assert.ok(decoded.findings.some((finding) => finding.code === "malformed-cache-entry"));
		assert.equal(Object.keys(decoded.cache?.dispatch ?? {}).length, 0);
	}
});

test("dispatch cache writer preserves the one cache, merges run history, and records the read-back residual", async () => {
	const fixture = await repo();
	try {
		const specPath = path.join(fixture.root, "spec.yaml");
		const cachePath = statusCachePath(fixture.root, specPath);
		const seeded = await observedCache(fixture.root, fixture.commit);
		const reviewKey = addressKey(["node"]);
		const review = {
			address: ["node"],
			verdict: "approved" as const,
			tree: { kind: "git" as const, worktreePath: fixture.root, resolvedCommit: fixture.commit },
			source: "review.txt",
			recordedAt: "2026-08-12T00:00:00.000Z",
		};
		await mkdir(path.dirname(cachePath), { recursive: true });
		await writeFile(cachePath, `${JSON.stringify({ ...seeded, review: { [reviewKey]: review } }, null, 2)}\n`);
		const first = dispatchEntry(fixture.root, fixture.commit, "run-1");
		const second = dispatchEntry(fixture.root, fixture.commit, "run-2", "dependent", ["dependent"]);
		const firstWrite = await writeDispatchCacheEntry(cachePath, specPath, fixture.root, first);
		assert.deepEqual(firstWrite, { status: "written", path: cachePath, attempts: 1, residualRace: STATUS_CACHE_READBACK_RESIDUAL });
		const secondWrite = await writeDispatchCacheEntry(cachePath, specPath, fixture.root, second);
		assert.equal(secondWrite.status, "written");
		const decoded = await readStatusCache(cachePath);
		assert.deepEqual(decoded.findings, []);
		assert.deepEqual(Object.keys(decoded.cache?.dispatch ?? {}), ["run-1", "run-2"]);
		assert.deepEqual(decoded.cache?.verification, seeded.verification);
		assert.deepEqual(decoded.cache?.review, { [reviewKey]: review });
		assert.equal(STATUS_CACHE_DISPATCH_WRITE_MAX_ATTEMPTS, 8);
		const source = await readFile(path.join(REPO_ROOT, "src", "status", "cache.ts"), "utf8");
		assert.match(source, /successful rename is read back before success is reported/);
		assert.match(source, /attempt <= STATUS_CACHE_DISPATCH_WRITE_MAX_ATTEMPTS/);
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test("a concurrent write burst never corrupts the cache and never loses a write silently", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-work-dispatch-concurrent-"));
	try {
		const specPath = path.join(root, "spec.yaml");
		const cachePath = statusCachePath(root, specPath);
		const entries = Array.from({ length: 32 }, (_, index) => dispatchEntry(root, "a".repeat(40), `run-${index}`));
		const results = await Promise.all(entries.map((entry) => writeDispatchCacheEntry(cachePath, specPath, root, entry)));
		const decoded = await readStatusCache(cachePath);
		assert.deepEqual(decoded.findings, []);
		assert.equal(results.some((result) => result.status === "failed"), false);
		const written = entries.filter((_entry, index) => results[index]?.status === "written");
		assert.ok(written.length > 0);

		// `written` means the entry was read back after this writer's rename. It does
		// NOT promise the entry survives to the end of the burst: a writer that
		// snapshotted earlier may rename its own merged copy over the top afterwards.
		// src/status/cache.ts names that residual, and every non-failed result carries
		// it, so asserting final presence here would fail on correct product code.
		for (const result of results) {
			if (result.status === "failed") continue;
			assert.equal(result.residualRace, STATUS_CACHE_READBACK_RESIDUAL, "every non-failed write must declare the read-back residual");
		}

		// What the burst must still guarantee: whatever survived is exactly what some
		// writer wrote, never a merged, torn, or invented entry.
		const survivors = Object.entries(decoded.cache?.dispatch ?? {});
		assert.ok(survivors.length > 0, "a burst in which every write vanished would mean the cache never landed");
		const byRunId = new Map(entries.map((entry) => [entry.runId, entry]));
		for (const [runId, survivor] of survivors) {
			assert.deepEqual(survivor, byRunId.get(runId), `${runId} survived in a shape no writer wrote`);
		}

		// A write reported written may be displaced, but only by the residual above:
		// some other writer's entry must occupy the cache in its place. Losing a
		// written entry while the burst as a whole recorded nothing new would be a
		// real defect, and this is the assertion that would catch it.
		const displaced = written.filter((entry) => decoded.cache?.dispatch[entry.runId] === undefined);
		if (displaced.length > 0) {
			const survivingRunIds = new Set(survivors.map(([runId]) => runId));
			assert.ok(
				displaced.every((entry) => !survivingRunIds.has(entry.runId)),
				"a displaced entry cannot also be present",
			);
			assert.ok(survivors.some(([runId]) => !displaced.some((entry) => entry.runId === runId)), `${displaced.length} written entr(y|ies) were displaced but no other writer's entry took their place`);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("dispatch cache writer fails closed instead of overwriting malformed or conflicting run data", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-work-dispatch-write-failure-"));
	try {
		const specPath = path.join(root, "spec.yaml");
		const cachePath = statusCachePath(root, specPath);
		await mkdir(path.dirname(cachePath), { recursive: true });
		await writeFile(cachePath, "{broken");
		const malformed = await writeDispatchCacheEntry(cachePath, specPath, root, dispatchEntry(root, "a".repeat(40), "run-1"));
		assert.equal(malformed.status, "failed");
		if (malformed.status === "failed") assert.equal(malformed.reason, "malformed-cache");
		assert.equal(await readFile(cachePath, "utf8"), "{broken");

		const entry = dispatchEntry(root, "a".repeat(40), "run-1");
		await writeFile(cachePath, JSON.stringify({ ...emptyStatusCache(specPath), dispatch: { [entry.runId]: entry } }));
		const beforeConflict = await readFile(cachePath, "utf8");
		const conflict = await writeDispatchCacheEntry(cachePath, specPath, root, { ...entry, forkName: "different" });
		assert.equal(conflict.status, "failed");
		if (conflict.status === "failed") assert.equal(conflict.reason, "run-id-conflict");
		assert.equal(await readFile(cachePath, "utf8"), beforeConflict);
		assert.deepEqual((await readStatusCache(cachePath)).cache?.dispatch[entry.runId], entry);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("every malformed persisted section is rejected with a finding and ignored", async () => {
	const fixture = await repo();
	try {
		const valid = await observedCache(fixture.root, fixture.commit);
		const key = addressKey(["node"]);
		const entry = valid.verification[key];
		assert.ok(entry);
		const tree = { kind: "git" as const, worktreePath: fixture.root, resolvedCommit: fixture.commit };
		const review = { address: ["node"], verdict: "approved" as const, tree, source: "review.txt", recordedAt: "2026-08-12T00:00:00.000Z" };
		const cases: readonly { name: string; cache: unknown; code: string; ignored: (decoded: Awaited<ReturnType<typeof readStatusCache>>) => boolean }[] = [
			{
				name: "verification key mismatch",
				cache: { ...valid, verification: { wrong: entry } },
				code: "malformed-cache-entry",
				ignored: (decoded) => decoded.cache?.verification.wrong === undefined,
			},
			{
				name: "verification decoder failure",
				cache: { ...valid, verification: { [key]: { address: ["node"], update: {} } } },
				code: "malformed-cache-entry",
				ignored: (decoded) => decoded.cache?.verification[key] === undefined,
			},
			{
				name: "review key mismatch",
				cache: { ...valid, review: { wrong: review } },
				code: "malformed-cache-entry",
				ignored: (decoded) => decoded.cache?.review.wrong === undefined,
			},
			{
				name: "review decoder failure",
				cache: { ...valid, review: { [key]: { ...review, recordedAt: "not-a-date" } } },
				code: "malformed-cache-entry",
				ignored: (decoded) => decoded.cache?.review[key] === undefined,
			},
			{
				name: "dispatch decoder failure",
				cache: { ...valid, dispatch: { status: "open" } },
				code: "malformed-cache-entry",
				ignored: (decoded) => Object.keys(decoded.cache?.dispatch ?? {}).length === 0,
			},
		];
		for (const testCase of cases) {
			const result = decodeStatusCache(testCase.cache, testCase.name);
			assert.ok(result.findings.some((finding) => finding.code === testCase.code), testCase.name);
			assert.equal(testCase.ignored({ ...(result.cache === undefined ? {} : { cache: result.cache }), findings: result.findings }), true, testCase.name);
		}
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test("raw duplicate verification and review addresses are findings and ignored", async () => {
	const fixture = await repo();
	try {
		const observed = await observedCache(fixture.root, fixture.commit);
		const key = addressKey(["node"]);
		const entry = observed.verification[key];
		assert.ok(entry);
		const review = { address: ["node"], verdict: "approved", tree: { kind: "git", worktreePath: fixture.root, resolvedCommit: fixture.commit }, source: "review.txt", recordedAt: "2026-08-12T00:00:00.000Z" };
		const raw = `{"kind":"pi-work-status-cache","version":1,"specPath":"spec.yaml","verification":{${JSON.stringify(key)}:${JSON.stringify(entry)},${JSON.stringify(key)}:${JSON.stringify(entry)}},"review":{${JSON.stringify(key)}:${JSON.stringify(review)},${JSON.stringify(key)}:${JSON.stringify(review)}},"dispatch":{}}`;
		const cachePath = statusCachePath(fixture.root, path.join(fixture.root, "spec.yaml"));
		await mkdir(path.dirname(cachePath), { recursive: true });
		await writeFile(cachePath, raw);
		const decoded = await readStatusCache(cachePath);
		assert.equal(decoded.findings.filter((finding) => finding.code === "cache-duplicate-address").length, 2);
		assert.equal(decoded.cache?.verification[key], undefined);
		assert.equal(decoded.cache?.review[key], undefined);
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test("cache binding findings cover source, address, and review conflicts", async () => {
	const fixture = await repo();
	try {
		const source = await readFile(path.join(fixture.root, "spec.yaml"), "utf8");
		const tree = { kind: "git" as const, worktreePath: fixture.root, resolvedCommit: fixture.commit };
		const base = await observedCache(fixture.root, fixture.commit);
		const key = addressKey(["node"]);
		const baseEntry = base.verification[key];
		assert.ok(baseEntry);
		const baseline = deriveStatus({ source, specPath: path.join(fixture.root, "spec.yaml"), tree });
		const assertRejected = (result: ReturnType<typeof deriveStatus>, expectedVerification: string = "unverified", expectedReview = "not-configured") => {
			const node = result.details.nodes.find((entry) => entry.nodeId === "node");
			const dependent = result.details.nodes.find((entry) => entry.nodeId === "dependent");
			assert.equal(node?.verification, expectedVerification);
			assert.notEqual(node?.verification, "verified-this-session");
			assert.equal(node?.review, expectedReview);
			assert.equal(node?.lifecycle, baseline.details.nodes.find((entry) => entry.nodeId === "node")?.lifecycle);
			assert.equal(dependent?.lifecycle, baseline.details.nodes.find((entry) => entry.nodeId === "dependent")?.lifecycle);
			assert.equal(result.details.specState, baseline.details.specState);
		};
		const sourceMismatch = { ...base, specPath: "other.yaml" };
		const sourceMismatchResult = deriveStatus({ source, specPath: path.join(fixture.root, "spec.yaml"), tree, cache: sourceMismatch });
		assert.ok(sourceMismatchResult.details.findings.some((finding) => finding.code === "cache-source-mismatch"));
		assertRejected(sourceMismatchResult);
		const unknown = { ...base, verification: { [addressKey(["ghost"])]: { address: ["ghost"], update: baseEntry.update } } };
		const unknownResult = deriveStatus({ source, specPath: path.join(fixture.root, "spec.yaml"), tree, cache: unknown });
		assert.ok(unknownResult.details.findings.some((finding) => finding.code === "cache-unknown-address"));
		assertRejected(unknownResult);
		const wrongNodeUpdate = JSON.parse(JSON.stringify(baseEntry.update)) as Record<string, unknown>;
		wrongNodeUpdate.nodeId = "wrong";
		(wrongNodeUpdate.record as Record<string, unknown>).nodeId = "wrong";
		const wrongNode = { ...base, verification: { [key]: { address: ["node"], update: wrongNodeUpdate as unknown as typeof baseEntry.update } } };
		const wrongNodeResult = deriveStatus({ source, specPath: path.join(fixture.root, "spec.yaml"), tree, cache: wrongNode });
		assert.ok(wrongNodeResult.details.findings.some((finding) => finding.code === "cache-address-mismatch"));
		assertRejected(wrongNodeResult);
		const wrongSpecUpdate = JSON.parse(JSON.stringify(baseEntry.update)) as Record<string, unknown>;
		wrongSpecUpdate.specPath = "other.yaml";
		const wrongSpec = { ...base, verification: { [key]: { address: ["node"], update: wrongSpecUpdate as unknown as typeof baseEntry.update } } };
		const wrongSpecResult = deriveStatus({ source, specPath: path.join(fixture.root, "spec.yaml"), tree, cache: wrongSpec });
		assert.ok(wrongSpecResult.details.findings.some((finding) => finding.code === "cache-source-mismatch"));
		assertRejected(wrongSpecResult);
		const evidenceConflict = JSON.parse(JSON.stringify(baseEntry.update)) as Record<string, unknown>;
		const evidenceRecord = evidenceConflict.record as Record<string, unknown>;
		const evidenceCriterion = (evidenceRecord.criteria as Array<Record<string, unknown>>)[0];
		assert.ok(evidenceCriterion);
		(evidenceCriterion.proof as Record<string, unknown>).authoredCommand = "printf changed";
		const evidenceMismatch = { ...base, verification: { [key]: { address: ["node"], update: evidenceConflict as unknown as typeof baseEntry.update } } };
		const evidenceMismatchResult = deriveStatus({ source, specPath: path.join(fixture.root, "spec.yaml"), tree, cache: evidenceMismatch });
		assert.ok(evidenceMismatchResult.details.findings.some((finding) => finding.code === "cache-source-conflict"));
		assertRejected(evidenceMismatchResult, "conflicting-observation");
		const review = { address: ["node"], verdict: "approved" as const, tree, source: "review.txt", recordedAt: "2026-08-12T00:00:00.000Z" };
		const withReview = { ...base, review: { [key]: review } };
		const reviewResult = deriveStatus({ source, specPath: path.join(fixture.root, "spec.yaml"), tree, cache: withReview });
		assert.equal(reviewResult.details.nodes.find((node) => node.nodeId === "node")?.review, "observed-approval-not-authoritative");
		assert.equal(reviewResult.details.nodes.find((node) => node.nodeId === "node")?.lifecycle, "ready");
		const unknownReview = { ...base, verification: {}, review: { [addressKey(["ghost"])]: { ...review, address: ["ghost"] } } };
		const unknownReviewResult = deriveStatus({ source, specPath: path.join(fixture.root, "spec.yaml"), tree, cache: unknownReview });
		assert.ok(unknownReviewResult.details.findings.some((finding) => finding.code === "cache-unknown-address"));
		assertRejected(unknownReviewResult);
		const staleReview = { ...base, review: { [key]: { ...review, tree: { ...tree, resolvedCommit: "0".repeat(40) } } } };
		assert.equal(deriveStatus({ source, specPath: path.join(fixture.root, "spec.yaml"), tree, cache: staleReview }).details.nodes.find((node) => node.nodeId === "node")?.review, "not-configured");
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test("command timeout is bound to observed cache evidence, not replayed for another timeout", async () => {
	const source = SPEC.replace("          run: printf signal\n", "          run: printf signal\n          timeout_ms: 3000\n");
	const fixture = await repo(source);
	try {
		const proofNode = { id: "node", task: "run", acceptance: [{ id: "A", statement: "signal", evidence: { kind: "command" as const, run: "printf signal", expect: { exit: 0, output_includes: "signal" }, timeout_ms: 3000 } }] };
		const verifier = createObservationalVerifier({ command: deterministicCommandOptions() });
		const result = await verifier.verifyNodeAndCache({ node: proofNode, specPath: "spec.yaml", target: { worktreePath: fixture.root, expectedCommit: fixture.commit } });
		assert.equal(result.result.outcome, "passed");
		assert.ok(result.cacheUpdate);
		const cache = { ...emptyStatusCache("spec.yaml"), verification: { [addressKey(["node"])]: { address: ["node"], update: result.cacheUpdate } } };
		const tree = { kind: "git" as const, worktreePath: fixture.root, resolvedCommit: fixture.commit };
		const original = deriveStatus({ source: await readFile(path.join(fixture.root, "spec.yaml"), "utf8"), specPath: path.join(fixture.root, "spec.yaml"), tree, cache });
		assert.equal(original.details.findings.some((finding) => finding.code === "cache-source-conflict"), false);
		for (const changed of [SPEC, source.replace("timeout_ms: 3000", "timeout_ms: 5000")]) {
			const outcome = deriveStatus({ source: withDraftLineage(changed, { cwd: fixture.root }), specPath: path.join(fixture.root, "spec.yaml"), tree, cache });
			assert.ok(outcome.details.findings.some((finding) => finding.code === "cache-source-conflict"), changed);
			assert.equal(outcome.details.nodes.find((node) => node.nodeId === "node")?.verification, "conflicting-observation");
		}
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test("ambiguous bare-id observations cannot be relabeled across qualified addresses", async () => {
	const source = withDraftLineage(`title: Duplicate\ndescription: d\nintent: i\nwork:\n  - id: api\n    task: API\n    work:\n      - id: test\n        task: tests\n        acceptance:\n          - id: api-A\n            statement: signal\n            evidence:\n              kind: command\n              run: printf signal\n              expect:\n                exit: 0\n                output_includes: signal\n  - id: ui\n    task: UI\n    work:\n      - id: test\n        task: tests\n        acceptance:\n          - id: ui-A\n            statement: signal\n            evidence:\n              kind: command\n              run: printf signal\n              expect:\n                exit: 0\n                output_includes: signal\n`);
	const fixture = await repo(source);
	try {
		const rootedSource = await readFile(path.join(fixture.root, "spec.yaml"), "utf8");
		const verifier = createObservationalVerifier({ command: deterministicCommandOptions() });
		const result = await verifier.verifyNodeAndCache({
			node: { id: "test", task: "tests", acceptance: [{ id: "A", statement: "signal", evidence: { kind: "command", run: "printf signal", expect: { exit: 0, output_includes: "signal" } } }] },
			specPath: "spec.yaml",
			target: { worktreePath: fixture.root, expectedCommit: fixture.commit },
		});
		assert.ok(result.cacheUpdate);
		const cache: StatusCacheV1 = {
			kind: "pi-work-status-cache",
			version: 1,
			specPath: "spec.yaml",
			verification: { [addressKey(["ui", "test"])]: { address: ["ui", "test"], update: result.cacheUpdate } },
			review: {},
			dispatch: {},
		};
		const sourceResult = deriveStatus({ source: rootedSource, specPath: path.join(fixture.root, "spec.yaml"), tree: { kind: "git", worktreePath: fixture.root, resolvedCommit: fixture.commit }, cache });
		const ui = sourceResult.details.nodes.find((node) => node.address.join("/") === "ui/test");
		assert.equal(ui?.verification, "unverified");
		assert.ok(sourceResult.details.findings.some((finding) => finding.code === "ambiguous-node-id" && finding.addresses.some((address) => address.join("/") === "api/test") && finding.addresses.some((address) => address.join("/") === "ui/test")));
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test("observed cache can report green but cannot satisfy lifecycle or dependency gates", async () => {
	const fixture = await repo();
	try {
		const cache = await observedCache(fixture.root, fixture.commit);
		const source = await readFile(path.join(fixture.root, "spec.yaml"), "utf8");
		const result = deriveStatus({ source, specPath: path.join(fixture.root, "spec.yaml"), tree: { kind: "git", worktreePath: fixture.root, resolvedCommit: fixture.commit }, cache });
		const node = result.details.nodes.find((entry) => entry.address.join("/") === "node");
		const dependent = result.details.nodes.find((entry) => entry.address.join("/") === "dependent");
		assert.equal(node?.verification, "observed-green-not-verified-this-session");
		assert.equal(node?.lifecycle, "ready");
		assert.equal(dependent?.lifecycle, "blocked");
		assert.equal(result.details.specState, "not-done");
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test("failed observations remain explicitly non-authoritative", async () => {
	const fixture = await repo();
	try {
		const verifier = createObservationalVerifier({ command: deterministicCommandOptions() });
		const update = await verifier.verifyNodeAndCache({
			node: { id: "node", task: "run", acceptance: [{ id: "A", statement: "signal", evidence: { kind: "command", run: "printf signal", expect: { exit: 0, output_includes: "never" } } }] },
			specPath: "spec.yaml",
			target: { worktreePath: fixture.root, expectedCommit: fixture.commit },
		});
		assert.ok(update.cacheUpdate);
		const source = withDraftLineage(`title: failed\ndescription: d\nintent: i\nwork:\n  - id: node\n    task: run\n    acceptance:\n      - id: A\n        statement: signal\n        evidence:\n          kind: command\n          run: printf signal\n          expect:\n            exit: 0\n            output_includes: never\n`, { cwd: fixture.root });
		const cache: StatusCacheV1 = { kind: "pi-work-status-cache", version: 1, specPath: "spec.yaml", verification: { [addressKey(["node"])]: { address: ["node"], update: update.cacheUpdate } }, review: {}, dispatch: {} };
		const result = deriveStatus({ source, specPath: path.join(fixture.root, "spec.yaml"), tree: { kind: "git", worktreePath: fixture.root, resolvedCommit: fixture.commit }, cache });
		assert.equal(result.details.nodes[0]?.verification, "observed-failure-not-verified-this-session");
		assert.equal(result.details.nodes[0]?.lifecycle, "ready");
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test("a hand-written exact-tree green record is still only observed and never runs its claimed command", async () => {
	const fixture = await repo();
	const marker = path.join(fixture.root, "claimed-marker");
	try {
		const source = withDraftLineage(`title: fabricated\ndescription: d\nintent: i\nwork:\n  - id: node\n    task: run\n    acceptance:\n      - id: A\n        statement: signal\n        evidence:\n          kind: command\n          run: printf ok; touch ${marker}\n          expect:\n            exit: 0\n            output_includes: ok\n  - id: dependent\n    task: dependent\n    depends_on: [node]\n    acceptance:\n      - id: B\n        statement: dependent\n        evidence:\n          kind: command\n          run: printf dependent\n          expect:\n            exit: 0\n            output_includes: dependent\n`, { cwd: fixture.root });
		const raw = await readFile(path.join(REPO_ROOT, "tests", "fixtures", "status", "fabricated-observed-green.json"), "utf8");
		const update = JSON.parse(raw.replaceAll("__WORKTREE__", fixture.root).replaceAll("__COMMIT__", fixture.commit).replaceAll("__MARKER__", marker));
		const cache: StatusCacheV1 = {
			kind: "pi-work-status-cache",
			version: 1,
			specPath: "spec.yaml",
			verification: { [addressKey(["node"])]: { address: ["node"], update } },
			review: {},
			dispatch: {},
		};
		const result = deriveStatus({ source, specPath: path.join(fixture.root, "spec.yaml"), tree: { kind: "git", worktreePath: fixture.root, resolvedCommit: fixture.commit }, cache });
		assert.equal(result.details.nodes.find((node) => node.nodeId === "node")?.verification, "observed-green-not-verified-this-session");
		assert.equal(result.details.nodes.find((node) => node.nodeId === "node")?.lifecycle, "ready");
		assert.equal(result.details.nodes.find((node) => node.nodeId === "dependent")?.lifecycle, "blocked");
		await assert.rejects(access(marker));
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test("source conflict and exact tree mismatch never carry observations forward", async () => {
	const fixture = await repo();
	try {
		const cache = await observedCache(fixture.root, fixture.commit);
		const entry = cache.verification[addressKey(["node"])];
		assert.ok(entry);
		const conflictJson = JSON.parse(JSON.stringify(entry.update)) as Record<string, unknown>;
		const conflictRecord = conflictJson.record as Record<string, unknown>;
		const criteria = conflictRecord.criteria as Array<Record<string, unknown>>;
		const criterion = criteria[0];
		assert.ok(criterion);
		criterion.criterion = { id: "A", statement: "changed source" };
		const conflicting: StatusCacheV1 = { ...cache, verification: { ...cache.verification, [addressKey(["node"])]: { ...entry, update: conflictJson as unknown as typeof entry.update } } };
		const source = await readFile(path.join(fixture.root, "spec.yaml"), "utf8");
		const conflictResult = deriveStatus({ source, specPath: path.join(fixture.root, "spec.yaml"), tree: { kind: "git", worktreePath: fixture.root, resolvedCommit: fixture.commit }, cache: conflicting });
		assert.equal(conflictResult.details.nodes.find((node) => node.nodeId === "node")?.verification, "conflicting-observation");
		assert.ok(conflictResult.details.findings.some((finding) => finding.code === "cache-source-conflict"));

		const stale = await observedCache(fixture.root, fixture.commit);
		const staleEntry = stale.verification[addressKey(["node"])];
		assert.ok(staleEntry);
		const staleJson = JSON.parse(JSON.stringify(staleEntry.update)) as Record<string, unknown>;
		const oldTree = { kind: "git", worktreePath: fixture.root, resolvedCommit: "0".repeat(40) };
		const staleRecord = staleJson.record as Record<string, unknown>;
		staleJson.tree = oldTree;
		staleRecord.tree = oldTree;
		staleRecord.checklist = { ...(staleRecord.checklist as object), tree: oldTree };
		staleRecord.criteria = (staleRecord.criteria as Array<Record<string, unknown>>).map((criterion) => ({ ...criterion, proof: { ...(criterion.proof as object), tree: oldTree } }));
		const staleCache: StatusCacheV1 = { ...stale, verification: { ...stale.verification, [addressKey(["node"])]: { ...staleEntry, update: staleJson as unknown as typeof staleEntry.update } } };
		const staleResult = deriveStatus({ source, specPath: path.join(fixture.root, "spec.yaml"), tree: { kind: "git", worktreePath: fixture.root, resolvedCommit: fixture.commit }, cache: staleCache });
		assert.equal(staleResult.details.nodes.find((node) => node.nodeId === "node")?.verification, "stale-observation");
		assert.ok(staleResult.details.findings.some((finding) => finding.code === "stale-cache-observation"));
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test("deleting observations does not change derived lifecycle answers", async () => {
	const fixture = await repo();
	try {
		const source = await readFile(path.join(fixture.root, "spec.yaml"), "utf8");
		const tree = { kind: "git" as const, worktreePath: fixture.root, resolvedCommit: fixture.commit };
		const withoutCache = deriveStatus({ source, specPath: path.join(fixture.root, "spec.yaml"), tree });
		const withObservation = deriveStatus({ source, specPath: path.join(fixture.root, "spec.yaml"), tree, cache: await observedCache(fixture.root, fixture.commit) });
		assert.deepEqual(withObservation.details.nodes.map((node) => node.lifecycle), withoutCache.details.nodes.map((node) => node.lifecycle));
		assert.equal(withObservation.details.specState, withoutCache.details.specState);
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});
