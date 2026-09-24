import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_POLICY_ENTRY_TYPE, configPolicyEntry } from "../config-layers.js";

type Handler = (args: string, ctx: ExtensionContext) => void | Promise<void>;

function fakePi() {
	const commands = new Map<string, { handler: Handler }>();
	const events = new Map<string, Array<(event: Record<string, unknown>, ctx: ExtensionContext) => unknown>>();
	const userMessages: unknown[] = [];
	const notifications: string[] = [];
	const api = {
		events: { on() { return () => {}; }, emit() {} },
		registerFlag() {},
		getFlag() { return undefined; },
		on(name: string, handler: (event: Record<string, unknown>, ctx: ExtensionContext) => unknown) {
			const existing = events.get(name) ?? [];
			existing.push(handler);
			events.set(name, existing);
		},
		registerTool() {},
		registerCommand(name: string, definition: { handler: Handler }) { commands.set(name, definition); },
		sendMessage() {},
		sendUserMessage(message: unknown) { userMessages.push(message); },
		getActiveTools() { return []; },
		setActiveTools() {},
		appendEntry() {},
	} as unknown as ExtensionAPI;
	return { api, commands, events, userMessages, notifications };
}

function context(home: string, sessionId: string, idle: { value: boolean }, entries: unknown[] = []): ExtensionContext {
	return {
		hasUI: true,
		cwd: home,
		model: { contextWindow: 200_000 },
		getContextUsage: () => ({ tokens: 128_000 }),
		isIdle: () => idle.value,
		ui: { notify: (message: string) => notificationsForContext.push(message) },
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => entries,
			getSessionDir: () => home,
			getSessionFile: () => path.join(home, `${sessionId}.jsonl`),
			getSessionId: () => sessionId,
			getHeader: () => ({ parentSession: undefined }),
			getLeafId: () => `${sessionId}-leaf`,
		},
	} as unknown as ExtensionContext;
}

let notificationsForContext: string[] = [];

test("check-in acknowledges synchronously and replaces an earlier queued request", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "checkin-command-"));
	const harness = fakePi();
	const extension = await import("../index.js");
	extension.default(harness.api);
	const idle = { value: false };
	const entries: unknown[] = [];
	notificationsForContext = harness.notifications;
	const ctx = context(home, "checkin-foreground", idle, entries);
	const command = harness.commands.get("checkin");
	assert.ok(command, "expected /checkin registration");

	const firstRequest = command.handler("", ctx);
	assert.match(harness.notifications.at(-1) ?? "", /queued.*current turn settles/u);
	await firstRequest;
	await command.handler("", ctx);
	assert.equal(harness.userMessages.length, 0, "active turns must not receive the check-in");

	idle.value = true;
	await harness.events.get("agent_settled")?.[0]?.({}, ctx);
	assert.equal(harness.userMessages.length, 1, "repeated requests must replace, not stack");
	assert.match(String(harness.userMessages[0]), /No durable focus or task list exists.*still report progress/isu);
	assert.equal(entries.length, 0, "check-in must not mutate focus or tasks");
});

test("check-in is not delivered when its authority marker cannot be persisted", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "checkin-marker-failure-"));
	const harness = fakePi();
	(harness.api as unknown as { appendEntry: () => void }).appendEntry = () => { throw new Error("marker unavailable"); };
	const extension = await import("../index.js");
	extension.default(harness.api);
	notificationsForContext = harness.notifications;
	const ctx = context(home, "checkin-marker-failure", { value: true });
	await harness.commands.get("checkin")?.handler("", ctx);
	assert.equal(harness.userMessages.length, 0, "generated check-in text must not be sent as an unmarked user message");
});

test("worker sessions refuse to self-report", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "checkin-worker-"));
	const harness = fakePi();
	const extension = await import("../index.js");
	extension.default(harness.api);
	const entries = [{
		type: "custom",
		customType: CONFIG_POLICY_ENTRY_TYPE,
		data: configPolicyEntry("host", { sessionRole: "worker" }, { declaredBy: "test-worker" }),
	}];
	notificationsForContext = harness.notifications;
	const ctx = context(home, "checkin-worker", { value: true }, entries);
	await harness.commands.get("checkin")?.handler("", ctx);
	assert.equal(harness.userMessages.length, 0);
	assert.match(harness.notifications.at(-1) ?? "", /Workers do not self-report/u);
});
