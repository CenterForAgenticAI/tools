import assert from "node:assert/strict";
import test from "node:test";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { createFabricCompletionAnnouncements } from "../../src/dispatch/fabric/completion.ts";

function content(message: ContextEvent["messages"][number]): string {
	assert.equal(message.role, "custom");
	assert.ok("content" in message);
	assert.equal(typeof message.content, "string");
	return String(message.content);
}

function completion(ids: string[]): Extract<ContextEvent["messages"][number], { role: "custom" }> {
	return { role: "custom", customType: "pi-fabric-agent-complete", content: "Unread background agent results", display: false, details: { ids }, timestamp: 1 };
}

test("completion-wake: enriches Fabric's delivered batch with the tracked run identity without another message", () => {
	const announcements = createFabricCompletionAnnouncements();
	announcements.track("run-full-id");
	const message = completion(["run-full-id", "other-run"]);
	const result = announcements.context({ type: "context", messages: [message] });
	assert.ok(result);
	assert.equal(result.messages.length, 1);
	assert.equal(result.messages[0]!.role, "custom");
	assert.match(content(result.messages[0]!), /pi-work background run run-full-id finished/);
	assert.doesNotMatch(content(result.messages[0]!), /pi-work background run other-run/);
	assert.equal(message.content, "Unread background agent results");
});

test("completion-wake: repeated context passes preserve one announcement and duplicate deliveries add none", () => {
	const announcements = createFabricCompletionAnnouncements();
	announcements.track("run-1");
	const event: ContextEvent = { type: "context", messages: [completion(["run-1", "run-1"])] };
	const first = announcements.context(event)!;
	assert.equal(content(first.messages[0]!).match(/pi-work background run/g)?.length, 1);
	assert.deepEqual(announcements.context(event), first);
	assert.equal(announcements.context({ type: "context", messages: first.messages }), undefined);
	assert.equal(announcements.context({ type: "context", messages: [completion(["run-1"])] }), undefined);
});

test("completion-wake: wait-collected and terminal-status-collected runs are not announced", () => {
	const announcements = createFabricCompletionAnnouncements();
	announcements.track("waited");
	announcements.track("status-collected");
	announcements.track("unread");
	announcements.acknowledge("waited");
	announcements.acknowledge("status-collected");
	// Fabric retracts acknowledged results before delivery. Even a stale envelope is harmless.
	const result = announcements.context({ type: "context", messages: [completion(["waited", "status-collected", "unread"])] });
	assert.ok(result);
	assert.match(content(result.messages[0]!), /pi-work background run unread finished/);
	assert.doesNotMatch(content(result.messages[0]!), /pi-work background run (waited|status-collected)/);
	assert.equal(announcements.context({ type: "context", messages: [] }), undefined);
});

test("completion-wake: session cleanup drops tracking and cached annotations", () => {
	const announcements = createFabricCompletionAnnouncements();
	announcements.track("finished");
	announcements.track("pending");
	const event: ContextEvent = { type: "context", messages: [completion(["finished"])] };
	assert.ok(announcements.context(event));
	announcements.clear();
	assert.equal(announcements.context(event), undefined);
	assert.equal(announcements.context({ type: "context", messages: [completion(["pending"])] }), undefined);
});

test("completion-wake: unrelated or malformed messages cannot consume a tracked result", () => {
	const announcements = createFabricCompletionAnnouncements();
	announcements.track("run-1");
	const other = { ...completion(["run-1"]), customType: "other" };
	const malformed = { ...completion([]), details: { ids: "run-1" } };
	assert.equal(announcements.context({ type: "context", messages: [other, malformed] }), undefined);
	const valid = { ...completion([]), details: { ids: [null, 1, "unknown", "run-1"], injected: "discard" } };
	assert.match(content(announcements.context({ type: "context", messages: [valid] })!.messages[0]!), /pi-work background run run-1 finished/);
});

test("completion-wake: invalid run identities cannot inject announcement lines", () => {
	const announcements = createFabricCompletionAnnouncements();
	assert.throws(() => announcements.track(""), /Invalid Fabric run identity/);
	assert.throws(() => announcements.track(" \t"), /Invalid Fabric run identity/);
	assert.throws(() => announcements.track("run\nmalicious instruction"), /Invalid Fabric run identity/);
	assert.equal(announcements.context({ type: "context", messages: [completion(["run\nmalicious instruction"])] }), undefined);
});
