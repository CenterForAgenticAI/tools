/**
 * The out-of-process strategy adapter against hostile or careless strategies (pi-context-aware#470,
 * REQ-STRAT-005). An external strategy must not be able to hang the bench, exhaust its memory, smuggle
 * fields or prototypes into a plan, name entries the view does not hold, or learn the session path or the
 * bench's environment. Each test supplies the hostile reply through a real process
 * (tests/fixtures/strategies/hostile.mjs) and asserts the refusal code; each goes red when its guard in
 * src/strategy-runtime/bench/external-strategy.ts or external-protocol.ts is removed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ContextView } from "../src/strategy/contract.js";
import { askExternal, parseReply, requestLine, syntheticView, type ExternalCommand, type ExternalLimits } from "../src/strategy-runtime/bench/index.js";

const HOSTILE: ExternalCommand = { label: "hostile", file: process.execPath, args: [path.resolve("tests/fixtures/strategies/hostile.mjs")] };
const LIMITS: ExternalLimits = { timeoutMs: 5_000, maxReplyBytes: 64 * 1024 };

/** A main-session view whose model id tells the hostile strategy what to do. */
const viewFor = (behaviour: string): ContextView => syntheticView({ toolResults: 4, resultTokens: 1_000, pressure: 0.3, modelId: behaviour });

const refusalOf = (behaviour: string, limits: ExternalLimits = LIMITS) => {
	const reply = askExternal(HOSTILE, viewFor(behaviour), limits);
	assert.equal(reply.ok, false, `${behaviour} is refused`);
	return reply.ok ? undefined : reply.code;
};

test("a strategy that does not answer within the per-request timeout is killed and refused as external-timeout", { timeout: 20_000 }, () => {
	const started = Date.now();
	assert.equal(refusalOf("hang", { ...LIMITS, timeoutMs: 1_500 }), "external-timeout");
	assert.ok(Date.now() - started < 6_000, "the bench did not wait for the late answer");
});

test("a strategy that writes without end is killed at the reply cap and refused as external-reply-too-large", { timeout: 20_000 }, () => {
	assert.equal(refusalOf("flood"), "external-reply-too-large");
});

test("a well-formed reply larger than the reply cap is refused as external-reply-too-large, not read whole", { timeout: 20_000 }, () => {
	// 200,000 characters, over the 64 KiB cap and under Node's own 1 MiB default.
	assert.equal(refusalOf("huge"), "external-reply-too-large");
});

test("a huge string under the reply cap is refused as external-field-too-long", () => {
	const reply = parseReply(JSON.stringify({ plans: [[{ kind: "say", text: "x".repeat(200_000) }]] }), viewFor("none"));
	assert.deepEqual(reply.ok ? "accepted" : reply.code, "external-field-too-long");
});

test("extra fields are refused as external-extra-field, at the top and in an operation, and no prototype is polluted", { timeout: 20_000 }, () => {
	assert.equal(refusalOf("extra-top"), "external-extra-field");
	assert.equal(refusalOf("proto"), "external-extra-field");
	assert.equal(refusalOf("constructor"), "external-extra-field");
	assert.equal(({} as Record<string, unknown>).polluted, undefined);
	assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined);
});

test("an entry id the view does not hold is refused as external-unknown-id", { timeout: 20_000 }, () => {
	assert.equal(refusalOf("unknown-id"), "external-unknown-id");
});

test("a field of the wrong type is refused as external-bad-field", { timeout: 20_000 }, () => {
	assert.equal(refusalOf("wrong-type"), "external-bad-field");
});

test("a reply that is not one JSON line is refused as external-malformed, and a crash as external-crash", { timeout: 20_000 }, () => {
	assert.equal(refusalOf("garbage"), "external-malformed");
	assert.equal(refusalOf("two-lines"), "external-malformed");
	assert.equal(refusalOf("crash"), "external-crash");
});

test("a strategy that answers and exits 0 without reading the whole request is accepted; one that exits non-zero is still refused as external-crash", { timeout: 20_000 }, () => {
	// 3,000 results: the request is far larger than a pipe buffer, so writing it fails with EPIPE once the program has exited.
	const big = syntheticView({ toolResults: 3_000, resultTokens: 1_000, pressure: 0.3 });
	assert.ok(requestLine(big).length > 256 * 1024, "the request outgrows any pipe buffer");
	const answered = askExternal({ label: "echo", file: "/bin/echo", args: ['{"plans":[]}'] }, big, LIMITS);
	assert.deepEqual(answered, { ok: true, plans: [] });
	const failed = askExternal({ label: "fails", file: "/bin/sh", args: ["-c", 'echo \'{"plans":[]}\'; exit 3'] }, big, LIMITS);
	assert.deepEqual(failed.ok ? "accepted" : failed.code, "external-crash");
});

test("a strategy that cannot be started is refused as external-spawn-failed", () => {
	const reply = askExternal({ label: "missing", file: path.join(os.tmpdir(), "no-such-strategy") }, viewFor("none"), LIMITS);
	assert.deepEqual(reply.ok ? "accepted" : reply.code, "external-spawn-failed");
});

test("the strategy learns neither the bench's environment nor its working directory: it runs with a fixed PATH only, in a fresh empty directory removed afterwards", { timeout: 20_000 }, () => {
	const secret = "pi-strategy-secret-6f1d";
	const hostPath = process.env.PATH;
	process.env.PI_STRATEGY_TEST_SECRET = secret;
	process.env.PATH = `${hostPath ?? ""}${path.delimiter}/${secret}/bin`;
	try {
		const seen = [1, 2].map(() => {
			const reply = askExternal(HOSTILE, viewFor("spy"), LIMITS);
			assert.ok(reply.ok, "the spy's reply is well formed");
			const op = reply.plans[0]![0]!;
			assert.equal(op.kind, "say");
			return JSON.parse(op.kind === "say" ? op.text : "{}") as { env: Record<string, string>; cwd: string; argv: string[] };
		});
		for (const { env, cwd, argv } of seen) {
			assert.equal(JSON.stringify(env).includes(secret), false, "no variable of the bench's environment reaches the strategy");
			assert.equal(env.HOME, undefined);
			// The bench passes PATH alone. Two names arrive anyway: macOS adds __CF_USER_TEXT_ENCODING to every
			// process it starts, and Node copies NODE_V8_COVERAGE into every child's environment while the bench
			// itself runs under coverage, as this suite does under c8.
			assert.deepEqual(Object.keys(env).filter((name) => name !== "__CF_USER_TEXT_ENCODING" && name !== "NODE_V8_COVERAGE"), ["PATH"]);
			assert.equal(env.PATH, [path.dirname(process.execPath), "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"].filter((dir, i, all) => all.indexOf(dir) === i).join(path.delimiter), "a PATH the bench builds, not its own");
			assert.deepEqual(argv, [], "the command line carries no session path");
			assert.notEqual(cwd, process.cwd());
			assert.ok(cwd.startsWith(fs.realpathSync(os.tmpdir())), `${cwd} is a temporary directory`);
			assert.equal(fs.existsSync(cwd), false, "the directory is removed after the request");
		}
		assert.notEqual(seen[0]!.cwd, seen[1]!.cwd, "each request gets a fresh directory");
	} finally {
		delete process.env.PI_STRATEGY_TEST_SECRET;
		process.env.PATH = hostPath;
	}
});

test("the request is one line holding only the protocol version and the view's named fields", () => {
	const view = viewFor("none");
	const line = requestLine(view);
	assert.equal(line.endsWith("\n"), true);
	assert.equal(line.indexOf("\n"), line.length - 1);
	const request = JSON.parse(line) as { protocol: number; view: Record<string, unknown> };
	assert.deepEqual(Object.keys(request), ["protocol", "view"]);
	assert.equal(request.protocol, 1);
	assert.deepEqual(Object.keys(request.view).sort(), ["cacheAgeMs", "compactionOwner", "entries", "folds", "hides", "model", "pressure", "protectedEntryIds", "registeredTools", "tools", "unownedTokens"]);
});

test("an accepted reply becomes fresh plans holding only the named fields", () => {
	const view = viewFor("none");
	const reply = parseReply(JSON.stringify({ plans: [[{ kind: "stub", entryId: "t1", text: "masked" }, { kind: "summarize", startId: "t2", endId: "t3", writer: "plan", summary: "s".repeat(80), topic: "reads" }], [{ kind: "say", text: "Use context_recall to read a masked result." }]] }), view);
	assert.deepEqual(reply, {
		ok: true,
		plans: [
			[{ kind: "stub", entryId: "t1", text: "masked" }, { kind: "summarize", startId: "t2", endId: "t3", topic: "reads", writer: "plan", summary: "s".repeat(80) }],
			[{ kind: "say", text: "Use context_recall to read a masked result." }],
		],
	});
});
