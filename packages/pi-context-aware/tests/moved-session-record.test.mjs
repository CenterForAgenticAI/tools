import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The session record (focus, tasks, asks, briefs, the focus seed and the launcher handoff)
// moved to pi-workstream. This package reads the focus through its own copies in
// src/snapshot-contracts/ and must not bring the moved files back or register their names.
const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** Source files that moved, relative to src/. A directory entry ending in "/" moved whole. */
export const MOVED = [
	"session-tasks/",
	"tool-arguments.ts",
	"seed/launcher-handoff.ts",
	"session/session-busy-probe.ts",
	"workstream/focus-seed.ts",
	"workstream/session-brief.ts",
	"workstream/workstream-focus.ts",
	"workstream/workstream-replay.ts",
	"workstream/workstream-safety.ts",
	"workstream/workstream-schema.ts",
	"workstream/workstream-state.ts",
	"workstream/workstream-view.ts",
	"workstream/workstream-widget.ts",
];

/** Tool and command names pi-workstream now owns. No alias may keep them here. */
export const MOVED_TOOLS = ["session_focus", "session_tasks"];
export const MOVED_COMMANDS = ["focus", "tasks", "answer"];

export function isMoved(relative) {
	return MOVED.some((entry) => (entry.endsWith("/") ? relative.startsWith(entry) : relative === entry));
}

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g;

/** The moved files that `relative` (a path under src/) imports through a relative specifier. */
export function movedImports(relative, text) {
	const found = [];
	for (const match of text.matchAll(SPECIFIER)) {
		const target = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1])).replace(/\.js$/, ".ts");
		if (isMoved(target)) found.push(target);
	}
	return found;
}

/** Names registered through registerTool({ name: "..." }) or registerCommand("..."). */
export function registeredNames(text) {
	const tools = [...text.matchAll(/registerTool\(\s*\{[^}]*?\bname:\s*["']([^"']+)["']/gs)].map((match) => match[1]);
	const commands = [...text.matchAll(/registerCommand\(\s*["']([^"']+)["']/g)].map((match) => match[1]);
	return { tools, commands };
}

function sourceFiles(directory, prefix = "") {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		if (entry.isDirectory()) return sourceFiles(path.join(directory, entry.name), relative);
		return entry.name.endsWith(".ts") ? [relative] : [];
	});
}

test("the guard sees static, type, re-export and dynamic imports of a moved file", () => {
	assert.deepEqual(movedImports("cache/recall.ts", 'import { redactText } from "../workstream/workstream-safety.js";'), ["workstream/workstream-safety.ts"]);
	assert.deepEqual(movedImports("platform/x.ts", 'import type { Task } from "../session-tasks/session-tasks.js";'), ["session-tasks/session-tasks.ts"]);
	assert.deepEqual(movedImports("platform/x.ts", 'export { stringEnum } from "../tool-arguments.js";'), ["tool-arguments.ts"]);
	assert.deepEqual(movedImports("platform/x.ts", 'const m = await import("../seed/launcher-handoff.js");'), ["seed/launcher-handoff.ts"]);
	assert.deepEqual(movedImports("workstream/workstream-context.ts", 'import { a } from "./workstream-state.js";'), ["workstream/workstream-state.ts"]);
	assert.deepEqual(movedImports("index.ts", 'import { probeSessionBusy } from "./session/session-busy-probe.js";'), ["session/session-busy-probe.ts"]);
});

test("the guard ignores files that stay and files that only look similar", () => {
	assert.deepEqual(movedImports("workstream/workstream-context.ts", 'import { a } from "./workstream-overlap.js";'), []);
	assert.deepEqual(movedImports("platform/x.ts", 'import { a } from "../snapshot-contracts/safety.js";'), []);
	assert.deepEqual(movedImports("platform/x.ts", 'import { a } from "node:fs";'), []);
});

test("the guard reads registered tool and command names", () => {
	const names = registeredNames('pi.registerTool({\n\tname: "session_focus",\n}); pi.registerCommand("focus", {}); pi.registerCommand(\'tasks\', {});');
	assert.deepEqual(names, { tools: ["session_focus"], commands: ["focus", "tasks"] });
	assert.deepEqual(registeredNames('pi.registerCommand("checkin", {});'), { tools: [], commands: ["checkin"] });
});

test("no moved source file is back in src/", () => {
	assert.deepEqual(sourceFiles(SRC).filter(isMoved), []);
	for (const entry of MOVED) assert.equal(existsSync(path.join(SRC, entry)), false, entry);
});

test("no source file imports a moved file", () => {
	const offenders = [];
	for (const relative of sourceFiles(SRC)) {
		for (const target of movedImports(relative, readFileSync(path.join(SRC, relative), "utf8"))) offenders.push(`src/${relative} imports src/${target}`);
	}
	assert.deepEqual(offenders, []);
});

test("no source file registers a tool or command that moved to pi-workstream", () => {
	const offenders = [];
	for (const relative of sourceFiles(SRC)) {
		const { tools, commands } = registeredNames(readFileSync(path.join(SRC, relative), "utf8"));
		for (const name of tools.filter((tool) => MOVED_TOOLS.includes(tool))) offenders.push(`src/${relative} registers tool ${name}`);
		for (const name of commands.filter((command) => MOVED_COMMANDS.includes(command))) offenders.push(`src/${relative} registers command /${name}`);
	}
	assert.deepEqual(offenders, []);
});
