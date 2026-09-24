import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	readToolsExpanded,
	sessionMetadataKey,
	withLiveCtx,
} from "../ctx-liveness.js";

function context(overrides: Record<string, unknown> = {}): ExtensionContext {
	return {
		cwd: "/workspace/project",
		isIdle: () => true,
		sessionManager: {
			getSessionId: () => "session-1",
			getSessionFile: () => "/sessions/session-1.jsonl",
		},
		ui: { getToolsExpanded: () => true },
		...overrides,
	} as unknown as ExtensionContext;
}

test("context liveness remembers only a context's own key after disposal", () => {
	let disposed = false;
	const captured = context({ isIdle: () => {
		if (disposed) throw new Error("This extension ctx is stale after session replacement or reload.");
		return true;
	} });
	assert.equal(sessionMetadataKey(captured), "session-1");
	disposed = true;
	assert.equal(sessionMetadataKey(captured), "session-1");
	assert.equal(readToolsExpanded(captured), false);
	assert.equal(withLiveCtx(captured, "disposed callback", () => "unreachable"), undefined);

	const neverResolved = context({ isIdle: () => { throw new Error("This extension ctx is stale after session replacement or reload."); } });
	assert.equal(sessionMetadataKey(neverResolved), "", "unknown disposal must not guess another session key");
	assert.equal(sessionMetadataKey(undefined, "last-known"), "last-known");
});

test("context liveness leaves unexpected callback and UI errors visible", () => {
	const callbackError = new Error("real callback bug");
	assert.throws(() => withLiveCtx(context(), "real callback", () => { throw callbackError; }), callbackError);
	const brokenUi = Object.defineProperty(context(), "ui", {
		get: () => { throw new Error("real UI getter bug"); },
	});
	assert.throws(() => readToolsExpanded(brokenUi), /real UI getter bug/u);
});
