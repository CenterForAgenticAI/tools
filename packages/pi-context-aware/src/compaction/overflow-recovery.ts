import { isContextOverflow, type AssistantMessage } from "@earendil-works/pi-ai";

/** The original response lets transient-retry use pi-ai's real classifier. */
export const ASSISTANT_RESPONSE_FOR_LLM_ERROR = Symbol("assistantResponseForLlmError");

export function assistantResponseForLlmError(error: Error): AssistantMessage | undefined {
	const response = (error as Error & { [ASSISTANT_RESPONSE_FOR_LLM_ERROR]?: unknown })[ASSISTANT_RESPONSE_FOR_LLM_ERROR];
	return response && typeof response === "object" ? response as AssistantMessage : undefined;
}

export type ContextOverflowRecoveryStage = "reduced-payload" | "fallback-model";

export interface ContextOverflowRecoveryEvent {
	operation: string;
	stage: ContextOverflowRecoveryStage;
	message: string;
	error: unknown;
	fallbackModel?: string;
}

export class ContextOverflowRecoveryExhaustedError extends Error {
	readonly operation: string;
	readonly latestWasOverflow: boolean;

	constructor(operation: string, latestError: unknown, overflowCause: unknown) {
		const message = latestError instanceof Error ? latestError.message : String(latestError);
		super(message, { cause: overflowCause });
		this.name = "ContextOverflowRecoveryExhaustedError";
		this.operation = operation;
		this.latestWasOverflow = isContextOverflowError(latestError);
	}
}

interface ContextOverflowFallback<T> {
	model: string;
	run: () => Promise<T>;
}

interface ContextOverflowRecoveryOptions<T> {
	operation: string;
	primary: () => Promise<T>;
	reduced?: () => Promise<T>;
	fallback?: ContextOverflowFallback<T> | null;
	onRecovery?: (event: ContextOverflowRecoveryEvent) => void;
	signal?: AbortSignal;
}

const EXPLICIT_OVERFLOW_CODES = new Set([
	"context_length_exceeded",
	"context_window_exceeded",
	"input_too_long",
	"prompt_too_long",
	"request_too_large",
]);

const EMBEDDED_OVERFLOW_CODE = /\b(?:context_(?:length|window)_exceeded|input_too_long|prompt_too_long)\b/i;

const EMPTY_USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function providerClassifierMatches(errorMessage: string): boolean {
	return isContextOverflow({
		role: "assistant",
		content: [],
		api: "context-aware-overflow-classifier",
		provider: "context-aware",
		model: "classifier",
		usage: EMPTY_USAGE,
		stopReason: "error",
		errorMessage,
		timestamp: 0,
	});
}

function collectErrorStrings(value: unknown, out: string[], seen: Set<object>, depth: number): void {
	if (depth > 4 || value === null || value === undefined) return;
	if (typeof value === "string") {
		out.push(value);
		return;
	}
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
		out.push(String(value));
		return;
	}
	if (typeof value !== "object") return;
	if (seen.has(value)) return;
	seen.add(value);

	if (value instanceof Error) {
		out.push(value.name, value.message);
		const cause = (value as Error & { cause?: unknown }).cause;
		if (cause !== undefined) collectErrorStrings(cause, out, seen, depth + 1);
	}

	for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
		if (typeof nested === "string" && (key === "code" || key === "type")) {
			out.push(nested.toLowerCase());
		}
		collectErrorStrings(nested, out, seen, depth + 1);
	}
}

export function isContextOverflowError(error: unknown): boolean {
	const strings: string[] = [];
	collectErrorStrings(error, strings, new Set<object>(), 0);
	for (const value of strings) {
		const normalized = value.trim().toLowerCase();
		if (EXPLICIT_OVERFLOW_CODES.has(normalized)) return true;
		if (providerClassifierMatches(value)) return true;
		if (EMBEDDED_OVERFLOW_CODE.test(value)) return true;
	}
	return false;
}

function errorWithAssistantResponse(message: string, response: AssistantMessage): Error {
	const error = new Error(message);
	Object.defineProperty(error, ASSISTANT_RESPONSE_FOR_LLM_ERROR, {
		configurable: false,
		enumerable: false,
		value: response,
		writable: false,
	});
	return error;
}

export function errorFromLlmResponse(response: AssistantMessage, contextWindow?: number): Error | null {
	if (isContextOverflow(response, contextWindow)) {
		return errorWithAssistantResponse(
			response.errorMessage?.trim() || "context_length_exceeded: LLM request exceeded the model context window",
			response,
		);
	}
	if (response.stopReason !== "error") return null;
	const message = typeof response.errorMessage === "string" && response.errorMessage.trim()
		? response.errorMessage.trim()
		: "LLM request failed without an error message";
	return errorWithAssistantResponse(message, response);
}

function emitRecovery(
	options: ContextOverflowRecoveryOptions<unknown>,
	stage: ContextOverflowRecoveryStage,
	error: unknown,
	fallbackModel?: string,
): void {
	const message = stage === "reduced-payload"
		? `${options.operation} exceeded the model context window; retrying once with a reduced payload.`
		: `${options.operation} still exceeded the context window after payload reduction; retrying with configured fallback model ${fallbackModel}.`;
	options.onRecovery?.({
		operation: options.operation,
		stage,
		message,
		error,
		fallbackModel,
	});
}

export async function runWithContextOverflowRecovery<T>(
	options: ContextOverflowRecoveryOptions<T>,
): Promise<T> {
	try {
		return await options.primary();
	} catch (primaryError) {
		if (!isContextOverflowError(primaryError)) throw primaryError;

		let latestError = primaryError;
		if (options.reduced) {
			if (options.signal?.aborted) throw options.signal.reason ?? new Error("Request was aborted");
			emitRecovery(options, "reduced-payload", primaryError);
			try {
				return await options.reduced();
			} catch (reducedError) {
				if (!isContextOverflowError(reducedError)) {
					throw new ContextOverflowRecoveryExhaustedError(options.operation, reducedError, primaryError);
				}
				latestError = reducedError;
			}
		}

		if (options.fallback) {
			if (options.signal?.aborted) throw options.signal.reason ?? new Error("Request was aborted");
			emitRecovery(options, "fallback-model", latestError, options.fallback.model);
			try {
				return await options.fallback.run();
			} catch (fallbackError) {
				throw new ContextOverflowRecoveryExhaustedError(options.operation, fallbackError, latestError);
			}
		}
		throw new ContextOverflowRecoveryExhaustedError(options.operation, latestError, primaryError);
	}
}

export function reduceTextForOverflow(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const marker = "\n\n[... content omitted for context-overflow retry ...]\n\n";
	if (maxChars <= marker.length) {
		let end = Math.max(0, maxChars);
		if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "") && /[\uDC00-\uDFFF]/.test(text[end] ?? "")) end--;
		return text.slice(0, end);
	}
	const remaining = maxChars - marker.length;
	let headEnd = Math.ceil(remaining * 0.35);
	let tailStart = text.length - (remaining - headEnd);
	if (/[\uD800-\uDBFF]/.test(text[headEnd - 1] ?? "") && /[\uDC00-\uDFFF]/.test(text[headEnd] ?? "")) headEnd--;
	if (/[\uD800-\uDBFF]/.test(text[tailStart - 1] ?? "") && /[\uDC00-\uDFFF]/.test(text[tailStart] ?? "")) tailStart++;
	return `${text.slice(0, headEnd)}${marker}${text.slice(tailStart)}`;
}

/**
 * Reduce a retry payload relative to the provider-rejected primary payload,
 * not only to model metadata. This guarantees a smaller dynamic text segment
 * even when chars-per-token estimates or the advertised context window are
 * optimistic for the actual provider/tokenizer.
 */
export function reduceTextForOverflowRetry(
	text: string,
	absoluteMaxChars: number,
	rejectedPayloadChars: number = text.length,
): string {
	if (text.length <= 1 || rejectedPayloadChars <= 1) return text;
	const relativeMaxChars = Math.max(1, Math.floor(rejectedPayloadChars * 0.5));
	const strictMaxChars = Math.min(absoluteMaxChars, relativeMaxChars, rejectedPayloadChars - 1);
	return reduceTextForOverflow(text, strictMaxChars);
}
