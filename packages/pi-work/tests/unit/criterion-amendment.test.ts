import assert from "node:assert/strict";
import test from "node:test";

import { amendCriterion, type CriterionAmendmentRequest } from "../../src/amend/index.ts";
import { parseYaml, validateWorkspec } from "../../src/schema/index.ts";
import { withDraftLineage } from "../helpers/workspec-source.ts";

const ORIGINAL = "The promoted criterion text";
const FIRST = "The first amended criterion text";
const SECOND = "The second amended criterion text";

const SOURCE = withDraftLineage(`title: amendment
description: d
intent: i
work:
  - id: node
    task: change one criterion
    acceptance:
      - id: A1
        statement: ${JSON.stringify(ORIGINAL)}
        evidence:
          kind: command
          run: !bash |
            printf signal
          expect:
            exit: 0
            output_includes: signal
`);

function request(overrides: Partial<CriterionAmendmentRequest> = {}): CriterionAmendmentRequest {
	return {
		criterionId: "A1",
		before: ORIGINAL,
		after: FIRST,
		reason: "The accepted design changed.",
		authority: "https://gitlab.example.test/group/project/-/issues/14",
		at: "2026-08-14T18:00:00.000Z",
		...overrides,
	};
}

test("amendCriterion appends exact history and produces a valid chain endpoint", () => {
	const first = amendCriterion(SOURCE, request());
	assert.equal(first.ok, true);
	if (!first.ok) return;
	assert.deepEqual(first.path, ["work", 0, "acceptance", 0]);
	const expectedRecord = [
		"        amendments:",
		"          - criterion_id: \"A1\"",
		`            before: ${JSON.stringify(ORIGINAL)}`,
		`            after: ${JSON.stringify(FIRST)}`,
		"            reason: \"The accepted design changed.\"",
		"            authority: \"https://gitlab.example.test/group/project/-/issues/14\"",
		"            at: \"2026-08-14T18:00:00.000Z\"",
		"",
	].join("\n");
	assert.equal(first.specSource, SOURCE
		.replace(`statement: ${JSON.stringify(ORIGINAL)}`, `statement: ${JSON.stringify(FIRST)}`)
		.replace("            output_includes: signal\n", `            output_includes: signal\n${expectedRecord}`));
	assert.equal(validateWorkspec(first.specSource).valid, true);

	const second = amendCriterion(first.specSource, request({
		before: FIRST,
		after: SECOND,
		reason: "A later authority clarified the wording.",
		authority: "ADR-0021",
		at: "2026-08-15T09:30:00.000Z",
	}));
	assert.equal(second.ok, true);
	if (!second.ok) return;
	assert.equal(validateWorkspec(second.specSource).valid, true);
	const value = parseYaml(second.specSource).value as {
		work: { acceptance: { statement: string; amendments: unknown[] }[] }[];
	};
	const criterion = value.work[0].acceptance[0];
	assert.equal(criterion.statement, SECOND);
	assert.deepEqual(criterion.amendments, [
		{
			criterion_id: "A1",
			before: ORIGINAL,
			after: FIRST,
			reason: "The accepted design changed.",
			authority: "https://gitlab.example.test/group/project/-/issues/14",
			at: "2026-08-14T18:00:00.000Z",
		},
		{
			criterion_id: "A1",
			before: FIRST,
			after: SECOND,
			reason: "A later authority clarified the wording.",
			authority: "ADR-0021",
			at: "2026-08-15T09:30:00.000Z",
		},
	]);
});

test("amendCriterion preserves valid block YAML while replacing plain and tagged block statements", () => {
	const encodings = [
		{ label: "plain", field: "statement: plain text", before: "plain text" },
		{ label: "tagged block", field: "statement: !md |-\n          block text\n          second line", before: "block text\nsecond line" },
	];
	for (const encoding of encodings) {
		const source = withDraftLineage(`title: ${encoding.label}\ndescription: d\nintent: i\nwork:\n  - id: node\n    task: amend\n    acceptance:\n      - id: A1\n        ${encoding.field}\n        evidence:\n          kind: user\n          prompt: confirm\n`);
		const result = amendCriterion(source, request({ before: encoding.before }));
		assert.equal(result.ok, true, encoding.label);
		if (!result.ok) continue;
		assert.equal(validateWorkspec(result.specSource).valid, true, encoding.label);
		assert.match(result.specSource, /statement: "The first amended criterion text"\n {8}evidence:/, encoding.label);
	}
});

test("amendCriterion refuses invalid source, unknown ids, stale before text, no-ops, and incomplete records", () => {
	const cases = [
		[amendCriterion("work: [", request()), "invalid-spec"],
		[amendCriterion(SOURCE, request({ criterionId: "missing" })), "criterion-not-found"],
		[amendCriterion(SOURCE, request({ before: "stale text" })), "criterion-before-mismatch"],
		[amendCriterion(SOURCE, request({ after: ORIGINAL })), "criterion-amendment-noop"],
		[amendCriterion(SOURCE, request({ reason: "" })), "invalid-request"],
		[amendCriterion(SOURCE, { ...request(), authority: undefined } as unknown as CriterionAmendmentRequest), "invalid-request"],
	] as const;
	for (const [result, code] of cases) {
		assert.equal(result.ok, false, code);
		if (!result.ok) assert.equal(result.code, code);
	}
});
