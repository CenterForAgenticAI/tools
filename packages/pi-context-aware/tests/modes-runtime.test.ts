import assert from "node:assert/strict";
import test from "node:test";
import {
	MODE_MESSAGE_TYPE,
	MODE_STATE_ENTRY_TYPE,
	createContextAwareModesV1,
} from "../src/modes/modes-runtime.js";
import {
	supportsContextAwareModeInstanceIdsV1,
	supportsContextAwareModeToolPoliciesV1,
	type ContextAwareModeDefinitionV1,
	type ContextAwareModeSnapshotV1,
	type ContextAwareModesV1,
	type ContextAwareServiceV1,
} from "../src/context-service.js";

interface Message {
	customType: string;
	content: string;
	details: unknown;
}

function harness(entries: unknown[] = []) {
	const messages: Message[] = [];
	const appendCalls: unknown[] = [];
	let confirmer: ((request: { mode: string; action: "enter" | "exit"; reason?: string }) => Promise<boolean | undefined>) | undefined;
	const runtime = createContextAwareModesV1({
		appendEntry: (customType, data) => {
			appendCalls.push({ customType, data });
			entries.push({ type: "custom", customType, data });
		},
		sendMessage: (customType, content, details) => messages.push({ customType, content, details }),
		entries: () => entries,
		interactiveConfirm: (request) => confirmer?.(request) ?? Promise.resolve(undefined),
	});
	return {
		runtime,
		entries,
		messages,
		appendCalls,
		setConfirmer: (next: typeof confirmer) => { confirmer = next; },
	};
}

function definition(id: string, owner: string, extra: Partial<ContextAwareModeDefinitionV1> = {}): ContextAwareModeDefinitionV1 {
	return {
		id,
		owner,
		transition: `${id} is active.`,
		blockedTools: [],
		...extra,
	};
}

function stateEntries(entries: readonly unknown[]): unknown[] {
	return entries.filter((entry) => (entry as { customType?: unknown }).customType === MODE_STATE_ENTRY_TYPE);
}

test("handles authorize transitions by identity and copy named fields", async () => {
	const h = harness();
	const caller = definition("review", "extension-a", { blockedTools: ["bash"] });
	Object.defineProperty(caller, "secret", { enumerable: true, get: () => { throw new Error("secret getter was read"); } });
	const defined = h.runtime.defineMode(caller);
	assert.equal(defined.status, "ok");
	if (defined.status !== "ok") return;
	const other = h.runtime.defineMode(definition("other", "extension-b"));
	assert.equal(other.status, "ok");
	if (other.status !== "ok") return;
	const copied = { ...defined.handle };
	assert.equal((await copied.enter()).status, "refused");
	assert.deepEqual(await defined.handle.enter(), { status: "ok" });
	assert.equal(copied.exit().status, "refused");
	assert.deepEqual(h.runtime.handleToolCall("bash", { command: "ls" }), {
		block: true,
		reason: "Tool bash is blocked by mode review.",
	});
	assert.equal(other.handle.exit().status, "refused");
	assert.equal(defined.handle.commandAllowed("mode-command"), true);
	assert.equal(JSON.stringify(h.entries).includes("secret"), false);
	assert.equal(JSON.stringify(h.messages).includes("secret"), false);
});

test("emits one non-triggering transition message for each accepted transition and stores no caller extras", async () => {
	const h = harness();
	const outer = h.runtime.defineMode(definition("outer", "a", { transition: "Outer transition." }));
	const inner = h.runtime.defineMode(definition("inner", "b", { transition: "Inner transition.", blockedTools: ["write"] }));
	assert.equal(outer.status, "ok");
	assert.equal(inner.status, "ok");
	if (outer.status !== "ok" || inner.status !== "ok") return;
	assert.deepEqual(await outer.handle.enter(), { status: "ok" });
	assert.deepEqual(await inner.handle.enter(), { status: "ok" });
	assert.deepEqual(inner.handle.exit(), { status: "ok" });
	assert.deepEqual(outer.handle.exit(), { status: "ok" });
	assert.equal(h.messages.length, 4);
	assert.ok(h.messages.every((message) => message.customType === MODE_MESSAGE_TYPE));
	assert.deepEqual(h.messages.map((message) => [message.content, (message.details as { action: string }).action]), [
		["Outer transition.", "enter"],
		["Inner transition.", "enter"],
		["Outer transition.", "exit"],
		["Exited mode outer.", "exit"],
	]);
	const last = stateEntries(h.entries).at(-1) as { data: { updatedAt: string; transitionId: string } };
	assert.deepEqual(last, {
		type: "custom",
		customType: MODE_STATE_ENTRY_TYPE,
		data: {
			schemaVersion: 1,
			current: null,
			outer: null,
			updatedAt: last.data.updatedAt,
			transitionId: last.data.transitionId,
		},
	});
	const transitionIds = stateEntries(h.entries).map((entry) => (entry as { data: { transitionId: string } }).data.transitionId);
	assert.deepEqual(h.messages.map((message) => (message.details as { transitionId: string }).transitionId), transitionIds, "each message carries its state entry's transitionId");
	assert.equal(new Set(transitionIds).size, 4);
});

test("inner rules replace outer rules and a third mode is refused without a side effect", async () => {
	const h = harness();
	const outer = h.runtime.defineMode(definition("outer", "a", { blockedTools: ["bash"] }));
	const inner = h.runtime.defineMode(definition("inner", "b", { blockedTools: ["write"] }));
	const third = h.runtime.defineMode(definition("third", "c"));
	assert.equal(outer.status, "ok");
	assert.equal(inner.status, "ok");
	assert.equal(third.status, "ok");
	if (outer.status !== "ok" || inner.status !== "ok" || third.status !== "ok") return;
	await outer.handle.enter();
	await inner.handle.enter();
	assert.equal(h.runtime.handleToolCall("bash", {}), undefined);
	assert.ok(h.runtime.handleToolCall("write", {}));
	const beforeMessages = h.messages.length;
	const thirdResult = await third.handle.enter();
	assert.deepEqual(thirdResult, {
		status: "refused",
		code: "NESTING_LIMIT",
		message: "Only one nested mode is supported.",
	});
	assert.equal(h.messages.length, beforeMessages);
	assert.deepEqual(inner.handle.exit(), { status: "ok" });
	assert.ok(h.runtime.handleToolCall("bash", {}));
});

test("guard blocks, including thrown guards, on the same path used by nested Fabric preflight", async () => {
	const h = harness();
	const mode = h.runtime.defineMode(definition("guarded", "owner", {
		guard: (toolName, input) => {
			if (toolName === "edit" && input.path === "secret") return { block: true, reason: "protected path" };
			if (toolName === "bash") throw new Error("private guard detail");
			return undefined;
		},
	}));
	assert.equal(mode.status, "ok");
	if (mode.status !== "ok") return;
	await mode.handle.enter();
	const foreground = h.runtime.handleToolCall("edit", { path: "secret" });
	const fabricPreflight = h.runtime.handleToolCall("edit", { path: "secret" });
	assert.deepEqual(foreground, fabricPreflight);
	assert.deepEqual(h.runtime.handleToolCall("bash", {}), { block: true, reason: "Tool bash is blocked by mode guarded." });
	assert.equal(JSON.stringify(h.messages).includes("private guard detail"), false);
});

test("resend emits the active transition once after compaction without changing the snapshot", async () => {
	const h = harness();
	const mode = h.runtime.defineMode(definition("review", "owner", { transition: "Review transition." }));
	assert.equal(mode.status, "ok");
	if (mode.status !== "ok") return;
	await mode.handle.enter();
	const before = h.runtime.current();
	const beforeMessages = h.messages.length;
	h.runtime.resend();
	assert.equal(h.messages.length, beforeMessages + 1);
	assert.equal(h.messages.at(-1)?.content, "Review transition.");
	assert.deepEqual(h.runtime.current(), before);
});

test("resume creates an orphan, redefinition re-arms it without a transition, and user exit clears it", async () => {
	const first = harness();
	const mode = first.runtime.defineMode(definition("review", "owner", { transition: "Review transition." }));
	assert.equal(mode.status, "ok");
	if (mode.status !== "ok") return;
	await mode.handle.enter();
	const resumed = harness(first.entries);
	assert.equal(resumed.runtime.current()?.available, false);
	assert.equal(resumed.runtime.handleToolCall("bash", {}), undefined);
	const rebound = resumed.runtime.defineMode(definition("review", "owner", { transition: "New process transition." }));
	assert.equal(rebound.status, "ok");
	assert.equal(resumed.runtime.current()?.available, true);
	assert.equal(resumed.messages.length, 0);
	assert.deepEqual(resumed.runtime.userExit(), { status: "ok" });
	assert.equal(resumed.runtime.current(), null);
	assert.equal(resumed.messages.at(-1)?.content, "Exited mode review.");
});

test("a final user exit emits the exit notice, not the entry transition", async () => {
	const h = harness();
	const mode = h.runtime.defineMode(definition("review", "owner", { transition: "Review transition." }));
	assert.equal(mode.status, "ok");
	if (mode.status !== "ok") return;
	await mode.handle.enter();
	assert.deepEqual(h.runtime.userExit(), { status: "ok" });
	assert.equal(h.messages.at(-1)?.content, "Exited mode review.");
	assert.equal((h.messages.at(-1)?.details as { action: string }).action, "exit");
});

test("an orphan user exit emits the exit notice, not the recovered entry transition", async () => {
	const first = harness();
	const mode = first.runtime.defineMode(definition("review", "owner", { transition: "Review transition." }));
	assert.equal(mode.status, "ok");
	if (mode.status !== "ok") return;
	await mode.handle.enter();
	const resumed = harness(first.entries.concat(first.messages.map((message) => ({ type: "custom_message", ...message }))));
	assert.equal(resumed.runtime.current()?.available, false);
	resumed.runtime.resend();
	assert.equal(resumed.messages.at(-1)?.content, "Review transition.");
	assert.deepEqual(resumed.runtime.userExit(), { status: "ok" });
	assert.equal(resumed.runtime.current(), null);
	assert.equal(resumed.messages.at(-1)?.content, "Exited mode review.");
	assert.equal((resumed.messages.at(-1)?.details as { action: string }).action, "exit");
});

test("a nested exit to an unavailable outer mode does not resend the inner transition", async () => {
	const first = harness();
	const outer = first.runtime.defineMode(definition("outer", "a", { transition: "Outer transition." }));
	const inner = first.runtime.defineMode(definition("inner", "b", { transition: "Inner transition." }));
	assert.equal(outer.status, "ok");
	assert.equal(inner.status, "ok");
	if (outer.status !== "ok" || inner.status !== "ok") return;
	await outer.handle.enter();
	await inner.handle.enter();
	const resumed = harness(first.entries.concat(first.messages.map((message) => ({ type: "custom_message", ...message }))));
	assert.deepEqual(resumed.runtime.userExit(), { status: "ok" });
	assert.equal(resumed.runtime.current()?.id, "outer");
	assert.equal(resumed.runtime.current()?.available, false);
	assert.equal(resumed.messages.at(-1)?.content, "Exited mode inner.");
	const beforeResend = resumed.messages.length;
	resumed.runtime.resend();
	assert.equal(resumed.messages.length, beforeResend);
});

/** A session that keeps state entries and transition messages in the order Pi appends them when idle. */
function orderedHarness() {
	const entries: unknown[] = [];
	let next = 0;
	const runtime = createContextAwareModesV1({
		appendEntry: (customType, data) => { entries.push({ type: "custom", id: `e${next++}`, customType, data }); },
		sendMessage: (customType, content, details) => { entries.push({ type: "custom_message", id: `e${next++}`, customType, content, details }); },
		entries: () => entries,
	});
	return { runtime, entries };
}

function refusedEnter(current: ContextAwareModeSnapshotV1 | Record<string, unknown>, content: string): unknown[] {
	const { id, owner } = current as { id: string; owner: string };
	return [
		{ type: "custom", id: "refused", customType: MODE_STATE_ENTRY_TYPE, data: { schemaVersion: 1, current, outer: null, updatedAt: "2026-10-09T00:00:00.000Z" } },
		{ type: "custom_message", id: "refused-message", customType: MODE_MESSAGE_TYPE, content, details: { id, owner, action: "enter" } },
	];
}

test("replay keeps the nested-exit text and never resends the message of a refused state entry", async () => {
	const live = orderedHarness();
	const outer = live.runtime.defineMode(definition("outer", "a", { transition: "Outer transition." }));
	const inner = live.runtime.defineMode(definition("inner", "b", { transition: "Inner transition." }));
	assert.equal(outer.status, "ok");
	assert.equal(inner.status, "ok");
	if (outer.status !== "ok" || inner.status !== "ok") return;
	await outer.handle.enter();
	await inner.handle.enter();
	assert.deepEqual(inner.handle.exit(), { status: "ok" });
	const restored = live.runtime.current();
	assert.equal(restored?.id, "outer");
	if (restored === null) return;
	const clean = harness([...live.entries]);
	clean.runtime.resend();
	assert.equal(clean.messages.at(-1)?.content, "Outer transition.", "the nested exit message restores the outer text");
	const wrongMode = { id: "wrong", owner: "c", instanceId: restored.instanceId, enteredAt: restored.enteredAt };
	const poisoned = harness([...live.entries, ...refusedEnter(wrongMode, "REFUSED WRONG MODE")]);
	assert.equal(poisoned.runtime.current()?.id, "outer");
	poisoned.runtime.resend();
	assert.equal(poisoned.messages.at(-1)?.content, "Outer transition.", "a refused entry's message must not stand in for the accepted text");
	const sameMode = { id: "outer", owner: "a", instanceId: restored.instanceId, enteredAt: new Date(Date.parse(restored.enteredAt) + 1000).toISOString() };
	const reentered = harness([...live.entries, ...refusedEnter(sameMode, "REFUSED SECOND ENTER")]);
	assert.equal(reentered.runtime.current()?.enteredAt, restored.enteredAt);
	reentered.runtime.resend();
	assert.equal(reentered.messages.at(-1)?.content, "Outer transition.", "a refused enter of the same mode must not match the accepted mode");
});

test("replay finds the accepted mode's text when Pi defers both messages to the end of the turn", async () => {
	const first = harness();
	const outer = first.runtime.defineMode(definition("outer", "a", { transition: "Outer transition." }));
	const inner = first.runtime.defineMode(definition("inner", "b", { transition: "Inner transition." }));
	assert.equal(outer.status, "ok");
	assert.equal(inner.status, "ok");
	if (outer.status !== "ok" || inner.status !== "ok") return;
	await outer.handle.enter();
	await inner.handle.enter();
	const deferred = [...first.entries, ...first.messages.map((message, index) => ({ type: "custom_message", id: `m${index}`, ...message }))];
	const resumed = harness(deferred);
	resumed.runtime.resend();
	assert.equal(resumed.messages.at(-1)?.content, "Inner transition.");
});

test("replay finds the accepted text when Pi delivers it after a later refused or malformed state entry", async () => {
	for (const kind of ["malformed", "refused"] as const) {
		const first = harness();
		const outer = first.runtime.defineMode(definition("outer", "a", { transition: "Outer transition." }));
		const inner = first.runtime.defineMode(definition("inner", "b", { transition: "Inner transition." }));
		assert.equal(outer.status, "ok");
		assert.equal(inner.status, "ok");
		if (outer.status !== "ok" || inner.status !== "ok") return;
		await outer.handle.enter();
		await inner.handle.enter();
		assert.deepEqual(inner.handle.exit(), { status: "ok" });
		const accepted = first.runtime.current();
		if (accepted === null) return assert.fail("outer is active");
		const bad = kind === "malformed"
			? { ...accepted, instanceId: 7 }
			: { id: accepted.id, owner: accepted.owner, instanceId: accepted.instanceId, enteredAt: new Date(Date.parse(accepted.enteredAt) + 1000).toISOString() };
		// Pi held all three messages until the end of the turn, after the bad entry.
		const branch = [
			...first.entries,
			{ type: "custom", customType: MODE_STATE_ENTRY_TYPE, data: { schemaVersion: 1, current: bad, outer: null, updatedAt: "2026-10-09T00:00:00.000Z" } },
			...first.messages.map((message, index) => ({ type: "custom_message", id: `m${index}`, ...message })),
		];
		const resumed = harness(branch);
		assert.equal(resumed.runtime.current()?.instanceId, accepted.instanceId, kind);
		resumed.runtime.resend();
		assert.equal(resumed.messages.at(-1)?.content, "Outer transition.", kind);
	}
});

test("a repeated copy of the accepted state entry keeps the text of the original message", async () => {
	const live = orderedHarness();
	const mode = live.runtime.defineMode(definition("review", "owner", { transition: "Review transition." }));
	assert.equal(mode.status, "ok");
	if (mode.status !== "ok") return;
	await mode.handle.enter();
	const original = stateEntries(live.entries)[0] as { data: unknown };
	const sent = live.entries.find((entry) => (entry as { customType?: unknown }).customType === MODE_MESSAGE_TYPE) as { details: unknown };
	const resumed = harness([
		...live.entries,
		{ type: "custom", id: "copy", customType: MODE_STATE_ENTRY_TYPE, data: original.data },
		{ type: "custom_message", id: "copied-message", customType: MODE_MESSAGE_TYPE, content: "COPIED TEXT", details: sent.details },
	]);
	assert.equal(resumed.runtime.current()?.id, "review");
	resumed.runtime.resend();
	assert.equal(resumed.messages.at(-1)?.content, "Review transition.");
});

test("an entry written before transitionId still recovers its text from messages before the next state entry", () => {
	const review = { id: "review", owner: "owner", instanceId: "review-1", enteredAt: "2026-10-01T00:00:00.000Z" };
	const legacyMessage = (id: string, content: string, extra: Record<string, unknown> = {}) => ({ type: "custom_message", id, customType: MODE_MESSAGE_TYPE, content, details: { id: "review", owner: "owner", action: "enter", ...extra } });
	const resumed = harness([
		{ type: "custom", id: "accepted", customType: MODE_STATE_ENTRY_TYPE, data: { schemaVersion: 1, current: review, outer: null, updatedAt: "2026-10-01T00:00:00.000Z" } },
		// A message with a transitionId belongs to a newer entry, even for the same mode.
		legacyMessage("tokened", "TOKENED TEXT", { transitionId: "belongs-to-a-newer-entry" }),
		legacyMessage("accepted-message", "Legacy transition."),
		{ type: "custom", id: "malformed", customType: MODE_STATE_ENTRY_TYPE, data: null },
		legacyMessage("malformed-message", "MALFORMED TEXT"),
	]);
	assert.equal(resumed.runtime.current()?.instanceId, "review-1");
	resumed.runtime.resend();
	assert.equal(resumed.messages.at(-1)?.content, "Legacy transition.");
});

test("model suggestions require explicit confirmation and preserve the enter reason", async () => {
	const h = harness();
	const mode = h.runtime.defineMode(definition("review", "owner"));
	assert.equal(mode.status, "ok");
	if (mode.status !== "ok") return;
	const beforeEntries = JSON.stringify(h.entries);
	const beforeMessages = JSON.stringify(h.messages);
	assert.deepEqual(await mode.handle.enter({ suggestedBy: "model" }), {
		status: "refused",
		code: "CONFIRMATION_REQUIRED",
		message: "Model suggestions require confirm: true.",
	});
	assert.deepEqual(await mode.handle.enter({ suggestedBy: "model", confirm: true }), {
		status: "refused",
		code: "CONFIRMATION_REQUIRED",
		message: "Mode suggestion requires confirmation.",
	});
	assert.equal(JSON.stringify(h.entries), beforeEntries);
	assert.equal(JSON.stringify(h.messages), beforeMessages);
	let calls = 0;
	let confirmedReason: string | undefined;
	h.setConfirmer(async (request) => {
		calls += 1;
		confirmedReason = request.reason;
		return true;
	});
	h.runtime.setSuggestionConfirmer(async () => true);
	assert.equal((await mode.handle.enter({ suggestedBy: "model" })).status, "refused");
	assert.equal(h.runtime.current(), null);
	assert.deepEqual(await h.runtime.enterSuggested("review", "approved by the model"), { status: "ok" });
	assert.equal(calls, 1);
	assert.equal(confirmedReason, "approved by the model");
	assert.equal(h.runtime.current()?.suggestedBy, "model");
});

test("commandAllowed is advisory and fails closed for errors or a non-effective handle", async () => {
	const h = harness();
	const mode = h.runtime.defineMode(definition("review", "owner", {
		commandAllowed: (name) => {
			if (name === "explode") throw new Error("private");
			return name === "allowed";
		},
	}));
	assert.equal(mode.status, "ok");
	if (mode.status !== "ok") return;
	assert.equal(mode.handle.commandAllowed("allowed"), false);
	await mode.handle.enter();
	assert.equal(mode.handle.commandAllowed("allowed"), true);
	assert.equal(mode.handle.commandAllowed("explode"), false);
});

test("an exit and re-enter within one millisecond gets a new instanceId", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-08T12:00:00.000Z") });
	const h = harness();
	const mode = h.runtime.defineMode(definition("review", "owner"));
	assert.equal(mode.status, "ok");
	if (mode.status !== "ok") return;
	await mode.handle.enter();
	const first = h.runtime.current();
	assert.deepEqual(mode.handle.exit(), { status: "ok" });
	await mode.handle.enter();
	const second = h.runtime.current();
	assert.ok(first && second);
	assert.equal(first.enteredAt, second.enteredAt, "the clock did not move");
	assert.match(first.instanceId ?? "", /^[0-9a-f-]{36}$/);
	assert.match(second.instanceId ?? "", /^[0-9a-f-]{36}$/);
	assert.notEqual(first.instanceId, second.instanceId);
	const persisted = stateEntries(h.entries).map((entry) => (entry as { data: { current: { instanceId?: string } | null } }).data.current?.instanceId ?? null);
	assert.deepEqual(persisted, [first.instanceId, null, second.instanceId]);
});

test("a nested mode keeps the outer instanceId, and exit restores it", async () => {
	const h = harness();
	const outer = h.runtime.defineMode(definition("outer", "a"));
	const inner = h.runtime.defineMode(definition("inner", "b"));
	assert.equal(outer.status, "ok");
	assert.equal(inner.status, "ok");
	if (outer.status !== "ok" || inner.status !== "ok") return;
	await outer.handle.enter();
	const outerId = h.runtime.current()?.instanceId;
	assert.match(outerId ?? "", /^[0-9a-f-]{36}$/, "the outer mode must have an id before nesting");
	await inner.handle.enter();
	const nested = h.runtime.current();
	assert.equal(nested?.outer?.instanceId, outerId);
	assert.notEqual(nested?.instanceId, outerId);
	assert.deepEqual(inner.handle.exit(), { status: "ok" });
	assert.equal(h.runtime.current()?.instanceId, outerId);
});

test("replay keeps a persisted instanceId", async () => {
	const first = harness();
	const mode = first.runtime.defineMode(definition("review", "owner"));
	assert.equal(mode.status, "ok");
	if (mode.status !== "ok") return;
	await mode.handle.enter();
	const entered = first.runtime.current()?.instanceId;
	assert.ok(entered);
	const resumed = harness([...first.entries]);
	assert.equal(resumed.runtime.current()?.instanceId, entered);
	assert.equal(resumed.runtime.current()?.available, false);
});

function legacyEntry(id: string, current: unknown, outer: unknown = null): unknown {
	return { type: "custom", id, customType: MODE_STATE_ENTRY_TYPE, data: { schemaVersion: 1, current, outer, updatedAt: "2026-10-01T00:00:00.000Z" } };
}

const legacyReview = { id: "review", owner: "owner", enteredAt: "2026-10-01T00:00:00.000Z" };

test("an entry written without instanceId gets the same derived id on every replay", () => {
	const entries = [legacyEntry("entry-a", legacyReview)];
	const first = harness([...entries]).runtime.current()?.instanceId;
	const second = harness([...entries]).runtime.current()?.instanceId;
	assert.match(first ?? "", /^legacy-[0-9a-f]{32}$/);
	assert.equal(first, second);
	const otherEntry = harness([legacyEntry("entry-b", legacyReview)]).runtime.current()?.instanceId;
	assert.notEqual(otherEntry, first, "the id comes from the session entry, not only the mode fields");
});

test("a legacy enter keeps its derived id while later entries copy it, and a later enter gets a new one", () => {
	const nested = { id: "inner", owner: "b", enteredAt: "2026-10-01T00:00:01.000Z" };
	const sameEnter = harness([
		legacyEntry("entry-a", legacyReview),
		{ type: "message", id: "unrelated" },
		legacyEntry("entry-b", nested, legacyReview),
		legacyEntry("entry-c", legacyReview),
	]);
	const alone = harness([legacyEntry("entry-a", legacyReview)]).runtime.current()?.instanceId;
	assert.equal(sameEnter.runtime.current()?.instanceId, alone, "the run of copies is one enter");
	const reentered = harness([
		legacyEntry("entry-a", legacyReview),
		legacyEntry("entry-b", null),
		legacyEntry("entry-c", legacyReview),
	]);
	assert.notEqual(reentered.runtime.current()?.instanceId, alone, "an exit between them makes a new enter, even at the same millisecond");
	const persisted = harness([legacyEntry("entry-a", legacyReview)]);
	const derived = persisted.runtime.current()?.instanceId;
	assert.deepEqual(persisted.runtime.userExit(), { status: "ok" });
	const outerKept = harness([legacyEntry("entry-a", legacyReview), legacyEntry("entry-b", nested, legacyReview)]);
	const outerId = outerKept.runtime.current()?.outer?.instanceId;
	assert.deepEqual(outerKept.runtime.userExit(), { status: "ok" });
	const written = stateEntries(outerKept.entries).at(-1) as { data: { current: { instanceId?: string } } };
	assert.equal(written.data.current.instanceId, outerId, "a transition persists the derived id");
	assert.equal(outerId, derived);
});

test("replay refuses an entry that reuses an ended instanceId or gives one id to two enters", () => {
	const review = { ...legacyReview, instanceId: "id-1" };
	const other = { id: "other", owner: "b", enteredAt: "2026-10-01T00:00:02.000Z" };
	const reused = harness([legacyEntry("entry-a", review), legacyEntry("entry-b", null), legacyEntry("entry-c", review)]);
	assert.equal(reused.runtime.current(), null, "an id that ended on the branch cannot start a second enter");
	const reusedLater = harness([legacyEntry("entry-a", review), legacyEntry("entry-b", null), legacyEntry("entry-c", { ...review, enteredAt: "2026-10-01T00:00:05.000Z" })]);
	assert.equal(reusedLater.runtime.current(), null, "a later enteredAt does not make a reused id a new enter");
	const replaced = harness([legacyEntry("entry-a", review), legacyEntry("entry-b", { ...other, instanceId: "id-1" })]);
	assert.equal(replaced.runtime.current()?.id, "review", "an id active for one enter cannot name another");
	const shared = harness([legacyEntry("entry-a", review), legacyEntry("entry-b", { ...other, instanceId: "id-1" }, review)]);
	assert.equal(shared.runtime.current()?.id, "review", "current and outer cannot share an id");
	assert.equal(shared.runtime.current()?.outer, undefined);
	const sharedFirst = harness([legacyEntry("entry-a", { ...other, instanceId: "id-1" }, review)]);
	assert.equal(sharedFirst.runtime.current(), null);
	const copies = harness([legacyEntry("entry-a", review), legacyEntry("entry-b", { ...other, instanceId: "id-2" }, review), legacyEntry("entry-c", review)]);
	assert.equal(copies.runtime.current()?.instanceId, "id-1", "copies of one active enter keep its id");
});

test("a legacy enter in an entry with no session entry id is refused", () => {
	const anonymous = { type: "custom", customType: MODE_STATE_ENTRY_TYPE, data: { schemaVersion: 1, current: legacyReview, outer: null, updatedAt: "2026-10-01T00:00:00.000Z" } };
	assert.equal(harness([anonymous]).runtime.current(), null);
	const kept = harness([legacyEntry("entry-a", { ...legacyReview, instanceId: "id-1" }), anonymous]);
	assert.equal(kept.runtime.current()?.instanceId, "id-1", "the copy inherits the active id, so it needs no entry id");
	const explicit = harness([{ ...anonymous, data: { ...anonymous.data, current: { ...legacyReview, instanceId: "id-9" } } }]);
	assert.equal(explicit.runtime.current()?.instanceId, "id-9", "an explicit id needs no entry id");
});

test("a malformed instanceId rejects the state entry", () => {
	const valid = { ...legacyReview, instanceId: "kept" };
	for (const instanceId of ["", "   ", 7, "x".repeat(129)]) {
		const h = harness([legacyEntry("entry-a", valid), legacyEntry("entry-b", { ...legacyReview, instanceId })]);
		assert.equal(h.runtime.current()?.instanceId, "kept", `instanceId ${JSON.stringify(instanceId)} must not be accepted`);
	}
	const trimmed = harness([legacyEntry("entry-a", { ...legacyReview, instanceId: "  spaced  " })]);
	assert.equal(trimmed.runtime.current()?.instanceId, "spaced");
});

test("supportsContextAwareModeInstanceIdsV1 needs the flag, not an active mode", () => {
	const modes = { defineMode: () => ({ status: "refused" as const, code: "INVALID_REQUEST" as const, message: "" }), current: () => null, setSuggestionConfirmer: () => {} };
	const service = (extra: object) => ({ protocolVersion: 1, modes: { ...modes, ...extra } }) as unknown as ContextAwareServiceV1;
	assert.equal(supportsContextAwareModeInstanceIdsV1(service({ instanceIds: true })), true);
	assert.equal(supportsContextAwareModeInstanceIdsV1(service({})), false);
	assert.equal(supportsContextAwareModeInstanceIdsV1(service({ instanceIds: "yes" })), false);
	assert.equal(supportsContextAwareModeInstanceIdsV1({ protocolVersion: 1 } as unknown as ContextAwareServiceV1), false);
	assert.equal(supportsContextAwareModeInstanceIdsV1(undefined), false);
});

test("producers and consumers written before instanceId still type-check", () => {
	// Compile-time guard: test:compile fails if instanceId or instanceIds becomes required.
	const oldSnapshot: ContextAwareModeSnapshotV1 = { id: "review", owner: "owner", enteredAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", available: true };
	const oldProducer: ContextAwareModesV1 = {
		current: () => oldSnapshot,
		defineMode: () => ({ status: "refused", code: "INVALID_REQUEST", message: "refused" }),
		setSuggestionConfirmer: () => {},
	};
	const newProducer: ContextAwareModesV1 = { ...oldProducer, instanceIds: true, current: () => ({ ...oldSnapshot, instanceId: "new-id" }) };
	type OldModes = Pick<ContextAwareModesV1, "defineMode" | "setSuggestionConfirmer"> & { current(): Omit<ContextAwareModeSnapshotV1, "instanceId"> | null };
	const oldConsumer: OldModes = newProducer;
	assert.equal(oldConsumer.current()?.id, "review");
	assert.equal(supportsContextAwareModeInstanceIdsV1({ protocolVersion: 1, modes: oldProducer } as unknown as ContextAwareServiceV1), false);
});

async function enteredWithPolicy(toolPolicy: ContextAwareModeDefinitionV1["toolPolicy"], extra: Partial<ContextAwareModeDefinitionV1> = {}) {
	const h = harness();
	const mode = h.runtime.defineMode(definition("review", "owner", { toolPolicy, ...extra }));
	assert.equal(mode.status, "ok");
	if (mode.status !== "ok") throw new Error("mode was not defined");
	assert.deepEqual(await mode.handle.enter(), { status: "ok" });
	return h;
}

test("a tool policy refuses every tool it does not list and lets listed tools run", async () => {
	const h = await enteredWithPolicy({ allowedTools: ["read", "grep"] });
	assert.equal(h.runtime.handleToolCall("read", { path: "a" }), undefined);
	assert.equal(h.runtime.handleToolCall("grep", { pattern: "x" }), undefined);
	assert.deepEqual(h.runtime.handleToolCall("replace_match", { path: "a", secret: "do-not-echo" }), {
		block: true,
		reason: "Tool replace_match is not allowed by mode review.",
	});
	assert.deepEqual(h.runtime.handleToolCall("fabric_exec", {}), {
		block: true,
		reason: "Tool fabric_exec is not allowed by mode review.",
	});
});

test("while lifted returns true the policy lets every tool run, and the guard still runs", async () => {
	let lifted = false;
	const h = await enteredWithPolicy({ allowedTools: ["read"], lifted: () => lifted }, {
		guard: (toolName) => toolName === "write" ? { block: true, reason: "guard says no" } : undefined,
	});
	assert.ok(h.runtime.handleToolCall("edit", {}), "not lifted: an unlisted tool is refused");
	lifted = true;
	assert.equal(h.runtime.handleToolCall("edit", {}), undefined);
	assert.equal(h.runtime.handleToolCall("bash", { command: "rm -rf src" }), undefined);
	assert.deepEqual(h.runtime.handleToolCall("write", {}), { block: true, reason: "guard says no" });
	lifted = false;
	assert.deepEqual(h.runtime.handleToolCall("edit", {}), { block: true, reason: "Tool edit is not allowed by mode review." });
});

test("a throwing or non-boolean lifted counts as not lifted", async () => {
	for (const lifted of [() => { throw new Error("private lift detail"); }, () => "yes" as unknown as boolean, () => 1 as unknown as boolean]) {
		const h = await enteredWithPolicy({ allowedTools: ["read"], lifted });
		assert.deepEqual(h.runtime.handleToolCall("edit", {}), { block: true, reason: "Tool edit is not allowed by mode review." });
		assert.equal(h.runtime.handleToolCall("read", {}), undefined);
	}
});

test("blockedTools wins over the allow-list and the guard runs only after the policy", async () => {
	const guarded: string[] = [];
	const h = await enteredWithPolicy({ allowedTools: ["bash", "read"] }, {
		blockedTools: ["bash"],
		guard: (toolName) => { guarded.push(toolName); return undefined; },
	});
	assert.deepEqual(h.runtime.handleToolCall("bash", { command: "ls" }), { block: true, reason: "Tool bash is blocked by mode review." });
	assert.ok(h.runtime.handleToolCall("edit", {}));
	assert.equal(h.runtime.handleToolCall("read", {}), undefined);
	assert.deepEqual(guarded, ["read"], "the guard sees only calls the policy let through");
});

test("readOnlyShell lets bash run only commands that pass the read-only check", async () => {
	const h = await enteredWithPolicy({ allowedTools: ["bash", "read"], readOnlyShell: true });
	assert.equal(h.runtime.handleToolCall("bash", { command: "git diff" }), undefined);
	assert.equal(h.runtime.handleToolCall("bash", { command: "rg foo src" }), undefined);
	const refusedReason = { block: true, reason: "Tool bash is not allowed by mode review: the command is not on the read-only shell list." };
	for (const command of [
		"git diff --output=x", "fd -x rm", "rg --pre sh x", "git diff; rm a", "cat a > b", "echo $(id)", "sh -c x", "git diff\nrm a",
		"git log --show-signature", "git log --format=%GG", "file -S -z a.Z", "file -p x", "fd -l x", "git status --ignored", "tail -f a",
	]) {
		assert.deepEqual(h.runtime.handleToolCall("bash", { command }), refusedReason, command);
	}
	assert.deepEqual(h.runtime.handleToolCall("bash", {}), refusedReason, "a missing command is refused");
	assert.equal(JSON.stringify(h.runtime.handleToolCall("bash", { command: "cat secret-token > b" })).includes("secret-token"), false, "the reason never repeats the command");
});

test("readOnlyShell does not admit bash when allowedTools omits it, and false leaves bash to allowedTools", async () => {
	const unlisted = await enteredWithPolicy({ allowedTools: ["read"], readOnlyShell: true });
	assert.deepEqual(unlisted.runtime.handleToolCall("bash", { command: "git diff" }), { block: true, reason: "Tool bash is not allowed by mode review." });
	const free = await enteredWithPolicy({ allowedTools: ["bash"], readOnlyShell: false });
	assert.equal(free.runtime.handleToolCall("bash", { command: "rm -rf src" }), undefined);
	const lifted = await enteredWithPolicy({ allowedTools: ["bash"], readOnlyShell: true, lifted: () => true });
	assert.equal(lifted.runtime.handleToolCall("bash", { command: "rm -rf src" }), undefined);
});

test("an invalid tool policy refuses defineMode", () => {
	const invalid: unknown[] = [
		null,
		"read",
		{},
		{ allowedTools: "read" },
		{ allowedTools: [""] },
		{ allowedTools: ["   "] },
		{ allowedTools: [7] },
		{ allowedTools: ["x".repeat(129)] },
		{ allowedTools: Array.from({ length: 65 }, (_, index) => `tool-${index}`) },
		{ allowedTools: ["read"], readOnlyShell: "true" },
		{ allowedTools: ["read"], readOnlyShell: 1 },
		{ allowedTools: ["read"], lifted: true },
		{ allowedTools: ["read"], lifted: "() => true" },
	];
	for (const toolPolicy of invalid) {
		const h = harness();
		const result = h.runtime.defineMode(definition("review", "owner", { toolPolicy: toolPolicy as ContextAwareModeDefinitionV1["toolPolicy"] }));
		assert.deepEqual(result, { status: "refused", code: "INVALID_REQUEST", message: "Mode definition is invalid or exceeds its bounds." }, JSON.stringify(toolPolicy));
	}
	const h = harness();
	assert.equal(h.runtime.defineMode(definition("max", "owner", { toolPolicy: { allowedTools: Array.from({ length: 64 }, (_, index) => `tool-${index}`) } })).status, "ok");
	assert.equal(h.runtime.defineMode(definition("empty", "owner", { toolPolicy: { allowedTools: [] } })).status, "ok");
});

test("the runtime copies the policy, trims names, and ignores later changes to the caller's object", async () => {
	const allowedTools = ["  read  ", "bash"];
	const toolPolicy: { allowedTools: string[]; readOnlyShell: boolean; lifted: () => boolean } = { allowedTools, readOnlyShell: true, lifted: () => false };
	// An enumerable extra field that throws when read: copying or spreading the caller's object fails the test.
	Object.defineProperty(toolPolicy, "extra", { enumerable: true, get: () => { throw new Error("the runtime read a field it should not copy"); } });
	const h = await enteredWithPolicy(toolPolicy);
	assert.equal(h.runtime.handleToolCall("read", {}), undefined, "names are trimmed");
	allowedTools.push("edit");
	toolPolicy.allowedTools = ["edit"];
	toolPolicy.readOnlyShell = false;
	toolPolicy.lifted = () => true;
	assert.ok(h.runtime.handleToolCall("edit", {}), "a later change to the caller's list or lifted does not widen the policy");
	assert.equal(h.runtime.handleToolCall("read", {}), undefined);
	assert.ok(h.runtime.handleToolCall("bash", { command: "rm -rf src" }), "a later change to readOnlyShell does not turn the shell check off");
	assert.equal(h.runtime.handleToolCall("bash", { command: "git diff" }), undefined);
});

test("an empty allow-list refuses every tool, and modes without a policy keep their behavior", async () => {
	const closed = await enteredWithPolicy({ allowedTools: [] });
	assert.ok(closed.runtime.handleToolCall("read", {}));
	assert.ok(closed.runtime.handleToolCall("suggest_mode", {}));
	const open = await enteredWithPolicy(undefined, { blockedTools: ["write"] });
	assert.equal(open.runtime.handleToolCall("replace_match", {}), undefined);
	assert.equal(open.runtime.handleToolCall("bash", { command: "rm -rf src" }), undefined);
	assert.ok(open.runtime.handleToolCall("write", {}));
});

test("a nested mode's policy replaces the outer one, and exit restores it", async () => {
	const h = harness();
	const outer = h.runtime.defineMode(definition("outer", "a", { toolPolicy: { allowedTools: ["read"] } }));
	const inner = h.runtime.defineMode(definition("inner", "b"));
	assert.equal(outer.status, "ok");
	assert.equal(inner.status, "ok");
	if (outer.status !== "ok" || inner.status !== "ok") return;
	await outer.handle.enter();
	assert.ok(h.runtime.handleToolCall("edit", {}));
	await inner.handle.enter();
	assert.equal(h.runtime.handleToolCall("edit", {}), undefined);
	assert.deepEqual(inner.handle.exit(), { status: "ok" });
	assert.deepEqual(h.runtime.handleToolCall("edit", {}), { block: true, reason: "Tool edit is not allowed by mode outer." });
});

test("supportsContextAwareModeToolPoliciesV1 needs the toolPolicies flag on a modes capability", () => {
	const modes = { defineMode: () => ({ status: "refused" as const, code: "INVALID_REQUEST" as const, message: "" }), current: () => null, setSuggestionConfirmer: () => {} };
	const service = (extra: object) => ({ protocolVersion: 1, modes: { ...modes, ...extra } }) as unknown as ContextAwareServiceV1;
	assert.equal(supportsContextAwareModeToolPoliciesV1(service({ toolPolicies: true })), true);
	assert.equal(supportsContextAwareModeToolPoliciesV1(service({ instanceIds: true })), false);
	assert.equal(supportsContextAwareModeToolPoliciesV1(service({ toolPolicies: "yes" })), false);
	assert.equal(supportsContextAwareModeToolPoliciesV1({ protocolVersion: 1, modes: { toolPolicies: true } } as unknown as ContextAwareServiceV1), false, "the flag alone is not a modes capability");
	assert.equal(supportsContextAwareModeToolPoliciesV1(undefined), false);
});
