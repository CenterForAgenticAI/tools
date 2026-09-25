/**
 * Build seed messages for the fork-clone.
 *
 * The fork-clone is a fresh AgentSession running the main agent's model + system
 * prompt. It needs a starting message history. Modes:
 *
 *   - "full"       Clone the entire main-thread history up to (but not including)
 *                  the unresolved assistant tool_use that triggered delegate.
 *                  Append a user message framing the delegation.
 *   - "snippet"    Take only the last N main-thread messages (user/assistant text,
 *                  tool calls summarised) as quoted context, inside a single user
 *                  message that frames the delegation.
 *   - "task_only"  Ignore main-thread history; single user message with just the
 *                  task and agent framing.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.js";
import type { TaskDeliveryMode } from "./delegate-runs.js";

// `AgentMessage` isn't re-exported from the top level of pi-coding-agent,
// so we use a structural alias here. This matches what session.messages
// actually returns.
type AgentMessage = any;

export type CloneMode = "full" | "snippet" | "task_only";


/**
 * The already-completed first `message_subagent` exchange for direct-first-turn
 * delivery. The runtime sends the caller's exact task to the worker, captures
 * the reply, and hands this back so the supervisor clone starts with a real,
 * resolved tool-call/result pair in its history (issue #452).
 */
export interface DirectFirstTurnExchange {
	/** Tool-call id shared by the synthetic assistant call and its result. */
	toolCallId: string;
	/** Tool name for the synthetic call (the clone's message_subagent tool). */
	toolName: string;
	/** The caller's exact task, delivered to the worker and shown as the call text. */
	task: string;
	/** The tool-result content the worker's first reply produced, verbatim. */
	replyContent: Array<{ type: "text"; text: string }>;
}
export interface BuildSeedOptions {
	mode: CloneMode;
	branchEntries: SessionEntry[];
	fromToolCallId: string; // tool call id of the delegate call being executed
	agent: AgentConfig;
	forkName: string;
	task: string;
	maxRounds: number;
	collapseMode: "final_output" | "summary";
	supervisorInstructions?: string;
	snippetLastN?: number;
	/**
	 * The absolute working directory the subagent (worker session) runs in.
	 * Rendered in the supervisor framing so the clone knows where the
	 * worker's file/shell tools operate.
	 */
	agentCwd?: string;
	/** Resolved supervised first-turn delivery mode. */
	taskDelivery: TaskDeliveryMode;
	/**
	 * Present only when `taskDelivery === "direct-first-turn"`: the completed
	 * first exchange to seed into the supervisor's history. Required in that
	 * mode; `buildSeedMessages` throws if it is missing.
	 */
	directFirstTurn?: DirectFirstTurnExchange;
}

export interface SeedResult {
	/** Messages to install on cloneSession.agent.state.messages before prompting. */
	priorMessages: AgentMessage[];
	/** Text to pass to cloneSession.prompt() to kick off the fork. */
	triggerText: string;
}

const isMessageEntry = (e: SessionEntry): e is SessionEntry & { type: "message" } => e.type === "message";

/**
 * Walk the cloned messages and prune the final assistant message if it contains
 * a toolCall matching `fromToolCallId`. That call is still in flight (this
 * extension's tool is executing) and feeding it to a fresh agent as an
 * unresolved tool_use would confuse the model.
 */
function stripPendingToolUse(messages: AgentMessage[], fromToolCallId: string): AgentMessage[] {
	if (messages.length === 0) return messages;
	const last = messages[messages.length - 1];
	if (last.role !== "assistant") return messages;
	const hasPending = (last.content as any[]).some(
		(part) => part && part.type === "toolCall" && part.id === fromToolCallId,
	);
	if (!hasPending) return messages;
	return messages.slice(0, -1);
}

/** Also strip any trailing orphan assistant tool_use messages (defensive). */
function stripTrailingOrphanToolUses(messages: AgentMessage[]): AgentMessage[] {
	let end = messages.length;
	while (end > 0) {
		const m = messages[end - 1] as any;
		if (m.role === "assistant") {
			const parts = Array.isArray(m.content) ? m.content : [];
			const toolCalls = parts.filter((p: any) => p?.type === "toolCall");
			if (toolCalls.length === 0) break;
			// Check that every toolCall has a following toolResult somewhere after it
			const allResolved = toolCalls.every((tc: any) =>
				messages.slice(end).some((n: any) => n.role === "toolResult" && n.toolCallId === tc.id),
			);
			if (allResolved) break;
			end--;
			continue;
		}
		break;
	}
	return end === messages.length ? messages : messages.slice(0, end);
}

function summariseMessageForSnippet(m: AgentMessage, max = 400): string {
	const truncate = (s: string, n: number = max) => (s.length > n ? `${s.slice(0, n)}…` : s);
	if (m.role === "user") {
		const text = Array.isArray(m.content)
			? m.content
					.map((c: any) => (c.type === "text" ? c.text : c.type === "image" ? "[image]" : ""))
					.filter(Boolean)
					.join("\n")
			: String(m.content);
		return `User: ${truncate(text)}`;
	}
	if (m.role === "assistant") {
		const parts: string[] = [];
		for (const c of m.content as any[]) {
			if (c.type === "text") parts.push(truncate(c.text));
			else if (c.type === "toolCall") parts.push(`[tool: ${c.name}(${truncate(JSON.stringify(c.arguments), 120)})]`);
		}
		return `Assistant: ${parts.join(" ")}`;
	}
	if (m.role === "toolResult") {
		const text = (m.content as any[])
			.map((c) => (c.type === "text" ? c.text : ""))
			.filter(Boolean)
			.join("\n");
		return `ToolResult(${(m as any).toolName}): ${truncate(text, 200)}`;
	}
	return "";
}

function buildDelegationFraming(opts: BuildSeedOptions, includeTaskBlock: boolean): string {
	const lines: string[] = [];
	lines.push(
		`You have decided to delegate a subtask to a specialised subagent. ` +
			`Your goal in this sub-conversation is to iterate with them — provide clarifications, review their output, redirect them if needed — until the delegation is complete.`,
	);
	lines.push("");
	lines.push(`## Subagent`);
	lines.push(`- Name: ${opts.agent.name}`);
	lines.push(`- Role: ${opts.agent.description}`);
	if (opts.forkName !== opts.agent.name) {
		lines.push(`- Instance label: ${opts.forkName}`);
	}
	lines.push("");
	if (opts.agentCwd) {
		lines.push(`## Subagent working directory`);
		lines.push(opts.agentCwd);
		lines.push("");
	}
	if (includeTaskBlock) {
		lines.push(`## Task`);
		lines.push(opts.task);
		lines.push("");
	}
	lines.push(`## Your tools (in this fork only)`);
	lines.push(
		`- \`message_subagent(text)\` — Send a message to the subagent. They will run their own tools and return a reply. Use this for the initial task and for every follow-up.`,
	);
	lines.push(
		`- \`finish_delegation({ final_output?, summary? })\` — End the fork. Provide either a \`final_output\` (the concrete answer to return to your main thread) or ask for a \`summary\` of what happened.`,
	);
	lines.push("");
	lines.push(`## Rules (read carefully)`);
	lines.push(`- You **must not** use any other tools in this fork. File/bash/search tools are not available here — the subagent has them.`);
	lines.push(
		`- You have up to **${opts.maxRounds} round(s)** of \`message_subagent\`. Plan your rounds.`,
	);
	lines.push(
		`- **Your final turn MUST be a \`finish_delegation\` tool call.** Do not end with a text-only assistant message — if you do, your text will be salvaged, but this is a fallback, not the intended path. Always terminate by calling \`finish_delegation\`.`,
	);
	lines.push(
		`- Collapse mode is **${opts.collapseMode}**: ` +
			(opts.collapseMode === "final_output"
				? `call \`finish_delegation({ final_output: "..." })\` with the concrete, self-contained answer your main thread needs. The payload is returned verbatim — no further processing — so include everything that matters.`
				: `call \`finish_delegation({ summary: "..." })\` with a concise, self-contained note. An explicitly configured \`summary_model\` may refine it from the full transcript; without one, your note is returned verbatim with no provider call.`),
	);
	if (opts.agent.stopConditionHint) {
		lines.push(`- Stop condition hint: ${opts.agent.stopConditionHint}`);
	}
	if (opts.supervisorInstructions) {
		lines.push(`- Additional guidance: ${opts.supervisorInstructions}`);
	}
	lines.push("");
	lines.push(
		`Begin by calling \`message_subagent\` with a clear first instruction for the subagent. Do not narrate between tool calls. Your **last** tool call must be \`finish_delegation\`.`,
	);
	return lines.join("\n");
}

export function buildSeedMessages(opts: BuildSeedOptions): SeedResult {
	const { basePriorMessages, framingText } = buildModeSeed(opts);
	if (opts.taskDelivery === "direct-first-turn") {
		return buildDirectFirstTurnSeed(opts, basePriorMessages, framingText);
	}
	return { priorMessages: basePriorMessages, triggerText: framingText };
}

/**
 * Compute the mode-appropriate starting history and framing text, independent
 * of the delivery mode. `task_only`/`snippet` seed no prior messages and fold
 * their context into the framing; `full` clones the stripped main-thread
 * history and uses the framing as the next user turn.
 */
function buildModeSeed(opts: BuildSeedOptions): { basePriorMessages: AgentMessage[]; framingText: string } {
	if (opts.mode === "task_only") {
		return { basePriorMessages: [], framingText: buildDelegationFraming(opts, true) };
	}

	if (opts.mode === "snippet") {
		const lastN = opts.snippetLastN ?? 10;
		const msgs = opts.branchEntries
			.filter(isMessageEntry)
			.map((e) => e.message as AgentMessage)
			.slice(-lastN);
		const snippet = msgs.map((m) => summariseMessageForSnippet(m)).filter(Boolean).join("\n\n");
		const framing = buildDelegationFraming(opts, true);
		// Issue #13 nit — distinguish "the branch was genuinely empty" from
		// "entries existed but none were message entries / all summarised to
		// nothing" (e.g. a branch of pure tool events). The old single
		// "(no prior context)" string misled debugging sessions into thinking
		// the branch itself was empty.
		const fallback =
			opts.branchEntries.length > 0
				? "(prior entries present but none were renderable messages)"
				: "(no prior context)";
		const combined =
			`## Recent main-thread context\n\n<snippet>\n${snippet || fallback}\n</snippet>\n\n` + framing;
		return { basePriorMessages: [], framingText: combined };
	}

	// "full" mode: clone full message history, strip pending tool_use; the
	// framing becomes the triggering prompt() call (i.e., the next user turn).
	const raw = opts.branchEntries.filter(isMessageEntry).map((e) => e.message as AgentMessage);
	let cloned = stripPendingToolUse(raw, opts.fromToolCallId);
	cloned = stripTrailingOrphanToolUses(cloned);
	return { basePriorMessages: cloned, framingText: buildDelegationFraming(opts, true) };
}

/**
 * Direct-first-turn (#452): the runtime already delivered the caller's exact
 * task to the worker and captured the reply. Represent that as a real completed
 * `message_subagent` exchange in the supervisor's history — the mode-appropriate
 * framing becomes the user turn that prompted the call, followed by the
 * assistant tool call and its resolved result — then prompt the supervisor with
 * a follow-up-only continuation. This keeps the supervisor's history in the
 * exact shape it would have had if it had made a correct first call itself,
 * without asking the model to reproduce the task.
 */
function buildDirectFirstTurnSeed(
	opts: BuildSeedOptions,
	basePriorMessages: AgentMessage[],
	framingText: string,
): SeedResult {
	const exchange = opts.directFirstTurn;
	if (!exchange) {
		throw new Error("direct-first-turn seed requires the completed first-turn exchange");
	}
	const framingUser: AgentMessage = {
		role: "user",
		content: [{ type: "text", text: framingText }],
	};
	const assistantCall: AgentMessage = {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: exchange.toolCallId,
				name: exchange.toolName,
				arguments: { text: exchange.task },
			},
		],
	};
	const toolResult: AgentMessage = {
		role: "toolResult",
		toolCallId: exchange.toolCallId,
		toolName: exchange.toolName,
		content: exchange.replyContent,
	};
	return {
		priorMessages: [...basePriorMessages, framingUser, assistantCall, toolResult],
		triggerText: buildDirectFirstTurnContinuation(opts),
	};
}

/**
 * The user turn that starts the supervisor's first *generated* turn in
 * direct-first-turn mode. The task and its reply are already in history above,
 * so this only tells the supervisor to review and continue — never to resend
 * the task, which would reintroduce the paraphrase this mode exists to prevent.
 */
function buildDirectFirstTurnContinuation(opts: BuildSeedOptions): string {
	const remaining = Math.max(0, opts.maxRounds - 1);
	const lines: string[] = [];
	lines.push(
		"The subagent has already been sent the task and returned the reply shown in the completed " +
			"`message_subagent` exchange above. That delivery was round 1.",
	);
	lines.push("");
	lines.push(
		"Do not resend or restate the task — it has already been delivered to the subagent exactly as written.",
	);
	lines.push(
		`You have ${remaining} follow-up round(s) of \`message_subagent\` remaining. Review the reply, then either ` +
			"send a follow-up (each consumes one round) or call `finish_delegation` to collapse the fork.",
	);
	lines.push("Your **last** tool call must be `finish_delegation`.");
	return lines.join("\n");
}
