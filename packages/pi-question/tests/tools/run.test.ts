import assert from "node:assert/strict";
import { test } from "node:test";
import type { AskSurface } from "../../src/adapters/surface.ts";
import { DEFAULTS, type PiQuestionConfig } from "../../src/config.ts";
import type { Question, QuestionAnswer } from "../../src/contract/index.ts";
import { runAsk } from "../../src/tools/run.ts";

const question: Question = { id: "a", question: "A?", options: [{ label: "x" }, { label: "y" }], recommended: 1 };

// A surface that never answers on its own; it settles as cancelled when aborted.
const hanging: AskSurface = {
	delivery: { surface: "dialogs", degraded: false },
	ask: (questions, signal) =>
		new Promise<QuestionAnswer[]>((resolve) => {
			signal?.addEventListener("abort", () => resolve(questions.map((q) => ({ id: q.id, status: "cancelled", selected: [] }))), { once: true });
		}),
};

const config = (extra: Partial<PiQuestionConfig>): PiQuestionConfig => ({ ...DEFAULTS, ...extra });
const run = (c: PiQuestionConfig, q: Question = question) =>
	runAsk({ surface: hanging, questions: [q], signal: undefined, config: c, events: undefined });

test("no timeout: waits for the surface", async () => {
	const surface: AskSurface = { delivery: hanging.delivery, ask: async (qs) => qs.map((q) => ({ id: q.id, status: "answered", selected: [0] })) };
	const out = await runAsk({ surface, questions: [question], signal: undefined, config: DEFAULTS, events: undefined });
	assert.deepEqual(out, { kind: "answers", answers: [{ id: "a", status: "answered", selected: [0] }] });
});

test("cancel policy: a timeout is reported, never an answer", async () => {
	const out = await run(config({ timeoutMs: 20, onTimeout: "cancel" }));
	assert.deepEqual(out, { kind: "answers", answers: [{ id: "a", status: "timeout", selected: [] }] });
});

test("recommended policy: applies the recommendation and marks it defaulted", async () => {
	const out = await run(config({ timeoutMs: 20, onTimeout: "recommended" }));
	assert.ok(out.kind === "answers");
	assert.equal(out.answers[0]?.selected[0], 1);
	assert.equal(out.answers[0]?.defaulted, true);
});

test("recommended policy: a security question is not defaulted", async () => {
	const out = await run(config({ timeoutMs: 20, onTimeout: "recommended" }), { ...question, category: "security-permission" });
	assert.ok(out.kind === "answers");
	assert.equal(out.answers[0]?.status, "timeout");
});

test("error policy: the call fails", async () => {
	assert.deepEqual(await run(config({ timeoutMs: 20, onTimeout: "error" })), { kind: "failed" });
});

test("blocked signal clears after a timeout", async () => {
	const seen: unknown[] = [];
	await runAsk({ surface: hanging, questions: [question], signal: undefined, config: config({ timeoutMs: 20 }), events: { emit: (_c, d) => void seen.push(d) } });
	assert.deepEqual(seen.map((s) => (s as { active: boolean }).active), [true, false]);
});
