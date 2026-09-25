import type { ActorActivityPhase } from "./actor-activity.js";
import type { TranscriptEntry } from "./summarize.js";

/** Optional worker-extension contract. Neither package imports the other. */
export const PROMPT_REPAIR_ENTRY_TYPE = "prompt-repair" as const;
export const PROMPT_REPAIR_ACTIVITY_CHANNEL = "prompt-repair:activity" as const;
export const PROMPT_REPAIR_DELEGATE_ENTRY_TYPE = "pi-delegate.prompt-repair.v1" as const;
export const PROMPT_REPAIR_SCHEMA_VERSION = 1 as const;
export const PROMPT_REPAIR_MAX_ATTEMPTS = 2 as const;

const MAX_REFUSAL_CHARS = 8_192;
const MAX_DIFF_CHARS = 128 * 1_024;
const MAX_PROMPT_CHARS = 64 * 1_024;
const MAX_REPAIR_ERROR_CHARS = 8_192;

export type PromptRepairOutcome = "accepted" | "refused" | "repair-failed";

export interface PromptRepairRecord {
	readonly schemaVersion: typeof PROMPT_REPAIR_SCHEMA_VERSION;
	readonly attempt: 1 | 2;
	readonly maxAttempts: typeof PROMPT_REPAIR_MAX_ATTEMPTS;
	readonly refusal: string;
	readonly repairModel: string;
	readonly outcome: PromptRepairOutcome;
	readonly diff?: string;
	readonly repairError?: string;
	/** Present only on the terminal record. The existing fallback consumes it. */
	readonly finalPrompt?: string;
	readonly timestamp: number;
}

export interface PromptRepairActivityProjection {
	readonly phase: Extract<ActorActivityPhase, "repairing-prompt" | "retrying-primary">;
	readonly message: string;
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface PromptRepairDelegateSeed {
	readonly schemaVersion: typeof PROMPT_REPAIR_SCHEMA_VERSION;
	readonly eligible: boolean;
}

export function buildPromptRepairDelegateSeed(eligible: boolean): PromptRepairDelegateSeed {
	return { schemaVersion: PROMPT_REPAIR_SCHEMA_VERSION, eligible };
}

function boundedText(value: unknown, maxChars: number): string | undefined {
	return typeof value === "string" && value.trim().length > 0 && value.length <= maxChars
		? value
		: undefined;
}

function exactModelRef(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*\/\S+$/u.test(value) && !/\s/u.test(value);
}

function promptRepairOutcome(value: unknown): PromptRepairOutcome | undefined {
	return value === "accepted" || value === "refused" || value === "repair-failed" ? value : undefined;
}

/** Validate one custom SessionEntry at the package boundary and copy named fields only. */
export function parsePromptRepairRecord(entry: unknown): PromptRepairRecord | undefined {
	if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== PROMPT_REPAIR_ENTRY_TYPE) return undefined;
	const data = entry.data;
	if (!isRecord(data) || data.schemaVersion !== PROMPT_REPAIR_SCHEMA_VERSION) return undefined;
	if ((data.attempt !== 1 && data.attempt !== 2) || data.maxAttempts !== PROMPT_REPAIR_MAX_ATTEMPTS) return undefined;
	const refusal = boundedText(data.refusal, MAX_REFUSAL_CHARS);
	const outcome = promptRepairOutcome(data.outcome);
	if (!refusal || !outcome || !exactModelRef(data.repairModel)) return undefined;
	if (typeof data.timestamp !== "number" || !Number.isFinite(data.timestamp) || data.timestamp < 0) return undefined;

	const diff = data.diff === undefined ? undefined : boundedText(data.diff, MAX_DIFF_CHARS);
	const repairError = data.repairError === undefined
		? undefined
		: boundedText(data.repairError, MAX_REPAIR_ERROR_CHARS);
	const finalPrompt = data.finalPrompt === undefined
		? undefined
		: boundedText(data.finalPrompt, MAX_PROMPT_CHARS);
	if (data.diff !== undefined && diff === undefined) return undefined;
	if (data.repairError !== undefined && repairError === undefined) return undefined;
	if (data.finalPrompt !== undefined && finalPrompt === undefined) return undefined;
	if ((outcome === "accepted" || outcome === "refused") && diff === undefined) return undefined;
	if (outcome === "repair-failed" && repairError === undefined) return undefined;
	if (outcome !== "repair-failed" && repairError !== undefined) return undefined;
	if ((outcome === "accepted" || data.attempt === PROMPT_REPAIR_MAX_ATTEMPTS) && finalPrompt === undefined) return undefined;

	return {
		schemaVersion: PROMPT_REPAIR_SCHEMA_VERSION,
		attempt: data.attempt,
		maxAttempts: PROMPT_REPAIR_MAX_ATTEMPTS,
		refusal,
		repairModel: data.repairModel,
		outcome,
		...(diff === undefined ? {} : { diff }),
		...(repairError === undefined ? {} : { repairError }),
		...(finalPrompt === undefined ? {} : { finalPrompt }),
		timestamp: data.timestamp,
	};
}

/** Read every valid prompt-repair entry in append order. */
export function readPromptRepairRecords(entries: readonly unknown[]): PromptRepairRecord[] {
	return entries.flatMap((entry) => {
		const record = parsePromptRepairRecord(entry);
		return record ? [record] : [];
	});
}

/** Merge snapshots by attempt; later timestamps win and output stays attempt ordered. */
export function mergePromptRepairRecords(
	current: readonly PromptRepairRecord[],
	incoming: readonly PromptRepairRecord[],
): PromptRepairRecord[] {
	const byAttempt = new Map<number, PromptRepairRecord>();
	for (const record of [...current, ...incoming]) {
		const prior = byAttempt.get(record.attempt);
		if (!prior || record.timestamp >= prior.timestamp) byAttempt.set(record.attempt, { ...record });
	}
	return [...byAttempt.values()].sort((left, right) => left.attempt - right.attempt);
}

/** A terminal repaired prompt overrides only the message handed to the existing fallback. */
export function promptRepairFallbackPrompt(records: readonly PromptRepairRecord[]): string | undefined {
	const latest = [...records].sort((left, right) => left.attempt - right.attempt).at(-1);
	if (!latest || latest.outcome === "accepted") return undefined;
	return latest.finalPrompt;
}

/** Read the terminal override from the refusing worker session, never from run-wide history. */
export function promptRepairFallbackPromptFromEntries(entries: readonly unknown[]): string | undefined {
	return promptRepairFallbackPrompt(readPromptRepairRecords(entries));
}

function fenceFor(text: string): string {
	const longest = Math.max(0, ...[...text.matchAll(/`+/gu)].map((match) => match[0].length));
	return "`".repeat(Math.max(3, longest + 1));
}

/** Human-readable record shared by transcript, final result, and expanded tool UI. */
export function renderPromptRepairRecord(record: PromptRepairRecord): string {
	const lines = [
		`### Prompt repair attempt ${record.attempt}/${record.maxAttempts} — ${record.outcome}`,
		"",
		`Repair model: \`${record.repairModel}\``,
		"",
		"Original provider refusal:",
		"",
		record.refusal,
	];
	if (record.diff) {
		const fence = fenceFor(record.diff);
		lines.push("", "Unified prompt diff:", "", `${fence}diff`, record.diff, fence);
	}
	if (record.repairError) lines.push("", "Repair failure:", "", record.repairError);
	if (record.finalPrompt) {
		const fence = fenceFor(record.finalPrompt);
		lines.push("", "Full final revised prompt:", "", `${fence}text`, record.finalPrompt, fence);
	}
	return lines.join("\n");
}

export function renderPromptRepairReport(records: readonly PromptRepairRecord[]): string {
	if (records.length === 0) return "";
	return ["## Prompt repair history", ...records.map(renderPromptRepairRecord)].join("\n\n");
}

export function promptRepairTranscriptEntries(records: readonly PromptRepairRecord[]): TranscriptEntry[] {
	return records.map((record) => ({
		source: "worker",
		role: "system",
		customType: PROMPT_REPAIR_ENTRY_TYPE,
		text: renderPromptRepairRecord(record),
		timestamp: record.timestamp,
	}));
}

const PROMPT_REPAIR_PRESERVED_AGENT_EVENTS = new Set([
	"agent_start",
	"agent_end",
	"agent_settled",
	"turn_start",
	"message_start",
	"queue_update",
]);

/** Keep a queued repair phase visible until the retried model produces output or a tool. */
export function shouldPreservePromptRepairActivity(eventType: string): boolean {
	return PROMPT_REPAIR_PRESERVED_AGENT_EVENTS.has(eventType);
}

/** Admit only categorical activity; raw prompt/error text is unreachable here. */
export function parsePromptRepairActivity(value: unknown): PromptRepairActivityProjection | undefined {
	if (!isRecord(value) || value.schemaVersion !== PROMPT_REPAIR_SCHEMA_VERSION) return undefined;
	if ((value.attempt !== 1 && value.attempt !== 2) || value.maxAttempts !== PROMPT_REPAIR_MAX_ATTEMPTS) return undefined;
	if (value.phase === "repairing") {
		return { phase: "repairing-prompt", message: `repairing prompt ${value.attempt}/${value.maxAttempts}` };
	}
	if (value.phase === "retrying-primary") {
		return { phase: "retrying-primary", message: `retrying primary model ${value.attempt}/${value.maxAttempts}` };
	}
	return undefined;
}
