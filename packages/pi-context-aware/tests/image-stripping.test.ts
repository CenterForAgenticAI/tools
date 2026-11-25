import test from "node:test";
import assert from "node:assert/strict";
import {
	detectPayloadProtocol,
	stripHistoricalImages,
	type ProviderPayloadProtocol,
} from "../src/media/image-stripping.js";
import {
	CLOSING_REPLY,
	FOLLOW_UP_REQUEST,
	OPENING_REQUEST,
	WIRE_APIS,
	captureProviderPayload,
	screenshotData,
	screenshotMarker,
	screenshotText,
	screenshotTranscript,
	type WireApi,
} from "./provider-payloads.js";

// issue #163. A session held 158 screenshots and every request
// overflowed. These tests strip real pi-ai request bodies.

const SCREENSHOTS = 120;
/** About 30 KB of decoded image per screenshot. */
const IMAGE_CHARS = 40_000;
/** Stated budget: the serialized request body must fit in 1 MB. */
const REQUEST_BUDGET_CHARS = 1_000_000;
const KEEP_RECENT = 5;

const EXPECTED_PROTOCOL: Record<WireApi, ProviderPayloadProtocol> = {
	"anthropic-messages": "anthropic-messages",
	"openai-completions": "openai-chat",
	"openai-responses": "openai-responses",
};

function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

for (const api of WIRE_APIS) {
	test(`${api}: ${SCREENSHOTS} screenshot results fit a 1 MB request after stripping, and every text survives`, async () => {
		const payload = await captureProviderPayload(api, screenshotTranscript(SCREENSHOTS, IMAGE_CHARS));
		const before = JSON.stringify(payload);
		assert.ok(before.length > REQUEST_BUDGET_CHARS * 4, `fixture must start far over budget, was ${before.length}`);

		const outcome = stripHistoricalImages(payload, { keepRecent: KEEP_RECENT });
		assert.equal(outcome.kind, "stripped");
		if (outcome.kind !== "stripped") return;
		assert.equal(outcome.protocol, EXPECTED_PROTOCOL[api]);
		assert.equal(outcome.removedImages, SCREENSHOTS - KEEP_RECENT);
		assert.equal(outcome.strippedMessages, SCREENSHOTS - KEEP_RECENT);

		const after = JSON.stringify(outcome.payload);
		assert.ok(after.length < REQUEST_BUDGET_CHARS, `stripped request is ${after.length} characters`);
		for (let index = 1; index <= SCREENSHOTS; index++) {
			assert.ok(after.includes(screenshotText(index)), `text of screenshot ${index} must survive`);
			const keptImage = index > SCREENSHOTS - KEEP_RECENT;
			assert.equal(after.includes(screenshotMarker(index)), keptImage, `image ${index} kept=${keptImage}`);
		}
		for (const text of [OPENING_REQUEST, CLOSING_REPLY, FOLLOW_UP_REQUEST]) assert.ok(after.includes(text), text);
		assert.equal(occurrences(after, "omitted from this request"), SCREENSHOTS - KEEP_RECENT);
		assert.match(after, /image\/png, ~29 KB\) omitted from this request/u);
		// The caller's body is not modified: Pi keeps it for retries.
		assert.equal(JSON.stringify(payload), before);
	});

	test(`${api}: a body with no more image-bearing messages than keepRecent is left alone`, async () => {
		const payload = await captureProviderPayload(api, screenshotTranscript(3, 400));
		const outcome = stripHistoricalImages(payload, { keepRecent: 3 });
		assert.deepEqual(outcome, { kind: "unchanged", protocol: EXPECTED_PROTOCOL[api] });
		const all = stripHistoricalImages(payload, { keepRecent: 0 });
		assert.equal(all.kind, "stripped");
		if (all.kind === "stripped") {
			for (const index of [1, 2, 3]) assert.ok(!JSON.stringify(all.payload).includes(screenshotMarker(index)));
		}
	});
}

test("an Anthropic system turn inside messages does not make the body ambiguous", () => {
	const payload = {
		model: "m",
		system: [{ type: "text", text: "sys" }],
		messages: [
			{ role: "user", content: [{ type: "text", text: "a" }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: screenshotData(1, 400) } }] },
			{ role: "system", content: [{ type: "text", text: "mid-conversation system note" }] },
			{ role: "user", content: [{ type: "text", text: "b" }] },
		],
	};
	assert.deepEqual(detectPayloadProtocol(payload), { ok: true, protocol: "anthropic-messages" });
	const outcome = stripHistoricalImages(payload, { keepRecent: 0 });
	assert.equal(outcome.kind, "stripped");
	if (outcome.kind === "stripped") assert.match(JSON.stringify(outcome.payload), /image\/jpeg, ~300 B\) omitted/u);
});

test("a removed Anthropic image hands its cache breakpoint to the placeholder", () => {
	const breakpoint = { type: "ephemeral" };
	const payload = {
		messages: [
			{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: screenshotData(1, 40) }, cache_control: breakpoint }] },
			{ role: "assistant", content: [{ type: "text", text: "seen" }] },
		],
	};
	const outcome = stripHistoricalImages(payload, { keepRecent: 0 });
	assert.equal(outcome.kind, "stripped");
	if (outcome.kind !== "stripped") return;
	const messages = outcome.payload.messages as Array<{ content: Array<Record<string, unknown>> }>;
	assert.deepEqual(messages[0]?.content[0]?.cache_control, breakpoint);
	assert.equal(messages[0]?.content[0]?.type, "text");
	// Untouched messages keep their identity.
	assert.equal(messages[1], payload.messages[1]);
});

test("shapes the stripper cannot read are reported, not silently passed", () => {
	const cases: Array<[string, unknown, RegExp]> = [
		["Google contents", { contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/png", data: "AAAA" } }] }] }, /Google-style contents/u],
		["Bedrock Converse", { messages: [{ role: "user", content: [{ image: { format: "png", source: { bytes: "AAAA" } } }] }] }, /unrecognized/u],
		["not an object", "raw text body", /not a JSON object/u],
		[
			"mixed markers",
			{ messages: [{ role: "tool", tool_call_id: "x", content: "ok" }, { role: "user", content: [{ type: "tool_result", tool_use_id: "y", content: "ok" }] }] },
			/both Anthropic and OpenAI chat/u,
		],
	];
	for (const [name, payload, reason] of cases) {
		const outcome = stripHistoricalImages(payload, { keepRecent: 0 });
		assert.equal(outcome.kind, "unsupported", name);
		if (outcome.kind === "unsupported") assert.match(outcome.reason, reason, name);
	}
});

test("Anthropic tool-change system turns are Anthropic markers, not unknown parts", () => {
	// pi-ai emits these for models with mid-conversation tool changes.
	const payload = {
		messages: [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{ role: "system", content: [{ type: "tool_addition", tool: { type: "tool_definition", definition: {} } }, { type: "tool_removal", tool: { type: "tool_reference", name: "x" } }] },
		],
	};
	assert.deepEqual(detectPayloadProtocol(payload), { ok: true, protocol: "anthropic-messages" });
	assert.deepEqual(stripHistoricalImages(payload, { keepRecent: 0 }), { kind: "unchanged", protocol: "anthropic-messages" });
});

test("a Responses custom tool output is stripped in its output list", () => {
	const image = { type: "input_image", detail: "auto", image_url: `data:image/webp;base64,${screenshotData(2, 80)}` };
	const payload = {
		input: [
			{ type: "custom_tool_call_output", call_id: "c1", output: [{ type: "input_text", text: "grammar tool ran" }, image] },
			{ type: "function_call_output", call_id: "c2", output: "plain string output" },
		],
	};
	const outcome = stripHistoricalImages(payload, { keepRecent: 0 });
	assert.equal(outcome.kind, "stripped");
	if (outcome.kind !== "stripped") return;
	const input = outcome.payload.input as Array<{ output: unknown }>;
	assert.deepEqual(input[0]?.output, [
		{ type: "input_text", text: "grammar tool ran" },
		{ type: "input_text", text: "[image (image/webp, ~60 B) omitted from this request; the session file keeps the original]" },
	]);
	assert.equal(input[1], payload.input[1]);
});

test("an unrecognized part is described in at most 64 printable characters (#166)", () => {
	const prefix = "the request body has an unrecognized content part (";
	const cases: Array<[string, unknown, string]> = [
		["long type", { type: `x-${"a".repeat(500)}` }, "type x-aaa"],
		["long keys", { [`k${"b".repeat(300)}`]: 1, other: 2 }, "keys kbbb"],
		["control characters", { type: "evil\n[forged log line]" }, "type evil?[forged"],
		// "type " plus 57 letters puts the emoji's first half at the cut.
		["pair at the cut", { type: `${"a".repeat(57)}\u{1F600}${"z".repeat(20)}` }, "type aaa"],
	];
	for (const [name, part, start] of cases) {
		const outcome = stripHistoricalImages({ messages: [{ role: "user", content: [part] }] }, { keepRecent: 0 });
		assert.ok(outcome.kind === "unsupported", name);
		assert.ok(outcome.reason.startsWith(prefix) && outcome.reason.endsWith(")"), name);
		const described = outcome.reason.slice(prefix.length, -1);
		assert.ok(described.length <= 64, `${name}: ${described.length} characters`);
		assert.ok(described.startsWith(start), `${name}: ${described}`);
		assert.doesNotMatch(described, /\p{Cc}/u, name);
		// Without the u flag the pattern sees code units, so it finds half a pair.
		assert.doesNotMatch(described, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, `${name}: broken surrogate pair`);
	}
});

test("a text-only messages body has nothing to strip and is not a failure", () => {
	const payload = { messages: [{ role: "user", content: "hello" }, { role: "assistant", content: [{ type: "text", text: "hi" }] }] };
	assert.deepEqual(stripHistoricalImages(payload, { keepRecent: 0 }), { kind: "unchanged", protocol: null });
});
