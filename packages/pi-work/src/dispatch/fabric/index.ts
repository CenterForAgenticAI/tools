import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { runGit } from "../../git.js";
import { resolveVerifierExecutable } from "../../verify/executable.js";
import type { DispatchBackend } from "../backend.js";
import type { DispatchPlanInput } from "../index.js";
import type { DispatchResult } from "../types.js";
import type { createFabricCompletionAnnouncements } from "./completion.js";
import { dispatchWithFabricModel } from "./model.js";
import { ensureFabricDispatchProgram } from "./program.js";
import { recordFabricDispatchReceipt, resolveFabricReceiptOwnership } from "./receipt.js";
import { FABRIC_WORKER_RESULT_SCHEMA, validateFabricWorkerResult } from "./result.js";
import { dispatchFabricRun } from "./run.js";
import type { FabricProgramEventBus } from "./transport.js";
import { changedSnapshotPaths, snapshotOptionalDirectory, snapshotWorktree, type WorktreeSnapshot } from "./snapshot.js";

export interface FabricDispatchBackendOptions {
	readonly events?: FabricProgramEventBus;
	readonly completion?: ReturnType<typeof createFabricCompletionAnnouncements>;
	readonly projectRoot?: string;
	readonly trustedProject?: boolean;
	readonly timeoutMs?: number;
}

async function readConfig(file: string): Promise<unknown> {
	try { return JSON.parse(await readFile(file, "utf8")); }
	catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

// Fabric accepts directories, not touch globs or files. The brief retains the
// narrower write contract, enforced by the post-run diff; shell is not a sandbox.
async function writableRoots(touches: readonly string[] | undefined, cwd: string): Promise<string[]> {
	const roots = await Promise.all((touches ?? []).map(async (touch) => {
		const wildcard = touch.search(/[*?{[]/);
		const prefix = wildcard < 0 ? touch : touch.slice(0, wildcard);
		let root = path.resolve(cwd, prefix || ".");
		if (wildcard >= 0 && !prefix.endsWith("/")) root = path.dirname(root);
		if (wildcard < 0) {
			try { if (!(await stat(root)).isDirectory()) root = path.dirname(root); }
			catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
				root = path.dirname(root);
			}
		}
		const relative = path.relative(cwd, root);
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Fabric writable root escapes the node worktree");
		return root;
	}));
	return [...new Set(roots)];
}

export function createFabricDispatchBackend(options: FabricDispatchBackendOptions = {}): DispatchBackend {
	return {
		name: "fabric",
		async dispatch(input: DispatchPlanInput): Promise<DispatchResult> {
			const { plan, target, context } = input;
			const run = plan.canonicalDelegate.runs[0];
			// Freeze file/directory meaning before the worker can replace a file with a directory.
			const touches = await Promise.all((run.writableRoots ?? []).map(async touch => {
				let directory = touch.endsWith("/");
				if (!/[*?{[]/.test(touch)) {
					try { directory = (await stat(path.resolve(run.cwd ?? target.worktreePath, touch))).isDirectory(); }
					catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
				}
				return { touch, directory };
			}));
			const git = await resolveVerifierExecutable("git");
			const sourceCwd = await realpath(run.cwd ?? target.worktreePath);
			const before = new Map<string, WorktreeSnapshot>();
			const listing = await runGit(git, sourceCwd, ["worktree", "list", "--porcelain", "-z"]);
			// Required trees never become optional because their registration is stale.
			const targetCwd = await realpath(target.worktreePath);
			const roots = new Set([sourceCwd, targetCwd]);
			for (const record of listing.stdout.split("\0\0")) {
				const fields = record.split("\0");
				const worktree = fields.find(field => field.startsWith("worktree "));
				if (!worktree) continue;
				const root = path.resolve(worktree.slice(9));
				if (roots.has(root)) continue;
				let canonical: string;
				try {
					canonical = await realpath(root);
					if (!(await stat(canonical)).isDirectory()) continue;
				}
				catch (error) {
					if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) continue;
					throw error;
				}
				roots.add(canonical);
			}
			for (const root of roots) before.set(root, await snapshotWorktree(root));
			const tracked = new Set((await runGit(git, sourceCwd, ["ls-files", "-z"])).stdout.split("\0").filter(Boolean));
			// Cache storage is outside the checkout. Nothing writes it during the run;
			// receipt/cache publication happens only after confinement checks pass.
			const cacheBefore = new Map<string, WorktreeSnapshot>();
			for (const root of roots) {
				const directory = path.resolve(root, "..", ".pi-work-status-cache", path.basename(root));
				cacheBefore.set(directory, await snapshotOptionalDirectory(directory));
			}
			const exempt = new Set<string>();
			const bootstrapDigests = new Map<string, string>();
			const selected = await dispatchWithFabricModel(run, {
				async models() { return context.modelRegistry.getAvailable().map((model) => ({ key: `${model.provider}/${model.id}` })); },
				async run(model) {
					const projectRoot = options.projectRoot ?? process.env.PI_FABRIC_PROJECT_ROOT ?? context.cwd;
					const program = await ensureFabricDispatchProgram(projectRoot);
					bootstrapDigests.set(path.resolve(program.path), createHash("sha256").update(await readFile(program.path)).digest("hex"));
					return dispatchFabricRun({
						ref: program.ref, projectRoot, trustedProject: options.trustedProject ?? false,
						invocation: {
							name: run.name, cwd: run.cwd ?? target.worktreePath, worktree: run.worktree,
							task: `${run.task}\nRead the brief first: ${plan.briefPath} (sha256 ${plan.briefSha256}).\n${run.skills === undefined ? "" : `Load these skills: ${run.skills.join(", ")}.\n`}Do not verify your own node. Return the structured result, including checklist accounting and gaps.`,
							confineWrites: run.confineWrites, writableRoots: await writableRoots(run.writableRoots, run.cwd ?? target.worktreePath),
							...(model === undefined ? {} : { model }),
						},
						schema: FABRIC_WORKER_RESULT_SCHEMA,
						...(input.signal === undefined ? {} : { signal: input.signal }),
						...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
					}, { events: options.events, readConfig });
				},
			});
			if (selected.status === "rejected") return { outcome: "rejected", dispatchState: "not-dispatched", plan, findings: [selected.finding] };
			const result = selected.result;
			if (!("status" in result) || result.status !== "dispatched") {
				const rejected = "status" in result && result.status === "rejected";
				const finding = { code: "delegate-runtime-error" as const, message: `${result.finding.code}: ${result.finding.message}` };
				return rejected ? { outcome: "rejected", dispatchState: "not-dispatched", plan, findings: [finding] } : { outcome: "indeterminate", dispatchState: "unknown", plan, findings: [finding] };
			}
			options.completion?.track(result.receipt.runId);
			const value = result.result.value;
			const validated = validateFabricWorkerResult(typeof value === "object" && value !== null && "status" in value && value.status === "completed" && "value" in value ? value.value : undefined);
			if (!validated.ok) return { outcome: "indeterminate", dispatchState: "unknown", plan, findings: [{ code: "delegate-receipt-invalid", message: `${validated.finding.code}: ${validated.finding.message}` }] };
			// Compare actual content, including ignored files; worker claims are not evidence.
			const cwd = result.receipt.worktreeResult?.path ?? run.cwd ?? target.worktreePath;
			const ownership = await resolveFabricReceiptOwnership(plan, target, cwd);
			if (typeof ownership !== "string") return ownership;
			const canonicalCwd = await realpath(cwd);
			// Fabric creates new worktrees during submission, with only tracked files.
			// Existing trees have their own complete before snapshot; a newly created
			// tree uses the source's tracked content, never its ignored metadata.
			const baseline = before.get(canonicalCwd) ?? new Map([...before.get(sourceCwd)!].filter(([file]) => tracked.has(file)));
			const snapshotChanges = changedSnapshotPaths(baseline, await snapshotWorktree(cwd));
			const base = result.receipt.worktreeResult?.baseRef ?? target.headCommit;
			const [committed, diff, staged] = await Promise.all([
				runGit(git, cwd, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", base, "HEAD", "--"]),
				runGit(git, cwd, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", base, "--"]),
				runGit(git, cwd, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", base, "--"]),
			]);
			const changed = new Set([...committed.stdout.split("\0"), ...diff.stdout.split("\0"), ...staged.stdout.split("\0"), ...snapshotChanges, ...validated.value.changedPaths].filter(Boolean));
			for (const [file, digest] of bootstrapDigests) {
				try {
					if (createHash("sha256").update(await readFile(file)).digest("hex") === digest) exempt.add(file);
				} catch { /* Missing or unreadable bootstrap bytes are never exempt. */ }
			}
			const outsideTouches = (root: string, file: string): boolean => {
				const absolute = path.resolve(root, file);
				if (exempt.has(absolute)) return false;
				// The bootstrap is exempt only while its pi-work-written bytes survive.
				if (bootstrapDigests.has(absolute)) return true;
				return !touches.some(({ touch, directory }) => {
					const normalized = touch.replace(/\/$/, "");
					return file === normalized || (directory && file.startsWith(`${normalized}/`)) || path.matchesGlob(file, touch);
				});
			};
			const outside = [...changed].filter(file => outsideTouches(cwd, file));
			for (const [root, baseline] of before) {
				// The worker was already compared above, including its Git changes.
				if (root === canonicalCwd) continue;
				const treeChanges = changedSnapshotPaths(baseline, await snapshotWorktree(root));
				outside.push(...treeChanges.filter(file => outsideTouches(root, file)).map(file => path.join(root, file)));
			}
			for (const [directory, baseline] of cacheBefore) {
				outside.push(...changedSnapshotPaths(baseline, await snapshotOptionalDirectory(directory)).map(file => path.join(directory, file)));
			}
			if (outside.length > 0) return { outcome: "indeterminate", dispatchState: "unknown", plan, findings: [{ code: "delegate-receipt-invalid", message: `Fabric changed paths outside declared touches: ${outside.map(file => JSON.stringify(file)).join(", ")}; do not redispatch automatically` }] };
			const recorded = await recordFabricDispatchReceipt({ plan, target, value, workerResult: validated.value });
			if ("outcome" in recorded) return recorded;
			const cache = recorded.cacheWrite;
			return { outcome: "dispatched", dispatchState: "dispatched", plan, ...recorded, findings: cache.status === "contended" ? [{ code: "cache-write-contended", message: cache.message }] : cache.status === "failed" ? [{ code: "cache-write-failed", message: cache.message }] : [] };
		},
	};
}
