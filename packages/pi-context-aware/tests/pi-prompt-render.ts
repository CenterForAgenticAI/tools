import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Test stand-in for one `before_agent_start` handler call inside Pi.
 *
 * Pi hands each handler mutable prompt sections and renders the prompt the
 * model receives from them: the base text, then each non-empty section framed
 * in a tag of its own name, joined by blank lines. A handler that returns
 * `systemPrompt` replaces the whole prompt instead. This file restates that
 * contract independently of the extension's own renderer, so a test that goes
 * through it checks the prompt the model would see.
 */

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;

export interface PiPromptEvent extends Record<string, unknown> {
	systemPrompt: string;
	systemPromptOptions: { sections: Record<string, string>; forceSystemPrompt?: string };
}

export type PiPromptRun<T = Record<string, unknown>> = T & {
	/** The prompt the model receives after this handler. */
	systemPrompt: string;
	/** The handler's raw `systemPrompt` result, which Pi treats as a full replacement. */
	returnedSystemPrompt: string | undefined;
	/** The prompt sections after this handler ran. */
	sections: Record<string, string>;
};

/** Give a test event the mutable section map Pi 1.0 always provides. */
export function piBeforeAgentStartEvent(event: Record<string, unknown>): PiPromptEvent {
	const existing = event.systemPromptOptions as { sections?: Record<string, string>; forceSystemPrompt?: string } | undefined;
	const base = typeof event.systemPrompt === "string" ? event.systemPrompt : "";
	const options = { ...existing, sections: { ...existing?.sections } };
	return {
		type: "before_agent_start",
		...(event.messageType === "custom" ? {} : { prompt: "" }),
		...event,
		get systemPrompt() {
			return options.forceSystemPrompt ?? renderPiPrompt(base, options.sections);
		},
		systemPromptOptions: options,
	};
}

/** Render base text and sections the way Pi renders a structured prompt. */
export function renderPiPrompt(base: string, sections: Record<string, string>): string {
	for (const name of Object.keys(sections)) {
		if (!/^[a-z][a-z0-9_-]*$/.test(name) || name === "preamble") {
			throw new Error(`Invalid system prompt section name: ${name}`);
		}
	}
	const framed = Object.entries(sections)
		.filter(([, content]) => content.length > 0)
		.map(([name, content]) => `<${name}>\n${content}\n</${name}>`);
	return [base, ...framed].filter((part) => part.length > 0).join("\n\n");
}

/** Wrap a registered handler so each call runs as it would inside Pi 1.0. */
export function piPromptHandler(handler: Handler): Handler {
	return (event, ctx) => runBeforeAgentStartLikePi(handler, event, ctx);
}

/** Run one handler as Pi 1.0 would and report the prompt the model receives. */
export async function runBeforeAgentStartLikePi<T = Record<string, unknown>>(
	handler: Handler,
	event: Record<string, unknown>,
	ctx: ExtensionContext,
): Promise<PiPromptRun<T>> {
	const piEvent = piBeforeAgentStartEvent(event);
	const forcedBefore = piEvent.systemPromptOptions.forceSystemPrompt;
	const result = ((await handler(piEvent, ctx)) ?? {}) as T & { systemPrompt?: string };
	const returnedSystemPrompt = result.systemPrompt;
	if (forcedBefore === undefined && returnedSystemPrompt !== undefined) {
		// Pi treats a returned prompt as an opaque replacement with no sections,
		// so every later turn would rewrite the whole prompt.
		throw new Error("before_agent_start replaced the whole system prompt instead of setting prompt sections");
	}
	if (returnedSystemPrompt !== undefined) piEvent.systemPromptOptions.forceSystemPrompt = returnedSystemPrompt;
	return {
		...result,
		returnedSystemPrompt,
		sections: piEvent.systemPromptOptions.sections,
		systemPrompt: piEvent.systemPrompt,
	};
}
