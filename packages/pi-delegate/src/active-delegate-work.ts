import { readdirSync, type Dirent } from "node:fs";

import {
	readOrchestrateActiveMarkerProcessState,
	resolveOrchestrateActiveOwnerDir,
} from "./detached-spawn.js";
import { pidAlive } from "./event-bus.js";
import { isLiveStatus, type ForkLiveStatus, resolveRuntimeStatePath } from "./runtime.js";
import { readJsonFile } from "./state-io.js";

interface RunStateRecord {
	runId: string;
	rootRunId?: string;
	ownerSessionId?: string;
	completedAt?: number | null;
	forks: Record<string, { status: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRunStateRecord(value: unknown): value is RunStateRecord {
	if (!isRecord(value) || typeof value.runId !== "string" || value.runId.length === 0 || !isRecord(value.forks)) {
		return false;
	}
	if (
		value.rootRunId !== undefined && typeof value.rootRunId !== "string" ||
		value.ownerSessionId !== undefined && typeof value.ownerSessionId !== "string" ||
		value.completedAt !== undefined && value.completedAt !== null &&
		(typeof value.completedAt !== "number" || !Number.isFinite(value.completedAt))
	) {
		return false;
	}
	return Object.values(value.forks).every((fork) => isRecord(fork) && typeof fork.status === "string");
}

function isLiveRun(run: RunStateRecord): boolean {
	return (run.completedAt === undefined || run.completedAt === null) &&
		Object.values(run.forks).some((fork) => isLiveStatus(fork.status as ForkLiveStatus));
}

type RootAttribution = "owned" | "foreign" | "unknown";

function resolveRootAttribution(
	records: readonly RunStateRecord[],
	rootRunId: string | undefined,
	sessionId: string,
): RootAttribution {
	if (rootRunId === undefined) return "unknown";

	const roots = records.filter((record) => record.runId === rootRunId);
	if (roots.length !== 1) return "unknown";

	const root = roots[0];
	if (
		(root.rootRunId !== undefined && root.rootRunId !== root.runId) ||
		root.ownerSessionId === undefined ||
		root.ownerSessionId.length === 0
	) {
		return "unknown";
	}
	return root.ownerSessionId === sessionId ? "owned" : "foreign";
}

function hasLiveRunStateWork(agentDir: string, sessionId: string): boolean {
	const result = readJsonFile(resolveRuntimeStatePath(agentDir));
	if (result.kind === "absent") return false;
	if (result.kind === "corrupt" || !isRecord(result.value) || !Array.isArray(result.value.runs)) return true;

	const runs = result.value.runs;
	if (!runs.every(isRunStateRecord)) return true;
	const records = runs as RunStateRecord[];

	return records.some((run) => {
		if (!isLiveRun(run)) return false;
		if (run.ownerSessionId !== undefined) return run.ownerSessionId === sessionId;
		// An ownerless live entry (a detached/chain child before #355 persists its
		// owner) counts as this session's work ONLY when its root positively
		// resolves to this session. `run-state.json` is machine-shared, so an
		// ownerless run whose root is missing, ambiguous, ownerless, or malformed
		// cannot be tied to the caller — it is another session's run or a stale
		// orphan, and attributing it to whoever happens to be asking would let one
		// orphan report every session as busy. Fail-closed still covers genuinely
		// unreadable data (a corrupt file, non-array runs, malformed entry,
		// unknown fork status) above; those return active regardless of session.
		// An absent file is idle, not fail-closed — it returns false above.
		return resolveRootAttribution(records, run.rootRunId, sessionId) === "owned";
	});
}

function hasLiveOrchestrateWork(agentDir: string, sessionId: string): boolean {
	let entries: Dirent<string>[];
	try {
		entries = readdirSync(resolveOrchestrateActiveOwnerDir(agentDir, sessionId), { withFileTypes: true });
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? false : true;
	}

	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const runId = entry.name.slice(0, -".json".length);
		const state = readOrchestrateActiveMarkerProcessState(agentDir, sessionId, runId);
		if (state.kind === "unknown") return true;
		if (state.kind === "present" && pidAlive(state.runnerPid)) return true;
	}
	return false;
}

/**
 * Return whether a session still has active delegate work across both durable
 * substrates: live run-state entries and live detached-orchestrate markers.
 * See `docs/active-delegate-work-contract.md` for the fail-closed contract.
 */
export function hasActiveDelegateWork(agentDir: string, sessionId: string): boolean {
	return hasLiveRunStateWork(agentDir, sessionId) || hasLiveOrchestrateWork(agentDir, sessionId);
}
