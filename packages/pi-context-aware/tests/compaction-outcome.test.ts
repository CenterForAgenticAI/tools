import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	classifyCompactionError,
	decideCompactionError,
	decideOwedCompactionReattempt,
	lookupReusableSummary,
	lookupReusableSummaryWithBoundary,
	preflightCompaction,
	recordRetainedSummary,
	recordSummaryRetentionFailure,
} from "../compaction-outcome.js";

function contextWithManager(sessionManager: unknown): ExtensionContext {
	return {
		cwd: "/workspace/project",
		isIdle: () => true,
		sessionManager,
		ui: {},
	} as unknown as ExtensionContext;
}

function context(branch: readonly unknown[] = [{ id: "entry-1", type: "message" }]): ExtensionContext {
	return contextWithManager({
		getSessionId: () => "session-1",
		getSessionFile: () => "/sessions/session-1.jsonl",
		getBranch: () => branch,
	});
}

const preparation = { firstKeptEntryId: "entry-1" };

test("classifies cancellation, transient transport, and both normal no-work outcomes", () => {
	assert.equal(classifyCompactionError(new Error("Compaction cancelled")).kind, "cancelled");
	const abortError = new Error("The compaction request was aborted");
	abortError.name = "AbortError";
	assert.equal(classifyCompactionError(abortError).kind, "cancelled");
	assert.equal(classifyCompactionError(new Error("Nothing to compact (session too small)")).kind, "nothing-to-compact");
	assert.equal(classifyCompactionError(new Error("Already compacted")).kind, "already-compacted");
	assert.equal(classifyCompactionError(new Error("WebSocket error")).kind, "transient");
	assert.equal(classifyCompactionError(new Error("provider failed")).kind, "other");
	assert.equal(classifyCompactionError("string failure").message, "string failure");
});

test("cancellation is reported without a failure lifecycle or recovery follow-up", () => {
	const decision = decideCompactionError(classifyCompactionError(new Error("Compaction cancelled")));
	assert.equal(decision.proactiveLifecycle, "cancelled");
	assert.equal(decision.injectRecoveryFollowUp, false);
	assert.equal(decision.notification?.level, "info");
	assert.match(decision.notification?.message ?? "", /cause not determined/);
	assert.match(decision.notification?.message ?? "", /session replacement|user interrupt/);
	assert.match(decision.debugNote ?? "", /cancelled/);
});

test("Already compacted and too-small outcomes consistently stay normal", () => {
	for (const message of ["Already compacted", "Nothing to compact (session too small)"]) {
		const decision = decideCompactionError(classifyCompactionError(new Error(message)));
		assert.equal(decision.notification, null);
		assert.equal(decision.injectRecoveryFollowUp, false);
		assert.equal(decision.proactiveLifecycle, "none");
	}
});

test("exhausted transient failures fail closed while retaining readable recovery", () => {
	const decision = decideCompactionError(classifyCompactionError(new Error("WebSocket error (after 3 attempts)")));
	assert.equal(decision.failClosed, true);
	assert.equal(decision.notification?.level, "error");
	assert.match(decision.recoveryFollowUp?.("seed") ?? "", /WebSocket error/);
});

test("genuine failures retain the existing error recovery policy", () => {
	const decision = decideCompactionError(classifyCompactionError(new Error("provider failed")));
	assert.equal(decision.notification?.level, "error");
	assert.equal(decision.proactiveLifecycle, "failed");
	assert.equal(decision.injectRecoveryFollowUp, true);
	assert.equal(decision.failClosed, false);
	assert.equal(
		decision.recoveryFollowUp?.("seed"),
		"(Compaction failed: provider failed. Continuing with original context.)\n\nseed",
	);
});

test("preflight stays conservative because Pi's size predicate is unavailable before preparation", () => {
	assert.deepEqual(preflightCompaction({ ctx: context(), seed: "seed" }), { kind: "proceed" });
});

test("a retained summary is reused on the same branch without another summarization call", () => {
	const ctx = context();
	let summarizationCalls = 0;
	const summarize = () => {
		summarizationCalls++;
		return "summary from first attempt";
	};

	const firstSummary = summarize();
	recordRetainedSummary({ ctx, summary: firstSummary, preparation });
	const reused = lookupReusableSummary({ ctx, preparation, event: {} });
	assert.equal(reused, firstSummary);
	assert.equal(summarizationCalls, 1, "the second attempt must not call the summarizer");
});

test("retained summary exposes its original boundary and is consumed once", () => {
	const ctx = context();
	const summaryPreparation = { ...preparation, tokensBefore: 1234 };
	recordRetainedSummary({ ctx, summary: "boundary-aware summary", preparation: summaryPreparation });
	assert.deepEqual(
		lookupReusableSummaryWithBoundary({ ctx, preparation: summaryPreparation, event: {} }),
		{ summary: "boundary-aware summary", firstKeptEntryId: "entry-1", tokensBefore: 1234 },
	);
	assert.equal(
		lookupReusableSummaryWithBoundary({ ctx, preparation: summaryPreparation, event: {} }),
		null,
		"a retained summary must not be reused by an unrelated later compaction",
	);
});

test("retained summary crosses event context wrappers but never crosses sessions", () => {
	const firstWrapper = context();
	const secondWrapper = contextWithManager(firstWrapper.sessionManager);
	recordRetainedSummary({ ctx: firstWrapper, summary: "wrapper-stable summary", preparation });
	assert.equal(
		lookupReusableSummary({ ctx: secondWrapper, preparation, event: {} }),
		"wrapper-stable summary",
		"fresh Pi event wrappers for one session must share retained summaries",
	);

	const otherSession = contextWithManager({
		getSessionId: () => "session-2",
		getSessionFile: () => "/sessions/session-2.jsonl",
		getBranch: () => [{ id: "entry-1", type: "message" }],
	});
	recordRetainedSummary({ ctx: firstWrapper, summary: "session-1 summary", preparation });
	assert.equal(lookupReusableSummary({ ctx: otherSession, preparation, event: {} }), null, "a different session cannot reuse the summary");
	assert.equal(lookupReusableSummary({ ctx: firstWrapper, preparation, event: {} }), "session-1 summary", "the original session retains its own summary");
});

test("a retained summary survives a tail append when its summarized prefix is unchanged", () => {
	const branch: unknown[] = [{ id: "entry-1", type: "message" }];
	const ctx = context(branch);
	recordRetainedSummary({ ctx, summary: "summary", preparation });
	branch.push({ id: "tail-1", type: "message" });
	assert.equal(lookupReusableSummary({ ctx, preparation, event: {} }), "summary");
});

test("an invalid retry boundary does not discard another session's retained summary", () => {
	const firstSession = context();
	const secondBranch: unknown[] = [{ id: "entry-1", type: "message" }];
	const secondSession = contextWithManager({
		getSessionId: () => "session-2",
		getSessionFile: () => "/sessions/session-2.jsonl",
		getBranch: () => secondBranch,
	});
	recordRetainedSummary({ ctx: firstSession, summary: "session-1 summary", preparation });
	recordRetainedSummary({ ctx: secondSession, summary: "session-2 summary", preparation });

	const firstManager = firstSession.sessionManager as unknown as { getBranch: () => unknown };
	firstManager.getBranch = () => "not-a-branch";
	assert.equal(lookupReusableSummary({ ctx: firstSession, preparation, event: {} }), null);
	assert.equal(
		lookupReusableSummary({ ctx: secondSession, preparation, event: {} }),
		"session-2 summary",
		"an unusable retry in one session must not clear another session's retained summary",
	);
});

test("a changed branch refuses reuse and records the reason", () => {
	const branch: unknown[] = [
		{ id: "prefix-1", type: "message" },
		{ id: "entry-1", type: "message" },
	];
	const ctx = context(branch);
	const warnings: string[] = [];
	const originalDebug = console.debug;
	console.debug = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
	try {
		recordRetainedSummary({ ctx, summary: "summary", preparation });
		branch[0] = { id: "prefix-2", type: "message" };
		assert.equal(lookupReusableSummary({ ctx, preparation, event: {} }), null);
		assert.match(warnings.at(-1) ?? "", /different session branch/);
	} finally {
		console.debug = originalDebug;
	}
});

test("a disposed session cannot retain or reuse a summary", () => {
	const ctx = context();
	const warnings: string[] = [];
	const originalDebug = console.debug;
	console.debug = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
	try {
		recordRetainedSummary({ ctx, summary: "summary", preparation });
		(ctx.isIdle as () => boolean) = () => { throw new Error("disposed"); };
		assert.equal(lookupReusableSummary({ ctx, preparation, event: {} }), null);
		assert.match(warnings.at(-1) ?? "", /disposed/);
		recordSummaryRetentionFailure({ ctx, reason: "explicit discard" });
		assert.match(warnings.at(-1) ?? "", /explicit discard/);
	} finally {
		console.debug = originalDebug;
	}
});

function withDebugCapture(run: (messages: string[]) => void): void {
	const messages: string[] = [];
	const originalDebug = console.debug;
	console.debug = (...args: unknown[]) => messages.push(args.map(String).join(" "));
	try {
		run(messages);
	} finally {
		console.debug = originalDebug;
	}
}

test("invalid preparation and branch shapes refuse reuse with diagnostic reasons", () => {
	withDebugCapture((messages) => {
		const invalidPreparation = context();
		recordRetainedSummary({ ctx: invalidPreparation, summary: "summary", preparation });
		assert.equal(lookupReusableSummary({ ctx: invalidPreparation, preparation: null, event: {} }), null);
		assert.match(messages.at(-1) ?? "", /stable branch identity/);

		const invalidEntry: unknown[] = [{ id: "entry-1", type: "message" }];
		const invalidEntryContext = context(invalidEntry);
		recordRetainedSummary({ ctx: invalidEntryContext, summary: "summary", preparation });
		invalidEntry[0] = "not-an-entry";
		assert.equal(lookupReusableSummary({ ctx: invalidEntryContext, preparation, event: {} }), null);
		assert.match(messages.at(-1) ?? "", /stable branch identity/);

		const invalidArrayContext = context();
		recordRetainedSummary({ ctx: invalidArrayContext, summary: "summary", preparation });
		const invalidArrayManager = invalidArrayContext.sessionManager as unknown as { getBranch: () => unknown };
		invalidArrayManager.getBranch = () => "not-an-array";
		assert.equal(lookupReusableSummary({ ctx: invalidArrayContext, preparation, event: {} }), null);
		assert.match(messages.at(-1) ?? "", /stable branch identity/);

		const unstableEntry: unknown[] = [{}];
		const unstableContext = context(unstableEntry);
		recordRetainedSummary({ ctx: unstableContext, summary: "summary", preparation });
		assert.equal(lookupReusableSummary({ ctx: unstableContext, preparation, event: {} }), null);
		assert.match(messages.at(-1) ?? "", /stable branch identity/);
	});
});

test("entryId branches are accepted, while missing branch identity sources refuse reuse", () => {
	const entryIdContext = context([{ entryId: "entry-1", type: "message" }]);
	recordRetainedSummary({ ctx: entryIdContext, summary: "entry-id summary", preparation });
	assert.equal(lookupReusableSummary({ ctx: entryIdContext, preparation, event: {} }), "entry-id summary");

	const missingTypeContext = context([{ id: "entry-1" }]);
	recordRetainedSummary({ ctx: missingTypeContext, summary: "missing-type summary", preparation });
	assert.equal(lookupReusableSummary({ ctx: missingTypeContext, preparation, event: {} }), "missing-type summary");

	const missingIdContext = context([{}]);
	withDebugCapture((messages) => {
		recordRetainedSummary({ ctx: missingIdContext, summary: "summary", preparation });
		assert.equal(lookupReusableSummary({ ctx: missingIdContext, preparation, event: {} }), null);
		assert.match(messages.at(-1) ?? "", /stable branch identity/);
	});

	const fullManagerContext = context();
	recordRetainedSummary({ ctx: fullManagerContext, summary: "summary", preparation });
	fullManagerContext.sessionManager = {
		getBranch: () => [{ id: "entry-1", type: "message" }],
	} as ExtensionContext["sessionManager"];
	assert.equal(lookupReusableSummary({ ctx: fullManagerContext, preparation, event: {} }), null);

	const missingBranchContext = contextWithManager({
		getSessionId: () => "session-1",
		getSessionFile: () => "/sessions/session-1.jsonl",
	});
	withDebugCapture((messages) => {
		recordRetainedSummary({ ctx: missingBranchContext, summary: "summary", preparation });
		assert.equal(lookupReusableSummary({ ctx: missingBranchContext, preparation, event: {} }), null);
		assert.match(messages.at(-1) ?? "", /stable branch identity/);
	});
});

test("missing optional session methods and throwing branch access refuse reuse without propagating", () => {
	const contextWithMissingMethods = context();
	recordRetainedSummary({ ctx: contextWithMissingMethods, summary: "summary", preparation });
	contextWithMissingMethods.sessionManager = {
		getBranch: () => [{ id: "entry-1", type: "message" }],
	} as ExtensionContext["sessionManager"];
	assert.equal(lookupReusableSummary({ ctx: contextWithMissingMethods, preparation, event: {} }), null);

	const throwingContext = context();
	recordRetainedSummary({ ctx: throwingContext, summary: "summary", preparation });
	(throwingContext.sessionManager as unknown as { getBranch: () => unknown }).getBranch = () => {
		throw new Error("branch unavailable");
	};
	assert.doesNotThrow(() => {
		assert.equal(lookupReusableSummary({ ctx: throwingContext, preparation, event: {} }), null);
	});
});

test("recording disposed, empty, or identity-less summaries stores nothing", () => {
	const disposed = context();
	(disposed.isIdle as () => boolean) = () => { throw new Error("disposed"); };
	recordRetainedSummary({ ctx: disposed, summary: "summary", preparation });
	(disposed.isIdle as () => boolean) = () => true;
	assert.equal(lookupReusableSummary({ ctx: disposed, preparation, event: {} }), null);

	const empty = context();
	recordRetainedSummary({ ctx: empty, summary: "   ", preparation });
	assert.equal(lookupReusableSummary({ ctx: empty, preparation, event: {} }), null);

	const identityLess = context();
	recordRetainedSummary({ ctx: identityLess, summary: "summary", preparation: {} });
	assert.equal(lookupReusableSummary({ ctx: identityLess, preparation, event: {} }), null);
});

test("retention diagnostics preserve Error and non-Error reasons", () => {
	withDebugCapture((messages) => {
		const ctx = context();
		recordSummaryRetentionFailure({ ctx, reason: new Error("error reason") });
		assert.match(messages.at(-1) ?? "", /error reason/);
		recordSummaryRetentionFailure({ ctx, reason: "string reason" });
		assert.match(messages.at(-1) ?? "", /string reason/);
	});
});

test("decideOwedCompactionReattempt: no owed marker is always a no-op", () => {
	assert.equal(
		decideOwedCompactionReattempt({ owedByRefusal: false, refusalCooldownStillCurrent: true, contextStillOverThreshold: true, withinCooldown: true }),
		"none",
	);
	assert.equal(
		decideOwedCompactionReattempt({ owedByRefusal: false, refusalCooldownStillCurrent: false, contextStillOverThreshold: false, withinCooldown: false }),
		"none",
	);
});

test("decideOwedCompactionReattempt: owed, refusal cooldown still current, below threshold drops the marker", () => {
	assert.equal(
		decideOwedCompactionReattempt({ owedByRefusal: true, refusalCooldownStillCurrent: true, contextStillOverThreshold: false, withinCooldown: true }),
		"clear-owed",
		"a session that recovered on its own no longer owes a compaction",
	);
});

test("decideOwedCompactionReattempt: owed and over threshold clears only its own still-blocking cooldown", () => {
	assert.equal(
		decideOwedCompactionReattempt({ owedByRefusal: true, refusalCooldownStillCurrent: true, contextStillOverThreshold: true, withinCooldown: true }),
		"clear-cooldown",
		"the refusal's own success-spacing cooldown is what delays the still-needed compaction",
	);
});

test("decideOwedCompactionReattempt: an expired refusal cooldown drops the marker instead of acting", () => {
	assert.equal(
		decideOwedCompactionReattempt({ owedByRefusal: true, refusalCooldownStillCurrent: true, contextStillOverThreshold: true, withinCooldown: false }),
		"clear-owed",
		"once the refusal cooldown has lapsed the ordinary threshold path re-triggers; the marker must not linger (#101 CR-OWED-MARKER-STALE)",
	);
});

test("decideOwedCompactionReattempt: a genuine-failure cooldown that replaced the refusal cooldown is never cleared", () => {
	// A different cooldown is now in effect (a real provider/transport failure set
	// it), so the stale refusal marker must be dropped without touching it.
	assert.equal(
		decideOwedCompactionReattempt({ owedByRefusal: true, refusalCooldownStillCurrent: false, contextStillOverThreshold: true, withinCooldown: true }),
		"clear-owed",
		"a genuine failure keeps its cooldown; the stale refusal marker is dropped (#101 CR-OWED-MARKER-STALE)",
	);
	assert.equal(
		decideOwedCompactionReattempt({ owedByRefusal: true, refusalCooldownStillCurrent: false, contextStillOverThreshold: false, withinCooldown: false }),
		"clear-owed",
	);
});
