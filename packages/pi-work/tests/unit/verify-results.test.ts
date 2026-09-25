import assert from "node:assert/strict";
import test from "node:test";

import { decodeVerificationCacheUpdate, isCompleteChecklist, isCriterionPassed, isNodePassed, isObservedNodePassed, type CriterionResult, type NodeVerificationRecord, type TreeIdentity } from "../../src/verify/index.ts";
import { verifyChecklist } from "../../src/verify/checklist.ts";
import { validCommandContainment } from "../../src/verify/containment.ts";

const tree: TreeIdentity = { kind: "git", worktreePath: "/tmp/work", resolvedCommit: "a".repeat(40) };
const monitoring = { method: "fs.watch" as const, mode: "recursive" as const, window: { startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:00.001Z", durationMs: 1 }, residualRace: "events-after-final-drain-may-be-missed" as const };

const forged: NodeVerificationRecord = {
	outcome: "passed",
	nodeId: "n1",
	tree,
	criteria: [{
		// @ts-expect-error A passed node cannot contain a failed criterion.
		outcome: "failed",
		criterion: { id: "c1", statement: "never ran" },
		attempt: { kind: "command", evidence: { kind: "command", run: "false", expect: { exit: 0 } }, startedAt: "2026-01-01", finishedAt: "2026-01-01", tree },
		failures: [{ code: "no-execution-evidence", message: "nothing executed" }],
	}],
	// @ts-expect-error A passed node cannot contain an incomplete checklist.
	checklist: { outcome: "incomplete", items: [], failures: [], tree },
	recordedAt: "2026-01-01",
};
void forged;

test("authority and cache validators agree on command containment", () => {
	const shell = "/bin/sh";
	const scope = "/usr/bin/systemd-run";
	assert.equal(validCommandContainment("process-group", shell, shell), true);
	assert.equal(validCommandContainment("process-group", scope, shell), false);
	assert.equal(validCommandContainment("systemd-scope", scope, shell), true);
	assert.equal(validCommandContainment("systemd-scope", shell, shell), false);
	assert.equal(validCommandContainment("unrecognized", scope, shell), false);
	// Old persisted Linux proofs omitted the field, regardless of executor path.
	assert.equal(validCommandContainment(undefined, scope, shell), true);
	assert.equal(validCommandContainment(undefined, shell, shell), true);
});

test("cache decoder rejects forged green records and tree disagreement", () => {
	const base = {
		kind: "verification-cache-update",
		specPath: "spec.yaml",
		nodeId: "n1",
		recordedAt: "2026-01-01T00:00:00.000Z",
		tree,
		record: {
			outcome: "passed",
			nodeId: "n1",
			tree,
			criteria: [{
				outcome: "passed",
				criterion: { id: "c1", statement: "signal" },
				startedAt: "2026-01-01T00:00:00.000Z",
				finishedAt: "2026-01-01T00:00:00.001Z",
				durationMs: 1,
				proof: {
					kind: "command-proof", authoredCommand: "printf signal", gitPath: "/usr/bin/git", executorPath: "/usr/bin/systemd-run", shellPath: "/bin/sh", expectation: { exit: 0, output_includes: "signal" }, stdout: "signal", stderr: "", exitCode: 0, signal: null, outputMatched: "signal", untrackedPaths: [], monitoring, startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:00.001Z", durationMs: 1, tree,
				},
			}],
		checklist: { outcome: "complete", items: [], failures: [], tree },
			recordedAt: "2026-01-01T00:00:00.000Z",
		},
	};
	// Legacy persisted Linux proofs omitted containment; decoding remains observational.
	const decoded = decodeVerificationCacheUpdate(base);
	assert.ok(decoded);
	const legacyShell = structuredClone(base);
	legacyShell.record.criteria[0].proof.executorPath = "/bin/sh";
	assert.ok(decodeVerificationCacheUpdate(legacyShell));
	const processGroup = structuredClone(base) as unknown as { record: { criteria: [{ proof: Record<string, unknown> }] } };
	const groupProof = processGroup.record.criteria[0].proof;
	groupProof.containment = "process-group";
	groupProof.executorPath = "/bin/sh";
	const decodedGroup = decodeVerificationCacheUpdate(JSON.parse(JSON.stringify(processGroup)));
	assert.ok(decodedGroup);
	if (decodedGroup?.record.outcome === "passed") {
		const proof = decodedGroup.record.criteria[0]?.proof;
		assert.equal(proof?.kind === "command-proof" && proof.containment, "process-group");
	}
	groupProof.executorPath = "/usr/bin/systemd-run";
	assert.equal(decodeVerificationCacheUpdate(processGroup), undefined);
	groupProof.containment = "unknown-containment";
	assert.equal(decodeVerificationCacheUpdate(processGroup), undefined);
	groupProof.containment = "systemd-scope";
	assert.ok(decodeVerificationCacheUpdate(processGroup));
	const wrongScope = structuredClone(base) as unknown as { record: { criteria: [{ proof: Record<string, unknown> }] } };
	const wrongScopeProof = wrongScope.record.criteria[0].proof;
	wrongScopeProof.containment = "systemd-scope";
	wrongScopeProof.executorPath = wrongScopeProof.shellPath;
	assert.equal(decodeVerificationCacheUpdate(wrongScope), undefined);
	if (decoded) {
		assert.equal(decoded.record.outcome, "passed");
		assert.equal(decoded.record.tree.resolvedCommit, tree.resolvedCommit);
		const failedCriterion: CriterionResult = { outcome: "failed", criterion: { id: "c1", statement: "not passed" }, attempt: { kind: "command", evidence: { kind: "command", run: "false", expect: { exit: 1, output_includes: "failure" } }, startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:00.001Z", tree }, failures: [{ code: "exit-mismatch", message: "not passed", expected: 1, actual: 0 }] };
		assert.equal(isCriterionPassed(failedCriterion), false);
	}
	const unknownProof = structuredClone(base) as Record<string, unknown>;
	const unknownCriterion = (unknownProof.record as Record<string, unknown>).criteria as Array<Record<string, unknown>>;
	const unknown = unknownCriterion[0]?.proof as Record<string, unknown>;
	if (unknown) {
		unknown.kind = "unknown-proof";
		assert.equal(decodeVerificationCacheUpdate(unknownProof), undefined);
	}
	const forgedGreen = structuredClone(base) as Record<string, unknown>;
	const record = forgedGreen.record as Record<string, unknown>;
	record.criteria = [{ outcome: "failed", criterion: { id: "c1", statement: "never ran" }, attempt: { kind: "command", evidence: { kind: "command", run: "false", expect: { exit: 0 } }, startedAt: "2026-01-01", finishedAt: "2026-01-01", tree }, failures: [{ code: "no-execution-evidence", message: "nothing" }] }];
	assert.equal(decodeVerificationCacheUpdate(forgedGreen), undefined);
	const mismatched = structuredClone(base) as Record<string, unknown>;
	const mismatchRecord = mismatched.record as Record<string, unknown>;
	mismatchRecord.tree = { ...tree, resolvedCommit: "b".repeat(40) };
	assert.equal(decodeVerificationCacheUpdate(mismatched), undefined);
	assert.equal(decodeVerificationCacheUpdate(null), undefined);
	assert.equal(decodeVerificationCacheUpdate({ kind: "other" }), undefined);
	const incomplete = structuredClone(base) as Record<string, unknown>;
	const incompleteRecord = incomplete.record as Record<string, unknown>;
	incompleteRecord.outcome = "failed";
	incompleteRecord.criteria = [{ outcome: "failed", criterion: { id: "c1", statement: "no" }, attempt: { kind: "command", evidence: { kind: "command", run: "false", expect: { exit: 0 } }, startedAt: "2026-01-01", finishedAt: "2026-01-01", tree }, failures: [{ code: "exit-mismatch", message: "no", expected: 0, actual: 1 }] }];
	incompleteRecord.checklist = { outcome: "incomplete", items: [], failures: [{ code: "checklist-accounting", message: "missing" }], tree };
	const decodedFailure = decodeVerificationCacheUpdate(incomplete);
	assert.ok(decodedFailure);
	if (decodedFailure) assert.equal(decodedFailure.record.outcome, "failed");
	const agent = structuredClone(base) as unknown as { record: { criteria: [{ proof: Record<string, unknown> }] } };
	agent.record.criteria[0].proof = { kind: "agent-proof", agent: "reviewer", rubric: "inspect", rubricDigest: "14a60637758cb026afd2fe447f3648a07965072eeefaa9ee57734959bce8ae2b", inputs: [{ path: "diagram.bin", digest: "0bf474896363505e5ea5e5d6ace8ebfb13a760a409b1fb467d428fc716f9f284", bytes: 4 }], verdict: "approve", dispatchReceipt: "receipt", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:00.001Z", durationMs: 1, tree };
	assert.ok(decodeVerificationCacheUpdate(agent));
	const user = structuredClone(base) as unknown as { record: { criteria: [{ proof: Record<string, unknown> }] } };
	user.record.criteria[0].proof = { kind: "user-proof", prompt: "sent", challenge: "challenge", sessionId: "session", sessionFile: "/tmp/session", entryId: "entry", entryTimestamp: "2026-01-01T00:00:00.000Z", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:00.001Z", durationMs: 1, tree };
	assert.ok(decodeVerificationCacheUpdate(user));
	const badCommand = structuredClone(base) as Record<string, unknown>;
	const badCommandRecord = badCommand.record as Record<string, unknown>;
	const badCommandCriterion = (badCommandRecord.criteria as Array<Record<string, unknown>>)[0];
	const badCommandProof = badCommandCriterion?.proof as Record<string, unknown>;
	if (badCommandProof) {
		badCommandProof.outputMatched = "";
		assert.equal(decodeVerificationCacheUpdate(badCommand), undefined);
		badCommandProof.outputMatched = "signal";
		badCommandProof.executorPath = "systemd-run";
		assert.equal(decodeVerificationCacheUpdate(badCommand), undefined);
		badCommandProof.executorPath = "/usr/bin/systemd-run";
		badCommandProof.untrackedPaths = [1];
		assert.equal(decodeVerificationCacheUpdate(badCommand), undefined);
		badCommandProof.untrackedPaths = [];
		badCommandProof.signal = "SIGTERM";
		assert.equal(decodeVerificationCacheUpdate(badCommand), undefined);
		badCommandProof.signal = null;
		badCommandProof.tree = { ...tree, worktreePath: "/other" };
		assert.equal(decodeVerificationCacheUpdate(badCommand), undefined);
	}
	const badChecklist = structuredClone(base) as Record<string, unknown>;
	const badChecklistRecord = badChecklist.record as Record<string, unknown>;
	badChecklistRecord.checklist = { outcome: "complete", items: [{ index: 0, item: "must run", done: false, tree }], failures: [], tree };
	assert.equal(decodeVerificationCacheUpdate(badChecklist), undefined);
	const invalidTree = structuredClone(base) as Record<string, unknown>;
	(invalidTree.record as Record<string, unknown>).tree = null;
	assert.equal(decodeVerificationCacheUpdate(invalidTree), undefined);
	const unknownTree = structuredClone(base) as Record<string, unknown>;
	(unknownTree.record as Record<string, unknown>).tree = { kind: "other" };
	assert.equal(decodeVerificationCacheUpdate(unknownTree), undefined);
	const invalidWindow = structuredClone(base) as Record<string, unknown>;
	const invalidWindowCriterion = ((invalidWindow.record as Record<string, unknown>).criteria as Array<Record<string, unknown>>)[0]!;
	invalidWindowCriterion.startedAt = "not-a-timestamp";
	assert.equal(decodeVerificationCacheUpdate(invalidWindow), undefined);
	const negativeWindow = structuredClone(base) as Record<string, unknown>;
	const negativeWindowCriterion = ((negativeWindow.record as Record<string, unknown>).criteria as Array<Record<string, unknown>>)[0]!;
	negativeWindowCriterion.durationMs = -1;
	assert.equal(decodeVerificationCacheUpdate(negativeWindow), undefined);
	const invalidSummary = structuredClone(base) as Record<string, unknown>;
	const invalidSummaryCriterion = ((invalidSummary.record as Record<string, unknown>).criteria as Array<Record<string, unknown>>)[0]!;
	invalidSummaryCriterion.criterion = { id: "", statement: "signal" };
	assert.equal(decodeVerificationCacheUpdate(invalidSummary), undefined);
	const invalidCriterion = structuredClone(base) as Record<string, unknown>;
	(invalidCriterion.record as Record<string, unknown>).criteria = [null];
	assert.equal(decodeVerificationCacheUpdate(invalidCriterion), undefined);
	const invalidChecklistItem = structuredClone(base) as Record<string, unknown>;
	(invalidChecklistItem.record as Record<string, unknown>).checklist = { outcome: "complete", items: [{ index: "zero", item: "must run", done: true, tree }], failures: [], tree };
	assert.equal(decodeVerificationCacheUpdate(invalidChecklistItem), undefined);
	const emptyIncompleteFailures = structuredClone(base) as Record<string, unknown>;
	(emptyIncompleteFailures.record as Record<string, unknown>).checklist = { outcome: "incomplete", items: [], failures: [], tree };
	assert.equal(decodeVerificationCacheUpdate(emptyIncompleteFailures), undefined);
	const failedWithPassedCriterion = structuredClone(base) as Record<string, unknown>;
	(failedWithPassedCriterion.record as Record<string, unknown>).outcome = "failed";
	assert.equal(decodeVerificationCacheUpdate(failedWithPassedCriterion), undefined);
	const emptyPassedCriteria = structuredClone(base) as Record<string, unknown>;
	(emptyPassedCriteria.record as Record<string, unknown>).criteria = [];
	assert.equal(decodeVerificationCacheUpdate(emptyPassedCriteria), undefined);
});

test("cache decoder rejects an impossible command proof before restoring trust", () => {
	const raw = {
		kind: "verification-cache-update",
		specPath: "spec.yaml",
		nodeId: "n1",
		recordedAt: "2026-01-01T00:00:00.000Z",
		tree,
		record: {
			outcome: "passed",
			nodeId: "n1",
			tree,
			criteria: [{
				outcome: "passed",
				criterion: { id: "c1", statement: "false must run" },
				startedAt: "2026-01-01T00:00:00.000Z",
				finishedAt: "2026-01-01T00:00:00.001Z",
				durationMs: 1,
				proof: {
					kind: "command-proof",
					authoredCommand: "false",
					gitPath: "/usr/bin/git",
					executorPath: "/usr/bin/systemd-run",
					shellPath: "/bin/sh",
					expectation: { exit: 0 },
					stdout: "",
					stderr: "",
					exitCode: null,
					signal: "SIGTERM",
					outputMatched: "fabricated",
					monitoring,
					startedAt: "not-a-timestamp",
					finishedAt: "also-not-a-timestamp",
					durationMs: 999,
					tree,
				},
			}],
			checklist: { outcome: "complete", items: [], failures: [], tree },
			recordedAt: "2026-01-01T00:00:00.000Z",
		},
	};
	assert.equal(decodeVerificationCacheUpdate(raw), undefined);
});

test("observed passed graphs are immutable and never become trusted", () => {
	const base = {
		kind: "verification-cache-update",
		specPath: "spec.yaml",
		nodeId: "n1",
		recordedAt: "2026-01-01T00:00:00.000Z",
		tree,
		record: {
			outcome: "passed",
			nodeId: "n1",
			tree,
			criteria: [{
				outcome: "passed",
				criterion: { id: "c1", statement: "signal" },
				startedAt: "2026-01-01T00:00:00.000Z",
				finishedAt: "2026-01-01T00:00:00.001Z",
				durationMs: 1,
				proof: {
					kind: "command-proof", authoredCommand: "printf signal", gitPath: "/usr/bin/git", executorPath: "/usr/bin/systemd-run", shellPath: "/bin/sh", expectation: { exit: 0, output_includes: "signal" }, stdout: "signal", stderr: "", exitCode: 0, signal: null, outputMatched: "signal", untrackedPaths: [], monitoring, startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:00.001Z", durationMs: 1, tree,
				},
			}],
			checklist: { outcome: "complete", items: [], failures: [], tree },
			recordedAt: "2026-01-01T00:00:00.000Z",
		},
	};
	const decoded = decodeVerificationCacheUpdate(base);
	assert.ok(decoded);
	if (!decoded) return;
	assert.ok(isObservedNodePassed(decoded.record));
	assert.equal(isNodePassed(decoded.record), false);
	assert.ok(Object.isFrozen(decoded));
	assert.ok(Object.isFrozen(decoded.record));
	assert.ok(Object.isFrozen(decoded.record.tree));
	assert.ok(Object.isFrozen(decoded.record.criteria));
	assert.ok(Object.isFrozen(decoded.record.criteria[0]?.proof));
	assert.throws(() => Object.assign(decoded.record, { tree: { ...tree, resolvedCommit: "b".repeat(40) }, criteria: [], checklist: { outcome: "incomplete" } }));
	assert.ok(isObservedNodePassed(decoded.record));
	assert.equal(isNodePassed(decoded.record), false);
	const cyclic = structuredClone(base);
	Object.defineProperty(cyclic.record, "cycle", { value: cyclic.record });
	const cyclicDecoded = decodeVerificationCacheUpdate(cyclic);
	assert.ok(cyclicDecoded);
	if (cyclicDecoded) {
		assert.equal(isNodePassed(cyclicDecoded.record), false);
	}
	assert.equal(isNodePassed({ ...decoded.record }), false);
	const prefrozen = structuredClone(base) as Record<string, unknown>;
	const prefrozenRecord = prefrozen.record as Record<string, unknown>;
	const prefrozenCriterion = (prefrozenRecord.criteria as Array<Record<string, unknown>>)[0];
	const prefrozenProof = prefrozenCriterion?.proof as Record<string, unknown>;
	if (prefrozenProof) {
		Object.freeze(prefrozenProof);
		const prefrozenDecoded = decodeVerificationCacheUpdate(prefrozen);
		assert.ok(prefrozenDecoded);
		if (prefrozenDecoded && isObservedNodePassed(prefrozenDecoded.record)) {
			const proof = prefrozenDecoded.record.criteria[0]?.proof;
			const expectation = proof?.kind === "command-proof" ? proof.expectation : undefined;
			assert.ok(expectation && Object.isFrozen(expectation));
			assert.throws(() => { if (expectation) Object.assign(expectation, { output_includes: "not-present" }); }, TypeError);
		}
	}
});

test("fresh checklist observations are not trusted until the verifier completes", () => {
	const complete = verifyChecklist(["must run"], [{ index: 0, done: true }], tree);
	assert.equal(complete.outcome, "complete");
	assert.equal(isCompleteChecklist(complete), false);
});
