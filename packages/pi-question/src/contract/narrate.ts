import type { AskDelivery, AskToolDetails, CompatQuestionResult, Question, QuestionAnswer } from "./types.ts";

/** pi-ask-tool's label for the free-text choice. Kept identical for compatibility. */
export const OTHER_OPTION = "Other (type your own)";

const oneLine = (value: string): string =>
	value
		.replace(/[\r\n\t]/g, " ")
		// eslint-disable-next-line no-control-regex -- strip control characters from session text
		.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
		.replace(/\s{2,}/g, " ")
		.trim();

export function toCompatResult(question: Question, answer: QuestionAnswer): CompatQuestionResult {
	const options = question.options.map((o) => o.label);
	const result: CompatQuestionResult = {
		id: question.id,
		question: question.question,
		options,
		multi: question.multi ?? false,
		selectedOptions: answer.selected.map((i) => options[i]).filter((l): l is string => l !== undefined),
	};
	if (question.description) result.description = question.description;
	if (answer.customText) result.customInput = answer.customText;
	return result;
}

function summary(result: CompatQuestionResult, answer: QuestionAnswer): string {
	if (answer.status !== "answered") return `(${answer.status})`;
	if (answer.defaulted) return `(timeout; default applied, no human answered: ${result.selectedOptions.map(oneLine).join(", ")})`;
	const picked = result.selectedOptions.map(oneLine);
	const custom = result.customInput ? oneLine(result.customInput) : undefined;
	if (picked.length === 0 && !custom) return "(cancelled)";
	const selected = result.multi ? `[${picked.join(", ")}]` : picked[0];
	if (picked.length > 0 && custom) return `${selected} + Other: "${custom}"`;
	return custom ? `"${custom}"` : (selected ?? "(cancelled)");
}

/**
 * Tool-result text. The first block matches pi-ask-tool (`User answers:` then
 * `id: selection`) so prompts that parse it keep working. Non-answers are named
 * explicitly: an unavailable surface is never reported as an empty selection.
 */
export function narrate(questions: Question[], answers: QuestionAnswer[], delivery: AskDelivery): string {
	const lines = ["User answers:"];
	for (const [i, q] of questions.entries()) {
		const answer = answers[i] ?? { id: q.id, status: "cancelled", selected: [] };
		lines.push(`${oneLine(q.id)}: ${summary(toCompatResult(q, answer), answer)}`);
	}
	if (answers.some((a) => a.status === "unavailable")) {
		lines.push("", "No human answer surface is available in this session. Do not assume an answer; continue only with choices you can justify, or report the open question upward.");
	}
	if (delivery.degraded) lines.push("", `Note: asked through a reduced ${delivery.surface} surface; option descriptions may not have been shown.`);
	return lines.join("\n");
}

export function buildDetails(questions: Question[], answers: QuestionAnswer[], delivery: AskDelivery): AskToolDetails {
	const results = questions.map((q, i) => toCompatResult(q, answers[i] ?? { id: q.id, status: "cancelled", selected: [] }));
	const details: AskToolDetails = { results, answers, delivery };
	const [only] = results;
	if (results.length === 1 && only) Object.assign(details, { ...only, results });
	return details;
}
