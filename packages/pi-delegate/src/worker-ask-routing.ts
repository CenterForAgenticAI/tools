/**
 * Worker-only compatibility routing for generic `ask` tools.
 *
 * A worker has no foreground prompt surface. Keeping a generic ask tool there
 * would therefore either disappear into a no-op UI or invite the model to
 * answer its own question. This module replaces an extension-registered ask
 * tool with either a typed escalation adapter or an actionable denial.
 */

import { Type } from "@sinclair/typebox";
import type { DefaultResourceLoader, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ResolvedEscalationConfig } from "./config.js";
import {
	makeEscalationRaiseTools,
	type EscalationRaiseToolDeps,
	type EscalationTool,
} from "./escalation-tools.js";
import type { EscalationCategory } from "./escalation-store.js";
import { ASK_TOOL_NAME } from "./tool-surface.js";

export { ASK_TOOL_NAME };

/**
 * Disabled-slot denial. This text is ALSO the tool description the model sees,
 * so it must not name a tool that is absent from this slot: `escalate_decision`
 * is only registered when escalation is enabled, and pointing a denied worker at
 * it invites a hallucinated call plus a wasted round. Instruct the only two safe
 * actions instead — stop, and report the unresolved question upward.
 */
const ASK_ROUTING_DENIED =
	"Generic `ask` cannot reach the user from a delegate worker, and this slot does not have " +
	"escalation enabled. Stop and report the unresolved question to whoever dispatched you, " +
	"asking for an escalation-enabled dispatch. Do not answer the question yourself, do not " +
	"work around it, and do not call an escalation tool — none is available in this slot.";

const ASK_CATEGORY_ERROR =
	"Generic `ask` could not be safely translated: provide an explicit escalation " +
	"category (`implementation`, `scope-product`, or `security-permission`) " +
	"rather than assuming a design or security question is implementation-local.";

const ASK_SHAPE_ERROR =
	"Generic `ask` could not be safely translated: it must carry a non-empty " +
	"question and 2–5 explicit options so the worker's intent is preserved.";

const ASK_MULTI_QUESTION_ERROR =
	"Generic `ask` could not be safely translated: an escalation carries exactly one bounded " +
	"decision, so a multi-question ask cannot be preserved. Raise the blocking question first " +
	"and escalate any remaining question separately.";

export interface AskRoutingOptions {
	enabled: boolean;
	/** Required only for enabled routing; the adapter never infers authority. */
	raiseDeps?: EscalationRaiseToolDeps;
}

const ASK_ORIGIN = "ask" as const;

const AskCategorySchema = Type.Union([
	Type.Literal("implementation"),
	Type.Literal("scope-product"),
	Type.Literal("security-permission"),
], {
	description: "Required classification: implementation for reversible local choices; scope-product for material scope, product, or UX changes; security-permission for security or permission questions.",
});

const AskOptionSchema = Type.Union([
	Type.String({ minLength: 1 }),
	Type.Object({ label: Type.String({ minLength: 1 }) }),
]);

/** Canonical shape an enabled adapter accepts, after `prepareAskArguments`. */
const ENABLED_ASK_SCHEMA = Type.Object({
	question: Type.String({ minLength: 1, description: "The bounded question to decide." }),
	category: AskCategorySchema,
	options: Type.Array(AskOptionSchema, { minItems: 2, maxItems: 5, description: "2–5 explicit options." }),
	body: Type.Optional(Type.String({ description: "Additional context for the decision." })),
	recommended: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based recommended option index." })),
	multi: Type.Optional(Type.Boolean({ description: "Allow selecting more than one option." })),
});

/** Disabled-slot shape: accept anything so `execute` can return the denial. */
const PERMISSIVE_ASK_SCHEMA = Type.Object({}, { additionalProperties: true });

/**
 * Coerce the ask dialects a worker may emit into `ENABLED_ASK_SCHEMA`.
 *
 * Pi runs this before schema validation and turns a throw into an ordinary
 * error tool result, so an unpreservable payload gets this module's actionable
 * wording instead of a raw validation failure. Coercion only renames and
 * reshapes; it never invents a category, an option set, or an answer.
 */
export function prepareAskArguments(raw: unknown): Record<string, unknown> {
	const params: Record<string, unknown> = isRecord(raw) ? { ...raw } : {};
	const questions = params.questions;
	if (Array.isArray(questions)) {
		// A single-question ask is exactly one bounded decision, so translate it
		// rather than rejecting the shape the generic ask tool advertises.
		if (questions.length !== 1) throw new Error(ASK_MULTI_QUESTION_ERROR);
		const [entry] = questions;
		if (!isRecord(entry)) throw new Error(ASK_SHAPE_ERROR);
		delete params.questions;
		Object.assign(params, {
			...entry,
			// A per-question `description` is decision context, not the prompt.
			...(typeof entry.description === "string" ? { body: entry.description } : {}),
		});
	}
	const question = firstString(params.question, params.header, params.prompt);
	const body = firstString(params.body, params.context);
	const rawOptions = Array.isArray(params.options)
		? params.options
		: Array.isArray(params.choices) ? params.choices : undefined;
	const recommended = params.recommended ?? params.recommendedIndex;
	const multi = typeof params.multi === "boolean"
		? params.multi
		: typeof params.multiple === "boolean" ? params.multiple : undefined;
	return {
		...(question !== undefined ? { question } : {}),
		...(params.category !== undefined ? { category: params.category } : {}),
		...(rawOptions ? { options: rawOptions.map(normalizeOptionEntry) } : {}),
		...(body !== undefined ? { body } : {}),
		...(recommended !== undefined ? { recommended } : {}),
		...(multi !== undefined ? { multi } : {}),
	};
}

/** Preserve unknown entries verbatim so schema validation reports them. */
function normalizeOptionEntry(option: unknown): unknown {
	if (typeof option === "string") return option.trim() || option;
	if (isRecord(option) && typeof option.label === "string") return { label: option.label.trim() || option.label };
	return option;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Build a worker-local ask shim. It never selects an option or supplies a timeout default. */
export function makeWorkerAskRoutingTool(options: AskRoutingOptions): ToolDefinition {
	const decisionTool: EscalationTool | undefined = options.enabled && options.raiseDeps
		? makeEscalationRaiseTools({
			...options.raiseDeps,
			origin: ASK_ORIGIN,
			config: noDefaultDecisionConfig(options.raiseDeps.config),
		})[0]
		: undefined;

	return {
		name: ASK_TOOL_NAME,
		label: options.enabled ? "Route ask as escalation" : "Ask unavailable in worker",
		description: options.enabled
			? "Compatibility adapter: translate this ask-shaped bounded question to escalate_decision. Include category, question, 2–5 options, and an optional recommended index. No timeout default is applied."
			: ASK_ROUTING_DENIED,
		// The ENABLED adapter advertises the canonical shape so the provider can
		// constrain and validate the call instead of every malformed payload
		// costing a round trip; `prepareArguments` (below) coerces the ask dialects
		// that predate it. The DISABLED shim stays permissive on purpose: any
		// ask-shaped call must reach `execute` and receive the actionable denial
		// rather than a schema-validation error the worker cannot act on.
		parameters: options.enabled ? ENABLED_ASK_SCHEMA : PERMISSIVE_ASK_SCHEMA,
		...(options.enabled ? { prepareArguments: prepareAskArguments } : {}),
		execute: async (toolCallId, params, signal) => {
			if (!options.enabled || !decisionTool) return deniedAskResult();
			const normalized = normalizeAskParams(params as Record<string, unknown>);
			if (normalized.ok === false) return askError(normalized.reason, normalized.code);
			if (!normalized.category) return askError(ASK_CATEGORY_ERROR, "ask-category-required");
			const result = await decisionTool.execute(toolCallId, {
				header: normalized.header,
				...(normalized.body ? { body: normalized.body } : {}),
				options: normalized.options,
				recommended: normalized.recommended,
				multi: normalized.multi,
				category: normalized.category,
			}, signal);
			return {
				...result,
				details: {
					...(result.details ?? {}),
					routedFrom: ASK_TOOL_NAME,
					askCategory: normalized.category,
				},
			};
		},
	};
}

/** Replace every loaded extension registration named `ask`, preserving provenance. */
export function replaceLoadedAskTools(
	loader: Pick<DefaultResourceLoader, "getExtensions">,
	shim: ToolDefinition,
): boolean {
	let replaced = false;
	for (const extension of loader.getExtensions().extensions) {
		const registered = extension.tools.get(ASK_TOOL_NAME);
		if (!registered) continue;
		extension.tools.set(ASK_TOOL_NAME, { ...registered, definition: shim });
		replaced = true;
	}
	return replaced;
}

/**
 * Reconcile an `ask` entry in a worker allowlist with what the loader actually
 * registered.
 *
 * `ask` parses as an allowlist name (see `tool-surface.ts`) but is provided by
 * an extension, so a surface can name it while nothing registers it. Pi's
 * allowlist is name-only, so that combination silently yields a worker without
 * the tool — and, when `ask` was the ONLY entry, a worker with NO tools at all
 * (`tools: ["nope"]` still fails closed in `resolveRunToolSurface`, so `ask`
 * must not become the one name that can quietly empty a surface). Fail closed
 * in that case; otherwise report a diagnostic and continue, since the rest of
 * the allowlist is still usable.
 */
export function reconcileWorkerAskSurface(args: {
	tools: readonly string[] | undefined;
	replaced: boolean;
	onDiagnostic?: (message: string) => void;
}): void {
	if (args.replaced || !args.tools?.includes(ASK_TOOL_NAME)) return;
	const remaining = args.tools.filter((name) => name !== ASK_TOOL_NAME);
	if (remaining.length === 0) {
		throw new Error(
			`Explicit tools allowlist selects only ${JSON.stringify(ASK_TOOL_NAME)}, but no loaded ` +
			"extension registers it; refusing to construct a worker with no usable tools.",
		);
	}
	args.onDiagnostic?.(
		`tools-error: tool ${JSON.stringify(ASK_TOOL_NAME)} is in the worker allowlist but no loaded ` +
		`extension registers it; the worker runs without it (remaining: ${remaining.join(", ")})`,
	);
}

function normalizeAskParams(params: Record<string, unknown>):
	| { ok: true; header: string; body?: string; options: Array<{ label: string }>; recommended?: number; multi?: boolean; category?: EscalationCategory }
	| { ok: false; reason: string; code: string } {
	const header = firstString(params.question, params.header, params.prompt);
	const rawOptions = Array.isArray(params.options) ? params.options : params.choices;
	if (!header || !Array.isArray(rawOptions) || rawOptions.length < 2 || rawOptions.length > 5) {
		return { ok: false, reason: ASK_SHAPE_ERROR, code: "ask-shape-unpreservable" };
	}
	const options: Array<{ label: string }> = [];
	for (const option of rawOptions) {
		const label = typeof option === "string"
			? option.trim()
			: option && typeof option === "object" && typeof (option as { label?: unknown }).label === "string"
				? (option as { label: string }).label.trim()
				: "";
		if (!label) return { ok: false, reason: ASK_SHAPE_ERROR, code: "ask-shape-unpreservable" };
		options.push({ label });
	}
	const recommendation = params.recommended ?? params.recommendedIndex;
	if (recommendation !== undefined && (!Number.isInteger(recommendation) || (recommendation as number) < 0 || (recommendation as number) >= options.length)) {
		return { ok: false, reason: "Generic `ask` recommendation must be a zero-based option index.", code: "ask-invalid-recommendation" };
	}
	const category = params.category as EscalationCategory | undefined;
	if (category !== undefined && !isEscalationCategory(category)) {
		return { ok: false, reason: ASK_CATEGORY_ERROR, code: "ask-category-required" };
	}
	return {
		ok: true,
		header,
		...(firstString(params.body, params.context) ? { body: firstString(params.body, params.context) } : {}),
		options,
		...(recommendation !== undefined ? { recommended: recommendation as number } : {}),
		...(typeof params.multi === "boolean" || typeof params.multiple === "boolean" ? { multi: (params.multi ?? params.multiple) as boolean } : {}),
		...(category ? { category } : {}),
	};
}

function deniedAskResult() {
	return askError(ASK_ROUTING_DENIED, "ask-requires-escalation", {
		requiresEscalationEnabledDispatch: true,
	});
}

/**
 * `requiresEscalationEnabledDispatch` is deliberately NOT set by default: a
 * malformed call inside an already-enabled slot is fixed by calling
 * `escalate_decision` correctly, not by re-dispatching the run.
 */
function askError(text: string, reason: string, extraDetails: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text" as const, text }],
		details: {
			reason,
			tool: ASK_TOOL_NAME,
			...extraDetails,
		},
		isError: true,
	};
}

/**
 * Expiry must not silently select the worker's own recommendation, so a routed
 * ask never runs under `useDefault`. An explicitly configured `cancel` or
 * `noDefaultError` already carries no default and states an operator intent, so
 * it is preserved rather than rewritten.
 */
function noDefaultDecisionConfig(config: ResolvedEscalationConfig): ResolvedEscalationConfig {
	if (config.timeoutBehavior.decision !== "useDefault") return config;
	return {
		...config,
		timeoutBehavior: { ...config.timeoutBehavior, decision: "noDefaultError" },
	};
}

function isEscalationCategory(value: unknown): value is EscalationCategory {
	return value === "implementation" || value === "scope-product" || value === "security-permission";
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
	return undefined;
}
