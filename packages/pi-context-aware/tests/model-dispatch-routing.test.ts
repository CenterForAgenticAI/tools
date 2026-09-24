import test from "node:test";
import assert from "node:assert/strict";
import { MODEL_DISPATCH_DECISIONS } from "../index.js";

test("model dispatch parity matrix covers every extension-owned call site", () => {
	assert.deepEqual(
		MODEL_DISPATCH_DECISIONS.map(({ site, dispatch, api }) => ({ site, dispatch, api })),
		[
			{ site: "cache artifacts", dispatch: "routed", api: "complete" },
			{ site: "seed generation", dispatch: "adaptive", api: "streamSimple|complete" },
			{ site: "seed expansion", dispatch: "adaptive", api: "streamSimple|complete" },
			{ site: "override summary", dispatch: "routed", api: "complete" },
			{ site: "compaction primary stream", dispatch: "adaptive", api: "streamSimple|complete" },
			{ site: "compaction retry/fallback", dispatch: "adaptive", api: "streamSimple|complete" },
			{ site: "workstream activity", dispatch: "routed", api: "complete" },
			{ site: "session naming", dispatch: "routed", api: "complete" },
		],
	);
	assert.equal(new Set(MODEL_DISPATCH_DECISIONS.map(({ site }) => site)).size, 8);
});

test("every retained streaming site keeps an operator-visible failure classification", () => {
	for (const decision of MODEL_DISPATCH_DECISIONS) {
		if (decision.dispatch !== "routed") assert.match(decision.visibility, /UI/u, decision.site);
	}
});

test("every adaptive site can route through complete when compat cannot dispatch", () => {
	for (const decision of MODEL_DISPATCH_DECISIONS) {
		if (decision.dispatch === "adaptive") assert.match(decision.api, /\bcomplete\b/u, decision.site);
	}
});
