#!/usr/bin/env node
/**
 * A hostile or careless external strategy for tests/strategy-conformance-hostile.test.ts
 * (pi-context-aware#470). It reads the whole request, then misbehaves in the way the view's model id
 * names. It takes no arguments and reads no environment: the view is its only input.
 */

import { writeSync } from "node:fs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8").split("\n")[0]);
const view = request.view;
const say = (text) => JSON.stringify({ plans: [[{ kind: "say", text }]] });
const answer = (line) => process.stdout.write(`${line}\n`);

switch (view.model.id) {
	case "hang":
		// Answers well-formed plans only after 8 seconds, long past the test's timeout. It does stop, so a
		// bench without the timeout accepts the late reply instead of hanging the test run.
		setTimeout(() => answer(JSON.stringify({ plans: [] })), 8_000);
		break;
	case "flood": {
		// Writes without end; only a kill stops it.
		const chunk = Buffer.alloc(64 * 1024, "x");
		for (;;) writeSync(1, chunk);
	}
	case "huge":
		// One well-formed line whose say text is 200,000 characters.
		answer(say("x".repeat(200_000)));
		break;
	case "extra-top":
		answer(JSON.stringify({ plans: [], note: "an unexpected key" }));
		break;
	case "proto":
		// JSON.parse makes __proto__ an own key; written by hand, since JSON.stringify of a literal would drop it.
		answer("{\"plans\":[[{\"kind\":\"say\",\"text\":\"hello\",\"__proto__\":{\"polluted\":true}}]]}");
		break;
	case "constructor":
		answer(JSON.stringify({ plans: [[{ kind: "stub", entryId: view.entries[0].id, text: "masked", constructor: { prototype: { polluted: true } } }]] }));
		break;
	case "unknown-id":
		answer(JSON.stringify({ plans: [[{ kind: "stub", entryId: "not-in-the-view", text: "masked" }]] }));
		break;
	case "wrong-type":
		answer(JSON.stringify({ plans: [[{ kind: "say", text: 42 }]] }));
		break;
	case "garbage":
		answer("this is not JSON");
		break;
	case "two-lines":
		answer(JSON.stringify({ plans: [] }));
		answer(JSON.stringify({ plans: [] }));
		break;
	case "crash":
		process.stdout.write("{\"plans\":");
		process.exit(3);
		break;
	case "spy":
		// Reports what it can learn about the bench: its environment, working directory and arguments.
		answer(say(JSON.stringify({ env: process.env, cwd: process.cwd(), argv: process.argv.slice(2) })));
		break;
	default:
		answer(JSON.stringify({ plans: [] }));
}
