import type { Question, QuestionAnswer } from "../contract/index.ts";

/** piQuestion.onTimeout. Mirrors `Policy` in proofs/question.bend. */
export type TimeoutPolicy = "cancel" | "recommended" | "error";

/** What the tool does when the deadline passes. Mirrors `Expiry`. */
export type Expiry = { kind: "resolved"; answer: QuestionAnswer } | { kind: "failed" };

/** Scope/product and security/permission decisions are never defaulted (`mayDefault`). */
export function mayDefault(question: Question): boolean {
	return question.category !== "scope-product" && question.category !== "security-permission";
}

const timedOut = (question: Question): QuestionAnswer => ({ id: question.id, status: "timeout", selected: [] });

/**
 * Decide one unanswered question at the deadline (`expire` in proofs/question.bend).
 * Laws L3-L8: never a human answer; a default is the question's own
 * recommendation; nothing is defaulted without one or in a gated category.
 */
export function expire(policy: TimeoutPolicy, question: Question): Expiry {
	if (policy === "error") return { kind: "failed" };
	if (policy === "recommended" && question.recommended !== undefined && mayDefault(question)) {
		return {
			kind: "resolved",
			answer: {
				id: question.id,
				status: "answered",
				selected: [question.recommended],
				defaulted: true,
				note: "Default chosen after the timeout; no human answered.",
			},
		};
	}
	return { kind: "resolved", answer: timedOut(question) };
}

/** The first outcome for a question wins; later ones are ignored (`settle`, L1-L2). */
export function settle(first: QuestionAnswer | undefined, later: QuestionAnswer): QuestionAnswer {
	return first ?? later;
}
