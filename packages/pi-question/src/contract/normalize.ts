import type { AskRequest, Question, QuestionCategory, QuestionOption } from "./types.ts";

export const LIMITS = {
	maxQuestions: 8,
	minOptions: 1,
	maxOptions: 12,
	maxText: 4000,
} as const;

const CATEGORIES: readonly QuestionCategory[] = ["implementation", "scope-product", "security-permission"];

export type NormalizeResult = { ok: true; request: AskRequest } | { ok: false; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim().length > 0 ? value.slice(0, LIMITS.maxText) : undefined;

function option(value: unknown): QuestionOption | undefined {
	if (typeof value === "string") return text(value) ? { label: value.trim() } : undefined;
	if (!isRecord(value)) return undefined;
	const label = text(value.label);
	if (!label) return undefined;
	const description = text(value.description);
	return description ? { label: label.trim(), description } : { label: label.trim() };
}

/**
 * Accept pi-ask-tool shape and the older dialects pi-delegate's worker ask shim
 * already coerces (`header`/`prompt`, `context`, `choices`, `recommendedIndex`,
 * `multiple`). Coercion only renames and reshapes; it never invents an answer,
 * an option set, or a category.
 */
function question(raw: unknown, index: number): Question | string {
	if (!isRecord(raw)) return `questions[${index}] must be an object`;
	const prompt = text(raw.question) ?? text(raw.prompt) ?? text(raw.header);
	if (!prompt) return `questions[${index}].question is required`;
	const rawOptions = Array.isArray(raw.options) ? raw.options : Array.isArray(raw.choices) ? raw.choices : [];
	const options = rawOptions.map(option).filter((o): o is QuestionOption => o !== undefined);
	if (options.length < LIMITS.minOptions) return `questions[${index}] needs at least ${LIMITS.minOptions} option`;
	if (options.length > LIMITS.maxOptions) return `questions[${index}] has more than ${LIMITS.maxOptions} options`;
	const recommended = typeof raw.recommended === "number" ? raw.recommended : raw.recommendedIndex;
	const multi = typeof raw.multi === "boolean" ? raw.multi : raw.multiple;
	const description = text(raw.description) ?? text(raw.context);
	const category = CATEGORIES.find((c) => c === raw.category);
	const q: Question = { id: text(raw.id)?.trim() ?? `q${index + 1}`, question: prompt, options };
	if (description) q.description = description;
	if (typeof multi === "boolean") q.multi = multi;
	if (typeof recommended === "number" && Number.isInteger(recommended) && recommended >= 0 && recommended < options.length) {
		q.recommended = recommended;
	}
	if (typeof raw.allowCustom === "boolean") q.allowCustom = raw.allowCustom;
	if (category) q.category = category;
	return q;
}

export function normalizeAskRequest(raw: unknown): NormalizeResult {
	const source = isRecord(raw) && Array.isArray(raw.questions) ? raw.questions : isRecord(raw) ? [raw] : undefined;
	if (!source || source.length === 0) return { ok: false, error: "questions must not be empty" };
	if (source.length > LIMITS.maxQuestions) return { ok: false, error: `at most ${LIMITS.maxQuestions} questions per ask` };
	const questions: Question[] = [];
	const seen = new Set<string>();
	for (const [index, entry] of source.entries()) {
		const q = question(entry, index);
		if (typeof q === "string") return { ok: false, error: q };
		if (seen.has(q.id)) return { ok: false, error: `duplicate question id "${q.id}"` };
		seen.add(q.id);
		questions.push(q);
	}
	return { ok: true, request: { questions } };
}
