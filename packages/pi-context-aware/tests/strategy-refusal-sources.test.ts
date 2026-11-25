/**
 * The refusal sentences, read where they are raised (pi-context-aware#468, CR-REFUSAL-SENTENCE-DRIFT on
 * pi-context-aware!405). `refusalCodeOf` gives a fold refusal its code from the sentence the fold engine or
 * `planFold` raises it with (`ENGINE_REFUSALS` in src/strategy-runtime/check-plan.ts). A kernel sync that
 * rewords one of those sentences would leave it `unrecognized`, counted as other in parity and metrics.
 *
 * This test parses the source files that raise them and collects every sentence at a raise site: a thrown
 * error, a push to `errors` or `warnings`, an `errors` or `warnings` list, a `*Message` variable, a
 * `refusal(code, message)` of `foldRules` or `summarizeEngine`, a `fail(ctx, errors)` of the fold pass,
 * and the text `stubSummaryError` returns. A `${...}` part reads as X. Then:
 *
 * - every alternative of every `ENGINE_REFUSALS` pattern matches a sentence that is really raised;
 * - every raised sentence gets a code other than `unrecognized`, the same code after `nativeRefusal`
 *   rewrites its advice, and, where it is raised with a code, that code; and
 * - the few raised sentences that are not refusals are named in `NOT_REFUSALS`, each still raised.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import ts from "typescript";

import { nativeRefusal } from "../src/folds/fold-refusal.js";
import { ENGINE_REFUSALS, refusalCodeOf } from "../src/strategy-runtime/check-plan.js";
import type { RefusalCode } from "../src/strategy/index.js";

/** The files that raise a sentence `ENGINE_REFUSALS` classifies, and the part of each that is read. */
const SOURCES: readonly { readonly file: string; readonly within?: string }[] = [
	{ file: "src/folds/kernel/compress.ts" },
	{ file: "src/folds/kernel/boundaries.ts" },
	{ file: "src/folds/fold-adapter.ts" },
	{ file: "src/folds/stub-summary.ts", within: "stubSummaryError" },
	{ file: "src/folds/fold-engine.ts" },
	{ file: "src/folds/fold-recovery.ts" },
	// The checker's own stub, say and plan refusals carry their code and are never read back from text.
	{ file: "src/strategy-runtime/check-plan.ts", within: "foldRules" },
];

/** Raised sentences that are not fold refusals, by their start, with the reason. Each must still be raised. */
const NOT_REFUSALS: readonly (readonly [RegExp, string])[] = [
	[/^Skipped range \(X\.\.X\) — overlaps an earlier range in the batch/u, "planFold plans one range per call, so no range of its request overlaps another"],
	[/^Excluded X checkpoint message\(s\) X from the compression range/u, "a note on a fold the engine still creates; a range left empty is refused as containing no compressible messages"],
	[/^Excluded X message\(s\) carrying image\/attachment payload\(s\)/u, "a note on a fold the engine still creates"],
	[/^Excluded X protected message\(s\) X from compression range/u, "a note on a fold the engine still creates; a range wholly protected is refused as in the protected zone"],
	[/^Withdrawn X message\(s\) from compression range to keep X intact/u, "a note on a fold the engine still creates; a range split at the zone is refused as would split"],
	[/^Withdrawn X message\(s\) from fold X to keep whole session entries/u, "a note on a fold planFold still creates; one left empty is refused by foldRules.coverage"],
	[/^X \(replay of request X\)$/u, "wraps a refusal raised elsewhere with the request it replays; the wrapped sentence is classified"],
	[/^coverage-changed: /u, "a replay or recovery outcome that carries its own code; no fold call plans it"],
	[/^branch-changed: /u, "a recovery outcome that carries its own code; no fold call plans it"],
	[/^entry-missing: /u, "a recovery outcome that carries its own code; no fold call plans it"],
	[/^fold drafts never contain X entries$/u, "an internal invariant of applyFoldDrafts, not a refusal"],
];

interface Raised {
	readonly at: string;
	readonly text: string;
	/** The code it is raised with, when the raise site names one. */
	readonly code?: string;
}

const SINK_PROPERTIES = new Set(["errors", "warnings"]);
const SINK_VARIABLES = /^(?:errors|warnings|\w*Message)$/u;

/** Every sentence raised in one source file, or in its declaration named `within`. */
function raisedIn(file: string, within?: string): Raised[] {
	const source = ts.createSourceFile(file, fs.readFileSync(path.resolve(file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const constants = new Map<string, string>();
	const gather = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isStringLiteralLike(node.initializer)) constants.set(node.name.text, node.initializer.text);
		ts.forEachChild(node, gather);
	};
	gather(source);
	const render = (node: ts.Expression): string[] => {
		if (ts.isStringLiteralLike(node)) return [node.text];
		if (ts.isTemplateExpression(node)) {
			return [node.head.text + node.templateSpans.map((span) => (ts.isIdentifier(span.expression) ? constants.get(span.expression.text) ?? "X" : "X") + span.literal.text).join("")];
		}
		if (ts.isParenthesizedExpression(node)) return render(node.expression);
		if (ts.isConditionalExpression(node)) return [...render(node.whenTrue), ...render(node.whenFalse)];
		if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return render(node.left).flatMap((left) => render(node.right).map((right) => left + right));
		return ["X"];
	};
	const sentences = (node: ts.Node): string[] => {
		if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(sentences);
		if (ts.isSpreadElement(node) || ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return sentences(node.expression);
		if (ts.isConditionalExpression(node)) return [...sentences(node.whenTrue), ...sentences(node.whenFalse)];
		if (ts.isCallExpression(node)) return node.arguments.flatMap(sentences);
		if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node) || ts.isBinaryExpression(node)) return render(node);
		return [];
	};
	const raised: Raised[] = [];
	const add = (node: ts.Node, found: readonly string[], code?: string): void => {
		const at = `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
		// A sentence has a word of three letters or more and a space; a bare kind such as "unknown" is not one.
		for (const text of found) if (/\s/u.test(text) && /[A-Za-z]{3,}/u.test(text.replace(/X/gu, ""))) raised.push({ at, text, ...(code === undefined ? {} : { code }) });
	};
	const visit = (node: ts.Node): void => {
		if (ts.isThrowStatement(node) && ts.isNewExpression(node.expression)) add(node, (node.expression.arguments ?? []).flatMap(sentences));
		else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "push" && /(?:^|\.)(?:errors|warnings)$/u.test(node.expression.expression.getText(source))) add(node, node.arguments.flatMap(sentences));
		else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "refusal") {
			const [code, message] = node.arguments;
			if (code && message) add(node, sentences(message), ts.isStringLiteralLike(code) ? code.text : undefined);
		} else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "fail" && node.arguments[1]) add(node, sentences(node.arguments[1]));
		else if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && SINK_PROPERTIES.has(node.name.text)) add(node, sentences(node.initializer));
		else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && SINK_VARIABLES.test(node.name.text) && node.initializer) add(node, sentences(node.initializer));
		else if (ts.isReturnStatement(node) && node.expression && within === "stubSummaryError") add(node, sentences(node.expression));
		ts.forEachChild(node, visit);
	};
	if (within === undefined) visit(source);
	else {
		let found = false;
		const find = (node: ts.Node): void => {
			const named = (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name !== undefined && ts.isIdentifier(node.name) && node.name.text === within;
			if (named) {
				found = true;
				visit(node);
			} else ts.forEachChild(node, find);
		};
		find(source);
		assert.ok(found, `${file} declares ${within}`);
	}
	return raised;
}

const RAISED: readonly Raised[] = SOURCES.flatMap(({ file, within }) => raisedIn(file, within));
const isNotRefusal = (text: string): boolean => NOT_REFUSALS.some(([pattern]) => pattern.test(text));

/** The alternatives of a pattern with no group: each sentence it names. */
function alternatives(pattern: RegExp): RegExp[] {
	assert.ok(!pattern.source.includes("("), `${pattern} has no group, so its alternatives split on |`);
	return pattern.source.split("|").map((source) => new RegExp(source, pattern.flags));
}

test("control: the raise sites are read, from the kernel, the adapter, the stub-summary check, the fold pass and foldRules", () => {
	for (const { file } of SOURCES) assert.ok(RAISED.some((raised) => raised.at.startsWith(`${file}:`)), `a sentence is raised in ${file}`);
	assert.ok(RAISED.length >= 40, `${RAISED.length} raised sentences`);
	const sample = (start: string) => RAISED.find((raised) => raised.text.startsWith(start))?.text;
	const anchored = sample("Requested range(s) cannot be anchored (e.g. X..X) — the refs exist in this session's ref map, but ") ?? "";
	assert.ok(anchored.endsWith("leaving your old refs dangling. X Run acp_status, then call the compress tool again using only the refs it reports."), `a branch of a *Message variable is read: ${anchored}`);
	assert.equal(sample("[stub-summary] This summary is a block pointer"), "[stub-summary] This summary is a block pointer copied from an earlier fold call, not a summary. Folding with it would replace the range with this one line. Write the complete summary for this range: decisions, file paths, errors and open work.");
	assert.ok(RAISED.some((raised) => raised.text === "X=\"X\" not found in visible context (likely consumed by an existing block)."), "a thrown error's message argument is read");
});

test("every ENGINE_REFUSALS pattern matches a sentence the fold engine or planFold really raises", () => {
	for (const [code, pattern] of ENGINE_REFUSALS) {
		for (const alternative of alternatives(pattern)) {
			assert.ok(RAISED.some((raised) => !isNotRefusal(raised.text) && alternative.test(raised.text)), `${code}: no raised sentence matches ${alternative}`);
		}
	}
});

test("every refusal sentence the fold engine and planFold raise has its code, keeps it through nativeRefusal, and agrees with the code it is raised with", () => {
	const overlapping = { overlapping: () => ["b1", "b2"] };
	const unclassified: string[] = [];
	for (const raised of RAISED) {
		if (isNotRefusal(raised.text)) continue;
		const code = refusalCodeOf(raised.text);
		if (code === "unrecognized") unclassified.push(`${raised.at}: ${raised.text}`);
		assert.equal(refusalCodeOf(nativeRefusal(raised.text, overlapping)), code, `rewritten: ${raised.at}: ${raised.text}`);
		if (raised.code !== undefined) assert.equal(code, raised.code as RefusalCode, `${raised.at}: ${raised.text}`);
	}
	assert.deepEqual(unclassified, [], "a reworded sentence, or a new one, needs its code in ENGINE_REFUSALS (or a reason in NOT_REFUSALS)");
});

test("each sentence NOT_REFUSALS names is still raised, so the list cannot hide a reworded refusal", () => {
	for (const [pattern, reason] of NOT_REFUSALS) assert.ok(RAISED.some((raised) => pattern.test(raised.text)), `${pattern} (${reason}) is no longer raised`);
});
