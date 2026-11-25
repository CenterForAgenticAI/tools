/**
 * Structural guard for the context strategy contract (pi-context-aware#467, REQ-STRAT-001): strategy code
 * cannot write the session. A strategy returns plans as data; only the runtime writes.
 *
 * Two checks, both on the TypeScript compiler's syntax tree:
 *
 * 1. An allowlist over every file under src/strategy. A file there may value-import only files under
 *    src/strategy (a type-only import from anywhere carries no code and is allowed). It may not name
 *    `pi`, `ctx`, the global object (`globalThis`, `global`, `self`), `Bun`, `require`, `process`,
 *    `eval` or `Function`, may not reach a `constructor` member, and may not call `import()` with an
 *    argument other than a string literal. Through these names, aliases, destructuring, `Reflect.apply`
 *    and `.bind` have nothing to reach.
 * 2. No module in the runtime import closure of src/strategy-runtime (every file the runtime
 *    value-imports, transitively) names a session or file writer: it reports any reference to a
 *    distinctive writer name, called or not, and any method call to a writer with a common name. It
 *    proves nothing about a writer handed in as a callback: a module that calls an injected writer under
 *    another name, such as `options.appendSessionOverride(ctx, ...)` in src/policy/context-policy.ts, is
 *    a known reach (`INJECTED_WRITERS`), and the plan checker is kept outside its closure.
 * 3. No module in that closure starts a process (a value import of `node:child_process`), except the bench's
 *    out-of-process strategy adapter (`BENCH_PROCESS`, pi-context-aware#470). It runs a strategy program per
 *    request in a scratch directory it makes and removes; that removal is the one file writer check 2
 *    accepts, and only in that module. The plan checker's closure starts no process.
 *
 * The guard is a review aid over source text, not a sandbox. It checks names, not values: a strategy
 * file that reaches a host handle through a name it does not list, or through a computed member name
 * such as `x["constr" + "uctor"]`, escapes check 1. It covers the bypass shapes review found
 * (pi-context-aware!403, CR-GUARD-DENYLIST-BYPASS and CR-GUARD-GLOBAL-ALIAS); each has a scratch fixture below.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import ts from "typescript";

export interface GuardFinding {
	/** Repository-relative file holding the finding. */
	readonly file: string;
	readonly line: number;
	readonly detail: string;
	/** Import chain from the scanned start file to `file`; one element when the start file holds it. */
	readonly via: readonly string[];
}

const STRATEGY_DIR = "src/strategy";
const RUNTIME_DIR = "src/strategy-runtime";
/** Names a strategy file may not use: the host's handles, the global object under each name Node, browsers and Bun give it, Bun's API, module loading, the process, and code evaluation. */
const FORBIDDEN_NAMES = new Set(["pi", "ctx", "globalThis", "global", "self", "Bun", "require", "process", "eval", "Function"]);
/**
 * Writers the runtime's closure calls through a callback it is handed, which check 2 cannot name: the
 * module and the callback. `checkPlan` must stay outside the closure of each.
 */
const INJECTED_WRITERS = [{ file: "src/policy/context-policy.ts", callback: "appendSessionOverride" }] as const;
/**
 * The one module of the runtime's closure that starts a process: the bench's out-of-process strategy adapter
 * (pi-context-aware#470), bench only. `writers` are the check-2 findings it is allowed, exactly: removing the
 * scratch directory it runs each strategy process in.
 */
const BENCH_PROCESS = { file: "src/strategy-runtime/bench/external-strategy.ts", writers: ["fs.rmSync(...)"] } as const;
/** Modules that start processes. */
const PROCESS_MODULES = new Set(["child_process", "node:child_process"]);
/** A callback named like an entry writer: `options.appendSessionOverride(...)`. */
const APPEND_CALLBACK = /^append[A-Z]/u;
/**
 * Writers whose names are distinctive enough to flag on any reference, called or not: Pi's ExtensionAPI and
 * ExtensionContext session writers, SessionManager entry writers, the fold engine's draft writer, and
 * node:fs file writers.
 */
const NAMED_WRITERS = new Set([
	"appendEntry", "sendMessage", "sendUserMessage", "applyFoldDrafts",
	"setLabel", "setSessionName", "navigateTree", "switchSession", "setModel", "setThinkingLevel",
	"appendMessage", "appendThinkingLevelChange", "appendModelChange", "appendUsage", "appendCustomEntry", "appendCustomMessageEntry", "appendSessionInfo", "appendContextEdit", "appendLabelChange",
	"writeFile", "writeFileSync", "writeSync", "appendFile", "appendFileSync", "createWriteStream", "renameSync", "unlinkSync", "rmSync", "rmdirSync", "mkdirSync", "copyFileSync", "cpSync", "truncateSync", "symlinkSync", "linkSync", "chmodSync", "utimesSync",
]);
/** Writers with common names, flagged only as a method call on a receiver (`ctx.compact(...)`, `ctx.fork(...)`, `fs.unlink(...)`). */
const METHOD_WRITERS = new Set(["branch", "branchWithSummary", "createBranchedSession", "resetLeaf", "newSession", "setSessionFile", "compact", "fork", "write", "unlink", "rename", "rm", "mkdir", "copyFile", "cp", "truncate"]);

interface ModuleUse {
	readonly specifier: string;
	readonly line: number;
}

interface Parsed {
	/** Runtime (value) module uses: imports, re-exports, `import()` and `require()` with a literal argument. */
	readonly imports: ModuleUse[];
	/** Allowlist findings other than imports: forbidden names, `constructor` members, non-literal `import()`. */
	readonly references: { line: number; detail: string }[];
	/** Denylist findings: writer references and writer method calls. */
	readonly writers: { line: number; detail: string }[];
	/** Calls of an `append...` callback that is not a named writer: a writer handed in, which the denylist cannot name. */
	readonly callbacks: { line: number; name: string }[];
}

/** The identifier is a member or declaration name, not a reference to a binding: `a.pi`, `{ pi: 1 }`, `interface X { pi: number }`. */
function isMemberName(node: ts.Identifier): boolean {
	const parent = node.parent;
	if (ts.isPropertyAccessExpression(parent) || ts.isQualifiedName(parent)) return (ts.isPropertyAccessExpression(parent) ? parent.name : parent.right) === node;
	return (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent)
		|| ts.isMethodSignature(parent) || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent) || ts.isEnumMember(parent)) && parent.name === node;
}

/** The identifier declares the writer rather than reaching one: `function applyFoldDrafts`, `interface X { appendEntry(): void }`. */
function declaresName(node: ts.Identifier): boolean {
	const parent = node.parent;
	return (ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent) || ts.isPropertySignature(parent)
		|| ts.isPropertyDeclaration(parent) || ts.isPropertyAssignment(parent)) && parent.name === node;
}

/** Every import and export clause binding is type-only. */
function typeOnlyImport(node: ts.ImportDeclaration): boolean {
	const clause = node.importClause;
	if (!clause) return false;
	if (clause.isTypeOnly) return true;
	const bindings = clause.namedBindings;
	return clause.name === undefined && bindings !== undefined && ts.isNamedImports(bindings) && bindings.elements.every((element) => element.isTypeOnly);
}

function typeOnlyExport(node: ts.ExportDeclaration): boolean {
	return node.isTypeOnly || (node.exportClause !== undefined && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 && node.exportClause.elements.every((element) => element.isTypeOnly));
}

function parse(file: string): Parsed {
	const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const parsed: Parsed = { imports: [], references: [], writers: [], callbacks: [] };
	const at = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
			if (!typeOnlyImport(node)) parsed.imports.push({ specifier: node.moduleSpecifier.text, line: at(node) });
		} else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
			if (!typeOnlyExport(node)) parsed.imports.push({ specifier: node.moduleSpecifier.text, line: at(node) });
		} else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
			parsed.imports.push({ specifier: node.moduleReference.expression.text, line: at(node) });
		} else if (ts.isCallExpression(node)) {
			const [first] = node.arguments;
			const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require");
			if (dynamic && first && ts.isStringLiteralLike(first)) parsed.imports.push({ specifier: first.text, line: at(node) });
			else if (dynamic) parsed.references.push({ line: at(node), detail: `${node.expression.getText(source)}() with a computed argument` });
			const callee = node.expression;
			const method = ts.isPropertyAccessExpression(callee) ? callee.name.text
				: ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression) ? callee.argumentExpression.text : undefined;
			if (method !== undefined && METHOD_WRITERS.has(method)) parsed.writers.push({ line: at(node), detail: `${callee.getText(source)}(...)` });
			if (method !== undefined && APPEND_CALLBACK.test(method) && !NAMED_WRITERS.has(method)) parsed.callbacks.push({ line: at(node), name: method });
		} else if (ts.isIdentifier(node)) {
			if (FORBIDDEN_NAMES.has(node.text) && !isMemberName(node)) parsed.references.push({ line: at(node), detail: `reference to ${node.text}` });
			if (node.text === "constructor" && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) parsed.references.push({ line: at(node), detail: "constructor member" });
			if (NAMED_WRITERS.has(node.text) && !declaresName(node)) {
				const shown = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node ? node.parent : node;
				const called = ts.isCallExpression(shown.parent) && shown.parent.expression === shown;
				parsed.writers.push({ line: at(node), detail: `${shown.getText(source)}${called ? "(...)" : ""}` });
			}
		} else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
			const name = node.argumentExpression.text;
			if (name === "constructor") parsed.references.push({ line: at(node), detail: "constructor member" });
			if (NAMED_WRITERS.has(name)) parsed.writers.push({ line: at(node), detail: node.getText(source) });
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return parsed;
}

function tsFiles(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		return entry.isDirectory() ? tsFiles(full) : entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [full] : [];
	}).sort();
}

/** The source file a relative specifier names, when it exists. */
function resolveImport(from: string, specifier: string): string | undefined {
	if (!specifier.startsWith(".")) return undefined;
	const base = path.resolve(path.dirname(from), specifier);
	const candidates = [base.replace(/\.js$/u, ".ts"), `${base}.ts`, path.join(base, "index.ts")];
	return candidates.find((candidate) => fs.existsSync(candidate));
}

const relTo = (root: string) => (file: string) => path.relative(root, file).split(path.sep).join("/");

/** Check 1: every file under `<root>/src/strategy` value-imports only src/strategy and reaches no host handle. */
export function scanStrategyAllowlist(root: string): { files: string[]; findings: GuardFinding[] } {
	const rel = relTo(root);
	const inside = path.join(root, STRATEGY_DIR) + path.sep;
	const files = tsFiles(path.join(root, STRATEGY_DIR));
	const findings: GuardFinding[] = [];
	for (const file of files) {
		const parsed = parse(file);
		const via = [rel(file)];
		for (const use of parsed.imports) {
			const target = use.specifier.startsWith(".") ? path.resolve(path.dirname(file), use.specifier) : undefined;
			if (target === undefined || !target.startsWith(inside)) findings.push({ file: rel(file), line: use.line, detail: `value import of ${use.specifier} from outside ${STRATEGY_DIR}`, via });
		}
		for (const reference of parsed.references) findings.push({ file: rel(file), line: reference.line, detail: reference.detail, via });
	}
	return { files: files.map(rel), findings: findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line) };
}

/**
 * Check 2: every writer reference in the runtime import closure of `<root>/src/strategy-runtime` (or of
 * `starts`), with the import chain that reaches it, and every `append...` callback the closure calls.
 */
export function scanRuntimeWriters(root: string, starts: readonly string[] = tsFiles(path.join(root, RUNTIME_DIR))): { closure: string[]; findings: GuardFinding[]; callbacks: GuardFinding[]; processes: GuardFinding[] } {
	const rel = relTo(root);
	const cache = new Map<string, Parsed>();
	const parsed = (file: string) => {
		let result = cache.get(file);
		if (!result) cache.set(file, result = parse(file));
		return result;
	};
	const seen = new Set<string>();
	const queue = starts.map((file) => ({ file, via: [rel(file)] }));
	for (const { file } of queue) seen.add(file);
	const findings: GuardFinding[] = [];
	const callbacks: GuardFinding[] = [];
	const processes: GuardFinding[] = [];
	while (queue.length > 0) {
		const { file, via } = queue.shift()!;
		const result = parsed(file);
		for (const writer of result.writers) findings.push({ file: rel(file), line: writer.line, detail: writer.detail, via });
		for (const callback of result.callbacks) callbacks.push({ file: rel(file), line: callback.line, detail: callback.name, via });
		for (const use of result.imports) {
			if (PROCESS_MODULES.has(use.specifier)) processes.push({ file: rel(file), line: use.line, detail: `value import of ${use.specifier}`, via });
			const next = resolveImport(file, use.specifier);
			if (!next || seen.has(next)) continue;
			seen.add(next);
			queue.push({ file: next, via: [...via, rel(next)] });
		}
	}
	return { closure: [...seen].map(rel).sort(), findings, callbacks, processes };
}

const describe = (findings: readonly GuardFinding[]) => findings.map((finding) => `${finding.file}:${finding.line} ${finding.detail} (via ${finding.via.join(" -> ")})`).join("\n");

test("every file under src/strategy value-imports only src/strategy and names no host handle", () => {
	const { files, findings } = scanStrategyAllowlist(path.resolve("."));
	assert.ok(files.includes("src/strategy/contract.ts") && files.includes("src/strategy/index.ts"), `the scan reads the strategy modules: ${files.join(", ")}`);
	assert.deepEqual(findings, [], `strategy modules break the allowlist:\n${describe(findings)}`);
});

test("no module the strategy runtime imports names a session or file writer", () => {
	const { closure, findings } = scanRuntimeWriters(path.resolve("."));
	for (const file of ["src/strategy-runtime/context-view.ts", "src/folds/fold-adapter.ts", "src/folds/kernel/index.ts", BENCH_PROCESS.file]) {
		assert.ok(closure.includes(file), `the scan follows the runtime's imports to ${file}: ${closure.join(", ")}`);
	}
	const known = (finding: GuardFinding) => finding.file === BENCH_PROCESS.file && (BENCH_PROCESS.writers as readonly string[]).includes(finding.detail);
	// The exemption is exact: each listed writer is still there, and nothing else in that module or elsewhere is.
	assert.deepEqual(findings.filter(known).map((finding) => finding.detail).sort(), [...BENCH_PROCESS.writers].sort(), "BENCH_PROCESS lists what the adapter removes");
	const others = findings.filter((finding) => !known(finding));
	assert.deepEqual(others, [], `the strategy runtime reaches session writers:\n${describe(others)}`);
});

test("only the bench's out-of-process strategy adapter starts a process from the runtime's closure, and the plan checker's closure starts none", () => {
	const root = path.resolve(".");
	const { processes } = scanRuntimeWriters(root);
	assert.deepEqual([...new Set(processes.map((found) => found.file))], [BENCH_PROCESS.file], `a runtime module starts a process:\n${describe(processes)}`);
	assert.deepEqual(scanRuntimeWriters(root, [path.join(root, RUNTIME_DIR, "check-plan.ts")]).processes, []);
});

test("the process check names a runtime module that imports node:child_process, through its import chain", () => {
	const { processes } = withTree({
		"src/strategy-runtime/view.ts": "import { run } from \"../folds/runner.js\";\nexport const build = () => run();\n",
		"src/folds/runner.ts": "import { execFileSync } from \"node:child_process\";\nexport const run = () => execFileSync(\"sh\");\n",
	}, (root) => scanRuntimeWriters(root));
	assert.deepEqual(processes, [{ file: "src/folds/runner.ts", line: 1, detail: "value import of node:child_process", via: ["src/strategy-runtime/view.ts", "src/folds/runner.ts"] }]);
});

test("the injected writers the runtime's closure calls are the known ones, and the plan checker's closure reaches none of them", () => {
	const root = path.resolve(".");
	const { callbacks } = scanRuntimeWriters(root);
	assert.deepEqual([...new Set(callbacks.map((found) => `${found.file} ${found.detail}`))].sort(), INJECTED_WRITERS.map(({ file, callback }) => `${file} ${callback}`),
		`an append... callback the denylist cannot name; list it in INJECTED_WRITERS:\n${describe(callbacks)}`);
	const checker = scanRuntimeWriters(root, [path.join(root, RUNTIME_DIR, "check-plan.ts")]);
	assert.ok(checker.closure.includes("src/folds/stub-summary.ts"), `the scan follows the checker's imports: ${checker.closure.join(", ")}`);
	for (const { file } of INJECTED_WRITERS) assert.equal(checker.closure.includes(file), false, `check-plan.ts reaches ${file}: ${checker.closure.join(", ")}`);
	assert.deepEqual([...checker.findings, ...checker.callbacks], []);
});

/** A throwaway repository tree under the temp directory; `files` maps repository-relative paths to source text. */
function withTree<T>(files: Record<string, string>, run: (root: string) => T): T {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "strategy-guard-"));
	try {
		for (const [file, text] of Object.entries(files)) {
			fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
			fs.writeFileSync(path.join(root, file), text);
		}
		return run(root);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

const WRITER_MODULE = "declare const pi: { appendEntry(type: string, data: unknown): void };\nexport function save() {\n\tpi.appendEntry(\"x\", {});\n}\n";

/** Each shape reaches a session writer without calling it by name; review found the old denylist missed them. */
const BYPASSES: Record<string, { source: string; expected: readonly string[] }> = {
	alias: {
		source: "declare const pi: any;\nconst host = pi;\nexport const run = () => host.appendEntry(\"x\", {});\n",
		expected: ["1 reference to pi", "2 reference to pi"],
	},
	destructure: {
		source: "declare const ctx: any;\nconst { appendMessage: save } = ctx.sessionManager;\nexport const run = () => save({});\n",
		expected: ["1 reference to ctx", "2 reference to ctx"],
	},
	computedMember: {
		source: "declare const pi: any;\nconst k = \"append\" + \"Entry\";\nexport const run = () => pi[k](\"x\", {});\n",
		expected: ["1 reference to pi", "3 reference to pi"],
	},
	reflectApply: {
		source: "declare const pi: any;\nexport const run = () => Reflect.apply(pi.appendEntry, pi, [\"x\", {}]);\n",
		expected: ["1 reference to pi", "2 reference to pi", "2 reference to pi"],
	},
	builtUpImport: {
		source: "const where = \"../folds/\" + \"writer.js\";\nexport const run = async () => (await import(where)).save();\n",
		expected: ["2 import() with a computed argument"],
	},
	bindAlias: {
		source: "declare const pi: any;\nconst send = pi.sendMessage.bind(pi);\nexport const run = () => send({});\n",
		expected: ["1 reference to pi", "2 reference to pi", "2 reference to pi"],
	},
	globalObject: {
		source: "export const run = () => (globalThis as { pi?: { appendEntry(t: string, d: unknown): void } }).pi?.appendEntry(\"x\", {});\n",
		expected: ["1 reference to globalThis"],
	},
	nodeGlobal: {
		source: "declare const global: { process: { chdir(dir: string): void } };\nexport const run = () => global.process.chdir(\"/\");\n",
		expected: ["1 reference to global", "2 reference to global"],
	},
	selfGlobal: {
		source: "declare const self: { pi?: { appendEntry(t: string, d: unknown): void } };\nexport const run = () => self.pi?.appendEntry(\"x\", {});\n",
		expected: ["1 reference to self", "2 reference to self"],
	},
	bunApi: {
		source: "declare const Bun: { write(path: string, data: string): Promise<number> };\nexport const run = () => Bun.write(\"session.jsonl\", \"{}\");\n",
		expected: ["1 reference to Bun", "2 reference to Bun"],
	},
	requireCall: {
		source: "export const run = () => require(\"../folds/writer.js\").save();\n",
		expected: ["1 value import of ../folds/writer.js from outside src/strategy", "1 reference to require"],
	},
	processHandle: {
		source: "export const run = () => process.chdir(\"/\");\n",
		expected: ["1 reference to process"],
	},
	constructorChain: {
		source: "export const run = () => ({}).constructor.constructor(\"return this\")();\n",
		expected: ["1 constructor member", "1 constructor member"],
	},
	valueImport: {
		source: "import { save } from \"../folds/writer.js\";\nexport const run = () => save();\n",
		expected: ["1 value import of ../folds/writer.js from outside src/strategy"],
	},
	packageImport: {
		source: "import { readFileSync } from \"node:fs\";\nexport const run = () => readFileSync(\"x\");\n",
		expected: ["1 value import of node:fs from outside src/strategy"],
	},
	runtimeReexport: {
		source: "export * from \"../strategy-runtime/index.js\";\n",
		expected: ["1 value import of ../strategy-runtime/index.js from outside src/strategy"],
	},
};

for (const [shape, { source, expected }] of Object.entries(BYPASSES)) {
	test(`the allowlist names a strategy that reaches the session by ${shape}`, () => {
		const found = withTree({ "src/strategy/bypass.ts": source, "src/folds/writer.ts": WRITER_MODULE }, (root) => scanStrategyAllowlist(root).findings);
		assert.deepEqual(found.map((finding) => `${finding.line} ${finding.detail}`), [...expected]);
		assert.ok(found.every((finding) => finding.file === "src/strategy/bypass.ts"));
	});
}

test("the allowlist accepts strategy code: imports inside src/strategy, type-only imports from anywhere, and member names that match a forbidden name", () => {
	const found = withTree({
		"src/strategy/clean.ts": [
			"import { STRATEGY_CONTRACT_VERSION } from \"./contract.js\";",
			"import type { Saver } from \"../folds/writer.js\";",
			"import { type Other } from \"../folds/writer.js\";",
			"export type { Saver as Kept } from \"../folds/writer.js\";",
			"export type Both = Saver | Other;",
			"interface Shape { pi: number; process: string }",
			"export const shape: Shape = { pi: 3, process: \"plan\" };",
			"export const read = (view: { ctx: number }) => view.ctx + shape.pi + STRATEGY_CONTRACT_VERSION;",
			"export const later = () => import(\"./contract.js\");",
		].join("\n"),
		"src/strategy/contract.ts": "export const STRATEGY_CONTRACT_VERSION = 1;\n",
		"src/folds/writer.ts": `${WRITER_MODULE}export type Saver = () => void;\nexport type Other = number;\n`,
	}, (root) => scanStrategyAllowlist(root).findings);
	assert.deepEqual(found, []);
});

test("the runtime denylist names each writer the runtime reaches through its imports, called or bound, with the import chain", () => {
	const { findings } = withTree({
		"src/strategy-runtime/view.ts": "import { touch } from \"../folds/host.js\";\nimport type { Kind } from \"../folds/typed.js\";\nexport const build = (kind: Kind) => touch(kind);\n",
		"src/folds/host.ts": [
			"declare const pi: any; declare const ctx: any;",
			"export function touch(kind: string) {",
			"\tpi.setLabel(\"e1\", kind);",
			"\tpi.setSessionName(kind);",
			"\tctx.fork(\"e1\");",
			"\tctx.navigateTree(\"e1\");",
			"\tctx.switchSession(\"f\");",
			"\tpi.setModel(kind);",
			"\tpi.setThinkingLevel(\"high\");",
			"\tconst send = pi.appendEntry.bind(pi);",
			"\treturn send;",
			"}",
		].join("\n"),
		"src/folds/typed.ts": `export type Kind = string;\n${WRITER_MODULE}`,
	}, (root) => scanRuntimeWriters(root));
	const via = ["src/strategy-runtime/view.ts", "src/folds/host.ts"];
	assert.deepEqual(findings, [
		{ file: "src/folds/host.ts", line: 3, detail: "pi.setLabel(...)", via },
		{ file: "src/folds/host.ts", line: 4, detail: "pi.setSessionName(...)", via },
		{ file: "src/folds/host.ts", line: 5, detail: "ctx.fork(...)", via },
		{ file: "src/folds/host.ts", line: 6, detail: "ctx.navigateTree(...)", via },
		{ file: "src/folds/host.ts", line: 7, detail: "ctx.switchSession(...)", via },
		{ file: "src/folds/host.ts", line: 8, detail: "pi.setModel(...)", via },
		{ file: "src/folds/host.ts", line: 9, detail: "pi.setThinkingLevel(...)", via },
		{ file: "src/folds/host.ts", line: 10, detail: "pi.appendEntry", via },
	], "the type-only import of src/folds/typed.ts carries no code and is not followed");
});

test("the runtime denylist still names the original writers: session entries, sendMessage, compact and fs writes", () => {
	const found = withTree({
		"src/strategy-runtime/direct.ts": [
			"import { writeFileSync } from \"node:fs\";",
			"declare const ctx: any; declare const pi: any;",
			"export function run() {",
			"\tctx.sessionManager.branch(\"e1\");",
			"\tpi.sendMessage({ customType: \"x\", content: \"y\" });",
			"\tctx.compact({});",
			"\twriteFileSync(\"out.txt\", \"y\");",
			"\tctx.sessionManager[\"appendMessage\"]({});",
			"}",
		].join("\n"),
	}, (root) => scanRuntimeWriters(root).findings.map((finding) => `${finding.line} ${finding.detail}`));
	assert.deepEqual(found, [
		"1 writeFileSync",
		"4 ctx.sessionManager.branch(...)",
		"5 pi.sendMessage(...)",
		"6 ctx.compact(...)",
		"7 writeFileSync(...)",
		"8 ctx.sessionManager[\"appendMessage\"]",
	]);
});
