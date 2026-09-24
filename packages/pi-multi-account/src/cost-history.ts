import type { AssistantMessage } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { isProjectKey, projectKeyForCwd } from "./project-identity.js";
import { appendHistory, type HistoryLockExhaustion, type HistoryRecordEnvelope } from "./history-store.js";
import { isCanonicalManagedProviderId } from "./runtime-state.js";

/**
 * Cost record status.
 * 
 * REQ-COST-INCOMPLETE: mutually exclusive status assigned in priority order.
 * Priority: complete > unpriced > partial
 */
export type CostStatus = "complete" | "unpriced" | "partial";

/**
 * Cost record payload appended to cost-history.ndjson.
 * 
 * REQ-COST-RECORD: immutable snapshot of one observed response's cost and usage.
 * REQ-OBSERVER-BOUNDED: observer id is bounded, non-identifying, process-scoped.
 */
export interface CostRecordPayload {
	readonly canonicalAccountId: string;
	readonly projectKey: string;
	readonly requestedModel: string;
	readonly responseModel: string | undefined;
	readonly observerId: string;
	readonly status: CostStatus;
	readonly schemaProvenance: string;
	readonly buildProvenance: string;
	readonly tokens: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
		readonly cacheWrite1h: number | undefined;
		readonly total: number;
	};
	readonly cost: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
		readonly total: number;
	};
}

/**
 * Bounded, non-identifying observer id.
 * 
 * REQ-OBSERVER-BOUNDED: process-scoped uuid, max 36 bytes. Contains no hostname,
 * username, path, or human-identifying token.
 */
let processObserverId: string | undefined;
function getObserverId(): string {
	if (!processObserverId) {
		processObserverId = randomUUID();
	}
	return processObserverId;
}

/**
 * Classify cost status.
 *
 * REQ-COST-INCOMPLETE: mutually exclusive status assigned in priority order.
 * Priority: complete > unpriced > partial.
 *
 * Discriminator is TERMINATION, not the cost value. Do NOT branch on
 * `cost.total === 0` (or any other cost-value predicate) as a signal of
 * completeness. A genuinely-free successful response (e.g. a fully-cache-read
 * turn) with every cost component equal to 0 is a REAL, correctly-priced
 * observation and MUST classify `complete`; excluding it would understate
 * usage in the REQ-COST-INCOMPLETE principal aggregate. The
 * "initialized zero-cost object" carve-out for `unpriced` applies to
 * INTERRUPTED responses, which by definition do not carry a terminal
 * stopReason and therefore fall past the `complete` branch on stopReason
 * alone — zero-ness of the payload is not the signal, the abnormal
 * termination is.
 *
 * 1. `complete` — stopReason is `stop`, `length`, or `toolUse` AND every
 *    required token and cost field is finite and non-negative. Zero-valued
 *    but finite/non-negative cost components ARE valid; a free turn
 *    classifies here.
 * 2. else `unpriced` — abnormal termination with no trustworthy computed
 *    cost: an interrupted stream whose payload is only pi's untouched
 *    zero-cost object, OR any response whose cost fields are missing,
 *    non-finite, or negative.
 * 3. else `partial` — `error`/`aborted` response, or a stream interrupted
 *    before a successful terminal message, that retains trustworthy
 *    computed cost or usage data.
 *
 * Known residual gap (spec REQ-COST-RECORD, accepted): a synthesised
 * terminal stopReason attached upstream to a genuinely-interrupted stream
 * will classify `complete` under this rule. The spec accepts that side of
 * the trade because stopReason is the completeness signal the emitter
 * provides; do not try to fix it here.
 */
export function classifyCostStatus(message: AssistantMessage): CostStatus {
	const { stopReason, usage } = message;

	const hasValidTokens =
		Number.isFinite(usage.input) &&
		usage.input >= 0 &&
		Number.isFinite(usage.output) &&
		usage.output >= 0 &&
		Number.isFinite(usage.cacheRead) &&
		usage.cacheRead >= 0 &&
		Number.isFinite(usage.cacheWrite) &&
		usage.cacheWrite >= 0 &&
		Number.isFinite(usage.totalTokens) &&
		usage.totalTokens >= 0;

	const hasValidCost =
		Number.isFinite(usage.cost.input) &&
		usage.cost.input >= 0 &&
		Number.isFinite(usage.cost.output) &&
		usage.cost.output >= 0 &&
		Number.isFinite(usage.cost.cacheRead) &&
		usage.cost.cacheRead >= 0 &&
		Number.isFinite(usage.cost.cacheWrite) &&
		usage.cost.cacheWrite >= 0 &&
		Number.isFinite(usage.cost.total) &&
		usage.cost.total >= 0;

	const isTerminalStop =
		stopReason === "stop" ||
		stopReason === "length" ||
		stopReason === "toolUse";

	// Priority 1: complete — terminal stopReason with all fields finite
	// and non-negative. Zero is finite and non-negative: a fully cache-read
	// turn that legitimately cost $0.00 classifies here.
	if (isTerminalStop && hasValidTokens && hasValidCost) {
		return "complete";
	}

	// Priority 2: unpriced — no trustworthy computed cost. Two disjoint
	// cases: (a) cost fields are outright invalid (non-finite or negative);
	// (b) abnormal termination whose payload has no cost or usage signal
	// at all (the untouched zero-cost object from an interrupted stream,
	// with no tokens observed either).
	const hasNoUsageSignal =
		usage.input === 0 &&
		usage.output === 0 &&
		usage.cacheRead === 0 &&
		usage.cacheWrite === 0 &&
		usage.totalTokens === 0 &&
		usage.cost.input === 0 &&
		usage.cost.output === 0 &&
		usage.cost.cacheRead === 0 &&
		usage.cost.cacheWrite === 0 &&
		usage.cost.total === 0;

	if (!hasValidCost || hasNoUsageSignal) {
		return "unpriced";
	}

	// Priority 3: partial — abnormal termination retaining trustworthy
	// cost or usage data.
	return "partial";
}

/**
 * Append a cost record to cost-history.ndjson.
 * 
 * REQ-COST-RECORD: one immutable record per observed response.
 * REQ-COST-NO-REPRICING: retains pi's computed cost verbatim, never recomputes.
 * 
 * Fail-soft: returns false on append failure, caller should log and continue.
 * NEVER throws into the host.
 */
export async function appendCostRecord(
	message: AssistantMessage,
	canonicalAccountId: string,
	options?: {
		readonly costHistoryPath?: string;
		readonly lockPath?: string;
		readonly expectedBase?: string;
		readonly now?: () => number;
		readonly projectKey?: string;
		readonly retryBudget?: {
			readonly maxRetries?: number;
			readonly initialDelayMs?: number;
			readonly maxDelayMs?: number;
		};
		readonly onLockExhausted?: (details: HistoryLockExhaustion) => void;
	},
): Promise<boolean> {
	try {
		const rawStatus = classifyCostStatus(message);
		// REQ-COST-NO-CONFLATION: Antigravity has no owning-vendor-api tier
		// (`providerTypeFor` always returns "subscription" for `google-antigravity`),
		// so the model `cost` rates registered from the reviewed upstream catalog
		// (`src/upstream-antigravity.ts`, e.g. Google's own `geminiFlashCost`-style
		// figures) are never a genuine per-token charge pi actually billed -- they
		// are the same public-rate-style estimate this repository already keeps
		// distinct from retained cost for every other family via `api-pricing.ts`.
		// Whatever `message.usage.cost` computed from that catalog rate must never
		// be recorded as a retained subscription-provider cost fact. Forcing
		// "unpriced" here is what makes `cost-digest.ts#parseObservation` floor
		// `retainedCostUsd` to 0 for this record downstream, while the tokens
		// still enter the ledger so usage is not understated.
		const status: CostStatus = isCanonicalManagedProviderId(
			canonicalAccountId,
			"google-antigravity",
		)
			? "unpriced"
			: rawStatus;
		const projectKey = options?.projectKey ?? projectKeyForCwd();
		if (!isProjectKey(projectKey)) return false;

		const payload: CostRecordPayload = {
			canonicalAccountId,
			projectKey,
			requestedModel: message.model,
			responseModel: message.responseModel,
			observerId: getObserverId(),
			status,
			schemaProvenance: "pi-multi-account@0.0.1",
			buildProvenance: `node@${process.version}`,
			tokens: {
				input: message.usage.input,
				output: message.usage.output,
				cacheRead: message.usage.cacheRead,
				cacheWrite: message.usage.cacheWrite,
				cacheWrite1h: message.usage.cacheWrite1h,
				total: message.usage.totalTokens,
			},
			cost: {
				input: message.usage.cost.input,
				output: message.usage.cost.output,
				cacheRead: message.usage.cost.cacheRead,
				cacheWrite: message.usage.cost.cacheWrite,
				total: message.usage.cost.total,
			},
		};

		const envelope: HistoryRecordEnvelope = {
			schemaVersion: 1,
			recordType: "cost-delta",
			stableId: randomUUID(),
			observedAtMs: message.timestamp,
			recordedAtMs: Date.now(),
			payload,
		};

		return await appendHistory(envelope, options);
	} catch {
		// Fail-soft: never throw into the host
		return false;
	}
}
