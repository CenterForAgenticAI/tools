import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionFactory,
	ExtensionHandler,
	SessionShutdownEvent,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { logDelegateDiagnostic, type DelegateDiagnosticOptions } from "./diagnostics.js";
import { acquireWorkerScratchCleanupLease, prepareWorkerScratchDir } from "./output-file.js";
import {
	loadProjectConfig,
	matchesArtifactNameException,
	PROJECT_CONFIG_RELATIVE_PATH,
	type ProjectConfigDiagnostic,
} from "./project-config.js";

/** A structured refusal produced by an enforced per-slot policy. */
export interface PolicyRefusal {
	boundary: "readOnly" | "writableRoot";
	toolName: "write" | "edit" | "bash";
	reason: string;
}

/** Absolute roots the worker may write to, including lexical and realpath forms. */
export interface WriteConfinementPolicy {
	roots: readonly string[];
	/** The assigned worker cwd/worktree, for refusal messages. */
	primaryRoot: string;
	/** The unique temporary directory granted to this worker. */
	scratchRoot?: string;
	/** Declared artifact name used by the repository-pollution guard. */
	artifact?: string;
	/** Roots that remain writable by write/edit when readOnly is true. */
	readonly artifactRoots?: readonly string[];
	/**
	 * Directories whose IMMEDIATE-CHILD files are writable, but whose nested
	 * subdirectories are not. Used to tolerate the common worker miss of writing a
	 * file directly into its scratch parent (`runs/<file>`) one level above the
	 * granted scratch leaf, without exposing sibling workers' private leaves under
	 * the same parent. Only trusted, we-allocated scratch parents are ever placed
	 * here; stored in lexical and realpath forms.
	 */
	readonly shallowRoots?: readonly string[];
	/** Independent per-slot read-only boundary. */
	readOnly?: boolean;
	/** Case classification keyed by canonical root. */
	readonly caseInsensitiveRoots?: ReadonlyMap<string, boolean>;
	/** Optional sink used by the live extension to retain structured refusals. */
	onRefusal?: (refusal: PolicyRefusal) => void;
	/** Optional runner sink that takes release ownership instead of a session-shutdown handler. */
	onScratchCleanupLeaseAcquired?: (release: () => void) => void;
	/**
	 * True only when `scratchRoot` was allocated for this policy rather than
	 * supplied by the caller. Cleanup authority follows allocation: a borrowed
	 * root -- one a chain allocated and hands to every step -- must outlive the
	 * worker that merely wrote into it, so the extension never removes it.
	 */
	ownsScratchCleanup?: boolean;
}

/** Named inline extension accepted by DefaultResourceLoader.extensionFactories. */
export interface NamedInlineExtension {
	name: string;
	factory: ExtensionFactory;
}

export interface WriteConfinementExtensionDeps {
	logDiagnostic?: (message: string, options?: DelegateDiagnosticOptions) => void;
}

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
	"log",
	"status",
	"show",
	"diff",
	"rev-parse",
	"rev-list",
	"ls-files",
	"ls-tree",
	"cat-file",
	"describe",
	"blame",
	"for-each-ref",
	"shortlog",
	"grep",
	"merge-base",
	"symbolic-ref",
	"check-ignore",
	"version",
]);

const RESERVED_ARTIFACT_NAMES = new Set(["plan.md", "implementation.md", "review.md", "progress.md", "context.md"]);

const GIT_TARGET_FLAGS = new Set(["-C", "--git-dir", "--work-tree"]);
const GIT_FLAGS_WITH_VALUES = new Set(["-c", "--config-env"]);
const PATCH_DIRECTIVES = [
	"*** Add File: ",
	"*** Update File: ",
	"*** Delete File: ",
	"*** Move to: ",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Unicode space characters Pi's own path normalizer folds to a plain space.
 * Mirrors `UNICODE_SPACES` in the SDK's `utils/paths`.
 */
const UNICODE_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/gu;

/**
 * Mirror of Pi's `resolveToCwd`, which is what the builtin `write`/`edit`
 * tools actually apply to their `path` argument:
 * `resolvePath(input, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true })`.
 *
 * This has to be mirrored rather than imported: the SDK's `exports` map only
 * publishes `.` and `./rpc-entry`, so `utils/paths` is not reachable, and a
 * deep import into `dist/` would break across the supported peer range.
 *
 * Getting this wrong is a containment hole, not a cosmetic difference. A guard
 * that resolved only `~` treated `@/outside/file` as the in-cwd relative path
 * `<cwd>/@/outside/file` while the builtin stripped the `@` and wrote to
 * `/outside/file`. `candidateResolutions` therefore checks the raw spelling as
 * well, so a future divergence in either direction can only refuse more, never
 * silently permit an escape.
 */
function normalizeLikePiTools(value: string): string {
	let normalized = value.replace(UNICODE_SPACES, " ");
	if (normalized.startsWith("@")) normalized = normalized.slice(1);
	if (normalized === "~") return os.homedir();
	if (normalized.startsWith("~/")) {
		return path.join(os.homedir(), normalized.slice(2));
	}
	if (/^file:\/\//u.test(normalized)) {
		try {
			return fileURLToPath(normalized);
		} catch {
			// A malformed file: URL is not a path the builtin can write either;
			// keep the raw spelling so containment still judges something.
			return normalized;
		}
	}
	return normalized;
}

function lexicalPath(candidate: string, cwd: string): string {
	return path.resolve(cwd, normalizeLikePiTools(candidate));
}

/**
 * Every absolute path this argument could denote. All of them must be inside a
 * writable root for the call to proceed.
 */
function candidateResolutions(candidate: string, cwd: string): string[] {
	return unique([lexicalPath(candidate, cwd), path.resolve(cwd, candidate)]);
}

/** Resolve a configured writable-root entry at the dispatch boundary. */
export function resolveWriteConfinementRoot(baseCwd: string, root: string): string {
	return lexicalPath(root, baseCwd);
}

/** Raised when containment cannot be established, so the caller must refuse. */
class UnresolvableTargetError extends Error {}

/** Errors that prove a component does not exist yet, so climbing is sound. */
function isMissingPathError(error: unknown): boolean {
	const code = (error as { code?: unknown } | undefined)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}

/** Bound on manual symlink hops, mirroring the kernel's own loop limit. */
const MAX_SYMLINK_HOPS = 12;

function lstatOrUndefined(target: string): fs.Stats | undefined {
	try {
		return fs.lstatSync(target);
	} catch {
		return undefined;
	}
}

/**
 * Resolve symlinks on the deepest EXISTING ancestor and re-append the missing
 * remainder. Writing a new file is the normal case, so a missing leaf must not
 * refuse — but only a genuinely absent component justifies climbing.
 *
 * Two failure modes this has to separate, because both surface as an error from
 * `realpathSync`:
 *
 *   - A component that truly does not exist. Climb; the write will create it.
 *   - A component that DOES exist but could not be resolved. Refuse.
 *
 * `ENOENT` alone does not distinguish them: a **dangling symlink reports ENOENT
 * even though the link itself exists**, and a write through that link lands on
 * the link's target. Treating it as absent approved exactly the escape this
 * guard exists to stop — an in-root link pointing at a missing out-of-root file
 * was written straight through. So an `ENOENT` component is `lstat`ed, and a
 * surviving symlink is followed manually to judge where the write would land.
 * Any other error (EACCES, ELOOP, EIO) refuses outright.
 */
function realPathWithRemainder(candidate: string): string {
	let current = candidate;
	const remainder: string[] = [];
	let symlinkHops = 0;
	while (true) {
		try {
			const real = fs.realpathSync(current);
			return remainder.length > 0 ? path.resolve(real, ...remainder.reverse()) : real;
		} catch (error) {
			if (!isMissingPathError(error)) {
				throw new UnresolvableTargetError(
					`could not resolve ${current}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			const entry = lstatOrUndefined(current);
			if (entry?.isSymbolicLink()) {
				if (++symlinkHops > MAX_SYMLINK_HOPS) {
					throw new UnresolvableTargetError(`symlink chain too deep at ${current}`);
				}
				let link: string;
				try {
					link = fs.readlinkSync(current);
				} catch (readError) {
					throw new UnresolvableTargetError(
						`could not read link ${current}: ${readError instanceof Error ? readError.message : String(readError)}`,
					);
				}
				// Judge the destination, keeping any remainder already collected.
				current = path.resolve(path.dirname(current), link);
				continue;
			}
			if (entry) {
				throw new UnresolvableTargetError(`${current} exists but could not be resolved`);
			}
			const parent = path.dirname(current);
			if (parent === current) return candidate;
			remainder.push(path.basename(current));
			current = parent;
		}
	}
}

function realRoot(root: string): string {
	try {
		return fs.realpathSync(root);
	} catch {
		return root;
	}
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

const caseSensitivityCache = new Map<string, boolean | undefined>();

/** Test-only cache reset; production callers never need to classify a root twice. */
export function __resetWriteConfinementCaseCacheForTests(): void {
	caseSensitivityCache.clear();
}

/** Test-only override for deterministic sensitive/insensitive filesystem cases. */
export function __setWriteConfinementCaseProbeForTests(
	probe: ((root: string) => boolean | undefined) | undefined,
): () => void {
	const previous = caseProbeOverride;
	caseProbeOverride = probe;
	caseSensitivityCache.clear();
	return () => { caseProbeOverride = previous; caseSensitivityCache.clear(); };
}

let caseProbeOverride: ((root: string) => boolean | undefined) | undefined;

function caseVariant(value: string): string {
	const index = value.search(/[A-Za-z]/u);
	if (index < 0) return `${value}a`;
	const character = value[index]!;
	const replacement = character === character.toUpperCase() ? character.toLowerCase() : character.toUpperCase();
	return `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`;
}

/**
 * Change only a probe's basename. Changing an ancestor would measure the
 * ancestor's case rules rather than the granted root's filesystem.
 */
function caseVariantBasename(probe: string): string {
	return path.join(path.dirname(probe), caseVariant(path.basename(probe)));
}

/** Validate the internal per-slot read-only contract before construction. */
export function assertReadOnlyValue(value: unknown, fieldPath = "readOnly"): value is boolean | undefined {
	if (value === undefined || typeof value === "boolean") return true;
	throw new TypeError(`${fieldPath} must be a boolean when provided; received ${JSON.stringify(value)}`);
}

/**
 * Reject a `readOnly` slot that also grants `writableRoots` inside its own
 * primary root (issue #536).
 *
 * A read-only worker may write only its scratch directory and separate artifact
 * roots: `readOnlyAllowedRoots` drops everything at or under the primary root.
 * A caller who sets both fields has therefore written a grant that cannot take
 * effect, and nothing said so. The dispatch was accepted, the worker did its
 * whole task, and the write was refused at the end -- after which the scratch
 * directory is removed, so the work is unrecoverable.
 *
 * Failing here matches how `detectDirectShape` already reports two conflicting
 * shape selectors: a contradictory request is caller error, and the cheapest
 * honest answer is to refuse it before any model call.
 *
 * A root OUTSIDE the primary root stays valid, because that is the supported
 * way to let a read-only worker emit a file.
 */
export function assertWritableRootsCompatibleWithReadOnly(request: {
	readOnly?: unknown;
	cwd: string;
	writableRoots?: readonly string[];
}): void {
	if (request.readOnly !== true) return;
	const roots = request.writableRoots ?? [];
	if (roots.length === 0) return;
	const primaryRoot = path.resolve(request.cwd);
	const offending = roots.filter((root) => {
		const resolved = path.resolve(primaryRoot, root);
		// At, inside, or containing the primary root: all three are void under
		// readOnly, and an ancestor would re-open it entirely.
		return resolved === primaryRoot
			|| isContained(resolved, primaryRoot, caseInsensitiveForRoot(primaryRoot))
			|| isContained(primaryRoot, resolved, caseInsensitiveForRoot(resolved));
	});
	if (offending.length === 0) return;
	throw new TypeError(
		`readOnly: true cannot be combined with writableRoots inside the worker's own root. ` +
		`A read-only worker may write only its scratch directory and separate artifact roots, ` +
		`so ${offending.join(", ")} would be silently ignored and the write refused after the work was done. ` +
		`Drop readOnly, move the root outside ${primaryRoot}, or set artifact: <name> to return one file.`,
	);
}
function probeCaseInsensitive(root: string): boolean | undefined {
	const canonical = realRoot(root);
	if (caseSensitivityCache.has(canonical)) return caseSensitivityCache.get(canonical);
	if (caseProbeOverride) {
		const overridden = caseProbeOverride(canonical);
		caseSensitivityCache.set(canonical, overridden);
		return overridden;
	}
	let result: boolean | undefined;
	let probe: string | undefined;
	try {
		if (!fs.statSync(canonical).isDirectory()) throw new Error("root is not a directory");
		probe = path.join(canonical, `.pi-case-probe-${process.pid}-${Date.now()}-MiXeD`);
		const fd = fs.openSync(probe, "wx", 0o600);
		fs.closeSync(fd);
		const alternate = caseVariantBasename(probe);
		result = fs.existsSync(alternate);
		// Cleanup is part of the probe contract. A failed cleanup invalidates the
		// observation rather than leaving durable litter in a user's root.
		fs.rmSync(probe, { force: true });
		if (fs.existsSync(probe)) result = undefined;
	} catch {
		result = undefined;
		if (probe) {
			try { fs.rmSync(probe, { force: true }); } catch { result = undefined; }
		}
	}
	caseSensitivityCache.set(canonical, result);
	return result;
}

function caseInsensitiveForRoot(root: string): boolean {
	const probed = probeCaseInsensitive(root);
	if (probed !== undefined) return probed;
	return process.platform === "darwin";
}

function isContained(candidate: string, root: string, caseInsensitive = false): boolean {
	const left = caseInsensitive ? candidate.toLowerCase() : candidate;
	const right = caseInsensitive ? root.toLowerCase() : root;
	if (left === right) return true;
	const prefix = right.endsWith(path.sep) ? right : `${right}${path.sep}`;
	return left.startsWith(prefix);
}

/** Return whether a configured allowed root could contain the primary root. */
function rootContainsPrimaryRoot(root: string, primaryRoot: string): boolean {
	try {
		const lexicalRoot = path.resolve(root);
		const lexicalPrimary = path.resolve(primaryRoot);
		const lexicalCaseInsensitive = caseInsensitiveForRoot(lexicalRoot);
		if (isContained(lexicalPrimary, lexicalRoot, lexicalCaseInsensitive)) return true;
		const canonicalRoot = fs.realpathSync(lexicalRoot);
		const canonicalPrimary = fs.realpathSync(lexicalPrimary);
		return isContained(canonicalPrimary, canonicalRoot, caseInsensitiveForRoot(canonicalRoot));
	} catch {
		// An uncertain relationship must not widen a read-only worker's writes.
		return true;
	}
}

function rootsForInput(workerCwd: string, roots: readonly string[]): { roots: string[]; cases: Map<string, boolean> } {
	const lexicalRoots = roots
		.filter((root): root is string => typeof root === "string" && root.length > 0)
		.map((root) => resolveWriteConfinementRoot(workerCwd, root));
	const allRoots = unique([...lexicalRoots, ...lexicalRoots.map(realRoot)]);
	const cases = new Map<string, boolean>();
	for (const root of allRoots) cases.set(root, caseInsensitiveForRoot(root));
	return { roots: allRoots, cases };
}

/**
 * Build the default worker write policy. Extra roots are resolved relative to
 * the worker cwd here as a defensive fallback; dispatchers normally resolve
 * them against the main-thread cwd before constructing a worker.
 */
export function resolveWriteConfinementPolicy(input: {
	workerCwd: string;
	extraRoots?: readonly string[];
	/** Legacy test seam and explicit broadening; never supplied by runners. */
	tempRoots?: readonly string[];
	scratchRoot?: string;
	artifactRoots?: readonly string[];
	shallowRoots?: readonly string[];
	artifact?: string;
	readOnly?: unknown;
	onRefusal?: (refusal: PolicyRefusal) => void;
	onScratchCleanupLeaseAcquired?: (release: () => void) => void;
	ownsScratchCleanup?: boolean;
}): WriteConfinementPolicy {
	assertReadOnlyValue(input.readOnly);
	const workerCwd = path.resolve(input.workerCwd);
	const lexicalArtifactRoots = [
		...(input.scratchRoot ? [input.scratchRoot] : []),
		...(input.artifactRoots ?? []),
	];
	const lexicalRoots = [
		workerCwd,
		...lexicalArtifactRoots,
		...(input.tempRoots ?? []),
		...(input.extraRoots ?? []),
	];
	const resolved = rootsForInput(workerCwd, lexicalRoots);
	const artifactRoots = rootsForInput(workerCwd, lexicalArtifactRoots).roots;
	// Shallow roots (immediate-child files only) never widen the recursive root
	// set, but their case classification must be known to the guard, so merge it in.
	const shallow = rootsForInput(workerCwd, input.shallowRoots ?? []);
	for (const [root, insensitive] of shallow.cases) resolved.cases.set(root, insensitive);
	return {
		roots: resolved.roots,
		primaryRoot: workerCwd,
		...(input.scratchRoot ? { scratchRoot: path.resolve(input.scratchRoot) } : {}),
		...(input.artifact ? { artifact: input.artifact } : {}),
		...(artifactRoots.length > 0 ? { artifactRoots } : {}),
		...(shallow.roots.length > 0 ? { shallowRoots: shallow.roots } : {}),
		...(input.readOnly !== undefined ? { readOnly: input.readOnly as boolean } : {}),
		caseInsensitiveRoots: resolved.cases,
		onRefusal: input.onRefusal,
		onScratchCleanupLeaseAcquired: input.onScratchCleanupLeaseAcquired,
		...(input.ownsScratchCleanup ? { ownsScratchCleanup: true } : {}),
	};
}

/**
 * Resolve the write authority a worker runs under, from its request.
 *
 * Shared by the direct and supervised worker runners so the default-on rule and
 * the opt-out diagnostic exist once rather than twice. Returning `undefined`
 * means no guard is installed, which is only reachable through an explicit
 * `confineWrites: false`.
 */
export function resolveWorkerWriteAuthority(
	request: {
		name: string;
		cwd: string;
		agentDir?: string;
		confineWrites?: boolean;
		writableRoots?: readonly string[];
		artifactRoots?: readonly string[];
		shallowRoots?: readonly string[];
		scratchRoot?: string;
		artifact?: string;
		readOnly?: unknown;
		onRefusal?: (refusal: PolicyRefusal) => void;
		onScratchCleanupLeaseAcquired?: (release: () => void) => void;
	},
	onDiagnostic: (message: string, options?: DelegateDiagnosticOptions) => void = logDelegateDiagnostic,
): WriteConfinementPolicy | undefined {
	assertReadOnlyValue(request.readOnly);
	// Refuse a grant that readOnly would void, before any model call (#536).
	assertWritableRootsCompatibleWithReadOnly({ readOnly: request.readOnly, cwd: request.cwd, writableRoots: request.writableRoots });
	if (request.confineWrites === false && request.readOnly !== true) {
		onDiagnostic(
			`worker ${request.name} explicitly disabled writable-root confinement`,
			{ agentDir: request.agentDir, throttleKey: `write-confinement-disabled:${request.name}` }
		);
		return undefined;
	}
	// Both runners allocate the leaf and pass it in, so they keep cleanup
	// authority. This fallback is the only case where the policy allocates, and
	// therefore the only case where the extension may remove the directory.
	const ownsScratchCleanup = request.scratchRoot === undefined;
	const scratchRoot = request.scratchRoot ?? prepareWorkerScratchDir({ scope: "main" });
	return resolveWriteConfinementPolicy({
		workerCwd: request.cwd,
		extraRoots: request.writableRoots,
		artifactRoots: request.artifactRoots,
		shallowRoots: request.shallowRoots,
		scratchRoot,
		artifact: request.artifact,
		ownsScratchCleanup,
		readOnly: request.readOnly,
		onRefusal: request.onRefusal,
		onScratchCleanupLeaseAcquired: request.onScratchCleanupLeaseAcquired,
	});
}

/**
 * Containment test for an already-absolute path, used by the nested-delegate
 * clamp to check a child's requested cwd and roots against the caller's.
 *
 * Absolute input only: a relative value is judged against the filesystem root,
 * which fails closed rather than silently checking the wrong directory. Callers
 * resolve first.
 */
export function isPathWithinRoots(absolutePath: string, policy: WriteConfinementPolicy): boolean {
	return isWritablePath(absolutePath, policy, path.parse(absolutePath).root || path.sep);
}

/** Return whether a path is inside an allowed root in both lexical and realpath space. */
export function isWritablePath(candidate: string, policy: WriteConfinementPolicy, cwd: string): boolean {
	if (typeof candidate !== "string" || candidate.length === 0) return false;
	try {
		return candidateResolutions(candidate, cwd).every((resolved) => {
			const real = realPathWithRemainder(resolved);
			return policy.roots.some((root) => isContained(
				resolved,
				root,
				policy.caseInsensitiveRoots?.get(root) ?? caseInsensitiveForRoot(root),
			)) && policy.roots.some((root) => isContained(
				real,
				root,
				policy.caseInsensitiveRoots?.get(root) ?? caseInsensitiveForRoot(root),
			));
		});
	} catch {
		return false;
	}
}

function sameDirectory(left: string, right: string, caseInsensitive: boolean): boolean {
	return caseInsensitive ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Whether a target is an IMMEDIATE-CHILD file of a shallow root. Shallow roots
 * tolerate the common miss of writing a file directly into the scratch parent
 * (`runs/<file>`), one level above the granted scratch leaf, without exposing a
 * sibling worker's private leaf under the same parent: `runs/<other-leaf>/file`
 * has a parent one level too deep and is refused. Judged in both lexical and
 * realpath space, like isWritablePath, so a symlinked child that escapes the
 * parent is refused rather than followed through.
 */
function isShallowChildWritable(
	candidate: string,
	shallowRoots: readonly string[],
	policy: WriteConfinementPolicy,
	cwd: string,
): boolean {
	if (shallowRoots.length === 0) return false;
	if (typeof candidate !== "string" || candidate.length === 0) return false;
	try {
		return candidateResolutions(candidate, cwd).every((resolved) => {
			const matches = (parent: string): boolean =>
				shallowRoots.some((root) => sameDirectory(
					parent,
					root,
					policy.caseInsensitiveRoots?.get(root) ?? caseInsensitiveForRoot(root),
				));
			return matches(path.dirname(resolved)) && matches(path.dirname(realPathWithRemainder(resolved)));
		});
	} catch {
		return false;
	}
}

/**
 * Shallow roots a slot may use. A read-only slot excludes any that sit inside a
 * Git tree or that could contain the primary root, mirroring readOnlyAllowedRoots;
 * in practice shallow roots are always temporary scratch parents, so this only
 * hardens against future misuse.
 */
function shallowRootsForPolicy(policy: WriteConfinementPolicy, readOnly: boolean): readonly string[] {
	const shallow = policy.shallowRoots ?? [];
	if (!readOnly) return shallow;
	return shallow
		.filter((root) => !rootContainsPrimaryRoot(root, policy.primaryRoot))
		.filter((root) => !rootIsInsideGitTree(root));
}

function addTarget(targets: string[], value: unknown): void {
	if (typeof value !== "string" || value.length === 0 || targets.includes(value)) return;
	targets.push(value);
}

/** Extract path-like targets from builtin and builtin-replacing write tools. */
export function writeTargetsForToolCall(toolName: string, input: unknown): string[] {
	if (toolName !== "write" && toolName !== "edit") return [];
	if (!isRecord(input)) return [];
	const targets: string[] = [];
	addTarget(targets, input.path);
	addTarget(targets, input.file_path);
	if (Array.isArray(input.multi)) {
		for (const item of input.multi) {
			if (isRecord(item)) addTarget(targets, item.path);
		}
	}
	if (typeof input.patch === "string") {
		for (const line of input.patch.split(/\r?\n/u)) {
			for (const directive of PATCH_DIRECTIVES) {
				if (line.startsWith(directive)) {
					addTarget(targets, line.slice(directive.length).trim());
					break;
				}
			}
		}
	}
	return targets;
}

interface SimpleCommandSegment {
	command: string;
	pipedInput: boolean;
}

function splitSimpleCommandSegments(command: string): SimpleCommandSegment[] {
	const commands: SimpleCommandSegment[] = [];
	let start = 0;
	let pipedInput = false;
	let quote: "'" | '"' | undefined;
	const push = (end: number, nextPipedInput: boolean): void => {
		commands.push({ command: command.slice(start, end), pipedInput });
		start = end + 1;
		pipedInput = nextPipedInput;
	};
	for (let index = 0; index < command.length; index++) {
		const character = command[index]!;
		if (character === "\\" && quote !== "'") {
			index++;
			continue;
		}
		if ((character === "'" || character === '"')) {
			if (quote === undefined) quote = character;
			else if (quote === character) quote = undefined;
			continue;
		}
		if (quote !== undefined) continue;
		if (character === ";" || character === "\n") {
			push(index, false);
			continue;
		}
		if (character === "&" && command[index + 1] === "&") {
			push(index, false);
			index++;
			start++;
			continue;
		}
		if (character === "&" && command[index + 1] !== ">" && command[index - 1] !== ">") {
			push(index, false);
			continue;
		}
		if (character === "|" && command[index + 1] === "|") {
			push(index, false);
			index++;
			start++;
			continue;
		}
		if (character === "|" && command[index + 1] === "&") {
			push(index, true);
			index++;
			start++;
			continue;
		}
		if (character === "|") push(index, true);
	}
	commands.push({ command: command.slice(start), pipedInput });
	return commands;
}

function splitSimpleCommands(command: string): string[] {
	return splitSimpleCommandSegments(command).map((segment) => segment.command);
}

function shellWords(command: string): string[] {
	const words: string[] = [];
	let word = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	const flush = () => {
		if (word.length > 0) words.push(word);
		word = "";
	};
	for (const character of command.trim()) {
		if (escaped) {
			word += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (character === "'" || character === '"') {
			if (quote === undefined) quote = character;
			else if (quote === character) quote = undefined;
			else word += character;
			continue;
		}
		if (quote === undefined && /\s/u.test(character)) flush();
		else word += character;
	}
	if (escaped) word += "\\";
	flush();
	return words;
}

/** Shell executable basename with grouping and attached-input syntax removed. */
function shellExecutableBasename(value: string): string {
	return path.basename(value).replace(/^[({]+/u, "").split("<", 1)[0]!.replace(/[)}]+$/u, "");
}

const SHELL_CONTROL_FLOW_PREFIXES = new Set([
	"if", "then", "else", "elif", "while", "until", "do", "!",
]);

interface ShellExecutionWrapperSpec {
	shortOptionsWithValues?: string;
	longOptionsWithValues?: ReadonlySet<string>;
	requiredPositionalsBeforeCommand?: number;
	optionalNumericPositionalBeforeCommand?: boolean;
	mutatingOutputShortOptions?: string;
	mutatingOutputLongOptions?: ReadonlySet<string>;
	refusedShortOptions?: string;
	refusedLongOptions?: ReadonlySet<string>;
	nonExecutingShortOptions?: string;
	nonExecutingLongOptions?: ReadonlySet<string>;
}

/** Wrappers that execute the command remaining after their own arguments. */
const SHELL_EXECUTION_WRAPPERS: ReadonlyMap<string, ShellExecutionWrapperSpec> = new Map([
	["builtin", {}],
	["command", {}],
	["exec", { shortOptionsWithValues: "a", longOptionsWithValues: new Set(["--argv0"]) }],
	["nohup", {}],
	["nice", { shortOptionsWithValues: "n", longOptionsWithValues: new Set(["--adjustment"]) }],
	["ionice", { shortOptionsWithValues: "cnpPu", longOptionsWithValues: new Set(["--class", "--classdata", "--pid", "--pgid", "--uid"]) }],
	["setsid", {}],
	["stdbuf", { shortOptionsWithValues: "ioe", longOptionsWithValues: new Set(["--input", "--output", "--error"]) }],
	["chrt", {
		shortOptionsWithValues: "TPD",
		longOptionsWithValues: new Set(["--sched-runtime", "--sched-period", "--sched-deadline"]),
		optionalNumericPositionalBeforeCommand: true,
	}],
	["taskset", { requiredPositionalsBeforeCommand: 1 }],
	["timeout", { shortOptionsWithValues: "ks", longOptionsWithValues: new Set(["--kill-after", "--signal"]), requiredPositionalsBeforeCommand: 1 }],
	["sudo", {
		shortOptionsWithValues: "CDcghpRrTtUu",
		longOptionsWithValues: new Set([
			"--close-from", "--chdir", "--login-class", "--group", "--host", "--prompt", "--chroot",
			"--role", "--command-timeout", "--type", "--other-user", "--user",
		]),
		refusedShortOptions: "eis",
		refusedLongOptions: new Set(["--edit", "--login", "--shell"]),
		nonExecutingShortOptions: "lVv",
		nonExecutingLongOptions: new Set(["--list", "--validate", "--version"]),
	}],
	["doas", {
		shortOptionsWithValues: "Cua",
		refusedShortOptions: "s",
		nonExecutingShortOptions: "C",
	}],
	["time", {
		shortOptionsWithValues: "fo",
		longOptionsWithValues: new Set(["--format", "--output"]),
		mutatingOutputShortOptions: "o",
		mutatingOutputLongOptions: new Set(["--output"]),
	}],
]);

const ENV_EXECUTION_WRAPPER_SPEC: ShellExecutionWrapperSpec = {
	shortOptionsWithValues: "uCfPaS",
	longOptionsWithValues: new Set(["--unset", "--chdir", "--file", "--argv0"]),
};

interface ShellWrapperOptionAnalysis {
	consumesNextValue: boolean;
	mutatesOutput: boolean;
	refused: boolean;
	nonExecuting: boolean;
}

function longShellOptionMatches(word: string, candidates: ReadonlySet<string> | undefined): boolean {
	if (!candidates) return false;
	const name = word.split("=", 1)[0]!;
	return [...candidates].some((candidate) => candidate.startsWith(name));
}

function analyzeShellWrapperOption(word: string, spec: ShellExecutionWrapperSpec): ShellWrapperOptionAnalysis {
	if (word.startsWith("--")) {
		return {
			consumesNextValue: !word.includes("=") && longShellOptionMatches(word, spec.longOptionsWithValues),
			mutatesOutput: longShellOptionMatches(word, spec.mutatingOutputLongOptions),
			refused: longShellOptionMatches(word, spec.refusedLongOptions),
			nonExecuting: longShellOptionMatches(word, spec.nonExecutingLongOptions),
		};
	}
	const shortOptionsWithValues = spec.shortOptionsWithValues ?? "";
	const mutatingOutputShortOptions = spec.mutatingOutputShortOptions ?? "";
	const refusedShortOptions = spec.refusedShortOptions ?? "";
	const nonExecutingShortOptions = spec.nonExecutingShortOptions ?? "";
	let mutatesOutput = false;
	let refused = false;
	let nonExecuting = false;
	for (let index = 1; index < word.length; index++) {
		const option = word[index]!;
		mutatesOutput ||= mutatingOutputShortOptions.includes(option);
		refused ||= refusedShortOptions.includes(option);
		nonExecuting ||= nonExecutingShortOptions.includes(option);
		if (!shortOptionsWithValues.includes(option)) continue;
		return { consumesNextValue: index === word.length - 1, mutatesOutput, refused, nonExecuting };
	}
	return { consumesNextValue: false, mutatesOutput, refused, nonExecuting };
}

interface ConsumedShellExecutionWrapper {
	commandIndex: number;
	mutatingOutputOption?: string;
	refusedOption?: string;
}

function consumeShellExecutionWrapper(
	words: readonly string[],
	wrapperIndex: number,
	spec: ShellExecutionWrapperSpec,
): ConsumedShellExecutionWrapper {
	let index = wrapperIndex + 1;
	let requiredPositionals = spec.requiredPositionalsBeforeCommand ?? 0;
	let optionalNumericPositional = spec.optionalNumericPositionalBeforeCommand === true;
	let options = true;
	let mutatingOutputOption: string | undefined;
	let refusedOption: string | undefined;
	let nonExecuting = false;
	while (index < words.length) {
		const word = words[index]!;
		if (options && word === "--") { index++; options = false; continue; }
		if (options && word.startsWith("-") && word !== "-") {
			const option = analyzeShellWrapperOption(word, spec);
			if (option.mutatesOutput) mutatingOutputOption = word;
			if (option.refused) refusedOption = word;
			nonExecuting ||= option.nonExecuting;
			index++;
			if (option.consumesNextValue && index < words.length) index++;
			continue;
		}
		if (requiredPositionals > 0) { requiredPositionals--; index++; continue; }
		if (optionalNumericPositional && /^\d+$/u.test(word)) {
			optionalNumericPositional = false;
			index++;
			continue;
		}
		break;
	}
	return {
		commandIndex: nonExecuting ? words.length : index,
		...(mutatingOutputOption ? { mutatingOutputOption } : {}),
		...(refusedOption ? { refusedOption } : {}),
	};
}

type ShellWrapperOptionReporter = (wrapper: string, option: string) => void;

/** Remove assignments, control-flow words, and wrappers to reveal a simple command's executable. */
function shellCommandWords(
	inputWords: readonly string[],
	reportOutput?: ShellWrapperOptionReporter,
	reportRefused?: ShellWrapperOptionReporter,
): string[] {
	const words = [...inputWords];
	let index = 0;
	while (index < words.length) {
		while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[index]!)) index++;
		const rawExecutable = words[index] ?? "";
		const executable = shellExecutableBasename(rawExecutable);
		if (executable === "" && /^[(){}]+$/u.test(rawExecutable)) { index++; continue; }
		const closesLeadingGroup = rawExecutable.startsWith("(") || words.slice(0, index).some((word) => /^\(+$/u.test(word));
		const attachedAfterClose = rawExecutable.indexOf(")");
		if (attachedAfterClose >= 0 && !rawExecutable.includes("<") && !closesLeadingGroup) {
			const attachedCommand = rawExecutable.slice(attachedAfterClose + 1);
			if (attachedCommand) words[index] = attachedCommand;
			else index++;
			continue;
		}
		if (/^\(\)\{$/u.test(words[index + 1] ?? "")) { index += 2; continue; }
		if (words[index + 1] === "()" && /^[{(]/u.test(words[index + 2] ?? "")) { index += 2; continue; }
		if (executable === "function") { index += 2; continue; }
		if (executable === "coproc") {
			index++;
			if (!/^[{(]/u.test(words[index] ?? "") && /^[{(]/u.test(words[index + 1] ?? "")) index++;
			continue;
		}
		if (executable === "case") {
			const inIndex = words.indexOf("in", index + 1);
			if (inIndex < 0) break;
			index = inIndex + 1;
			while (index < words.length && !words[index]!.includes(")")) index++;
			if (index < words.length) {
				const pattern = words[index]!;
				const attachedCommand = pattern.slice(pattern.indexOf(")") + 1);
				if (attachedCommand) words[index] = attachedCommand;
				else index++;
			}
			continue;
		}
		if (SHELL_CONTROL_FLOW_PREFIXES.has(executable)) { index++; continue; }
		if (executable === "env") {
			index++;
			while (index < words.length) {
				const word = words[index]!;
				if (word === "--") { index++; break; }
				if (word === "-") { index++; continue; }
				if (word.startsWith("-")) {
					const option = analyzeShellWrapperOption(word, ENV_EXECUTION_WRAPPER_SPEC);
					index++;
					if (option.consumesNextValue && index < words.length) index++;
					continue;
				}
				if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(word)) { index++; continue; }
				break;
			}
			continue;
		}
		const wrapper = SHELL_EXECUTION_WRAPPERS.get(executable);
		if (!wrapper) break;
		const consumed = consumeShellExecutionWrapper(words, index, wrapper);
		if (consumed.mutatingOutputOption) reportOutput?.(executable, consumed.mutatingOutputOption);
		if (consumed.refusedOption) reportRefused?.(executable, consumed.refusedOption);
		index = consumed.commandIndex;
	}
	return words.slice(index);
}

function isGitExecutable(value: string): boolean {
	return value === "git" || path.basename(value) === "git";
}

function resolveGitTarget(value: string, cwd: string): string | undefined {
	if (!value) return undefined;
	return lexicalPath(value, cwd);
}

function parseGitSimpleCommand(tokens: string[], cwd: string): { targets: string[]; subcommand?: string } | undefined {
	let index = 0;
	const targets: string[] = [];
	let commandCwd = cwd;
	// Consume EVERY leading shell assignment, not just the git ones: with only
	// `GIT_*` recognised, an unrelated prefix such as `LC_ALL=C GIT_DIR=…` hid
	// the git target completely.
	while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index]!)) {
		const assignment = tokens[index]!;
		const equals = assignment.indexOf("=");
		if (/^(?:GIT_DIR|GIT_WORK_TREE)$/u.test(assignment.slice(0, equals))) {
			const target = resolveGitTarget(assignment.slice(equals + 1), commandCwd);
			if (target) targets.push(target);
		}
		index++;
	}
	// `env [-i] [-u NAME] NAME=value... git ...` is a plain git invocation with a
	// wrapper in front of it; without this the whole command went unrecognised.
	if (index < tokens.length && path.basename(tokens[index]!) === "env") {
		index++;
		while (index < tokens.length) {
			const token = tokens[index]!;
			if (token === "-i" || token === "--ignore-environment" || token === "-") {
				index++;
				continue;
			}
			if (token === "-u" || token === "--unset") {
				index += 2;
				continue;
			}
			if (token === "--") {
				index++;
				break;
			}
			const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/su.exec(token);
			if (!assignment) break;
			if (assignment[1] === "GIT_DIR" || assignment[1] === "GIT_WORK_TREE") {
				const target = resolveGitTarget(assignment[2]!, commandCwd);
				if (target) targets.push(target);
			}
			index++;
		}
	}
	if (index >= tokens.length || !isGitExecutable(tokens[index]!)) return undefined;
	index++;
	while (index < tokens.length) {
		const token = tokens[index]!;
		if (token === "--") break;
		if (GIT_TARGET_FLAGS.has(token)) {
			const value = tokens[index + 1];
			if (value === undefined) break;
			const target = resolveGitTarget(value, commandCwd);
			if (target) targets.push(target);
			if (token === "-C") commandCwd = target ?? commandCwd;
			index += 2;
			continue;
		}
		let matchedAttached = false;
		for (const flag of ["--git-dir=", "--work-tree="]) {
			if (token.startsWith(flag)) {
				const target = resolveGitTarget(token.slice(flag.length), commandCwd);
				if (target) targets.push(target);
				matchedAttached = true;
				break;
			}
		}
		if (matchedAttached) {
			index++;
			continue;
		}
		if (token.startsWith("-C") && token.length > 2) {
			const target = resolveGitTarget(token.slice(2), commandCwd);
			if (target) {
				targets.push(target);
				commandCwd = target;
			}
			index++;
			continue;
		}
		if (GIT_FLAGS_WITH_VALUES.has(token)) {
			index += 2;
			continue;
		}
		if (token.startsWith("-")) {
			index++;
			continue;
		}
		return { targets, subcommand: token };
	}
	return { targets };
}

/**
 * True when a git target still contains shell syntax this parser cannot
 * evaluate. `git -C "$PARENT" commit` is a real escape route, so an
 * unevaluatable target on a mutating subcommand is refused rather than assumed
 * benign. Read-only subcommands are unaffected, which keeps the common
 * `git -C "$REPO" log` idiom working.
 */
function hasUnevaluatedExpansion(value: string): boolean {
	return /[$`]/u.test(value);
}

/** Return explicit, out-of-root git targets from mutating bash commands. */
export function outOfRootGitTargets(command: string, policy: WriteConfinementPolicy, cwd: string): string[] {
	if (typeof command !== "string") return [];
	const offending: string[] = [];
	for (const simpleCommand of splitSimpleCommands(command)) {
		const parsed = parseGitSimpleCommand(shellWords(simpleCommand), cwd);
		if (!parsed || (parsed.subcommand !== undefined && READ_ONLY_GIT_SUBCOMMANDS.has(parsed.subcommand))) continue;
		for (const target of parsed.targets) {
			const unresolved = hasUnevaluatedExpansion(target);
			if ((unresolved || !isWritablePath(target, policy, cwd)) && !offending.includes(target)) {
				offending.push(target);
			}
		}
	}
	return offending;
}

const READ_ONLY_MUTATING_EXECUTABLES = new Set([
	"rm", "mv", "cp", "tee", "truncate", "dd", "mkdir", "touch", "chmod", "chown", "ln", "install", "sudoedit",
]);
const READ_ONLY_PACKAGE_COMMANDS = new Set([
	"npm install", "npm i", "yarn add", "pnpm add", "pip install", "pip3 install",
]);
const READ_ONLY_INTERPRETERS = new Set([
	"python", "python3", "node", "nodejs", "deno", "bun", "perl", "ruby", "php",
	"Rscript", "osascript", "sh", "bash", "dash", "zsh", "ksh",
]);
const INTERPRETER_INLINE_CODE_FLAGS = ["-c", "-e", "-E", "-r", "-p", "--eval", "--exec", "--print"] as const;

/** Return true for an unquoted shell output redirection. */
interface ShellOutputRedirections {
	found: boolean;
	targets: string[];
}

function readShellWordAt(command: string, start: number): { value: string; end: number } {
	let value = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let index = start;
	for (; index < command.length; index++) {
		const character = command[index]!;
		if (escaped) {
			value += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote !== undefined) {
			if (character === quote) quote = undefined;
			else value += character;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (/\s/u.test(character) || /[;|&<>()]/u.test(character)) break;
		value += character;
	}
	if (escaped) value += "\\";
	return { value, end: index };
}

function shellOutputRedirections(command: string): ShellOutputRedirections {
	const targets: string[] = [];
	let found = false;
	let quote: "'" | '"' | undefined;
	for (let index = 0; index < command.length; index++) {
		const character = command[index]!;
		if (character === "\\" && quote !== "'") { index++; continue; }
		if (character === "'" || character === '"') {
			if (quote === undefined) quote = character;
			else if (quote === character) quote = undefined;
			continue;
		}
		if (quote !== undefined) continue;
		const isFdRedirect = character === ">";
		const isAllFdRedirect = character === "&" && command[index + 1] === ">";
		if (!isFdRedirect && !isAllFdRedirect) continue;
		found = true;
		let targetStart = index + (isAllFdRedirect ? 2 : (command[index + 1] === ">" ? 2 : 1));
		while (/\s/u.test(command[targetStart] ?? "")) targetStart++;
		const target = readShellWordAt(command, targetStart);
		if (target.value) addTarget(targets, target.value);
		index = Math.max(index, target.end - 1);
	}
	return { found, targets };
}

/** Return true for an unquoted shell output redirection. */
function hasOutputRedirection(command: string): boolean {
	return shellOutputRedirections(command).found;
}

function nonOptionShellArguments(words: readonly string[]): string[] {
	const argumentsAfterOptions: string[] = [];
	let options = true;
	for (const word of words) {
		if (options && word === "--") { options = false; continue; }
		if (options && word.startsWith("-")) continue;
		argumentsAfterOptions.push(word);
	}
	return argumentsAfterOptions;
}

function hasShellOption(words: readonly string[], shortOption: string, longOption: string): boolean {
	let options = true;
	for (const word of words) {
		if (options && word === "--") { options = false; continue; }
		if (!options || word === "-" || !word.startsWith("-")) continue;
		if (word.startsWith("--")) {
			if (word.split("=", 1)[0] === longOption) return true;
			continue;
		}
		if (word.slice(1).includes(shortOption)) return true;
	}
	return false;
}

function ddWriteTargets(arguments_: readonly string[]): string[] {
	let effectiveTarget: string | undefined;
	for (const argument of arguments_) {
		const output = /^of=(.*)$/su.exec(argument);
		if (output) effectiveTarget = output[1];
	}
	return effectiveTarget ? [effectiveTarget] : [];
}

function inlineAwkPrograms(arguments_: readonly string[]): string[] {
	const programs: string[] = [];
	let fileProgram = false;
	let options = true;
	for (let index = 0; index < arguments_.length; index++) {
		const argument = arguments_[index]!;
		if (options && argument === "--") { options = false; continue; }
		if (options && (argument === "-f" || argument === "--file")) {
			fileProgram = true;
			index++;
			continue;
		}
		if (options && (/^-f.+/su.test(argument) || argument.startsWith("--file="))) {
			fileProgram = true;
			continue;
		}
		if (options && (argument === "-e" || argument === "--source")) {
			const program = arguments_[index + 1];
			if (program !== undefined) programs.push(program);
			index++;
			continue;
		}
		if (options && argument.startsWith("-e") && argument.length > 2) {
			programs.push(argument.slice(2));
			continue;
		}
		if (options && argument.startsWith("--source=")) {
			programs.push(argument.slice("--source=".length));
			continue;
		}
		if (options && ["-F", "-v", "-W", "--field-separator", "--assign"].includes(argument)) {
			index++;
			continue;
		}
		if (options && argument.startsWith("-")) continue;
		if (!fileProgram) programs.push(argument);
		break;
	}
	return programs;
}

function awkExpressionIsTopLevel(code: string): boolean {
	let parentheses = 0;
	let brackets = 0;
	for (const character of code) {
		if (character === "(") parentheses++;
		else if (character === ")") parentheses--;
		else if (character === "[") brackets++;
		else if (character === "]") brackets--;
	}
	return parentheses === 0 && brackets === 0;
}

function awkRegexCanStart(code: readonly string[], index: number): boolean {
	let previous = index - 1;
	while (previous >= 0 && /[\t\r ]/u.test(code[previous] ?? "")) previous--;
	if (previous < 0 || code[previous] === "\n") return true;
	return /[!,(=:{;~]/u.test(code[previous] ?? "");
}

function maskAwkComments(code: string): string {
	const masked = code.split("");
	let regularExpression = false;
	let characterClass = false;
	let escaped = false;
	for (let index = 0; index < masked.length; index++) {
		const character = masked[index]!;
		if (regularExpression) {
			if (escaped) { escaped = false; continue; }
			if (character === "\\") { escaped = true; continue; }
			if (character === "[") { characterClass = true; continue; }
			if (character === "]") { characterClass = false; continue; }
			if (character === "/" && !characterClass) regularExpression = false;
			continue;
		}
		if (character === "/" && awkRegexCanStart(masked, index)) {
			regularExpression = true;
			continue;
		}
		if (character !== "#") continue;
		while (index < masked.length && masked[index] !== "\n") {
			masked[index] = " ";
			index++;
		}
	}
	return masked.join("");
}

function endOfAwkParenthesizedTarget(
	code: string,
	activeCode: string,
	start: number,
	count: number,
): number | undefined {
	let index = start;
	for (let closing = 0; closing < count; closing++) {
		for (;;) {
			while (/\s/u.test(code[index] ?? "")) index++;
			if (code[index] !== "#" || activeCode[index] !== " ") break;
			while (index < code.length && code[index] !== "\n") index++;
		}
		if (code[index] !== ")") return undefined;
		index++;
	}
	return index;
}

function awkTargetExpressionEndsAt(code: string, activeCode: string, start: number): boolean {
	let index = start;
	while (/[\t\r ]/u.test(code[index] ?? "")) index++;
	if (index >= code.length || code[index] === "\n" || code[index] === ";" || code[index] === "}") return true;
	return code[index] === "#" && activeCode[index] === " ";
}

function staticAwkWriteTargets(code: string): string[] {
	const targets: string[] = [];
	const literals = staticQuotedStrings(code);
	const activeCode = maskAwkComments(maskQuotedStrings(code, literals));
	for (const literal of literals) {
		const beforeLiteral = activeCode.slice(0, literal.start);
		const rawBeforeLiteral = code.slice(0, literal.start);
		const activeRedirect = />>?\s*((?:\(\s*)*)$/u.exec(beforeLiteral);
		const redirect = />>?\s*((?:\(\s*)*)$/u.exec(rawBeforeLiteral);
		if (!activeRedirect || !redirect || activeRedirect.index !== redirect.index) continue;
		const parenthesisCount = [...(redirect[1] ?? "")].filter((character) => character === "(").length;
		const targetEnd = endOfAwkParenthesizedTarget(code, activeCode, literal.end, parenthesisCount);
		if (targetEnd === undefined || !awkTargetExpressionEndsAt(code, activeCode, targetEnd)) continue;
		const previous = beforeLiteral[redirect.index - 1];
		if (previous !== undefined && /[<>=!]/u.test(previous)) continue;
		const statementStart = Math.max(
			beforeLiteral.lastIndexOf(";", redirect.index - 1),
			beforeLiteral.lastIndexOf("\n", redirect.index - 1),
			beforeLiteral.lastIndexOf("{", redirect.index - 1),
			beforeLiteral.lastIndexOf("}", redirect.index - 1),
		) + 1;
		const beforeRedirect = beforeLiteral.slice(statementStart, redirect.index);
		if (!/\b(?:print|printf)\b/u.test(beforeRedirect)) continue;
		if (!awkExpressionIsTopLevel(beforeRedirect)) continue;
		addTarget(targets, literal.value);
	}
	return targets;
}

/** Return common shell-tool paths that need the repository write guard. */
function bashWriteTargets(command: string): string[] {
	const targets = shellOutputRedirections(command).targets;
	for (const simple of splitSimpleCommands(command)) {
		const words = shellCommandWords(shellWords(simple));
		if (words.length === 0) continue;
		const executable = path.basename(words[0]!);
		const toolArguments = words.slice(1);
		const argumentsAfterOptions = nonOptionShellArguments(toolArguments);
		if (executable === "dd") {
			for (const target of ddWriteTargets(toolArguments)) addTarget(targets, target);
			continue;
		}
		if (executable === "awk") {
			for (const program of inlineAwkPrograms(toolArguments)) {
				for (const target of staticAwkWriteTargets(program)) addTarget(targets, target);
			}
			continue;
		}
		if (executable === "tee") {
			for (const target of argumentsAfterOptions) addTarget(targets, target);
			continue;
		}
		const inPlaceSed = executable === "sed" && toolArguments.some((word) =>
			word === "-i" || word.startsWith("-i") || word === "--in-place" || word.startsWith("--in-place="),
		);
		if (inPlaceSed) {
			for (const target of argumentsAfterOptions.slice(1)) addTarget(targets, target);
			continue;
		}
		if (
			executable === "cp" || executable === "mv" || executable === "install" ||
			executable === "ln" || executable === "link"
		) {
			const destination = argumentsAfterOptions[argumentsAfterOptions.length - 1];
			if (destination) addTarget(targets, destination);
			const createsHardlink =
				executable === "link" ||
				(executable === "ln" && !hasShellOption(toolArguments, "s", "--symbolic")) ||
				(executable === "cp" && hasShellOption(toolArguments, "l", "--link"));
			// Known bounded residual (accepted; tracked in #460). This inspects the
			// literal source words of a hardlink-creating command. It cannot see a
			// source that only becomes the protected file AFTER the shell runs -- a
			// glob (`ln .pi/*.json alias`), a command substitution
			// (`ln "$(printf .pi/pi-delegate.json)" alias`), or an interpreter link API
			// (`python3 -c 'os.link(...)'`, `node -e 'fs.linkSync(...)'`) on a WRITABLE
			// worker, which does not receive the readOnly interpreter denylist. This is
			// the same unbounded command-form-denylist evasion class #460 records for
			// the readOnly guard: it blocks the realistic accidental/primed-pollution
			// threat, and the durable fix (an OS read-only mount / sandbox / command
			// allowlist) closes the whole class for writable workers too.
			if (createsHardlink) {
				for (const source of argumentsAfterOptions.slice(0, -1)) addTarget(targets, source);
			}
		}
	}
	return unique(targets);
}

function interpreterName(executable: string): string | undefined {
	const basename = shellExecutableBasename(executable);
	if (READ_ONLY_INTERPRETERS.has(basename)) return basename;
	const withoutVersion = basename.replace(/-?\d+(?:\.\d+)*$/u, "");
	return READ_ONLY_INTERPRETERS.has(withoutVersion) ? basename : undefined;
}

function hasUnquotedShellSubstitution(command: string): boolean {
	let quote: "'" | '"' | undefined;
	for (let index = 0; index < command.length; index++) {
		const character = command[index]!;
		if (character === "\\" && quote !== "'") { index++; continue; }
		if (character === "'" || character === '"') {
			if (quote === undefined) quote = character;
			else if (quote === character) quote = undefined;
			continue;
		}
		if (quote !== "'" && (
			character === "`" ||
			((character === "$" || character === "<" || character === ">") && command[index + 1] === "(")
		)) return true;
	}
	return false;
}

function hasEnvSplitString(words: readonly string[]): boolean {
	for (let index = 0; index < words.length; index++) {
		if (shellExecutableBasename(words[index]!) !== "env") continue;
		return words.slice(index + 1).some((word) =>
			word === "-S" || word.startsWith("-S") || word === "--split-string" || word.startsWith("--split-string="),
		);
	}
	return false;
}

function interpreterCarriesCode(args: readonly string[], command: string, pipedInput: boolean): boolean {
	let afterOptions = false;
	for (const arg of args) {
		if (afterOptions) return true;
		if (arg === "--") { afterOptions = true; continue; }
		if (arg === "-") return true;
		if (!arg.startsWith("-")) return true;
		if (INTERPRETER_INLINE_CODE_FLAGS.some((flag) =>
			arg === flag || (arg.startsWith(`${flag}=`)) || (flag.startsWith("--") ? false : arg.startsWith(flag) && arg.length > flag.length),
		)) return true;
		if (/^-[^-]*[ceErp]/u.test(arg)) return true;
	}
	// A bare interpreter on the receiving side of a pipeline consumes its code
	// from stdin. Redirections and heredocs are also executable input even when
	// the interpreter has no script-path argument.
	return pipedInput || /<{1,3}/u.test(command);
}

const ARTIFACT_NAME_GUARD_INTERPRETERS = new Set(["python", "node", "nodejs", "perl", "ruby"]);

function artifactGuardInterpreterFamily(interpreter: string): string {
	return interpreter.replace(/-?\d+(?:\.\d+)*$/u, "");
}

/** Extract code attached to or following each interpreter's -c/-e/-p flags. */
function inlineInterpreterCode(family: string, args: readonly string[]): string[] {
	const code: string[] = [];
	const shortCodeFlags = family === "python" ? "c" : (family === "node" || family === "nodejs" ? "ep" : "e");
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--") break;
		if (arg.startsWith("--")) {
			const flag = ["--eval", "--exec", "--print"].find((candidate) =>
				arg === candidate || arg.startsWith(`${candidate}=`),
			);
			if (!flag) continue;
			const attached = arg.startsWith(`${flag}=`) ? arg.slice(flag.length + 1) : undefined;
			const value = attached ?? args[index + 1];
			if (value !== undefined) code.push(value);
			if (attached === undefined) index++;
			continue;
		}
		if (!arg.startsWith("-") || arg === "-") continue;
		for (let optionIndex = 1; optionIndex < arg.length; optionIndex++) {
			if (!shortCodeFlags.includes(arg[optionIndex]!)) continue;
			const attached = arg.slice(optionIndex + 1).replace(/^=/u, "");
			// In a Node `-pe` cluster, `p` is followed by the real code-taking
			// `e`. Perl's `p` is never code-taking, so both `-pe` and `-p -e`
			// naturally resolve to `e` instead.
			if (attached && [...attached].every((option) => shortCodeFlags.includes(option))) continue;
			const value = attached || args[index + 1];
			if (value !== undefined) code.push(value);
			if (!attached) index++;
			break;
		}
	}
	return code;
}

interface StaticQuotedString {
	value: string;
	start: number;
	end: number;
}

function staticQuotedStrings(code: string): StaticQuotedString[] {
	const values: StaticQuotedString[] = [];
	let quote: "'" | '"' | "`" | undefined;
	let start = 0;
	let value = "";
	let escaped = false;
	for (let index = 0; index < code.length; index++) {
		const character = code[index]!;
		if (quote === undefined) {
			if (character === "'" || character === '"' || character === "`") {
				quote = character;
				start = index;
			}
			continue;
		}
		if (escaped) {
			value += character;
			escaped = false;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (character === quote) {
			values.push({ value, start, end: index + 1 });
			quote = undefined;
			value = "";
			continue;
		}
		value += character;
	}
	return values;
}

function writeModeFollows(code: string, end: number): boolean {
	return /^\s*,\s*(?:mode\s*(?:=|:)\s*)?["'][^"']*[wax+][^"']*["']/u.test(code.slice(end));
}

function maskQuotedStrings(code: string, literals: readonly StaticQuotedString[]): string {
	const masked = code.split("");
	for (const literal of literals) {
		for (let index = literal.start; index < literal.end; index++) masked[index] = " ";
	}
	return masked.join("");
}

function perlWriteMode(value: string): boolean {
	return /^(?:>{1,2}|\+<|<\+|\+>{1,2})(?::.*)?$/u.test(value.trim());
}

function perlTwoArgumentWriteTarget(value: string): string | undefined {
	const match = /^(?:>{1,2}|\+<|<\+|\+>{1,2})\s*(.+)$/su.exec(value);
	return match?.[1];
}

function pythonOpenWritesLiteral(
	code: string,
	unquotedCode: string,
	literals: readonly StaticQuotedString[],
	literal: StaticQuotedString,
): boolean {
	const staticStringPrefix = "(?:[rubf]{1,2})?";
	const beforeLiteral = unquotedCode.slice(0, literal.start);
	let argumentStart: number | undefined;
	for (const match of beforeLiteral.matchAll(/\bopen\s*\(/gu)) {
		const candidate = match.index + match[0].length;
		if (!unquotedCode.slice(candidate, literal.start).includes(")")) argumentStart = candidate;
	}
	if (argumentStart === undefined) return false;
	const callStart = argumentStart;
	const callEnd = unquotedCode.indexOf(")", literal.end);
	if (callEnd < 0) return false;

	const beforeTarget = unquotedCode.slice(callStart, literal.start);
	const firstPositional = new RegExp(`^\\s*${staticStringPrefix}$`, "iu").test(beforeTarget);
	const namedFile = new RegExp(`(?:^|,)\\s*file\\s*=\\s*${staticStringPrefix}$`, "iu").test(beforeTarget);
	if (!firstPositional && !namedFile) return false;
	if (firstPositional && writeModeFollows(code, literal.end)) return true;

	return literals.some((candidate) => {
		if (candidate.start < callStart || candidate.end > callEnd) return false;
		const beforeMode = unquotedCode.slice(callStart, candidate.start);
		const namedMode = new RegExp(`(?:^|,)\\s*mode\\s*=\\s*${staticStringPrefix}$`, "iu");
		return namedMode.test(beforeMode) && /[wax+]/u.test(candidate.value);
	});
}

function staticInterpreterWriteTargets(family: string, code: string): string[] {
	const targets: string[] = [];
	const literals = staticQuotedStrings(code);
	const unquotedCode = maskQuotedStrings(code, literals);
	for (const literal of literals) {
		const before = code.slice(0, literal.start);
		const after = code.slice(literal.end);
		let target: string | undefined;
		if (family === "python") {
			const pathlib = /\bPath\s*\(\s*(?:[rubf]{1,2})?$/iu;
			if (pythonOpenWritesLiteral(code, unquotedCode, literals, literal)) target = literal.value;
			else if (pathlib.test(before) && /^\s*\)\s*\.\s*(?:write_text|write_bytes|touch)\s*\(/u.test(after)) target = literal.value;
		} else if (family === "node" || family === "nodejs") {
			if (/\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream)\s*\(\s*$/u.test(before)) target = literal.value;
		} else if (family === "perl") {
			const statementStart = Math.max(
				unquotedCode.lastIndexOf(";", literal.start - 1),
				unquotedCode.lastIndexOf("\n", literal.start - 1),
			) + 1;
			const statementBefore = unquotedCode.slice(statementStart, literal.start);
			if (/\bopen\b/u.test(statementBefore)) {
				const priorLiterals = literals.filter((candidate) =>
					candidate.start >= statementStart && candidate.end <= literal.start,
				);
				const priorMode = priorLiterals.at(-1)?.value;
				if (priorMode !== undefined && perlWriteMode(priorMode)) target = literal.value;
				else if (priorLiterals.length === 0) target = perlTwoArgumentWriteTarget(literal.value);
			}
		} else {
			if (/\b(?:File\.write|IO\.write)\s*\(\s*$/u.test(before)) target = literal.value;
			else if (/\bFile\.open\s*\(\s*$/u.test(before) && writeModeFollows(code, literal.end)) target = literal.value;
		}
		if (target) addTarget(targets, target);
	}
	return unique(targets);
}

/**
 * Best-effort static targets in inline Python, Node, Perl, and Ruby code.
 * Computed/encoded paths and unmodelled write APIs remain outside this name
 * guard; writable-root confinement still controls where the worker may write.
 */
function interpreterArtifactWriteTargets(command: string): string[] {
	const targets: string[] = [];
	for (const segment of splitSimpleCommandSegments(command)) {
		const words = shellCommandWords(shellWords(segment.command));
		if (words.length === 0) continue;
		const interpreter = interpreterName(words[0]!);
		if (!interpreter || !interpreterCarriesCode(words.slice(1), segment.command, segment.pipedInput)) continue;
		const family = artifactGuardInterpreterFamily(interpreter);
		if (!ARTIFACT_NAME_GUARD_INTERPRETERS.has(family)) continue;
		for (const code of inlineInterpreterCode(family, words.slice(1))) {
			for (const target of staticInterpreterWriteTargets(family, code)) addTarget(targets, target);
		}
	}
	return unique(targets);
}

/** Best-effort denylist for obvious mutating commands in a read-only slot. */
export function readOnlyBashRefusal(command: string, cwd = process.cwd()): string | undefined {
	if (typeof command !== "string") return "readOnly bash policy could not classify the command";
	if (hasUnquotedShellSubstitution(command)) return "readOnly bash policy refuses shell command or process substitution";
	for (const simpleCommand of splitSimpleCommandSegments(command)) {
		const simple = simpleCommand.command;
		if (hasOutputRedirection(simple)) return "readOnly bash policy refuses shell output redirection";
		const rawWords = shellWords(simple);
		if (hasEnvSplitString(rawWords)) return "readOnly bash policy refuses env split-string command";
		let wrapperOutput: { wrapper: string; option: string } | undefined;
		let refusedWrapperOption: { wrapper: string; option: string } | undefined;
		const words = shellCommandWords(
			rawWords,
			(wrapper, option) => { wrapperOutput ??= { wrapper, option }; },
			(wrapper, option) => { refusedWrapperOption ??= { wrapper, option }; },
		);
		if (wrapperOutput) {
			return `readOnly bash policy refuses mutating ${wrapperOutput.wrapper} output option ${wrapperOutput.option}`;
		}
		if (refusedWrapperOption) {
			return `readOnly bash policy refuses unsafe ${refusedWrapperOption.wrapper} option ${refusedWrapperOption.option}`;
		}
		if (words.length === 0) continue;
		const executable = path.basename(words[0]!);
		const interpreter = interpreterName(executable);
		if (interpreter && interpreterCarriesCode(words.slice(1), simple, simpleCommand.pipedInput)) {
			return `readOnly bash policy refuses interpreter ${interpreter} with executable code`;
		}
		if (READ_ONLY_MUTATING_EXECUTABLES.has(executable)) {
			return `readOnly bash policy refuses mutating command ${executable}`;
		}
		if (executable === "sed" && words.slice(1).some((word) =>
			word === "-i" || word.startsWith("-i") || word === "--in-place" || word.startsWith("--in-place="),
		)) return "readOnly bash policy refuses in-place sed";
		if (READ_ONLY_PACKAGE_COMMANDS.has([executable, ...words.slice(1, 2)].join(" "))) {
			return `readOnly bash policy refuses package installation ${words.slice(0, 2).join(" ")}`;
		}
		const parsedGit = parseGitSimpleCommand(rawWords, cwd);
		if (parsedGit?.subcommand !== undefined && !READ_ONLY_GIT_SUBCOMMANDS.has(parsedGit.subcommand)) {
			return `readOnly bash policy refuses mutating git subcommand ${parsedGit.subcommand}`;
		}
	}
	return undefined;
}

/** Join roots into a readable "a, b and c" clause for a worker prompt. */
function joinRootsForPrompt(roots: readonly string[]): string {
	if (roots.length <= 1) return roots[0] ?? "";
	return `${roots.slice(0, -1).join(", ")} and ${roots[roots.length - 1]!}`;
}

/** Effective writable roots of a non-read-only policy, primary root first. */
function displayWritableRoots(policy: WriteConfinementPolicy): string[] {
	return unique([policy.primaryRoot, ...policy.roots]);
}

/**
 * The write-scope instruction injected into a delegate worker's prompt.
 *
 * A worker only learns where it may write from this one line, so the wording is
 * load-bearing. The earlier text -- "Worker scratch directory: <path>. Place
 * temporary write/edit paths there." -- framed the scratch dir as a home for
 * *temporary* files and never said the rest of the OS temp directory is refused.
 * A worker producing a durable deliverable it did not consider "temporary" (a
 * design review it would otherwise drop in `/tmp/foo.md`) therefore wrote outside
 * its roots and was blocked, repeatedly, even though the refusal named the
 * scratch dir to retry in. This states the roots positively, names the refusal
 * and that it covers the rest of `/tmp`, and gives the worker somewhere to put a
 * durable file without a caller having to know any of it.
 *
 * The roots named are the *effective* ones, read from the resolved policy, so the
 * text never diverges from what the guard actually enforces:
 *   - `writableRoots` a caller granted are listed, not falsely called refused.
 *   - a `readOnly` worker is told its cwd is NOT writable, because the guard
 *     excludes the primary root and its ancestors for a read-only slot.
 *   - a `confineWrites: false` worker has no policy, so it gets the plain scratch
 *     pointer with no refusal claim -- which would otherwise be a lie.
 * When an `artifact` is declared the free-form "return it in your final message"
 * fallback is dropped, because the artifact contract is that the final message is
 * the handoff, not the deliverable.
 */
export function workerWriteScopeInstruction(params: {
	scratchRoot: string;
	policy: WriteConfinementPolicy | undefined;
	artifact?: string;
}): string {
	const deliverable = params.artifact
		? `\nYour artifact: ${params.artifact}\nWrite that exact path. It is your deliverable.\nYour final message is your handoff, not the artifact.`
		: "";
	if (!params.policy) {
		// Writes are not confined for this worker, so a refusal claim would be a
		// lie. Keep the plain scratch pointer, plus any declared deliverable.
		return `Worker scratch directory: ${params.scratchRoot}. Place temporary write/edit paths there.${deliverable}`;
	}
	const policy = params.policy;
	const scratch = policy.scratchRoot ?? params.scratchRoot;
	const readOnly = policy.readOnly === true;
	const allowed = readOnly ? readOnlyAllowedRoots(policy) : displayWritableRoots(policy);
	// Roots the caller widened with beyond the cwd + scratch the worker always has.
	const extra = unique(allowed.filter((root) => root !== policy.primaryRoot && root !== scratch));
	const extraClause = extra.length > 0 ? `, plus ${joinRootsForPrompt(extra)}` : "";
	const refusal = " Writes anywhere else are refused, including elsewhere under /tmp or the system temp directory.";
	const durableTail = params.artifact
		? deliverable
		: ` If you need to produce a file, such as a report or review you might otherwise drop in /tmp, write it inside your scratch directory ${scratch}, or return it in your final message.`;
	if (readOnly) {
		return (
			`Write scope. This worker is read-only, so its working directory ${policy.primaryRoot} is not writable. ` +
			`You may create or modify files only inside your scratch directory ${scratch}${extraClause}.` +
			` Use the built-in write/edit tools for these files. Mutating bash commands and interpreter scripts are refused even inside scratch.` +
			` If your tool list lacks the needed write/edit tool, ask the dispatcher to grant it; scratch allocation does not add tools.` +
			`${refusal}${durableTail}`
		);
	}
	return (
		`Write scope. You may create or modify files only inside your working directory ${policy.primaryRoot} ` +
		`and your scratch directory ${scratch}${extraClause}.${refusal}${durableTail}`
	);
}

/** Render the short model-facing refusal used by blocked tool calls. */
export function confinementRefusal(
	kind: "path" | "git",
	offending: readonly string[],
	policy: WriteConfinementPolicy,
): string {
	const label = kind === "git" ? "git target" : "path";
	const paths = offending.length > 0 ? offending.join(", ") : "the requested target";
	const otherRoots = unique(policy.roots.filter((root) => root !== policy.primaryRoot));
	const scratch = policy.scratchRoot ? ` Granted scratch directory: ${policy.scratchRoot}.` : "";
	return `Delegate worker refused ${label} outside its assigned writable root: ${paths}. Assigned root: ${policy.primaryRoot}.${scratch} Other allowed roots: ${otherRoots.join(", ") || "(none)"}. Re-issue the call with a path inside ${policy.primaryRoot}, or ask the dispatcher to widen writableRoots.`;
}

/**
 * A guarded tool call whose check itself failed is refused, not allowed. This
 * guard exists because a silent out-of-root write is the defect being removed;
 * allowing the call on an internal error would reintroduce exactly that
 * failure, so the boundary fails closed and the operator gets a diagnostic.
 */
function internalFailureRefusal(toolName: string, policy: WriteConfinementPolicy, detail: string): string {
	const scratch = policy.scratchRoot ? ` Granted scratch directory: ${policy.scratchRoot}.` : "";
	return `Delegate worker refused this ${toolName} call: its writable-root check could not complete (${detail}). Assigned root: ${policy.primaryRoot}.${scratch} The guard fails closed rather than allow an unchecked write; retry with a path inside the assigned root and report the failure if it persists.`;
}

function notifyRefusal(policy: WriteConfinementPolicy, refusal: PolicyRefusal): void {
	try { policy.onRefusal?.(refusal); } catch { /* reporting must not weaken the guard */ }
}

/** Walk upward from a resolved target until a Git worktree marker is found. */
function gitTreeRootForTarget(target: string): string | undefined {
	let current = path.dirname(path.resolve(target));
	while (true) {
		try {
			if (fs.existsSync(path.join(current, ".git"))) return current;
		} catch {
			return undefined;
		}
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}


function declaredArtifactBasename(policy: WriteConfinementPolicy): string | undefined {
	return policy.artifact ? path.basename(policy.artifact.trim()).toLowerCase() : undefined;
}

interface RepositoryWriteGuardTargets {
	trustedProjectConfig: string[];
	artifactNames: string[];
}

function isProjectConfigTarget(target: string, repositoryRoot: string): boolean {
	const relative = path.relative(repositoryRoot, path.resolve(target));
	const caseInsensitive = caseInsensitiveForRoot(repositoryRoot);
	return caseInsensitive
		? relative.toLowerCase() === PROJECT_CONFIG_RELATIVE_PATH.toLowerCase()
		: relative === PROJECT_CONFIG_RELATIVE_PATH;
}

interface FileInodeIdentity {
	dev: bigint;
	ino: bigint;
	nlink: bigint;
	isFile: boolean;
}

function fileInodeIdentity(target: string): FileInodeIdentity | undefined {
	try {
		const stats = fs.statSync(target, { bigint: true });
		return {
			dev: stats.dev,
			ino: stats.ino,
			nlink: stats.nlink,
			isFile: stats.isFile(),
		};
	} catch (error) {
		if (isMissingPathError(error)) return undefined;
		throw new UnresolvableTargetError(
			`could not stat ${target}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function sameInode(left: FileInodeIdentity, right: FileInodeIdentity | undefined): boolean {
	return right !== undefined && left.dev === right.dev && left.ino === right.ino;
}

function policyRepositoryRoots(policy: WriteConfinementPolicy, cwd: string): string[] {
	return unique([cwd, policy.primaryRoot, ...policy.roots].flatMap((root) => {
		const repositoryRoot = gitTreeRootForTarget(path.join(path.resolve(root), ".pi-delegate-inode-probe"));
		return repositoryRoot ? [repositoryRoot] : [];
	}));
}

function matchesTrustedConfigInode(identity: FileInodeIdentity, repositoryRoots: readonly string[]): boolean {
	return repositoryRoots.some((root) => sameInode(
		identity,
		fileInodeIdentity(path.join(root, PROJECT_CONFIG_RELATIVE_PATH)),
	));
}

function projectConfigExceptions(
	repositoryRoot: string,
	exceptionsByRoot: Map<string, readonly string[]>,
	diagnostic: ProjectConfigDiagnostic,
): readonly string[] {
	let exceptions = exceptionsByRoot.get(repositoryRoot);
	if (!exceptions) {
		exceptions = loadProjectConfig(repositoryRoot, diagnostic).artifactNameExceptions;
		exceptionsByRoot.set(repositoryRoot, exceptions);
	}
	return exceptions;
}

function isProtectedArtifactPath(
	target: string,
	repositoryRoot: string,
	names: ReadonlySet<string>,
	exceptionsByRoot: Map<string, readonly string[]>,
	diagnostic: ProjectConfigDiagnostic,
): boolean {
	if (!names.has(path.basename(target).toLowerCase())) return false;
	const exceptions = projectConfigExceptions(repositoryRoot, exceptionsByRoot, diagnostic);
	return !matchesArtifactNameException(path.relative(repositoryRoot, target), exceptions);
}

function matchesProtectedArtifactInode(
	identity: FileInodeIdentity,
	repositoryRoot: string,
	names: ReadonlySet<string>,
	exceptionsByRoot: Map<string, readonly string[]>,
	diagnostic: ProjectConfigDiagnostic,
): boolean {
	const pending = [repositoryRoot];
	while (pending.length > 0) {
		const directory = pending.pop()!;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(directory, { withFileTypes: true });
		} catch (error) {
			if (isMissingPathError(error)) continue;
			throw new UnresolvableTargetError(
				`could not inspect ${directory} for protected hardlinks: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		for (const entry of entries) {
			const target = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === ".git") continue;
				// A nested Git tree owns both its protected names and its exceptions.
				// Inspect it separately rather than applying the containing tree's config.
				const entryRepositoryRoot = gitTreeRootForTarget(
					path.join(target, ".pi-delegate-inode-probe"),
				);
				if (entryRepositoryRoot === repositoryRoot) pending.push(target);
				else if (entryRepositoryRoot && matchesProtectedArtifactInode(
					identity,
					entryRepositoryRoot,
					names,
					exceptionsByRoot,
					diagnostic,
				)) return true;
				continue;
			}
			if (
				isProtectedArtifactPath(target, repositoryRoot, names, exceptionsByRoot, diagnostic) &&
				sameInode(identity, fileInodeIdentity(target))
			) return true;
		}
	}
	return false;
}

function repositoryWriteGuardTargetsForPaths(
	rawTargets: readonly string[],
	policy: WriteConfinementPolicy,
	cwd: string,
	diagnostic: ProjectConfigDiagnostic,
): RepositoryWriteGuardTargets {
	const declared = declaredArtifactBasename(policy);
	const names = new Set([...RESERVED_ARTIFACT_NAMES].map((name) => name.toLowerCase()));
	if (declared) names.add(declared);
	const trustedProjectConfig: string[] = [];
	const artifactNames: string[] = [];
	const exceptionsByRoot = new Map<string, readonly string[]>();
	const configuredRepositoryRoots = policyRepositoryRoots(policy, cwd);
	for (const raw of rawTargets) {
		for (const candidate of candidateResolutions(raw, cwd)) {
			const lexicalRoot = gitTreeRootForTarget(candidate);
			if (lexicalRoot && isProjectConfigTarget(candidate, lexicalRoot)) {
				addTarget(trustedProjectConfig, candidate);
				continue;
			}
			if (lexicalRoot && isProtectedArtifactPath(candidate, lexicalRoot, names, exceptionsByRoot, diagnostic)) {
				addTarget(artifactNames, candidate);
				continue;
			}
			let resolved: string;
			try { resolved = realPathWithRemainder(candidate); } catch { continue; }
			const root = gitTreeRootForTarget(resolved);
			if (root && isProjectConfigTarget(resolved, root)) {
				addTarget(trustedProjectConfig, candidate);
				continue;
			}

			// `realpath` cannot reveal hardlinks: every name is equally canonical. Compare
			// the existing inode to every trusted config reachable by this policy instead.
			// This remains a preflight check because Pi's tool hook cannot hold an fd across
			// the later write; an external inode swap in that interval is an inherent TOCTOU.
			const identity = fileInodeIdentity(resolved);
			const repositoryRoots = unique([
				...configuredRepositoryRoots,
				...(lexicalRoot ? [lexicalRoot] : []),
				...(root ? [root] : []),
			]);
			if (identity && matchesTrustedConfigInode(identity, repositoryRoots)) {
				addTarget(trustedProjectConfig, candidate);
				continue;
			}
			// Hardlinks have no preferred pathname, so inspect every repository the
			// policy can reach only when the target's link count proves aliases exist.
			// The preflight-to-write TOCTOU noted above still applies to this scan.
			if (identity?.isFile && identity.nlink > 1n && repositoryRoots.some((repositoryRoot) =>
				matchesProtectedArtifactInode(identity, repositoryRoot, names, exceptionsByRoot, diagnostic)
			)) {
				addTarget(artifactNames, candidate);
				continue;
			}
			if (!root) continue;
			if (isProtectedArtifactPath(resolved, root, names, exceptionsByRoot, diagnostic)) {
				addTarget(artifactNames, candidate);
			}
		}
	}
	return { trustedProjectConfig, artifactNames };
}

/** Find protected writes inside Git trees before ordinary root checks run. */
function repositoryWriteGuardTargets(
	toolName: "write" | "edit",
	input: unknown,
	policy: WriteConfinementPolicy,
	cwd: string,
	diagnostic: ProjectConfigDiagnostic,
): RepositoryWriteGuardTargets {
	return repositoryWriteGuardTargetsForPaths(
		writeTargetsForToolCall(toolName, input),
		policy,
		cwd,
		diagnostic,
	);
}

/**
 * Find common shell-tool and inline-interpreter writes protected inside a Git
 * worktree. This is an accepted best-effort denylist boundary, not a sandbox.
 * Static `dd of=` operands and awk string-literal output redirections are
 * covered. Dynamic/computed targets and unmodelled interpreter file-open APIs
 * (`os.open`, `fs.openSync`, `sysopen`, and `File.binwrite`) remain accepted
 * residuals that the repository delivery gate must catch.
 */
function repositoryBashWriteGuardTargets(
	command: string,
	policy: WriteConfinementPolicy,
	cwd: string,
	diagnostic: ProjectConfigDiagnostic,
): RepositoryWriteGuardTargets {
	return repositoryWriteGuardTargetsForPaths(
		[...bashWriteTargets(command), ...interpreterArtifactWriteTargets(command)],
		policy,
		cwd,
		diagnostic,
	);
}

function trustedProjectConfigRefusal(targets: readonly string[]): string {
	return `Delegate worker refused filesystem write: ${targets.join(", ")} targets ${PROJECT_CONFIG_RELATIVE_PATH} inside a Git working tree. The artifact-name exceptions config is trusted-source-only and delegate workers cannot create or modify it.`;
}

function repositoryPollutionRefusal(targets: readonly string[], policy: WriteConfinementPolicy): string {
	const destination = policy.artifact && policy.scratchRoot
		? path.resolve(policy.scratchRoot, policy.artifact)
		: "the worker scratch directory";
	return `Delegate worker refused filesystem write: ${targets.join(", ")} uses a reserved artifact filename or a hardlink alias to one inside a Git working tree. Write the declared artifact to ${destination} instead.`;
}


function rootIsInsideGitTree(root: string): boolean {
	return unique([path.resolve(root), realRoot(root)]).some((candidate) =>
		gitTreeRootForTarget(path.join(candidate, ".pi-delegate-readonly-probe")) !== undefined,
	);
}

function readOnlyAllowedRoots(policy: WriteConfinementPolicy): string[] {
	return unique([...(policy.scratchRoot ? [policy.scratchRoot] : []), ...(policy.artifactRoots ?? [])])
		.filter((root) => !rootContainsPrimaryRoot(root, policy.primaryRoot))
		.filter((root) => !rootIsInsideGitTree(root));
}

function readOnlyWritablePath(candidate: string, policy: WriteConfinementPolicy, cwd: string): boolean {
	const allowedRoots = readOnlyAllowedRoots(policy);
	if (allowedRoots.length === 0) return false;
	return isWritablePath(candidate, { ...policy, roots: allowedRoots }, cwd);
}

/** Read a tool name defensively; an unreadable event carries nothing to guard. */
function safeToolName(event: unknown): string | undefined {
	try {
		if (!isRecord(event)) return undefined;
		return typeof event.toolName === "string" ? event.toolName : undefined;
	} catch {
		return undefined;
	}
}

function safeInputCommand(input: unknown): string | undefined {
	if (!isRecord(input) || typeof input.command !== "string") return undefined;
	return input.command;
}

/** Create the last-loaded inline event handler that blocks unsafe write calls. */
export function createWriteConfinementExtension(
	policy: WriteConfinementPolicy,
	deps: WriteConfinementExtensionDeps = {},
): NamedInlineExtension {
	const writeDiagnostic = deps.logDiagnostic ?? logDelegateDiagnostic;
	// Throttling is per worker root, not global: two concurrent lane workers
	// escaping within the same 60s window must each leave a record.
	const diagnosticRoot = policy.scratchRoot ?? policy.primaryRoot;
	const refusalThrottleKey = `write-confinement-refusal:${diagnosticRoot}`;
	const failureThrottleKey = `write-confinement-handler:${diagnosticRoot}`;
	const handleToolCall: ExtensionHandler<ToolCallEvent, ToolCallEventResult> = (event, context) => {
		const toolName = safeToolName(event);
		if (toolName !== "write" && toolName !== "edit" && toolName !== "bash") return undefined;
		try {
			if (toolName === "write" || toolName === "edit") {
				const guarded = repositoryWriteGuardTargets(toolName, event.input, policy, context.cwd, writeDiagnostic);
				if (guarded.trustedProjectConfig.length > 0) {
					const reason = trustedProjectConfigRefusal(guarded.trustedProjectConfig);
					const refusal: PolicyRefusal = { boundary: policy.readOnly === true ? "readOnly" : "writableRoot", toolName, reason };
					notifyRefusal(policy, refusal);
					writeDiagnostic(`trusted project config refusal: ${reason}`, { throttleKey: refusalThrottleKey });
					return { block: true, reason };
				}
				if (guarded.artifactNames.length > 0) {
					const reason = repositoryPollutionRefusal(guarded.artifactNames, policy);
					const refusal: PolicyRefusal = { boundary: policy.readOnly === true ? "readOnly" : "writableRoot", toolName, reason };
					notifyRefusal(policy, refusal);
					writeDiagnostic(`artifact filename refusal: ${reason}`, { throttleKey: refusalThrottleKey });
					return { block: true, reason };
				}
				const targets = writeTargetsForToolCall(toolName, event.input);
				if (policy.readOnly === true && targets.length === 0) {
					const reason = `Delegate worker refused ${toolName}: readOnly slot boundary could not identify a writable target.`;
					const refusal: PolicyRefusal = { boundary: "readOnly", toolName, reason };
					notifyRefusal(policy, refusal);
					writeDiagnostic(`readOnly refusal: ${reason}`, { throttleKey: refusalThrottleKey });
					return { block: true, reason };
				}
				const offending = targets.filter((target) => policy.readOnly === true
					? (!readOnlyWritablePath(target, policy, context.cwd)
						&& !isShallowChildWritable(target, shallowRootsForPolicy(policy, true), policy, context.cwd))
					: (!isWritablePath(target, policy, context.cwd)
						&& !isShallowChildWritable(target, shallowRootsForPolicy(policy, false), policy, context.cwd)));
				if (offending.length > 0) {
					const reason = policy.readOnly === true
						? `Delegate worker refused ${toolName}: readOnly slot boundary permits writes only inside ${readOnlyAllowedRoots(policy).join(", ") || "the granted artifact roots"}.`
						: confinementRefusal("path", offending, policy);
					const refusal: PolicyRefusal = { boundary: policy.readOnly === true ? "readOnly" : "writableRoot", toolName, reason };
					notifyRefusal(policy, refusal);
					writeDiagnostic(`${policy.readOnly === true ? "readOnly" : "write-confinement"} refusal: ${reason}`, { throttleKey: refusalThrottleKey });
					return { block: true, reason };
				}
			}
			if (toolName === "bash") {
				const command = safeInputCommand(event.input) ?? "";
				const guarded = repositoryBashWriteGuardTargets(command, policy, context.cwd, writeDiagnostic);
				if (guarded.trustedProjectConfig.length > 0) {
					const reason = trustedProjectConfigRefusal(guarded.trustedProjectConfig);
					const refusal: PolicyRefusal = { boundary: policy.readOnly === true ? "readOnly" : "writableRoot", toolName: "bash", reason };
					notifyRefusal(policy, refusal);
					writeDiagnostic(`trusted project config refusal: ${reason}`, { throttleKey: refusalThrottleKey });
					return { block: true, reason };
				}
				if (guarded.artifactNames.length > 0) {
					const reason = repositoryPollutionRefusal(guarded.artifactNames, policy);
					const refusal: PolicyRefusal = { boundary: policy.readOnly === true ? "readOnly" : "writableRoot", toolName: "bash", reason };
					notifyRefusal(policy, refusal);
					writeDiagnostic(`${policy.readOnly === true ? "readOnly" : "artifact filename"} refusal: ${reason}`, { throttleKey: refusalThrottleKey });
					return { block: true, reason };
				}
				if (policy.readOnly === true) {
					const readOnlyReason = readOnlyBashRefusal(command, context.cwd);
					if (readOnlyReason) {
						const reason = `Delegate worker refused bash: ${readOnlyReason}; boundary=readOnly.`;
						const refusal: PolicyRefusal = { boundary: "readOnly", toolName: "bash", reason };
						notifyRefusal(policy, refusal);
						writeDiagnostic(`readOnly refusal: ${reason}`, { throttleKey: refusalThrottleKey });
						return { block: true, reason };
					}
				}
				const offending = outOfRootGitTargets(safeInputCommand(event.input) ?? "", policy, context.cwd);
				if (offending.length > 0) {
					const reason = confinementRefusal("git", offending, policy);
					const refusal: PolicyRefusal = { boundary: "writableRoot", toolName: "bash", reason };
					notifyRefusal(policy, refusal);
					writeDiagnostic(`write-confinement refusal: ${reason}`, { throttleKey: refusalThrottleKey });
					return { block: true, reason };
				}
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			const reason = internalFailureRefusal(toolName, policy, detail);
			notifyRefusal(policy, {
				boundary: policy.readOnly === true ? "readOnly" : "writableRoot",
				toolName: toolName as "write" | "edit" | "bash",
				reason,
			});
			writeDiagnostic(`write-confinement check failed for ${toolName}; refusing the call: ${detail}`, {
				throttleKey: failureThrottleKey,
			});
			return { block: true, reason };
		}
		return undefined;
	};
	return {
		name: "write-confinement",
		factory: (pi) => {
			// Never lease a borrowed root: releasing it would remove a directory the
			// allocator, and any later chain step, still owns.
			const releaseScratchLease = policy.ownsScratchCleanup && policy.scratchRoot
				? acquireWorkerScratchCleanupLease(policy.scratchRoot)
				: undefined;
			pi.on("tool_call", handleToolCall);
			if (releaseScratchLease) {
				if (policy.onScratchCleanupLeaseAcquired) {
					try {
						policy.onScratchCleanupLeaseAcquired(releaseScratchLease);
					} catch (error) {
						releaseScratchLease();
						throw error;
					}
				} else {
					const handleSessionShutdown: ExtensionHandler<SessionShutdownEvent> = () => {
						releaseScratchLease();
					};
					pi.on("session_shutdown", handleSessionShutdown);
				}
			}
		},
	};
}
