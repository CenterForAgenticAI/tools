/**
 * Operator-only advice for a structured provider refusal.
 *
 * A refusal is an outcome, not an account failure: routing keeps the account
 * and nothing is resent (see `src/routing.ts`, status `retained`). This module
 * only tells the operator what happened and which choices remain. It never
 * resends, rephrases, starts a turn, changes the model, rotates an account, or
 * writes state.
 *
 * Only the structured `code` field selects advice. The adapter sets it from the
 * provider's own stop reason (`src/anthropic-adaptive-stream.ts`). Assistant
 * prose, the error message, the raw stop reason, and content are never read,
 * so a refusal is never guessed and no provider text can reach the advice.
 */

/** Identical advice inside this window is shown once. */
export const REFUSAL_ADVICE_REPEAT_WINDOW_MS = 60_000;

/** Provider and model IDs are named only when they are short, plain tokens. */
const SAFE_ROUTE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

const CHOICES =
	"Multi-account kept the account and did not resend, reroute, or retry it. " +
	"You can revise the request, or pick another model explicitly with /model.";

export type RefusalAdviceRoute = Readonly<{
	providerId?: unknown;
	modelId?: unknown;
}>;

/** Reads one own data property; accessors and proxies count as absent. */
function ownDataValue(value: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	return descriptor !== undefined && "value" in descriptor
		? descriptor.value
		: undefined;
}

/**
 * The allowlisted projection: whether `message` is an assistant error terminal
 * carrying the exact structured `refusal` code. Nothing else is read.
 */
export function isStructuredRefusal(message: unknown): boolean {
	try {
		if (typeof message !== "object" || message === null) return false;
		return (
			ownDataValue(message, "role") === "assistant" &&
			ownDataValue(message, "stopReason") === "error" &&
			ownDataValue(message, "code") === "refusal"
		);
	} catch {
		return false;
	}
}

function safeRouteId(value: unknown): string | undefined {
	return typeof value === "string" && SAFE_ROUTE_ID.test(value)
		? value
		: undefined;
}

function safeRouteLabel(route: RefusalAdviceRoute): string | undefined {
	try {
		const providerId = safeRouteId(route.providerId);
		const modelId = safeRouteId(route.modelId);
		return providerId === undefined || modelId === undefined
			? undefined
			: `${providerId}/${modelId}`;
	} catch {
		return undefined;
	}
}

/**
 * Bounded advice text for a structured refusal, or `undefined` when the message
 * carries no structured refusal code. The text names only the route identity
 * the caller resolved, and drops it when it is not a short plain token.
 */
export function refusalAdvice(
	message: unknown,
	route: RefusalAdviceRoute,
): string | undefined {
	if (!isStructuredRefusal(message)) return undefined;
	const label = safeRouteLabel(route);
	const subject =
		label === undefined ? "The model refused this request." : `${label} refused this request.`;
	return `${subject} ${CHOICES}`;
}

type NotifyContext = {
	readonly hasUI?: unknown;
	readonly ui?: { notify?: unknown };
};

export type RefusalAdvisorOptions = Readonly<{
	/** False for delegate-owned sessions that share the foreground UI. */
	foreground: boolean;
	now?: () => number;
}>;

/**
 * Shows refusal advice in the foreground UI at most once per terminal and once
 * per route inside {@link REFUSAL_ADVICE_REPEAT_WINDOW_MS}. Fail-soft: a UI
 * failure never reaches the caller. Returns whether advice was shown.
 */
export function createRefusalAdvisor(options: RefusalAdvisorOptions) {
	const now = options.now ?? Date.now;
	const advised = new WeakSet<object>();
	let lastText: string | undefined;
	let lastAtMs = Number.NEGATIVE_INFINITY;
	return {
		advise(
			message: unknown,
			context: NotifyContext | undefined,
			route: RefusalAdviceRoute,
		): boolean {
			try {
				if (!options.foreground) return false;
				const text = refusalAdvice(message, route);
				if (text === undefined) return false;
				if (advised.has(message as object)) return false;
				advised.add(message as object);
				if (context?.hasUI !== true) return false;
				const notify = context.ui?.notify;
				if (typeof notify !== "function") return false;
				const atMs = now();
				if (text === lastText && atMs - lastAtMs < REFUSAL_ADVICE_REPEAT_WINDOW_MS) {
					return false;
				}
				lastText = text;
				lastAtMs = atMs;
				notify.call(context.ui, text, "warning");
				return true;
			} catch {
				return false;
			}
		},
	};
}
