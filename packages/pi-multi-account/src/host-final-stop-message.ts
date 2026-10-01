import {
	isContextOverflow,
	isRetryableAssistantError,
	type AssistantMessage,
} from "@earendil-works/pi-ai";
import { sanitizeDiagnosticText } from "./diagnostics.js";

/** Fixed fallbacks for a structured provider stop; none matches a host re-dispatch pattern. */
export const REFUSAL_FALLBACK_MESSAGE = "The model refused to complete the request";
export const UNKNOWN_STOP_FALLBACK_MESSAGE =
	"Provider stopped with an unrecognized stop reason";

/** Upper bound on the normalized stop reason named in a reworded message. */
const MAX_NAMED_REASON_LENGTH = 64;

/**
 * Whether the pinned host would re-dispatch an error terminal carrying `text`.
 *
 * The host re-dispatches when either retry predicate matches the prose:
 * `AgentSession._isRetryableError` runs pi-ai `isRetryableAssistantError`, and
 * `_checkCompaction` runs `isContextOverflow` before compacting and retrying once
 * (pi-coding-agent dist/core/agent-session.js, both from `@earendil-works/pi-ai`).
 * An unreadable predicate result counts as a match, so the caller keeps looking
 * for a safer form.
 */
function hostWouldRedispatch(message: AssistantMessage, text: string): boolean {
	try {
		const probe = { ...message, errorMessage: text };
		return isRetryableAssistantError(probe) || isContextOverflow(probe, 0);
	} catch {
		return true;
	}
}

function namedReasonMessage(reason: string): string {
	return `Provider stopped (reason: ${reason})`;
}

/**
 * Normalizes a bounded, sanitized raw stop reason into plain words: every run of
 * non-alphanumeric characters (underscores included) becomes one space, and the
 * result is capped at a word boundary where possible.
 */
function normalizedReasonWords(rawStopReason: unknown): string[] {
	if (typeof rawStopReason !== "string") return [];
	const words = sanitizeDiagnosticText(rawStopReason)
		.replace(/[^A-Za-z0-9]+/g, " ")
		.trim()
		.split(" ")
		.filter((word) => word.length > 0);
	const kept: string[] = [];
	let length = 0;
	for (const word of words) {
		const next = length === 0 ? word.length : length + 1 + word.length;
		if (next > MAX_NAMED_REASON_LENGTH) {
			if (kept.length === 0) kept.push(word.slice(0, MAX_NAMED_REASON_LENGTH));
			break;
		}
		kept.push(word);
		length = next;
	}
	return kept;
}

/**
 * Names an unknown stop reason in a message neither host predicate acts on.
 *
 * The first form keeps every normalized word. When that still matches a host
 * predicate (a reason containing "overloaded" or "timeout", say), the second
 * form admits words in order and drops each one whose addition would make the
 * message match. Every admitted prefix was probed, so the result is host-final
 * by construction. An empty result yields `undefined`.
 */
function unknownStopNamingReason(
	message: AssistantMessage,
	rawStopReason: unknown,
): string | undefined {
	const words = normalizedReasonWords(rawStopReason);
	if (words.length === 0) return undefined;
	const reworded = namedReasonMessage(words.join(" "));
	if (!hostWouldRedispatch(message, reworded)) return reworded;
	const kept: string[] = [];
	for (const word of words) {
		const tentative = namedReasonMessage([...kept, word].join(" "));
		if (!hostWouldRedispatch(message, tentative)) kept.push(word);
	}
	return kept.length === 0 ? undefined : namedReasonMessage(kept.join(" "));
}

/**
 * The public error text for a structured refusal or unknown provider stop.
 *
 * The pinned host re-dispatches an error terminal from its prose alone (see
 * `hostWouldRedispatch`). A refusal explanation or stop reason is
 * provider-authored, so text such as "overloaded", "prompt is too long", or
 * "model_context_window_exceeded" would make the host send the stopped request
 * again. The structured code alone selects this path; the provider text is kept
 * only when neither host predicate would act on it. An unknown stop is then
 * reworded so it still names its reason, and only when no reworded form is safe
 * is a fixed fallback published. A refusal whose explanation is unsafe publishes
 * its fixed fallback directly. A message without the structured code, or that is
 * not an error terminal, yields `undefined` and must be published unchanged.
 */
export function hostFinalStopMessage(
	message: AssistantMessage,
): { readonly errorMessage: string } | undefined {
	const code = (message as { code?: unknown }).code;
	if (message.stopReason !== "error") return undefined;
	if (code !== "refusal" && code !== "unknown_stop") return undefined;
	const candidate = message.errorMessage;
	if (
		typeof candidate === "string" &&
		candidate.length > 0 &&
		!hostWouldRedispatch(message, candidate)
	) {
		return { errorMessage: candidate };
	}
	if (code === "refusal") return { errorMessage: REFUSAL_FALLBACK_MESSAGE };
	return {
		errorMessage:
			unknownStopNamingReason(message, message.rawStopReason) ??
			UNKNOWN_STOP_FALLBACK_MESSAGE,
	};
}
