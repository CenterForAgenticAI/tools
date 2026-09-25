/**
 * Chain-dir and private worker-run directory helpers.
 *
 * Artifact storage v2 gives every producer attempt private scratch/output leaves.
 * This module validates the mutable candidate only; artifact-workspace publishes
 * checked bytes as an immutable retained snapshot. Assistant text is never
 * written to an artifact file.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import { performance } from "node:perf_hooks";
import * as path from "node:path";

import {
	createOwnerOnlyDirectory,
	enforceOwnerOnlyDirectoryIdentity,
	ensureOwnerOnlyDirectory,
} from "./state-io.js";

export interface OutputFromFileRequest {
	/** Filename, must be relative. Resolved against the authoritative artifact directory. */
	name: string;
	/** Directory that confines the source artifact. */
	baseDir: string;
}

export interface ReadOutputFromFile {
	absolutePath: string;
	bytes: number;
	content: string;
}

export type OutputFileErrorKind =
	| "absolute-path"
	| "outside-scratch-dir"
	| "empty-name"
	| "read-failed"
	| "empty-content";

export class OutputFileError extends Error {
	readonly kind: OutputFileErrorKind;
	constructor(kind: OutputFileErrorKind, message: string) {
		super(message);
		this.name = "OutputFileError";
		this.kind = kind;
	}
}

type WorkerScratchLeafAllocator = (prefix: string) => string;
let workerScratchLeafAllocator: WorkerScratchLeafAllocator = (prefix) => fs.mkdtempSync(prefix);

/** Narrow failure-injection seam for the worker scratch allocation boundary. */
export function __setWorkerScratchLeafAllocatorForTests(
	allocator: WorkerScratchLeafAllocator | undefined,
): () => void {
	const previous = workerScratchLeafAllocator;
	workerScratchLeafAllocator = allocator ?? ((prefix) => fs.mkdtempSync(prefix));
	return () => { workerScratchLeafAllocator = previous; };
}

type WorkerScratchRunsRootIdentity = Readonly<FileIdentity> & { readonly path: string };

interface WorkerScratchRegistration {
	readonly leaf: string;
	leafIdentity: Readonly<FileIdentity>;
	readonly runsRoot: WorkerScratchRunsRootIdentity;
	/** Workspace-owned and explicitly opted-in runs are removed recursively; other legacy roots preserve contents. */
	readonly recursiveCleanup: boolean;
	leases: number;
	retirement?: ReturnType<typeof setImmediate>;
}

function removeWorkerScratchLeaf(leaf: string): void {
	fs.rmdirSync(leaf);
}
let workerScratchSweep = sweepOldWorkerScratchDirs;
let workerScratchClock = (): number => performance.now();
const WORKER_SCRATCH_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const workerScratchRegistrations = new Map<string, WorkerScratchRegistration>();
const workerScratchSweepAttempts = new Map<string, number>();
const workerScratchParentIdentities = new Map<string, WorkerScratchRunsRootIdentity>();

/** Test-only seam for observing and controlling allocation-time stale sweeps. */
export function __setWorkerScratchSweepForTests(
	sweep: typeof sweepOldWorkerScratchDirs | undefined,
): () => void {
	const previous = workerScratchSweep;
	workerScratchSweep = sweep ?? sweepOldWorkerScratchDirs;
	return () => { workerScratchSweep = previous; };
}

/** Test-only seam for deterministic monotonic allocation-time sweep cadence tests. */
export function __setWorkerScratchClockForTests(
	clock: (() => number) | undefined,
): () => void {
	const previous = workerScratchClock;
	workerScratchClock = clock ?? (() => performance.now());
	return () => { workerScratchClock = previous; };
}

function maybeSweepOldWorkerScratchDirs(root: string): void {
	const now = workerScratchClock();
	const previous = workerScratchSweepAttempts.get(root);
	if (previous !== undefined && now - previous < WORKER_SCRATCH_SWEEP_INTERVAL_MS) return;
	workerScratchSweepAttempts.set(root, now);
	try {
		workerScratchSweep({ root });
	} catch {
		/* best effort; cadence is consumed even when the sweep fails */
	}
}

function verifyWorkerScratchRunsRoot(runsRoot: string, expected?: WorkerScratchRunsRootIdentity): WorkerScratchRunsRootIdentity | undefined {
	const resolved = path.resolve(runsRoot);
	try {
		const stat = fs.lstatSync(runsRoot);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
		// The canonical-path comparison removed here compared realpathSync(runsRoot)
		// with realpathSync(path.resolve(runsRoot)). Under fs.realpathSync those are
		// always equal: Node's JS implementation collapses ".." lexically before it
		// resolves links, so both sides normalise identically and the check could only
		// reject by throwing. This is specific to fs.realpathSync: for "/a/link/../b"
		// with /a/link -> /c it yields /a/b on both sides, while coreutils realpath and
		// fs.realpathSync.native yield /b. Switching to .native would make the two
		// sides genuinely disagree.
		//
		// Do not restore the earlier, stricter `realpathSync(runsRoot) !== resolved`
		// (realpath against the lexical resolve). That form rejects a symlinked
		// ancestor, and on macOS TMPDIR resolves through /var -> /private/var, so every
		// worker scratch allocation fails.
		//
		// The real guarantee is below: the final component is not itself a symlink, and
		// `expected` pins the directory's dev/ino, so a swapped path fails identity.
		const identity = fileIdentity(stat);
		if (expected && !sameFileIdentity(identity, expected)) return undefined;
		return { path: resolved, ...identity };
	} catch {
		return undefined;
	}
}

function ensureRecordedWorkerScratchLeaf(registration: WorkerScratchRegistration): boolean {
	if (verifyWorkerScratchRunsRoot(registration.runsRoot.path, registration.runsRoot) === undefined) return false;
	try {
		const stat = fs.lstatSync(registration.leaf);
		if (
			!stat.isDirectory() ||
			stat.isSymbolicLink() ||
			!sameFileIdentity(fileIdentity(stat), registration.leafIdentity)
		) return false;
		return enforceOwnerOnlyDirectoryIdentity(registration.leaf, registration.leafIdentity);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
	}
	try {
		const createdIdentity = createOwnerOnlyDirectory(registration.leaf);
		const stat = fs.lstatSync(registration.leaf);
		if (
			!stat.isDirectory() ||
			stat.isSymbolicLink() ||
			!sameFileIdentity(fileIdentity(stat), createdIdentity)
		) return false;
		registration.leafIdentity = createdIdentity;
		return true;
	} catch {
		return false;
	}
}

function retireWorkerScratchRegistration(registration: WorkerScratchRegistration): void {
	if (registration.leases !== 0) return;
	if (workerScratchRegistrations.get(registration.leaf) === registration) {
		workerScratchRegistrations.delete(registration.leaf);
	}
}

function scheduleWorkerScratchRegistrationRetirement(registration: WorkerScratchRegistration): void {
	if (registration.retirement !== undefined) return;
	registration.retirement = setImmediate(() => {
		registration.retirement = undefined;
		retireWorkerScratchRegistration(registration);
	});
}

export function acquireWorkerScratchCleanupLease(scratchRoot: string): (() => void) | undefined {
	const leaf = path.resolve(scratchRoot);
	const registration = workerScratchRegistrations.get(leaf);
	if (!registration) return undefined;
	if (!ensureRecordedWorkerScratchLeaf(registration)) {
		scheduleWorkerScratchRegistrationRetirement(registration);
		return undefined;
	}
	if (registration.retirement !== undefined) {
		clearImmediate(registration.retirement);
		registration.retirement = undefined;
	}
	registration.leases++;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		registration.leases--;
		if (registration.leases !== 0) return;
		if (verifyWorkerScratchRunsRoot(registration.runsRoot.path, registration.runsRoot) === undefined) {
			scheduleWorkerScratchRegistrationRetirement(registration);
			return;
		}
		try {
			const stat = fs.lstatSync(registration.leaf);
			if (
				!stat.isDirectory() ||
				stat.isSymbolicLink() ||
				!sameFileIdentity(fileIdentity(stat), registration.leafIdentity)
			) {
				scheduleWorkerScratchRegistrationRetirement(registration);
				return;
			}
			if (registration.recursiveCleanup) {
				removeStaleWorkerScratchCandidate({
					candidate: registration.leaf,
					candidateIdentity: registration.leafIdentity,
					runsRoot: registration.runsRoot.path,
					runsRootIdentity: registration.runsRoot,
				});
			} else {
				removeWorkerScratchLeaf(registration.leaf);
			}
		} catch {
			/* best effort; stale sweeping recovers failed shutdown cleanup */
		}
		scheduleWorkerScratchRegistrationRetirement(registration);
	};
}
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object") return undefined;
	const code = Reflect.get(error, "code");
	return typeof code === "string" ? code : undefined;
}

interface ContainedPath {
	trimmed: string;
	requestedRoot: string;
	lexicalResolved: string;
}

function resolveContainedPath(args: {
	name: string;
	baseDir: string;
	emptyMessage: string;
	absoluteMessage: (name: string, baseDir: string) => string;
	escapeMessage: (name: string, baseDir: string) => string;
	escapeKind: "outside-scratch-dir";
	rootMessage: (name: string, baseDir: string) => string;
}): ContainedPath {
	const trimmed = args.name.trim();
	const requestedRoot = path.resolve(args.baseDir);
	if (trimmed.length === 0) throw new OutputFileError("empty-name", args.emptyMessage);
	if (path.isAbsolute(trimmed)) {
		throw new OutputFileError("absolute-path", args.absoluteMessage(trimmed, requestedRoot));
	}
	const lexicalResolved = path.resolve(requestedRoot, trimmed);
	if (lexicalResolved !== requestedRoot && !lexicalResolved.startsWith(`${requestedRoot}${path.sep}`)) {
		throw new OutputFileError(args.escapeKind, args.escapeMessage(trimmed, requestedRoot));
	}
	if (lexicalResolved === requestedRoot) {
		throw new OutputFileError("empty-name", args.rootMessage(trimmed, requestedRoot));
	}
	return { trimmed, requestedRoot, lexicalResolved };
}

interface FileIdentity {
	dev: number;
	ino: number;
}

function fileIdentity(stat: fs.Stats): FileIdentity {
	return { dev: stat.dev, ino: stat.ino };
}

function sameFileIdentity(a: FileIdentity, b: FileIdentity): boolean {
	return a.dev === b.dev && a.ino === b.ino;
}

function closeFd(fd: number | undefined): void {
	if (fd === undefined) return;
	try {
		fs.closeSync(fd);
	} catch {
		// Preserve the original filesystem error.
	}
}

/**
 * Read an authoritative artifact from `baseDir/name`.
 *
 * The lexical checks keep the artifact name inside the artifact workspace, while canonical-path
 * checks prevent a symlink from redirecting the read outside the artifact workspace.
 * Missing, unreadable, non-file, and empty sources are all hard failures.
 */
export function readOutputFromFile(req: OutputFromFileRequest): ReadOutputFromFile {
	const confined = resolveContainedPath({
		name: req.name,
		baseDir: req.baseDir,
		emptyMessage: `artifact path is empty; looked in the artifact workspace ${path.resolve(req.baseDir)}`,
		absoluteMessage: (name, baseDir) =>
			`artifact path must be relative, got absolute file ${name}; looked in the artifact workspace ${baseDir}`,
		escapeMessage: (name, baseDir) =>
			`artifact file ${name} escapes the artifact workspace ${baseDir}`,
		escapeKind: "outside-scratch-dir",
		rootMessage: (name, baseDir) =>
			`artifact file ${name} resolves to the artifact workspace ${baseDir}; provide a file path`,
	});

	let fd: number | undefined;
	try {
		const canonicalRoot = fs.realpathSync(confined.requestedRoot);
		const canonicalTarget = fs.realpathSync(confined.lexicalResolved);
		if (
			canonicalTarget !== canonicalRoot &&
			!canonicalTarget.startsWith(canonicalRoot + path.sep)
		) {
			throw new OutputFileError(
				"outside-scratch-dir",
				`artifact file ${confined.trimmed} resolves outside the artifact workspace ${confined.requestedRoot}; expected ${confined.lexicalResolved}`,
			);
		}

		const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
		const nonBlock = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
		fd = fs.openSync(canonicalTarget, fs.constants.O_RDONLY | noFollow | nonBlock);
		const opened = fs.fstatSync(fd);
		if (!opened.isFile()) {
			throw new Error(`expected a regular file, found mode ${opened.mode.toString(8)}`);
		}

		// Pin the opened file by descriptor, then re-check the path and identity.
		// A path swap can no longer redirect the bytes read below.
		const revalidatedTarget = fs.realpathSync(confined.lexicalResolved);
		if (
			revalidatedTarget !== canonicalRoot &&
			!revalidatedTarget.startsWith(canonicalRoot + path.sep)
		) {
			throw new OutputFileError(
				"outside-scratch-dir",
				`artifact file ${confined.trimmed} changed to resolve outside the artifact workspace ${confined.requestedRoot}; expected ${confined.lexicalResolved}`,
			);
		}
		const revalidated = fs.statSync(revalidatedTarget);
		if (!sameFileIdentity(fileIdentity(opened), fileIdentity(revalidated))) {
			throw new Error("source file changed while opening");
		}

		const data = fs.readFileSync(fd);
		if (data.byteLength === 0) {
			throw new OutputFileError(
				"empty-content",
				`artifact file ${confined.trimmed} is empty; expected ${confined.lexicalResolved} in the artifact workspace ${confined.requestedRoot}`,
			);
		}
		return {
			absolutePath: confined.lexicalResolved,
			bytes: data.byteLength,
			content: data.toString("utf-8"),
		};
	} catch (error) {
		if (error instanceof OutputFileError) throw error;
		throw new OutputFileError(
			"read-failed",
			`failed to read artifact file ${confined.trimmed}; expected ${confined.lexicalResolved} in the artifact workspace ${confined.requestedRoot}: ${errorMessage(error)}`,
		);
	} finally {
		closeFd(fd);
	}
}

/**
 * Resolve / create the per-run chain artifact directory.
 *
 * Layout: `<tmpdir>/pi-delegate-<scope>/chain-runs/<runId>/`
 *
 * `scope` lets us isolate test runs from production runs (test code uses
 * `"test"`, the extension uses `"main"`). The directory is created on
 * demand and never deleted by `prepareChainDir` itself — the
 * `sweepOldChainDirs` helper handles cleanup based on age.
 */
export function prepareChainDir(args: {
	runId: string;
	scope?: string;
	root?: string;
}): string {
	// determinism-contract:allow — a chain's steps must FIND each other's
	// outputs, so this root is deliberately stable and shared, not scratch.
	const root = args.root ?? path.join(os.tmpdir(), `pi-delegate-${args.scope ?? "main"}`);
	const dir = path.join(root, "chain-runs", args.runId);
	ensureOwnerOnlyDirectory(dir);
	return dir;
}

/**
 * Delete `chain-runs/*` subdirectories older than `maxAgeMs` (default 24 h).
 * Best-effort: any error on a single dir is logged and ignored.
 *
 * Returns the number of directories actually removed.
 */
export function sweepOldChainDirs(args: {
	scope?: string;
	root?: string;
	maxAgeMs?: number;
	now?: number;
}): number {
	// determinism-contract:allow — a chain's steps must FIND each other's
	// outputs, so this root is deliberately stable and shared, not scratch.
	const root = args.root ?? path.join(os.tmpdir(), `pi-delegate-${args.scope ?? "main"}`);
	const runsRoot = path.join(root, "chain-runs");
	if (!fs.existsSync(runsRoot)) return 0;
	const maxAgeMs = args.maxAgeMs ?? 24 * 60 * 60 * 1000;
	const cutoff = (args.now ?? Date.now()) - maxAgeMs;
	let removed = 0;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(runsRoot, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const full = path.join(runsRoot, entry.name);
		try {
			const stat = fs.statSync(full);
			if (stat.mtimeMs < cutoff) {
				fs.rmSync(full, { recursive: true, force: true });
				removed++;
			}
		} catch {
			/* swallow; best-effort */
		}
	}
	return removed;
}

export interface PrepareWorkerScratchDirArgs {
	scope?: string;
	root?: string;
	/** Remove temporary contents recursively when the allocating runner releases its lease. */
	recursiveCleanup?: boolean;
}

function registerWorkerScratchLeaf(leaf: string, runsRoot: string, recursiveCleanup = false): string {
	const resolvedRunsRoot = verifyWorkerScratchRunsRoot(runsRoot);
	if (resolvedRunsRoot === undefined) {
		throw new Error(`worker scratch parent is not a trusted directory: ${runsRoot}`);
	}
	workerScratchParentIdentities.set(resolvedRunsRoot.path, resolvedRunsRoot);
	const resolvedLeaf = path.resolve(leaf);
	if (path.dirname(resolvedLeaf) === resolvedRunsRoot.path) {
		const leafStat = fs.lstatSync(resolvedLeaf);
		if (leafStat.isDirectory() && !leafStat.isSymbolicLink()) {
			workerScratchRegistrations.set(resolvedLeaf, {
				leaf: resolvedLeaf,
				leafIdentity: fileIdentity(leafStat),
				runsRoot: resolvedRunsRoot,
				recursiveCleanup,
				leases: 0,
			});
		}
	}
	return leaf;
}

/** Allocate an isolated scratch directory for one in-process worker. */
export function prepareWorkerScratchDir(args: PrepareWorkerScratchDirArgs): string {
	// determinism-contract:allow — this is only the scoped parent; mkdtempSync
	// below creates the unique worker leaf.
	const root = args.root ?? path.join(os.tmpdir(), `pi-delegate-${args.scope ?? "main"}`);
	const runsRoot = path.join(root, "worker-runs");
	ensureOwnerOnlyDirectory(runsRoot);
	maybeSweepOldWorkerScratchDirs(path.resolve(root));
	const leaf = workerScratchLeafAllocator(path.join(runsRoot, "worker-"));
	return registerWorkerScratchLeaf(leaf, runsRoot, args.recursiveCleanup === true);
}

function workerScratchDirectoryIdentity(candidate: string): Readonly<FileIdentity> | undefined {
	try {
		const stat = fs.lstatSync(candidate);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
		return fileIdentity(stat);
	} catch {
		return undefined;
	}
}

function removeStaleWorkerScratchCandidate(args: {
	candidate: string;
	candidateIdentity: Readonly<FileIdentity>;
	runsRoot: string;
	runsRootIdentity: WorkerScratchRunsRootIdentity;
}): boolean {
	const stillTrusted = (): boolean => {
		if (verifyWorkerScratchRunsRoot(args.runsRoot, args.runsRootIdentity) === undefined) return false;
		const identity = workerScratchDirectoryIdentity(args.candidate);
		return identity !== undefined && sameFileIdentity(identity, args.candidateIdentity);
	};
	if (!stillTrusted()) return false;
	try {
		// Empty stale leaves are the common case. Non-recursive removal avoids
		// traversing anything a concurrent process may have introduced beneath it.
		fs.rmdirSync(args.candidate);
		return true;
	} catch (error) {
		if (errorCode(error) !== "ENOTEMPTY" && errorCode(error) !== "EEXIST") return false;
	}
	if (!stillTrusted()) return false;
	try {
		// Stale artifacts remain recoverable by the 24-hour policy. Node exposes no
		// directory-handle-relative recursive delete, so a same-UID pathname swap
		// after this final identity check remains a narrow residual race.
		fs.rmSync(args.candidate, { recursive: true });
		return true;
	} catch {
		return false;
	}
}

/** Delete stale worker scratch directories, best effort, using the chain-run age policy. */
export function sweepOldWorkerScratchDirs(args: {
	scope?: string;
	root?: string;
	maxAgeMs?: number;
	now?: number;
}): number {
	// determinism-contract:allow — worker-runs is a scoped parent; entries are
	// unique mkdtemp leaves and are swept by age.
	const root = args.root ?? path.join(os.tmpdir(), `pi-delegate-${args.scope ?? "main"}`);
	const runsRoot = path.join(root, "worker-runs");
	const runsRootIdentity = verifyWorkerScratchRunsRoot(
		runsRoot,
		workerScratchParentIdentities.get(path.resolve(runsRoot)),
	);
	if (runsRootIdentity === undefined) return 0;
	const maxAgeMs = args.maxAgeMs ?? 24 * 60 * 60 * 1000;
	const cutoff = (args.now ?? Date.now()) - maxAgeMs;
	let removed = 0;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(runsRoot, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		try {
			const full = path.resolve(runsRoot, entry.name);
			if (path.dirname(full) !== runsRootIdentity.path) continue;
			const registration = workerScratchRegistrations.get(full);
			if (registration && registration.leases !== 0) continue;
			const stat = fs.lstatSync(full);
			if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mtimeMs >= cutoff) continue;
			if (!removeStaleWorkerScratchCandidate({
				candidate: full,
				candidateIdentity: fileIdentity(stat),
				runsRoot,
				runsRootIdentity,
			})) continue;
			if (registration) retireWorkerScratchRegistration(registration);
			removed++;
		} catch {
			/* swallow; best effort */
		}
	}
	return removed;
}
