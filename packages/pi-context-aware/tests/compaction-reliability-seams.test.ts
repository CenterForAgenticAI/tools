import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	classifyCompactionError,
	decideCompactionError,
	lookupReusableSummary,
	preflightCompaction,
	recordRetainedSummary,
	recordSummaryRetentionFailure,
} from "../compaction-outcome.js";
import {
	isCtxUsable,
	readToolsExpanded,
	sessionMetadataKey,
	withLiveCtx,
} from "../ctx-liveness.js";
import {
	isTransientFailure,
	resolveTransientRetryPolicy,
	runWithTransientRetryRecovery,
} from "../transient-retry.js";
import {
	ContextOverflowRecoveryExhaustedError,
	errorFromLlmResponse,
} from "../overflow-recovery.js";

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

test("transient retry seam resolves the documented default and retries with bounded backoff", async () => {
	const ctx = context();
	assert.deepEqual(resolveTransientRetryPolicy(ctx), {
		maxAttempts: 4,
		baseDelayMs: 2_000,
		source: "documented-default",
	});
	assert.equal(isTransientFailure(new Error("WebSocket error")), true);
	let calls = 0;
	const started = Date.now();
	const result = await runWithTransientRetryRecovery({
		operation: "test",
		primary: async () => {
			calls++;
			if (calls < 2) throw new Error("WebSocket error");
			return "ok";
		},
	}, { maxAttempts: 2, baseDelayMs: 5, source: "documented-default" });
	assert.equal(result, "ok");
	assert.equal(calls, 2);
	assert.ok(Date.now() - started >= 4, "the retry waits before its second attempt");
});

test("classifies a real failed assistant response with pi-ai and retries a fresh memoized stream", async () => {
	const failedResponse = {
		role: "assistant" as const,
		content: [],
		api: "test",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "error" as const,
		errorMessage: "WebSocket error",
		timestamp: 0,
	};
	let streamFactoryCalls = 0;
	const streamFactory = () => {
		streamFactoryCalls++;
		const response = streamFactoryCalls === 1
			? failedResponse
			: { ...failedResponse, stopReason: "stop" as const, errorMessage: undefined };
		let memoizedResult: Promise<typeof response> | undefined;
		return {
			// Real EventStream.result() returns this same promise on every call.
			result: () => memoizedResult ??= Promise.resolve(response),
		};
	};
	const result = await runWithTransientRetryRecovery({
		operation: "stream result",
		primary: async () => {
			// The compaction handler must do this at the stream-factory boundary;
			// this seam test only proves the retry wrapper's callback contract.
			const response = await streamFactory().result();
			const error = errorFromLlmResponse(response);
			if (error) throw error;
			return response.stopReason;
		},
	}, { maxAttempts: 2, baseDelayMs: 0, source: "documented-default" });
	assert.equal(result, "stop");
	assert.equal(streamFactoryCalls, 2);
});

test("does not retry deterministic provider errors", async () => {
	const deterministic = new Error("400: {\"message\":\"Reasoning is mandatory for this endpoint and cannot be disabled.\"...}");
	let calls = 0;
	await assert.rejects(
		runWithTransientRetryRecovery({
			operation: "deterministic failure",
			primary: async () => {
				calls++;
				throw deterministic;
			},
		}, { maxAttempts: 4, baseDelayMs: 0, source: "documented-default" }),
		error => error === deterministic,
	);
	assert.equal(calls, 1);
	assert.equal(isTransientFailure(deterministic), false);
});

test("aborts during transient backoff without starting another attempt", async () => {
	const controller = new AbortController();
	let calls = 0;
	const pending = runWithTransientRetryRecovery({
		operation: "aborted retry",
		signal: controller.signal,
		primary: async () => {
			calls++;
			throw new Error("WebSocket error");
		},
	}, { maxAttempts: 3, baseDelayMs: 50, source: "documented-default" });
	setTimeout(() => controller.abort(new Error("cancelled during backoff")), 5);
	await assert.rejects(pending, /cancelled during backoff/);
	assert.equal(calls, 1);
});

test("does not repeat an exhausted overflow recovery sequence", async () => {
	const calls: string[] = [];
	await assert.rejects(
		runWithTransientRetryRecovery({
			operation: "overflow guard",
			primary: async () => {
				calls.push("primary");
				throw new Error("context_length_exceeded: fetch failed");
			},
			reduced: async () => {
				calls.push("reduced");
				throw new Error("prompt is too long: fetch failed");
			},
			fallback: {
				model: "fallback/model",
				run: async () => {
					calls.push("fallback");
					throw new Error("context_length_exceeded: fetch failed");
				},
			},
		}, { maxAttempts: 4, baseDelayMs: 0, source: "documented-default" }),
		error => error instanceof ContextOverflowRecoveryExhaustedError && error.latestWasOverflow,
	);
	assert.deepEqual(calls, ["primary", "reduced", "fallback"]);
});

test("does not retry an AbortError when the signal has not flipped yet", async () => {
	let calls = 0;
	const controller = new AbortController();
	await assert.rejects(
		runWithTransientRetryRecovery({
			operation: "provider abort",
			signal: controller.signal,
			primary: async () => {
				calls++;
				throw new DOMException("The operation was aborted", "AbortError");
			},
		}, { maxAttempts: 4, baseDelayMs: 0, source: "documented-default" }),
		error => error instanceof DOMException && error.name === "AbortError",
	);
	assert.equal(calls, 1);
});

test("reports the final transient error and attempt count when exhausted", async () => {
	let calls = 0;
	await assert.rejects(
		runWithTransientRetryRecovery({
			operation: "Seed expansion",
			primary: async () => {
				calls++;
				throw new Error("fetch failed");
			},
		}, { maxAttempts: 3, baseDelayMs: 0, source: "documented-default" }),
		error => {
			assert.match(error instanceof Error ? error.message : String(error), /fetch failed \(after 3 attempts\)/);
			return true;
		},
	);
	assert.equal(calls, 3);
});

test("transient retry seam reads host-visible Pi retry settings when available", () => {
	const ctx = context({ settingsManager: { getRetrySettings: () => ({ maxRetries: 2, baseDelayMs: 125 }) } });
	assert.deepEqual(resolveTransientRetryPolicy(ctx), {
		maxAttempts: 3,
		baseDelayMs: 125,
		source: "pi-settings",
	});
});

test("context liveness seam preserves live metadata and expanded-state behavior", () => {
	const ctx = context();
	assert.equal(isCtxUsable(ctx), true);
	assert.equal(sessionMetadataKey(ctx), "session-1");
	assert.equal(readToolsExpanded(ctx), true);
	assert.equal(withLiveCtx(ctx, "test", () => "value"), "value");
	assert.equal(sessionMetadataKey(undefined, "last-known"), "last-known");
	const stale = context({ isIdle: () => { throw new Error("stale"); } });
	assert.equal(isCtxUsable(stale), false);
	assert.equal(readToolsExpanded(context({ ui: {} })), false);
});

test("compaction outcome seam preserves both existing error branches", () => {
	const already = classifyCompactionError(new Error("Already compacted"));
	const other = classifyCompactionError(new Error("provider failed"));
	assert.equal(already.kind, "already-compacted");
	assert.equal(other.kind, "other");
	const alreadyDecision = decideCompactionError(already);
	assert.equal(alreadyDecision.injectRecoveryFollowUp, false);
	assert.equal(alreadyDecision.notification, null);
	assert.match(alreadyDecision.debugNote ?? "", /suppressing notification and recovery follow-up/);
	const otherDecision = decideCompactionError(other);
	assert.equal(otherDecision.injectRecoveryFollowUp, true);
	assert.equal(otherDecision.recoveryFollowUp?.("seed"), "(Compaction failed: provider failed. Continuing with original context.)\n\nseed");
	assert.equal(preflightCompaction({ ctx: context(), seed: "seed" }).kind, "proceed");
});

test("compaction outcome no-op hooks are callable", () => {
	const ctx = context();
	assert.equal(lookupReusableSummary({ ctx, preparation: {}, event: {} }), null);
	recordRetainedSummary({ ctx, summary: "summary", preparation: {} });
	recordSummaryRetentionFailure({ ctx, reason: "test" });
});

test("compaction caller honours cancellation without recording proactive failure", async () => {
	const extension = await import("../index.js");
	const handlers = new Map<string, (event: Record<string, unknown>, ctx: ExtensionContext) => unknown>();
	const tools = new Map<string, unknown>();
	const commands = new Map<string, unknown>();
	const api = {
		events: { emit: () => {}, on: () => () => {} },
		registerFlag: () => {},
		getFlag: () => undefined,
		on: (name: string, handler: (event: Record<string, unknown>, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
		registerCommand: (name: string, definition: unknown) => commands.set(name, definition),
		sendMessage: () => {},
		sendUserMessage: () => {},
		getActiveTools: () => [],
		setActiveTools: () => {},
	} as unknown as ExtensionAPI;
	extension.default(api);

	let idle = false;
	const compactions: Array<{ onError?: (error: Error) => void }> = [];
	const notifications: string[] = [];
	const ctx = {
		hasUI: true,
		cwd: "/workspace/project",
		model: { contextWindow: 200_000 },
		getContextUsage: () => ({ tokens: 128_000 }),
		isProjectTrusted: () => true,
		isIdle: () => idle,
		compact: (options: { onError?: (error: Error) => void }) => compactions.push(options),
		ui: {
			notify: (message: string) => notifications.push(message),
			setWorkingMessage: () => {},
			setWorkingVisible: () => {},
			setWorkingIndicator: () => {},
			setStatus: () => {},
			setWidget: () => {},
		},
		sessionManager: {
			getEntries: () => [],
			getBranch: () => [],
			getSessionDir: () => "/workspace/project",
			getSessionFile: () => "/workspace/project/session.jsonl",
			getSessionId: () => "caller-cancellation-session",
			getHeader: () => ({ parentSession: undefined }),
			getLeafId: () => "leaf-1",
		},
	} as unknown as ExtensionContext;

	const compactTool = tools.get("compact_session") as {
		execute: (
			toolCallId: string,
			params: { seed_prompt: string; rewrite_seed: boolean },
			signal: AbortSignal,
			onUpdate: undefined,
			ctx: ExtensionContext,
		) => Promise<{ terminate?: boolean }>;
	};
	const queued = await compactTool.execute(
		"caller-cancellation",
		{ seed_prompt: "Continue after cancellation", rewrite_seed: false },
		new AbortController().signal,
		undefined,
		ctx,
	);
	assert.equal(queued.terminate, true);
	idle = true;
	await handlers.get("agent_settled")?.({}, ctx);
	assert.equal(compactions.length, 1);

	compactions[0]?.onError?.(new Error("Compaction cancelled"));
	await new Promise<void>((resolve) => setImmediate(resolve));
	const cancellationNotice = notifications.at(-1) ?? "";
	assert.match(cancellationNotice, /cause not determined.*session replacement\/reload or user interrupt/);
	const contextStatus = commands.get("context-status") as {
		handler: (args: string, commandContext: ExtensionContext) => Promise<void>;
	};
	await contextStatus.handler("", ctx);
	const status = notifications.at(-1) ?? "";
	assert.match(status, /Proactive lifecycle: cancelled/);
	assert.doesNotMatch(status, /failed|cooldown|until/);
});
