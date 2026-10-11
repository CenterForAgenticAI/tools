import { readFile } from "node:fs/promises";
import { inspect, isDeepStrictEqual } from "node:util";
import {
	parseDefinition,
	type AgentDefinition,
	type Diagnostic,
	type Isolation,
	type ParseOptions,
} from "./definition.ts";
import type { IsolationDowngradeGrant } from "./policy.ts";

export type ConformanceLevel = "parses" | "enforces";

export interface ConsumerDiagnostic {
	readonly severity: "error" | "warning" | "hint";
	readonly path: string;
}

export interface ConsumerParse {
	readonly ok: boolean;
	readonly definition?: unknown;
	readonly diagnostics: readonly ConsumerDiagnostic[];
}

export interface ConformanceRestriction {
	readonly path: string;
	readonly value: unknown;
}

export interface PrepareRequest {
	readonly runtime: string;
	readonly requestedIsolation: Isolation;
	readonly isolationGrant?: IsolationDowngradeGrant;
}

export type PrepareResult =
	| { readonly ok: true; readonly enforced: readonly ConformanceRestriction[] }
	| { readonly ok: false; readonly reason: string };

export interface ConformanceConsumer {
	readonly name: string;
	parse(source: string, options: ParseOptions): ConsumerParse | Promise<ConsumerParse>;
	prepare?(definition: AgentDefinition, request: PrepareRequest): PrepareResult | Promise<PrepareResult>;
}

export interface ConformanceOptions {
	readonly level: ConformanceLevel;
}

export interface ConformanceFailure {
	readonly fixture: string;
	readonly path: string;
	readonly expected: unknown;
	readonly actual: unknown;
}

export interface ConformanceReport {
	readonly consumer: string;
	readonly level: ConformanceLevel;
	readonly passed: boolean;
	readonly checked: number;
	readonly failures: ConformanceFailure[];
}

interface ManifestEntry {
	readonly file: string;
	readonly expect: "valid" | "invalid" | "converter";
	readonly options?: ParseOptions;
}

interface ValidFixture {
	readonly file: string;
	readonly definition: AgentDefinition;
}

const fixturesRoot = new URL("../fixtures/", import.meta.url);
const manifestUrl = new URL("manifest.json", fixturesRoot);

function failure(fixture: string, path: string, expected: unknown, actual: unknown): ConformanceFailure {
	return { fixture, path, expected, actual };
}

function isContainer(value: unknown): value is Record<string, unknown> | readonly unknown[] {
	return typeof value === "object" && value !== null;
}

function childPath(parent: string, key: string, array: boolean): string {
	if (array) return `${parent}[${key}]`;
	return parent.length === 0 ? key : `${parent}.${key}`;
}

function compareDefinitions(
	fixture: string,
	expected: unknown,
	actual: unknown,
	path: string,
	failures: ConformanceFailure[],
): void {
	if (isDeepStrictEqual(expected, actual)) return;
	if (isContainer(expected) && isContainer(actual) && Array.isArray(expected) === Array.isArray(actual)) {
		const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
		for (const key of keys) {
			compareDefinitions(
				fixture,
				(expected as Record<string, unknown>)[key],
				(actual as Record<string, unknown>)[key],
				childPath(path, key, Array.isArray(expected)),
				failures,
			);
		}
		return;
	}
	failures.push(failure(fixture, path || "definition", expected, actual));
}

function diagnosticCounts(
	diagnostics: readonly ConsumerDiagnostic[] | readonly Diagnostic[],
	severity: "error" | "warning",
): Map<string, number> {
	const counts = new Map<string, number>();
	for (const diagnostic of diagnostics) {
		if (diagnostic.severity !== severity) continue;
		counts.set(diagnostic.path, (counts.get(diagnostic.path) ?? 0) + 1);
	}
	return counts;
}

function compareDiagnostics(
	fixture: string,
	expectedDiagnostics: readonly Diagnostic[],
	actualDiagnostics: readonly ConsumerDiagnostic[],
	failures: ConformanceFailure[],
): void {
	for (const severity of ["error", "warning"] as const) {
		const expected = diagnosticCounts(expectedDiagnostics, severity);
		const actual = diagnosticCounts(actualDiagnostics, severity);
		const paths = [...new Set([...expected.keys(), ...actual.keys()])].sort();
		for (const path of paths) {
			const expectedCount = expected.get(path) ?? 0;
			const actualCount = actual.get(path) ?? 0;
			if (expectedCount === actualCount) continue;
			failures.push(
				failure(
					fixture,
					path,
					expectedCount === 0 ? undefined : { severity, count: expectedCount },
					actualCount === 0 ? undefined : { severity, count: actualCount },
				),
			);
		}
	}
}

function restrictionsFor(definition: AgentDefinition): ConformanceRestriction[] {
	const restrictions: ConformanceRestriction[] = [];
	if (definition.tools !== "inherit") restrictions.push({ path: "tools", value: definition.tools });
	if (definition.disallowedTools.length > 0)
		restrictions.push({ path: "disallowedTools", value: definition.disallowedTools });
	if (!(definition.agents.length === 1 && definition.agents[0] === "*"))
		restrictions.push({ path: "agents", value: definition.agents });
	if (definition.workspace.isolation !== "shared")
		restrictions.push({ path: "workspace.isolation", value: definition.workspace.isolation });
	if (definition.limits.maxTurns !== null)
		restrictions.push({ path: "limits.maxTurns", value: definition.limits.maxTurns });
	if (definition.limits.timeoutMinutes !== null)
		restrictions.push({ path: "limits.timeoutMinutes", value: definition.limits.timeoutMinutes });
	for (const [index, skill] of definition.skills.entries()) {
		if (skill.required) restrictions.push({ path: `skills[${index}].required`, value: true });
	}
	for (const [runtime, options] of Object.entries(definition.runtimes)) {
		if (options.required) restrictions.push({ path: `runtimes.${runtime}.required`, value: true });
	}
	return restrictions;
}

function defaultRequest(definition: AgentDefinition): PrepareRequest {
	const requiredRuntime = Object.entries(definition.runtimes).find(([, options]) => options.required)?.[0];
	return {
		runtime: requiredRuntime ?? "conformance",
		requestedIsolation: definition.workspace.isolation,
	};
}

function compareRestrictions(
	fixture: string,
	expected: readonly ConformanceRestriction[],
	actual: readonly ConformanceRestriction[],
	failures: ConformanceFailure[],
): void {
	for (const restriction of expected) {
		const reported = actual.find(({ path }) => path === restriction.path);
		if (reported !== undefined && isDeepStrictEqual(restriction.value, reported.value)) continue;
		failures.push(failure(fixture, restriction.path, restriction.value, reported?.value));
	}
}

async function checkPreparation(
	prepare: NonNullable<ConformanceConsumer["prepare"]>,
	fixture: string,
	definition: AgentDefinition,
	request: PrepareRequest,
	failures: ConformanceFailure[],
): Promise<void> {
	try {
		const result = await prepare(definition, request);
		if (!result.ok) return;
		compareRestrictions(fixture, restrictionsFor(definition), result.enforced, failures);
	} catch (error) {
		failures.push(failure(fixture, "prepare", "prepare result", String(error)));
	}
}

async function checkRefusal(
	prepare: NonNullable<ConformanceConsumer["prepare"]>,
	fixture: string,
	path: string,
	definition: AgentDefinition,
	request: PrepareRequest,
	failures: ConformanceFailure[],
): Promise<void> {
	try {
		const result = await prepare(definition, request);
		if (!result.ok) return;
		failures.push(failure(fixture, path, "refusal", "accepted"));
	} catch (error) {
		failures.push(failure(fixture, "prepare", "refusal result", String(error)));
	}
}

function enforcementProbe(base: AgentDefinition): AgentDefinition {
	return {
		...base,
		tools: [{ name: "read", portable: "read", namespace: null }],
		disallowedTools: [{ name: "execute", portable: "execute", namespace: null }],
		agents: ["reviewer"],
		skills: [...base.skills, { name: "conformance-skill", source: null, version: null, required: true }],
		workspace: { isolation: "worktree" },
		limits: { maxTurns: 1, timeoutMinutes: 1 },
		runtimes: { ...base.runtimes, "conformance-required": { required: true } },
	};
}

async function runEnforcementChecks(
	consumer: ConformanceConsumer,
	validFixtures: readonly ValidFixture[],
	failures: ConformanceFailure[],
): Promise<number> {
	const base = validFixtures.find(({ file }) => file === "valid/minimal.md")!;
	const checked = validFixtures.length + 3;
	if (consumer.prepare === undefined) {
		failures.push(failure(base.file, "prepare", "function", "missing"));
		return checked;
	}
	const prepare = consumer.prepare.bind(consumer);
	for (const fixture of validFixtures) {
		await checkPreparation(prepare, fixture.file, fixture.definition, defaultRequest(fixture.definition), failures);
	}
	const probe = enforcementProbe(base.definition);
	await checkPreparation(prepare, base.file, probe, defaultRequest(probe), failures);
	await checkRefusal(
		prepare,
		base.file,
		"workspace.isolation",
		probe,
		{ runtime: "conformance-required", requestedIsolation: "shared" },
		failures,
	);
	await checkRefusal(
		prepare,
		base.file,
		"runtimes.conformance-required.required",
		probe,
		{ runtime: "conformance-other", requestedIsolation: "worktree" },
		failures,
	);
	return checked;
}

export async function runConformance(
	consumer: ConformanceConsumer,
	options: ConformanceOptions,
): Promise<ConformanceReport> {
	const manifest = JSON.parse(await readFile(manifestUrl, "utf8")) as ManifestEntry[];
	const entries = manifest.filter(({ expect }) => expect !== "converter");
	const failures: ConformanceFailure[] = [];
	const validFixtures: ValidFixture[] = [];
	for (const entry of entries) {
		const source = await readFile(new URL(entry.file, fixturesRoot), "utf8");
		const reference = parseDefinition(source, entry.options ?? {});
		if (reference.ok) validFixtures.push({ file: entry.file, definition: reference.definition });
		try {
			const actual = await consumer.parse(source, entry.options ?? {});
			if (actual.ok !== reference.ok) failures.push(failure(entry.file, "ok", reference.ok, actual.ok));
			compareDiagnostics(entry.file, reference.diagnostics, actual.diagnostics, failures);
			if (reference.ok && actual.ok)
				compareDefinitions(entry.file, reference.definition, actual.definition, "", failures);
		} catch (error) {
			failures.push(failure(entry.file, "parse", "parse result", String(error)));
		}
	}
	let checked = entries.length;
	if (options.level === "enforces") checked += await runEnforcementChecks(consumer, validFixtures, failures);
	return {
		consumer: consumer.name,
		level: options.level,
		passed: failures.length === 0,
		checked,
		failures,
	};
}

export async function assertConformance(consumer: ConformanceConsumer, options: ConformanceOptions): Promise<void> {
	const report = await runConformance(consumer, options);
	if (report.passed) return;
	const details = report.failures.map(
		({ fixture, path, expected, actual }) =>
			`- ${fixture} ${path}: expected ${inspect(expected, { breakLength: Infinity })}, actual ${inspect(actual, { breakLength: Infinity })}`,
	);
	throw new Error(
		`${report.consumer} failed conformance level ${report.level} with ${report.failures.length} failure(s):\n${details.join("\n")}`,
	);
}
