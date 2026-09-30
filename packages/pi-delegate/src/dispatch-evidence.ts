import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { OrchestrateCfg } from "./detached-spawn.js";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { openWorkerArtifact } from "./artifact-workspace.js";
import { expandParallelTasks } from "./direct-shape.js";
import type { AgentConfig } from "./agents.js";
import type { DelegateDispatchSnapshot } from "./runtime.js";
import { isSafeRunId } from "./run-id.js";
import { readJsonFile, replaceJsonFile, resolveDelegateStateDir, withStateFileLock } from "./state-io.js";
import { resolveEffectiveCwd } from "./cwd-resolution.js";

export interface DispatchInputDigest {
	kind: "task" | "read" | "checklist" | "focus";
	name: string;
	algorithm: "sha256";
	digest: string;
}
export interface DispatchAcceptance {
	runId: string;
	transport: "in-process" | "daemon";
	state: "accepted" | "uncertain";
	daemonSessionId?: string;
	promptId?: string;
	idempotencyKey?: string;
}
export interface DispatchStepEvidence {
	id: string;
	name: string;
	agent: string;
	kind: "worker" | "command";
	stepIndex: number;
	dependsOn: string[];
	state: "planned" | "started" | "completed" | "failed" | "aborted" | "skipped";
	inputDigests: DispatchInputDigest[];
	actualInputDigests: Array<{ sequence: number; algorithm: "sha256"; digest: string }>;
}
export interface DispatchEvidence {
	version: 1;
	runId: string;
	createdAt: string;
	shape: string;
	inputDigests: DispatchInputDigest[];
	steps: DispatchStepEvidence[];
}
export interface DispatchFailureEvidence {
	acceptance: DispatchAcceptance;
	stage: "metadata" | "receipt" | "submission" | "locator";
	cleanup: "not-requested" | "acknowledged" | "rejected" | "unknown";
	/** Acknowledging cancellation is not terminal proof. */
	terminalConfirmed: false;
	recovery: { runId: string; action: "status-and-harvest" | "recover-pending-launch" };
}
/** Only a durable accepted locator attests delivery of the cfg prompt. */
export function daemonDispatchEntries(cfg: OrchestrateCfg | undefined, promptState = "pending") {
	if (!cfg?.daemonLocator?.promptId) return [];
	return [{ name: cfg.entryName ?? cfg.agentName, agent: cfg.agentName,
		status: promptState === "settled" ? "completed" : promptState === "failed" || promptState === "aborted" ? promptState : "started",
		inputDigests: [{ sequence: 0, algorithm: "sha256" as const, digest: inputSha256(cfg.task) }],
	}];
}
export function projectDispatchSteps(steps: DispatchStepEvidence[], run: DelegateDispatchSnapshot | undefined, entries: Array<{ name?: unknown; status?: unknown; inputDigests?: unknown }>, terminal: boolean): DispatchStepEvidence[] {
	return steps.map((step) => {
		const result = entries.find((entry) => entry.name === step.name) ?? run?.finalResult?.find((entry) => entry.name === step.name);
		const live = run?.forks[step.name];
		const status = result?.status ?? live?.status;
		const state: DispatchStepEvidence["state"] = status === "completed" || status === "failed" || status === "aborted"
			? status : terminal && !result ? "skipped" : status && status !== "pending" && status !== "constructing" ? "started" : "planned";
		const actual = Array.isArray(result?.inputDigests) ? result.inputDigests : (live?.transcript ?? [])
			.filter((entry) => entry.source === "worker" && entry.role === "user")
			.map((entry, sequence) => ({ sequence, algorithm: "sha256" as const, digest: inputSha256(entry.text) }));
		return { id: step.id, name: step.name, agent: step.agent, kind: step.kind, stepIndex: step.stepIndex,
			dependsOn: [...step.dependsOn], state, inputDigests: step.inputDigests,
			actualInputDigests: actual.flatMap((digest) => digest && typeof digest === "object" && typeof digest.sequence === "number" && digest.algorithm === "sha256" && typeof digest.digest === "string"
				? [{ sequence: digest.sequence, algorithm: "sha256" as const, digest: digest.digest }] : []),
		};
	});
}
export function inputSha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}
export async function digestDispatchInputs(slot: Record<string, unknown>, baseCwd: string, deferred = false, optionalFileReads = false): Promise<DispatchInputDigest[]> {
	const digests: DispatchInputDigest[] = [];
	if (typeof slot.task === "string") digests.push({ kind: "task", name: "task", algorithm: "sha256", digest: inputSha256(slot.task) });
	for (const read of Array.isArray(slot.reads) ? slot.reads : []) {
		if (typeof read === "string") {
			// Chain reads can name earlier artifacts and are resolved at execution.
			// Their bytes belong to the actual prompt, not a caller-cwd guess.
			if (deferred) continue;
			try {
				digests.push({ kind: "read", name: read, algorithm: "sha256", digest: createHash("sha256").update(readFileSync(path.resolve(baseCwd, read))).digest("hex") });
			} catch (error) {
				// Public string reads are best-effort context. The executor emits
				// its warning/placeholder; unavailable bytes cannot supply a digest.
				if (!optionalFileReads) throw error;
			}
		} else {
			const opened = await openWorkerArtifact(read);
			try { digests.push({ kind: "read", name: opened.artifactRef.artifactName, algorithm: "sha256", digest: opened.artifactRef.sha256 }); }
			finally { await opened.release(); }
		}
	}
	const handoff = slot.handoff && typeof slot.handoff === "object" ? slot.handoff as Record<string, unknown> : undefined;
	for (const [kind, value] of [["checklist", handoff?.tasks ?? slot.checklist], ["focus", handoff?.focus ?? slot.focus]] as const) {
		if (value !== undefined) digests.push({ kind, name: kind, algorithm: "sha256", digest: inputSha256(JSON.stringify(value)) });
	}
	return digests;
}
function evidencePath(agentDir: string, runId: string): string {
	if (!isSafeRunId(runId)) throw new Error("unsafe dispatch evidence runId");
	return path.join(resolveDelegateStateDir(agentDir), "dispatch-evidence", `${runId}.json`);
}
export function readDispatchEvidence(agentDir: string, runId: string): DispatchEvidence | undefined {
	const read = readJsonFile(evidencePath(agentDir, runId));
	return read.kind === "ok" ? read.value as DispatchEvidence : undefined;
}

/** Observe the handler's resolved plan. Never normalize, discover, compile or execute. */
export async function buildDispatchEvidence(runId: string, params: Record<string, unknown>, cwd: string, shape: string): Promise<DispatchEvidence> {
	const groups: Array<Array<{ slot: Record<string, unknown>; name: string; kind: "worker" | "command" }>> = [];
	const expand = (slots: Record<string, unknown>[]) => {
		const tasks = expandParallelTasks({ rawTasks: slots.map((slot) => ({
			name: typeof slot.name === "string" ? slot.name : undefined,
			agent: { name: String(slot.agent) } as AgentConfig,
			task: typeof slot.task === "string" ? slot.task : "",
			count: typeof slot.count === "number" ? slot.count : undefined,
		})) });
		const expandedSlots = slots.flatMap((slot) => Array.from({ length: Math.max(1, Math.floor(typeof slot.count === "number" ? slot.count : 1)) }, () => slot));
		return tasks.map((task, index) => ({ slot: expandedSlots[index]!, name: task.name, kind: "worker" as const }));
	};
	if (Array.isArray(params.chain)) {
		for (const [index, value] of params.chain.entries()) {
			const step = value as Record<string, unknown>;
			if (Array.isArray(step.parallel)) groups.push(expand(step.parallel).map((entry) => ({ ...entry, name: `step${index + 1}.${entry.name}` })));
			else if (typeof step.run === "string") groups.push([{ slot: step, name: `step${index + 1}-run-${step.run}`, kind: "command" }]);
			else groups.push([{ slot: step, name: typeof step.name === "string" ? step.name : `step${index + 1}-${step.agent}`, kind: "worker" }]);
		}
	} else {
		const slots = Array.isArray(params.agents) ? params.agents : Array.isArray(params.tasks) ? params.tasks : [params.orchestrate ?? params];
		groups.push(expand(slots as Record<string, unknown>[]));
	}
	const steps: DispatchStepEvidence[] = [];
	for (const [stepIndex, group] of groups.entries()) {
		for (const { slot, name, kind } of group) {
			const baseCwd = resolveEffectiveCwd(cwd, typeof params.cwd === "string" ? params.cwd : undefined, typeof slot.cwd === "string" ? slot.cwd : undefined);
			steps.push({ id: name, name, kind, agent: kind === "command" ? `run:${slot.run}` : String(slot.agent), stepIndex,
				dependsOn: stepIndex === 0 ? [] : groups[stepIndex - 1]!.map((entry) => entry.name), state: "planned",
				inputDigests: await digestDispatchInputs(slot, baseCwd, shape === "chain", true), actualInputDigests: [],
			});
		}
	}
	const evidence: DispatchEvidence = { version: 1, runId, createdAt: new Date().toISOString(), shape: shape === "orchestrate" ? "driver" : shape,
		inputDigests: typeof params.task === "string" ? [{ kind: "task", name: "task", algorithm: "sha256", digest: inputSha256(params.task) }] : [], steps };
	return evidence;
}

export async function prepareDispatchEvidence(agentDir: string, runId: string, params: Record<string, unknown>, cwd: string, shape: string): Promise<DispatchEvidence> {
	return persistDispatchEvidence(agentDir, await buildDispatchEvidence(runId, params, cwd, shape));
}

/** Persist only after the handler has admitted the invocation. */
export function persistDispatchEvidence(agentDir: string, evidence: DispatchEvidence): DispatchEvidence {
	const { runId } = evidence;
	const file = evidencePath(agentDir, runId);
	return withStateFileLock(file, () => {
		const previous = readJsonFile(file);
		if (previous.kind === "corrupt") throw new Error(`dispatch evidence unreadable for runId=${runId}`, { cause: previous.error });
		if (previous.kind === "ok") {
			const value = previous.value;
			if (!value || typeof value !== "object" ||
				!("version" in value) || value.version !== 1 ||
				!("runId" in value) || value.runId !== runId ||
				!("createdAt" in value) || typeof value.createdAt !== "string" ||
				!("shape" in value) || value.shape !== evidence.shape ||
				!("inputDigests" in value) || !isDeepStrictEqual(value.inputDigests, evidence.inputDigests) ||
				!("steps" in value) || !isDeepStrictEqual(value.steps, evidence.steps)) {
				throw new Error(`conflicting dispatch plan for runId=${runId}; existing evidence is immutable`);
			}
			return { ...evidence, createdAt: value.createdAt };
		}
		replaceJsonFile(file, evidence);
		return evidence;
	});
}
