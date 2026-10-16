import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	CONTEXT_AWARE_POLICY_CHANGED_EVENT,
	buildContextAwareSnapshotV1,
	type ContextAwarePolicyChangedEventV1,
	type ContextAwareSnapshotSourceV1,
} from "../src/context-service.js";
import {
	CONFIG_POLICY_ENTRY_TYPE,
	configPolicyEntry,
	readConfigLayer,
	readPolicyEntryLayers,
	resolveConfigLayers,
} from "../src/platform/config-layers.js";
import { buildContextTelemetry, contextBand } from "../src/platform/context-telemetry.js";
import {
	DEFAULT_PRESSURE_LADDER,
	createContextPolicyController,
	formatContextPolicyStatus,
	parseContextPolicyCommandArgument,
	parseContextPolicyValue,
	resolveContextPolicy,
} from "../src/policy/context-policy.js";

function policyEntry(layer: "session" | "host", values: Record<string, unknown>): unknown {
	return { type: "custom", customType: CONFIG_POLICY_ENTRY_TYPE, data: configPolicyEntry(layer, values) };
}

function policyOf(entries: readonly unknown[]) {
	return resolveContextPolicy(resolveConfigLayers(readPolicyEntryLayers(entries)));
}

// --- validation -------------------------------------------------------------

test("summaries is the only accepted context policy value", () => {
	assert.equal(parseContextPolicyValue("summaries"), "summaries");
	for (const value of ["recent", "trim-tool-output", "Summaries", " summaries", "", null, undefined, 1, {}]) {
		assert.equal(parseContextPolicyValue(value), undefined, JSON.stringify(value));
	}
});

test("an unsupported value in a config file is ignored and the policy keeps its lower-layer value", () => {
	const resolved = resolveConfigLayers([
		readConfigLayer({ contextPolicy: "summaries" }, "global", "/global.json"),
		readConfigLayer({ contextPolicy: "recent" }, "project", "/project.json"),
	]);
	const policy = resolveContextPolicy(resolved);

	assert.equal(resolved.config.contextPolicy, "summaries");
	assert.equal(policy.value, "summaries");
	assert.equal(policy.source, "global", "the rejected project value must not become the winning layer");
	assert.deepEqual(resolved.rejected, [{ layer: "project", path: "contextPolicy" }]);
	assert.match(policy.diagnostic ?? "", /Ignored an unsupported contextPolicy in the project layer; supported values: summaries\./u);
});

test("an unsupported value in a session entry is ignored and the branch keeps its earlier value", () => {
	const policy = policyOf([
		policyEntry("session", { contextPolicy: "summaries" }),
		policyEntry("session", { contextPolicy: "recent" }),
	]);
	assert.equal(policy.value, "summaries");
	assert.equal(policy.source, "session");
	assert.match(policy.diagnostic ?? "", /unsupported contextPolicy in the session layer/u);

	const hostOnly = policyOf([policyEntry("host", { contextPolicy: "trim-tool-output" })]);
	assert.equal(hostOnly.value, "summaries");
	assert.equal(hostOnly.source, "default");
	assert.match(hostOnly.diagnostic ?? "", /unsupported contextPolicy in the host policy layer/u);
});

test("/context-policy parses status and summaries and refuses anything else with a clear error", () => {
	assert.deepEqual(parseContextPolicyCommandArgument(""), { kind: "status" });
	assert.deepEqual(parseContextPolicyCommandArgument(" status "), { kind: "status" });
	assert.deepEqual(parseContextPolicyCommandArgument("summaries"), { kind: "set", value: "summaries" });
	assert.deepEqual(parseContextPolicyCommandArgument("recent"), {
		kind: "invalid",
		message: "Unsupported context policy \"recent\". Supported values: summaries. The policy is unchanged.",
	});
});

test("the /context-policy command records nothing and announces nothing for an unsupported value", async () => {
	const entries: unknown[] = [];
	const notices: Array<{ message: string; level: string | undefined }> = [];
	const events: ContextAwarePolicyChangedEventV1[] = [];
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const pi = {
		registerCommand(name: string, definition: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
			commands.set(name, definition);
		},
		events: {
			emit(channel: string, data: unknown) {
				if (channel === CONTEXT_AWARE_POLICY_CHANGED_EVENT) events.push(data as ContextAwarePolicyChangedEventV1);
			},
			on: () => () => {},
		},
	} as unknown as Parameters<typeof createContextPolicyController>[0];
	const ctx = {
		sessionManager: { getSessionId: () => "session-1" },
		ui: { notify: (message: string, level?: string) => notices.push({ message, level }) },
	} as unknown as ExtensionContext;
	const controller = createContextPolicyController(pi, {
		resolve: () => resolveConfigLayers(readPolicyEntryLayers(entries)),
		appendSessionOverride: (_ctx, values) => entries.push(policyEntry("session", values)),
	});
	controller.register();
	controller.start(ctx);
	const command = commands.get("context-policy");
	assert.ok(command);

	await command.handler("recent", ctx);
	assert.equal(entries.length, 0, "an unsupported value must not be recorded");
	assert.equal(events.length, 0);
	assert.deepEqual(notices.at(-1), {
		message: "Unsupported context policy \"recent\". Supported values: summaries. The policy is unchanged.",
		level: "error",
	});
	assert.equal(controller.current(ctx).source, "default");

	await command.handler("summaries", ctx);
	assert.equal(entries.length, 1);
	assert.equal(controller.current(ctx).source, "session");
	assert.equal(events.length, 1);
	assert.equal(events[0]?.reason, "command");
	assert.equal(events[0]?.previous?.source, "default");
	assert.equal(events[0]?.current.source, "session");

	await command.handler("summaries", ctx);
	assert.equal(events.length, 1, "recording the same policy again is not a change");

	await command.handler("status", ctx);
	assert.match(notices.at(-1)?.message ?? "", /^Context policy: summaries \(source: session\)$/mu);
});

test("/context-policy status shows effective first-user settings and their independent sources", async () => {
	let handler: (args: string, ctx: ExtensionContext) => Promise<void> = async () => {};
	let notice = "";
	const pi = { registerCommand(_name: string, definition: { handler: typeof handler }) { handler = definition.handler; } } as unknown as Parameters<typeof createContextPolicyController>[0];
	createContextPolicyController(pi, {
		resolve: () => resolveConfigLayers([
			readConfigLayer({ folds: { firstUserMessage: "keep-under-tokens" } }, "project"),
			...readPolicyEntryLayers([policyEntry("session", { "folds.firstUserMessageMaxTokens": 400 })]),
		]),
		appendSessionOverride: () => {},
	}).register();
	await handler("status", { ui: { notify(message: string) { notice = message; } } } as unknown as ExtensionContext);
	assert.match(notice, /folds.firstUserMessage: keep-under-tokens \(source: project\)/u);
	assert.match(notice, /folds.firstUserMessageMaxTokens: 400 \(source: session\)/u);
});

// --- pressure ladder --------------------------------------------------------

test("the default ladder starts WARN at the first fold nudge and URGENT at seeded compaction", () => {
	const policy = resolveContextPolicy(resolveConfigLayers([]));
	assert.deepEqual(policy.ladder, {
		foldNudgeStartFraction: 0.45,
		foldNudgeEndFraction: 0.75,
		seededCompactionFraction: 0.9,
		recoverableHideFraction: 0.95,
	});
	assert.deepEqual(policy.bands, { warnFraction: 0.45, urgentFraction: 0.9 });

	assert.equal(contextBand(0.449), "OK");
	assert.equal(contextBand(0.45), "WARN");
	assert.equal(contextBand(0.85), "WARN", "85% sits between the last fold nudge and compaction");
	assert.equal(contextBand(0.9), "URGENT");
	assert.match(buildContextTelemetry({ fraction: 0.5, headroom: 100_000 }), /band="WARN"[^>]*action="gate-broad-work"/u);
	assert.match(buildContextTelemetry({ fraction: 0.85, headroom: 30_000 }), /band="WARN"/u);
});

test("a configured ladder moves the telemetry bands and reports each threshold's layer", () => {
	const policy = resolveContextPolicy(resolveConfigLayers([
		readConfigLayer({ pressureLadder: { foldNudgeStartFraction: 0.3, seededCompactionFraction: 0.8 } }, "project"),
	]));
	assert.deepEqual(policy.bands, { warnFraction: 0.3, urgentFraction: 0.8 });
	assert.equal(policy.ladderSources.foldNudgeStartFraction, "project");
	assert.equal(policy.ladderSources.foldNudgeEndFraction, "default");
	assert.equal(policy.ladderSources.seededCompactionFraction, "project");

	assert.match(buildContextTelemetry({ fraction: 0.35, headroom: 1_000 }, { bands: policy.bands }), /band="WARN"/u);
	assert.match(buildContextTelemetry({ fraction: 0.35, headroom: 1_000 }), /band="OK"/u);
	assert.match(buildContextTelemetry({ fraction: 0.82, headroom: 1_000 }, { bands: policy.bands }), /band="URGENT"[^>]*action="compact-before-tool"/u);
	assert.equal(contextBand(0.82, policy.bands), "URGENT");
});

test("a ladder value outside (0, 1] is ignored and a lower layer supplies it", () => {
	for (const invalid of [0, -0.1, 1.5, "0.5", Number.NaN]) {
		const resolved = resolveConfigLayers([
			readConfigLayer({ pressureLadder: { foldNudgeStartFraction: invalid } }, "project"),
		]);
		assert.equal(resolved.config.pressureLadder?.foldNudgeStartFraction, DEFAULT_PRESSURE_LADDER.foldNudgeStartFraction, String(invalid));
		assert.deepEqual(resolved.rejected, [{ layer: "project", path: "pressureLadder.foldNudgeStartFraction" }]);
	}
});

test("an out-of-order ladder falls back to the default ladder with a diagnostic", () => {
	const policy = resolveContextPolicy(resolveConfigLayers([
		readConfigLayer({ pressureLadder: { foldNudgeStartFraction: 0.8, foldNudgeEndFraction: 0.5 } }, "global"),
	]));
	assert.deepEqual(policy.ladder, DEFAULT_PRESSURE_LADDER);
	assert.deepEqual(policy.bands, { warnFraction: 0.45, urgentFraction: 0.9 });
	assert.equal(policy.ladderSources.foldNudgeStartFraction, "default");
	assert.match(policy.diagnostic ?? "", /pressureLadder values are out of order \(80%, 50%, 90%, 95%\); using the default ladder\./u);
	assert.match(formatContextPolicyStatus(policy), /^Diagnostic: pressureLadder values are out of order/mu);
});

test("the typed snapshot band follows the session's ladder", () => {
	const source: ContextAwareSnapshotSourceV1 = {
		pressure: { tokens: 170_000, contextWindow: 200_000 },
		session: { id: "session-1", cwd: "/work" },
		lineageSessionFiles: [],
		artifacts: [],
		compaction: { state: "idle" },
		effectiveMode: {
			seedMode: "auto-gen",
			seedRewrite: true,
			ambiguityMode: "inherit",
			effectiveAmbiguityMode: "cautious-proceed",
			compactionModel: null,
		},
	};
	assert.equal(buildContextAwareSnapshotV1(source).pressure.band, "WARN", "85% is WARN on the default ladder");
	const moved = buildContextAwareSnapshotV1({ ...source, pressureBands: { warnFraction: 0.5, urgentFraction: 0.8 } });
	assert.equal(moved.pressure.band, "URGENT");
	assert.equal(moved.pressure.phaseBoundary, "required");
});

test("status names the policy, every ladder step, the bands, and their sources", () => {
	assert.equal(
		formatContextPolicyStatus(resolveContextPolicy(resolveConfigLayers([]))),
		[
			"Context policy: summaries (source: default)",
			"Fold nudges: 45% to 75% (sources: default, default)",
			"Seeded compaction: 90% (source: default)",
			"Recoverable hide, only when compaction cannot run: 95% (source: default)",
			"Telemetry bands: WARN from 45%, URGENT from 90%",
		].join("\n"),
	);
});
