import { boundActivityText } from "./activity-status.js";
import {
	boundRunTimeoutTranscript,
	TIMEOUT_ASSISTANT_MAX_BYTES,
	TIMEOUT_TRANSCRIPT_ENTRY_MAX_BYTES,
	TIMEOUT_TRANSCRIPT_MAX_ENTRIES,
} from "./fork-activity.js";
import { truncateRecoveryText } from "./fork-recovery.js";
import { MAX_LINEAGE_DEPTH } from "./fork-predecessor.js";
import type { RunResult, PriorWorkerSession } from "./fork-runner.js";
import type { HarvestOutcome } from "./harvest-outcome.js";
import type { WorkerErrorKind } from "./refusal.js";
import { validateWorkerArtifactReference, type WorkerArtifactReference } from "./artifact-workspace.js";
import { isWorkerFailureCause, isWorkerRetryKind } from "./refusal.js";
import {
	capDelegateOnlyResult,
	getUncappedResultContent,
	rememberUncappedResultContent,
} from "./delegate-only/result-caps.js";

const TIMEOUT_PRIOR_WORKER_SESSIONS_MAX = 5;
import {
	boundMutationText,
	MAX_DIAGNOSTIC_DETAIL,
	MAX_PATH_BYTES,
	MAX_PATHS,
	MAX_REPOSITORY_ROOT_BYTES,
	type MutationNotTrackedReason,
	type MutationReport,
} from "./mutation-tracking.js";
import {
	diagnosticsWithGenerated,
	normalizeUsageCounters,
} from "./usage-rollup.js";
import {
	MAX_SEED_NOTE_CHARS,
	MAX_SEED_TASK_ID_CHARS,
	MAX_SEED_TITLE_CHARS,
	TASK_PROGRESS_FIELD,
	classifyTaskOutcome,
	isValidSeedRef,
	readTaskProgressFields,
	type SeedTaskStatus,
	type TaskLedger,
	type TaskProgressFields,
	type TaskProgressRow,
} from "./task-seam.js";

import { PROMPT_REPAIR_ENTRY_TYPE, mergePromptRepairRecords, parsePromptRepairRecord, type PromptRepairRecord } from "./prompt-repair-seam.js";
import type { WorktreeDiff } from "./worktree.js";
/** Optional direct-only fields carried on caller-visible tool details. */
export interface RunResultDetailExtensions {
	harvest?: HarvestOutcome;
	outputFile?: { absolutePath: string; bytes: number };
	artifactRef?: WorkerArtifactReference;
	artifactError?: { kind: "storage-busy" | "artifact-unavailable"; message: string; retryable: boolean };
	warnings?: Array<{ kind: "reads" | "output" | "progress" | "policy"; message: string }>;
	activeToolNames?: string[];
}

export type ProjectedRunResult = RunResult & RunResultDetailExtensions;
type AgentMessage = Record<string, unknown>;
type RecordValue = Record<string, unknown>;

function isRecordValue(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function boundedString(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max;
}

function optionalBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
	return isFiniteNumber(value) ? value : undefined;
}

function timeoutBoundedText(value: unknown, maxBytes: number): string | undefined {
	return typeof value === "string" ? truncateRecoveryText(value, maxBytes) : undefined;
}

function projectTimeoutString(value: unknown, timeoutSalvage: boolean, maxBytes = TIMEOUT_TRANSCRIPT_ENTRY_MAX_BYTES): string | undefined {
	if (typeof value !== "string") return undefined;
	return timeoutSalvage ? truncateRecoveryText(value, maxBytes) : value;
}

function projectTimeoutStringArray(value: unknown, timeoutSalvage: boolean): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const limit = timeoutSalvage ? Math.min(value.length, TIMEOUT_TRANSCRIPT_MAX_ENTRIES) : value.length;
	const projected: string[] = [];
	for (let index = 0; index < limit; index += 1) {
		if (!Object.prototype.hasOwnProperty.call(value, index)) return undefined;
		const item = value[index];
		if (typeof item !== "string") return undefined;
		projected.push(projectTimeoutString(item, timeoutSalvage)!);
	}
	return projected;
}

function isValidAttempt(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_LINEAGE_DEPTH;
}

export function isWorkerErrorKind(value: unknown): value is WorkerErrorKind {
	return value === "refusal" || value === "no-model-alternative";
}
function projectPromptRepairRecords(value: unknown): PromptRepairRecord[] | undefined {
	if (!Array.isArray(value) || value.length > 2) return undefined;
	const limit = value.length;
	const projected: PromptRepairRecord[] = [];
	for (let index = 0; index < limit; index += 1) {
		if (!Object.prototype.hasOwnProperty.call(value, index)) return undefined;
		const record = parsePromptRepairRecord({ type: "custom", customType: "prompt-repair", data: value[index] });
		if (record) projected.push(record);
	}
	return mergePromptRepairRecords([], projected);
}


export function isMutationNotTrackedReason(value: unknown): value is MutationNotTrackedReason {
	return value === "not-git" || value === "timeout" || value === "git-error" || value === "output-limit" ||
		value === "repository-changed" || value === "invalid-output" || value === "observation-unavailable";
}

function isTranscriptRole(value: unknown): value is RunResult["transcript"][number]["role"] {
	return value === "user" || value === "assistant" || value === "toolCall" || value === "toolResult" ||
		value === "thinking" || value === "system" || value === "text";
}

function isSeedTaskStatus(value: unknown): value is SeedTaskStatus {
	return value === "pending" || value === "active" || value === "done" || value === "blocked" || value === "deferred";
}

function isRunStatus(value: unknown): value is RunResult["status"] {
	return value === "pending" || value === "running" || value === "completed" || value === "failed" || value === "aborted" || value === "paused";
}

function isAgentSource(value: unknown): value is RunResult["agentSource"] {
	return value === "builtin" || value === "user" || value === "project" || value === "package";
}

function isCollapseMode(value: unknown): value is RunResult["collapseMode"] {
	return value === "final_output" || value === "summary";
}

function isCancelReason(value: unknown): value is NonNullable<RunResult["cancelReason"]> {
	return value === "user" || value === "timeout" || value === "heartbeat" || value === "supervisor" || value === "shutdown" || value === "never-constructed";
}

export function projectTranscriptEntry(entry: unknown): RunResult["transcript"][number] | undefined {
	if (!isRecordValue(entry) || typeof entry.source !== "string" || typeof entry.role !== "string" || typeof entry.text !== "string") return undefined;
	if (entry.source !== "supervisor" && entry.source !== "worker") return undefined;
	if (!isTranscriptRole(entry.role)) return undefined;
	const timestamp = optionalFiniteNumber(entry.timestamp);
	const toolName = optionalString(entry.toolName);
	const toolCallId = optionalString(entry.toolCallId);
	const toolMeta = optionalString(entry.toolMeta);
	const customType = entry.customType === PROMPT_REPAIR_ENTRY_TYPE ? PROMPT_REPAIR_ENTRY_TYPE : undefined;
	const isError = optionalBoolean(entry.isError);
	return {
		source: entry.source,
		role: entry.role,
		text: entry.text,
		...(timestamp !== undefined ? { timestamp } : {}),
		...(toolName !== undefined ? { toolName } : {}),
		...(toolCallId !== undefined ? { toolCallId } : {}),
		...(toolMeta !== undefined ? { toolMeta } : {}),
		...(customType !== undefined ? { customType } : {}),
		...(isError !== undefined ? { isError } : {}),
	};
}

export function projectTaskProgressRow(row: unknown): TaskProgressRow | undefined {
	if (!isRecordValue(row) || !isSeedTaskStatus(row.status)) return undefined;
	const progress = readTaskProgressFields({
		[TASK_PROGRESS_FIELD]: {
			kind: "task",
			schemaVersion: 1,
			done: row.status === "done" ? 1 : 0,
			total: 1,
			active: row.status === "active" ? "active" : null,
			blocked: row.status === "blocked" ? 1 : 0,
			outcome: row.status === "blocked" ? "stuck" : row.status === "done" || row.status === "deferred" ? "complete" : "gap",
			rows: [row],
		},
	});
	return progress?.rows?.[0];
}

export function projectTaskProgressFields(progress: unknown): TaskProgressFields | undefined {
	const normalized = isRecordValue(progress) && typeof progress.active === "string" && progress.active.length > MAX_SEED_TITLE_CHARS
		? { ...progress, active: boundActivityText(progress.active) }
		: progress;
	return readTaskProgressFields({ [TASK_PROGRESS_FIELD]: normalized });
}

function projectTaskLedger(ledger: unknown): TaskLedger | undefined {
	if (!isRecordValue(ledger) || !isRecordValue(ledger.counts) || !Array.isArray(ledger.rows) || !Array.isArray(ledger.unfinished)) return undefined;
	if (ledger.outcome !== "complete" && ledger.outcome !== "gap" && ledger.outcome !== "stuck") return undefined;
	const counts = ledger.counts;
	const numericCounts = ["done", "total", "blocked", "pending", "deferred"] as const;
	if (!numericCounts.every((key) => Number.isSafeInteger(counts[key]) && (counts[key] as number) >= 0)) return undefined;
	const active = counts.active === null
		? null
		: boundedString(counts.active, MAX_SEED_TITLE_CHARS)
			? counts.active
			: undefined;
	if (active === undefined) return undefined;
	const expectedTotal = (counts.done as number) + (counts.blocked as number) + (counts.pending as number) + (counts.deferred as number) + (active === null ? 0 : 1);
	if (!Number.isSafeInteger(expectedTotal) || expectedTotal !== counts.total) return undefined;
	const canonicalCounts = {
		done: counts.done as number,
		total: counts.total as number,
		active,
		blocked: counts.blocked as number,
		pending: counts.pending as number,
		deferred: counts.deferred as number,
	};
	if (ledger.outcome !== classifyTaskOutcome(canonicalCounts)) return undefined;

	const rows = ledger.rows.map(projectTaskProgressRow);
	if (!rows.every((row): row is TaskProgressRow => row !== undefined) || rows.length !== canonicalCounts.total) return undefined;
	const rowCounts = { done: 0, blocked: 0, pending: 0, active: 0, deferred: 0 };
	const rowByLogicalId = new Map<string, TaskProgressRow>();
	for (const row of rows) {
		rowCounts[row.status] += 1;
		const logicalId = row.idKind === "local" ? `local:${row.localTaskId}` : `owner:${row.ownerTaskId}`;
		if (rowByLogicalId.has(logicalId)) return undefined;
		rowByLogicalId.set(logicalId, row);
	}
	if (
		rowCounts.done !== canonicalCounts.done ||
		rowCounts.blocked !== canonicalCounts.blocked ||
		rowCounts.pending !== canonicalCounts.pending ||
		rowCounts.active !== (canonicalCounts.active === null ? 0 : 1) ||
		rowCounts.deferred !== canonicalCounts.deferred
	) return undefined;

	const unfinished = ledger.unfinished.map((item): TaskLedger["unfinished"][number] | undefined => {
		if (!isRecordValue(item) || !boundedString(item.id, MAX_SEED_TASK_ID_CHARS) || !boundedString(item.title, MAX_SEED_TITLE_CHARS) || !isSeedTaskStatus(item.status)) return undefined;
		if (item.status === "done" || item.status === "deferred") return undefined;
		const ownerTaskId = item.ownerTaskId === undefined
			? undefined
			: boundedString(item.ownerTaskId, MAX_SEED_TASK_ID_CHARS)
				? item.ownerTaskId
				: undefined;
		if (item.ownerTaskId !== undefined && ownerTaskId === undefined) return undefined;
		const note = item.note === undefined
			? undefined
			: boundedString(item.note, MAX_SEED_NOTE_CHARS)
				? item.note
				: undefined;
		if (item.note !== undefined && note === undefined) return undefined;
		const ref = isValidSeedRef(item.ref) ? item.ref : undefined;
		return {
			id: item.id,
			title: item.title,
			status: item.status,
			...(note === undefined ? {} : { note }),
			...(ownerTaskId === undefined ? {} : { ownerTaskId }),
			...(ref === undefined ? {} : { ref }),
		};
	});
	if (!unfinished.every((item): item is TaskLedger["unfinished"][number] => item !== undefined)) return undefined;
	const unfinishedByLogicalId = new Map<string, TaskLedger["unfinished"][number]>();
	for (const item of unfinished) {
		const logicalId = item.ownerTaskId === undefined ? `local:${item.id}` : `owner:${item.ownerTaskId}`;
		if (unfinishedByLogicalId.has(logicalId)) return undefined;
		const row = rowByLogicalId.get(logicalId);
		if (row === undefined || row.status !== item.status) return undefined;
		unfinishedByLogicalId.set(logicalId, item);
	}
	const expectedUnfinished = rows.filter((row) => row.status !== "done" && row.status !== "deferred");
	if (unfinished.length !== expectedUnfinished.length) return undefined;
	for (const row of expectedUnfinished) {
		const logicalId = row.idKind === "local" ? `local:${row.localTaskId}` : `owner:${row.ownerTaskId}`;
		if (!unfinishedByLogicalId.has(logicalId)) return undefined;
	}
	return {
		outcome: ledger.outcome,
		counts: canonicalCounts,
		rows,
		unfinished,
	};
}

function projectTimeoutTaskLedger(ledger: unknown): TaskLedger | undefined {
	if (!isRecordValue(ledger)) return undefined;
	if (Array.isArray(ledger.rows) && ledger.rows.length > TIMEOUT_TRANSCRIPT_MAX_ENTRIES) return undefined;
	if (Array.isArray(ledger.unfinished) && ledger.unfinished.length > TIMEOUT_TRANSCRIPT_MAX_ENTRIES) return undefined;
	return projectTaskLedger(ledger);
}

function projectWorktreeDiff(value: unknown): WorktreeDiff | undefined {
	if (!isRecordValue(value)) return undefined;
	const integer = (candidate: unknown): number | undefined =>
		typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : undefined;
	const index = integer(value.index);
	const filesChanged = integer(value.filesChanged);
	const insertions = integer(value.insertions);
	const deletions = integer(value.deletions);
	if (index === undefined || typeof value.agent !== "string" || typeof value.branch !== "string" ||
		typeof value.diffStat !== "string" || filesChanged === undefined ||
		insertions === undefined || deletions === undefined || typeof value.patchPath !== "string") return undefined;
	return {
		index,
		agent: boundMutationText(value.agent, MAX_PATH_BYTES),
		branch: boundMutationText(value.branch, MAX_PATH_BYTES),
		diffStat: boundMutationText(value.diffStat, MAX_DIAGNOSTIC_DETAIL),
		filesChanged,
		insertions,
		deletions,
		patchPath: boundMutationText(value.patchPath, MAX_PATH_BYTES),
		...(value.captureFailed === true ? { captureFailed: true as const } : {}),
		...(value.captureFailed === true && typeof value.worktreePath === "string"
			? { worktreePath: boundMutationText(value.worktreePath, MAX_PATH_BYTES) }
			: {}),
	};
}

function projectMutationReport(report: unknown): MutationReport | undefined {
	if (!isRecordValue(report)) return undefined;
	try {
		const status = report.status;
	if (status === "tracked") {
		const repositoryRoot = report.repositoryRoot;
		const changedPaths = report.changedPaths;
		if (typeof repositoryRoot !== "string" || !Array.isArray(changedPaths)) return undefined;
		const hasOmittedPathCount = Object.prototype.hasOwnProperty.call(report, "omittedPathCount");
		const suppliedOmittedValue = hasOmittedPathCount ? report.omittedPathCount : undefined;
		if (hasOmittedPathCount && (typeof suppliedOmittedValue !== "number" || !Number.isSafeInteger(suppliedOmittedValue) || suppliedOmittedValue < 0)) {
			return undefined;
		}
		const suppliedOmitted = (suppliedOmittedValue as number | undefined) ?? 0;
		const suppliedTruncated = report.truncated;
		const pathCount = changedPaths.length;
		const boundedPaths: string[] = [];
		let retainedPathBytes = 0;
		let omitted = Math.max(0, pathCount - MAX_PATHS);
		const keptLength = Math.min(pathCount, MAX_PATHS);
		for (let index = 0; index < keptLength; index += 1) {
			if (!Object.prototype.hasOwnProperty.call(changedPaths, index)) return undefined;
			const path = changedPaths[index];
			if (typeof path !== "string") return undefined;
			const pathBytes = Buffer.byteLength(path, "utf8");
			if (pathBytes > MAX_PATH_BYTES - retainedPathBytes) {
				omitted += 1;
				continue;
			}
			boundedPaths.push(path);
			retainedPathBytes += pathBytes;
		}
		const omittedPathCount = Math.min(Number.MAX_SAFE_INTEGER, suppliedOmitted + omitted);
		return {
			status: "tracked",
			repositoryRoot: boundMutationText(repositoryRoot, MAX_REPOSITORY_ROOT_BYTES),
			changedPaths: boundedPaths,
			...(suppliedTruncated === true || omitted > 0 || suppliedOmitted > 0 ? { truncated: true as const } : {}),
			...(omittedPathCount > 0 ? { omittedPathCount } : {}),
		};
	}
	if (status === "not-tracked") {
		const reason = report.reason;
		const detail = report.detail;
		if (!isMutationNotTrackedReason(reason)) return undefined;
		return {
			status: "not-tracked",
			reason,
			...(typeof detail === "string" ? { detail: boundMutationText(detail, MAX_DIAGNOSTIC_DETAIL) } : {}),
		};
	}
		return undefined;
	} catch {
		// Caller-owned report accessors must not be able to break projection.
		return undefined;
	}
}

function projectHarvestOutcome(harvest: unknown, timeoutSalvage = false): HarvestOutcome | undefined {
	if (!isRecordValue(harvest)) return undefined;
	if (harvest.kind === "substantive" && (harvest.method === "terminal" || harvest.method === "salvage") && typeof harvest.text === "string") {
		return { kind: "substantive", method: harvest.method, text: timeoutSalvage ? truncateRecoveryText(harvest.text, TIMEOUT_ASSISTANT_MAX_BYTES) : harvest.text };
	}
	if (harvest.kind === "failure" && typeof harvest.error === "string") {
		return {
			kind: "failure",
			error: timeoutSalvage ? truncateRecoveryText(harvest.error, TIMEOUT_ASSISTANT_MAX_BYTES) : harvest.error,
			...(isWorkerErrorKind(harvest.errorKind) ? { errorKind: harvest.errorKind } : {}),
			...(typeof harvest.stopReason === "string" ? { stopReason: projectTimeoutString(harvest.stopReason, timeoutSalvage) } : {}),
		};
	}
	if (harvest.kind === "missing" && (harvest.reason === "no-assistant" || harvest.reason === "empty" || harvest.reason === "cancellation-only") && harvest.text === "") {
		return { kind: "missing", reason: harvest.reason, text: "" };
	}
	return undefined;
}

function projectPriorWorkerSession(session: unknown, timeoutSalvage = false): PriorWorkerSession | undefined {
	if (!isRecordValue(session) || !Array.isArray(session.messagesSnapshot) || !isFiniteNumber(session.endedAt) || typeof session.restartMessage !== "string") return undefined;
	const projectedMessages = session.messagesSnapshot
		.slice(timeoutSalvage ? -TIMEOUT_TRANSCRIPT_MAX_ENTRIES : undefined)
		.map((message) => projectAgentMessage(message, timeoutSalvage))
		.filter((message): message is AgentMessage => message !== undefined);
	if (session.messagesSnapshot.length > 0 && projectedMessages.length === 0) return undefined;
	return {
		...(typeof session.sessionFile === "string" ? { sessionFile: projectTimeoutString(session.sessionFile, timeoutSalvage) } : {}),
		messagesSnapshot: projectedMessages,
		endedAt: session.endedAt,
		...(session.retirementReason === "restart_worker" || session.retirementReason === "refusal-fallback" || session.retirementReason === "transient-fallback"
			? { retirementReason: session.retirementReason }
			: {}),
		restartMessage: timeoutSalvage ? truncateRecoveryText(session.restartMessage, TIMEOUT_TRANSCRIPT_ENTRY_MAX_BYTES) : session.restartMessage,
	};
}

/** Project one typed SDK content block without copying open-ended nested fields. */
function projectAgentContentBlock(value: unknown, role: "user" | "assistant" | "toolResult", timeoutSalvage = false): RecordValue | undefined {
	if (!isRecordValue(value) || typeof value.type !== "string") return undefined;
	if (value.type === "text" && typeof value.text === "string" && value.text.length > 0) {
		return {
			type: "text",
			text: projectTimeoutString(value.text, timeoutSalvage)!,
			...(typeof value.textSignature === "string" ? { textSignature: projectTimeoutString(value.textSignature, timeoutSalvage) } : {}),
		};
	}
	if (value.type === "image" && role !== "assistant" && typeof value.data === "string" && value.data.length > 0 && typeof value.mimeType === "string" && value.mimeType.length > 0) {
		return { type: "image", data: projectTimeoutString(value.data, timeoutSalvage)!, mimeType: projectTimeoutString(value.mimeType, timeoutSalvage)! };
	}
	if (value.type === "thinking" && role === "assistant" && typeof value.thinking === "string" && value.thinking.length > 0) {
		return {
			type: "thinking",
			thinking: projectTimeoutString(value.thinking, timeoutSalvage)!,
			...(typeof value.thinkingSignature === "string" ? { thinkingSignature: projectTimeoutString(value.thinkingSignature, timeoutSalvage) } : {}),
			...(typeof value.redacted === "boolean" ? { redacted: value.redacted } : {}),
		};
	}
	if (value.type === "toolCall" && role === "assistant" && typeof value.id === "string" && value.id.length > 0 && typeof value.name === "string" && value.name.length > 0 && isRecordValue(value.arguments)) {
		return {
			type: "toolCall",
			id: projectTimeoutString(value.id, timeoutSalvage)!,
			name: projectTimeoutString(value.name, timeoutSalvage)!,
			// Tool arguments are tool-defined and intentionally not a closed DTO.
			// Keep the replay-safe call identity while preventing arbitrary nested
			// caller data from crossing the retired-session snapshot boundary.
			arguments: {},
			...(typeof value.thoughtSignature === "string" ? { thoughtSignature: projectTimeoutString(value.thoughtSignature, timeoutSalvage) } : {}),
			...(typeof value.namespace === "string" ? { namespace: projectTimeoutString(value.namespace, timeoutSalvage) } : {}),
		};
	}
	return undefined;
}

function projectAgentContent(
	value: unknown,
	role: "user" | "assistant" | "toolResult",
	allowEmptyAssistant: boolean = false,
	timeoutSalvage = false,
): string | RecordValue[] | undefined {
	if (role === "user" && typeof value === "string" && value.length > 0) return timeoutSalvage ? truncateRecoveryText(value, TIMEOUT_TRANSCRIPT_ENTRY_MAX_BYTES) : value;
	if (!Array.isArray(value) || (value.length === 0 && !(role === "assistant" && allowEmptyAssistant))) return undefined;
	const blocks = timeoutSalvage ? value.slice(-TIMEOUT_TRANSCRIPT_MAX_ENTRIES) : value;
	const projected = blocks.map((block) => projectAgentContentBlock(block, role, timeoutSalvage));
	return projected.every((block): block is RecordValue => block !== undefined) ? projected : undefined;
}

function projectAgentSdkUsage(value: unknown): RecordValue | undefined {
	if (!isRecordValue(value) || !isRecordValue(value.cost)) return undefined;
	const number = (record: RecordValue, key: string): number | undefined => {
		if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
		const candidate = record[key];
		return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 ? candidate : undefined;
	};
	const required = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
	const costRequired = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;
	if (!required.every((key) => number(value, key) !== undefined) || !costRequired.every((key) => number(value.cost as RecordValue, key) !== undefined)) return undefined;
	const optional = (key: string): number | undefined => {
		if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) return undefined;
		return number(value, key);
	};
	if (
		(Object.prototype.hasOwnProperty.call(value, "cacheWrite1h") && value.cacheWrite1h !== undefined && optional("cacheWrite1h") === undefined) ||
		(Object.prototype.hasOwnProperty.call(value, "reasoning") && value.reasoning !== undefined && optional("reasoning") === undefined)
	) return undefined;
	const cacheWrite1h = optional("cacheWrite1h");
	const reasoning = optional("reasoning");
	return {
		...Object.fromEntries(required.map((key) => [key, number(value, key)])),
		...(cacheWrite1h !== undefined ? { cacheWrite1h } : {}),
		...(reasoning !== undefined ? { reasoning } : {}),
		cost: Object.fromEntries(costRequired.map((key) => [key, number(value.cost as RecordValue, key)])),
	};
}

/** Project the closed supervisor finish DTO; only string outputs are retained. */
function projectSupervisorFinishPayload(
	payload: unknown,
	timeoutSalvage = false,
): RunResult["supervisorFinishPayload"] | undefined {
	if (!isRecordValue(payload)) return undefined;
	return {
		...(typeof payload.final_output === "string" ? { final_output: timeoutSalvage ? truncateRecoveryText(payload.final_output, TIMEOUT_ASSISTANT_MAX_BYTES) : payload.final_output } : {}),
		...(typeof payload.summary === "string" ? { summary: timeoutSalvage ? truncateRecoveryText(payload.summary, TIMEOUT_ASSISTANT_MAX_BYTES) : payload.summary } : {}),
	};
}

/** Preserve only the SDK message fields required for transcript reconstruction. */
function projectAgentMessage(message: unknown, timeoutSalvage = false): AgentMessage | undefined {
	if (!isRecordValue(message)) return undefined;
	if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return undefined;
	const role = message.role;
	const timestamp = optionalFiniteNumber(message.timestamp);
	if (timestamp === undefined) return undefined;
	if (role === "assistant") {
		if (typeof message.api !== "string" || message.api.length === 0 || typeof message.provider !== "string" || message.provider.length === 0 || typeof message.model !== "string" || message.model.length === 0) return undefined;
		if (message.stopReason !== "pending" && message.stopReason !== "stop" && message.stopReason !== "length" && message.stopReason !== "toolUse" && message.stopReason !== "error" && message.stopReason !== "aborted" && message.stopReason !== "deferred") return undefined;
	}
	const content = projectAgentContent(message.content, role, role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted"), timeoutSalvage);
	if (content === undefined) return undefined;
	const projected: AgentMessage = { role, content, timestamp };
	if (role === "user") return projected;
	if (role === "assistant") {
		const usage = projectAgentSdkUsage(message.usage);
		if (usage === undefined) return undefined;
		projected.api = projectTimeoutString(message.api, timeoutSalvage)!;
		projected.provider = projectTimeoutString(message.provider, timeoutSalvage)!;
		projected.model = projectTimeoutString(message.model, timeoutSalvage)!;
		projected.stopReason = message.stopReason;
		projected.usage = usage;
		for (const key of ["responseModel", "responseId", "errorMessage", "rawStopReason"] as const) {
			if (typeof message[key] === "string") projected[key] = timeoutSalvage ? truncateRecoveryText(message[key], TIMEOUT_TRANSCRIPT_ENTRY_MAX_BYTES) : message[key];
		}
		if (typeof message.endTurn === "boolean") projected.endTurn = message.endTurn;
		return projected;
	}
	if (typeof message.toolCallId !== "string" || message.toolCallId.length === 0 || typeof message.toolName !== "string" || message.toolName.length === 0 || typeof message.isError !== "boolean") return undefined;
	projected.toolCallId = projectTimeoutString(message.toolCallId, timeoutSalvage)!;
	projected.toolName = projectTimeoutString(message.toolName, timeoutSalvage)!;
	projected.isError = message.isError;
	const usage = projectAgentSdkUsage(message.usage);
	if (usage !== undefined) projected.usage = usage;
	if (Array.isArray(message.addedToolNames)) {
		const names: string[] = [];
		const limit = timeoutSalvage
			? Math.min(message.addedToolNames.length, TIMEOUT_TRANSCRIPT_MAX_ENTRIES)
			: message.addedToolNames.length;
		for (let index = 0; index < limit; index += 1) {
			if (!Object.prototype.hasOwnProperty.call(message.addedToolNames, index)) return undefined;
			const name = message.addedToolNames[index];
			if (typeof name !== "string") return undefined;
			names.push(projectTimeoutString(name, timeoutSalvage)!);
		}
		projected.addedToolNames = names;
	}
	return projected;
}

export function projectRunUsage(usage: unknown, timeoutSalvage = false): RunResult["usage"] | undefined {
	if (!isRecordValue(usage)) return undefined;
	const normalized = normalizeUsageCounters(usage);
	const values = normalized.usage;
	const persistedDiagnostics = Array.isArray(usage.diagnostics)
		? (timeoutSalvage ? usage.diagnostics.slice(-TIMEOUT_TRANSCRIPT_MAX_ENTRIES) : usage.diagnostics)
		: usage.diagnostics;
	const diagnostics = diagnosticsWithGenerated(
		persistedDiagnostics,
		normalized.diagnostics,
	);
	return {
		supervisorInput: values.supervisorInput ?? 0,
		supervisorOutput: values.supervisorOutput ?? 0,
		...(values.supervisorCacheRead === undefined ? {} : { supervisorCacheRead: values.supervisorCacheRead }),
		...(values.supervisorCacheWrite === undefined ? {} : { supervisorCacheWrite: values.supervisorCacheWrite }),
		workerInput: values.workerInput ?? 0,
		workerOutput: values.workerOutput ?? 0,
		...(values.workerCacheRead === undefined ? {} : { workerCacheRead: values.workerCacheRead }),
		...(values.workerCacheWrite === undefined ? {} : { workerCacheWrite: values.workerCacheWrite }),
		...(values.tickerInput === undefined ? {} : { tickerInput: values.tickerInput }),
		...(values.tickerOutput === undefined ? {} : { tickerOutput: values.tickerOutput }),
		...(values.tickerCacheRead === undefined ? {} : { tickerCacheRead: values.tickerCacheRead }),
		...(values.tickerCacheWrite === undefined ? {} : { tickerCacheWrite: values.tickerCacheWrite }),
		...(values.tickerCost === undefined ? {} : { tickerCost: values.tickerCost }),
		...(diagnostics.length === 0 ? {} : { diagnostics }),
		cost: values.cost ?? 0,
	};
}

/**
 * Project a result at an ownership boundary. Every stable result and nested
 * field is copied by name so caller-owned unknown properties cannot cross into
 * runtime state, persistence, events, wakes, or tool details.
 */
export function projectRunResult(
	result: RunResult & Partial<RunResultDetailExtensions> | RecordValue,
	_options: Readonly<Record<string, unknown>> = {},
): ProjectedRunResult {
	const timeoutSalvage = result.status === "aborted" && result.cancelReason === "timeout";
	const projectedRefusalModels = projectTimeoutStringArray(result.refusalModels, timeoutSalvage);
	const projectedAttemptedModels = projectTimeoutStringArray(result.attemptedModels, timeoutSalvage);
	const inputDigestSource = Array.isArray(result.inputDigests)
		? (timeoutSalvage ? result.inputDigests.slice(-TIMEOUT_TRANSCRIPT_MAX_ENTRIES) : result.inputDigests)
		: undefined;
	const inputDigests = inputDigestSource?.flatMap((digest) => {
		if (!isRecordValue(digest) || !isFiniteNumber(digest.sequence) || digest.algorithm !== "sha256" || typeof digest.digest !== "string") return [];
		return [{ sequence: digest.sequence, algorithm: "sha256" as const, digest: projectTimeoutString(digest.digest, timeoutSalvage)! }];
	});
	const policyRefusalSource = Array.isArray(result.policyRefusals)
		? (timeoutSalvage ? result.policyRefusals.slice(-32) : result.policyRefusals)
		: undefined;
	const policyRefusals = policyRefusalSource
		? policyRefusalSource.flatMap((refusal) => {
			if (!isRecordValue(refusal) || typeof refusal.reason !== "string") return [];
			const boundary: "readOnly" | "writableRoot" | undefined = refusal.boundary === "readOnly" || refusal.boundary === "writableRoot" ? refusal.boundary : undefined;
			const toolName: "write" | "edit" | "bash" | undefined = refusal.toolName === "write" || refusal.toolName === "edit" || refusal.toolName === "bash" ? refusal.toolName : undefined;
			if (boundary === undefined || toolName === undefined) return [];
			const projectedRefusal: { boundary: "readOnly" | "writableRoot"; toolName: "write" | "edit" | "bash"; reason: string } = {
				boundary,
				toolName,
				reason: projectTimeoutString(refusal.reason, timeoutSalvage)!,
			};
			return [projectedRefusal];
		})
		: undefined;
	const timeout = isRecordValue(result.timeout) && isFiniteNumber(result.timeout.maxDurationMs) && isFiniteNumber(result.timeout.windDownGraceMs) && isFiniteNumber(result.timeout.globalMaxDurationMs)
		? {
			maxDurationMs: result.timeout.maxDurationMs,
			windDownGraceMs: result.timeout.windDownGraceMs,
			globalMaxDurationMs: result.timeout.globalMaxDurationMs,
			...(typeof result.timeout.enforceWallClockBudget === "boolean"
				? { enforceWallClockBudget: result.timeout.enforceWallClockBudget }
				: {}),
			...(isFiniteNumber(result.timeout.deadlineAtMs) ? { deadlineAtMs: result.timeout.deadlineAtMs } : {}),
		}
		: undefined;
	const sourceCollapsedContent = optionalString(result.collapsedContent) ?? "";
	const terminalResult = result.status === "completed" || result.status === "failed" || result.status === "aborted" || result.status === "paused";
	const retainedCollapsedContent = typeof result === "object" && result !== null
		? (getUncappedResultContent(result, { terminal: terminalResult }) ?? sourceCollapsedContent)
		: sourceCollapsedContent;
	if (typeof result === "object" && result !== null) {
		rememberUncappedResultContent(result, retainedCollapsedContent, { terminal: terminalResult });
	}
	const cappedResult = _options.capDelegateOnlyResult === false
		? { text: retainedCollapsedContent, truncated: false as const }
		: capDelegateOnlyResult(
			retainedCollapsedContent,
			typeof result.workerSessionFile === "string" ? result.workerSessionFile : (typeof result.name === "string" ? result.name : "unknown-worker"),
		);
	const projectedPriorWorkerSessions = Array.isArray(result.priorWorkerSessions)
		? result.priorWorkerSessions
			.slice(timeoutSalvage ? -TIMEOUT_PRIOR_WORKER_SESSIONS_MAX : undefined)
			.map((session) => projectPriorWorkerSession(session, timeoutSalvage))
			.filter((session): session is PriorWorkerSession => session !== undefined)
		: undefined;
	const priorWorkerSessions = projectedPriorWorkerSessions === undefined || projectedPriorWorkerSessions.length === 0
		? undefined
		: projectedPriorWorkerSessions;
	const activeToolNames = (() => {
		const source = Object.prototype.hasOwnProperty.call(result, "activeToolNames") ? result.activeToolNames : undefined;
		if (!Array.isArray(source)) return undefined;
		const projectedNames: string[] = [];
		const limit = timeoutSalvage ? Math.min(source.length, TIMEOUT_TRANSCRIPT_MAX_ENTRIES) : source.length;
		for (let index = 0; index < limit; index += 1) {
			if (!Object.prototype.hasOwnProperty.call(source, index)) return undefined;
			const name = source[index];
			if (typeof name !== "string") return undefined;
			projectedNames.push(projectTimeoutString(name, timeoutSalvage)!);
		}
		return projectedNames;
	})();
	const promptRepairs = projectPromptRepairRecords(result.promptRepairs);
	const projected: ProjectedRunResult = {
		name: projectTimeoutString(result.name, timeoutSalvage) ?? "",
		agent: projectTimeoutString(result.agent, timeoutSalvage) ?? "",
		agentSource: isAgentSource(result.agentSource) ? result.agentSource : "builtin",
		task: projectTimeoutString(result.task, timeoutSalvage) ?? "",
		status: isRunStatus(result.status) ? result.status : "failed",
		...(Object.prototype.hasOwnProperty.call(result, "attempt") && isValidAttempt(result.attempt) ? { attempt: result.attempt } : {}),
		roundsUsed: optionalFiniteNumber(result.roundsUsed) ?? 0,
		maxRounds: optionalFiniteNumber(result.maxRounds) ?? 0,
		collapseMode: isCollapseMode(result.collapseMode) ? result.collapseMode : "final_output",
		collapsedContent: timeoutSalvage
			? (timeoutBoundedText(cappedResult.text, TIMEOUT_ASSISTANT_MAX_BYTES) ?? "")
			: cappedResult.text,
		...(typeof result.workerSessionFile === "string" ? { workerSessionFile: projectTimeoutString(result.workerSessionFile, timeoutSalvage) } : {}),
		...(activeToolNames !== undefined ? { activeToolNames } : {}),
		...(inputDigests !== undefined ? { inputDigests } : {}),
		...(result.taskLedger !== undefined ? { taskLedger: timeoutSalvage ? projectTimeoutTaskLedger(result.taskLedger) : projectTaskLedger(result.taskLedger) } : {}),
		...(typeof result.recoveredOutput === "boolean" ? { recoveredOutput: result.recoveredOutput } : {}),
		...(typeof result.workerCwd === "string" ? { workerCwd: projectTimeoutString(result.workerCwd, timeoutSalvage) } : {}),
		transcript: (() => {
			const transcriptSource = Array.isArray(result.transcript)
				? (timeoutSalvage ? result.transcript.slice(-TIMEOUT_TRANSCRIPT_MAX_ENTRIES) : result.transcript)
				: [];
			const projectedTranscript = transcriptSource
				.map(projectTranscriptEntry).filter((entry): entry is RunResult["transcript"][number] => entry !== undefined);
			return timeoutSalvage ? boundRunTimeoutTranscript(projectedTranscript) : projectedTranscript;
		})(),
		...(promptRepairs !== undefined ? { promptRepairs } : {}),
		...(result.supervisorFinishPayload !== undefined
			? { supervisorFinishPayload: projectSupervisorFinishPayload(result.supervisorFinishPayload, timeoutSalvage) }
			: {}),
		...(typeof result.summaryModelUsed === "string" ? { summaryModelUsed: projectTimeoutString(result.summaryModelUsed, timeoutSalvage) } : {}),
		...(typeof result.summaryFallbackReason === "string" ? { summaryFallbackReason: projectTimeoutString(result.summaryFallbackReason, timeoutSalvage) } : {}),
		...(typeof result.error === "string" ? { error: projectTimeoutString(result.error, timeoutSalvage) } : {}),
		...(isWorkerErrorKind(result.errorKind) ? { errorKind: result.errorKind } : {}),
		...(isWorkerRetryKind(result.retryKind) ? { retryKind: result.retryKind } : {}),
		// A closed categorical value, so it survives the detached/serialized path
		// intact the way `retryKind` does. An unrecognised value is dropped, not
		// forwarded: a caller must be able to trust the category it reads.
		...(isWorkerFailureCause(result.failureCause) ? { failureCause: result.failureCause } : {}),
		...(projectedRefusalModels !== undefined ? { refusalModels: projectedRefusalModels } : {}),
		...(policyRefusals !== undefined ? { policyRefusals } : {}),
		...(result.mutationReport !== undefined ? { mutationReport: projectMutationReport(result.mutationReport) } : {}),
		...(result.worktreeDiff !== undefined ? { worktreeDiff: projectWorktreeDiff(result.worktreeDiff) } : {}),
		...(typeof result.workerModel === "string" ? { workerModel: projectTimeoutString(result.workerModel, timeoutSalvage) } : {}),
		...(projectedAttemptedModels !== undefined ? { attemptedModels: projectedAttemptedModels } : {}),		...(isCancelReason(result.cancelReason) ? { cancelReason: result.cancelReason } : {}),
		...(typeof result.steered === "boolean" ? { steered: result.steered } : {}),
		...(timeout !== undefined ? { timeout } : {}),
		...(priorWorkerSessions !== undefined ? { priorWorkerSessions } : {}),
		usage: projectRunUsage(result.usage, timeoutSalvage) ?? {
			supervisorInput: 0,
			supervisorOutput: 0,
			workerInput: 0,
			workerOutput: 0,
			cost: 0,
		},
	};
	// Preserve the historical own-property shape for known optional fields,
	// including explicit `undefined`, while still excluding unknown fields.
	for (const key of [
		"workerSessionFile", "inputDigests", "taskLedger", "recoveredOutput", "workerCwd", "promptRepairs",
		"supervisorFinishPayload", "summaryModelUsed", "summaryFallbackReason", "error", "errorKind", "retryKind",
		"failureCause",
		"refusalModels", "policyRefusals", "mutationReport", "worktreeDiff", "workerModel", "attemptedModels", "cancelReason",
		"steered", "timeout", "priorWorkerSessions",
	] as const) {
		if (Object.prototype.hasOwnProperty.call(result, key) && !Object.prototype.hasOwnProperty.call(projected, key)) {
			Reflect.defineProperty(projected, key, {
				value: undefined,
				enumerable: true,
				configurable: true,
				writable: true,
			});
		}
	}

	const harvest = projectHarvestOutcome(result.harvest, timeoutSalvage);
	if (harvest !== undefined) projected.harvest = harvest;
	if (isRecordValue(result.outputFile) && typeof result.outputFile.absolutePath === "string" && isFiniteNumber(result.outputFile.bytes)) {
		projected.outputFile = {
			absolutePath: projectTimeoutString(result.outputFile.absolutePath, timeoutSalvage)!,
			bytes: result.outputFile.bytes,
		};
	}
	try {
		if (result.artifactRef !== undefined) projected.artifactRef = validateWorkerArtifactReference(result.artifactRef);
	} catch { /* malformed or forged references do not cross the result boundary */ }
	if (isRecordValue(result.artifactError) &&
		(result.artifactError.kind === "storage-busy" || result.artifactError.kind === "artifact-unavailable") &&
		typeof result.artifactError.message === "string" && typeof result.artifactError.retryable === "boolean") {
		projected.artifactError = {
			kind: result.artifactError.kind,
			message: projectTimeoutString(result.artifactError.message, timeoutSalvage)!,
			retryable: result.artifactError.retryable,
		};
	}
	if (Array.isArray(result.warnings)) {
		const sourceWarnings = timeoutSalvage ? result.warnings.slice(-TIMEOUT_TRANSCRIPT_MAX_ENTRIES) : result.warnings;
		const warnings = sourceWarnings.flatMap((warning) => {
			if (!isRecordValue(warning) || typeof warning.message !== "string") return [];
			// `policy` must survive the boundary: dropping it would silently discard
			// the refused-write verdict this projection exists to carry (#536).
			const kind: "reads" | "output" | "progress" | "policy" | undefined = warning.kind === "reads" || warning.kind === "output" || warning.kind === "progress" || warning.kind === "policy" ? warning.kind : undefined;
			if (kind === undefined) return [];
			const projectedWarning: { kind: "reads" | "output" | "progress" | "policy"; message: string } = {
				kind,
				message: projectTimeoutString(warning.message, timeoutSalvage)!,
			};
			return [projectedWarning];
		});
		projected.warnings = warnings;
	}
	if (cappedResult.advisoryWarning !== undefined) {
		projected.warnings = [
			...(projected.warnings ?? []),
			{ kind: "output", message: cappedResult.advisoryWarning },
		];
	}
	if (typeof result === "object" && result !== null) {
		rememberUncappedResultContent(projected, retainedCollapsedContent, { terminal: terminalResult });
	}
	return projected;
}

export function projectRunResults(
	results: readonly RunResult[],
	_options: Readonly<Record<string, unknown>> = {},
): ProjectedRunResult[] {
	return results.map((result) => projectRunResult(result, _options));
}
