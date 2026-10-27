import { normalizeContext } from "@earendil-works/pi-ai";
import { estimateContextTokens } from "./context-token-estimator.js";

/**
 * Decide whether it is safe to fall back to Pi's built-in compaction after the
 * context-aware compaction hook failed for a reason that is neither an exhausted
 * overflow ladder nor an exhausted transient transport (those are handled
 * separately and always cancel).
 *
 * The request templates below mirror Pi's private request builders in
 * `dist/core/compaction/compaction.js` in Pi 1.4.0. Keep them together
 * so a Pi prompt change has one compatibility surface to update. Conversation
 * serialization remains Pi-owned: callers supply `serializeConversation(...)`.
 */

/** pi-ai's `clampMaxTokensToContext` safety margin. */
export const PI_CONTEXT_SAFETY_TOKENS = 4096;

/**
 * A structured multi-section checkpoint needs room beyond the one-token floor
 * used by pi-ai's clamp. 1,024 tokens matches pi-ai's minimum answer allowance
 * when reasoning shares an output ceiling.
 */
export const MIN_USEFUL_COMPACTION_OUTPUT_TOKENS = 1024;

const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_INSTRUCTIONS = `Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

${UPDATE_SUMMARIZATION_INSTRUCTIONS}`;

const TURN_PREFIX_SUMMARIZATION_PROMPT = `The messages above are earlier context from an ongoing conversation. Later messages are stored separately and do not need to be reconstructed.

Create a concise checkpoint of the user's request and the progress shown above. This checkpoint will be placed before the later messages so the conversation can continue with the necessary context.

## Original Request
[What did the user ask for?]

## Progress So Far
- [Key decisions and work completed in these messages]

## Context Needed to Continue
- [Information from these messages needed to understand the later work]

Only summarize information explicitly present above. Do not infer or recreate later messages.`;

export type BuiltinCompactionRequest =
	| {
		kind: "history";
		conversationText: string;
		previousSummary?: string;
		customInstructions?: string;
	}
	| {
		kind: "turn-prefix";
		conversationText: string;
		customInstructions?: string;
	};

function historyPrompt(request: Extract<BuiltinCompactionRequest, { kind: "history" }>): string {
	let basePrompt = request.previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (request.customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${request.customInstructions}`;
	}
	let promptText = `<conversation>\n${request.conversationText}\n</conversation>\n\n`;
	if (request.previousSummary) {
		promptText += `<previous-summary>\n${request.previousSummary}\n</previous-summary>\n\n`;
	}
	return promptText + basePrompt;
}

function turnPrefixPrompt(request: Extract<BuiltinCompactionRequest, { kind: "turn-prefix" }>): string {
	let promptText = `# Conversation\n${request.conversationText}\n\n# Instructions\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
	if (request.customInstructions) {
		promptText = `${promptText}\n\nAdditional focus: ${request.customInstructions}`;
	}
	return promptText;
}

/** Estimate the same normalized two-message context Pi sends, with pi-ai's estimator. */
export function estimateBuiltinCompactionRequestTokens(request: BuiltinCompactionRequest): number {
	const userPrompt = request.kind === "history" ? historyPrompt(request) : turnPrefixPrompt(request);
	const context = normalizeContext({
		systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
		messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: 0 }],
	});
	return estimateContextTokens(context).tokens;
}

export interface BuiltinCompactionFallbackInput {
	/** Requests the built-in path would send separately. */
	requests: readonly BuiltinCompactionRequest[];
	/** Active model context window, when known. */
	contextWindow: number | undefined;
}

export type BuiltinCompactionFallbackDecision =
	| { fallback: true }
	| { fallback: false; reason: string };

export function decideBuiltinCompactionFallback(
	input: BuiltinCompactionFallbackInput,
): BuiltinCompactionFallbackDecision {
	const { contextWindow } = input;
	// Without a known window or a usable estimate, do not block the built-in:
	// refusing on missing data would suppress a fallback that might succeed.
	if (!Number.isFinite(contextWindow) || (contextWindow ?? 0) <= 0) return { fallback: true };
	const largestRequest = input.requests.reduce(
		(max, request) => Math.max(max, estimateBuiltinCompactionRequestTokens(request)),
		0,
	);
	if (largestRequest <= 0) return { fallback: true };
	const outputBudget = (contextWindow as number) - largestRequest - PI_CONTEXT_SAFETY_TOKENS;
	if (outputBudget < MIN_USEFUL_COMPACTION_OUTPUT_TOKENS) {
		return {
			fallback: false,
			reason: `the largest built-in summarization request (~${largestRequest} input tokens) leaves only ~${Math.max(1, outputBudget)} summary output tokens after Pi's ${PI_CONTEXT_SAFETY_TOKENS}-token safety margin; at least ${MIN_USEFUL_COMPACTION_OUTPUT_TOKENS} are required`,
		};
	}
	return { fallback: true };
}
