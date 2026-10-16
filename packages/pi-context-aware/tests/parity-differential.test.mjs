import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { differentialExitCode, verifyTarball, inspectParityCase, verifyCorpusEvidence } from "../scripts/parity-differential-support.mjs";
// The runner passes the built judgment from dist; tests use the compiled copy of the same source.
import { buildFoldParityReport, judgeParityCalls } from "../.test-dist/src/parity/report.js";
import { coverageHash } from "../.test-dist/src/parity/compare.js";

// Consistent evidence: both sides agree, the coverage hash is real, and the call's created block is
// the one active fold whose summary the request carries. The shared judgment recomputes all of it.
const blocks = { count: 1, coverageCount: 2, coverageIds: ["a", "b"], coverageHash: coverageHash(["a", "b"]), partialEntries: 0, tiers: [1], absorbed: [] };
const summary = { role: "user", hash: "s1", summary: true, topicHash: "t1" };
const hashes = { messages: [summary, { role: "user", hash: "h1", summary: false }], tagsSeen: true, total: 2 };
const oursHashes = { ...hashes, activeFoldCount: 1, activeFoldIds: ["b1"], expectedSummaryHashes: ["s1"], expectedSummaryTopicHashes: ["t1"] };
const outcome = { type: "accepted", reasons: [] };
// Any record version works for the helper; the runner passes the built recorder's PARITY_RECORD_VERSION.
const V = 5;
const base = { v: V, fingerprint: "engine", sessionId: "synthetic", at: "2026-01-01" };
const call = { ...base, kind: "compress", toolCallId: "direct", nested: false, awaitingNextRequest: true, verdict: "match", diffs: [], bcp: blocks, ours: { ...blocks, createdIds: ["b1"] },
	bcpOutcome: outcome, oursOutcome: outcome, parseKind: "ok", parseInvalidItems: 0, refs: [{ bcp: "m00001", ours: "m00001" }], refContinuity: { same: 1, used: 1 } };
const request = { ...base, kind: "next-request", toolCallIds: ["direct"], verdict: "match", diffs: [], bcp: hashes, ours: oursHashes };
const without = (record, ...keys) => Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
const inspect = (records, register = []) => inspectParityCase(records, register, "engine", V, judgeParityCalls).failures;
const kinds = (records, register) => inspect(records, register).map((f) => f.record ? `${f.kind}:${f.record}` : f.kind);
// Recorder faults, with the record they came from and the shared validator's reason.
const faults = (records) => inspect(records).filter((f) => f.kind === "recorder-error").map((f) => `${f.record}: ${f.reason}`);

test("synthetic corpus preserves all eight required scenarios and literal boundaries", () => {
	const corpus = JSON.parse(fs.readFileSync(new URL("./fixtures/parity-corpus/cases.json", import.meta.url), "utf8"));
	assert.deepEqual(corpus.map((c) => c.id), ["direct", "fabric-nested", "several-ranges", "tier-two", "invalid-range", "first-user", "long-summary", "tool-pair-edges"]);
	assert.equal(corpus[1].nested, true);
	assert.equal(corpus[2].steps[0].length, 2);
	assert.equal(corpus[3].steps[1][0].startId, "b1");
	assert.equal(corpus[3].steps[1][0].endId, "b2");
	assert.equal(corpus[4].steps[0][0].startId, "m99998");
	assert.equal(corpus[5].steps[0][0].startId, "m00001");
	assert.ok(corpus[6].steps[0][0].summary.length > 200);
	assert.equal(corpus[7].toolPairs, true);
	assert.equal(corpus[7].steps[0][0].startId, "m00003");
	assert.equal(corpus[7].steps[0][0].endId, "m00005");
});

test("differential scenario evidence rejects absent steps and wrong fold tiers", () => {
	const item = { id: "direct", steps: [[]], expectedBcpTiers: [1] };
	assert.doesNotThrow(() => verifyCorpusEvidence([{ ...call, bcp: { tiers: [1] } }], item));
	assert.throws(() => verifyCorpusEvidence([], item), /each corpus step/u);
	assert.throws(() => verifyCorpusEvidence([{ ...call, bcp: { tiers: [] } }], item), /stated bcp fold tiers/u);
});

test("differential nested evidence requires flag, Fabric parent and child id", () => {
	const item = { id: "fabric-nested", nested: true, steps: [[]], expectedBcpTiers: [1] };
	const valid = { ...call, nested: true, toolCallId: "fabric_synthetic_parent/1", parentToolCallId: "fabric_synthetic_parent", bcp: { tiers: [1] } };
	assert.doesNotThrow(() => verifyCorpusEvidence([valid], item));
	assert.throws(() => verifyCorpusEvidence([{ ...valid, nested: false }], item), /nested flag/u);
	assert.throws(() => verifyCorpusEvidence([{ ...valid, parentToolCallId: "other" }], item), /Fabric parent/u);
	assert.throws(() => verifyCorpusEvidence([{ ...valid, toolCallId: "other/1" }], item), /child id/u);
});

test("differential tier-two evidence requires both earlier folds to be absorbed", () => {
	const item = { id: "tier-two", steps: [[], []], expectedBcpTiers: [1, 1, 2] };
	const records = [{ ...call, bcp: { tiers: [1, 1] } }, { ...call, bcp: { tiers: [2], absorbed: ["b1", "b2"] } }];
	assert.doesNotThrow(() => verifyCorpusEvidence(records, item));
	assert.throws(() => verifyCorpusEvidence([records[0], { ...call, bcp: { tiers: [2], absorbed: ["b1"] } }], item), /absorb earlier folds/u);
});

test("differential invalid-range evidence requires unknown-ref rejection", () => {
	const item = { id: "invalid-range", steps: [[]], expectedBcpTiers: [] };
	assert.doesNotThrow(() => verifyCorpusEvidence([{ ...call, bcp: { tiers: [] }, bcpOutcome: { type: "rejected", reasons: ["unknown-ref"] } }], item));
	assert.throws(() => verifyCorpusEvidence([{ ...call, bcp: { tiers: [] }, bcpOutcome: { type: "no-op", reasons: [] } }], item), /invalid refs must be rejected/u);
});

test("differentialExitCode maps a failed run to 1 and a clean run to 0", () => {
	assert.equal(differentialExitCode(true), 1);
	assert.equal(differentialExitCode(false), 0);
});

test("differential CLI exits nonzero when its isolated worker fails", () => {
	// A substituted tarball in the cache makes the worker fail offline, before any download.
	const cache = fs.mkdtempSync(path.join(os.tmpdir(), "parity-cli-"));
	try {
		fs.writeFileSync(path.join(cache, "billion-context-pi-0.1.83.tgz"), "substituted tarball");
		const script = fileURLToPath(new URL("../scripts/parity-differential.mjs", import.meta.url));
		const result = spawnSync(process.execPath, [script, "--cache", cache], { encoding: "utf8", timeout: 60_000 });
		assert.equal(result.error, undefined);
		assert.match(result.stderr, /bcp tarball integrity mismatch/u);
		assert.equal(result.status, 1);
	} finally { fs.rmSync(cache, { recursive: true, force: true }); }
});

test("differential integrity rejects a substituted cached tarball", () => {
	assert.throws(() => verifyTarball(Buffer.from("substitution")), /bcp tarball integrity mismatch/u);
});

test("differential gate rejects missing calls and missing next-request evidence", () => {
	assert.deepEqual(kinds([]), ["calls-missing"]);
	assert.deepEqual(kinds([call]), ["next-request-pending"]);
	assert.deepEqual(kinds([call, request]), []);
});

test("differential gate requires a next request for every call, even without the awaiting flag", () => {
	const unflagged = without(call, "awaitingNextRequest");
	assert.deepEqual(kinds([unflagged]), ["next-request-pending"]);
	// A request from another session links no call, so nothing judged it either.
	assert.deepEqual(kinds([unflagged, { ...request, sessionId: "other" }]), ["request-unlinked", "next-request-pending"]);
	assert.deepEqual(kinds([unflagged, request]), []);
});

test("differential gate rejects conclusive records that lack the evidence they compared", () => {
	const cases = [
		// The request's active-fold check also needs the call's own block ids.
		[[without(call, "ours"), request], ["compress: ours block evidence invalid: missing", "next-request: linked batch block evidence unavailable"]],
		[[without(call, "bcpOutcome"), request], ["compress: bcpOutcome invalid: missing"]],
		[[call, without(request, "bcp", "ours")], ["next-request: ours request hashes invalid: missing"]],
		[[call, { ...request, ours: { messages: [], tagsSeen: true } }], ["next-request: ours request hashes invalid: total", "next-request: expected summary evidence unavailable"]],
		// A verdict must agree with its diffs, and only the three known verdicts count.
		[[call, { ...request, diffs: [{ kind: "content" }] }], ["next-request: record verdict disagrees with stored diffs"]],
		[[call, { ...request, verdict: "diff" }], ["next-request: record verdict disagrees with stored diffs"]],
		[[{ ...call, verdict: "accepted" }, request], ["compress: record verdict missing or unknown"]],
	];
	for (const [records, expected] of cases) {
		assert.equal(kinds(records)[0], "inconclusive");
		assert.deepEqual(faults(records), expected);
	}
});

test("differential gate rejects the review's false-green probes", () => {
	// A match call with only bcp tiers and no next-request record used to pass both gates.
	const probe = { ...base, kind: "compress", toolCallId: "direct", verdict: "match", diffs: [], bcp: { tiers: [1] } };
	assert.deepEqual(kinds([probe]), ["next-request-pending", "recorder-error:compress"]);
	// Adding the awaiting flag and an empty match request used to pass as well.
	const emptyRequest = { ...base, kind: "next-request", toolCallIds: ["direct"], verdict: "match", diffs: [] };
	assert.deepEqual(kinds([{ ...probe, awaitingNextRequest: true }, emptyRequest]), ["inconclusive", "recorder-error:compress", "recorder-error:next-request"]);
});

test("differential gate prints every unexplained kind and accepts only registered differences", () => {
	const records = [call, { ...request, verdict: "diff", diffs: [{ kind: "summaries" }, { kind: "tool-calls" }] }];
	assert.deepEqual(inspect(records).map((f) => f.kind), ["summaries", "tool-calls"]);
	const register = [{ id: "FP-99", matches: (diff, owner) => diff.kind === "summaries" && owner.toolCallId === "direct" }];
	assert.deepEqual(inspect(records, register).map((f) => f.kind), ["tool-calls"]);
	assert.equal(inspect([call, request]).length, 0);
});

test("differential gate never explains away an inconclusive record", () => {
	const records = [call, { ...request, verdict: "inconclusive", diffs: [{ kind: "tags-absent" }] }];
	assert.deepEqual(inspect(records, [{ matches: () => true }]).map((f) => f.kind), ["inconclusive"]);
});

test("differential gate rejects stale fingerprints and versions", () => {
	// The current request then links no current call.
	assert.deepEqual(kinds([{ ...call, fingerprint: "old" }, request]), ["record-stale", "calls-missing", "request-unlinked"]);
	assert.deepEqual(kinds([{ ...call, v: 1 }, request]), ["record-stale", "calls-missing", "request-unlinked"]);
	// Only the version the recorder writes now counts: older and newer records are both stale.
	assert.deepEqual(kinds([{ ...call, v: V - 1 }, { ...request, v: V - 1 }]), ["record-stale", "calls-missing"]);
	assert.deepEqual(kinds([{ ...call, v: V + 1 }, { ...request, v: V + 1 }]), ["record-stale", "calls-missing"]);
	assert.throws(() => inspectParityCase([call, request], [], "engine"), /current parity record version/u);
	assert.throws(() => inspectParityCase([call, request], [], "engine", V), /shared parity call judgment/u);
});

test("differential gate gives register entries the provider request that followed the call", () => {
	// Real register entries explain a call's difference from the request evidence, so they need it.
	const needsRequest = [{ id: "FP-98", matches: (diff, owner, next) => next?.kind === "next-request" && next.toolCallIds.includes(owner.toolCallId) && next.ours === oursHashes }];
	const callDiff = [{ ...call, verdict: "diff", diffs: [{ kind: "block-count" }] }, request];
	assert.deepEqual(kinds(callDiff), ["block-count:compress"]);
	assert.deepEqual(kinds(callDiff, needsRequest), []);
	const requestDiff = [call, { ...request, verdict: "diff", diffs: [{ kind: "summaries" }] }];
	assert.deepEqual(kinds(requestDiff, needsRequest), []);
	// A call with no linked request gets no request, so the entry cannot explain it.
	const orphan = [{ ...call, verdict: "diff", diffs: [{ kind: "block-count" }] }];
	assert.deepEqual(kinds(orphan, needsRequest), ["next-request-pending", "block-count:compress"]);
});

test("differential gate rejects the round-1 review's malformed conclusive records", () => {
	// Review note 166260: these records used to give { count: 1, failures: [] }.
	const malformed = [
		[{ ...call, bcp: without(blocks, "partialEntries"), ours: without(call.ours, "partialEntries") }, "compress: ours block evidence invalid: partialEntries"],
		[{ ...call, bcp: without(blocks, "coverageHash") }, "compress: bcp block evidence invalid: coverageHash"],
		[{ ...call, bcpOutcome: { type: "bogus", reasons: [] } }, "compress: bcpOutcome invalid: type"],
		[{ ...call, oursOutcome: { type: "accepted", reasons: ["bogus"] } }, "compress: oursOutcome invalid: reasons"],
		[{ ...call, bcp: { ...blocks, tiers: [7] } }, "compress: bcp block evidence invalid: tiers"],
	];
	for (const [record, fault] of malformed) {
		assert.equal(kinds([record, request])[0], "inconclusive");
		assert.equal(faults([record, request])[0], fault);
	}
	assert.deepEqual(faults([call, { ...request, bcp: { ...hashes, total: 3 } }]), ["next-request: bcp request hashes invalid: messages"]);
	assert.deepEqual(kinds([call, request]), []);
});

test("differential gate recomputes differences instead of trusting a stored match", () => {
	// Review note 166260, round 2: well-formed evidence that disagrees passed as a stored match.
	const contradictions = [
		[{ ...call, bcp: { ...blocks, count: 2, tiers: [1, 1] } }, request, ["block-count:compress", "tier:compress"]],
		[{ ...call, bcp: { ...blocks, coverageIds: ["a", "c"], coverageHash: coverageHash(["a", "c"]) } }, request, ["coverage:compress"]],
		[{ ...call, bcpOutcome: { type: "rejected", reasons: ["unknown-ref"] } }, request, ["outcome:compress"]],
		[call, { ...request, bcp: { ...hashes, messages: [summary, { role: "user", hash: "h2", summary: false }] } }, ["content:next-request"]],
	];
	for (const [compress, next, expected] of contradictions) {
		assert.equal(compress.verdict, "match");
		assert.equal(next.verdict, "match");
		assert.deepEqual(kinds([compress, next]), expected);
		// The readiness report counts the same call as a difference.
		assert.equal(buildFoldParityReport([compress, next], [], "engine").counts.diff, 1);
	}
});
