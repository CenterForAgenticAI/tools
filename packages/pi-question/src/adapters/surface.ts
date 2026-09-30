import type { AskDelivery, Question, QuestionAnswer } from "../contract/index.ts";

/** One way of putting a question in front of a human. See `.spec/03-surfaces.md`. */
export interface AskSurface {
	readonly delivery: AskDelivery;
	ask(questions: Question[], signal: AbortSignal | undefined): Promise<QuestionAnswer[]>;
}

export const unavailableSurface: AskSurface = {
	delivery: { surface: "none", degraded: false },
	async ask(questions) {
		return questions.map((q) => ({ id: q.id, status: "unavailable", selected: [] }));
	},
};
