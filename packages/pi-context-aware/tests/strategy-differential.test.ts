/**
 * Differential test for the plan checker (pi-context-aware#468, REQ-STRAT-003): recorded `context_fold`
 * requests give the same accept or refuse result, the same refusal text and the same fold records as
 * before `planFold` took its refusals from the checker.
 *
 * The requests are synthetic: the parity corpus (tests/fixtures/parity-corpus/cases.json), and one case
 * per refusal cause the fold audit counted (pi-context-aware#457), in tests/fixtures/strategy-differential.
 * `expected.json` holds what `planFold` returned for each request at 68a124e, before the change, less the
 * twelve null hides pi-context-aware#441 stopped writing for entries an absorbed fold already hid. Set
 * STRATEGY_DIFFERENTIAL_RECORD=1 to write it again; only do that on a commit whose fold decisions are
 * known good, because the file is the old path's record.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { foldStateFromBranch, planFold, planFoldCoded, summarizeEngine, type FoldPlan, type FoldPlanInput } from "../src/folds/fold-adapter.js";
import { applyFoldDrafts } from "../src/folds/fold-engine.js";
import { baseIdOf } from "../src/folds/kernel/index.js";
import { buildContextView, checkPlan, refusalCodeOf } from "../src/strategy-runtime/index.js";
import type { RefusalCode } from "../src/strategy/index.js";
import { differentialCases, FIXTURES, seedCase, type DifferentialCase, type DifferentialRequest, type Seeded } from "./strategy-differential-cases.js";

const EXPECTED = path.join(FIXTURES, "strategy-differential/expected.json");

/** `planFold` for one recorded request on the session as it stands. */
export function planRequest(seeded: Seeded, request: DifferentialRequest): FoldPlan {
	return planFold(requestInput(seeded, request));
}

function requestInput(seeded: Seeded, request: DifferentialRequest): FoldPlanInput {
	const { manager } = seeded;
	return {
		startRef: request.startId,
		endRef: request.endId,
		summary: request.summary,
		...(request.topic ? { topic: request.topic } : {}),
		...(request.summaryMaxChars !== undefined ? { summaryMaxChars: request.summaryMaxChars } : {}),
		branch: manager.getBranch(),
		contextEntries: manager.buildContextEntries(),
		modelContextLimit: seeded.modelContextLimit,
		...(seeded.hints ? { hints: seeded.hints } : {}),
	};
}

/** What a request's plan is compared on: accept or refuse, the refusal text, the records and drafts, with entry ids as message numbers. */
export function comparable(plan: FoldPlan, seeded: Seeded, branch: readonly SessionEntry[]): unknown {
	const shape = plan.ok
		? { ok: true, records: plan.records, drafts: plan.drafts, warnings: plan.warnings }
		: { ok: false, errors: plan.errors, validRefs: plan.validRefs };
	const names = new Map<string, string>(branch.map((entry, index) => [entry.id, `#${seeded.ids.indexOf(entry.id) >= 0 ? seeded.ids.indexOf(entry.id) + 1 : `e${index}`}`]));
	const ids = [...names.keys()].sort((a, b) => b.length - a.length).map((id) => id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
	const pattern = ids.length > 0 ? new RegExp(ids.join("|"), "gu") : undefined;
	const walk = (value: unknown, key?: string): unknown => {
		if (key === "createdAt" && typeof value === "number") return 0;
		if (typeof value === "string") return pattern ? value.replace(pattern, (id) => names.get(id)!) : value;
		if (Array.isArray(value)) return value.map((item) => walk(item));
		if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
		return value;
	};
	return walk(shape);
}

/** Every request of a case, step by step: requests of one step plan in order, each on the branch the ones before it wrote. */
export function runCase(item: DifferentialCase, plan: (seeded: Seeded, request: DifferentialRequest) => FoldPlan = planRequest): unknown[] {
	const seeded = seedCase(item);
	const outcomes: unknown[] = [];
	for (const step of item.steps) {
		for (const request of step) {
			const result = plan(seeded, request);
			outcomes.push(comparable(result, seeded, seeded.manager.getBranch()));
			if (result.ok) applyFoldDrafts(seeded.manager, result.drafts);
		}
	}
	return outcomes;
}

const record = process.env.STRATEGY_DIFFERENTIAL_RECORD === "1";
const expected: Record<string, unknown[]> = record ? {} : JSON.parse(fs.readFileSync(EXPECTED, "utf8")) as Record<string, unknown[]>;
const recorded: Record<string, unknown[]> = {};

for (const item of differentialCases()) {
	test(`REQ-STRAT-003 differential: ${item.id} plans as recorded before the checker`, () => {
		const actual = runCase(item);
		if (record) { recorded[item.id] = actual; return; }
		assert.ok(expected[item.id], `expected.json records ${item.id}`);
		assert.deepEqual(actual, expected[item.id]);
	});
}

/**
 * The code each refused request gets, by case and request number: one case per refusal cause the fold
 * audit counted (pi-context-aware#457), and the engine's other refusals. Requests not listed are accepted.
 */
const CODES: Record<string, Record<number, RefusalCode>> = {
	"parity-invalid-range": { 0: "unknown-ref" },
	"already-compressed": { 1: "already-folded" },
	"already-compressed-overlap": { 1: "already-folded" },
	"same-step-overlap": { 1: "already-folded" },
	"first-user-and-folded": { 1: "already-folded" },
	"kept-verbatim": { 0: "kept-verbatim" },
	"condensed-all": { 0: "condenses-instead" },
	"too-small": { 0: "too-small" },
	"pair-at-zone": { 0: "too-small" },
	"stub-summary": { 0: "summary-stub" },
	"summary-too-long": { 0: "summary-long" },
	"summary-too-short": { 0: "summary-short" },
	"summary-empty": { 0: "summary-empty" },
	"protected-zone": { 0: "protected-zone" },
	"pair-tail-split": { 0: "protected-zone" },
	"first-user-only": { 0: "first-user-kept" },
	"unknown-ref": { 0: "unknown-ref" },
	"invalid-ref": { 0: "unknown-ref" },
	"pair-zone-only": { 0: "split-pair" },
};

for (const item of differentialCases()) {
	test(`REQ-STRAT-002 differential: ${item.id} refuses with the code its cause names, and each code is the one its message is classified by`, () => {
		const found: Record<number, RefusalCode> = {};
		let index = 0;
		runCase(item, (seeded, request) => {
			const coded = planFoldCoded(requestInput(seeded, request));
			if (!coded.ok) {
				for (const refusal of coded.refusals) assert.equal(refusalCodeOf(refusal.message), refusal.code, refusal.message);
				assert.equal(coded.refusals.length, 1, "one refusal per refused request");
				found[index] = coded.refusals[0]!.code;
			}
			index++;
			return coded.ok ? coded : { ok: false, errors: coded.refusals.map((refusal) => refusal.message), validRefs: coded.validRefs };
		});
		assert.deepEqual(found, CODES[item.id] ?? {});
	});

	test(`REQ-STRAT-003 differential: ${item.id} gets the same verdict and records through checkPlan as recorded before the checker`, () => {
		if (record) return;
		// A summarize operation carries no summary limit: a request that sets one is planned by planFold and not compared.
		const uncompared = new Set<number>();
		let index = 0;
		const actual = runCase(item, (seeded, request) => {
			const i = index++;
			if (request.summaryMaxChars === undefined) return checkedRequest(seeded, request);
			uncompared.add(i);
			return planRequest(seeded, request);
		});
		const old = expected[item.id] as { ok: boolean; errors?: string[] }[];
		assert.equal(actual.length, old.length);
		actual.forEach((outcome, i) => {
			if (uncompared.has(i)) return;
			const now = outcome as { ok: boolean; errors?: string[] };
			if (old[i]!.ok) assert.deepEqual(now, old[i], `request ${i} is accepted with the same records`);
			else assert.equal(now.ok, false, `request ${i} is refused`);
		});
	});
}

/** The request as a strategy's `summarize` operation: each ref as the entry it names, a fold id as itself. Unknown refs stay as they are, and no entry has that id. */
function checkedRequest(seeded: Seeded, request: DifferentialRequest): FoldPlan {
	const { manager } = seeded;
	const branch = manager.getBranch();
	const contextEntries = manager.buildContextEntries();
	const refs = foldStateFromBranch(branch, contextEntries).kernel.messageRefs.byRef;
	const entryOf = (ref: string) => (refs[ref] !== undefined ? baseIdOf(refs[ref]) : ref);
	const view = buildContextView({ branch, contextEntries, projection: manager.buildSessionProjection(), model: { id: "differential", contextWindow: seeded.modelContextLimit }, tokens: 0, reachableTools: [], registeredTools: [], ...(seeded.hints ? { hints: seeded.hints } : {}), now: 1, compactionOwner: "none" });
	const engine = summarizeEngine({ branch, contextEntries, modelContextLimit: seeded.modelContextLimit, ...(seeded.hints ? { hints: seeded.hints } : {}) });
	const op = { kind: "summarize", startId: entryOf(request.startId), endId: entryOf(request.endId), writer: "plan", summary: request.summary, ...(request.topic ? { topic: request.topic } : {}) } as const;
	const check = checkPlan(view, [op], engine);
	if (!check.ok) return { ok: false, errors: check.refusals.map((refusal) => refusal.message), validRefs: [] };
	const effect = check.effects[0];
	assert.ok(effect?.kind === "summarize" && check.effects.length === 1, JSON.stringify(check));
	return { ok: true, records: [...effect.records], drafts: [...effect.drafts], warnings: [...effect.warnings] };
}

if (record) {
	test.after(() => fs.writeFileSync(EXPECTED, JSON.stringify(recorded, null, "\t") + "\n"));
}