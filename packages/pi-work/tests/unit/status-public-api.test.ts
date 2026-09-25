import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import test from "node:test";

import * as status from "../../src/status/index.ts";
import * as cache from "../../src/status/cache.ts";
import { decodeStatusCache } from "../../src/status/cache.ts";
import { REPO_ROOT, repoSourcePath, sourceModuleUrl } from "../helpers/source-under-test.ts";
import { withDraftLineage } from "../helpers/workspec-source.ts";

const INTERMEDIATE_TYPE_NAMES = new Set([
	"ChecklistReportsByAddress",
	"ClassifiedCache",
	"DerivedStatusContext",
	"Finding",
	"NodeContractAssembly",
	"NodeStatusReport",
	"ObservationReport",
	"ObservedFailedVerification",
	"ObservedNodeVerificationRecord",
	"ObservedVerificationCacheUpdate",
	"ObservedVerificationResult",
	"PlanReceipt",
	"StatusBlocker",
	"StatusCacheDecode",
	"StatusCacheV1",
	"StatusCacheVerificationEntry",
	"StatusFinding",
	"StatusGraph",
	"StatusGraphBuild",
	"StatusNodeInput",
	"VerificationCacheUpdate",
	"VerificationFailure",
	"VerificationResult",
	"WorkStatusDetails",
	"WorkStatusResult",
]);

const LIFECYCLE_TYPE_NAMES = new Set(["DerivationOutput", "LifecycleState", "NodeStatusReport", "WorkStatusDetails", "WorkStatusResult"]);
const LIFECYCLE_PROPERTIES = new Set(["gating", "lifecycle", "readiness", "specState"]);
const LIFECYCLE_VALUES = new Set(["blocked", "done", "needs-decision", "ready"]);
const STATUS_TYPES_SOURCE = path.resolve(repoSourcePath("status/types.ts"));
const MAX_TYPE_TRAVERSAL_DEPTH = 12;
const MAX_TYPE_TRAVERSAL_VISITS = 256;

interface SourceText {
	readonly fileName: string;
	readonly source: string;
}

interface CallableContract {
	readonly name: string;
	readonly parameters: readonly ts.Type[];
	readonly returnType: ts.Type;
	readonly body?: ts.Node | undefined;
}

interface TypeTraversalState {
	readonly seen: Set<ts.Type>;
	remaining: number;
}

interface CallableTraversalState extends TypeTraversalState {
	readonly seenSignatures: Set<ts.Signature>;
	exhausted: boolean;
}

function symbolDeclaration(symbol: ts.Symbol): ts.Declaration | undefined {
	return symbol.valueDeclaration ?? symbol.declarations?.[0];
}

function resolvedSymbol(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
	return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function propertyType(type: ts.Type, property: ts.Symbol, checker: ts.TypeChecker): ts.Type | undefined {
	const ownerSymbol = type.aliasSymbol ?? type.symbol;
	const declaration = symbolDeclaration(property) ?? (ownerSymbol ? symbolDeclaration(ownerSymbol) : undefined);
	return declaration ? checker.getTypeOfSymbolAtLocation(property, declaration) : undefined;
}

function propertyIsPublic(property: ts.Symbol): boolean {
	return !(property.declarations ?? []).some((declaration) => {
		const modifiers = ts.canHaveModifiers(declaration) ? ts.getModifiers(declaration) : undefined;
		const inaccessible = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword);
		const name = (declaration as ts.NamedDeclaration).name;
		return inaccessible || (name ? ts.isPrivateIdentifier(name) : false);
	});
}

function isValidatedPublicRequest(type: ts.Type): boolean {
	return [type.aliasSymbol, type.symbol].some((symbol) => symbol?.getName() === "StatusRequest" && symbol.declarations?.some((declaration) => path.resolve(declaration.getSourceFile().fileName) === STATUS_TYPES_SOURCE));
}

function signatureBody(signature: ts.Signature): ts.Node | undefined {
	const declaration = signature.declaration;
	if (!declaration) return undefined;
	if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration) || ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration)) return declaration.body;
	return undefined;
}

function typeNames(type: ts.Type, result = new Set<string>(), seen = new Set<ts.Type>(), depth = 0): Set<string> {
	if (depth > 5 || seen.has(type)) return result;
	seen.add(type);
	for (const symbol of [type.aliasSymbol, type.symbol]) if (symbol) result.add(symbol.getName());
	if (type.isUnionOrIntersection()) for (const member of type.types) typeNames(member, result, seen, depth + 1);
	if (type.flags & ts.TypeFlags.Object) {
		const reference = type as ts.TypeReference;
		for (const argument of reference.typeArguments ?? []) typeNames(argument, result, seen, depth + 1);
	}
	return result;
}

function typeIsIntermediate(type: ts.Type, checker: ts.TypeChecker): boolean {
	if (isValidatedPublicRequest(type)) return false;
	const state: TypeTraversalState = { seen: new Set(), remaining: MAX_TYPE_TRAVERSAL_VISITS };
	const visit = (candidate: ts.Type, depth: number): boolean => {
		if (depth > MAX_TYPE_TRAVERSAL_DEPTH || state.remaining === 0) return true;
		if (state.seen.has(candidate)) return false;
		state.seen.add(candidate);
		state.remaining -= 1;
		for (const symbol of [candidate.aliasSymbol, candidate.symbol]) {
			const name = symbol?.getName();
			if (name && (INTERMEDIATE_TYPE_NAMES.has(name) || /^Observed/.test(name) || /(?:Cache|Context|Graph)$/.test(name))) return true;
		}
		if (candidate.isUnionOrIntersection() && candidate.types.some((member) => visit(member, depth + 1))) return true;
		const constraint = checker.getBaseConstraintOfType(candidate);
		if (constraint && constraint !== candidate && visit(constraint, depth + 1)) return true;
		if (!(candidate.flags & ts.TypeFlags.Object)) return false;
		const reference = candidate as ts.TypeReference;
		if ((reference.typeArguments ?? []).some((argument) => visit(argument, depth + 1))) return true;
		return checker.getPropertiesOfType(candidate).some((property) => {
			if (!propertyIsPublic(property)) return false;
			const nestedType = propertyType(candidate, property, checker);
			return nestedType ? visit(nestedType, depth + 1) : false;
		});
	};
	return visit(type, 0);
}

function typeHasLifecycle(type: ts.Type, checker: ts.TypeChecker, seen = new Set<ts.Type>(), depth = 0): boolean {
	if (depth > 5 || seen.has(type)) return false;
	seen.add(type);
	const names = typeNames(type);
	if ([...names].some((name) => LIFECYCLE_TYPE_NAMES.has(name))) return true;
	if (type.isUnionOrIntersection() && type.types.some((member) => typeHasLifecycle(member, checker, seen, depth + 1))) return true;
	if (checker.getPropertiesOfType(type).some((property) => LIFECYCLE_PROPERTIES.has(property.getName()))) return true;
	if (type.flags & ts.TypeFlags.Object) {
		const reference = type as ts.TypeReference;
		if ((reference.typeArguments ?? []).some((argument) => typeHasLifecycle(argument, checker, seen, depth + 1))) return true;
	}
	return false;
}

function bodyHasLifecycle(body: ts.Node | undefined, checker: ts.TypeChecker): boolean {
	if (!body) return false;
	let found = false;
	const visit = (node: ts.Node): void => {
		if (found) return;
		if (ts.isStringLiteral(node) && (LIFECYCLE_VALUES.has(node.text) || LIFECYCLE_PROPERTIES.has(node.text))) found = true;
		if (ts.isIdentifier(node) && LIFECYCLE_PROPERTIES.has(node.text)) found = true;
		if (ts.isCallExpression(node)) {
			const signature = checker.getResolvedSignature(node);
			if (signature && typeHasLifecycle(signature.getReturnType(), checker)) found = true;
		}
		ts.forEachChild(node, visit);
	};
	visit(body);
	return found;
}

function callableContracts(name: string, type: ts.Type, checker: ts.TypeChecker, program: ts.Program, contracts: CallableContract[], state: CallableTraversalState, depth = 0): void {
	if (depth > MAX_TYPE_TRAVERSAL_DEPTH || state.remaining === 0) {
		state.exhausted = true;
		return;
	}
	if (state.seen.has(type)) return;
	state.seen.add(type);
	state.remaining -= 1;
	for (const signature of checker.getSignaturesOfType(type, ts.SignatureKind.Call)) {
		if (state.seenSignatures.has(signature)) continue;
		state.seenSignatures.add(signature);
		const parameters = signature.getParameters().map((parameter) => {
			const declaration = parameter.valueDeclaration ?? parameter.declarations?.[0] ?? signature.declaration;
			if (!declaration) throw new Error(`callable ${name} has a parameter without a declaration`);
			return checker.getTypeOfSymbolAtLocation(parameter, declaration);
		});
		const returnType = signature.getReturnType();
		contracts.push({ name, parameters, returnType, body: signatureBody(signature) });
		callableContracts(name, returnType, checker, program, contracts, state, depth + 1);
	}
	if (type.isUnionOrIntersection()) for (const member of type.types) callableContracts(name, member, checker, program, contracts, state, depth + 1);
	const constraint = checker.getBaseConstraintOfType(type);
	if (constraint && constraint !== type) callableContracts(name, constraint, checker, program, contracts, state, depth + 1);
	if (type.flags & ts.TypeFlags.Object) {
		const reference = type as ts.TypeReference;
		for (const argument of reference.typeArguments ?? []) callableContracts(name, argument, checker, program, contracts, state, depth + 1);
	}
	for (const property of checker.getPropertiesOfType(type)) {
		if (property.getName() === "prototype" || !propertyIsPublic(property)) continue;
		const declaration = property.valueDeclaration ?? property.declarations?.[0];
		const nestedType = propertyType(type, property, checker);
		if (!nestedType) continue;
		const propertySignatures = checker.getSignaturesOfType(nestedType, ts.SignatureKind.Call);
		if (propertySignatures.length > 0 && declaration && program.isSourceFileDefaultLibrary(declaration.getSourceFile())) continue;
		if (propertySignatures.length > 0 || nestedType.flags & ts.TypeFlags.Object) callableContracts(`${name}.${property.getName()}`, nestedType, checker, program, contracts, state, depth + 1);
	}
	for (const signature of checker.getSignaturesOfType(type, ts.SignatureKind.Construct)) callableContracts(name, signature.getReturnType(), checker, program, contracts, state, depth + 1);
}

function exportedReducerViolations(files: readonly SourceText[]): readonly string[] {
	const options: ts.CompilerOptions = {
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		strict: true,
		noEmit: true,
		skipLibCheck: true,
		allowJs: false,
	};
	const host = ts.createCompilerHost(options, true);
	const program = ts.createProgram(files.map((file) => file.fileName), options, host);
	const checker = program.getTypeChecker();
	const violations: string[] = [];
	for (const file of files) {
		const sourceFile = program.getSourceFile(file.fileName);
		const moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile);
		if (!sourceFile || !moduleSymbol) continue;
		for (const exported of checker.getExportsOfModule(moduleSymbol)) {
			const symbol = resolvedSymbol(checker, exported);
			const declaration = symbolDeclaration(symbol);
			if (!declaration) continue;
			const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
			const contracts: CallableContract[] = [];
			const traversal: CallableTraversalState = { seen: new Set(), seenSignatures: new Set(), remaining: MAX_TYPE_TRAVERSAL_VISITS, exhausted: false };
			callableContracts(exported.getName(), type, checker, program, contracts, traversal);
			for (const contract of contracts) {
				if (contract.parameters.some((parameter) => typeIsIntermediate(parameter, checker)) && (typeHasLifecycle(contract.returnType, checker) || bodyHasLifecycle(contract.body, checker))) violations.push(`${path.basename(file.fileName)}:${contract.name}`);
			}
			if (traversal.exhausted) violations.push(`${path.basename(file.fileName)}:${exported.getName()}.[traversal-limit]`);
		}
	}
	return [...new Set(violations)].sort();
}

async function mutationViolations(files: Readonly<Record<string, string>>): Promise<readonly string[]> {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-work-status-export-"));
	try {
		const sources = Object.entries(files).map(([fileName, source]) => ({ fileName: path.join(root, fileName), source }));
		for (const file of sources) await writeFile(file.fileName, file.source);
		return exportedReducerViolations(sources);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("status barrel exposes reporting APIs but no authority constructor or private verifier path", async () => {
	assert.equal("createVerifier" in status, false);
	assert.equal("createObservationalVerifier" in status, false);
	const source = await readFile(`${REPO_ROOT}/src/status/index.ts`, "utf8");
	assert.doesNotMatch(source, /verify\/internal/);
	assert.doesNotMatch(source, /work-verify/);
	assert.doesNotMatch(source, /createVerifier/);
});

test("export inventory structurally rejects caller-controlled intermediate lifecycle reducers", async () => {
	const fileNames = (await readdir(repoSourcePath("status"))).filter((file) => file.endsWith(".ts")).sort();
	assert.ok(fileNames.length > 0);
	const files = await Promise.all(fileNames.map(async (fileName) => ({ fileName: path.join(repoSourcePath("status"), fileName), source: await readFile(path.join(repoSourcePath("status"), fileName), "utf8") })));
	assert.deepEqual(exportedReducerViolations(files), []);
	for (const file of fileNames) await import(sourceModuleUrl(`status/${file.slice(0, -3)}`)) as Record<string, unknown>;
});

test("export inventory catches reducer-shaped mutation surfaces", async () => {
	const types = `interface DerivedStatusContext { readonly graph: unknown }\ninterface WorkStatusDetails { readonly lifecycle: "done" }\n`;
	const deepLayerCount = MAX_TYPE_TRAVERSAL_DEPTH + 3;
	const deepParameterTypes = Array.from({ length: deepLayerCount }, (_, index) => index === deepLayerCount - 1 ? `interface ParameterLayer${index} { readonly context: DerivedStatusContext }` : `interface ParameterLayer${index} { readonly next: ParameterLayer${index + 1} }`).join("\n");
	const deepResultTypes = Array.from({ length: deepLayerCount }, (_, index) => index === deepLayerCount - 1 ? `interface ResultLayer${index} { run(context: DerivedStatusContext): WorkStatusDetails }` : `interface ResultLayer${index} { readonly next: ResultLayer${index + 1} }`).join("\n");
	const cases: readonly { name: string; files: Readonly<Record<string, string>>; expected: string }[] = [
		{
			name: "direct declaration",
			files: { "direct.ts": `${types}export function unsafe(context: DerivedStatusContext): WorkStatusDetails { return { lifecycle: "done" }; }` },
			expected: "direct.ts:unsafe",
		},
		{
			name: "object-wrapped parameter",
			files: { "object-parameter.ts": `${types}export function unsafe(input: { context: DerivedStatusContext }): WorkStatusDetails { return { lifecycle: "done" }; }` },
			expected: "object-parameter.ts:unsafe",
		},
		{
			name: "generic-constrained parameter",
			files: { "generic-constraint.ts": `${types}export function unsafe<T extends DerivedStatusContext>(input: T): WorkStatusDetails { return { lifecycle: "done" }; }` },
			expected: "generic-constraint.ts:unsafe",
		},
		{
			name: "same-name request spoof",
			files: { "request-spoof.ts": `${types}interface StatusRequest { readonly context: DerivedStatusContext } export function unsafe(input: StatusRequest): WorkStatusDetails { return { lifecycle: "done" }; }` },
			expected: "request-spoof.ts:unsafe",
		},
		{
			name: "parameter beyond traversal depth",
			files: { "deep-parameter.ts": `${types}${deepParameterTypes}\nexport function unsafe(input: ParameterLayer0): WorkStatusDetails { return { lifecycle: "done" }; }` },
			expected: "deep-parameter.ts:unsafe",
		},
		{
			name: "factory-returned object method",
			files: { "factory.ts": `${types}export function factory() { return { run(context: DerivedStatusContext): WorkStatusDetails { return { lifecycle: "done" }; } }; }` },
			expected: "factory.ts:factory.run",
		},
		{
			name: "returned callable beyond traversal depth",
			files: { "deep-return.ts": `${types}${deepResultTypes}\nexport function factory(): ResultLayer0 { throw new Error("fixture"); }` },
			expected: "deep-return.ts:factory.[traversal-limit]",
		},
		{
			name: "export-list alias",
			files: { "list.ts": `${types}function unsafe(context: DerivedStatusContext): WorkStatusDetails { return { lifecycle: "done" }; } export { unsafe };` },
			expected: "list.ts:unsafe",
		},
		{
			name: "callable variable alias",
			files: { "callable-alias.ts": `${types}function source(context: DerivedStatusContext): WorkStatusDetails { return { lifecycle: "done" }; } export const unsafe = source;` },
			expected: "callable-alias.ts:unsafe",
		},
		{
			name: "observed and cache intermediate types",
			files: {
				"observed-cache.ts": `${types}interface ObservedVerificationResult { readonly outcome: "passed" } interface StatusCacheV1 { readonly version: 1 } export function unsafe(observed: ObservedVerificationResult, cache: StatusCacheV1): WorkStatusDetails { return { lifecycle: observed.outcome === "passed" ? "done" : "ready" }; }`,
			},
			expected: "observed-cache.ts:unsafe",
		},
		{
			name: "re-export",
			files: {
				"reexport.ts": `export { unsafe } from "./reexport-source.js";`,
				"reexport-source.ts": `${types}export function unsafe(context: DerivedStatusContext): WorkStatusDetails { return { lifecycle: "done" }; }`,
			},
			expected: "reexport.ts:unsafe",
		},
		{
			name: "exported object method",
			files: { "object.ts": `${types}export const unsafe = { run(context: DerivedStatusContext): WorkStatusDetails { return { lifecycle: "done" }; } };` },
			expected: "object.ts:unsafe.run",
		},
		{
			name: "exported class method",
			files: { "class.ts": `${types}export class Unsafe { run(context: DerivedStatusContext): WorkStatusDetails { return { lifecycle: "done" }; } }` },
			expected: "class.ts:Unsafe.run",
		},
		{
			name: "default callable",
			files: { "default.ts": `${types}export default function unsafe(context: DerivedStatusContext): WorkStatusDetails { return { lifecycle: "done" }; }` },
			expected: "default.ts:default",
		},
		{
			name: "namespace callable",
			files: { "namespace.ts": `${types}export namespace unsafe { export function run(context: DerivedStatusContext): WorkStatusDetails { return { lifecycle: "done" }; } }` },
			expected: "namespace.ts:unsafe.run",
		},
		{
			name: "getter-returned callable",
			files: { "getter.ts": `${types}export const unsafe = { get run() { return (context: DerivedStatusContext): WorkStatusDetails => ({ lifecycle: "done" }); } };` },
			expected: "getter.ts:unsafe.run",
		},
		{
			name: "computed method",
			files: { "computed.ts": `${types}const key = "run" as const; export const unsafe = { [key](context: DerivedStatusContext): WorkStatusDetails { return { lifecycle: "done" }; } };` },
			expected: "computed.ts:unsafe.run",
		},
		{
			name: "callable type alias",
			files: { "callable-type-alias.ts": `${types}type Unsafe = (context: DerivedStatusContext) => WorkStatusDetails; export const unsafe: Unsafe = () => ({ lifecycle: "done" });` },
			expected: "callable-type-alias.ts:unsafe",
		},
		{
			name: "callable interface",
			files: { "callable-interface.ts": `${types}interface Unsafe { (context: DerivedStatusContext): WorkStatusDetails } export const unsafe: Unsafe = () => ({ lifecycle: "done" });` },
			expected: "callable-interface.ts:unsafe",
		},
		{
			name: "recursive parameter envelope",
			files: { "recursive-envelope.ts": `${types}interface Envelope { readonly next?: Envelope; readonly payload?: { readonly context: DerivedStatusContext } } export function unsafe(input: Envelope): WorkStatusDetails { return { lifecycle: "done" }; }` },
			expected: "recursive-envelope.ts:unsafe",
		},
		{
			name: "factory-returned callback",
			files: { "returned-callback.ts": `${types}export function factory() { return (context: DerivedStatusContext): WorkStatusDetails => ({ lifecycle: "done" }); }` },
			expected: "returned-callback.ts:factory",
		},
		{
			name: "ambient-interface factory result",
			files: {
				"ambient-contract.d.ts": `interface DerivedStatusContext { readonly graph: unknown }\ninterface WorkStatusDetails { readonly lifecycle: "done" }\ninterface UnsafeResult { run(context: DerivedStatusContext): WorkStatusDetails }\n`,
				"ambient-factory.ts": `export function factory(): UnsafeResult { throw new Error("fixture"); }`,
			},
			expected: "ambient-factory.ts:factory.run",
		},
	];
	const safeFiles = {
		"inaccessible-members.ts": `${types}class Result { private run(context: DerivedStatusContext): WorkStatusDetails { return { lifecycle: "done" }; } protected execute(context: DerivedStatusContext): WorkStatusDetails { return { lifecycle: "done" }; } } export function factory() { return new Result(); }`,
	};
	const combinedFiles = Object.fromEntries([...cases.flatMap((testCase) => Object.entries(testCase.files)), ...Object.entries(safeFiles)]);
	const violations = await mutationViolations(combinedFiles);
	const missed: string[] = [];
	for (const testCase of cases) {
		if (!violations.includes(testCase.expected)) missed.push(`${testCase.name}: ${violations.join(", ") || "no violations"}`);
	}
	assert.deepEqual(missed, []);
	assert.equal(violations.some((violation) => violation.startsWith("inaccessible-members.ts:")), false);
});

test("cache source module pins the complete runtime export inventory with one bounded writer", () => {
	assert.deepEqual(Object.keys(cache).sort(), [
		"STATUS_CACHE_DISPATCH_WRITE_MAX_ATTEMPTS",
		"STATUS_CACHE_READBACK_RESIDUAL",
		"STATUS_CACHE_VERSION",
		"cacheEntry",
		"classifyStatusCache",
		"decodeStatusCache",
		"emptyStatusCache",
		"readStatusCache",
		"sameTreeIdentity",
		"statusCachePath",
		"writeDispatchCacheEntry",
	].sort());
	assert.equal(cache.STATUS_CACHE_DISPATCH_WRITE_MAX_ATTEMPTS, 8);
	assert.equal(cache.STATUS_CACHE_READBACK_RESIDUAL, "readback-may-precede-later-overwrite");
});

test("invalid source is rejected before a supplied cache is inspected", () => {
	let inspected = false;
	const cache = new Proxy({}, { get() { inspected = true; throw new Error("cache must not be inspected"); } });
	const result = status.deriveStatus({
		source: "work: [",
		specPath: "/tmp/invalid/spec.yaml",
		tree: { kind: "git", worktreePath: "/tmp/invalid", resolvedCommit: "a".repeat(40) },
		cache,
	});
	assert.equal(result.ok, false);
	assert.equal(inspected, false);
	assert.ok(result.details.findings.some((finding) => finding.code === "yaml-syntax"));
});

test("refresh is a typed blocked result and does not invent a trusted result", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-work-status-refresh-"));
	try {
		const source = withDraftLineage(`title: status\ndescription: d\nintent: i\nwork:\n  - id: node\n    task: run\n    acceptance:\n      - id: A\n        statement: signal\n        evidence:\n          kind: command\n          run: printf signal\n          expect:\n            exit: 0\n            output_includes: signal\n`, { cwd: root });
		const result = await status.refreshStatus({ source, request: { path: "spec.yaml", worktreePath: root, expectedCommit: "a".repeat(40) } });
		assert.equal(result.status, "blocked");
		if (result.status === "blocked") {
			assert.equal(result.ran, false);
			assert.match(result.message, /public verification barrel/);
			assert.equal(result.requires.length, 3);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("cache schema has no lifecycle or done field", () => {
	const decoded = decodeStatusCache({
		kind: "pi-work-status-cache",
		version: 1,
		specPath: "/tmp/spec.yaml",
		verification: {},
		review: {},
		dispatch: {},
		lifecycle: "done",
	});
	assert.equal(decoded.cache, undefined);
	assert.ok(decoded.findings.some((finding) => finding.code === "malformed-cache"));
});
