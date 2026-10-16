import test from "node:test";
import assert from "node:assert/strict";

import {
	createBpeTokenizer,
	createCore,
	defaultCountTokens,
	estimateTokensFast,
	type Ports,
	type TokenCountFn,
} from "../src/folds/kernel/index.js";

/*
 * The vendored upstream test "TokenCountFn type is compatible with createCore ports" runs with
 * type annotations erased, so it cannot catch a type mismatch. This file is compiled by
 * `npm run test:compile` (tsconfig.test.json), so a tokenizer that stops fitting the port, or a
 * port type that stops checking its argument, fails the build.
 */
const tokenizers = {
	bpe: createBpeTokenizer(),
	fast: estimateTokensFast,
	default: defaultCountTokens,
} satisfies Record<string, TokenCountFn & NonNullable<Ports["countTokens"]>>;

// @ts-expect-error a token-count port must return a number
const wrongPort: Ports = { countTokens: (text: string) => text };
void wrongPort;

test("each kernel tokenizer type-checks as a createCore token-count port", () => {
	for (const [name, countTokens] of Object.entries(tokenizers)) {
		const ports: Ports = { countTokens };
		const core = createCore(ports);
		assert.equal(typeof core.applyCompression, "function", name);
		const count = countTokens("tokenizer port check");
		assert.ok(Number.isInteger(count) && count > 0, `${name} returned ${count}`);
	}
});
