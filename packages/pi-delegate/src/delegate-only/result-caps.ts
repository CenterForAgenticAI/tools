import { truncateRecoveryText } from "../fork-recovery.js";
import { getActiveDelegateOnlyMode } from "./runtime-state.js";

export interface DelegateOnlyResultCap {
	text: string;
	advisoryWarning?: string;
	truncated: boolean;
}

const warnedWorkers = new Set<string>();
interface RetainedResultContent {
	text: string;
	terminal: boolean;
}
const uncappedResultContent = new WeakMap<object, RetainedResultContent>();
const POINTER_NOTICE = "[delegate-only result truncated; use delegate_control(action=\"result\", runId).]";

/**
 * Keep the source text associated with a projection so a caller that mutates a
 * result in place (the timeout salvage path) cannot make the durable copy lossy.
 * A progress projection is only provisional: the first terminal source value
 * replaces it and remains authoritative over later delivery projections.
 * The map is process-local; runtime persistence owns the durable copy.
 */
export function rememberUncappedResultContent(result: object, text: string, options: { terminal?: boolean } = {}): void {
	const terminal = options.terminal === true;
	const existing = uncappedResultContent.get(result);
	if (existing?.terminal && !terminal) return;
	if (existing?.terminal && terminal) {
		if (existing.text.length === 0 && text.length > 0) uncappedResultContent.set(result, { text, terminal: true });
		return;
	}
	uncappedResultContent.set(result, { text, terminal });
}

export function getUncappedResultContent(result: object, options: { terminal?: boolean } = {}): string | undefined {
	const retained = uncappedResultContent.get(result);
	if (options.terminal === true && retained !== undefined && !retained.terminal) return undefined;
	return retained?.text;
}

function advisoryLimitForActiveMode(): number | undefined {
	const mode = getActiveDelegateOnlyMode();
	return mode && validLimit(mode.config.resultAdvisoryBytes) ? mode.config.resultAdvisoryBytes : undefined;
}

function validLimit(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

/**
 * Claim the single worker turn allowed to shorten an oversized result.
 *
 * The claim is shared with `capDelegateOnlyResult`: a projection warning is
 * the fallback when a runner did not get a chance to ask the worker first.
 */
export function shouldRequestShorterResult(text: string, workerKey: string): boolean {
	const advisoryBytes = advisoryLimitForActiveMode();
	if (advisoryBytes === undefined || Buffer.byteLength(text, "utf8") <= advisoryBytes || warnedWorkers.has(workerKey)) {
		return false;
	}
	warnedWorkers.add(workerKey);
	return true;
}

function boundedPointerNotice(maxBytes: number, runId?: string): string {
	const notice = runId === undefined
		? POINTER_NOTICE
		: `[delegate-only result truncated; use delegate_control(action="result", runId="${runId}").]`;
	if (Buffer.byteLength(notice, "utf8") <= maxBytes) return notice;
	return truncateRecoveryText(notice, maxBytes);
}

function truncateWithPointer(text: string, maxBytes: number, runId?: string): string {
	if (maxBytes <= 0) return "";
	const pointer = boundedPointerNotice(maxBytes, runId);
	const pointerBytes = Buffer.byteLength(pointer, "utf8");
	const separator = "\n\n";
	if (pointerBytes + Buffer.byteLength(separator, "utf8") >= maxBytes) return truncateRecoveryText(pointer, maxBytes);
	const prefix = truncateRecoveryText(text, maxBytes - pointerBytes - Buffer.byteLength(separator, "utf8"));
	return `${prefix}${separator}${pointer}`;
}

/**
 * Project a worker result for the active delegate-only foreground.
 * The input remains untouched so durable run state retains the full result.
 */
export function capDelegateOnlyResult(
	text: string,
	workerKey: string,
	options: { claimAdvisory?: boolean; runId?: string } = {},
): DelegateOnlyResultCap {
	const mode = getActiveDelegateOnlyMode();
	if (!mode || !validLimit(mode.config.resultAdvisoryBytes) || !validLimit(mode.config.resultHardCapBytes)) {
		return { text, truncated: false };
	}

	const resultBytes = Buffer.byteLength(text, "utf8");
	const advisoryWarning = options.claimAdvisory !== false && resultBytes > mode.config.resultAdvisoryBytes && !warnedWorkers.has(workerKey)
		? (() => {
			warnedWorkers.add(workerKey);
			return `Worker result exceeded the delegate-only advisory cap of ${mode.config.resultAdvisoryBytes} bytes; return a shorter result.`;
		})()
		: undefined;
	if (resultBytes <= mode.config.resultHardCapBytes) {
		return { text, ...(advisoryWarning === undefined ? {} : { advisoryWarning }), truncated: false };
	}
	return {
		text: truncateWithPointer(text, mode.config.resultHardCapBytes, options.runId),
		...(advisoryWarning === undefined ? {} : { advisoryWarning }),
		truncated: true,
	};
}
