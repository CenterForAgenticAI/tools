import { defineTool, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildDetails, narrate, normalizeAskRequest, type AskToolDetails } from "../contract/index.ts";
import { selectSurface } from "../adapters/select-surface.ts";
import { loadConfig } from "../config.ts";
import { runAsk } from "./run.ts";

// Schema is pi-ask-tool's, plus optional pi-question fields. Keep it a superset.
const Option = Type.Object({
	label: Type.String({ description: "Display label" }),
	description: Type.Optional(Type.String({ description: "Optional one-line explanation of this option" })),
});

const QuestionItem = Type.Object({
	id: Type.String({ description: "Question id (e.g. auth, cache, priority)" }),
	question: Type.String({ description: "Question text" }),
	description: Type.Optional(Type.String({ description: "Optional context in Markdown/plain text." })),
	options: Type.Array(Option, { description: "Available options. Do not include 'Other'.", minItems: 1 }),
	multi: Type.Optional(Type.Boolean({ description: "Allow multi-select" })),
	recommended: Type.Optional(Type.Number({ description: "0-indexed recommended option." })),
	allowCustom: Type.Optional(Type.Boolean({ description: "Offer a free-text answer. Default true." })),
	category: Type.Optional(
		Type.Union([Type.Literal("implementation"), Type.Literal("scope-product"), Type.Literal("security-permission")]),
	),
});

export const AskParameters = Type.Object({
	questions: Type.Array(QuestionItem, { description: "Questions to ask", minItems: 1 }),
});

const DESCRIPTION = `
Ask the user for clarification when a choice materially affects the outcome.

- Use when multiple valid approaches have different trade-offs.
- Prefer 2-5 concise options.
- Use multi=true when multiple answers are valid.
- Use recommended=<index> (0-indexed) to mark the default option.
- Use description to provide Markdown/plain context.
- You can ask multiple related questions in one call using questions[].
- Do NOT include an 'Other' option; UI adds it automatically.
`.trim();

export const createAskTool = (pi: Pick<ExtensionAPI, "events">) => defineTool({
	name: "ask",
	label: "Ask",
	description: DESCRIPTION,
	parameters: AskParameters,
	executionMode: "sequential",
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const normalized = normalizeAskRequest(params);
		if (!normalized.ok) {
			return { content: [{ type: "text", text: `Error: ${normalized.error}` }], details: {} satisfies AskToolDetails };
		}
		const { questions } = normalized.request;
		const config = loadConfig(getAgentDir(), ctx.cwd, (m) => console.warn(m));
		const surface = selectSurface(ctx, config.surfaces);
		const outcome = await runAsk({ surface, questions, signal, config, events: pi.events });
		if (outcome.kind === "failed") {
			return { content: [{ type: "text", text: "Error: the question timed out and no default is allowed." }], details: {} satisfies AskToolDetails };
		}
		const answers = outcome.answers;
		return {
			content: [{ type: "text", text: narrate(questions, answers, surface.delivery) }],
			details: buildDetails(questions, answers, surface.delivery),
		};
	},
});
