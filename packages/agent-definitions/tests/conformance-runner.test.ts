import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { checkIsolation, checkRuntime, parseDefinition, type AgentDefinition, type ParseResult } from "../src/index.ts";
import {
	assertConformance,
	runConformance,
	type ConformanceConsumer,
	type ConformanceFailure,
	type ConformanceReport,
	type ConformanceRestriction,
	type PrepareRequest,
	type PrepareResult,
} from "../src/conformance.ts";

interface ManifestEntry {
	file: string;
	expect: "valid" | "invalid" | "converter";
}

const manifest = JSON.parse(
	readFileSync(new URL("../fixtures/manifest.json", import.meta.url), "utf8"),
) as ManifestEntry[];
const parseChecks = manifest.filter(({ expect }) => expect !== "converter").length;
const validChecks = manifest.filter(({ expect }) => expect === "valid").length;
const enforcementProbeChecks = 3;

function restrictions(definition: AgentDefinition): ConformanceRestriction[] {
	const result: ConformanceRestriction[] = [];
	if (definition.tools !== "inherit") result.push({ path: "tools", value: definition.tools });
	if (definition.disallowedTools.length > 0)
		result.push({ path: "disallowedTools", value: definition.disallowedTools });
	if (!(definition.agents.length === 1 && definition.agents[0] === "*"))
		result.push({ path: "agents", value: definition.agents });
	if (definition.workspace.isolation !== "shared")
		result.push({ path: "workspace.isolation", value: definition.workspace.isolation });
	if (definition.limits.maxTurns !== null) result.push({ path: "limits.maxTurns", value: definition.limits.maxTurns });
	if (definition.limits.timeoutMinutes !== null)
		result.push({ path: "limits.timeoutMinutes", value: definition.limits.timeoutMinutes });
	for (const [index, skill] of definition.skills.entries()) {
		if (skill.required) result.push({ path: `skills[${index}].required`, value: true });
	}
	for (const [runtime, options] of Object.entries(definition.runtimes)) {
		if (options.required) result.push({ path: `runtimes.${runtime}.required`, value: true });
	}
	return result;
}

function referencePrepare(definition: AgentDefinition, request: PrepareRequest): PrepareResult {
	const isolation = checkIsolation({
		definition: definition.workspace.isolation,
		requested: request.requestedIsolation,
		...(request.isolationGrant === undefined ? {} : { grant: request.isolationGrant }),
	});
	if (!isolation.ok) return { ok: false, reason: isolation.reason };
	const selectedRuntime = definition.runtimes[request.runtime];
	const runtime = checkRuntime(definition, {
		runtime: request.runtime,
		knownKeys: selectedRuntime === undefined ? [] : Object.keys(selectedRuntime).filter((key) => key !== "required"),
	});
	if (!runtime.ok) return { ok: false, reason: runtime.diagnostics.map(({ code }) => code).join(", ") };
	return { ok: true, enforced: restrictions(definition) };
}

function consumer(
	name: string,
	transform: (result: ParseResult) => ReturnType<ConformanceConsumer["parse"]> = (result) => result,
	prepare: ConformanceConsumer["prepare"] = referencePrepare,
): ConformanceConsumer {
	return {
		name,
		parse(source, options) {
			return transform(parseDefinition(source, options));
		},
		prepare,
	};
}

function failureAt(report: ConformanceReport, fixture: string, path: string): ConformanceFailure {
	const failure = report.failures.find((candidate) => candidate.fixture === fixture && candidate.path === path);
	assert.ok(failure, `expected failure for ${fixture} at ${path}: ${JSON.stringify(report.failures)}`);
	return failure;
}

describe("conformance runner", () => {
	it("passes the reference parser at the parses level", async () => {
		const report = await runConformance(consumer("reference"), { level: "parses" });
		assert.deepEqual(report, {
			consumer: "reference",
			level: "parses",
			passed: true,
			checked: parseChecks,
			failures: [],
		});
	});

	it("passes a reference prepare implementation at the enforces level", async () => {
		const report = await runConformance(consumer("reference-enforcer"), { level: "enforces" });
		assert.deepEqual(report, {
			consumer: "reference-enforcer",
			level: "enforces",
			passed: true,
			checked: parseChecks + validChecks + enforcementProbeChecks,
			failures: [],
		});
	});

	it("reports a definition field deleted by a consumer", async () => {
		const broken = consumer("drops-limits", (result) => {
			if (!result.ok) return result;
			const { limits: _limits, ...definition } = result.definition;
			return { ...result, definition };
		});
		const report = await runConformance(broken, { level: "parses" });
		assert.equal(report.passed, false);
		assert.deepEqual(failureAt(report, "valid/minimal.md", "limits"), {
			fixture: "valid/minimal.md",
			path: "limits",
			expected: { maxTurns: null, timeoutMinutes: null },
			actual: undefined,
		});
	});

	it("reports a changed default at its canonical path", async () => {
		const broken = consumer("changes-default", (result) => {
			if (!result.ok || result.definition.name !== "minimal") return result;
			return {
				...result,
				definition: {
					...result.definition,
					context: { ...result.definition.context, project: false },
				},
			};
		});
		const report = await runConformance(broken, { level: "parses" });
		assert.deepEqual(failureAt(report, "valid/minimal.md", "context.project"), {
			fixture: "valid/minimal.md",
			path: "context.project",
			expected: true,
			actual: false,
		});
	});

	it("reports a dropped warning at the warning's field path", async () => {
		const broken = consumer("drops-warnings", (result) => ({
			...result,
			diagnostics: result.diagnostics.filter(({ severity }) => severity !== "warning"),
		}));
		const report = await runConformance(broken, { level: "parses" });
		assert.deepEqual(failureAt(report, "valid/uppercase-name.md", "name"), {
			fixture: "valid/uppercase-name.md",
			path: "name",
			expected: { severity: "warning", count: 1 },
			actual: undefined,
		});
	});

	it("reports a consumer that accepts an invalid fixture", async () => {
		const broken = consumer("accepts-invalid", (result) =>
			result.ok ? result : { ok: true, definition: {}, diagnostics: result.diagnostics },
		);
		const report = await runConformance(broken, { level: "parses" });
		assert.deepEqual(failureAt(report, "invalid/missing-description.md", "ok"), {
			fixture: "invalid/missing-description.md",
			path: "ok",
			expected: false,
			actual: true,
		});
	});

	it("reports a changed error path at the expected field path", async () => {
		const broken = consumer("moves-errors", (result) => {
			if (result.ok) return result;
			return {
				...result,
				diagnostics: result.diagnostics.map((diagnostic, index) =>
					index === 0 ? { ...diagnostic, path: "wrong.path" } : diagnostic,
				),
			};
		});
		const report = await runConformance(broken, { level: "parses" });
		assert.deepEqual(failureAt(report, "invalid/missing-description.md", "description"), {
			fixture: "invalid/missing-description.md",
			path: "description",
			expected: { severity: "error", count: 1 },
			actual: undefined,
		});
	});

	it("reports an enforcement implementation that omits workspace isolation", async () => {
		const broken = consumer("omits-isolation", undefined, (definition, request) => {
			const result = referencePrepare(definition, request);
			return result.ok
				? { ...result, enforced: result.enforced.filter(({ path }) => path !== "workspace.isolation") }
				: result;
		});
		const report = await runConformance(broken, { level: "enforces" });
		assert.deepEqual(failureAt(report, "valid/minimal.md", "workspace.isolation"), {
			fixture: "valid/minimal.md",
			path: "workspace.isolation",
			expected: "worktree",
			actual: undefined,
		});
	});

	it("reports an enforcement implementation that accepts looser isolation", async () => {
		const broken = consumer("accepts-looser-isolation", undefined, (definition, request) => {
			const selectedRuntime = definition.runtimes[request.runtime];
			const runtime = checkRuntime(definition, {
				runtime: request.runtime,
				knownKeys:
					selectedRuntime === undefined ? [] : Object.keys(selectedRuntime).filter((key) => key !== "required"),
			});
			return runtime.ok ? { ok: true, enforced: restrictions(definition) } : { ok: false, reason: "runtime mismatch" };
		});
		const report = await runConformance(broken, { level: "enforces" });
		assert.deepEqual(failureAt(report, "valid/minimal.md", "workspace.isolation"), {
			fixture: "valid/minimal.md",
			path: "workspace.isolation",
			expected: "refusal",
			actual: "accepted",
		});
	});

	it("reports changed array entries and a non-object definition", async () => {
		const changesArray = consumer("changes-array", (result) => {
			if (!result.ok || result.definition.name !== "minimal") return result;
			return { ...result, definition: { ...result.definition, model: ["wrong-model"] } };
		});
		const arrayReport = await runConformance(changesArray, { level: "parses" });
		assert.deepEqual(failureAt(arrayReport, "valid/minimal.md", "model[0]"), {
			fixture: "valid/minimal.md",
			path: "model[0]",
			expected: "inherit",
			actual: "wrong-model",
		});

		const replacesDefinition = consumer("replaces-definition", (result) =>
			result.ok && result.definition.name === "minimal" ? { ...result, definition: null } : result,
		);
		const rootReport = await runConformance(replacesDefinition, { level: "parses" });
		const rootFailure = failureAt(rootReport, "valid/minimal.md", "definition");
		assert.equal((rootFailure.expected as AgentDefinition).name, "minimal");
		assert.equal(rootFailure.actual, null);
	});

	it("accepts a prepare implementation that refuses every restricted definition", async () => {
		const refuses = consumer("refuses", undefined, () => ({ ok: false, reason: "unsupported restriction" }));
		const report = await runConformance(refuses, { level: "enforces" });
		assert.equal(report.passed, true);
		assert.deepEqual(report.failures, []);
	});

	it("reports a self-reported restriction with the wrong value", async () => {
		const broken = consumer("changes-restriction", undefined, (definition, request) => {
			const result = referencePrepare(definition, request);
			return result.ok
				? {
						...result,
						enforced: result.enforced.map((restriction) =>
							restriction.path === "workspace.isolation" ? { ...restriction, value: "shared" } : restriction,
						),
					}
				: result;
		});
		const report = await runConformance(broken, { level: "enforces" });
		assert.deepEqual(failureAt(report, "valid/minimal.md", "workspace.isolation"), {
			fixture: "valid/minimal.md",
			path: "workspace.isolation",
			expected: "worktree",
			actual: "shared",
		});
	});

	it("turns prepare exceptions into failures instead of throwing", async () => {
		const broken = consumer("throws-prepare", undefined, () => {
			throw new Error("prepare exploded");
		});
		const report = await runConformance(broken, { level: "enforces" });
		assert.equal(report.passed, false);
		assert.deepEqual(failureAt(report, "valid/minimal.md", "prepare"), {
			fixture: "valid/minimal.md",
			path: "prepare",
			expected: "prepare result",
			actual: "Error: prepare exploded",
		});
		assert.ok(report.failures.some(({ expected }) => expected === "refusal result"));
	});

	it("reports an enforcement implementation that accepts a required runtime mismatch", async () => {
		const broken = consumer("accepts-runtime-mismatch", undefined, (definition, request) => {
			const isolation = checkIsolation({
				definition: definition.workspace.isolation,
				requested: request.requestedIsolation,
			});
			return isolation.ok ? { ok: true, enforced: restrictions(definition) } : { ok: false, reason: isolation.reason };
		});
		const report = await runConformance(broken, { level: "enforces" });
		assert.deepEqual(failureAt(report, "valid/minimal.md", "runtimes.conformance-required.required"), {
			fixture: "valid/minimal.md",
			path: "runtimes.conformance-required.required",
			expected: "refusal",
			actual: "accepted",
		});
	});

	it("calls prepare with the consumer as its receiver", async () => {
		const stateful: ConformanceConsumer & { enabled: boolean } = {
			name: "stateful",
			enabled: true,
			parse: parseDefinition,
			prepare(definition, request) {
				if (!this.enabled) throw new Error("consumer receiver was lost");
				return referencePrepare(definition, request);
			},
		};
		const report = await runConformance(stateful, { level: "enforces" });
		assert.equal(report.passed, true);
		assert.deepEqual(report.failures, []);
	});

	it("requires prepare at the enforces level", async () => {
		const withoutPrepare: ConformanceConsumer = {
			name: "parse-only",
			parse: parseDefinition,
		};
		const report = await runConformance(withoutPrepare, { level: "enforces" });
		assert.deepEqual(failureAt(report, "valid/minimal.md", "prepare"), {
			fixture: "valid/minimal.md",
			path: "prepare",
			expected: "function",
			actual: "missing",
		});
	});

	it("turns a consumer exception into failures instead of throwing", async () => {
		const report = await runConformance(
			{
				name: "throws",
				parse() {
					throw new Error("consumer exploded");
				},
			},
			{ level: "parses" },
		);
		assert.equal(report.passed, false);
		assert.deepEqual(failureAt(report, "valid/minimal.md", "parse"), {
			fixture: "valid/minimal.md",
			path: "parse",
			expected: "parse result",
			actual: "Error: consumer exploded",
		});
	});

	it("asserts passing reports and lists failing fixture paths", async () => {
		await assert.doesNotReject(assertConformance(consumer("reference"), { level: "parses" }));
		const broken = consumer("changes-default", (result) => {
			if (!result.ok || result.definition.name !== "minimal") return result;
			return { ...result, definition: { ...result.definition, schemaVersion: 2 } };
		});
		await assert.rejects(assertConformance(broken, { level: "parses" }), (error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /changes-default failed conformance level parses/);
			assert.match(error.message, /valid\/minimal\.md schemaVersion: expected 1, actual 2/);
			return true;
		});
	});
});
