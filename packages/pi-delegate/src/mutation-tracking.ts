import { spawnSync } from "node:child_process";

const COMMAND_TIMEOUT_MS = 2_000;
const OUTPUT_LIMIT = 1024 * 1024;
/** Maximum changed paths retained in a mutation report. */
export const MAX_PATHS = 256;
/** Maximum UTF-8 bytes retained across changed-path identities. */
export const MAX_PATH_BYTES = 16 * 1024;
/** Maximum UTF-8 bytes retained for the repository root identity. */
export const MAX_REPOSITORY_ROOT_BYTES = 4 * 1024;

type MutationCommandResult = {
	error?: NodeJS.ErrnoException | Error;
	status: number | null;
	stdout?: Buffer | string;
	stderr?: Buffer | string;
};
type MutationCommandRunner = (cwd: string, args: string[]) => MutationCommandResult;

const defaultMutationCommandRunner: MutationCommandRunner = (cwd, args) => spawnSync("git", ["-C", cwd, ...args], {
	encoding: "buffer",
	timeout: COMMAND_TIMEOUT_MS,
	maxBuffer: OUTPUT_LIMIT,
	windowsHide: true,
});
let mutationCommandRunner = defaultMutationCommandRunner;

/** Deterministic failure injection for observation tests; production uses spawnSync. */
export function __setMutationTrackingCommandForTests(
	runner: MutationCommandRunner | undefined,
): () => void {
	const previous = mutationCommandRunner;
	mutationCommandRunner = runner ?? defaultMutationCommandRunner;
	return () => { mutationCommandRunner = previous; };
}

export type MutationNotTrackedReason =
	| "not-git"
	| "timeout"
	| "git-error"
	| "output-limit"
	| "repository-changed"
	| "invalid-output"
	| "observation-unavailable";

export type MutationReport =
	| {
		status: "tracked";
		repositoryRoot: string;
		changedPaths: string[];
		truncated?: true;
		omittedPathCount?: number;
	}
	| {
		status: "not-tracked";
		reason: MutationNotTrackedReason;
		detail?: string;
	};

export interface MutationSnapshot {
	status: "tracked";
	repositoryRoot: string;
	entries: ReadonlyMap<string, string>;
}

export interface UntrackedMutationSnapshot {
	status: "not-tracked";
	reason: MutationNotTrackedReason;
	detail?: string;
}

export const MAX_DIAGNOSTIC_DETAIL = 500;

/** Bound caller-controlled mutation metadata by encoded UTF-8 bytes. */
export function boundMutationText(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	const marker = "…";
	const markerBytes = Buffer.byteLength(marker, "utf8");
	if (markerBytes > maxBytes) return "";
	let used = markerBytes;
	let prefix = "";
	for (const character of value) {
		const bytes = Buffer.byteLength(character, "utf8");
		if (used + bytes > maxBytes) break;
		prefix += character;
		used += bytes;
	}
	return `${prefix}${marker}`;
}

function detail(error: unknown): string {
	return boundMutationText(error instanceof Error ? error.message : String(error), MAX_DIAGNOSTIC_DETAIL);
}

/** A bounded report for terminal paths that could not establish a baseline. */
export function unavailableMutationReport(detailText?: string): MutationReport {
	return {
		status: "not-tracked",
		reason: "observation-unavailable",
		...(detailText ? { detail: detail(detailText) } : {}),
	};
}

function runGit(cwd: string, args: string[]): { ok: true; stdout: Buffer } | { ok: false; reason: MutationNotTrackedReason; detail?: string } {
	try {
		const result = mutationCommandRunner(cwd, args);
		if (result.error) {
			const error = result.error as NodeJS.ErrnoException & { code?: string };
			if (error.code === "ETIMEDOUT") return { ok: false, reason: "timeout", detail: detail(error) };
			if (error.code === "ENOBUFS") return { ok: false, reason: "output-limit", detail: "git observation output exceeded the bounded limit" };
			return { ok: false, reason: "git-error", detail: detail(error) };
		}
		if (result.status === null) return { ok: false, reason: "git-error", detail: "git observation exited without a status" };
		if (result.status !== 0) return { ok: false, reason: "not-git", detail: detail(String(result.stderr ?? "")) };
		const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(String(result.stdout ?? ""));
		if (stdout.byteLength > OUTPUT_LIMIT) return { ok: false, reason: "output-limit" };
		return { ok: true, stdout };
	} catch (error) {
		return { ok: false, reason: "git-error", detail: detail(error) };
	}
}

/** Parse `git status --porcelain=v1 -z` without line splitting. */
export function parsePorcelainStatus(output: Buffer | string): Map<string, string> {
	const bytes = Buffer.isBuffer(output) ? output : Buffer.from(output);
	const records = bytes.toString("utf8").split("\0");
	const entries = new Map<string, string>();
	for (let index = 0; index < records.length; index++) {
		const record = records[index]!;
		if (!record) continue;
		if (record.length < 4 || record[2] !== " ") throw new Error("invalid git porcelain record");
		const signature = record.slice(0, 2);
		const first = record.slice(3);
		if (!first) throw new Error("invalid git porcelain path");
		entries.set(first, signature);
		if (signature.includes("R") || signature.includes("C")) {
			const second = records[++index];
			if (!second) throw new Error("invalid git porcelain rename record");
			entries.set(second, signature);
		}
	}
	return entries;
}

/** Capture the git root and porcelain state, or an explicit not-tracked state. */
export function captureMutationSnapshot(cwd: string): MutationSnapshot | UntrackedMutationSnapshot {
	const root = runGit(cwd, ["rev-parse", "--show-toplevel"]);
	if (root.ok === false) return { status: "not-tracked", reason: root.reason, ...(root.detail ? { detail: root.detail } : {}) };
	const repositoryRoot = root.stdout.toString("utf8").trim();
	if (!repositoryRoot) return { status: "not-tracked", reason: "invalid-output", detail: "empty repository root" };
	const status = runGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
	if (status.ok === false) return status.reason === "not-git"
		? { status: "not-tracked", reason: "git-error", detail: status.detail }
		: { status: "not-tracked", reason: status.reason, ...(status.detail ? { detail: status.detail } : {}) };
	try {
		return { status: "tracked", repositoryRoot, entries: parsePorcelainStatus(status.stdout) };
	} catch (error) {
		return { status: "not-tracked", reason: "invalid-output", detail: detail(error) };
	}
}

/** Compare two successful observations without claiming causation. */
export function compareMutationSnapshots(
	baseline: MutationSnapshot | UntrackedMutationSnapshot,
	terminal: MutationSnapshot | UntrackedMutationSnapshot,
): MutationReport {
	if (baseline.status !== "tracked") return { status: "not-tracked", reason: baseline.reason, ...(baseline.detail ? { detail: detail(baseline.detail) } : {}) };
	if (terminal.status !== "tracked") return { status: "not-tracked", reason: terminal.reason, ...(terminal.detail ? { detail: detail(terminal.detail) } : {}) };
	if (baseline.repositoryRoot !== terminal.repositoryRoot) return { status: "not-tracked", reason: "repository-changed" };
	const paths = new Set<string>([...baseline.entries.keys(), ...terminal.entries.keys()]);
	const changedPaths = [...paths].filter((path) => baseline.entries.get(path) !== terminal.entries.get(path)).sort();
	const boundedPaths: string[] = [];
	let retainedPathBytes = 0;
	let omittedPathCount = Math.max(0, changedPaths.length - MAX_PATHS);
	for (const path of changedPaths.slice(0, MAX_PATHS)) {
		const pathBytes = Buffer.byteLength(path, "utf8");
		if (pathBytes > MAX_PATH_BYTES - retainedPathBytes) {
			omittedPathCount += 1;
			continue;
		}
		boundedPaths.push(path);
		retainedPathBytes += pathBytes;
	}
	return {
		status: "tracked",
		repositoryRoot: boundMutationText(terminal.repositoryRoot, MAX_REPOSITORY_ROOT_BYTES),
		changedPaths: boundedPaths,
		...(omittedPathCount > 0 ? { truncated: true as const, omittedPathCount } : {}),
	};
}

export function mutationReportFor(cwd: string, baseline: MutationSnapshot | UntrackedMutationSnapshot): MutationReport {
	return compareMutationSnapshots(baseline, captureMutationSnapshot(cwd));
}
