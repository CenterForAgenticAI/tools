import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { OTHER_OPTION, type Question, type QuestionAnswer } from "../contract/index.ts";
import type { AskSurface } from "./surface.ts";

type DialogUi = Pick<ExtensionUIContext, "select" | "input">;

const RECOMMENDED = " (Recommended)";

/**
 * Primitive fallback: one select per single-choice question, one input per
 * multi-choice question. Works over `pi --mode rpc` and pi-daemon's
 * `ui_request` because both forward `select` and `input`.
 */
export function dialogSurface(ui: DialogUi): AskSurface {
	return {
		delivery: { surface: "dialogs", degraded: true },
		async ask(questions, signal) {
			const answers: QuestionAnswer[] = [];
			for (const q of questions) answers.push(await askOne(ui, q, signal));
			return answers;
		},
	};
}

async function askOne(ui: DialogUi, q: Question, signal: AbortSignal | undefined): Promise<QuestionAnswer> {
	const opts = signal ? { signal } : undefined;
	const labels = q.options.map((o, i) => (q.recommended === i ? `${o.label}${RECOMMENDED}` : o.label));
	const title = q.description ? `${q.question}\n\n${q.description}` : q.question;
	const custom = q.allowCustom !== false;
	if (q.multi) {
		const menu = labels.map((l, i) => `${i + 1}. ${l}`).join("\n");
		const raw = await ui.input(`${title}\n\nReply with comma-separated option numbers.\n${menu}`, undefined, opts);
		if (raw === undefined || raw.trim() === "") return { id: q.id, status: "cancelled", selected: [] };
		const selected: number[] = [];
		const rest: string[] = [];
		for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
			const n = Number(part);
			if (Number.isInteger(n) && n >= 1 && n <= labels.length) {
				if (!selected.includes(n - 1)) selected.push(n - 1);
			} else rest.push(part);
		}
		const answer: QuestionAnswer = { id: q.id, status: "answered", selected };
		if (custom && rest.length > 0) answer.customText = rest.join(", ");
		return answer;
	}
	const choice = await ui.select(title, custom ? [...labels, OTHER_OPTION] : labels, opts);
	if (choice === undefined) return { id: q.id, status: "cancelled", selected: [] };
	if (custom && choice === OTHER_OPTION) {
		const text = await ui.input(`${q.question}\n\nYour answer:`, undefined, opts);
		return text && text.trim()
			? { id: q.id, status: "answered", selected: [], customText: text.trim() }
			: { id: q.id, status: "cancelled", selected: [] };
	}
	const index = labels.indexOf(choice);
	return index >= 0
		? { id: q.id, status: "answered", selected: [index] }
		: { id: q.id, status: "answered", selected: [], customText: choice };
}
