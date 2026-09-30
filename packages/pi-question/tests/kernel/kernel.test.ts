import assert from "node:assert/strict";
import { test } from "node:test";
import type { Question, QuestionAnswer } from "../../src/contract/index.ts";
import { DEFAULTS, mergeConfig } from "../../src/config.ts";
import { expire, mayDefault, settle } from "../../src/kernel/expire.ts";
import { allowedFrom, chooseSurface } from "../../src/kernel/select.ts";
import { withBlockedSignal } from "../../src/kernel/signals.ts";

const q = (extra: Partial<Question> = {}): Question => ({ id: "a", question: "A?", options: [{ label: "x" }, { label: "y" }], ...extra });
const policies = ["cancel", "recommended", "error"] as const;
const categories = [undefined, "implementation", "scope-product", "security-permission"] as const;

// L3: expiry never yields a human answer.
test("expire never reports a human answer without the defaulted marker", () => {
	for (const p of policies) for (const category of categories) for (const recommended of [undefined, 1]) {
		const e = expire(p, q({ ...(category ? { category } : {}), ...(recommended !== undefined ? { recommended } : {}) }));
		if (e.kind === "resolved" && e.answer.status === "answered") assert.equal(e.answer.defaulted, true);
	}
});

// L4
test("cancel policy reports a timeout with no choice", () => {
	assert.deepEqual(expire("cancel", q({ recommended: 1 })), { kind: "resolved", answer: { id: "a", status: "timeout", selected: [] } });
});

// L5, L6
test("scope/product and security decisions are never defaulted", () => {
	for (const category of ["scope-product", "security-permission"] as const) {
		assert.equal(mayDefault(q({ category })), false);
		const e = expire("recommended", q({ category, recommended: 0 }));
		assert.ok(e.kind === "resolved" && e.answer.status === "timeout" && e.answer.selected.length === 0);
	}
});

// L7, L8
test("a default is the question's own recommendation; none without one", () => {
	const yes = expire("recommended", q({ recommended: 1, category: "implementation" }));
	assert.ok(yes.kind === "resolved" && yes.answer.status === "answered" && yes.answer.selected[0] === 1 && yes.answer.defaulted === true);
	const none = expire("recommended", q());
	assert.ok(none.kind === "resolved" && none.answer.status === "timeout");
});

test("error policy fails the call", () => {
	assert.deepEqual(expire("error", q()), { kind: "failed" });
});

// L1, L2
test("the first outcome wins", () => {
	const a: QuestionAnswer = { id: "a", status: "answered", selected: [0] };
	const b: QuestionAnswer = { id: "a", status: "cancelled", selected: [] };
	assert.equal(settle(settle(undefined, a), b), a);
});

// L10-L13, checked over every input
test("surface selection obeys the surface laws", () => {
	const bools = [true, false];
	for (const host of bools) for (const interactive of bools) for (const ui of bools)
		for (const ah of bools) for (const at of bools) for (const ad of bools) {
			const allowed = { host: ah, tui: at, dialogs: ad };
			const s = chooseSurface({ host, interactive, ui }, allowed);
			if (s === "host") assert.ok(ah);
			if (s === "tui") assert.ok(at);
			if (s === "dialogs") assert.ok(ad);
			if (!ui) assert.ok(s === "host" || s === "none");
			if (!interactive) assert.notEqual(s, "tui");
			if (host && ah) assert.equal(s, "host");
		}
});

test("allowedFrom reads the config list", () => {
	assert.deepEqual(allowedFrom(["dialogs"]), { host: false, tui: false, dialogs: true });
});

// L14, L15
test("blocked signal is raised and cleared exactly once, even on throw", async () => {
	const seen: unknown[] = [];
	const events = { emit: (_c: string, d: unknown) => void seen.push(d) };
	await assert.rejects(withBlockedSignal(events, "dialogs", "L", true, async () => { throw new Error("boom"); }));
	assert.deepEqual(seen, [{ active: true, label: "L" }, { active: false }]);
});

test("no signal for the none surface or when disabled", async () => {
	const seen: unknown[] = [];
	const events = { emit: (_c: string, d: unknown) => void seen.push(d) };
	await withBlockedSignal(events, "none", "L", true, async () => 1);
	await withBlockedSignal(events, "dialogs", "L", false, async () => 1);
	assert.deepEqual(seen, []);
});

test("a throwing listener never affects the ask", async () => {
	const events = { emit: () => { throw new Error("listener"); } };
	assert.equal(await withBlockedSignal(events, "dialogs", "L", true, async () => 7), 7);
});

test("invalid config layers fail closed with one warning each", () => {
	const warnings: string[] = [];
	const c = mergeConfig([{ onTimeout: "nope" }, { timeoutMs: 5, onTimeout: "recommended" }], (m) => warnings.push(m));
	assert.equal(warnings.length, 1);
	assert.equal(c.timeoutMs, 5);
	assert.equal(c.onTimeout, "recommended");
	assert.deepEqual(mergeConfig([undefined], () => {}), DEFAULTS);
});
