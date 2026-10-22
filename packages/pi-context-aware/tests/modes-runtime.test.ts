import assert from "node:assert/strict";
import test from "node:test";
import {
	MODE_MESSAGE_TYPE,
	MODE_STATE_ENTRY_TYPE,
	MODE_STATE_ENTRY_TYPE_V1,
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
	const stage = h.runtime.defineMode(definition("stage", "a", { transition: "Stage transition.", layer: { name: "stage", rank: 1 } }));
	const stance = h.runtime.defineMode(definition("stance", "b", { transition: "Stance transition.", blockedTools: ["write"], layer: { name: "stance", rank: 2 } }));
	assert.equal(stage.status, "ok");
	assert.equal(stance.status, "ok");
	if (stage.status !== "ok" || stance.status !== "ok") return;
	assert.deepEqual(await stage.handle.enter(), { status: "ok" });
	assert.deepEqual(await stance.handle.enter(), { status: "ok" });
	assert.deepEqual(stance.handle.exit(), { status: "ok" });
	assert.deepEqual(stage.handle.exit(), { status: "ok" });
	assert.equal(h.messages.length, 4);
	assert.ok(h.messages.every((message) => message.customType === MODE_MESSAGE_TYPE));
	assert.deepEqual(h.messages.map((message) => [message.content, (message.details as { action: string; layer: string }).action, (message.details as { layer: string }).layer]), [
		["Stage transition.", "enter", "stage"],
		["Stance transition.", "enter", "stance"],
		["Exited mode stance.", "exit", "stance"],
		["Exited mode stage.", "exit", "stage"],
	]);
	const last = stateEntries(h.entries).at(-1) as { data: { updatedAt: string; transitionId: string } };
	assert.deepEqual(last, {
		type: "custom",
		customType: MODE_STATE_ENTRY_TYPE,
		data: {
			schemaVersion: 2,
			layers: [],
			updatedAt: last.data.updatedAt,
			transitionId: last.data.transitionId,
		},
	});
	const transitionIds = stateEntries(h.entries).map((entry) => (entry as { data: { transitionId: string } }).data.transitionId);
	assert.deepEqual(h.messages.map((message) => (message.details as { transitionId: string }).transitionId), transitionIds, "each message carries its state entry's transitionId");
	assert.equal(new Set(transitionIds).size, 4);
});

test("tool rules intersect across layers, and entering on an occupied layer replaces its mode with one message", async () => {
	const h = harness();
	const stage = h.runtime.defineMode(definition("build", "a", { blockedTools: ["bash"], layer: { name: "stage", rank: 1 } }));
	const stance = h.runtime.defineMode(definition("review", "b", { blockedTools: ["write"], layer: { name: "stance", rank: 2 } }));
	const replacement = h.runtime.defineMode(definition("audit", "c", { transition: "Audit transition.", layer: { name: "stance", rank: 2 } }));
	assert.ok(stage.status === "ok" && stance.status === "ok" && replacement.status === "ok");
	await stage.handle.enter();
	await stance.handle.enter();
	assert.deepEqual(h.runtime.handleToolCall("bash", {}), { block: true, reason: "Tool bash is blocked by mode build." });
	assert.deepEqual(h.runtime.handleToolCall("write", {}), { block: true, reason: "Tool write is blocked by mode review." });
	assert.equal(h.runtime.handleToolCall("read", {}), undefined);
	const beforeMessages = h.messages.length;
	const beforeEntries = stateEntries(h.entries).length;
	assert.deepEqual(await replacement.handle.enter(), { status: "ok" });
	assert.deepEqual(h.messages.slice(beforeMessages).map((message) => [message.content, (message.details as { action: string }).action]), [["Audit transition.", "enter"]]);
	assert.equal(stateEntries(h.entries).length, beforeEntries + 1);
	assert.deepEqual(h.runtime.layers().map((snapshot) => [snapshot.layer, snapshot.id]), [["stage", "build"], ["stance", "audit"]]);
	assert.equal(h.runtime.handleToolCall("write", {}), undefined, "the replaced mode's rules are gone");
	assert.ok(h.runtime.handleToolCall("bash", {}), "the other layer's rules stay");
	assert.equal(stance.handle.exit().status, "refused", "the replaced handle no longer holds the layer");
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

test("leaving an orphan layer on resume resends only the text of the layers that remain", async () => {
	const first = harness();
	const stage = first.runtime.defineMode(definition("build", "a", { transition: "Build transition.", layer: { name: "stage", rank: 1 } }));
	const stance = first.runtime.defineMode(definition("review", "b", { transition: "Review transition.", layer: { name: "stance", rank: 2 } }));
	assert.ok(stage.status === "ok" && stance.status === "ok");
	await stage.handle.enter();
	await stance.handle.enter();
	const resumed = harness(first.entries.concat(first.messages.map((message) => ({ type: "custom_message", ...message }))));
	assert.deepEqual(resumed.runtime.layers().map((snapshot) => [snapshot.id, snapshot.available]), [["build", false], ["review", false]]);
	assert.deepEqual(resumed.runtime.userExit(), { status: "ok" });
	assert.equal(resumed.runtime.current()?.id, "build");
	assert.equal(resumed.messages.at(-1)?.content, "Exited mode review.");
	resumed.runtime.resend();
	assert.equal(resumed.messages.at(-1)?.content, "Build transition.");
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

/** A state entry the identity ledger refuses, and a message that claims to be its transition. */
function refusedEnter(mode: ContextAwareModeSnapshotV1 | Record<string, unknown>, content: string): unknown[] {
	const { id, owner, instanceId } = mode as { id: string; owner: string; instanceId: string };
	return [
		{ type: "custom", id: "refused", customType: MODE_STATE_ENTRY_TYPE, data: { schemaVersion: 2, layers: [{ layer: "stage", rank: 1, mode }], updatedAt: "2026-10-09T00:00:00.000Z", transitionId: "refused-transition" } },
		{ type: "custom_message", id: "refused-message", customType: MODE_MESSAGE_TYPE, content, details: { id, owner, action: "enter", transitionId: "refused-transition", instanceId, layer: "stage" } },
	];
}

test("replay keeps the remaining layer's text and never resends the message of a refused state entry", async () => {
	const live = orderedHarness();
	const stage = live.runtime.defineMode(definition("build", "a", { transition: "Build transition.", layer: { name: "stage", rank: 1 } }));
	const stance = live.runtime.defineMode(definition("review", "b", { transition: "Review transition.", layer: { name: "stance", rank: 2 } }));
	assert.ok(stage.status === "ok" && stance.status === "ok");
	await stage.handle.enter();
	await stance.handle.enter();
	assert.deepEqual(stance.handle.exit(), { status: "ok" });
	const restored = live.runtime.current();
	assert.equal(restored?.id, "build");
	if (restored === null) return;
	const clean = harness([...live.entries]);
	clean.runtime.resend();
	assert.equal(clean.messages.at(-1)?.content, "Build transition.", "the stance exit leaves the stage text");
	const stateOnly = live.entries.filter((entry) => (entry as { customType?: unknown }).customType !== MODE_MESSAGE_TYPE);
	const messagesOnly = live.entries.filter((entry) => (entry as { customType?: unknown }).customType === MODE_MESSAGE_TYPE);
	const wrongMode = { id: "wrong", owner: "c", instanceId: restored.instanceId, enteredAt: restored.enteredAt };
	const sameMode = { id: "build", owner: "a", instanceId: restored.instanceId, enteredAt: new Date(Date.parse(restored.enteredAt) + 1000).toISOString() };
	for (const [label, mode] of [["wrong mode", wrongMode], ["second enter", sameMode]] as const) {
		// Pi held the accepted messages until after the refused entry and its message.
		const poisoned = harness([...stateOnly, ...refusedEnter(mode, `REFUSED ${label}`), ...messagesOnly]);
		assert.equal(poisoned.runtime.current()?.id, "build", label);
		assert.equal(poisoned.runtime.current()?.enteredAt, restored.enteredAt, label);
		poisoned.runtime.resend();
		assert.equal(poisoned.messages.at(-1)?.content, "Build transition.", `a refused entry's message must not stand in for the accepted text (${label})`);
	}
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
		const stage = first.runtime.defineMode(definition("build", "a", { transition: "Build transition.", layer: { name: "stage", rank: 1 } }));
		const stance = first.runtime.defineMode(definition("review", "b", { transition: "Review transition.", layer: { name: "stance", rank: 2 } }));
		assert.ok(stage.status === "ok" && stance.status === "ok");
		await stage.handle.enter();
		await stance.handle.enter();
		assert.deepEqual(stance.handle.exit(), { status: "ok" });
		const accepted = first.runtime.current();
		if (accepted === null) return assert.fail("build is active");
		const mode = { id: accepted.id, owner: accepted.owner, instanceId: accepted.instanceId, enteredAt: accepted.enteredAt };
		const bad = kind === "malformed"
			? { ...mode, instanceId: 7 }
			: { ...mode, enteredAt: new Date(Date.parse(accepted.enteredAt) + 1000).toISOString() };
		// Pi held all three messages until the end of the turn, after the bad entry.
		const branch = [
			...first.entries,
			{ type: "custom", customType: MODE_STATE_ENTRY_TYPE, data: { schemaVersion: 2, layers: [{ layer: "stage", rank: 1, mode: bad }], updatedAt: "2026-10-09T00:00:00.000Z" } },
			...first.messages.map((message, index) => ({ type: "custom_message", id: `m${index}`, ...message })),
		];
		const resumed = harness(branch);
		assert.equal(resumed.runtime.current()?.instanceId, accepted.instanceId, kind);
		resumed.runtime.resend();
		assert.equal(resumed.messages.at(-1)?.content, "Build transition.", kind);
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
		{ type: "custom", id: "accepted", customType: MODE_STATE_ENTRY_TYPE_V1, data: { schemaVersion: 1, current: review, outer: null, updatedAt: "2026-10-01T00:00:00.000Z" } },
		// A message with a transitionId belongs to a newer entry, even for the same mode.
		legacyMessage("tokened", "TOKENED TEXT", { transitionId: "belongs-to-a-newer-entry" }),
		legacyMessage("accepted-message", "Legacy transition."),
		{ type: "custom", id: "malformed", customType: MODE_STATE_ENTRY_TYPE_V1, data: null },
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
	const persisted = stateEntries(h.entries).map((entry) => (entry as { data: { layers: Array<{ mode: { instanceId: string } }> } }).data.layers[0]?.mode.instanceId ?? null);
	assert.deepEqual(persisted, [first.instanceId, null, second.instanceId]);
});

test("entering a higher layer keeps the lower layer's instanceId, and leaving it keeps it too", async () => {
	const h = harness();
	const stage = h.runtime.defineMode(definition("build", "a", { layer: { name: "stage", rank: 1 } }));
	const stance = h.runtime.defineMode(definition("review", "b", { layer: { name: "stance", rank: 2 } }));
	assert.ok(stage.status === "ok" && stance.status === "ok");
	await stage.handle.enter();
	const stageId = h.runtime.current()?.instanceId;
	assert.match(stageId ?? "", /^[0-9a-f-]{36}$/, "the stage mode must have an id before the stance enters");
	await stance.handle.enter();
	assert.deepEqual(h.runtime.layers().map((snapshot) => snapshot.id), ["build", "review"]);
	assert.equal(h.runtime.layers()[0]?.instanceId, stageId);
	assert.notEqual(h.runtime.current()?.instanceId, stageId);
	assert.deepEqual(stance.handle.exit(), { status: "ok" });
	assert.equal(h.runtime.current()?.instanceId, stageId);
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
	return { type: "custom", id, customType: MODE_STATE_ENTRY_TYPE_V1, data: { schemaVersion: 1, current, outer, updatedAt: "2026-10-01T00:00:00.000Z" } };
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

test("a legacy enter keeps its derived id while later entries copy it, and a later enter gets a new one", async () => {
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
	const stage = persisted.runtime.defineMode(definition("build", "a", { layer: { name: "stage", rank: 1 } }));
	assert.ok(stage.status === "ok");
	assert.deepEqual(await stage.handle.enter(), { status: "ok" });
	const written = stateEntries(persisted.entries).at(-1) as { data: { layers: Array<{ layer: string; mode: { instanceId: string } }> } };
	assert.equal(written.data.layers.find((slot) => slot.layer === "default")?.mode.instanceId, derived, "a transition persists the derived id");
	assert.match(derived ?? "", /^legacy-[0-9a-f]{32}$/);
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
	const anonymous = { type: "custom", customType: MODE_STATE_ENTRY_TYPE_V1, data: { schemaVersion: 1, current: legacyReview, outer: null, updatedAt: "2026-10-01T00:00:00.000Z" } };
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

test("tool rules intersect across layers, and a lift lifts only its own layer's policy", async () => {
	const h = harness();
	let stageLifted = false;
	const stage = h.runtime.defineMode(definition("build", "a", { toolPolicy: { allowedTools: ["read", "edit"], lifted: () => stageLifted }, layer: { name: "stage", rank: 1 } }));
	const stance = h.runtime.defineMode(definition("review", "b", { toolPolicy: { allowedTools: ["read", "grep"] }, layer: { name: "stance", rank: 2 } }));
	assert.ok(stage.status === "ok" && stance.status === "ok");
	await stage.handle.enter();
	assert.equal(h.runtime.handleToolCall("edit", {}), undefined);
	await stance.handle.enter();
	assert.equal(h.runtime.handleToolCall("read", {}), undefined, "a tool both layers allow runs");
	assert.deepEqual(h.runtime.handleToolCall("edit", {}), { block: true, reason: "Tool edit is not allowed by mode review." });
	assert.deepEqual(h.runtime.handleToolCall("grep", {}), { block: true, reason: "Tool grep is not allowed by mode build." });
	stageLifted = true;
	assert.equal(h.runtime.handleToolCall("grep", {}), undefined, "the stage lift lifts the stage policy");
	assert.deepEqual(h.runtime.handleToolCall("edit", {}), { block: true, reason: "Tool edit is not allowed by mode review." }, "the stage lift does not lift the stance policy");
	assert.deepEqual(stance.handle.exit(), { status: "ok" });
	assert.equal(h.runtime.handleToolCall("edit", {}), undefined);
});

test("blockedTools on any layer wins over another layer's allow-list, and every guard runs", async () => {
	const h = harness();
	const guarded: string[] = [];
	const stage = h.runtime.defineMode(definition("build", "a", { blockedTools: ["bash"], guard: (toolName) => { guarded.push(`build:${toolName}`); return undefined; }, layer: { name: "stage", rank: 1 } }));
	const stance = h.runtime.defineMode(definition("review", "b", { toolPolicy: { allowedTools: ["bash", "read"] }, guard: (toolName) => { guarded.push(`review:${toolName}`); return toolName === "read" ? { block: true, reason: "no reading" } : undefined; }, layer: { name: "stance", rank: 2 } }));
	assert.ok(stage.status === "ok" && stance.status === "ok");
	await stage.handle.enter();
	await stance.handle.enter();
	assert.deepEqual(h.runtime.handleToolCall("bash", { command: "ls" }), { block: true, reason: "Tool bash is blocked by mode build." });
	assert.deepEqual(guarded, [], "no guard runs when a blocked tool refuses the call");
	assert.deepEqual(h.runtime.handleToolCall("read", {}), { block: true, reason: "no reading" });
	assert.deepEqual(guarded, ["build:read", "review:read"]);
});

test("layers sort by rank, then by layer name, whatever order they were entered in", async () => {
	const h = harness();
	const modes = [
		h.runtime.defineMode(definition("stance-b", "a", { layer: { name: "beta", rank: 2 } })),
		h.runtime.defineMode(definition("role", "a", { layer: { name: "role", rank: 0 } })),
		h.runtime.defineMode(definition("stance-a", "a", { layer: { name: "alpha", rank: 2 } })),
	];
	for (const mode of modes) {
		assert.ok(mode.status === "ok");
		await mode.handle.enter();
	}
	assert.deepEqual(h.runtime.layers().map((snapshot) => [snapshot.layer, snapshot.rank]), [["role", 0], ["alpha", 2], ["beta", 2]]);
	assert.equal(h.runtime.current()?.id, "stance-b");
	assert.equal(h.runtime.current()?.outer?.id, "stance-a", "current() names the next layer down as outer");
	assert.equal(h.runtime.current()?.outer?.outer, undefined);
});

test("a second definition on a layer must name the same rank and pin", () => {
	const h = harness();
	assert.equal(h.runtime.defineMode(definition("build", "a", { layer: { name: "stage", rank: 1 } })).status, "ok");
	for (const layer of [{ name: "stage", rank: 2 }, { name: "stage", rank: 1, pinned: true as const }]) {
		assert.deepEqual(h.runtime.defineMode(definition("other", "b", { layer })), {
			status: "refused",
			code: "INVALID_REQUEST",
			message: "Another mode names this layer with a different rank or pin.",
		});
	}
	assert.equal(h.runtime.defineMode(definition("plan", "b", { layer: { name: "stage", rank: 1 } })).status, "ok");
	for (const layer of [{ name: "default", rank: 3 }, { name: "big", rank: 1_000_001 }, { name: "frac", rank: 1.5 }]) {
		assert.equal(h.runtime.defineMode(definition(`bad-${layer.name}`, "c", { layer })).status, "refused", layer.name);
	}
});

test("bare user exit leaves the highest-ranked layer that is not pinned, and a named exit leaves that layer", async () => {
	const h = harness();
	const role = h.runtime.defineMode(definition("overseer", "a", { layer: { name: "role", rank: 0, pinned: true } }));
	const stage = h.runtime.defineMode(definition("build", "a", { layer: { name: "stage", rank: 1 } }));
	const stance = h.runtime.defineMode(definition("review", "a", { layer: { name: "stance", rank: 2 } }));
	assert.ok(role.status === "ok" && stage.status === "ok" && stance.status === "ok");
	h.runtime.openPinnedWindow();
	assert.deepEqual(await role.handle.enter(), { status: "ok" });
	h.runtime.closePinnedWindow();
	await stage.handle.enter();
	await stance.handle.enter();
	assert.deepEqual(h.runtime.userExit("stage"), { status: "ok" });
	assert.deepEqual(h.runtime.layers().map((snapshot) => snapshot.layer), ["role", "stance"]);
	assert.deepEqual(h.runtime.userExit("stage"), { status: "refused", code: "NOT_FOUND", message: "No mode is active on that layer." });
	assert.deepEqual(h.runtime.userExit(), { status: "ok" });
	assert.deepEqual(h.runtime.layers().map((snapshot) => snapshot.layer), ["role"]);
	const beforeEntries = h.entries.length;
	assert.deepEqual(h.runtime.userExit(), { status: "refused", code: "PINNED_LAYER", message: "Only pinned modes are active." });
	assert.equal(h.runtime.userExit("role").status, "refused");
	assert.equal(h.entries.length, beforeEntries, "a refused exit writes nothing");
	assert.equal(h.runtime.current()?.id, "overseer");
});

test("a pinned layer is entered only while the start window is open, and no call can exit or replace it", async () => {
	const h = harness();
	const role = h.runtime.defineMode(definition("overseer", "a", { layer: { name: "role", rank: 0, pinned: true } }));
	const rival = h.runtime.defineMode(definition("worker", "a", { layer: { name: "role", rank: 0, pinned: true } }));
	assert.ok(role.status === "ok" && rival.status === "ok");
	const late = { status: "refused", code: "PINNED_LAYER", message: "A pinned layer can be entered only before the session's first agent run." };
	assert.deepEqual(await role.handle.enter(), late, "the window is closed until the host opens it");
	h.runtime.openPinnedWindow();
	assert.deepEqual(await role.handle.enter({ until: new AbortController().signal }), { status: "refused", code: "INVALID_REQUEST", message: "A pinned layer cannot be entered for one run." });
	h.setConfirmer(async () => true);
	assert.deepEqual(await role.handle.enter({ suggestedBy: "model", confirm: true }), { status: "refused", code: "PINNED_LAYER", message: "A pinned layer is entered only by its owner at session start." });
	assert.equal((await h.runtime.enterSuggested("overseer")).status, "refused");
	assert.deepEqual(await role.handle.enter(), { status: "ok" });
	assert.deepEqual(await rival.handle.enter(), late, "an occupied pinned layer cannot be replaced, even with the window open");
	h.runtime.closePinnedWindow();
	assert.deepEqual(role.handle.exit(), { status: "refused", code: "PINNED_LAYER", message: "A pinned mode cannot be exited." });
	assert.equal((await h.runtime.exitSuggested("overseer")).status, "refused");
	assert.equal(h.runtime.current()?.id, "overseer");
	assert.equal(h.runtime.current()?.pinned, true);
	h.runtime.openPinnedWindow();
	h.runtime.userExit();
	assert.equal(h.runtime.current()?.id, "overseer", "opening the window again does not unpin");
});

test("a run-scoped mode leaves its layer when the run ends, unless another mode replaced it", async () => {
	const h = harness();
	const stage = h.runtime.defineMode(definition("build", "a", { layer: { name: "stage", rank: 1 } }));
	const stance = h.runtime.defineMode(definition("review", "a", { blockedTools: ["write"], layer: { name: "stance", rank: 2 } }));
	const other = h.runtime.defineMode(definition("audit", "a", { layer: { name: "stance", rank: 2 } }));
	assert.ok(stage.status === "ok" && stance.status === "ok" && other.status === "ok");
	await stage.handle.enter();
	const run = new AbortController();
	assert.deepEqual(await stance.handle.enter({ until: run.signal }), { status: "ok" });
	assert.equal(h.runtime.current()?.runScoped, true);
	assert.ok(h.runtime.handleToolCall("write", {}));
	run.abort();
	assert.deepEqual(h.runtime.layers().map((snapshot) => snapshot.id), ["build"], "the stage mode stays");
	assert.deepEqual([h.messages.at(-1)?.content, (h.messages.at(-1)?.details as { action: string }).action], ["Exited mode review.", "exit"]);
	assert.equal(h.runtime.handleToolCall("write", {}), undefined);
	const second = new AbortController();
	await stance.handle.enter({ until: second.signal });
	await other.handle.enter();
	const beforeMessages = h.messages.length;
	second.abort();
	assert.equal(h.messages.length, beforeMessages, "the replaced run-scoped mode does not take the new mode with it");
	assert.equal(h.runtime.current()?.id, "audit");
	assert.deepEqual(await stance.handle.enter({ until: AbortSignal.abort() }), { status: "refused", code: "RUN_ENDED", message: "The run this mode was entered for has ended." });
});

test("resume restores every layer but a run-scoped one, and resends their texts once in rank order", async () => {
	const first = harness();
	const role = first.runtime.defineMode(definition("overseer", "a", { transition: "Shared text.", layer: { name: "role", rank: 0, pinned: true } }));
	const stage = first.runtime.defineMode(definition("build", "a", { transition: "Build text.", layer: { name: "stage", rank: 1 } }));
	const stance = first.runtime.defineMode(definition("review", "a", { transition: "Shared text.", layer: { name: "stance", rank: 2 } }));
	const run = first.runtime.defineMode(definition("probe", "a", { transition: "Probe text.", layer: { name: "probe", rank: 3 } }));
	assert.ok(role.status === "ok" && stage.status === "ok" && stance.status === "ok" && run.status === "ok");
	first.runtime.openPinnedWindow();
	await role.handle.enter();
	first.runtime.closePinnedWindow();
	await stage.handle.enter();
	await stance.handle.enter();
	await run.handle.enter({ until: new AbortController().signal });
	const live = first.runtime.layers();
	const resumed = harness(first.entries.concat(first.messages.map((message, index) => ({ type: "custom_message", id: `m${index}`, ...message }))));
	assert.deepEqual(
		resumed.runtime.layers().map((snapshot) => [snapshot.layer, snapshot.id, snapshot.instanceId, snapshot.pinned === true]),
		live.slice(0, 3).map((snapshot) => [snapshot.layer, snapshot.id, snapshot.instanceId, snapshot.pinned === true]),
	);
	resumed.runtime.resend();
	assert.equal(resumed.messages.length, 1);
	assert.equal(resumed.messages[0]?.content, "Shared text.\n\nBuild text.");
	assert.equal(resumed.runtime.defineMode(definition("overseer", "a", { transition: "Shared text.", layer: { name: "role", rank: 0, pinned: true } })).status, "ok");
	assert.deepEqual(resumed.runtime.userExit("role"), { status: "refused", code: "PINNED_LAYER", message: "A pinned mode cannot be exited while its owner defines it." }, "a resumed pinned layer stays pinned");
	assert.deepEqual(resumed.runtime.userExit(), { status: "ok" });
	assert.deepEqual(resumed.runtime.layers().map((snapshot) => snapshot.layer), ["role", "stage"]);
});

test("after resume, a definition naming a restored layer with another rank or pin is refused, so the owner re-arms its pinned layer", async () => {
	const first = harness();
	const roleDefinition = definition("overseer", "a", { blockedTools: ["bash"], layer: { name: "role", rank: 0, pinned: true } });
	const role = first.runtime.defineMode(roleDefinition);
	assert.ok(role.status === "ok");
	first.runtime.openPinnedWindow();
	assert.deepEqual(await role.handle.enter(), { status: "ok" });
	first.runtime.closePinnedWindow();
	const resumed = harness(first.entries.slice());
	const squat = { status: "refused", code: "INVALID_REQUEST", message: "A restored mode holds this layer with a different rank or pin." };
	assert.deepEqual(resumed.runtime.defineMode(definition("squatter", "b", { layer: { name: "role", rank: 5 } })), squat);
	assert.deepEqual(resumed.runtime.defineMode(definition("squatter", "b", { layer: { name: "role", rank: 0 } })), squat, "dropping the pin is a different shape too");
	assert.equal(resumed.runtime.defineMode(roleDefinition).status, "ok", "the owner still re-arms the restored pinned layer");
	assert.deepEqual(resumed.runtime.handleToolCall("bash", { command: "ls" }), { block: true, reason: "Tool bash is blocked by mode overseer." });
	assert.equal(resumed.runtime.userExit("role").status, "refused");
});

test("after resume, an unpinned leftover layer does not stop another mode defining that layer with another rank", async () => {
	const first = harness();
	const stage = first.runtime.defineMode(definition("build", "a", { layer: { name: "stage", rank: 1 } }));
	assert.ok(stage.status === "ok");
	assert.deepEqual(await stage.handle.enter(), { status: "ok" });
	const resumed = harness(first.entries.slice());
	assert.deepEqual(resumed.runtime.layers().map((snapshot) => [snapshot.layer, snapshot.id]), [["stage", "build"]]);
	assert.equal(resumed.runtime.defineMode(definition("deploy", "b", { layer: { name: "stage", rank: 2 } })).status, "ok");
	assert.equal(resumed.runtime.userExit("stage").status, "ok", "the leftover can still be cleared");
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
