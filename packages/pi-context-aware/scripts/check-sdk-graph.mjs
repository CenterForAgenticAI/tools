#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { BUN_LOCK, bunLockAsPackageLock, readBunLock } from "./bun-lock.mjs";

/**
 * The Pi SDK is published as a set of packages released in lockstep. The
 * package pins two of them as development dependencies and lets npm pull in
 * the rest, but the public-release verifier installs a clean export without
 * a lockfile. Without overrides, that install takes the newest patch of
 * every transitive SDK package, so a release published after a commit can put
 * a second copy of pi-ai under pi-agent-core and break the build (TS2322,
 * "separate declarations of a private property 'queue'").
 *
 * `overrides` in package.json survive the export. Each SDK override points at a
 * development pin with a `$` reference, so the whole SDK follows that pin: a
 * Renovate bump moves it, and the compatibility gate's minimum endpoint, which
 * rewrites the pins, moves it too. This script checks that the overrides cover
 * the SDK and that the lockfile (--lockfile) or the installed tree (--installed)
 * holds exactly one copy of each SDK package at the pinned version.
 *
 * The overrides cover the whole supported host range, and SDK releases add and
 * drop packages (Pi 1.2 drops chord, which the minimum endpoint still installs),
 * so only the development pins themselves must be present.
 */

export const SDK_SCOPE = "@earendil-works/";

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const LOCK_SDK_KEY = /(?:^|\/)node_modules\/(@earendil-works\/[^/]+)$/;

function record(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * Resolve every SDK override to the exact version it pins.
 *
 * @param {unknown} manifest
 * @returns {{ expected: Map<string, string>, pinned: Set<string>, errors: string[] }}
 */
export function expectedSdkVersions(manifest) {
	const manifestRecord = record(manifest);
	const devDependencies = record(manifestRecord.devDependencies);
	const overrides = record(manifestRecord.overrides);
	const expected = new Map();
	const pinned = new Set();
	const errors = [];

	for (const name of Object.keys(devDependencies)) {
		if (!name.startsWith(SDK_SCOPE)) continue;
		pinned.add(name);
		if (!Object.hasOwn(overrides, name)) {
			errors.push(`${name} is a development dependency without an override; add "${name}": "$${name}"`);
		}
	}

	for (const [name, spec] of Object.entries(overrides)) {
		if (!name.startsWith(SDK_SCOPE)) continue;
		if (typeof spec !== "string" || !spec.startsWith("$")) {
			errors.push(`${name} override must reference a development pin with "$"; found ${JSON.stringify(spec)}`);
			continue;
		}
		const reference = spec.slice(1);
		if (!reference.startsWith(SDK_SCOPE)) {
			errors.push(`${name} override must reference an SDK development pin; found ${spec}`);
			continue;
		}
		if (Object.hasOwn(devDependencies, name) && reference !== name) {
			errors.push(`${name} is a development dependency, so its override must be "$${name}"; found ${spec}`);
			continue;
		}
		const version = devDependencies[reference];
		if (typeof version !== "string" || !STABLE_VERSION.test(version)) {
			errors.push(`${name} override references ${reference}, which is not an exact development pin`);
			continue;
		}
		expected.set(name, version);
	}

	return { expected, pinned, errors };
}

/**
 * Compare located SDK copies with the versions the overrides pin.
 *
 * @param {Map<string, string>} expected
 * @param {Set<string>} pinned
 * @param {Array<{ location: string, name: string, version: string | undefined }>} copies
 * @param {string} source
 */
function compareCopies(expected, pinned, copies, source) {
	const errors = [];
	const topLevel = new Set();
	for (const { location, name, version } of copies) {
		if (location !== `node_modules/${name}`) {
			errors.push(`${source} has a nested SDK copy at ${location} (${version ?? "unknown version"}); every SDK package must resolve to one top-level copy`);
			continue;
		}
		topLevel.add(name);
		const want = expected.get(name);
		if (want === undefined) {
			errors.push(`${source} contains ${name}@${version ?? "unknown"} without an override; add "${name}": "$@earendil-works/pi-coding-agent"`);
		} else if (version !== want) {
			errors.push(`${source} resolves ${name}@${version ?? "missing"}; the overrides pin ${want}`);
		}
	}
	for (const name of pinned) {
		if (!topLevel.has(name)) errors.push(`${source} has no top-level ${name}; install the development dependencies`);
	}
	return errors;
}

/**
 * @param {unknown} manifest
 * @param {unknown} lockfile
 * @returns {string[]}
 */
export function validateLockfileSdkGraph(manifest, lockfile) {
	const { expected, pinned, errors } = expectedSdkVersions(manifest);
	const copies = [];
	for (const [location, entry] of Object.entries(record(record(lockfile).packages))) {
		const match = LOCK_SDK_KEY.exec(location);
		if (!match) continue;
		const version = record(entry).version;
		copies.push({ location, name: match[1], version: typeof version === "string" ? version : undefined });
	}
	return [...errors, ...compareCopies(expected, pinned, copies, BUN_LOCK)];
}

/**
 * Every installed SDK package directory, at any depth, relative to projectDir.
 *
 * @param {string} projectDir
 */
export function findInstalledSdkCopies(projectDir) {
	const copies = [];
	const visit = (modulesDir) => {
		let entries;
		try {
			entries = fs.readdirSync(path.join(projectDir, modulesDir), { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			const packageDirs = entry.name.startsWith("@")
				? fs.readdirSync(path.join(projectDir, modulesDir, entry.name), { withFileTypes: true })
					.filter((child) => child.isDirectory())
					.map((child) => `${entry.name}/${child.name}`)
				: [entry.name];
			for (const name of packageDirs) {
				const location = `${modulesDir}/${name}`;
				if (name.startsWith(SDK_SCOPE)) {
					let version;
					try {
						version = record(JSON.parse(fs.readFileSync(path.join(projectDir, location, "package.json"), "utf8"))).version;
					} catch {
						version = undefined;
					}
					copies.push({ location, name, version: typeof version === "string" ? version : undefined });
				}
				visit(`${location}/node_modules`);
			}
		}
	};
	visit("node_modules");
	return copies;
}

/**
 * @param {unknown} manifest
 * @param {string} projectDir
 * @returns {string[]}
 */
export function validateInstalledSdkGraph(manifest, projectDir) {
	const { expected, pinned, errors } = expectedSdkVersions(manifest);
	if (!fs.existsSync(path.join(projectDir, "node_modules"))) {
		return [...errors, "node_modules is missing; install dependencies before checking the installed SDK graph"];
	}
	return [...errors, ...compareCopies(expected, pinned, findInstalledSdkCopies(projectDir), "node_modules")];
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
	const modes = process.argv.slice(2);
	if (modes.length === 0 || modes.some((mode) => mode !== "--lockfile" && mode !== "--installed")) {
		console.error("Usage: check-sdk-graph.mjs [--lockfile] [--installed]");
		process.exit(2);
	}
	const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const manifest = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8"));
	const errors = [];
	if (modes.includes("--lockfile")) {
		errors.push(...validateLockfileSdkGraph(manifest, bunLockAsPackageLock(readBunLock(projectDir))));
	}
	if (modes.includes("--installed")) errors.push(...validateInstalledSdkGraph(manifest, projectDir));
	if (errors.length > 0) {
		console.error(`Pi SDK graph check failed:\n- ${[...new Set(errors)].join("\n- ")}`);
		process.exitCode = 1;
	} else {
		const { expected } = expectedSdkVersions(manifest);
		const versions = [...new Set(expected.values())].join(", ");
		console.log(`Pi SDK graph OK (${modes.join(" ")}): ${expected.size} packages, one copy each, at ${versions}`);
	}
}
