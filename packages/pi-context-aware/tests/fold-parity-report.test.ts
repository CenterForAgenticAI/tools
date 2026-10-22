import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BUCKET_LABELS, buildFoldParityReport, DIFF_KIND_LABELS, registerFoldParityCommand } from "../src/parity/report.js";
import { coverageHash } from "../src/parity/compare.js";
import { PARITY_REGISTER } from "../src/parity/register.js";
import { appendParityRecords, PARITY_RECORD_VERSION, verdictFor, type CompressRecord, type NextRequestRecord, type ParityRecord, type RequestDelta } from "../src/parity/records.js";

const call = (n: number, fingerprint = "current", diffs: CompressRecord["diffs"] = []): CompressRecord => ({
	v: PARITY_RECORD_VERSION, kind: "compress", fingerprint, sessionId: "session", toolCallId: `call-${n}`, nested: false,
	at: new Date(n).toISOString(), verdict: verdictFor(diffs), diffs,
	parseKind: "ok", parseInvalidItems: 0, refs: [], refContinuity: { same: 0, used: 0 },
	ours: { count: 0, coverageCount: 0, coverageIds: [], coverageHash: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", createdIds: [], partialEntries: 0, tiers: [], absorbed: [] },
	bcp: { count: 0, coverageCount: 0, coverageIds: [], coverageHash: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", partialEntries: 0, tiers: [], absorbed: [] },
	oursOutcome: { type: "rejected", reasons: ["summary-short"] }, bcpOutcome: { type: "rejected", reasons: ["summary-short"] },
});
const request = (call: CompressRecord): NextRequestRecord => ({
	v: call.v, kind: "next-request", fingerprint: call.fingerprint, sessionId: call.sessionId, toolCallIds: [call.toolCallId],
	at: call.at, verdict: "match", diffs: [],
	ours: { activeFoldCount: 0, activeFoldIds: [], expectedSummaryHashes: [], expectedSummaryTopicHashes: [], messages: [], total: 0, tagsSeen: true },
	bcp: { messages: [], total: 0, tagsSeen: true },
});
const linked = (calls: CompressRecord[]): ParityRecord[] => calls.flatMap((call) => [call, request(call)]);
const withTimeZone = <T>(timeZone: string, render: () => T): T => {
	const previousTz = process.env.TZ;
	process.env.TZ = timeZone;
	try {
		return render();
	} finally {
		if (previousTz === undefined) delete process.env.TZ;
		else process.env.TZ = previousTz;
	}
};

test("fingerprint changes reset the count", () => {
	const report = buildFoldParityReport([call(0, "old"), call(1)], [], "current");
	assert.equal(report.count, 1);
	assert.equal(report.window?.calls, 1);
	assert.deepEqual(report.earlierBuilds, { calls: 1, builds: 1 });
});

test("only the most recent 500 calls determine readiness, including their next request", () => {
	const records = linked([call(0, "current", [{ kind: "coverage" }]), ...Array.from({ length: 500 }, (_, i) => call(i + 1))]);
	assert.equal(buildFoldParityReport(records, [], "current").ready, true);
	// Replace call-500's request: one call has exactly one linking request.
	records[records.length - 1] = { ...request(call(500)), at: new Date(501).toISOString(), verdict: "diff", diffs: [{ kind: "summaries" }] };
	const report = buildFoldParityReport(records, [], "current");
	assert.equal(report.ready, false);
	assert.equal(report.counts.diff, 1);
	assert.equal(report.blocking[0]?.toolCallId, "call-500");
	assert.deepEqual(report.blocking[0]?.kinds, ["summaries"]);
	assert.match(report.text, /call-500 {2}summaries$/mu);
});

test("register entries explain differences retroactively", () => {
	const records = linked([call(1, "current", [{ kind: "coverage" }])]);
	const report = buildFoldParityReport(records, [{ id: "FP-001", title: "Known widening", reason: "Entry atomicity", matches: (diff) => diff.kind === "coverage" }], "current");
	assert.equal(report.counts.explained, 1);
	assert.equal(report.counts.diff, 0);
	assert.deepEqual(report.registerHits, { "FP-001": { calls: 1, differences: 1 } });
});

test("inconclusive calls block readiness even if a register entry matches", () => {
	const records = Array.from({ length: 500 }, (_, i) => call(i));
	records[499] = call(499, "current", [{ kind: "side-file-missing" }]);
	const report = buildFoldParityReport(linked(records), [{ id: "FP-001", title: "Missing", reason: "test", matches: () => true }], "current");
	assert.equal(report.counts.inconclusive, 1);
	assert.equal(report.ready, false);
});

test("records with missing evidence fields or unknown vocabulary cannot reach readiness", () => {
	const valid = linked(Array.from({ length: 500 }, (_, i) => call(i)));
	assert.equal(buildFoldParityReport(valid, [], "current").ready, true);
	const breaks: ((record: CompressRecord) => CompressRecord)[] = [
		(record) => ({ ...record, bcp: { ...record.bcp!, partialEntries: undefined as unknown as number } }),
		(record) => ({ ...record, bcpOutcome: { type: "bogus" as "rejected", reasons: [] } }),
		(record) => ({ ...record, oursOutcome: { type: "rejected", reasons: ["bogus" as "other"] } }),
	];
	for (const breakRecord of breaks) {
		const report = buildFoldParityReport(valid.map((record) => record.kind === "compress" ? breakRecord(record) : record), [], "current");
		assert.equal(report.ready, false);
		assert.equal(report.counts.inconclusive, 500);
	}
});

test("duplicate compress records for one call identity cannot reach readiness", () => {
	const duplicates = Array.from({ length: 500 }, (_, i) => ({ ...call(i), toolCallId: "call-same" }));
	const report = buildFoldParityReport([...duplicates, request(duplicates[0]!)], [], "current");
	assert.equal(report.ready, false);
	assert.equal(report.counts.inconclusive, 500);
	const oneExtra = linked(Array.from({ length: 500 }, (_, i) => call(i)));
	oneExtra.push({ ...call(500), toolCallId: "call-499" });
	const extraReport = buildFoldParityReport(oneExtra, [], "current");
	assert.equal(extraReport.ready, false);
	assert.ok(extraReport.blocking.some((blocked) => blocked.toolCallId === "call-499"));
	assert.match(extraReport.text, /call-499/u);
});

test("a call linked by more than one next request cannot reach readiness", () => {
	const calls = Array.from({ length: 500 }, (_, i) => call(i));
	const records = linked(calls);
	records.push(request(calls[499]!));
	const report = buildFoldParityReport(records, [], "current");
	assert.equal(report.ready, false);
	assert.equal(report.counts.inconclusive, 1);
});

test("a next request that lists one call twice cannot reach readiness", () => {
	const calls = Array.from({ length: 500 }, (_, i) => call(i));
	const records = linked(calls);
	const last = records.length - 1;
	records[last] = { ...request(calls[499]!), toolCallIds: ["call-499", "call-499"] };
	const report = buildFoldParityReport(records, [], "current");
	assert.equal(report.ready, false);
	assert.equal(report.counts.inconclusive, 1);
	const repeatedEverywhere = Array.from({ length: 500 }, (_, i) => call(i)).flatMap((c) => [c, { ...request(c), toolCallIds: [c.toolCallId, c.toolCallId] }]);
	assert.equal(buildFoldParityReport(repeatedEverywhere, [], "current").ready, false);
});

test("calls awaiting next-request evidence are inconclusive", () => {
	assert.equal(buildFoldParityReport([{ ...call(1), awaitingNextRequest: true }], [], "current").counts.inconclusive, 1);
});

test("R5 every DiffKind has exactly one report-time evidence table row", () => {
	const source = ts.createSourceFile("records.ts", fs.readFileSync("src/parity/records.ts", "utf8"), ts.ScriptTarget.Latest, true);
	const declaration = source.statements.find((node): node is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(node) && node.name.text === "DiffKind");
	assert.ok(declaration && ts.isUnionTypeNode(declaration.type));
	const kinds = declaration.type.types.map((node) => {
		assert.ok(ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal));
		return node.literal.text;
	});
	const doc = fs.readFileSync("docs/fold-parity.md", "utf8");
	const rows = [...doc.matchAll(/^\| `([^`]+)` \| ([abc]) \| .+ \|$/gmu)];
	assert.deepEqual(rows.map((row) => row[1]).sort(), kinds.sort());
	assert.equal(new Set(rows.map((row) => row[1])).size, kinds.length);
});

test("every parity register ID is documented, and no undocumented register ID exists", () => {
	const doc = fs.readFileSync("docs/fold-parity.md", "utf8");
	assert.deepEqual([...new Set(doc.match(/FP-\d{3}/gu) ?? [])].sort(), PARITY_REGISTER.map((entry) => entry.id).sort());
});

// ---- Register entries for endings only billion-context-pi has (FP-004 to FP-007) ----

// Version-5 block evidence: full coverage hashes, and the native block each call created (call-N creates bN).
const FOLDED = { count: 1, coverageCount: 4, coverageIds: ["a", "b", "c", "d"], coverageHash: coverageHash(["a", "b", "c", "d"]), partialEntries: 0, tiers: [1], absorbed: [] } as const;
const NONE = { count: 0, coverageCount: 0, coverageIds: [], coverageHash: coverageHash([]), partialEntries: 0, tiers: [], absorbed: [] } as const;
const blockOf = (toolCallId: string) => `b${toolCallId.slice("call-".length)}`;
const folded = (toolCallId: string) => ({ ...FOLDED, createdIds: [blockOf(toolCallId)] });
/** A call billion-context-pi refused with `type` while the native preview folded four entries. */
const refused = (type: NonNullable<CompressRecord["bcpOutcome"]>["type"], diffs: CompressRecord["diffs"], overrides: Partial<CompressRecord> = {}): CompressRecord => ({
	...call(1, "current", diffs), verdict: "diff", oursOutcome: { type: "accepted", reasons: [] }, bcpOutcome: { type, reasons: [] }, ours: folded("call-1"), bcp: NONE, ...overrides,
});
const consequences = (type: string): CompressRecord["diffs"] => [
	{ kind: "outcome", reason: `ours=accepted; bcp=${type}` }, { kind: "block-count" },
	{ kind: "coverage", oursOnlyCount: 4, bcpOnlyCount: 0, oursOnly: ["a", "b", "c", "d"], bcpOnly: [] }, { kind: "tier" },
];
/** The next request of a batch; `evidence` is the refusal and counterfactual evidence the recorder keeps on it. */
const nextRequest = (diffs: NextRequestRecord["diffs"], evidence: Pick<NextRequestRecord, "refused" | "counterfactual" | "counterfactualOurs"> = {}, toolCallIds: readonly string[] = ["call-1"], at = 2): NextRequestRecord => {
	// Version-5 request evidence that recomputes to no difference of its own: each linked call's block
	// is active and its summary is in both requests, so only the stored diffs remain.
	const active = toolCallIds.map(blockOf).sort();
	const messages = active.map((id) => ({ role: "user", summary: true, topicHash: "topic", hash: `summary-${id}` }));
	const hashes = { messages, total: messages.length, tagsSeen: true };
	const ours = { ...hashes, activeFoldCount: active.length, activeFoldIds: active, activeFoldIdsCapped: false, expectedSummaryHashes: messages.map((message) => message.hash), expectedSummaryTopicHashes: messages.map(() => "topic") };
	// A counterfactual comes with its preview's request evidence; by default it is billion-context-pi's request.
	const counterfactualOurs = evidence.counterfactual ? { counterfactualOurs: ours } : {};
	return { v: PARITY_RECORD_VERSION, kind: "next-request", fingerprint: "current", sessionId: "session", toolCallIds, at: new Date(at).toISOString(), verdict: verdictFor(diffs), diffs, ...counterfactualOurs, ...evidence, ours, bcp: hashes };
};
const ENDINGS = [["FP-004", "capped-retry"], ["FP-005", "dead-range"], ["FP-006", "tier3-rewrite"], ["FP-007", "aborted"]] as const;
const REQUEST_DIFFS: NextRequestRecord["diffs"] = [{ kind: "summaries" }, { kind: "content" }, { kind: "tool-calls" }, { kind: "tool-results" }];
/** The full native request is the counterfactual one with only the refused calls' own folds applied. */
const ONLY_REFUSED_FOLDS: RequestDelta = { verdict: "refused-folds-only", refusedFolds: 1, coveredEntries: 4, removedMessages: 4 };
/**
 * Evidence that omitting the refused calls from the native preview reproduces billion-context-pi's
 * request, and that the full native request differs from that preview only by the refused calls' folds.
 */
const clean = (refused: NonNullable<NextRequestRecord["refused"]>) => ({ refused, counterfactual: { diffs: [], delta: ONLY_REFUSED_FOLDS } });

for (const [id, type] of ENDINGS) {
	test(`${id} explains a ${type} refusal and the extra native fold, in the call and the next request`, () => {
		const report = buildFoldParityReport([refused(type, consequences(type)), nextRequest(REQUEST_DIFFS, clean([{ toolCallId: "call-1", type }]))], PARITY_REGISTER, "current");
		assert.deepEqual(report.counts, { match: 0, explained: 1, diff: 0, inconclusive: 0 });
		// Hits count differences: four in the call and four in its next request.
		assert.deepEqual(report.registerHits[id], { calls: 1, differences: 8 });
	});
}

test("each request consequence of a refusal is explained on its own, tool calls and results included", () => {
	for (const diff of REQUEST_DIFFS) {
		const report = buildFoldParityReport([refused("dead-range", consequences("dead-range")), nextRequest([diff], clean([{ toolCallId: "call-1", type: "dead-range" }]))], PARITY_REGISTER, "current");
		assert.deepEqual(report.counts, { match: 0, explained: 1, diff: 0, inconclusive: 0 }, diff.kind);
		assert.equal(report.registerHits["FP-005"]?.differences, 5, diff.kind);
	}
});

test("a refusal does not explain a request difference that remains without the refused call", () => {
	const dead = refused("dead-range", consequences("dead-range"));
	const counts = (request: NextRequestRecord) => buildFoldParityReport([dead, request], PARITY_REGISTER, "current").counts;
	const unexplained = { match: 0, explained: 0, diff: 1, inconclusive: 0 };
	// The review probe: the request differs and nothing shows the difference is the refused fold's.
	assert.deepEqual(counts(nextRequest([{ kind: "summaries" }, { kind: "content" }, { kind: "tool-calls" }])), unexplained);
	assert.deepEqual(counts(nextRequest(REQUEST_DIFFS, { refused: [{ toolCallId: "call-1", type: "dead-range" }] })), unexplained);
	// The preview without the refused call still differs: a retained tool call changed.
	for (const remaining of [[{ kind: "tool-calls" }], [{ kind: "tool-results" }], [{ kind: "content" }], [{ kind: "summaries" }]] as const) {
		assert.deepEqual(counts(nextRequest(REQUEST_DIFFS, { refused: [{ toolCallId: "call-1", type: "dead-range" }], counterfactual: { diffs: remaining } })), unexplained, remaining[0].kind);
	}
	// Evidence that does not name a refused call in this batch, or names a different ending.
	assert.deepEqual(counts(nextRequest(REQUEST_DIFFS, clean([]))), unexplained);
	assert.deepEqual(counts(nextRequest(REQUEST_DIFFS, clean([{ toolCallId: "call-9", type: "dead-range" }]))), unexplained);
	assert.deepEqual(counts(nextRequest(REQUEST_DIFFS, clean([{ toolCallId: "call-1", type: "rejected" as "dead-range" }]))), unexplained);
	// Malformed persisted evidence is never an explanation.
	assert.deepEqual(counts(nextRequest(REQUEST_DIFFS, { refused: [{ toolCallId: "call-1", type: "dead-range" }], counterfactual: {} as { diffs: [] } })), unexplained);
	assert.deepEqual(counts(nextRequest(REQUEST_DIFFS, { refused: { toolCallId: "call-1", type: "dead-range" } as unknown as [], counterfactual: { diffs: [], delta: ONLY_REFUSED_FOLDS } })), unexplained);
});

test("a clean counterfactual explains nothing unless the full request differs from it only by the refused folds", () => {
	const dead = refused("dead-range", consequences("dead-range"));
	const counts = (counterfactual: NextRequestRecord["counterfactual"]) => buildFoldParityReport([dead, nextRequest(REQUEST_DIFFS, { refused: [{ toolCallId: "call-1", type: "dead-range" }], counterfactual })], PARITY_REGISTER, "current").counts;
	const unexplained = { match: 0, explained: 0, diff: 1, inconclusive: 0 };
	assert.deepEqual(counts({ diffs: [], delta: ONLY_REFUSED_FOLDS }), { match: 0, explained: 1, diff: 0, inconclusive: 0 });
	// A record written before the structural check, without its evidence.
	assert.deepEqual(counts({ diffs: [] }), unexplained);
	for (const reason of ["attribution-unavailable", "too-large", "unattributed-fold", "sibling-changed", "sibling-covered", "sibling-absorbed", "summary-missing", "message-changed"] as const) {
		assert.deepEqual(counts({ diffs: [], delta: { ...ONLY_REFUSED_FOLDS, verdict: "other", reason } }), unexplained, reason);
	}
	// Malformed persisted evidence.
	assert.deepEqual(counts({ diffs: [], delta: { ...ONLY_REFUSED_FOLDS, verdict: "yes" as "other" } }), unexplained);
	assert.deepEqual(counts({ diffs: [], delta: null as unknown as RequestDelta }), unexplained);
});

/** An accepted call that matched billion-context-pi; it shares its batch's next request. */
const accepted = (n: number): CompressRecord => ({ ...call(n), oursOutcome: { type: "accepted", reasons: [] }, bcpOutcome: { type: "accepted", reasons: [] }, ours: folded(`call-${n}`), bcp: FOLDED });
/** 499 matching calls in another session, later than every batch below. */
const fillers = Array.from({ length: 499 }, (_, i): CompressRecord => ({ ...call(1_000 + i), sessionId: "other" }));

test("partial or malformed refusal, counterfactual and delta evidence is never explained (review round 4)", () => {
	const dead = refused("dead-range", consequences("dead-range"));
	const REFUSED = [{ toolCallId: "call-1", type: "dead-range" }] as const;
	const counts = (evidence: Record<string, unknown>) => buildFoldParityReport([dead, nextRequest(REQUEST_DIFFS, evidence as Pick<NextRequestRecord, "refused" | "counterfactual">)], PARITY_REGISTER, "current").counts;
	const explained = { match: 0, explained: 1, diff: 0, inconclusive: 0 };
	const unexplained = { match: 0, explained: 0, diff: 1, inconclusive: 0 };
	const withDelta = (delta: unknown) => ({ refused: REFUSED, counterfactual: { diffs: [], delta } });
	const without = (field: string) => Object.fromEntries(Object.entries(ONLY_REFUSED_FOLDS).filter(([key]) => key !== field));
	// Control: the complete record the recorder writes is explained.
	assert.deepEqual(counts(withDelta(ONLY_REFUSED_FOLDS)), explained);
	const rows: [string, Record<string, unknown>][] = [
		// The round-4 probe's delta: only its verdict.
		["verdict only", withDelta({ verdict: "refused-folds-only" })],
		// Each field refused-folds-only needs, removed in turn.
		...["verdict", "refusedFolds", "coveredEntries", "removedMessages"].map((field): [string, Record<string, unknown>] => [`without ${field}`, withDelta(without(field))]),
		// Counts that are not safe non-negative integers.
		["non-integer count", withDelta({ ...ONLY_REFUSED_FOLDS, refusedFolds: 1.5 })],
		["negative count", withDelta({ ...ONLY_REFUSED_FOLDS, coveredEntries: -4 })],
		["non-number count", withDelta({ ...ONLY_REFUSED_FOLDS, removedMessages: "4" })],
		// A reason refused-folds-only never has, an unknown reason, and a count the writer never sets for it.
		["verdict with a foreign reason", withDelta({ ...ONLY_REFUSED_FOLDS, reason: "message-changed" })],
		["unknown reason", withDelta({ ...ONLY_REFUSED_FOLDS, reason: "bogus" })],
		["verdict with a foreign count", withDelta({ ...ONLY_REFUSED_FOLDS, mismatchAt: 0 })],
		// Malformed refused calls.
		["refused not an array", { ...withDelta(ONLY_REFUSED_FOLDS), refused: { toolCallId: "call-1", type: "dead-range" } }],
		["refused bad id", { ...withDelta(ONLY_REFUSED_FOLDS), refused: [...REFUSED, { toolCallId: 7, type: "dead-range" }] }],
		["refused id outside the batch", { ...withDelta(ONLY_REFUSED_FOLDS), refused: [...REFUSED, { toolCallId: "call-9", type: "dead-range" }] }],
		["refused unknown ending", { ...withDelta(ONLY_REFUSED_FOLDS), refused: [{ toolCallId: "call-1", type: "bogus" }] }],
		// Malformed counterfactual diffs.
		["diffs not an array", { refused: REFUSED, counterfactual: { diffs: {}, delta: ONLY_REFUSED_FOLDS } }],
		["diff of unknown kind", { refused: REFUSED, counterfactual: { diffs: [{ kind: "bogus" }], delta: ONLY_REFUSED_FOLDS } }],
		["diff with a malformed count", { refused: REFUSED, counterfactual: { diffs: [{ kind: "summaries", oursOnlyCount: -1 }], delta: ONLY_REFUSED_FOLDS } }],
		["diff that is not an object", { refused: REFUSED, counterfactual: { diffs: ["summaries"], delta: ONLY_REFUSED_FOLDS } }],
	];
	for (const [label, evidence] of rows) assert.deepEqual(counts(evidence), unexplained, label);
	// A batch with an accepted sibling: an unknown ending or a repeated call beside a valid refusal.
	const sibling = accepted(0);
	const batch = (evidence: Record<string, unknown>) => buildFoldParityReport([sibling, dead, nextRequest(REQUEST_DIFFS, evidence as Pick<NextRequestRecord, "refused">, [sibling.toolCallId, dead.toolCallId])], PARITY_REGISTER, "current").counts;
	assert.deepEqual(batch(withDelta(ONLY_REFUSED_FOLDS)), { match: 0, explained: 2, diff: 0, inconclusive: 0 });
	for (const [label, refusedCalls] of [
		["sibling with an unknown ending", [...REFUSED, { toolCallId: sibling.toolCallId, type: "bogus" }]],
		["sibling with a non-refusal ending", [...REFUSED, { toolCallId: sibling.toolCallId, type: "accepted" }]],
		["refused call repeated", [...REFUSED, { toolCallId: "call-1", type: "aborted" }]],
	] as const) assert.deepEqual(batch({ ...withDelta(ONLY_REFUSED_FOLDS), refused: refusedCalls }), { match: 0, explained: 0, diff: 2, inconclusive: 0 }, label);
});

test("a batch with an accepted sibling is explained only when the preview without the refused call is clean", () => {
	const sibling = accepted(0);
	const dead = refused("dead-range", consequences("dead-range"));
	const ids = [sibling.toolCallId, dead.toolCallId];
	const explained = buildFoldParityReport([sibling, dead, nextRequest(REQUEST_DIFFS, clean([{ toolCallId: dead.toolCallId, type: "dead-range" }]), ids)], PARITY_REGISTER, "current");
	assert.deepEqual(explained.counts, { match: 0, explained: 2, diff: 0, inconclusive: 0 });
	const corrupted = buildFoldParityReport([sibling, dead, nextRequest(REQUEST_DIFFS, { refused: [{ toolCallId: dead.toolCallId, type: "dead-range" }], counterfactual: { diffs: [{ kind: "tool-calls" }] } }, ids)], PARITY_REGISTER, "current");
	assert.deepEqual(corrupted.counts, { match: 0, explained: 0, diff: 2, inconclusive: 0 });
});

test("the request decision does not depend on whether a sibling is inside the 500-call window", () => {
	const sibling = accepted(0);
	const dead = refused("dead-range", consequences("dead-range"), { at: new Date(1).toISOString() });
	const ids = [sibling.toolCallId, dead.toolCallId];
	const report = (request: NextRequestRecord) => buildFoldParityReport([sibling, dead, request, ...linked(fillers)], PARITY_REGISTER, "current");
	const corrupted = report(nextRequest(REQUEST_DIFFS, { refused: [{ toolCallId: dead.toolCallId, type: "dead-range" }], counterfactual: { diffs: [{ kind: "tool-calls" }] } }, ids));
	// The sibling has left the window; the refused call alone must still keep the corruption.
	assert.equal(corrupted.window?.calls, 500);
	assert.deepEqual(corrupted.counts, { match: 499, explained: 0, diff: 1, inconclusive: 0 });
	assert.equal(corrupted.ready, false);
	const genuine = report(nextRequest(REQUEST_DIFFS, clean([{ toolCallId: dead.toolCallId, type: "dead-range" }]), ids));
	assert.deepEqual(genuine.counts, { match: 499, explained: 1, diff: 0, inconclusive: 0 });
	assert.equal(genuine.ready, true);
});

test("several refused calls in one batch are explained together only by a clean preview without all of them", () => {
	const dead = refused("dead-range", consequences("dead-range"));
	const aborted = { ...refused("aborted", consequences("aborted"), { ours: folded("call-2") }), toolCallId: "call-2", at: new Date(2).toISOString() };
	const ids = [dead.toolCallId, aborted.toolCallId];
	const both = [{ toolCallId: dead.toolCallId, type: "dead-range" }, { toolCallId: aborted.toolCallId, type: "aborted" }] as const;
	const explained = buildFoldParityReport([dead, aborted, nextRequest(REQUEST_DIFFS, clean(both), ids, 3)], PARITY_REGISTER, "current");
	assert.deepEqual(explained.counts, { match: 0, explained: 2, diff: 0, inconclusive: 0 });
	// Each call's own differences go to its own entry; the shared request goes to the first entry that names an ending in the batch.
	assert.deepEqual(Object.fromEntries(Object.entries(explained.registerHits).map(([id, hit]) => [id, hit.differences])), { "FP-005": 12, "FP-007": 4 });
	const remaining = buildFoldParityReport([dead, aborted, nextRequest(REQUEST_DIFFS, { refused: both, counterfactual: { diffs: [{ kind: "content" }] } }, ids, 3)], PARITY_REGISTER, "current");
	assert.deepEqual(remaining.counts, { match: 0, explained: 0, diff: 2, inconclusive: 0 });
});

test("a billion-context-pi-side id list with a missing or zero count is never explained", () => {
	const dead = refused("dead-range", consequences("dead-range"));
	const fp005 = PARITY_REGISTER.find((entry) => entry.id === "FP-005")!;
	for (const kind of ["coverage", "absorbed"] as const) {
		assert.equal(fp005.matches({ kind, oursOnlyCount: 4, bcpOnlyCount: 0, oursOnly: ["a"], bcpOnly: [] }, dead), true, kind);
		assert.equal(fp005.matches({ kind, oursOnlyCount: 4, oursOnly: ["a"] }, dead), true, kind);
		assert.equal(fp005.matches({ kind, bcpOnly: ["unexpected-bcp-id"] }, dead), false, kind);
		assert.equal(fp005.matches({ kind, bcpOnlyCount: 0, bcpOnly: ["unexpected-bcp-id"] }, dead), false, kind);
		assert.equal(fp005.matches({ kind, bcpOnlyCount: 1, bcpOnly: [] }, dead), false, kind);
		assert.equal(fp005.matches({ kind, bcpOnlyCount: "0" as unknown as number }, dead), false, kind);
		// Persisted shapes no writer produces: a null count, and an id list that is not an array.
		assert.equal(fp005.matches({ kind, bcpOnlyCount: null as unknown as number, bcpOnly: [] }, dead), false, kind);
		assert.equal(fp005.matches({ kind, bcpOnlyCount: 0, bcpOnly: "b1" as unknown as [] }, dead), false, kind);
		assert.equal(fp005.matches({ kind, bcpOnlyCount: 0, bcpOnly: {} as unknown as [] }, dead), false, kind);
	}
	const report = buildFoldParityReport([refused("dead-range", [...consequences("dead-range").slice(0, 2), { kind: "coverage", oursOnlyCount: 4, bcpOnlyCount: 0, oursOnly: ["a"], bcpOnly: ["b"] }]), nextRequest([])], PARITY_REGISTER, "current");
	assert.equal(report.counts.diff, 1);
});

test("the bcp-only register leaves differences outside the refusal unexplained", () => {
	// Every call needs a linked request; without one under test, a matching request is linked.
	const unexplained = (record: CompressRecord, request: NextRequestRecord = nextRequest([])) => buildFoldParityReport([record, request], PARITY_REGISTER, "current").counts.diff;
	// The same differences without a bcp-only ending.
	assert.equal(unexplained(refused("rejected", consequences("rejected"))), 1);
	// A refusal that carries a rejection reason is a different ending.
	assert.equal(unexplained(refused("dead-range", consequences("dead-range"), { bcpOutcome: { type: "dead-range", reasons: ["consumed"] } })), 1);
	// An outcome reason that does not match the recorded outcomes.
	assert.equal(unexplained(refused("dead-range", [{ kind: "outcome", reason: "ours=rejected; bcp=dead-range" }])), 1);
	// Something on the billion-context-pi side the native preview lacks.
	assert.equal(unexplained(refused("aborted", [...consequences("aborted"), { kind: "absorbed", oursOnlyCount: 0, bcpOnlyCount: 1, oursOnly: [], bcpOnly: ["b1"] }])), 1);
	// billion-context-pi created a fold despite the refusal.
	assert.equal(unexplained(refused("capped-retry", consequences("capped-retry"), { bcp: FOLDED })), 1);
	// The native preview created nothing, so no fold explains a coverage difference.
	assert.equal(unexplained(refused("tier3-rewrite", consequences("tier3-rewrite"), { ours: { ...NONE, createdIds: [] } })), 1);
	// A broken tool pairing in the next request is never a consequence of a refusal, even with a clean counterfactual.
	assert.equal(unexplained(refused("dead-range", consequences("dead-range")), nextRequest([{ kind: "tool-pairing" }], clean([{ toolCallId: "call-1", type: "dead-range" }]))), 1);
});

test("a refused call with an inconclusive difference stays inconclusive", () => {
	const report = buildFoldParityReport([refused("aborted", [...consequences("aborted"), { kind: "side-file-missing" }])], PARITY_REGISTER, "current");
	assert.equal(report.counts.inconclusive, 1);
	assert.equal(report.ready, false);
});

// ---- Reading the report (presentation only; readiness is unchanged) ----

const diffKinds = (): string[] => {
	const source = ts.createSourceFile("records.ts", fs.readFileSync("src/parity/records.ts", "utf8"), ts.ScriptTarget.Latest, true);
	const declaration = source.statements.find((node): node is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(node) && node.name.text === "DiffKind");
	assert.ok(declaration && ts.isUnionTypeNode(declaration.type));
	return declaration.type.types.map((node) => {
		assert.ok(ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal));
		return node.literal.text;
	});
};

test("every DiffKind and every bucket has a non-empty plain-language label", () => {
	assert.deepEqual(Object.keys(DIFF_KIND_LABELS).sort(), diffKinds().sort());
	for (const [kind, label] of Object.entries(DIFF_KIND_LABELS)) assert.ok(label.trim().length > 10, kind);
	assert.deepEqual(Object.keys(BUCKET_LABELS).sort(), ["diff", "explained", "inconclusive", "match"]);
	for (const [bucket, label] of Object.entries(BUCKET_LABELS)) assert.ok(label.trim().length > 10, bucket);
});

test("the headline says Ready or Not ready with the reason in one sentence", () => {
	const different = buildFoldParityReport(linked([call(1, "current", [{ kind: "coverage" }]), call(2), call(3, "current", [{ kind: "too-large" }])]), [], "current");
	assert.equal(different.text.split("\n")[2], "Not ready to cut over. 3 of 500 calls recorded; 1 has differences no known entry explains and 1 could not be compared.");
	const short = buildFoldParityReport(linked([call(1)]), [], "current");
	assert.equal(short.text.split("\n")[2], "Not ready to cut over. 1 of 500 calls recorded; 499 more are needed.");
	const ready = buildFoldParityReport(linked(Array.from({ length: 501 }, (_, i) => call(i))), [], "current");
	assert.equal(ready.ready, true);
	assert.match(ready.text.split("\n")[2]!, /^Ready to cut over\. The latest 500 of 501 comparable calls have no undocumented differences and none was inconclusive\.$/u);
});

test("the build line shows the combined fingerprint and, when given, its engine and folds parts", () => {
	const records = linked([{ ...call(1), fingerprint: "4a987a5925d2ffffffff" }]);
	const bare = buildFoldParityReport(records, [], "4a987a5925d2ffffffff");
	assert.match(bare.text, /^Build {4}fingerprint 4a987a5925d2$/mu);
	assert.equal(bare.engine, undefined);
	const parts = buildFoldParityReport(records, [], "4a987a5925d2ffffffff", { engine: "eec704d7e43d0000", folds: { firstUserMessage: "keep", firstUserMessageMaxTokens: 8_000 } });
	assert.match(parts.text, /^Build {4}fingerprint 4a987a5925d2 = engine eec704d7e43d \+ folds\.firstUserMessage keep, firstUserMessageMaxTokens 8000$/mu);
	assert.equal(parts.engine, "eec704d7e43d0000");
	assert.deepEqual(parts.folds, { firstUserMessage: "keep", firstUserMessageMaxTokens: 8_000 });
});

test("calls from other fingerprints and older record versions are shown as not counted", () => {
	const legacy = { ...call(9, "current"), v: 1 } as unknown as ParityRecord;
	const records = [...linked([call(0, "old"), call(1, "older"), call(2, "old"), call(3), { ...call(4), sessionId: "other" }]), legacy];
	const report = withTimeZone("UTC", () => buildFoldParityReport(records, [], "current"));
	assert.equal(report.count, 2);
	assert.deepEqual(report.earlierBuilds, { calls: 3, builds: 2 });
	assert.equal(report.olderVersionCalls, 1);
	assert.deepEqual(report.window, { calls: 2, sessions: 2, from: new Date(3).toISOString(), to: new Date(4).toISOString() });
	assert.match(report.text, /^ {9}Not counted: 3 calls from 2 earlier builds; 1 call from an older record version$/mu);
	assert.equal(report.text.split("\n").find((line) => line.startsWith("Window")), "Window   2 compress calls in 2 sessions, 1970-01-01 00:00 UTC to 1970-01-01 00:00 UTC");
});

test("report timestamps use the fixed local time zone and show its UTC offset", () => {
	const winter = { ...call(1, "current", [{ kind: "coverage" }]), at: "2026-01-15T11:34:00.000Z" };
	const summer = { ...call(2, "current", [{ kind: "coverage" }]), at: "2026-07-15T11:34:00.000Z" };
	const lines = withTimeZone("Europe/Berlin", () => buildFoldParityReport(linked([winter, summer]), [], "current").text.split("\n"));
	assert.equal(lines.find((line) => line.startsWith("Window")), "Window   2 compress calls in 1 session, 2026-01-15 12:34 +01:00 to 2026-07-15 13:34 +02:00");
	assert.deepEqual(lines.filter((line) => line.includes("session session")), [
		"   2026-07-15 13:34 +02:00  session session  call-2  coverage",
		"   2026-01-15 12:34 +01:00  session session  call-1  coverage",
	]);
});

test("every diff kind in a blocking call is listed with its label, counted in calls", () => {
	for (const kind of diffKinds() as (keyof typeof DIFF_KIND_LABELS)[]) {
		const report = buildFoldParityReport(linked([call(1, "current", [{ kind }, { kind, reason: "second" }]), call(2, "current", [{ kind }])]), [], "current");
		assert.equal(report.ready, false, kind);
		const section = INCONCLUSIVE.has(kind) ? report.inconclusiveKindCalls : report.undocumentedKindCalls;
		assert.equal(section[kind], 2, kind);
		assert.match(report.text, new RegExp(`^ +2  ${kind} +${DIFF_KIND_LABELS[kind].replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "mu"), kind);
	}
});
const INCONCLUSIVE = new Set(["side-file-missing", "import-unsupported", "import-skipped", "ref-unmapped", "too-large", "tags-absent", "recorder-error", "tool-evidence", "outcome-unknown"]);

test("register hits show calls and differences with the entry title and qualified issue", () => {
	const entry = { id: "FP-001" as const, title: "Known widening", reason: "test", issue: "pi-context-aware#175", matches: (diff: { kind: string }) => diff.kind === "coverage" };
	const report = buildFoldParityReport(linked([call(1, "current", [{ kind: "coverage" }, { kind: "coverage", reason: "b" }]), call(2, "current", [{ kind: "coverage" }])]), [entry], "current");
	assert.deepEqual(report.registerHits, { "FP-001": { calls: 2, differences: 3 } });
	assert.match(report.text, /^ {3}FP-001 {2}Known widening {2}2; 3 {2}intel\/pi-context-aware#175$/mu);
});

test("the default lists the newest 10 blocking calls and all lists every one with reasons", () => {
	const records = linked(Array.from({ length: 12 }, (_, i) => ({ ...call(i, "current", [{ kind: "coverage", reason: `reason-${i}` }]), nested: i === 11 })));
	const lines = (text: string) => text.split("\n").filter((line) => /session session/u.test(line));
	const short = buildFoldParityReport(records, [], "current");
	assert.equal(short.blocking.length, 12);
	assert.equal(short.blocking[0]?.toolCallId, "call-11");
	assert.equal(lines(short.text).length, 10);
	assert.match(short.text, /^Newest calls that block cut-over \(10 of 12; \/fold-parity all lists every one\)$/mu);
	assert.match(lines(short.text)[0]!, /call-11 {2}coverage {2}nested$/u);
	assert.doesNotMatch(short.text, /nested=|reason-/u);
	const every = buildFoldParityReport(records, [], "current", { all: true });
	assert.equal(lines(every.text).length, 12);
	assert.match(every.text, /^ +coverage: reason-0$/mu);
});

test("the /fold-parity command passes the build parts and the all argument", async () => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "parity-command-")));
	try {
		const calls = Array.from({ length: 12 }, (_, i) => call(i, "combined", [{ kind: "coverage" }]));
		await appendParityRecords(dir, "session", linked(calls));
		const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
		const api = { registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) { commands.set(name, options.handler); } } as unknown as ExtensionAPI;
		registerFoldParityCommand(api, { agentDir: dir, fingerprint: () => "combined", build: () => ({ engine: "engine-hash", folds: { firstUserMessage: "keep", firstUserMessageMaxTokens: 8_000 } }) });
		const notices: string[] = [];
		const ctx = { ui: { notify: (message: string) => { notices.push(message); } } } as unknown as ExtensionContext;
		await commands.get("fold-parity")!("", ctx);
		await commands.get("fold-parity")!(" all ", ctx);
		assert.match(notices[0]!, /fingerprint combined = engine engine-hash \+ folds\.firstUserMessage keep/u);
		const count = (text: string) => text.split("\n").filter((line) => /session session/u.test(line)).length;
		assert.equal(count(notices[0]!), 10);
		assert.equal(count(notices[1]!), 12);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
