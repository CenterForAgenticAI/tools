import type { HumanForm, JsonValue, VerdictName } from "../model.js";

/**
 * Turning an operator's answer into a verdict.
 *
 * Pure. It decides; a runner journals the decision and routes on it.
 *
 * A human node's verdicts are a **fixed namespace**
 * ([0011](../../.spec/0011-data-contracts.md) §5.4): `confirmed` or `declined`
 * for a confirmation, the chosen option's id for a choice, and `answered` for
 * free text. They are words rather than booleans because a YAML mapping key
 * `true:` is a boolean, so a routing table whose shape depends on how it was
 * quoted is a defect waiting to be filed
 * ([0010](../../.spec/0010-decision-log.md) D-020).
 *
 * An answer outside that namespace is **refused, never coerced**. Coercion here
 * would be the same failure the rest of this package keeps removing: a run that
 * routed on a guess looks exactly like a run that routed on an answer.
 */

export interface HumanAnswer {
	readonly verdict: VerdictName;
	/** The text a `text` node collected. Absent for `confirm` and `choice`. */
	readonly value?: JsonValue;
}

export type HumanAnswerResolution =
	| { readonly ok: true; readonly answer: HumanAnswer }
	| { readonly ok: false; readonly refusal: string };

/**
 * The spellings a confirmation accepts.
 *
 * The two verdict words, and `true`/`false` because
 * [`.spec/examples/release-gate.md`](../../.spec/examples/release-gate.md)
 * documents `/graph resume <runId> true`. The **verdict** recorded and routed is
 * always the word, so D-020 holds however the answer was typed.
 */
const CONFIRM_INPUTS: ReadonlyMap<string, VerdictName> = new Map([
	["confirmed", "confirmed"],
	["declined", "declined"],
	["true", "confirmed"],
	["false", "declined"],
]);

/** Every answer a form accepts, for a refusal that tells the operator what to type. */
export function acceptedAnswers(form: HumanForm): string[] {
	if (form.kind === "confirm") return [...CONFIRM_INPUTS.keys()];
	if (form.kind === "choice") return form.options.map((option) => option.id);
	return ["any non-empty text"];
}

/** Resolve one operator answer against a human node's form. */
export function resolveHumanAnswer(form: HumanForm, raw: JsonValue | undefined): HumanAnswerResolution {
	if (raw === undefined || raw === null) return refuse(form, "no answer was supplied");

	if (form.kind === "confirm") {
		if (typeof raw === "boolean") return { ok: true, answer: { verdict: raw ? "confirmed" : "declined" } };
		if (typeof raw !== "string") return refuse(form, `${describe(raw)} is not a confirmation`);
		const verdict = CONFIRM_INPUTS.get(raw.trim().toLowerCase());
		return verdict ? { ok: true, answer: { verdict } } : refuse(form, `${JSON.stringify(raw)} is not a confirmation`);
	}

	if (form.kind === "choice") {
		if (typeof raw !== "string") return refuse(form, `${describe(raw)} is not one of the options`);
		// An exact option id, and nothing else. A near miss is refused rather than
		// guessed at, for the same reason an illegal `graph_transition` is refused
		// rather than corrected (D-057).
		const chosen = form.options.find((option) => option.id === raw.trim());
		return chosen ? { ok: true, answer: { verdict: chosen.id } } : refuse(form, `${JSON.stringify(raw)} is not one of the options`);
	}

	if (typeof raw !== "string") return refuse(form, `${describe(raw)} is not text`);
	// A `text` node exists to collect something, and it MUST declare `output`
	// (`E-TEXT-NODE-NO-OUTPUT`). An empty answer routing as `answered` would write
	// nothing and look like a successful collection.
	if (raw.trim().length === 0) return refuse(form, "the answer is empty");
	return { ok: true, answer: { verdict: "answered", value: raw } };
}

function refuse(form: HumanForm, because: string): HumanAnswerResolution {
	return { ok: false, refusal: `The answer was refused: ${because}. This ${form.kind} node accepts ${acceptedAnswers(form).join(", ")}.` };
}

function describe(value: JsonValue): string {
	return Array.isArray(value) ? "an array" : typeof value === "object" ? "an object" : JSON.stringify(value);
}
