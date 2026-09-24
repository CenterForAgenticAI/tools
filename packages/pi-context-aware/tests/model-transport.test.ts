import test from "node:test";
import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import { compatCanDispatch } from "../model-transport.js";

function model(api: string): Model<Api> {
	return { provider: "p", id: "m", api } as unknown as Model<Api>;
}

test("compatCanDispatch is true when the instance resolves the model's api", () => {
	const compat = { getApiProvider: (api: Api) => (api === "anthropic-messages" ? ({} as never) : undefined) };
	assert.equal(compatCanDispatch(compat, model("anthropic-messages")), true);
});

test("compatCanDispatch is false when the api is not registered in this instance", () => {
	// The #94 case: a runtime-registered api (e.g. multi-account's `unified`) is
	// absent from this package's own compat copy under a `packages:` load.
	const compat = { getApiProvider: (api: Api) => (api === "anthropic-messages" ? ({} as never) : undefined) };
	assert.equal(compatCanDispatch(compat, model("unified")), false);
});

test("compatCanDispatch treats a throwing lookup as non-dispatchable", () => {
	const compat = { getApiProvider: () => { throw new Error("boom"); } };
	assert.equal(compatCanDispatch(compat, model("unified")), false);
});
