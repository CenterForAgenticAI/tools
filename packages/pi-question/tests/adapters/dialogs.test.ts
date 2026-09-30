import assert from "node:assert/strict";
import { test } from "node:test";
import { dialogSurface } from "../../src/adapters/dialogs.ts";
import { OTHER_OPTION, type Question } from "../../src/contract/index.ts";

const single: Question = { id: "a", question: "A?", options: [{ label: "x" }, { label: "y" }], recommended: 1 };

function ui(selects: (string | undefined)[], inputs: (string | undefined)[] = []) {
	return {
		select: async () => selects.shift(),
		input: async () => inputs.shift(),
	};
}

test("maps a recommended label back to its index", async () => {
	const [answer] = await dialogSurface(ui(["y (Recommended)"])).ask([single], undefined);
	assert.deepEqual(answer, { id: "a", status: "answered", selected: [1] });
});

test("Other opens a text input", async () => {
	const [answer] = await dialogSurface(ui([OTHER_OPTION], ["z"])).ask([single], undefined);
	assert.deepEqual(answer, { id: "a", status: "answered", selected: [], customText: "z" });
});

test("dismissal is cancelled, not an empty answer", async () => {
	const [answer] = await dialogSurface(ui([undefined])).ask([single], undefined);
	assert.equal(answer?.status, "cancelled");
});

test("multi-select parses numbers and keeps free text", async () => {
	const multi: Question = { ...single, multi: true };
	const [answer] = await dialogSurface(ui([], ["2, 1, extra"])).ask([multi], undefined);
	assert.deepEqual(answer, { id: "a", status: "answered", selected: [1, 0], customText: "extra" });
});
