/**
 * Which pi-work this process loaded, and whether the copy on disk has since changed.
 *
 * pi loads an extension once per process. When the installed checkout or package is
 * updated underneath a running process, the process keeps executing the code it
 * loaded at startup while skills and documentation are read fresh from disk. Tool
 * results therefore say when the two differ, so a reader knows a restart may help.
 *
 * Every read here fails open: an unreadable package root or a missing Git checkout
 * yields no identity and no hint, never an error.
 */
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface LoadIdentity {
	readonly version?: string;
	readonly commit?: string;
}

export interface StaleLoadCheck {
	/** What this process loaded. */
	readonly loaded: LoadIdentity;
	/** One line naming loaded and installed identities, or undefined when they match or cannot be read. */
	hint(): string | undefined;
}

export interface StaleLoadCheckOptions {
	readonly packageRoot: string | undefined;
	/** Defaults to the identity on disk when the check is created. */
	readonly loaded?: LoadIdentity;
	readonly now?: () => number;
	readonly cacheMs?: number;
}

const DEFAULT_CACHE_MS = 2_000;
const MAX_ROOT_DEPTH = 4;
const MAX_IDENTITY_BYTES = 64 * 1024;
const MAX_VERSION_LENGTH = 100;

/** Only missing files are absent; other failures must stop ref fallback. */
function readText(file: string): string | undefined {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
		const stat = fstatSync(descriptor);
		if (!stat.isFile() || stat.size > MAX_IDENTITY_BYTES) throw new Error("invalid identity file");
		const buffer = Buffer.alloc(MAX_IDENTITY_BYTES + 1);
		let length = 0;
		while (length < buffer.length) {
			const count = readSync(descriptor, buffer, length, buffer.length - length, null);
			if (count === 0) break;
			length += count;
		}
		if (length > MAX_IDENTITY_BYTES) throw new Error("identity file too large");
		return buffer.toString("utf8", 0, length);
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

/** Find the nearest package.json at or above a module's directory. */
export function packageRootFrom(moduleUrl: string): string | undefined {
	try {
		let directory = path.dirname(fileURLToPath(moduleUrl));
		for (let depth = 0; depth <= MAX_ROOT_DEPTH; depth += 1) {
			if (statSync(path.join(directory, "package.json"), { throwIfNoEntry: false })?.isFile()) return directory;
			const parent = path.dirname(directory);
			if (parent === directory) return undefined;
			directory = parent;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function gitDirectory(root: string): string | undefined {
	const dotGit = path.join(root, ".git");
	const stat = statSync(dotGit, { throwIfNoEntry: false });
	if (stat?.isDirectory()) return dotGit;
	if (!stat?.isFile()) return undefined;
	const pointer = /^gitdir: (.+)$/m.exec(readText(dotGit) ?? "")?.[1]?.trim();
	return pointer === undefined ? undefined : path.resolve(root, pointer);
}

function isCommit(value: unknown): value is string {
	return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.exec(value)?.[0] === value;
}

function isVersion(value: unknown): value is string {
	return typeof value === "string" && value.length <= MAX_VERSION_LENGTH
		&& /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,64})?(?:\+[0-9A-Za-z.-]{1,64})?$/.exec(value)?.[0] === value;
}

function sanitizeIdentity(identity: LoadIdentity): LoadIdentity {
	return {
		...(isVersion(identity.version) ? { version: identity.version } : {}),
		...(isCommit(identity.commit) ? { commit: identity.commit } : {}),
	};
}

/** Resolve HEAD by reading Git's files directly; no subprocess. */
export function readHeadCommit(root: string): string | undefined {
	try {
		const gitDir = gitDirectory(root);
		if (gitDir === undefined) return undefined;
		const head = readText(path.join(gitDir, "HEAD"))?.trim();
		if (head === undefined) return undefined;
		if (isCommit(head)) return head;
		const ref = /^ref: (refs\/\S+)$/.exec(head)?.[1];
		if (ref === undefined || ref.split("/").includes("..")) return undefined;
		const common = readText(path.join(gitDir, "commondir"))?.trim();
		const commonDir = common === undefined || common.length === 0 ? gitDir : path.resolve(gitDir, common);
		for (const directory of new Set([gitDir, commonDir])) {
			const loose = readText(path.join(directory, ref));
			if (loose !== undefined) return isCommit(loose.trim()) ? loose.trim() : undefined;
		}
		for (const line of (readText(path.join(commonDir, "packed-refs")) ?? "").split("\n")) {
			const [commit, name] = line.trim().split(" ");
			if (name === ref && isCommit(commit)) return commit;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

/** Read the package version and, for a Git checkout, its HEAD commit. */
export function readLoadIdentity(packageRoot: string | undefined): LoadIdentity {
	if (packageRoot === undefined) return {};
	let version: string | undefined;
	try {
		const manifest: unknown = JSON.parse(readText(path.join(packageRoot, "package.json")) ?? "null");
		const candidate = typeof manifest === "object" && manifest !== null ? (manifest as Record<string, unknown>).version : undefined;
		if (isVersion(candidate)) version = candidate;
	} catch {
		version = undefined;
	}
	const commit = readHeadCommit(packageRoot);
	return { ...(version === undefined ? {} : { version }), ...(commit === undefined ? {} : { commit }) };
}

/** Render an identity such as `1.2.3 (0123456789ab)`; empty when nothing is known. */
export function describeLoadIdentity(identity: LoadIdentity): string {
	const safe = sanitizeIdentity(identity);
	const commit = safe.commit?.slice(0, 12);
	if (safe.version !== undefined && commit !== undefined) return `${safe.version} (${commit})`;
	return safe.version ?? commit ?? "";
}

function changed(loaded: string | undefined, installed: string | undefined): boolean {
	return loaded !== undefined && installed !== undefined && loaded !== installed;
}

/** Only a field readable both at load and now can show a change; anything unreadable is no evidence. */
function differs(loaded: LoadIdentity, installed: LoadIdentity): boolean {
	return changed(loaded.version, installed.version) || changed(loaded.commit, installed.commit);
}

export function createStaleLoadCheck(options: StaleLoadCheckOptions): StaleLoadCheck {
	const loaded = sanitizeIdentity(options.loaded ?? readLoadIdentity(options.packageRoot));
	const now = options.now ?? Date.now;
	const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
	let cached: { at: number; hint: string | undefined } | undefined;
	return {
		loaded,
		hint() {
			const at = now();
			if (cached !== undefined && at - cached.at < cacheMs) return cached.hint;
			const installed = readLoadIdentity(options.packageRoot);
			const hint = differs(loaded, installed)
				? `pi-work loaded ${describeLoadIdentity(loaded)}; installed is ${describeLoadIdentity(installed)}. Restart pi to use it.`
				: undefined;
			cached = { at, hint };
			return hint;
		},
	};
}

/** The check for the copy of pi-work this module was loaded from, captured at load. */
export const staleLoadCheck: StaleLoadCheck = createStaleLoadCheck({ packageRoot: packageRootFrom(import.meta.url) });

/** Suffix naming the loaded pi-work, for failures a newer copy might not produce. */
export function loadedIdentitySuffix(identity: LoadIdentity = staleLoadCheck.loaded): string {
	const described = describeLoadIdentity(identity);
	return described.length === 0 ? "" : ` (loaded pi-work ${described})`;
}

const TRUNCATION_MARKER = "\n… output truncated";

/**
 * Reserve space for the restart hint when bounding tool text. An oversized hint
 * is itself cut off so the combined output always fits.
 */
export function boundedTextWithHint(rendered: string, maxLength: number, hint: string | undefined): { text: string; truncated: boolean } {
	const maximum = Math.max(0, Math.floor(maxLength));
	if (hint !== undefined && hint.length >= maximum) return { text: hint.slice(0, maximum), truncated: true };
	const limit = hint === undefined ? maximum : maximum - hint.length - 1;
	const truncated = rendered.length > limit;
	const marker = TRUNCATION_MARKER.slice(0, limit);
	const body = truncated ? `${rendered.slice(0, limit - marker.length)}${marker}` : rendered;
	return { text: hint === undefined ? body : `${body}\n${hint}`, truncated };
}
