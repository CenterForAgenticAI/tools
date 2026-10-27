import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ContextAwareModeDefinitionV1 } from "../src/context-service.js";
import { createModesExtensionController } from "../src/modes/modes-extension.js";

type ModeCommand = { handler: (args: string, ctx: ExtensionContext) => Promise<void> };

function definition(id: string, extra: Partial<ContextAwareModeDefinitionV1> = {}): ContextAwareModeDefinitionV1 {
	return { id, owner: "controller-test", transition: `${id} is active.`, blockedTools: [], ...extra };
}

const pinnedRole = (id = "overseer") => definition(id, { layer: { name: "role", rank: 0, pinned: true } });
const LATE = { status: "refused", code: "PINNED_LAYER", message: "A pinned layer can be entered only before the session's first agent run." };

/** A controller on a fake Pi whose session branch is `entries`; appended mode state lands there too. */
function harness(entries: unknown[] = []) {
	const commands = new Map<string, unknown>();
	const pi = {
		appendEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); },
		sendMessage: () => {},
		on: () => {},
		registerCommand: (name: string, command: unknown) => { commands.set(name, command); },
		registerTool: () => {},
	} as unknown as ExtensionAPI;
	const controller = createModesExtensionController(pi, { suggestToolEnabled: () => true });
	controller.register();
	const notifications: Array<[string, string | undefined]> = [];
	const ctx = {
		hasUI: true,
		ui: {
			setStatus: () => {},
			setWidget: () => {},
			notify: (message: string, level?: string) => { notifications.push([message, level]); },
			confirm: async () => false,
		},
		sessionManager: { getBranch: () => entries },
	} as unknown as ExtensionContext;
	const mode = (args: string) => (commands.get("mode") as ModeCommand).handler(args, ctx);
	const modes = () => {
		const capability = controller.capability();
		assert.ok(capability, "start creates the runtime that the capability projects");
		return capability;
	};
	const layers = () => {
		const read = modes().layers;
		assert.ok(read, "the layered runtime exposes its layers");
		return read();
	};
	return { controller, ctx, entries, notifications, mode, modes, layers };
}

const userMessage = { type: "message", message: { role: "user", content: "hello" } };
const assistantMessage = { type: "message", message: { role: "assistant", content: [] } };
const customEntry = { type: "custom", customType: "other-extension/state", data: {} };

for (const reason of ["startup", "new"] as const) {
	test(`session start "${reason}" on a branch with no conversation opens the pinned window`, async () => {
		const h = harness([customEntry]);
		h.controller.start(h.ctx, reason);
		const role = h.modes().defineMode(pinnedRole());
		assert.ok(role.status === "ok");
		assert.deepEqual(await role.handle.enter(), { status: "ok" });
		assert.equal(h.modes().current()?.pinned, true);
	});
}

for (const reason of ["reload", "resume", "fork", undefined] as const) {
	test(`session start "${String(reason)}" keeps the pinned window closed`, async () => {
		const h = harness();
		h.controller.start(h.ctx, reason);
		const role = h.modes().defineMode(pinnedRole());
		assert.ok(role.status === "ok");
		assert.deepEqual(await role.handle.enter(), LATE);
		assert.equal(h.modes().current(), null);
	});
}

for (const [label, entry] of [["user", userMessage], ["assistant", assistantMessage]] as const) {
	test(`a "new" start on a branch that already holds a ${label} message keeps the pinned window closed`, async () => {
		const h = harness([entry]);
		h.controller.start(h.ctx, "new");
		const role = h.modes().defineMode(pinnedRole());
		assert.ok(role.status === "ok");
		assert.deepEqual(await role.handle.enter(), LATE);
	});
}

test("a session branch that cannot be read keeps the pinned window closed", async () => {
	const h = harness();
	// The runtime reads the branch once to restore mode state; only the pinned-window check meets the failure.
	let reads = 0;
	const ctx = {
		...h.ctx,
		sessionManager: { getBranch: () => { reads += 1; if (reads === 1) return []; throw new Error("branch unavailable"); } },
	} as unknown as ExtensionContext;
	h.controller.start(ctx, "startup");
	assert.equal(reads, 2, "the pinned-window check read the branch");
	const role = h.modes().defineMode(pinnedRole());
	assert.ok(role.status === "ok");
	assert.deepEqual(await role.handle.enter(), LATE);
});

test("agentStart closes the pinned window that a startup opened", async () => {
	const h = harness();
	h.controller.start(h.ctx, "startup");
	const role = h.modes().defineMode(pinnedRole());
	assert.ok(role.status === "ok");
	h.controller.agentStart();
	assert.deepEqual(await role.handle.enter(), LATE);
	assert.equal(h.modes().current(), null);
});

test("/mode exit with no layer leaves the highest layer that is not pinned", async () => {
	const h = harness();
	h.controller.start(h.ctx, "startup");
	const role = h.modes().defineMode(pinnedRole());
	const stage = h.modes().defineMode(definition("build", { layer: { name: "stage", rank: 1 } }));
	const stance = h.modes().defineMode(definition("review", { layer: { name: "stance", rank: 2 } }));
	assert.ok(role.status === "ok" && stage.status === "ok" && stance.status === "ok");
	assert.deepEqual(await role.handle.enter(), { status: "ok" });
	h.controller.agentStart();
	await stage.handle.enter();
	await stance.handle.enter();
	await h.mode("exit");
	assert.deepEqual(h.layers().map((slot) => slot.layer), ["role", "stage"]);
	await h.mode("exit");
	assert.deepEqual(h.layers().map((slot) => slot.layer), ["role"]);
	await h.mode("exit");
	assert.deepEqual(h.notifications.at(-1), ["PINNED_LAYER: Only pinned modes are active.", "warning"]);
	assert.deepEqual(h.layers().map((slot) => slot.layer), ["role"]);
});

test("/mode exit <layer> leaves that layer, and refuses a live pinned layer", async () => {
	const h = harness();
	h.controller.start(h.ctx, "startup");
	const role = h.modes().defineMode(pinnedRole());
	const stage = h.modes().defineMode(definition("build", { layer: { name: "stage", rank: 1 } }));
	const stance = h.modes().defineMode(definition("review", { layer: { name: "stance", rank: 2 } }));
	assert.ok(role.status === "ok" && stage.status === "ok" && stance.status === "ok");
	await role.handle.enter();
	h.controller.agentStart();
	await stage.handle.enter();
	await stance.handle.enter();
	await h.mode("  exit   stage  ");
	assert.deepEqual(h.notifications.at(-1), ["ok", "info"]);
	assert.deepEqual(h.layers().map((slot) => slot.layer), ["role", "stance"]);
	await h.mode("exit missing");
	assert.deepEqual(h.notifications.at(-1), ["NOT_FOUND: No mode is active on that layer.", "warning"]);
	await h.mode("exit role");
	assert.deepEqual(h.notifications.at(-1), ["PINNED_LAYER: A pinned mode cannot be exited while its owner defines it.", "warning"]);
	assert.deepEqual(h.layers().map((slot) => slot.layer), ["role", "stance"]);
});

test("/mode refuses malformed arguments with the usage line and changes nothing", async () => {
	const h = harness();
	h.controller.start(h.ctx, "startup");
	const stage = h.modes().defineMode(definition("build", { layer: { name: "stage", rank: 1 } }));
	assert.ok(stage.status === "ok");
	await stage.handle.enter();
	const entriesBefore = h.entries.length;
	for (const args of ["exit stage extra", `exit ${"s".repeat(65)}`, "status stage", "leave", "stage"]) {
		await h.mode(args);
		assert.deepEqual(h.notifications.at(-1), ["Usage: /mode [status|exit [<layer>]]", "warning"], args);
	}
	assert.equal(h.entries.length, entriesBefore, "a refused command writes no mode state");
	assert.deepEqual(h.layers().map((slot) => slot.layer), ["stage"]);
	for (const args of ["", "status"]) {
		await h.mode(args);
		assert.deepEqual(h.notifications.at(-1), ["mode: stage: build · owner: controller-test", "info"], args);
	}
});

test("/mode exit <layer> clears a resumed pinned layer whose definition is gone", async () => {
	const first = harness();
	first.controller.start(first.ctx, "startup");
	const role = first.modes().defineMode(pinnedRole());
	assert.ok(role.status === "ok");
	assert.deepEqual(await role.handle.enter(), { status: "ok" });
	first.controller.agentStart();

	const resumed = harness(first.entries.slice());
	resumed.controller.start(resumed.ctx, "resume");
	resumed.controller.restore(resumed.ctx);
	assert.deepEqual(resumed.layers().map((slot) => [slot.layer, slot.id, slot.pinned, slot.available]), [["role", "overseer", true, false]]);
	await resumed.mode("exit");
	assert.deepEqual(resumed.notifications.at(-1), ["PINNED_LAYER: Only pinned modes are active.", "warning"], "bare exit still skips the pinned leftover");
	await resumed.mode("exit role");
	assert.deepEqual(resumed.notifications.at(-1), ["ok", "info"]);
	assert.deepEqual(resumed.layers(), []);
});
