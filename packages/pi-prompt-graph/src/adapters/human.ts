import type { CompiledNode, JsonValue, NodeOutcome } from "../model.js";
import { acceptedAnswers, resolveHumanAnswer } from "../pure/human.js";
import { interpolate } from "./interpolate.js";
import type { NodeExecutionContext } from "./index.js";

/**
 * The adapter that asks a person.
 *
 * It pauses the run rather than answering for anybody: with no answer in hand it
 * reports `awaitingHuman`, and the runner journals `human-requested` and moves
 * the run to `waiting-human`. The run resumes with the operator's answer, which
 * is injected into the interrupted node only
 * ([0005](../../.spec/0005-node-adapters.md) §5).
 *
 * A `human` node is the one kind with no clock: its resolved `timeoutMs` is
 * `null`, because it is already waiting for the person a timeout prompt would
 * ask ([0010](../../.spec/0010-decision-log.md) D-033).
 */
export class HumanAdapter {
	/** The question this node puts to the operator, with state interpolated in. */
	question(node: CompiledNode, context: NodeExecutionContext = {}): string {
		if (node.binding.kind !== "human") throw new TypeError(`Node ${node.id} is not a human node.`);
		return interpolate(node.binding.question, context.state ?? {});
	}

	/** What the operator may type, so a refusal can say so. */
	accepts(node: CompiledNode): string[] {
		if (node.binding.kind !== "human") throw new TypeError(`Node ${node.id} is not a human node.`);
		return acceptedAnswers(node.binding.form);
	}

	run(node: CompiledNode, context: HumanExecutionContext = {}): Promise<NodeOutcome> {
		if (node.binding.kind !== "human") throw new TypeError(`Node ${node.id} is not a human node.`);
		const question = this.question(node, context);
		if (context.answer === undefined) {
			// Not a failure and not a verdict: the node has not run yet. The run
			// suspends here and the operator decides when it continues (D-022).
			return Promise.resolve({ status: "aborted", changed: false, completionSignal: "not-applicable", awaitingHuman: { question } });
		}
		const resolved = resolveHumanAnswer(node.binding.form, context.answer);
		if (!resolved.ok) {
			// Still waiting. A refused answer must not become a verdict, so the node
			// is not failed either: failing it would route an operator's typo through
			// `onError` and spend a retry on a question nobody re-asked.
			return Promise.resolve({ status: "aborted", changed: false, completionSignal: "not-applicable", awaitingHuman: { question, refusal: resolved.refusal } });
		}
		return Promise.resolve({
			status: "completed",
			changed: false,
			completionSignal: "not-applicable",
			humanVerdict: resolved.answer.verdict,
			// A `text` node MUST declare `output` (`E-TEXT-NODE-NO-OUTPUT`), and this
			// is what lands there. `confirm` and `choice` carry the verdict alone.
			...(resolved.answer.value === undefined ? {} : { output: resolved.answer.value }),
		});
	}
}

export interface HumanExecutionContext extends NodeExecutionContext {
	/** The operator's answer, as supplied to `/graph resume`. */
	readonly answer?: JsonValue;
}

export function runHuman(node: CompiledNode, context: HumanExecutionContext = {}): Promise<NodeOutcome> {
	return new HumanAdapter().run(node, context);
}
