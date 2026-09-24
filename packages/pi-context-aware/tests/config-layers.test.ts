import test from "node:test";
import assert from "node:assert/strict";
import {
	CONFIG_LAYERS,
	CONFIG_POLICY_ENTRY_TYPE,
	DEFAULT_CONTEXT_CACHE_CONFIG,
	DEFAULT_PROACTIVE_COMPACTION_CONFIG,
	DEFAULT_SESSION_NAMING_CONFIG,
	configLayerFromValues,
	configPolicyEntry,
	formatLayerAttribution,
	isKnownConfigPath,
	normalizeProactiveThreshold,
	overriddenPaths,
	parseConfigPolicyEntry,
	readConfigLayer,
	readPolicyEntryLayers,
	resolveConfigLayers,
	type ConfigLayer,
	type ConfigLayerInput,
} from "../config-layers.js";

function policyEntry(layer: "session" | "host", values: Record<string, unknown>, declaredBy?: string): unknown {
	return {
		type: "custom",
		customType: CONFIG_POLICY_ENTRY_TYPE,
		data: configPolicyEntry(layer, values, declaredBy === undefined ? {} : { declaredBy }),
	};
}

function valueAt(inputs: readonly ConfigLayerInput[], path: string): unknown {
	return resolveConfigLayers(inputs).byPath.get(path)?.value;
}

function layerAt(inputs: readonly ConfigLayerInput[], path: string): ConfigLayer | undefined {
	return resolveConfigLayers(inputs).byPath.get(path)?.layer;
}

// --- precedence -------------------------------------------------------------

test("precedence runs defaults → global → project → CLI → session → host policy", () => {
	assert.deepEqual([...CONFIG_LAYERS], ["default", "global", "project", "cli", "session", "host"]);
});

test("an empty stack resolves entirely from built-in defaults", () => {
	const resolved = resolveConfigLayers([]);
	assert.equal(resolved.config.seedMode, "auto-gen");
	assert.equal(resolved.config.summarizer?.enabled, true);
	assert.equal(resolved.config.contextCache?.scope, DEFAULT_CONTEXT_CACHE_CONFIG.scope);
	assert.equal(resolved.config.contextCache?.readThrough, true);
	assert.equal(resolved.config.proactiveCompaction?.preparationStallTimeoutMs, DEFAULT_PROACTIVE_COMPACTION_CONFIG.preparationStallTimeoutMs);
	assert.ok(resolved.entries.every((entry) => entry.layer === "default"));
});

test("each layer beats the one below it", () => {
	const stack = [
		readConfigLayer({ seedMode: "user-approve" }, "global", "/global.json"),
		readConfigLayer({ seedMode: "auto-gen" }, "project", "/project.json"),
		configLayerFromValues("cli", [["seedMode", "user-approve"]]),
		readPolicyEntryLayers([policyEntry("session", { seedMode: "auto-gen" })])[0] as ConfigLayerInput,
	];
	assert.equal(valueAt(stack, "seedMode"), "auto-gen");
	assert.equal(layerAt(stack, "seedMode"), "session");
});

test("summarizer opt-out resolves per leaf through every configuration layer", () => {
	const stack = [
		readConfigLayer({ summarizer: { enabled: false } }, "global", "/global.json"),
		readConfigLayer({ summarizer: { enabled: true } }, "project", "/project.json"),
		...readPolicyEntryLayers([policyEntry("host", { "summarizer.enabled": false }, "test-host")]),
	];
	assert.equal(valueAt(stack, "summarizer.enabled"), false);
	assert.equal(layerAt(stack, "summarizer.enabled"), "host");
	assert.equal(isKnownConfigPath("summarizer.enabled"), true);
});

test("host policy beats a CLI flag, so an inherited flag cannot redirect a worker", () => {
	const stack = [
		configLayerFromValues("cli", [["proactiveCompaction.enabled", true]]),
		...readPolicyEntryLayers([policyEntry("host", { "proactiveCompaction.enabled": false }, "pi-delegate/worker")]),
	];
	assert.equal(valueAt(stack, "proactiveCompaction.enabled"), false);
	assert.equal(layerAt(stack, "proactiveCompaction.enabled"), "host");
});

test("precedence comes from the layer, not from the order the inputs arrive in", () => {
	const host = readPolicyEntryLayers([policyEntry("host", { seedRewrite: false })]);
	const global = readConfigLayer({ seedRewrite: true }, "global");
	assert.equal(valueAt([...host, global], "seedRewrite"), false);
	assert.equal(valueAt([global, ...host], "seedRewrite"), false);
});

// --- merge semantics --------------------------------------------------------

test("a partial object overrides only the keys it names", () => {
	const stack = [
		readConfigLayer({ contextCache: { scope: "repo", maxListedFiles: 30 } }, "global"),
		readConfigLayer({ contextCache: { scope: "session" } }, "project"),
	];
	const resolved = resolveConfigLayers(stack);
	assert.equal(resolved.config.contextCache?.scope, "session");
	// The sibling survives: whole-object replacement would have discarded it.
	assert.equal(resolved.config.contextCache?.maxListedFiles, 30);
	assert.equal(resolved.byPath.get("contextCache.maxListedFiles")?.layer, "global");
});

test("an unset key falls through to the default rather than to the layer's other keys", () => {
	const resolved = resolveConfigLayers([readConfigLayer({ contextCache: { scope: "repo" } }, "project")]);
	assert.equal(resolved.config.contextCache?.staleHours, DEFAULT_CONTEXT_CACHE_CONFIG.staleHours);
	assert.equal(resolved.byPath.get("contextCache.staleHours")?.layer, "default");
});

// --- invalid values ---------------------------------------------------------

test("an invalid value is skipped so a lower layer still supplies the key", () => {
	const stack = [
		readConfigLayer({ contextCache: { scope: "repo" } }, "global"),
		readConfigLayer({ contextCache: { scope: "sideways" } }, "project", "/project.json"),
	];
	const resolved = resolveConfigLayers(stack);
	assert.equal(resolved.config.contextCache?.scope, "repo");
	assert.equal(resolved.byPath.get("contextCache.scope")?.layer, "global");
	assert.deepEqual(resolved.rejected, [{ layer: "project", path: "contextCache.scope" }]);
});

test("unknown keys are ignored entirely", () => {
	const layer = readConfigLayer({ nonsense: true, contextCache: { nonsense: 1 } }, "global");
	assert.equal(layer.values.size, 0);
	assert.deepEqual(layer.rejected, []);
	assert.equal(isKnownConfigPath("nonsense"), false);
	assert.equal(isKnownConfigPath("contextCache.scope"), true);
});

test("a non-object document contributes nothing instead of throwing", () => {
	for (const raw of [undefined, null, 7, "text", []]) {
		const layer = readConfigLayer(raw, "global");
		assert.equal(layer.values.size, 0);
	}
});

test("an explicit null model is a value, not an absent key", () => {
	const stack = [
		readConfigLayer({ compactionModel: "anthropic/claude-haiku-4-5" }, "global"),
		readConfigLayer({ compactionModel: null }, "project"),
	];
	assert.equal(valueAt(stack, "compactionModel"), null);
	assert.equal(layerAt(stack, "compactionModel"), "project");
});

// --- provenance -------------------------------------------------------------

test("an overruled value is retained rather than dropped", () => {
	const stack = [
		readConfigLayer({ seedRewrite: true }, "global", "/global.json"),
		configLayerFromValues("cli", [["seedRewrite", false]]),
		...readPolicyEntryLayers([policyEntry("host", { seedRewrite: true }, "pi-delegate/worker")]),
	];
	const entry = resolveConfigLayers(stack).byPath.get("seedRewrite");
	assert.equal(entry?.layer, "host");
	assert.deepEqual(
		entry?.overruled.map((loser) => [loser.layer, loser.value]),
		[["cli", false], ["global", true]],
	);
});

test("layer attribution names the winner and every overruled value", () => {
	const stack = [
		configLayerFromValues("cli", [["seedRewrite", false]]),
		...readPolicyEntryLayers([policyEntry("host", { seedRewrite: true }, "pi-delegate/worker")]),
	];
	const text = formatLayerAttribution(resolveConfigLayers(stack));
	const line = text.split("\n").find((candidate) => candidate.startsWith("seedRewrite")) ?? "";
	assert.ok(line.includes("(host policy: pi-delegate/worker)"), line);
	assert.ok(line.includes("[overruled: CLI flag=off]"), line);
	assert.deepEqual(overriddenPaths(resolveConfigLayers(stack)), ["seedRewrite"]);
});

test("attribution records the file a value came from", () => {
	const text = formatLayerAttribution(resolveConfigLayers([readConfigLayer({ seedMode: "user-approve" }, "project", "/repo/.pi/context-aware.json")]));
	assert.ok(text.includes("(project: /repo/.pi/context-aware.json)"), text);
});

// --- session-carried policy -------------------------------------------------

test("session and host records are separate layers of one entry type", () => {
	const layers = readPolicyEntryLayers([
		policyEntry("session", { "contextCache.scope": "repo" }),
		policyEntry("host", { "contextCache.scope": "directory" }, "pi-delegate/worker"),
	]);
	assert.deepEqual(layers.map((layer) => layer.layer), ["session", "host"]);
	assert.equal(valueAt(layers, "contextCache.scope"), "directory");
});

test("later records accumulate rather than replacing the whole layer", () => {
	const layers = readPolicyEntryLayers([
		policyEntry("session", { "contextCache.scope": "repo" }),
		policyEntry("session", { seedRewrite: false }),
	]);
	assert.equal(valueAt(layers, "contextCache.scope"), "repo");
	assert.equal(valueAt(layers, "seedRewrite"), false);
});

test("a later record wins for the path it names", () => {
	const layers = readPolicyEntryLayers([
		policyEntry("host", { "contextCache.scope": "repo" }),
		policyEntry("host", { "contextCache.scope": "session" }),
	]);
	assert.equal(valueAt(layers, "contextCache.scope"), "session");
});

test("remove withdraws a path so a lower layer supplies it again", () => {
	const entries = [
		policyEntry("session", { "contextCache.scope": "repo" }),
		{
			type: "custom",
			customType: CONFIG_POLICY_ENTRY_TYPE,
			data: configPolicyEntry("session", {}, { remove: ["contextCache.scope"] }),
		},
	];
	const stack = [readConfigLayer({ contextCache: { scope: "directory" } }, "global"), ...readPolicyEntryLayers(entries)];
	assert.equal(valueAt(stack, "contextCache.scope"), "directory");
	assert.equal(layerAt(stack, "contextCache.scope"), "global");
});

test("entries of other custom types and malformed payloads are ignored", () => {
	const layers = readPolicyEntryLayers([
		{ type: "custom", customType: "something.else", data: configPolicyEntry("host", { seedRewrite: false }) },
		{ type: "message", customType: CONFIG_POLICY_ENTRY_TYPE, data: configPolicyEntry("host", { seedRewrite: false }) },
		{ type: "custom", customType: CONFIG_POLICY_ENTRY_TYPE, data: { schemaVersion: 99, layer: "host", values: { seedRewrite: false } } },
		{ type: "custom", customType: CONFIG_POLICY_ENTRY_TYPE, data: { schemaVersion: 1, layer: "global", values: { seedRewrite: false } } },
		null,
		"not an entry",
	]);
	assert.deepEqual(layers, []);
});

test("a policy record cannot declare a layer other than session or host", () => {
	assert.equal(parseConfigPolicyEntry({ schemaVersion: 1, layer: "cli", values: {} }), null);
	assert.equal(parseConfigPolicyEntry({ schemaVersion: 1, layer: "host", values: {} })?.layer, "host");
});

test("an invalid value inside a policy record is rejected, not applied", () => {
	const layers = readPolicyEntryLayers([policyEntry("host", { "contextCache.scope": "sideways", seedRewrite: false })]);
	const stack = [readConfigLayer({ contextCache: { scope: "repo" } }, "global"), ...layers];
	assert.equal(valueAt(stack, "contextCache.scope"), "repo");
	assert.equal(valueAt(stack, "seedRewrite"), false);
	assert.deepEqual(resolveConfigLayers(stack).rejected, [{ layer: "host", path: "contextCache.scope" }]);
});

// --- individual leaf parsing ------------------------------------------------

test("a proactive threshold accepts fraction and percentage boundaries, and rejects values outside its band", () => {
	for (const [value, expected] of [[0.25, 0.25], [0.95, 0.95], [25, 0.25], [95, 0.95]] as const) {
		assert.equal(normalizeProactiveThreshold(value), expected);
	}
	for (const value of [0.1, 0.24, 0.96, 99]) {
		assert.equal(normalizeProactiveThreshold(value), undefined);
	}
	assert.equal(normalizeProactiveThreshold("78%"), undefined);
});

test("a rejected threshold leaves the default in place", () => {
	const resolved = resolveConfigLayers([readConfigLayer({ proactiveCompaction: { thresholdFraction: 0.05 } }, "global")]);
	assert.equal(resolved.config.proactiveCompaction?.thresholdFraction, DEFAULT_PROACTIVE_COMPACTION_CONFIG.thresholdFraction);
});

test("the proactive stall threshold is a layered positive integer", () => {
	const resolved = resolveConfigLayers([
		readConfigLayer({ proactiveCompaction: { preparationStallTimeoutMs: 45_000 } }, "global"),
		readConfigLayer({ proactiveCompaction: { preparationStallTimeoutMs: 0 } }, "project"),
	]);
	assert.equal(resolved.config.proactiveCompaction?.preparationStallTimeoutMs, 45_000);
	assert.equal(resolved.byPath.get("proactiveCompaction.preparationStallTimeoutMs")?.layer, "global");
	assert.deepEqual(resolved.rejected, [{ layer: "project", path: "proactiveCompaction.preparationStallTimeoutMs" }]);
});

test("readThrough can be disabled per layer without changing the narrow scope", () => {
	const resolved = resolveConfigLayers([readConfigLayer({ contextCache: { scope: "worktree", readThrough: false } }, "session")]);
	assert.equal(resolved.config.contextCache?.scope, "worktree");
	assert.equal(resolved.config.contextCache?.readThrough, false);
	assert.equal(resolved.byPath.get("contextCache.readThrough")?.layer, "session");
});

test("maxListedFiles must be a whole number of at least one", () => {
	for (const bad of [0, -1, 2.5, "12"]) {
		const layer = readConfigLayer({ contextCache: { maxListedFiles: bad } }, "global");
		assert.deepEqual(layer.rejected, ["contextCache.maxListedFiles"]);
	}
	assert.equal(readConfigLayer({ contextCache: { maxListedFiles: 1 } }, "global").values.get("contextCache.maxListedFiles"), 1);
});

test("context-cache retention limits must be positive", () => {
	for (const path of ["maxTotalSizeMB", "staleHours"] as const) {
		for (const bad of [0, -1]) {
			const layer = readConfigLayer({ contextCache: { [path]: bad } }, "global");
			assert.deepEqual(layer.rejected, [`contextCache.${path}`]);
		}
		const layer = readConfigLayer({ contextCache: { [path]: 0.5 } }, "global");
		assert.equal(layer.values.get(`contextCache.${path}`), 0.5);
	}
});

test("configLayerFromValues drops unknown paths instead of trusting the caller", () => {
	const layer = configLayerFromValues("cli", [["seedRewrite", false], ["nonsense", true], ["seedMode", undefined]]);
	assert.deepEqual([...layer.values.keys()], ["seedRewrite"]);
});

test("seedAuthorityGuard defaults to warn and accepts only its three values", () => {
	// The default decides what a refused compaction handoff costs. `warn` is
	// chosen so the guard can never freeze a session that has to compact.
	assert.equal(resolveConfigLayers([]).config.seedAuthorityGuard, "warn");
	for (const mode of ["enforce", "warn", "off"]) {
		assert.equal(valueAt([readConfigLayer({ seedAuthorityGuard: mode }, "global")], "seedAuthorityGuard"), mode);
	}
	const rejected = readConfigLayer({ seedAuthorityGuard: "block" }, "global");
	assert.deepEqual(rejected.rejected, ["seedAuthorityGuard"]);
	assert.equal(resolveConfigLayers([rejected]).config.seedAuthorityGuard, "warn");
});

// --- session naming (#86) ----------------------------------------------------

test("sessionNaming leaves resolve from their layered defaults", () => {
	const resolved = resolveConfigLayers([]);
	assert.deepEqual(resolved.config.sessionNaming, DEFAULT_SESSION_NAMING_CONFIG);
	assert.deepEqual(resolved.config.sessionNaming?.models, ["openai/gpt-5.6-luna"]);
	assert.equal(resolved.byPath.get("sessionNaming.scope")?.layer, "default");
	assert.equal(resolved.byPath.get("sessionNaming.models")?.value, DEFAULT_SESSION_NAMING_CONFIG.models);
});

test("a project layer overrides one sessionNaming leaf and keeps the siblings", () => {
	const stack = [
		readConfigLayer({ sessionNaming: { scope: "interactive", attempts: 5 } }, "project", "/project.json"),
	];
	const resolved = resolveConfigLayers(stack);
	assert.equal(resolved.config.sessionNaming?.scope, "interactive");
	assert.equal(resolved.config.sessionNaming?.attempts, 5);
	assert.equal(resolved.config.sessionNaming?.reviseEveryTurns, DEFAULT_SESSION_NAMING_CONFIG.reviseEveryTurns);
	assert.equal(resolved.config.sessionNaming?.models, DEFAULT_SESSION_NAMING_CONFIG.models);
});

test("invalid sessionNaming values are rejected, not defaulted at that layer", () => {
	const stack = [readConfigLayer({ sessionNaming: { scope: "sometimes", models: ["no-slash"], maxNameLength: 0 } }, "global", "/global.json")];
	const resolved = resolveConfigLayers(stack);
	for (const path of ["sessionNaming.scope", "sessionNaming.models", "sessionNaming.maxNameLength"]) {
		assert.equal(resolved.byPath.get(path)?.layer, "default", path);
	}
});

test("sessionNaming.model refs must be non-empty provider/id strings", () => {
	const good = readConfigLayer({ sessionNaming: { models: ["z-ai/glm-5.3-flash", "openai/gpt-5.6-luna"] } }, "global");
	assert.ok(isKnownConfigPath("sessionNaming.models"));
	assert.deepEqual(resolveConfigLayers([good]).config.sessionNaming?.models, ["z-ai/glm-5.3-flash", "openai/gpt-5.6-luna"]);
	const bad = readConfigLayer({ sessionNaming: { models: [] } }, "global");
	assert.equal(resolveConfigLayers([bad]).config.sessionNaming?.models, DEFAULT_SESSION_NAMING_CONFIG.models);
});
