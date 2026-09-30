import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDetails, narrate, type Question } from "../../src/contract/index.ts";

const q: Question = { id: "auth", question: "Which auth?", options: [{ label: "JWT" }, { label: "Session" }] };
const dialogs = { surface: "dialogs", degraded: false } as const;

test("matches pi-ask-tool summary lines", () => {
	const text = narrate([q], [{ id: "auth", status: "answered", selected: [1] }], dialogs);
	assert.match(text, /^User answers:\nauth: Session$/m);
});

test("names an unavailable surface instead of an empty selection", () => {
	const text = narrate([q], [{ id: "auth", status: "unavailable", selected: [] }], { surface: "none", degraded: false });
	assert.match(text, /auth: \(unavailable\)/);
	assert.match(text, /No human answer surface/);
});

test("details mirror pi-ask-tool fields for a single question", () => {
	const details = buildDetails([q], [{ id: "auth", status: "answered", selected: [0], customText: "with refresh" }], dialogs);
	assert.equal(details.id, "auth");
	assert.deepEqual(details.selectedOptions, ["JWT"]);
	assert.equal(details.customInput, "with refresh");
	assert.equal(details.results?.length, 1);
});
