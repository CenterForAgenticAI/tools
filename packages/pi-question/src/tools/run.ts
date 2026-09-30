import type { Question, QuestionAnswer } from "../contract/index.ts";
import type { AskSurface } from "../adapters/surface.ts";
import type { PiQuestionConfig } from "../config.ts";
import { expire } from "../kernel/expire.ts";
import { withBlockedSignal, type EventSink } from "../kernel/signals.ts";

export type AskOutcome = { kind: "answers"; answers: QuestionAnswer[] } | { kind: "failed" };

export interface RunAskInput {
	surface: AskSurface;
	questions: Question[];
	signal: AbortSignal | undefined;
	config: PiQuestionConfig;
	events: EventSink | undefined;
}

/**
 * Ask through the surface, racing an optional deadline. Answers already given
 * are kept; only unanswered questions expire (L1: the first outcome wins).
 */
export async function runAsk({ surface, questions, signal, config, events }: RunAskInput): Promise<AskOutcome> {
	const label = questions.length === 1 ? (questions[0]?.question ?? "question") : `${questions.length} questions`;
	return withBlockedSignal(events, surface.delivery.surface, label, config.blockedSignal, async () => {
		if (config.timeoutMs <= 0) return { kind: "answers", answers: await surface.ask(questions, signal) } as const;
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<"deadline">((resolve) => {
			timer = setTimeout(() => resolve("deadline"), config.timeoutMs);
		});
		try {
			const pending = surface.ask(questions, controller.signal);
			const winner = await Promise.race([pending, deadline]);
			if (winner !== "deadline") return { kind: "answers", answers: winner } as const;
			controller.abort();
			const settled = await pending.catch((): QuestionAnswer[] => []);
			const answers: QuestionAnswer[] = [];
			for (const [i, q] of questions.entries()) {
				const given = settled[i];
				if (given && given.status === "answered") {
					answers.push(given);
					continue;
				}
				const e = expire(config.onTimeout, q);
				if (e.kind === "failed") return { kind: "failed" } as const;
				answers.push(e.answer);
			}
			return { kind: "answers", answers } as const;
		} finally {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	});
}
