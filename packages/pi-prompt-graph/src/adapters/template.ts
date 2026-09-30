import type { CompiledNode, NodeOutcome } from "../model.js";
import type { NodeExecutionContext } from "./index.js";
import { corroborateWindow, type NodeWindow } from "../pure/corroboration.js";
import { interpolate } from "./interpolate.js";

/**
 * Why PTM would not start a template, in PTM's own vocabulary.
 *
 * Reproduced rather than reinterpreted: these are the strings the fork emits on
 * `prompt-template:prompt:invoke:ack`, and a graph that renamed them would make
 * a run's diagnostics untraceable back to the extension that refused.
 */
export type TemplateRefusalReason =
	| "busy"
	| "chain-template"
	| "invalid-request"
	| "not-ready"
	| "unknown-template"
	| "unsupported-context";

/** What the adapter asks the session to start. */
export interface TemplateInvocation {
	readonly nodeId: string;
	/** The template's name, without a leading slash. */
	readonly name: string;
	readonly args?: string;
	readonly thinking?: string;
	readonly timeoutMs?: number | null;
	readonly signal?: globalThis.AbortSignal;
}

/**
 * PTM's answer to an invocation: it either started the template or said why not.
 *
 * A refusal is a node failure with a specific reason and is never retried into
 * the same wall (§2.4): an unknown template stays unknown, and a busy PTM is
 * busy because something else holds the session this run also needs.
 */
export type TemplateAck =
	| { readonly accepted: true; readonly runId: string }
	| { readonly accepted: false; readonly reason: TemplateRefusalReason };

/**
 * How a started template ended, as the session observed it.
 *
 * `status` is PTM's report. It is necessary and not sufficient: S5 recorded 128
 * of these while the model took 6 turns (D-051), so the window below is what
 * decides whether the node actually did anything.
 */
export interface TemplateCompletion {
	readonly status: "completed" | "failed" | "cancelled";
	/** PTM's own report of whether the prompt called `write` or `edit`. */
	readonly changed: boolean;
	readonly lastText?: string;
	/** Model turns observed between this node's `started` and `finished`. */
	readonly turnsInWindow: number;
	readonly usage?: NodeOutcome["usage"];
}

/**
 * The port Mode A runs behind.
 *
 * The adapter never names a `pi-prompt-template-model` symbol and never touches
 * `pi.events` itself: the runner supplies whatever can reach PTM in the live
 * session, exactly as the delegate adapter does for a worker (D-054). That is
 * what lets every rule below be tested without a session, and it is why this
 * file has no import from Pi.
 */
export interface TemplateSession {
	/** Ask PTM to start a template, and wait only for its acknowledgement. */
	invoke(invocation: TemplateInvocation): Promise<TemplateAck>;
	/**
	 * Wait for the started template's lifecycle completion, observing the node's
	 * window as it goes.
	 *
	 * Resolving to `undefined` means the peer never answered — no completion, no
	 * failure, no timeout of its own. That is the wedge S5 measured, and §11.2.2
	 * makes it a run-level fault rather than a node failure.
	 */
	awaitCompletion(runId: string, invocation: TemplateInvocation): Promise<TemplateCompletion | undefined>;
}

/**
 * Which PTM capabilities a session has. Both are preconditions with no fallback
 * (§11.2, D-038, D-039), so a missing one refuses the run at start rather than
 * degrading it.
 */
export interface TemplateCapabilities {
	/** PTM answers `prompt-template:prompt:invoke`. Without it a node cannot be started at all. */
	readonly canInvoke: boolean;
	/** PTM publishes `prompt-template:prompt:{started,finished}`. Without it a node cannot be known to have finished. */
	readonly publishesLifecycle: boolean;
	/** The PTM version found, named in the refusal so the reason is actionable. */
	readonly version?: string;
}

export interface TemplateAdapterConfig {
	readonly session: TemplateSession;
}

/**
 * Names what a session lacks, for `RUN-COMPLETION-SIGNAL-UNAVAILABLE`.
 *
 * Returns `undefined` when both capabilities are present. The message names the
 * version found as well as what is missing, because "upgrade PTM" is only
 * actionable when the reader can tell what they are running.
 */
export function missingTemplateCapabilities(capabilities: TemplateCapabilities): string | undefined {
	const missing: string[] = [];
	if (!capabilities.canInvoke) missing.push("the invocation event `prompt-template:prompt:invoke`");
	if (!capabilities.publishesLifecycle) missing.push("the lifecycle events `prompt-template:prompt:{started,finished}`");
	if (!missing.length) return undefined;
	const found = capabilities.version ? `pi-prompt-template-model ${capabilities.version}` : "the pi-prompt-template-model found";
	return `${found} lacks ${missing.join(" and ")}. Mode A has no fallback for either (D-038, D-039).`;
}

/**
 * A refusal reason rendered for a person, kept close to PTM's own words.
 *
 * Every one of these is terminal for the attempt. None of them becomes true by
 * asking again with the same request, which is why the outcome below is a node
 * failure that the engine's `retry` must not walk back into (§2.4).
 */
const REFUSAL_TEXT: Record<TemplateRefusalReason, string> = {
	"busy": "PTM is already running a prompt, loop, or chain, so it refused this one",
	"chain-template": "the template is a chain, a loop, or a boomerang, which the invocation channel cannot start",
	"invalid-request": "PTM rejected the invocation as malformed",
	"not-ready": "PTM has not finished loading its templates",
	"unknown-template": "PTM has no template by that name",
	"unsupported-context": "PTM cannot run a template in this context",
};

/**
 * Runs a `template` node: Mode A, the graph driving a prompt template inside the
 * user's own session.
 *
 * The adapter reports; it resolves nothing. Three rules do the work, and each
 * exists because something was measured going wrong:
 *
 * 1. **A refusal is a node failure with a reason** (§2.4). PTM says why, and the
 *    reason is carried through rather than flattened to "failed".
 * 2. **A reported completion is corroborated before it is accepted** (D-051). A
 *    window with no model turn fails the node rather than passing it.
 * 3. **A peer that never answers is a run-level fault** (§11.2.2), not a node
 *    failure — retrying a node cannot fix a session that has stopped working.
 */
export class TemplateAdapter {
	readonly config: TemplateAdapterConfig;

	constructor(config: TemplateAdapterConfig) {
		this.config = config;
	}

	async run(node: CompiledNode, context: NodeExecutionContext = {}): Promise<NodeOutcome> {
		if (node.binding.kind !== "template") throw new TypeError(`Node ${node.id} is not a template node.`);
		const state = context.state ?? {};
		const invocation: TemplateInvocation = {
			nodeId: node.id,
			name: node.binding.command,
			...(node.binding.args ? { args: interpolate(node.binding.args, state) } : {}),
			...(node.binding.thinking ? { thinking: node.binding.thinking } : {}),
			timeoutMs: node.timeoutMs,
			...(context.signal ? { signal: context.signal } : {}),
		};

		const ack = await this.config.session.invoke(invocation);
		if (!ack.accepted) {
			// Never a retry into the same wall: the engine sees a node failure with
			// the reason attached, and `onError` routes it like any other.
			return {
				status: "failed",
				changed: false,
				completionSignal: "not-applicable",
				// Terminal: none of PTM's refusal reasons becomes false by asking the
				// same thing again, so a retry would spend budget to be told the same
				// thing. `onError` still routes it (§2.4).
				terminal: true,
				diagnostics: [`Node ${node.id}: PTM refused to start template "${invocation.name}" — ${REFUSAL_TEXT[ack.reason]} (${ack.reason}).`],
			};
		}

		const completion = await this.config.session.awaitCompletion(ack.runId, invocation);

		// No completion, no failure, no timeout of the peer's own. This is the wedge
		// S5 measured: the session stays nominally alive and stops doing work, and
		// every node after it inherits it. The run suspends; the node is not blamed.
		if (completion === undefined) {
			return {
				status: "aborted",
				changed: false,
				completionSignal: "not-applicable",
				peerUnresponsive: {
					peer: "pi-prompt-template-model",
					detail: `Node ${node.id}: template "${invocation.name}" was started and PTM never reported it finishing.`,
				},
				diagnostics: [`Node ${node.id}: no lifecycle completion arrived for template "${invocation.name}".`],
			};
		}

		if (completion.status !== "completed") {
			return {
				status: completion.status === "cancelled" ? "aborted" : "failed",
				changed: completion.changed,
				completionSignal: "reported",
				...(completion.usage ? { usage: completion.usage } : {}),
				...(completion.lastText ? { text: completion.lastText } : {}),
				diagnostics: [`Node ${node.id}: template "${invocation.name}" reported ${completion.status}.`],
			};
		}

		// PTM says it finished. That is necessary and not sufficient (D-051).
		const window: NodeWindow = {
			turnsInWindow: completion.turnsInWindow,
			reportedChanged: completion.changed,
			...(completion.lastText ? { lastText: completion.lastText } : {}),
		};
		const corroboration = corroborateWindow(window);
		if (!corroboration.corroborated) {
			return {
				status: "failed",
				changed: false,
				completionSignal: "reported",
				...(completion.usage ? { usage: completion.usage } : {}),
				...(completion.lastText ? { text: completion.lastText } : {}),
				uncorroborated: true,
				diagnostics: [`Node ${node.id}: template "${invocation.name}" reported completion, but ${corroboration.reason}. A reported completion is not evidence of work (D-051).`],
			};
		}

		// A template node's declared output is the model's last message.
		//
		// PTM has no structured return channel, so this is the value there is. It
		// was already carried as `text` and the runner only ever stores
		// `outcome.output`, so before #36 every template node's declared `output:`
		// stayed empty: a graph ending in one completed, reported success, and
		// produced nothing. All eight template nodes across the four worked
		// examples declare `output:` and none declares a contract, so requiring a
		// structured result would refuse every one of them.
		//
		// The weakness is real and worth naming: this is prose, so nothing checks
		// it, and a template that merely says "done" stores "done". Corroboration
		// (D-051) is what stands between that and a node which did nothing at all.
		if (node.output && !completion.lastText) {
			return {
				status: "failed",
				changed: completion.changed,
				completionSignal: "reported",
				...(completion.usage ? { usage: completion.usage } : {}),
				diagnostics: [`Node ${node.id} declares output ${node.output}, but template "${invocation.name}" finished with no text to store. A node that cannot produce its declared output must not report success (#36).`],
			};
		}

		return {
			status: "completed",
			changed: completion.changed,
			completionSignal: "reported",
			...(completion.usage ? { usage: completion.usage } : {}),
			...(completion.lastText ? { text: completion.lastText } : {}),
			...(completion.lastText === undefined ? {} : { output: completion.lastText }),
		};
	}
}
