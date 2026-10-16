import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import type { CompactionOwnerIdentity } from "./owner-claim.js";

/** The name this extension claims under. */
export const COMPACTION_OWNER_NAME = "pi-context-aware";

/**
 * True for a package.json name that is this package. The internal build and the public
 * release publish it under different scopes, and the release rewrites only package.json,
 * so the source matches the unscoped base name, with or without a scope. A manifest is
 * only asked this question when it sits at this file's own package root (see
 * `packageRoot`), so a scoped name elsewhere on the disk is never read.
 */
export function isThisPackageName(name: unknown): boolean {
	if (typeof name !== "string") return false;
	const slash = name.indexOf("/");
	if (slash === -1) return name === COMPACTION_OWNER_NAME;
	return name.startsWith("@") && name.indexOf("/", slash + 1) === -1 && name.slice(slash + 1) === COMPACTION_OWNER_NAME;
}

let memo: string | undefined;

/** 1-64 characters, no control characters, no surrounding whitespace: the protocol's rule for a version. */
function isPrintable(value: string): boolean {
	if (value.length < 1 || value.length > 64 || value.trim() !== value) return false;
	for (const char of value) {
		const code = char.codePointAt(0)!;
		if (code < 0x20 || code === 0x7f) return false;
	}
	return true;
}

/**
 * The root of the package this file belongs to, from where the build puts it:
 * `<root>/dist/extension.js` (the bundled entry Pi loads), `<root>/dist/compaction/`
 * (the release build), `<root>/src/compaction/` (the source) or
 * `<root>/.test-dist/src/compaction/` (the test build). Anything else has no known root.
 */
function packageRoot(file: string): string | undefined {
	let directory = path.dirname(file);
	if (path.basename(directory) === "dist") return path.dirname(directory);
	if (path.basename(directory) !== "compaction") return undefined;
	directory = path.dirname(directory);
	const top = path.basename(directory);
	if (top !== "dist" && top !== "src") return undefined;
	directory = path.dirname(directory);
	if (top === "src" && path.basename(directory) === ".test-dist") directory = path.dirname(directory);
	return directory;
}

/**
 * The package version, from this package's own package.json. Only the manifest at the
 * package root is read: when it is missing, the nearest manifest above belongs to some
 * other package, so its version is not this one's. The protocol needs 1-64 printable
 * characters, so anything else reads as `unknown`.
 */
export function packageVersion(): string {
	memo ??= readPackageVersion(new URL(import.meta.url));
	return memo;
}

/** `packageVersion` without the memo, starting from any file. */
export function readPackageVersion(from: URL): string {
	const root = packageRoot(fileURLToPath(from));
	if (root === undefined) return "unknown";
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
		if (isThisPackageName(parsed.name) && typeof parsed.version === "string" && isPrintable(parsed.version)) return parsed.version;
	} catch {
		// no readable package.json at the package root
	}
	return "unknown";
}

export function compactionOwnerIdentity(): CompactionOwnerIdentity {
	return { name: COMPACTION_OWNER_NAME, version: packageVersion() };
}
