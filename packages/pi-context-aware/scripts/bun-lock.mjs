/**
 * Read Bun's text lockfile (`bun.lock`) for the dependency checks.
 *
 * `bun.lock` is JSON with trailing commas. Its `workspaces[""]` entry holds the
 * root package's declared dependencies, and `packages` maps an install path to
 * a tuple whose first element is `name@version`. An install path joins package
 * names with `/`: `@earendil-works/pi-ai/typebox` is the copy of `typebox`
 * installed at `node_modules/@earendil-works/pi-ai/node_modules/typebox`.
 *
 * Unlike package-lock.json, bun.lock has no `dev` flag, so
 * `runtimeReachable` derives it: a package is development-only when no runtime
 * dependency of the root reaches it.
 */

import fs from "node:fs";
import path from "node:path";

export const BUN_LOCK = "bun.lock";

function record(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * Parse bun.lock text. Removes the trailing commas JSON rejects, skipping string
 * contents so a comma inside a value is never touched.
 *
 * @param {string} text
 */
export function parseBunLock(text) {
	let out = "";
	let inString = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (inString) {
			out += char;
			if (char === "\\") {
				out += text[index + 1] ?? "";
				index++;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
			out += char;
			continue;
		}
		if (char === ",") {
			let next = index + 1;
			while (next < text.length && /\s/.test(text[next])) next++;
			if (text[next] === "}" || text[next] === "]") continue;
		}
		out += char;
	}
	return JSON.parse(out);
}

/** @param {string} projectDir */
export function readBunLock(projectDir) {
	return parseBunLock(fs.readFileSync(path.join(projectDir, BUN_LOCK), "utf8"));
}

/** The root workspace: the package's own declared dependencies. */
export function bunLockRoot(lockfile) {
	return record(record(record(lockfile).workspaces)[""]);
}

/**
 * Split an install path into package names, keeping `@scope/name` together.
 *
 * @param {string} key
 * @returns {string[]}
 */
export function installPathNames(key) {
	const parts = key.split("/");
	const names = [];
	for (let index = 0; index < parts.length; index++) {
		if (parts[index].startsWith("@") && index + 1 < parts.length) {
			names.push(`${parts[index]}/${parts[index + 1]}`);
			index++;
		} else {
			names.push(parts[index]);
		}
	}
	return names;
}

function splitIdent(ident) {
	if (typeof ident !== "string") return { version: undefined };
	const at = ident.lastIndexOf("@");
	return at > 0 ? { version: ident.slice(at + 1) } : { version: undefined };
}

/**
 * Every installed package: its install path, the npm-style `node_modules`
 * location, the name it is installed under, its version and its metadata.
 *
 * @param {unknown} lockfile
 * @returns {Array<{ key: string, names: string[], location: string, name: string, version: string | undefined, meta: Record<string, unknown> }>}
 */
export function bunLockEntries(lockfile) {
	const entries = [];
	for (const [key, value] of Object.entries(record(record(lockfile).packages))) {
		const tuple = Array.isArray(value) ? value : [];
		const names = installPathNames(key);
		const meta = record(tuple.slice(1).find((item) => item !== null && typeof item === "object" && !Array.isArray(item)));
		entries.push({
			key,
			names,
			location: names.map((name) => `node_modules/${name}`).join("/"),
			name: names[names.length - 1],
			version: splitIdent(tuple[0]).version,
			meta,
		});
	}
	return entries;
}

/**
 * Install paths reachable from the root's runtime dependencies
 * (`dependencies` and `optionalDependencies`). Resolution follows Node: from a
 * package at `a/b`, dependency `d` resolves to `a/b/d`, then `a/d`, then `d`.
 *
 * @param {unknown} lockfile
 * @returns {Set<string>}
 */
export function runtimeReachable(lockfile) {
	const byKey = new Map(bunLockEntries(lockfile).map((entry) => [entry.key, entry]));
	const resolve = (fromNames, dependency) => {
		for (let depth = fromNames.length; depth >= 0; depth--) {
			const key = [...fromNames.slice(0, depth), dependency].join("/");
			if (byKey.has(key)) return byKey.get(key);
		}
		return undefined;
	};
	const root = bunLockRoot(lockfile);
	const reached = new Set();
	const queue = [];
	const visit = (fromNames, dependencies) => {
		for (const dependency of Object.keys(record(dependencies))) {
			const entry = resolve(fromNames, dependency);
			if (entry && !reached.has(entry.key)) {
				reached.add(entry.key);
				queue.push(entry);
			}
		}
	};
	visit([], root.dependencies);
	visit([], root.optionalDependencies);
	while (queue.length > 0) {
		const entry = queue.shift();
		for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
			visit(entry.names, entry.meta[field]);
		}
	}
	return reached;
}

/**
 * Present bun.lock in the shape the dependency checks read from
 * package-lock.json: `packages[""]` holds the root declarations and every
 * `node_modules/...` location holds `{ version, dev }`. bun.lock records no
 * root `engines`, bundled dependencies or per-package `dev` flag; `dev` is
 * derived with `runtimeReachable`.
 *
 * @param {unknown} lockfile
 */
export function bunLockAsPackageLock(lockfile) {
	const root = bunLockRoot(lockfile);
	const runtime = runtimeReachable(lockfile);
	const peerDependenciesMeta = Object.fromEntries(
		(Array.isArray(root.optionalPeers) ? root.optionalPeers : [])
			.filter((name) => typeof name === "string")
			.map((name) => [name, { optional: true }]),
	);
	const rootEntry = { name: root.name };
	for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
		if (root[field] !== undefined) rootEntry[field] = record(root[field]);
	}
	if (Object.keys(peerDependenciesMeta).length > 0) rootEntry.peerDependenciesMeta = peerDependenciesMeta;
	const packages = { "": rootEntry };
	for (const entry of bunLockEntries(lockfile)) {
		packages[entry.location] = { version: entry.version, dev: !runtime.has(entry.key) };
	}
	return { packages };
}
