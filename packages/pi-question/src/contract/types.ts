/**
 * The question contract. Pure data: no pi SDK, no I/O, no runtime dependencies.
 * Consumers import this through the package's `./contract` export.
 *
 * Shape is a superset of pi-ask-tool's `ask` parameters, so existing prompts and
 * model habits keep working. See `.spec/02-contract.md`.
 */

export type QuestionCategory = "implementation" | "scope-product" | "security-permission";

export interface QuestionOption {
	label: string;
	description?: string;
}

export interface Question {
	/** Stable id, unique within one ask. */
	id: string;
	question: string;
	/** Optional Markdown context. Renderers must sanitise it. */
	description?: string;
	options: QuestionOption[];
	multi?: boolean;
	/** Zero-based index into `options`. */
	recommended?: number;
	/** Whether a free-text answer is offered. Default true (pi-ask "Other"). */
	allowCustom?: boolean;
	category?: QuestionCategory;
}

export interface AskRequest {
	questions: Question[];
}

export type AnswerStatus = "answered" | "cancelled" | "timeout" | "dismissed" | "unavailable";

export interface QuestionAnswer {
	id: string;
	status: AnswerStatus;
	/** Zero-based indices into the question's options. */
	selected: number[];
	customText?: string;
	note?: string;
	/** True when no human chose: the choice is the question's recommendation applied at a timeout. */
	defaulted?: boolean;
}

/** Which surface delivered the ask. `degraded` means information was lost on the way. */
export interface AskDelivery {
	surface: "tui" | "dialogs" | "host" | "none";
	degraded: boolean;
}

/**
 * pi-ask-tool compatible result record. Field names match pi-ask-tool 0.2.x
 * `details.results[]` so readers of existing session files keep working.
 */
export interface CompatQuestionResult {
	id: string;
	question: string;
	description?: string;
	options: string[];
	multi: boolean;
	selectedOptions: string[];
	customInput?: string;
}

export interface AskToolDetails {
	/** pi-ask-tool single-question mirror fields (present when exactly one question). */
	id?: string;
	question?: string;
	description?: string;
	options?: string[];
	multi?: boolean;
	selectedOptions?: string[];
	customInput?: string;
	results?: CompatQuestionResult[];
	/** pi-question additions. */
	answers?: QuestionAnswer[];
	delivery?: AskDelivery;
}
