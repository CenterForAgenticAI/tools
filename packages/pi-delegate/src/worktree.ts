// Copied from pi-subagents@0.17.1 with minor adjustments; see that package for history.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { logDelegateDiagnostic } from "./diagnostics.js";
import type { EnvOverrides } from "./env-overrides.js";

export interface WorktreeSetup {
	agentDir?: string;
	cwd: string;
	worktrees: WorktreeInfo[];
	baseCommit: string;
	/**
	 * Issue #5 — worktree paths whose diff capture FAILED (vs legitimately
	 * empty). Populated by `diffWorktrees`, honored by `cleanupWorktrees`:
	 * a worktree whose changes could not be captured into a patch is
	 * PRESERVED on disk (skipped by cleanup) instead of force-removed, so a
	 * capture failure can never destroy the only copy of the work.
	 */
	diffCaptureFailedPaths?: string[];
	/**
	 * Scratch directory that holds this run's worktrees, one level above them.
	 *
	 * Allocated with `mkdtemp` per `createWorktrees` call, so two runs that
	 * derive the same `pi-fork-worktree-<runId>-<index>` leaf never collide and
	 * a run that dies before cleanup cannot occupy a path a later run wants.
	 * Absent when a registered provider supplied every worktree — those paths
	 * belong to the provider, and removing their parent is not ours to do.
	 */
	scratchRoot?: string;
}

export interface WorktreeInfo {
	path: string;
	agentCwd: string;
	branch: string;
	index: number;
	nodeModulesLinked: boolean;
	syntheticPaths: string[];
	/** Run-local git configuration additions used by workers in this worktree. */
	gitEnv?: EnvOverrides;
	/** Temporary exclude file owned by this worktree and removed during cleanup. */
	gitExcludeFile?: string;
}

export interface WorktreeDiff {
	index: number;
	agent: string;
	branch: string;
	diffStat: string;
	filesChanged: number;
	insertions: number;
	deletions: number;
	patchPath: string;
	/**
	 * Set when patch capture failed. The patch is then empty and cleanup
	 * preserves the worktree, which may hold the only copy of the work.
	 */
	captureFailed?: true;
	/** Preserved worktree to recover manually; present only with `captureFailed`. */
	worktreePath?: string;
}

/** Caller-visible manual-recovery guidance for a failed patch capture. */
export function formatWorktreeCaptureFailureGuidance(diff: Pick<WorktreeDiff, "branch" | "worktreePath">): string {
	return `worktree patch capture failed; uncommitted work was PRESERVED in ${diff.worktreePath ?? "the isolated worktree"} ` +
		`(branch ${diff.branch}). Recover it manually (for example \`git -C ${diff.worktreePath ?? "<worktree>"} status\` and copy or commit the changes), ` +
		"then remove the worktree and branch.";
}

export interface WorktreeTaskCwdConflict {
	index: number;
	agent: string;
	cwd: string;
}

export interface WorktreeSetupHookConfig {
	hookPath: string;
	timeoutMs?: number;
}

export interface CreateWorktreesOptions {
	agentDir?: string;
	agents?: string[];
	setupHook?: WorktreeSetupHookConfig;
}

// ---------------------------------------------------------------------------
// Worktree provider hook (spec 0109)
// ---------------------------------------------------------------------------

/**
 * Request shape passed to an external worktree provider.
 * The provider decides whether to supply a custom WorktreeInfo
 * (e.g. graft’s per-spec worktree) or return null to fall through
 * to the default OS-tmp behaviour.
 */
export interface WorktreeRequest {
	toplevel: string;
	runId: string;
	index: number;
	specId?: string;
	role?: string;
}

/**
 * A synchronous callback that, given a WorktreeRequest, either
 * returns a fully-populated WorktreeInfo (provider supplies the
 * worktree) or null (fall through to OS-tmp default).
 *
 * If the provider throws, the error propagates verbatim —
 * pi-delegate does NOT silently fall back to OS-tmp (REQ-FAIL-LOUD).
 */
export type WorktreeProvider = (request: WorktreeRequest) => WorktreeInfo | null;

/**
 * PROVIDER CONTRACT addendum (issue #5):
 * - When EVERY run is provider-handled, the default path's clean-tree gate
 *   is BYPASSED (deliberate — e.g. graft repos carry dirty journal state).
 *   The provider owns cleanliness validation for its own worktrees.
 * - Returned info is validated by `validateWorktreeInfo`: the path must be
 *   absolute and must not be the repo toplevel, an ancestor of it, or the
 *   filesystem root; `agentCwd` must live inside the worktree. Violations
 *   throw (fail-loud), because these paths are later targets of
 *   `git worktree remove --force`.
 * - Cleanup only ever removes paths that `git worktree list` reports as
 *   LINKED worktrees of the repo, and only force-deletes branches matching
 *   the delegate naming scheme (`pi-fork-*`) — a provider-owned branch is
 *   left alone (the provider owns its branch lifecycle).
 */

/**
 * Validate a provider-supplied WorktreeInfo before it enters the setup (and
 * therefore before its path can ever reach `git worktree remove --force` in
 * cleanup). Throws with a descriptive message on violation (REQ-FAIL-LOUD).
 * Exported so providers can self-check (issue #5).
 */
export function validateWorktreeInfo(info: WorktreeInfo, toplevel: string): void {
	const fail = (why: string): never => {
		throw new Error(
			`worktree provider returned an unsafe WorktreeInfo (${why}): ${JSON.stringify({
				path: info?.path,
				agentCwd: info?.agentCwd,
				branch: info?.branch,
			})}`,
		);
	};
	if (!info || typeof info.path !== "string" || info.path.trim() === "") fail("missing path");
	if (!path.isAbsolute(info.path)) fail("path must be absolute");
	if (typeof info.branch !== "string" || info.branch.trim() === "") fail("missing branch");
	const realPath = resolveRealPath(info.path);
	const realTop = resolveRealPath(toplevel);
	if (realPath === path.parse(realPath).root) fail("path is the filesystem root");
	if (realPath === realTop) fail("path is the repo toplevel (the main checkout)");
	if (realTop.startsWith(realPath + path.sep)) fail("path contains the repo toplevel");
	// A worktree NESTED inside the toplevel (e.g. <repo>/.worktrees/spec-1) is
	// deliberately ALLOWED — it is the canonical provider layout (graft-style
	// per-spec worktrees) and the cleanup-side linked-worktree guard already
	// ensures such a path is only ever removed when git itself reports it as a
	// linked worktree (never the main checkout).
	if (typeof info.agentCwd !== "string" || info.agentCwd.trim() === "") fail("missing agentCwd");
	const realAgentCwd = resolveRealPath(info.agentCwd);
	if (realAgentCwd !== realPath && !realAgentCwd.startsWith(realPath + path.sep)) {
		fail("agentCwd escapes the worktree");
	}
}

/** realpath when the path exists, plain resolve otherwise (best-effort). */
function resolveRealPath(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}

let _worktreeProvider: WorktreeProvider | null = null;

/**
 * Register an external worktree provider. When registered,
 * `createSingleWorktree` consults the provider before falling back
 * to OS-tmp worktree creation.
 *
 * **cwd precedence (REQ-CWD-PRECEDENCE):** When the caller passes an
 * explicit `cwd:` on a delegate call, the provider is NOT consulted.
 * That check happens at the call-site in fork-runner.ts / direct-runner.ts,
 * not inside worktree.ts.
 */
export function registerWorktreeProvider(provider: WorktreeProvider): void {
	_worktreeProvider = provider;
}

/**
 * Clear any registered provider (for test cleanup).
 * @internal — exported only for test use.
 */
export function clearWorktreeProvider(): void {
	_worktreeProvider = null;
}

interface ResolvedWorktreeSetupHook {
	hookPath: string;
	timeoutMs: number;
}

interface WorktreeSetupHookInput {
	version: 1;
	repoRoot: string;
	worktreePath: string;
	agentCwd: string;
	branch: string;
	index: number;
	runId: string;
	baseCommit: string;
	agent?: string;
}

interface WorktreeSetupHookOutput {
	syntheticPaths?: string[];
}

interface GitResult {
	stdout: string;
	stderr: string;
	status: number | null;
}

interface RepoState {
	toplevel: string;
	cwdRelative: string;
	baseCommit: string;
}

const DEFAULT_WORKTREE_SETUP_HOOK_TIMEOUT_MS = 30000;

function runGit(cwd: string, args: string[]): GitResult {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		status: result.status,
	};
}

/**
 * Return only the environment entries needed to append a run-local
 * `core.excludesFile` config entry. Existing GIT_CONFIG_* entries remain in
 * the inherited environment and are deliberately not replaced.
 *
 * Worker processes inherit the orchestrator's `process.env`; the call sites
 * merge this patch after caller overrides, reserving the appended slot for the
 * delegate exclusion entry.
 */
export function buildWorktreeGitEnv(
	excludeFile: string,
	baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const rawCount = baseEnv.GIT_CONFIG_COUNT;
	const count = rawCount === undefined ? 0 : Number(rawCount);
	if (!Number.isInteger(count) || count < 0) {
		throw new Error(`invalid GIT_CONFIG_COUNT: ${JSON.stringify(rawCount)}`);
	}
	return {
		GIT_CONFIG_COUNT: String(count + 1),
		[`GIT_CONFIG_KEY_${count}`]: "core.excludesFile",
		[`GIT_CONFIG_VALUE_${count}`]: excludeFile,
	};
}

function runGitChecked(cwd: string, args: string[]): string {
	const result = runGit(cwd, args);
	if (result.status !== 0) {
		const command = `git -C ${cwd} ${args.join(" ")}`;
		const message = result.stderr.trim() || result.stdout.trim() || `${command} failed`;
		throw new Error(message);
	}
	return result.stdout;
}

function resolveRepoState(cwd: string): RepoState {
	const repoCheck = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (repoCheck.status !== 0 || repoCheck.stdout.trim() !== "true") {
		throw new Error("worktree isolation requires a git repository");
	}

	const toplevel = runGitChecked(cwd, ["rev-parse", "--show-toplevel"]).trim();
	const rawPrefix = runGitChecked(cwd, ["rev-parse", "--show-prefix"]).trim();
	const normalizedPrefix = rawPrefix
		? path.normalize(rawPrefix.replace(/[\\/]+$/, ""))
		: "";
	const cwdRelative = normalizedPrefix === "." ? "" : normalizedPrefix;

	const status = runGitChecked(toplevel, ["status", "--porcelain"]);
	if (status.trim().length > 0) {
		throw new Error("worktree isolation requires a clean git working tree. Commit or stash changes first.");
	}

	const baseCommit = runGitChecked(toplevel, ["rev-parse", "HEAD"]).trim();
	return { toplevel, cwdRelative, baseCommit };
}

function normalizeComparableCwd(cwd: string): string {
	const resolved = path.resolve(cwd);
	try {
		return fs.realpathSync(resolved);
	} catch {
		// Use the unresolved absolute path when realpath resolution is unavailable.
		return resolved;
	}
}

export function findWorktreeTaskCwdConflict(
	tasks: ReadonlyArray<{ agent: string; cwd?: string }>,
	sharedCwd: string,
): WorktreeTaskCwdConflict | undefined {
	const normalizedSharedCwd = normalizeComparableCwd(sharedCwd);
	for (let index = 0; index < tasks.length; index++) {
		const task = tasks[index]!;
		if (!task.cwd) continue;
		const taskCwd = path.isAbsolute(task.cwd) ? task.cwd : path.resolve(sharedCwd, task.cwd);
		if (normalizeComparableCwd(taskCwd) === normalizedSharedCwd) continue;
		return { index, agent: task.agent, cwd: task.cwd };
	}
	return undefined;
}

export function formatWorktreeTaskCwdConflict(
	conflict: WorktreeTaskCwdConflict,
	sharedCwd: string,
): string {
	return `worktree isolation uses the shared cwd (${sharedCwd}); task ${conflict.index + 1} (${conflict.agent}) sets cwd to ${conflict.cwd}. Remove task-level cwd overrides or disable worktree.`;
}

function safePatchAgentName(agent: string): string {
	return agent.replace(/[^\w.-]/g, "_");
}

function buildWorktreeBranch(runId: string, index: number): string {
	return `pi-fork-${runId}-${index}`;
}

/**
 * Allocate the scratch directory this run's worktrees live under.
 *
 * `mkdtemp` rather than a name derived from the run: a run id is not unique
 * enough to own an absolute path in a shared temp directory. Two runs on one
 * machine used the same one and the second failed with `fatal: '<path>' already
 * exists`, and a run killed before cleanup left the path occupied for every
 * later run until someone cleared it by hand.
 */
function createWorktreeScratchRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-fork-worktrees-"));
}

/**
 * Path of one worktree inside this run's scratch root. The run-derived leaf
 * stays — it is what makes a stray directory identifiable — it just no longer
 * has to be unique on its own.
 */
function buildWorktreePath(scratchRoot: string, runId: string, index: number): string {
	return path.join(scratchRoot, `pi-fork-worktree-${runId}-${index}`);
}

/**
 * Allocate the directory a run writes its per-task patches into.
 *
 * Same rule as the worktrees themselves, for the same reason, but a separate
 * directory: these patches OUTLIVE cleanup — `formatWorktreeDiffSummary` prints
 * the path for the operator to open — so they cannot live inside the scratch
 * root that cleanup removes.
 */
export function createWorktreeDiffsDir(runId: string, prefix = "pi-fork-diffs"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-${runId}-`));
}

/**
 * Remove the scratch root once its worktrees are gone. Best-effort and
 * non-recursive in spirit: a preserved worktree (diff capture failed) leaves
 * the directory non-empty, and `rmdir` failing on that is the correct outcome —
 * the preserved work stays reachable at the path the diagnostic printed.
 */
function removeWorktreeScratchRoot(scratchRoot: string | undefined): void {
	if (!scratchRoot) return;
	try {
		fs.rmdirSync(scratchRoot);
	} catch {
		// Non-empty (preserved worktree) or already gone; either way, leave it.
	}
}

function linkNodeModulesIfPresent(toplevel: string, worktreePath: string): boolean {
	const nodeModulesPath = path.join(toplevel, "node_modules");
	const nodeModulesLinkPath = path.join(worktreePath, "node_modules");
	if (!fs.existsSync(nodeModulesPath) || fs.existsSync(nodeModulesLinkPath)) return false;
	try {
		fs.symlinkSync(nodeModulesPath, nodeModulesLinkPath);
		return true;
	} catch {
		// Symlink creation is optional (e.g., unsupported filesystems on CI runners).
		return false;
	}
}

function createGitExcludeFile(): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-delegate-git-exclude-"));
	return path.join(directory, "exclude");
}

function writeGitExcludeFile(excludeFile: string, syntheticPaths: string[]): void {
	const patterns = [...new Set(syntheticPaths)].map((syntheticPath) => {
		const gitPath = syntheticPath.split(path.sep).join("/");
		return `/${gitPath}`;
	});
	fs.writeFileSync(excludeFile, patterns.length > 0 ? `${patterns.join("\n")}\n` : "", "utf-8");
}

function removeGitExcludeFile(excludeFile: string | undefined): void {
	if (!excludeFile) return;
	try {
		fs.rmSync(path.dirname(excludeFile), { recursive: true, force: true });
	} catch {
		// Best effort; this file is outside the consumer repository.
	}
}

function parseHookTimeout(timeoutMs: number | undefined): number {
	if (timeoutMs === undefined) return DEFAULT_WORKTREE_SETUP_HOOK_TIMEOUT_MS;
	if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
		throw new Error("worktree setup hook timeout must be an integer greater than 0");
	}
	return timeoutMs;
}

function resolveWorktreeSetupHook(
	repoRoot: string,
	config: WorktreeSetupHookConfig | undefined,
): ResolvedWorktreeSetupHook | undefined {
	if (!config) return undefined;
	const hookPath = config.hookPath.trim();
	if (!hookPath) {
		throw new Error("worktree setup hook path cannot be empty");
	}

	const expandedHookPath = hookPath.startsWith("~/") ? path.join(os.homedir(), hookPath.slice(2)) : hookPath;
	let resolvedPath: string;
	if (path.isAbsolute(expandedHookPath)) {
		resolvedPath = expandedHookPath;
	} else if (expandedHookPath.includes("/") || expandedHookPath.includes("\\")) {
		resolvedPath = path.resolve(repoRoot, expandedHookPath);
	} else {
		throw new Error("worktree setup hook must be an absolute path or a repo-relative path");
	}

	if (!fs.existsSync(resolvedPath)) {
		throw new Error(`worktree setup hook not found: ${resolvedPath}`);
	}
	if (fs.statSync(resolvedPath).isDirectory()) {
		throw new Error(`worktree setup hook must be a file, got directory: ${resolvedPath}`);
	}

	return {
		hookPath: resolvedPath,
		timeoutMs: parseHookTimeout(config.timeoutMs),
	};
}

function normalizeSyntheticPath(worktreePath: string, rawPath: string): string {
	const trimmed = rawPath.trim();
	if (!trimmed) throw new Error("synthetic path cannot be empty");
	if (path.isAbsolute(trimmed)) throw new Error(`synthetic path must be relative: ${rawPath}`);

	const resolved = path.resolve(worktreePath, trimmed);
	const relative = path.relative(worktreePath, resolved);
	if (!relative || relative === ".") {
		throw new Error(`synthetic path cannot target the worktree root: ${rawPath}`);
	}
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`synthetic path escapes the worktree root: ${rawPath}`);
	}
	return path.normalize(relative);
}

function hasTrackedEntries(worktreePath: string, relativePath: string): boolean {
	const result = runGit(worktreePath, ["ls-files", "--", relativePath]);
	return result.status === 0 && result.stdout.trim().length > 0;
}

function parseWorktreeSetupHookOutput(rawStdout: string): WorktreeSetupHookOutput {
	const trimmed = rawStdout.trim();
	if (!trimmed) {
		throw new Error("worktree setup hook returned empty stdout; expected JSON object");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`worktree setup hook returned invalid JSON: ${message}`, { cause: error });
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("worktree setup hook stdout must be a JSON object");
	}
	return parsed as WorktreeSetupHookOutput;
}

function runWorktreeSetupHook(
	hook: ResolvedWorktreeSetupHook,
	input: WorktreeSetupHookInput,
	gitEnv: EnvOverrides,
): string[] {
	const result = spawnSync(hook.hookPath, [], {
		cwd: input.worktreePath,
		encoding: "utf-8",
		input: JSON.stringify(input),
		timeout: hook.timeoutMs,
		shell: false,
		env: { ...process.env, ...gitEnv },
	});

	if (result.error) {
		const code = "code" in result.error ? result.error.code : undefined;
		if (code === "ETIMEDOUT") {
			throw new Error(`worktree setup hook timed out after ${hook.timeoutMs}ms`);
		}
		throw new Error(`worktree setup hook failed: ${result.error.message}`);
	}

	if (result.status !== 0) {
		const details = result.stderr.trim() || result.stdout.trim() || "no output";
		throw new Error(`worktree setup hook failed with exit code ${result.status}: ${details}`);
	}

	const output = parseWorktreeSetupHookOutput(result.stdout);
	if (output.syntheticPaths === undefined) return [];
	if (!Array.isArray(output.syntheticPaths)) {
		throw new Error("worktree setup hook output field 'syntheticPaths' must be an array of relative paths");
	}

	const uniquePaths = new Set<string>();
	for (const candidate of output.syntheticPaths) {
		if (typeof candidate !== "string") {
			throw new Error("worktree setup hook output field 'syntheticPaths' must contain only strings");
		}
		const normalizedPath = normalizeSyntheticPath(input.worktreePath, candidate);
		if (hasTrackedEntries(input.worktreePath, normalizedPath)) {
			throw new Error(`worktree setup hook cannot mark tracked paths as synthetic: ${normalizedPath}`);
		}
		uniquePaths.add(normalizedPath);
	}
	return [...uniquePaths];
}

function createSingleWorktree(
	toplevel: string,
	cwdRelative: string,
	scratchRoot: string,
	runId: string,
	index: number,
	baseCommit: string,
	setupHook: ResolvedWorktreeSetupHook | undefined,
	agent: string | undefined,
): WorktreeInfo {
	const branch = buildWorktreeBranch(runId, index);
	const worktreePath = buildWorktreePath(scratchRoot, runId, index);
	const add = runGit(toplevel, ["worktree", "add", worktreePath, "-b", branch, "HEAD"]);
	if (add.status !== 0) {
		const message = add.stderr.trim() || add.stdout.trim() || `failed to create worktree ${worktreePath}`;
		throw new Error(message);
	}

	const agentCwd = cwdRelative ? path.join(worktreePath, cwdRelative) : worktreePath;
	const gitExcludeFile = createGitExcludeFile();
	const gitEnv = buildWorktreeGitEnv(gitExcludeFile);
	try {
		const nodeModulesLinked = linkNodeModulesIfPresent(toplevel, worktreePath);
		const syntheticPaths = nodeModulesLinked ? ["node_modules"] : [];
		writeGitExcludeFile(gitExcludeFile, syntheticPaths);

		if (setupHook) {
			const hookSyntheticPaths = runWorktreeSetupHook(setupHook, {
				version: 1,
				repoRoot: toplevel,
				worktreePath,
				agentCwd,
				branch,
				index,
				runId,
				baseCommit,
				agent,
			}, gitEnv);
			syntheticPaths.push(...hookSyntheticPaths);
			writeGitExcludeFile(gitExcludeFile, syntheticPaths);
		}

		return {
			path: worktreePath,
			agentCwd,
			branch,
			index,
			nodeModulesLinked,
			syntheticPaths,
			gitEnv,
			gitExcludeFile,
		};
	} catch (error) {
		removeGitExcludeFile(gitExcludeFile);
		// Inline rollback deliberately bypasses the cleanupSingleWorktree
		// guards: both the path and the branch were created by THIS function a
		// few lines up (`worktree add <tmpdir-path> -b pi-fork-...`), so they
		// are linked-worktree + delegate-branch by construction.
		try { runGitChecked(toplevel, ["worktree", "remove", "--force", worktreePath]); } catch {
			// Best-effort rollback; preserve the original setup failure.
		}
		try { runGitChecked(toplevel, ["branch", "-D", branch]); } catch {
			// Best-effort rollback; preserve the original setup failure.
		}
		throw error;
	}
}

function removeSyntheticPath(worktree: WorktreeInfo, syntheticPath: string): void {
	const resolved = path.resolve(worktree.path, syntheticPath);
	const relative = path.relative(worktree.path, resolved);
	if (!relative || relative === "." || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		return;
	}

	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(resolved);
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
		if (code === "ENOENT") return;
		throw error;
	}

	if (stat.isSymbolicLink()) {
		fs.unlinkSync(resolved);
		return;
	}
	if (stat.isDirectory()) {
		fs.rmSync(resolved, { recursive: true, force: true });
		return;
	}
	fs.rmSync(resolved, { force: true });
}

function removeSyntheticPathsBeforeDiff(worktree: WorktreeInfo): void {
	if (worktree.syntheticPaths.length === 0) return;
	const seen = new Set<string>();
	for (const syntheticPath of worktree.syntheticPaths) {
		if (seen.has(syntheticPath)) continue;
		seen.add(syntheticPath);
		removeSyntheticPath(worktree, syntheticPath);
	}
}

function emptyDiff(index: number, agent: string, branch: string, patchPath: string): WorktreeDiff {
	return {
		index,
		agent,
		branch,
		diffStat: "",
		filesChanged: 0,
		insertions: 0,
		deletions: 0,
		patchPath,
	};
}

function parseNumstat(numstat: string): { filesChanged: number; insertions: number; deletions: number } {
	const lines = numstat
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	let filesChanged = 0;
	let insertions = 0;
	let deletions = 0;

	for (const line of lines) {
		const [rawInsertions, rawDeletions] = line.split("\t");
		if (rawInsertions === undefined || rawDeletions === undefined) continue;
		filesChanged++;
		if (/^\d+$/.test(rawInsertions)) insertions += parseInt(rawInsertions, 10);
		if (/^\d+$/.test(rawDeletions)) deletions += parseInt(rawDeletions, 10);
	}

	return { filesChanged, insertions, deletions };
}

function captureWorktreeDiff(
	setup: WorktreeSetup,
	worktree: WorktreeInfo,
	agent: string,
	patchPath: string,
): WorktreeDiff {
	removeSyntheticPathsBeforeDiff(worktree);
	runGitChecked(worktree.path, ["add", "-A"]);
	const diffStat = runGitChecked(worktree.path, ["diff", "--cached", "--stat", setup.baseCommit]).trim();
	const patch = runGitChecked(worktree.path, ["diff", "--cached", setup.baseCommit]);
	const numstat = runGitChecked(worktree.path, ["diff", "--cached", "--numstat", setup.baseCommit]);
	fs.writeFileSync(patchPath, patch, "utf-8");

	if (!patch.trim()) {
		return emptyDiff(worktree.index, agent, worktree.branch, patchPath);
	}

	const parsed = parseNumstat(numstat);
	return {
		index: worktree.index,
		agent,
		branch: worktree.branch,
		diffStat,
		filesChanged: parsed.filesChanged,
		insertions: parsed.insertions,
		deletions: parsed.deletions,
		patchPath,
	};
}

/** Capture one entry as soon as its worker stops, before result publication or cleanup. */
export function captureWorktreeDiffForEntry(
	setup: WorktreeSetup,
	index: number,
	agent: string,
	diffsDir: string,
): WorktreeDiff {
	const worktree = setup.worktrees[index];
	if (!worktree) throw new Error(`worktree entry ${index} does not exist`);
	const patchPath = path.join(diffsDir, `task-${index}-${safePatchAgentName(agent)}.patch`);
	try {
		fs.mkdirSync(diffsDir, { recursive: true });
		// Preservation is sticky: a later successful capture never un-preserves a
		// worktree whose earlier capture failed, because guidance naming that
		// worktree may already have been published to the caller.
		return captureWorktreeDiff(setup, worktree, agent, patchPath);
	} catch (err) {
		logDelegateDiagnostic(
			`worktree diff capture failed for ${worktree.path} (${agent}): ` +
				`${(err as Error)?.message ?? err} — wrote empty patch ${patchPath}; ` +
				`worktree will be PRESERVED by cleanup for manual recovery`,
			{ agentDir: setup.agentDir, level: "warn" },
		);
		if (!(setup.diffCaptureFailedPaths ?? []).includes(worktree.path)) {
			(setup.diffCaptureFailedPaths ??= []).push(worktree.path);
		}
		// Never clobber a patch an earlier capture already wrote and published.
		if (!hasNonEmptyPatch(patchPath)) writeEmptyPatch(patchPath);
		return { ...emptyDiff(index, agent, worktree.branch, patchPath), captureFailed: true, worktreePath: worktree.path };
	}
}

function hasNonEmptyPatch(patchPath: string): boolean {
	try {
		return fs.statSync(patchPath).size > 0;
	} catch {
		return false;
	}
}

function writeEmptyPatch(patchPath: string): void {
	try {
		fs.writeFileSync(patchPath, "", "utf-8");
	} catch {
		// Diff artifact writing is best-effort in error paths.
	}
}

/**
 * Parse `git worktree list --porcelain` into resolved worktree paths. The
 * FIRST entry is always the MAIN worktree; the rest are linked worktrees.
 */
function listWorktreePaths(repoCwd: string): { main: string | undefined; linked: Set<string> } {
	const out = runGitChecked(repoCwd, ["worktree", "list", "--porcelain"]);
	const paths: string[] = [];
	for (const line of out.split("\n")) {
		if (line.startsWith("worktree ")) paths.push(resolveRealPath(line.slice("worktree ".length).trim()));
	}
	return { main: paths[0], linked: new Set(paths.slice(1)) };
}

/** Branches the delegate worktree flow created and is allowed to force-delete. */
const DELEGATE_BRANCH_PREFIX = "pi-fork-";

function cleanupSingleWorktree(repoCwd: string, worktree: WorktreeInfo): void {
	// Issue #5 — removal guard: only ever remove a path that git itself
	// reports as a LINKED worktree of this repo. This makes the catastrophic
	// failure modes (a provider/path mixup pointing at the main checkout, an
	// arbitrary user directory, or a stale WorktreeInfo after external
	// cleanup) structurally impossible regardless of what `worktree.path`
	// contains, instead of relying on git's own argument validation.
	try {
		const target = resolveRealPath(worktree.path);
		const { main, linked } = listWorktreePaths(repoCwd);
		if (target === main) {
			// Never touch the main checkout. (git would refuse too; refuse first.)
			return;
		}
		if (linked.has(target)) {
			try { runGitChecked(repoCwd, ["worktree", "remove", "--force", worktree.path]); } catch {
				// Cleanup is best-effort to avoid masking caller errors.
			}
		}
		// Unregistered path: nothing to remove (already pruned / never created).
	} catch {
		// Even listing failed — fail safe by removing nothing.
	}
	// Issue #5 — branch guard: only force-delete branches the delegate flow
	// itself created (pi-fork-*). A provider-supplied branch (e.g. graft's
	// per-spec branch) carries work the provider owns; never -D it. This also
	// protects a pre-existing user branch from a name collision, since
	// pi-fork-<runId>-<index> branches are minted with `-b` (creation fails on
	// collision rather than reusing the user's branch).
	if (worktree.branch.startsWith(DELEGATE_BRANCH_PREFIX)) {
		try { runGitChecked(repoCwd, ["branch", "-D", worktree.branch]); } catch {
			// Cleanup is best-effort to avoid masking caller errors.
		}
	}
	removeGitExcludeFile(worktree.gitExcludeFile);
}

function hasWorktreeChanges(diff: WorktreeDiff): boolean {
	return diff.filesChanged > 0 || diff.insertions > 0 || diff.deletions > 0 || diff.diffStat.trim().length > 0;
}

export function createWorktrees(cwd: string, runId: string, count: number, options?: CreateWorktreesOptions): WorktreeSetup {
	// --- Provider fast-path (spec 0109) ---
	// When a provider is registered, try it for ALL worktrees first.
	// If every call returns non-null, we skip resolveRepoState entirely
	// (bypassing the clean-tree gate — needed for graft repos with dirty
	// journal state). If ANY call returns null, we fall through to the
	// default path which requires a clean tree.
	if (_worktreeProvider) {
		const providerResults: (WorktreeInfo | null)[] = [];
		// Resolve toplevel without the clean-tree check.
		const repoCheck = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
		if (repoCheck.status !== 0 || repoCheck.stdout.trim() !== "true") {
			throw new Error("worktree isolation requires a git repository");
		}
		const toplevel = runGitChecked(cwd, ["rev-parse", "--show-toplevel"]).trim();

		let allHandled = true;
		for (let index = 0; index < count; index++) {
			const request: WorktreeRequest = { toplevel, runId, index };
			// Provider may throw — let it propagate (REQ-FAIL-LOUD).
			const result = _worktreeProvider(request);
			providerResults.push(result);
			if (result === null) allHandled = false;
		}

		if (allHandled) {
			// Issue #5 — never admit an unsafe provider path into the setup:
			// everything in `worktrees` is a later target of
			// `git worktree remove --force` in cleanup. Throws on violation
			// (REQ-FAIL-LOUD, consistent with provider error propagation).
			for (const info of providerResults as WorktreeInfo[]) {
				validateWorktreeInfo(info, toplevel);
			}
			const baseCommit = runGitChecked(toplevel, ["rev-parse", "HEAD"]).trim();
			return {
				cwd: toplevel,
				worktrees: providerResults as WorktreeInfo[],
				baseCommit,
				agentDir: options?.agentDir,
			};
		}
		// At least one returned null — fall through to default path
		// which needs a clean tree. The provider results are discarded;
		// all worktrees go through the default flow.
	}

	const repo = resolveRepoState(cwd);
	const setupHook = resolveWorktreeSetupHook(repo.toplevel, options?.setupHook);
	const scratchRoot = createWorktreeScratchRoot();
	const worktrees: WorktreeInfo[] = [];

	try {
		for (let index = 0; index < count; index++) {
			worktrees.push(createSingleWorktree(
				repo.toplevel,
				repo.cwdRelative,
				scratchRoot,
				runId,
				index,
				repo.baseCommit,
				setupHook,
				options?.agents?.[index],
			));
		}
	} catch (error) {
		cleanupWorktrees({
			cwd: repo.toplevel,
			worktrees,
			baseCommit: repo.baseCommit,
			scratchRoot,
		});
		throw error;
	}

	return {
		cwd: repo.toplevel,
		worktrees,
		baseCommit: repo.baseCommit,
		agentDir: options?.agentDir,
		scratchRoot,
	};
}

/**
 * Capture every entry's diff. An entry already present in `captured` was
 * captured when its worker stopped and that result was published; it is reused
 * verbatim rather than captured again, so the aggregate, cleanup preservation,
 * and the patch on disk cannot contradict the earlier caller-visible guidance.
 */
export function diffWorktrees(
	setup: WorktreeSetup,
	agents: string[],
	diffsDir: string,
	captured?: ReadonlyMap<number, WorktreeDiff>,
): WorktreeDiff[] {
	try {
		fs.mkdirSync(diffsDir, { recursive: true });
	} catch {
		// Returning no diffs is safer than failing the whole command on artifact-dir issues.
		return [];
	}

	const diffs: WorktreeDiff[] = [];
	for (let index = 0; index < setup.worktrees.length; index++) {
		const earlier = captured?.get(index);
		if (earlier) {
			diffs.push(earlier);
			continue;
		}
		const agent = agents[index] ?? `task-${index + 1}`;
		diffs.push(captureWorktreeDiffForEntry(setup, index, agent, diffsDir));
	}

	return diffs;
}

export function cleanupWorktrees(setup: WorktreeSetup): void {
	const preserve = new Set(setup.diffCaptureFailedPaths ?? []);
	for (let index = setup.worktrees.length - 1; index >= 0; index--) {
		const worktree = setup.worktrees[index]!;
		if (preserve.has(worktree.path)) {
			// Issue #5 — this worktree's diff capture failed, so the patch is
			// empty while the tree may still hold the only copy of real work.
			// Leave it (and its branch) on disk for manual recovery.
			logDelegateDiagnostic(
				`cleanup preserved worktree ${worktree.path} (branch ${worktree.branch}): ` +
					`diff capture failed earlier; after recovering changes, remove with ` +
					`\`git -C ${setup.cwd} worktree remove --force ${worktree.path}\` ` +
					`and \`git -C ${setup.cwd} branch -D ${worktree.branch}\``,
				{ agentDir: setup.agentDir, level: "warn" },
			);
			continue;
		}
		cleanupSingleWorktree(setup.cwd, worktree);
	}
	try { runGitChecked(setup.cwd, ["worktree", "prune"]); } catch {
		// Pruning is best-effort cleanup.
	}
	removeWorktreeScratchRoot(setup.scratchRoot);
}

export function formatWorktreeDiffSummary(diffs: WorktreeDiff[]): string {
	const changed = diffs.filter(hasWorktreeChanges);
	const failed = diffs.filter((diff) => diff.captureFailed === true);
	if (changed.length === 0 && failed.length === 0) return "";

	const lines: string[] = ["=== Worktree Changes ===", ""];
	for (const diff of failed) {
		lines.push(`--- Task ${diff.index + 1} (${diff.agent}): ${formatWorktreeCaptureFailureGuidance(diff)} ---`, "");
	}
	if (changed.length === 0) return lines.join("\n").trimEnd();
	for (const diff of changed) {
		lines.push(
			`--- Task ${diff.index + 1} (${diff.agent}): ${diff.filesChanged} files changed, +${diff.insertions} -${diff.deletions} ---`,
		);
		if (diff.diffStat.trim().length > 0) {
			lines.push(diff.diffStat);
		}
		lines.push("");
	}

	const patchesDir = path.dirname(changed[0]!.patchPath);
	lines.push(`Full patches: ${patchesDir}`);
	return lines.join("\n").trimEnd();
}
