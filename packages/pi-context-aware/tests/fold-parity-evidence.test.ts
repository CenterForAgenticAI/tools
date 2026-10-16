import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import ts from "typescript";
import { blockEvidenceFault, isComparableBlockEvidence, outcomeEvidenceFault, parityEvidenceFault, refusalEvidenceFault, requestDeltaFault, requestHashesFault } from "../src/parity/evidence.js";
import { coverageHash, MAX_COVERAGE_IDS, MAX_MESSAGE_HASHES } from "../src/parity/compare.js";
import { isRefusalOutcome, PARITY_RECORD_VERSION, type CompressRecord, type MessageHash, type NextRequestRecord } from "../src/parity/records.js";

// Each row breaks one field of otherwise complete evidence, so removing any single check turns its row red.
const ids = (n: number) => Array.from({ length: n }, (_, i) => `entry-${String(i).padStart(3, "0")}`);
const bcpBlocks = { count: 2, coverageCount: 3, coverageIds: ids(3), coverageHash: coverageHash(ids(3)), partialEntries: 1, tiers: [1, 2], absorbed: ["b0"] };
const oursBlocks = { ...bcpBlocks, createdIds: ["b1", "b2"] };
const outcome = { type: "partial", reasons: ["consumed", "split"] } as const;
const messages: MessageHash[] = [
	{ role: "user", hash: "a1", summary: false },
	{ role: "assistant", hash: "b2", summary: false, toolCalls: [{ id: "c1", name: "compress", argsHash: "x1", compactedArgsHash: "y1" }] },
	{ role: "toolResult", hash: "c3", summary: false, toolResult: { toolCallId: "c1", toolName: "compress", isError: false } },
	{ role: "user", hash: "d4", summary: true, topicHash: "t4" },
];
const bcpHashes = { messages, total: messages.length, tagsSeen: true };
const oursHashes = { ...bcpHashes, activeFoldCount: 1, activeFoldIds: ["b1"], activeFoldIdsCapped: false, expectedSummaryHashes: ["d4"], expectedSummaryTopicHashes: ["t4"] };
const base = { v: PARITY_RECORD_VERSION, fingerprint: "engine", sessionId: "session", at: "2026-01-01T00:00:00.000Z" };
const call: CompressRecord = {
	...base, kind: "compress", toolCallId: "c1", nested: false, verdict: "match", diffs: [], ours: oursBlocks, bcp: bcpBlocks,
	oursOutcome: outcome, bcpOutcome: outcome, parseKind: "ok", parseInvalidItems: 0,
	refs: [{ bcp: "m00001", ours: "m00001" }, { bcp: "b9" }], refContinuity: { same: 1, used: 2 },
};
const request: NextRequestRecord = { ...base, kind: "next-request", toolCallIds: ["c1"], verdict: "match", diffs: [], ours: oursHashes, bcp: bcpHashes };

/** A copy with one field replaced, or removed when `value` is undefined. */
function withField(value: object, key: string, replacement: unknown): Record<string, unknown> {
	const copy: Record<string, unknown> = { ...value };
	if (replacement === undefined) delete copy[key];
	else copy[key] = replacement;
	return copy;
}

test("complete evidence from every recorder field passes the shared validator", () => {
	assert.equal(blockEvidenceFault(oursBlocks), undefined);
	assert.equal(blockEvidenceFault(bcpBlocks), undefined);
	assert.equal(outcomeEvidenceFault(outcome), undefined);
	assert.equal(requestHashesFault(oursHashes), undefined);
	assert.equal(parityEvidenceFault(call), undefined);
	assert.equal(parityEvidenceFault(request), undefined);
	// Positive controls at the recorder's caps: the coverage list keeps 50 ids and request hashes keep 2,000 messages.
	const wide = ids(MAX_COVERAGE_IDS + 10);
	assert.equal(blockEvidenceFault({ ...bcpBlocks, coverageCount: wide.length, coverageIds: wide.slice(0, MAX_COVERAGE_IDS), coverageHash: coverageHash(wide) }), undefined);
	const long = Array.from({ length: MAX_MESSAGE_HASHES }, (_, i) => ({ role: "user", hash: `h${i}`, summary: false }));
	assert.equal(requestHashesFault({ messages: long, total: MAX_MESSAGE_HASHES + 5, tagsSeen: false }), undefined);
	// Capped created ids are structurally valid; the record-level check below still refuses them.
	assert.equal(blockEvidenceFault({ ...oursBlocks, createdIds: ["b1"], blockIdsCapped: true }), undefined);
});

test("block evidence needs every field, consistent counts and known fold tiers", () => {
	const rows: [string, unknown, string][] = [
		["count", undefined, "count"], ["count", -1, "count"], ["count", 1.5, "count"],
		["coverageCount", "3", "coverageCount"],
		["coverageIds", ids(2), "coverageIds"], ["coverageIds", ["entry-000", "entry-000", "entry-001"], "coverageIds"], ["coverageIds", ["", "a", "b"], "coverageIds"],
		["coverageHash", undefined, "coverageHash"], ["coverageHash", "abc", "coverageHash"],
		["partialEntries", undefined, "partialEntries"], ["partialEntries", 4, "partialEntries"],
		["tiers", undefined, "tiers"], ["tiers", [1], "tiers"], ["tiers", [1, 4], "tiers"], ["tiers", ["1", 2], "tiers"],
		["blockIdsCapped", "yes", "blockIdsCapped"],
		["absorbed", undefined, "absorbed"], ["absorbed", ["b0", "b0"], "absorbed"], ["absorbed", [7], "absorbed"],
		["createdIds", ["b1"], "createdIds"], ["createdIds", ["b1", "b1"], "createdIds"],
	];
	for (const [field, value, fault] of rows) assert.equal(blockEvidenceFault(withField(oursBlocks, field, value)), fault, `${field}=${JSON.stringify(value)}`);
	assert.equal(blockEvidenceFault({ ...bcpBlocks, coverageCount: 60, coverageIds: ids(MAX_COVERAGE_IDS + 1) }), "coverageIds");
	assert.equal(blockEvidenceFault(undefined), "missing");
	// Comparable evidence may disagree with its own counts, but never has missing fields or unknown values.
	assert.equal(isComparableBlockEvidence({ ...oursBlocks, count: 3 }), true);
	assert.equal(isComparableBlockEvidence({ ...bcpBlocks, partialEntries: 9, coverageIds: ids(1) }), true);
	assert.equal(isComparableBlockEvidence(withField(oursBlocks, "partialEntries", undefined)), false);
	assert.equal(isComparableBlockEvidence({ ...oursBlocks, tiers: [1, 5] }), false);
	assert.equal(blockEvidenceFault([oursBlocks]), "missing");
});

test("outcome evidence accepts only the recorder's outcome types and reject reasons", () => {
	const rows: [string, unknown, string][] = [
		["type", undefined, "type"], ["type", "bogus", "type"], ["type", "toString", "type"],
		["reasons", undefined, "reasons"], ["reasons", ["bogus"], "reasons"], ["reasons", ["split", "split"], "reasons"],
	];
	for (const [field, value, fault] of rows) assert.equal(outcomeEvidenceFault(withField(outcome, field, value)), fault, `${field}=${JSON.stringify(value)}`);
	assert.equal(outcomeEvidenceFault(null), "missing");
});

test("request hashes need a message hash for every counted message, up to the cap", () => {
	const message = (key: string, value: unknown) => [withField(messages[1]!, key, value), ...messages.slice(2)];
	const rows: [string, unknown, string][] = [
		["total", undefined, "total"], ["total", messages.length + 1, "messages"],
		["messages", messages.slice(1), "messages"], ["messages", [...messages.slice(0, 3), { role: "user", summary: false }], "messages"],
		["messages", [messages[0], ...message("toolCalls", [{ id: "c1", name: "compress" }])], "messages"],
		["messages", [messages[0], withField(messages[1]!, "toolCalls", [{ id: "c1", name: "compress", argsHash: "x", compactedArgsHash: 1 }]), ...messages.slice(2)], "messages"],
		["messages", [...messages.slice(0, 2), withField(messages[2]!, "toolResult", { toolCallId: "c1", toolName: "compress", isError: "no" }), messages[3]], "messages"],
		["messages", [messages[0], ...message("toolEvidence", "partial")], "messages"],
		["messages", [...messages.slice(0, 3), withField(messages[3]!, "topicHash", 4)], "messages"],
		["tagsSeen", undefined, "tagsSeen"],
		["activeFoldCount", -1, "activeFoldCount"],
		["activeFoldIds", ["b1", "b1"], "activeFoldIds"],
		["activeFoldIdsCapped", "no", "activeFoldIdsCapped"],
		["expectedSummaryHashes", [1], "expectedSummaryHashes"],
		["expectedSummaryTopicHashes", "t4", "expectedSummaryTopicHashes"],
		["firstUserFolded", { role: "user" }, "firstUserFolded"],
		["firstUserReplacementHash", 3, "firstUserReplacementHash"],
	];
	for (const [field, value, fault] of rows) assert.equal(requestHashesFault(withField(oursHashes, field, value)), fault, `${field}=${JSON.stringify(value)}`);
	assert.equal(requestHashesFault({ ...bcpHashes, messages: [...messages, ...messages], total: messages.length * 2 + 1 }), "messages");
});

test("a conclusive compress record needs both sides' evidence, parse evidence and uncapped refs", () => {
	const rows: [string, unknown, string][] = [
		["toolCallId", "", "call id missing"],
		["ours", undefined, "ours block evidence invalid: missing"],
		["bcp", withField(bcpBlocks, "partialEntries", undefined), "bcp block evidence invalid: partialEntries"],
		["oursOutcome", undefined, "oursOutcome invalid: missing"],
		["bcpOutcome", { type: "bogus", reasons: [] }, "bcpOutcome invalid: type"],
		["parseKind", "weird", "parse evidence missing or unknown"], ["parseKind", undefined, "parse evidence missing or unknown"],
		["parseInvalidItems", undefined, "parse evidence missing or unknown"],
		["refs", undefined, "ref evidence missing"], ["refs", [{ bcp: 1 }], "ref evidence missing"], ["refs", [{ bcp: "m1", ours: 2 }], "ref evidence missing"],
		["refContinuity", { same: 1, used: 3 }, "ref evidence capped or inconsistent"], ["refContinuity", { same: 3, used: 2 }, "ref evidence capped or inconsistent"],
		["refContinuity", undefined, "ref evidence capped or inconsistent"],
		["ours", { ...oursBlocks, createdIds: ["b1"], blockIdsCapped: true }, "block ids capped"],
	];
	for (const [field, value, fault] of rows) assert.equal(parityEvidenceFault(withField(call, field, value)), fault, `${field}=${JSON.stringify(value)}`);
});

test("a conclusive request needs linked call ids, both sides' hashes and consistent summary evidence", () => {
	const rows: [string, unknown, string][] = [
		["toolCallIds", [], "call ids missing"], ["toolCallIds", [""], "call ids missing"], ["toolCallIds", undefined, "call ids missing"],
		["ours", withField(oursHashes, "tagsSeen", undefined), "ours request hashes invalid: tagsSeen"],
		["bcp", { ...bcpHashes, total: 9 }, "bcp request hashes invalid: messages"],
		["ours", { ...oursHashes, expectedSummaryHashes: [] }, "expected summary evidence disagrees with active fold count"],
		["ours", withField(oursHashes, "expectedSummaryTopicHashes", undefined), "expected summary evidence unavailable"],
	];
	for (const [field, value, fault] of rows) assert.equal(parityEvidenceFault(withField(request, field, value)), fault, `${field}=${JSON.stringify(value)}`);
});

test("verdicts and diff kinds come from the closed vocabularies; inconclusive records need no evidence", () => {
	assert.equal(parityEvidenceFault(withField(call, "kind", "summary")), "unknown record kind");
	assert.equal(parityEvidenceFault(withField(call, "verdict", "accepted")), "record verdict missing or unknown");
	assert.equal(parityEvidenceFault(withField(call, "diffs", undefined)), "stored diffs missing or of an unknown kind");
	assert.equal(parityEvidenceFault({ ...call, verdict: "diff", diffs: [{ kind: "bogus" }] }), "stored diffs missing or of an unknown kind");
	assert.equal(parityEvidenceFault({ ...call, diffs: [{ kind: "coverage" }] }), "record verdict disagrees with stored diffs");
	assert.equal(parityEvidenceFault({ ...call, verdict: "diff" }), "record verdict disagrees with stored diffs");
	assert.equal(parityEvidenceFault("record"), "record is not an object");
	// Inconclusive records never count as results, so they need only a known verdict and known diff kinds.
	const bare = { ...base, kind: "compress", toolCallId: "c1", verdict: "inconclusive", diffs: [{ kind: "side-file-missing" }] };
	assert.equal(parityEvidenceFault(bare), undefined);
	assert.equal(parityEvidenceFault({ ...bare, diffs: [{ kind: "missing-side-file" }] }), "stored diffs missing or of an unknown kind");
});

// ---- Refusal, counterfactual and delta evidence (review round 4, CR-REQUEST-ATTRIBUTION) ----

/** A type alias's string-literal union in records.ts. */
function recordsUnion(name: string): string[] {
	const source = ts.createSourceFile("records.ts", fs.readFileSync("src/parity/records.ts", "utf8"), ts.ScriptTarget.Latest, true);
	const alias = source.statements.find((node): node is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(node) && node.name.text === name);
	assert.ok(alias && ts.isUnionTypeNode(alias.type), name);
	return alias.type.types.map((node) => {
		assert.ok(ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal));
		return node.literal.text;
	});
}
/** RequestDelta's members in records.ts, each with whether it is optional. */
function requestDeltaMembers(): Map<string, boolean> {
	const source = ts.createSourceFile("records.ts", fs.readFileSync("src/parity/records.ts", "utf8"), ts.ScriptTarget.Latest, true);
	const declaration = source.statements.find((node): node is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(node) && node.name.text === "RequestDelta");
	assert.ok(declaration);
	return new Map(declaration.members.map((member) => {
		assert.ok(ts.isPropertySignature(member) && ts.isIdentifier(member.name));
		return [member.name.text, !!member.questionToken];
	}));
}
/**
 * Every delta `refusedFoldDelta` in compare.ts can write, read from its source: the verdict, the
 * reason, and the fields each one sets. `other(reason, extra)` adds `...counts` and `extra`; the one
 * `refused-folds-only` return names its fields directly. A spread of `counts` adds that object's keys.
 */
function writerDeltas(): { verdict: string; reason?: string; fields: string[] }[] {
	const source = ts.createSourceFile("compare.ts", fs.readFileSync("src/parity/compare.ts", "utf8"), ts.ScriptTarget.Latest, true);
	const writer = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "refusedFoldDelta");
	assert.ok(writer?.body);
	const objects = new Map<string, string[]>();
	const keys = (object: ts.ObjectLiteralExpression): string[] => object.properties.flatMap((property) => {
		if (ts.isSpreadAssignment(property)) {
			assert.ok(ts.isIdentifier(property.expression) && objects.has(property.expression.text), property.getText());
			return objects.get(property.expression.text)!;
		}
		assert.ok(property.name && ts.isIdentifier(property.name), property.getText());
		return [property.name.text];
	});
	const deltas: { verdict: string; reason?: string; fields: string[] }[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isObjectLiteralExpression(node.initializer)) objects.set(node.name.text, keys(node.initializer));
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "other") {
			const [reason, extra] = node.arguments;
			assert.ok(reason && ts.isStringLiteral(reason));
			const extras = extra ? (assert.ok(ts.isObjectLiteralExpression(extra)), keys(extra)) : [];
			deltas.push({ verdict: "other", reason: reason.text, fields: ["verdict", "reason", ...objects.get("counts")!, ...extras] });
		}
		if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) {
			const verdict = node.expression.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText() === "verdict");
			assert.ok(verdict && ts.isPropertyAssignment(verdict) && ts.isStringLiteral(verdict.initializer));
			deltas.push({ verdict: verdict.initializer.text, fields: keys(node.expression) });
		}
		ts.forEachChild(node, visit);
	};
	visit(writer.body);
	return deltas;
}
/** A delta the writer could produce: each field it sets, with counts of 1. */
const writtenDelta = (shape: { verdict: string; reason?: string; fields: string[] }): Record<string, unknown> =>
	Object.fromEntries(shape.fields.map((field) => [field, field === "verdict" ? shape.verdict : field === "reason" ? shape.reason : 1]));

test("the delta validator accepts exactly the deltas the writer produces, with every field it sets", () => {
	const shapes = writerDeltas();
	const members = requestDeltaMembers();
	// The writer covers every closed reason once, and refused-folds-only once.
	assert.deepEqual(shapes.filter((shape) => shape.verdict === "other").map((shape) => shape.reason).sort(), recordsUnion("RequestDeltaReason").sort());
	assert.deepEqual(shapes.filter((shape) => shape.verdict !== "other").map((shape) => shape.verdict), ["refused-folds-only"]);
	for (const shape of shapes) {
		const label = shape.reason ?? shape.verdict;
		const delta = writtenDelta(shape);
		assert.equal(requestDeltaFault(delta), undefined, label);
		// Every field the writer sets is a RequestDelta member, and every required member is set.
		for (const field of shape.fields) assert.ok(members.has(field), `${label}: ${field}`);
		for (const [member, optional] of members) if (!optional) assert.ok(shape.fields.includes(member), `${label}: ${member}`);
		// Removing any field the writer sets, or adding a member it never sets, is a fault.
		for (const field of shape.fields) assert.notEqual(requestDeltaFault(withField(delta, field, undefined)), undefined, `${label} without ${field}`);
		for (const member of members.keys()) if (!shape.fields.includes(member)) assert.notEqual(requestDeltaFault({ ...delta, [member]: member === "reason" ? "message-changed" : 1 }), undefined, `${label} with ${member}`);
		// Counts are safe non-negative integers.
		for (const field of shape.fields.filter((field) => field !== "verdict" && field !== "reason")) {
			for (const bad of [1.5, -1, "1", null, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) assert.equal(requestDeltaFault({ ...delta, [field]: bad }), field, `${label}: ${field}=${String(bad)}`);
		}
	}
});

test("the delta validator rejects verdicts and reasons outside the closed combinations", () => {
	const only = { verdict: "refused-folds-only", refusedFolds: 1, coveredEntries: 4, removedMessages: 4 };
	assert.equal(requestDeltaFault(only), undefined);
	for (const reason of recordsUnion("RequestDeltaReason")) assert.equal(requestDeltaFault({ ...only, reason }), "reason", reason);
	assert.equal(requestDeltaFault({ ...only, verdict: "other", reason: "bogus" }), "reason");
	assert.equal(requestDeltaFault({ ...only, verdict: "other" }), "reason");
	assert.equal(requestDeltaFault({ ...only, verdict: "yes" }), "verdict");
	assert.equal(requestDeltaFault({ ...only, note: "extra" }), "unknown field");
	for (const value of [null, undefined, [], "refused-folds-only"]) assert.equal(requestDeltaFault(value), "missing", String(value));
});

test("refusal evidence needs refused calls of this batch with closed endings, well-formed diffs, a valid delta and the counterfactual's hashes", () => {
	const refusal = { ...request, toolCallIds: ["c1", "c2"], refused: [{ toolCallId: "c1", type: "dead-range" }], counterfactual: { diffs: [{ kind: "summaries" }], delta: { verdict: "refused-folds-only", refusedFolds: 1, coveredEntries: 4, removedMessages: 4 } }, counterfactualOurs: oursHashes };
	assert.equal(refusalEvidenceFault(refusal), undefined);
	// Every refusal ending is accepted.
	for (const type of recordsUnion("OutcomeType").filter(isRefusalOutcome)) assert.equal(refusalEvidenceFault({ ...refusal, refused: [{ toolCallId: "c1", type }] }), undefined, type);
	const rows: [string, unknown, string][] = [
		["refused", undefined, "refused"], ["refused", [], "refused"], ["refused", { toolCallId: "c1", type: "dead-range" }, "refused"],
		["refused", [{ toolCallId: "c1", type: "dead-range" }, null], "refused call id"],
		["refused", [{ toolCallId: "c1", type: "dead-range" }, { toolCallId: "", type: "dead-range" }], "refused call id"],
		["refused", [{ toolCallId: "c1", type: "dead-range" }, { toolCallId: 2, type: "dead-range" }], "refused call id"],
		["refused", [{ toolCallId: "c1", type: "dead-range" }, { toolCallId: "c9", type: "dead-range" }], "refused call id"],
		["refused", [{ toolCallId: "c1", type: "dead-range" }, { toolCallId: "c1", type: "aborted" }], "refused call repeated"],
		["refused", [{ toolCallId: "c1", type: "dead-range" }, { toolCallId: "c2", type: "rejected" }], "refused ending"],
		["refused", [{ toolCallId: "c1", type: "dead-range" }, { toolCallId: "c2", type: "bogus" }], "refused ending"],
		["counterfactual", undefined, "counterfactual"], ["counterfactual", [], "counterfactual"],
		["counterfactual", { delta: refusal.counterfactual.delta }, "counterfactual diffs"],
		["counterfactual", { diffs: "none", delta: refusal.counterfactual.delta }, "counterfactual diffs"],
		["counterfactual", { diffs: [null], delta: refusal.counterfactual.delta }, "counterfactual diffs"],
		["counterfactual", { diffs: [{ kind: "bogus" }], delta: refusal.counterfactual.delta }, "counterfactual diffs"],
		["counterfactual", { diffs: [{ kind: "summaries", oursOnlyCount: -1 }], delta: refusal.counterfactual.delta }, "counterfactual diffs"],
		["counterfactual", { diffs: [{ kind: "summaries", bcpOnly: [1] }], delta: refusal.counterfactual.delta }, "counterfactual diffs"],
		["counterfactual", { diffs: [{ kind: "summaries", reason: 5 }], delta: refusal.counterfactual.delta }, "counterfactual diffs"],
		["counterfactual", { diffs: [] }, "counterfactual delta missing"],
		["counterfactual", { diffs: [], delta: { verdict: "refused-folds-only" } }, "counterfactual delta refusedFolds"],
		["counterfactualOurs", undefined, "counterfactualOurs missing"],
		["counterfactualOurs", { ...oursHashes, total: 9 }, "counterfactualOurs messages"],
	];
	for (const [field, value, fault] of rows) assert.equal(refusalEvidenceFault(withField(refusal, field, value)), fault, `${field}=${JSON.stringify(value)}`);
});
