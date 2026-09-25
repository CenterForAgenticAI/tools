/**
 * Minimal in-repo RPC client for the detached `orchestrate` pi child (spec
 * 0013, node A: `rpc-transport-and-terminal`).
 *
 * The orchestrate child now runs `pi --mode rpc` (NOT `--mode json -p`): a
 * headless JSON stdin/stdout protocol (newline-delimited JSON). This module is
 * the PARENT-side half of that protocol — the transport + terminal-detection
 * machinery the runner drives. It is deliberately MINIMAL: pi-mono's own
 * `RpcClient` is internal (not a public export of the installed
 * `@earendil-works/pi-coding-agent` package), so we reimplement only the slice
 * the orchestrate runner needs, with node builtins + the JSONL framing.
 *
 * PROTOCOL REFERENCE (cite, do NOT import internals) —
 * github.com/earendil-works/pi, packages/coding-agent/src/modes/rpc/:
 *   - jsonl.ts            — `serializeJsonLine` (LF-only `JSON.stringify(v)+"\n"`)
 *                           + `attachJsonlLineReader` (strict LF framing, NOT
 *                           node readline). Copied FAITHFULLY here.
 *   - rpc-mode.ts         — the CHILD side. CRITICAL behaviours this client must
 *                           respect (each verified against the source):
 *                             * runRpcMode ends `return new Promise(()=>{})`
 *                               (rpc-mode.ts:24-area) — the child NEVER
 *                               self-exits; it exits only on stdin `end` /
 *                               SIGTERM / SIGHUP. So terminal is detected off
 *                               the EVENT STREAM and the child is torn down
 *                               EXPLICITLY by the runner.
 *                             * the child PAUSES its own agent loop on stdout
 *                               backpressure (`session.agent.subscribe(async()=>
 *                               { await waitForRawStdoutBackpressure() })`,
 *                               rpc-mode.ts:357-area) — a slow/absent reader
 *                               does NOT SIGPIPE; it SILENTLY STALLS the agent
 *                               forever with no agent_end. Hence: attach the
 *                               reader SYNCHRONOUSLY at construction (before any
 *                               write) and never stop draining until exit.
 *                             * `extension_ui_request` events: BLOCKING methods
 *                               (confirm/select/input/editor) await an
 *                               `extension_ui_response` keyed by `id`;
 *                               fire-and-forget methods (notify/setStatus/
 *                               setWidget/setTitle/set_editor_text) get NO reply.
 *   - rpc-client.ts       — the reference parent. We are deliberately STRICTER:
 *                           its `waitForIdle` resolves on ANY `agent_end`
 *                           IGNORING `willRetry` (rpc-client.ts waitForIdle).
 *                           A retryable provider error makes pi emit
 *                           `agent_end{willRetry:true}` then start ANOTHER turn
 *                           (agent-session.ts _willRetryAfterAgentEnd ~503/549),
 *                           so we treat ONLY `agent_end{willRetry:false}` as the
 *                           qualifying terminal. We also do NOT copy its fragile
 *                           100ms post-attach `setTimeout` startup probe.
 *   - rpc-types.ts        — RpcCommand / RpcResponse / RpcExtensionUIRequest /
 *                           RpcExtensionUIResponse shapes (modelled locally).
 *
 * PROTOCOL VERSION PIN: validated against pi-coding-agent — see
 * `VALIDATED_PI_VERSION`. The protocol-shape assertions below (the event
 * discriminants + the `agent_end.messages` / `message_end.message` carriers)
 * are what a pi upgrade would have to change; if it does, this client should
 * fail LOUD (a classification error) rather than hang silently.
 *
 * NO control wiring lives here yet (steer / follow_up / abort): spec 0013 node
 * B owns the SteerableSession facade + the control consumer. This module ships
 * only the transport + terminal half: send the initial `{prompt}`, drain the
 * stream, classify the terminal, and tear the child down.
 */

import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { isDeepStrictEqual } from "node:util";
import {
	classifyHarvestOutcome,
	RUN_ENDING_CONTINUATION_PROMPT,
	shouldAttemptHarvestContinuation,
	type HarvestMessage,
} from "./harvest-outcome.js";
import { saturatingAdd } from "./usage-rollup.js";

/**
 * The pi-coding-agent version this RPC client's protocol shape was validated
 * against. Bump deliberately after re-verifying the rpc/ source + the live e2e
 * protocol-shape assertion. A silent protocol drift past this is exactly what
 * the shape assertions guard against.
 */
export const VALIDATED_PI_VERSION = "0.74.x";

// ── JSONL framing (FAITHFUL copy of pi-mono modes/rpc/jsonl.ts) ──────────────
//
// LF-only newline-delimited JSON. Payloads may contain other Unicode line
// separators (U+2028 / U+2029) that are valid inside JSON strings, so we split
// on "\n" ONLY — node `readline` splits on those extra separators and would
// corrupt strict JSONL framing. Reproduced (not imported) per the spec's
// "node builtins only / do NOT import pi internals" constraint.

/** Serialize one strict JSONL record (LF-terminated). */
export function serializeJsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

/**
 * Attach an LF-only JSONL reader to a stream. Returns a detach function.
 * Mirrors pi-mono `attachJsonlLineReader` (github.com/earendil-works/pi).
 */
export function attachJsonlLineReader(
	stream: Readable,
	onLine: (line: string) => void,
): () => void {
	const decoder = new StringDecoder("utf8");
	let buffer = "";

	const emitLine = (line: string) => {
		onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
	};

	const onData = (chunk: string | Buffer) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
		while (true) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) return;
			emitLine(buffer.slice(0, newlineIndex));
			buffer = buffer.slice(newlineIndex + 1);
		}
	};

	const onEnd = () => {
		buffer += decoder.end();
		if (buffer.length > 0) {
			emitLine(buffer);
			buffer = "";
		}
	};

	stream.on("data", onData);
	stream.on("end", onEnd);

	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}

// ── Protocol shapes (modelled locally from rpc-types.ts; NOT imported) ───────
//
// Only the fields this client inspects are modelled. Everything else on a pi
// event is ignored. Pinned to `VALIDATED_PI_VERSION`.

/** A pi message `content` part (the subset we read). */
interface PiContentPart {
	type?: string;
	text?: unknown;
	content?: unknown;
}

/** A pi assistant/user/toolResult message (the subset we read). */
interface PiMessage extends HarvestMessage {
	role?: string;
	content?: unknown;
	customType?: unknown;
	stopReason?: string;
	errorMessage?: string;
	usage?: {
		input?: number;
		inputTokens?: number;
		output?: number;
		outputTokens?: number;
		cacheRead?: number;
		cacheReadTokens?: number;
		cacheWrite?: number;
		cacheWriteTokens?: number;
		cost?: { total?: number };
	};
}

/**
 * A pi RPC stdout line — an `AgentSessionEvent`, a command `response` ack, or an
 * `extension_ui_request`. Only the discriminants + carriers we act on are
 * modelled. `agent_end.willRetry` is stamped by the session
 * (agent-session.ts:503); `agent_end.messages` carries the turn's messages.
 */
interface PiRpcLine {
	type?: string;
	// agent_end
	messages?: PiMessage[];
	willRetry?: boolean;
	// message_end / message_update
	message?: PiMessage;
	// tool_execution_start / tool_execution_end
	toolName?: string;
	result?: unknown;
	// extension_ui_request
	id?: string;
	method?: string;
}

/** An extension_ui_request method that BLOCKS the child awaiting a response. */
const BLOCKING_UI_METHODS = new Set([
	"confirm",
	"select",
	"input",
	"editor",
]);

// ── Accumulated stream outcome (preserved shape from spec 0007) ──────────────
//
// The runner's `PiChildResult` carries an `outcome` of this shape. We PRESERVE
// the spec-0007 field names (finalText / cleanStopText / toolStarts / usage /
// cleanStop / rawLines) — re-expressed over the RPC event stream rather than
// the print stream — so the runner's terminal classification + the supervision
// substrate that reads `outcome` are unchanged at the field level. The
// clean-stop predicate (REQ-RPC-4, the old `decidePiStreamTerminal` logic) is
// applied to the message that accompanies the QUALIFYING `agent_end`.

/** Accumulated token/cost usage scraped from assistant `message_end` events. */
export interface RpcStreamUsage {
	turns: number;
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost: number;
}

/** The distilled outcome of an RPC run's event stream (REQ-RPC-2/4). */
export interface RpcStreamOutcome {
	/** Last assistant `message_end` text observed (any stopReason). */
	finalText: string;
	/**
	 * Assistant text from the QUALIFYING terminal stop specifically
	 * (stopReason:'stop', no tool call, non-error). This — NOT `finalText` — is
	 * the authoritative `done` output (REQ-RPC-4): set ONLY by a clean
	 * terminating message, so interim/tool-use text can never masquerade as a
	 * successful terminal and stale earlier text never survives an empty stop.
	 */
	cleanStopText?: string;
	/** Tool names whose `tool_execution_start` we saw (activity tracking). */
	toolStarts: string[];
	/** Accumulated token/cost usage. */
	usage: RpcStreamUsage;
	/** A provider/assistant errorMessage if one surfaced (e.g. 401). */
	assistantError?: string;
	/** True iff a qualifying clean assistant stop (no tool, non-error) landed. */
	cleanStop: boolean;
	/** Raw protocol lines that failed to parse (kept for failure context). */
	rawLines: string[];
}

function emptyUsage(): RpcStreamUsage {
	return { turns: 0, input: 0, output: 0, cost: 0 };
}

function emptyOutcome(): RpcStreamOutcome {
	return {
		finalText: "",
		toolStarts: [],
		usage: emptyUsage(),
		cleanStop: false,
		rawLines: [],
	};
}

/**
 * Extract plain text from a pi message `content` (string, or an array of
 * `{type:'text',text}` / `{type:'tool_result',content}` / `{text}` parts).
 */
export function extractTextFromContent(content: unknown): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const texts: string[] = [];
	for (const part of content as PiContentPart[]) {
		if (part && typeof part === "object") {
			if (part.type === "text" && "text" in part) texts.push(String(part.text));
			else if (part.type === "tool_result" && "content" in part) {
				const inner = extractTextFromContent(part.content);
				if (inner) texts.push(inner);
			} else if ("text" in part) texts.push(String(part.text));
		}
	}
	return texts.join("\n");
}

/** True iff a message `content` array carries a `toolCall` part. */
function hasToolCall(content: unknown): boolean {
	return (
		Array.isArray(content) &&
		content.some((p) => (p as PiContentPart)?.type === "toolCall")
	);
}

function isHarvestRole(message: PiMessage): boolean {
	return message.role === "user" || message.role === "custom" || message.role === "assistant";
}

function sameHarvestMessage(left: PiMessage, right: PiMessage): boolean {
	return left.role === right.role &&
		left.customType === right.customType &&
		left.stopReason === right.stopReason &&
		left.errorMessage === right.errorMessage &&
		isDeepStrictEqual(left.content, right.content);
}

function latestAssistantInAuthoritativeWindow(
	messages: readonly PiMessage[],
): PiMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i]!;
		if (message.role === "assistant") return message;
		if (message.role === "user") return undefined;
	}
	return undefined;
}

// ── Terminal classification ──────────────────────────────────────────────────

/** Why the run reached a terminal (diagnostics / classification). */
export type RpcTerminalReason =
	/** A qualifying `agent_end{willRetry:false}` was observed. */
	| "agent_end"
	/** The process exited (or errored / stdin-EPIPE'd) before a qualifying end. */
	| "process_exit"
	/** No protocol event of ANY kind for the liveness ceiling while alive. */
	| "stalled";

/** A terminal classification of a finished RPC run (REQ-RPC-4). */
export type RpcTerminal =
	| { kind: "done"; output: string }
	| { kind: "failed"; error: string };

/**
 * The full result of driving an RPC child to terminal — the classification
 * PLUS the accumulated stream outcome + exit context the runner threads into
 * its `PiChildResult`.
 */
export interface RpcDriveResult {
	terminal: RpcTerminal;
	reason: RpcTerminalReason;
	outcome: RpcStreamOutcome;
	exitCode: number | null;
	stderr: string;
	/** A spawn/transport-level error (ENOENT, stdin EPIPE before any event). */
	spawnError?: string;
}

/**
 * Map a finished RPC run to a terminal (REQ-RPC-4 — the FIX, re-expressed over
 * the event stream). This is the spec-0007 `decidePiStreamTerminal` predicate
 * preserved (NOT deleted): a provider/assistant error / nonzero exit / NO clean
 * terminal assistant text is `failed`; ONLY a qualifying clean stop with real
 * text is `done`. A provider error must NEVER become an empty `done` (the
 * original spec 0005 bug). Side-effect-free + exported so a unit test asserts
 * classification over a canned outcome.
 */
export function classifyRpcTerminal(args: {
	outcome: RpcStreamOutcome;
	reason: RpcTerminalReason;
	exitCode: number | null;
	stderr?: string;
	/** Deterministic childlog path for operator-visible terminal failures. */
	childlogPath?: string;
}): RpcTerminal {
	const { outcome, reason, exitCode } = args;
	const stderr = (args.stderr ?? "").trim();

	// (b) An explicit provider/assistant error always fails, regardless of exit.
	if (outcome.assistantError) {
		return {
			kind: "failed",
			error: `pi child reported an assistant error: ${outcome.assistantError}${stderr ? `\n--- stderr ---\n${stderr}` : ""}`,
		};
	}

	// (b) A stalled child (no protocol event for the liveness ceiling while the
	// process was still alive) fails distinctly — it is NOT a turn deadline; a
	// long-but-EMITTING turn is never killed (REQ-RPC-10 / spec-0002 invariant).
	if (reason === "stalled") {
		const detail =
			stderr ||
			(outcome.rawLines.length
				? outcome.rawLines.slice(-10).join("\n")
				: "(no protocol events observed while the process was alive)");
		return {
			kind: "failed",
			error: `pi child stalled (no RPC events while alive): ${detail}${args.childlogPath ? ` (childlog: ${args.childlogPath})` : ""}`,
		};
	}

	// (b) The process exited/errored before a qualifying agent_end → failed with
	// whatever context we have (exit code + stderr + raw lines).
	if (reason === "process_exit") {
		const detail =
			stderr ||
			(outcome.rawLines.length
				? outcome.rawLines.slice(-10).join("\n")
				: "(no stderr / no parseable output)");
		return {
			kind: "failed",
			error: `pi child exited before a clean terminal (code ${exitCode === null ? "null (signal)" : exitCode}): ${detail}`,
		};
	}

	// reason === "agent_end": a qualifying agent_end{willRetry:false} landed.
	// (b) Nonzero exit alongside it (rare; the runner ends stdin → the child
	// exits 0 normally) still fails.
	if (exitCode !== null && exitCode !== 0) {
		const detail = stderr || "(nonzero exit after a qualifying agent_end)";
		return {
			kind: "failed",
			error: `pi child exited with code ${exitCode} after agent_end: ${detail}`,
		};
	}

	// (b) `done` REQUIRES a clean assistant stop (stopReason:'stop', no tool
	// call, non-error) that itself carried terminal text. A qualifying agent_end
	// without that — a partial/tool-use end, an empty clean stop — is a FAILURE,
	// never a silent `done`. This is the spec-0007 REQ-PICLI-4 predicate.
	const cleanText = (outcome.cleanStopText ?? "").trim();
	if (!outcome.cleanStop || !cleanText) {
		const detail =
			stderr ||
			(outcome.rawLines.length
				? outcome.rawLines.slice(-10).join("\n")
				: !outcome.cleanStop
					? "(agent_end without a clean assistant stop — partial or tool-use turn)"
					: "(clean stop but no terminal assistant text)");
		return {
			kind: "failed",
			error: `pi child produced no clean terminal assistant output: ${detail}`,
		};
	}

	// (a) Clean stop + non-error + terminal text → done (output from the clean
	// stop itself, not interim text).
	return { kind: "done", output: cleanText };
}

// ── The RPC client ────────────────────────────────────────────────────────────

/** Tunables for the RPC client (test seams + the liveness ceiling). */
export interface OrchestrateRpcClientOptions {
	/** Deterministic childlog path included in the operator-visible stall error. */
	childlogPath?: string;
	/**
	 * Liveness ceiling (ms): if NO protocol event of any kind is observed for
	 * this long while the process is still alive, the run is classified
	 * `stalled` → `failed` (REQ-RPC-10). Keys on the ABSENCE OF ANY EVENT, NOT a
	 * turn deadline — a long-but-emitting turn resets the timer on every event
	 * and is never killed (spec-0002's no-wall-clock-kill-of-a-healthy-pipeline
	 * invariant). The first interval starts when `start()` sends the prompt.
	 */
	livenessCeilingMs?: number;
	/** Bounded SIGTERM→SIGKILL backstop window during teardown (ms). */
	sigkillBackstopMs?: number;
	/** Injectable clock (tests). */
	now?: () => number;
}

/** Default liveness ceiling: generous enough for a slow first model token. */
export const DEFAULT_LIVENESS_CEILING_MS = 120_000;

/**
 * Absolute maximum liveness ceiling (issue #8): the longest the parent will
 * tolerate ZERO stream events from an alive child before declaring a stall.
 * Callers may tune the ceiling up to this bound; they may not disable it.
 */
export const MAX_LIVENESS_CEILING_MS = 600_000;

/** Clamp a caller-supplied liveness ceiling into (0, MAX_LIVENESS_CEILING_MS]. */
export function clampLivenessCeiling(requested: number | undefined): number {
	if (requested === undefined) return DEFAULT_LIVENESS_CEILING_MS;
	if (typeof requested !== "number" || Number.isNaN(requested) || requested <= 0) {
		return DEFAULT_LIVENESS_CEILING_MS;
	}
	// `Infinity` (or any over-max value) reads as "as long as possible" — that
	// is the absolute max, never "no ceiling".
	return Math.min(requested, MAX_LIVENESS_CEILING_MS);
}

/** Cap on captured child stderr (MR !2 review finding #3) — OOM guard. */
export const MAX_STDERR_BYTES = 1024 * 1024;

/** Cap on collected unparseable stdout lines (MR !2 review finding #4). */
export const MAX_RAW_LINES = 1000;
/** Default SIGTERM→SIGKILL backstop window during teardown. */
export const DEFAULT_SIGKILL_BACKSTOP_MS = 5_000;

/**
 * Drives a `pi --mode rpc` child over its JSON stdin/stdout protocol — the
 * TRANSPORT + TERMINAL half (spec 0013 node A).
 *
 * Lifecycle:
 *   1. `new OrchestrateRpcClient(child, opts)` — attaches the stdout JSONL
 *      reader + the stderr collector SYNCHRONOUSLY (before any write). This
 *      ordering is the #1 hang guard: the child stalls its agent loop on stdout
 *      backpressure, so the reader MUST be draining before the first `{prompt}`.
 *   2. `start(task)` — sends `{type:'prompt', message:task}` ONCE.
 *   3. `waitForTerminal()` — resolves with the classified `RpcDriveResult` on a
 *      qualifying `agent_end{willRetry:false}` RACED with process exit/error +
 *      the liveness ceiling; THEN tears the child down (end stdin → bounded
 *      SIGTERM → SIGKILL) and only then resolves.
 *
 * `isStreaming` (derived from agent_start/agent_end) and the live `child` are
 * exposed for spec 0013 node B's SteerableSession facade; node A does not wire
 * steer/cancel.
 */
export class OrchestrateRpcClient {
	private readonly child: ChildProcess;
	private readonly stdin: Writable | null;
	private readonly opts: Required<
		Pick<
			OrchestrateRpcClientOptions,
			"livenessCeilingMs" | "sigkillBackstopMs"
		>
	> & { now: () => number; childlogPath?: string };

	private readonly outcome: RpcStreamOutcome = emptyOutcome();
	/** Request-scoped provenance used by the shared harvest selector. */
	private readonly harvestMessages: PiMessage[] = [];
	/** Message-end carriers observed in the current agent turn, for agent_end dedupe. */
	private currentTurnMessages: PiMessage[] = [];
	private continuationAttempts = 0;
	private runEndingToolObserved = false;
	private runEndingToolDeclared = false;
	private callerAbortRequested = false;
	private stderr = "";
	/** True once `stderr` hit MAX_STDERR_BYTES and further chunks are dropped. */
	private stderrTruncated = false;
	private detachStdout: (() => void) | null = null;

	/** True between an `agent_start` and its matching `agent_end` (REQ-RPC-8). */
	private streaming = false;
	/** Whether `start()` has sent the initial prompt. */
	private started = false;
	/** Whether a terminal has been reached (idempotency guard). */
	private terminalReached = false;

	private exitCode: number | null = null;
	private signalCode: NodeJS.Signals | null = null;
	private exited = false;
	private spawnError: string | undefined;
	/** Set when the stdin transport dies (EPIPE) without (yet) a process exit. */
	private transportGone = false;

	/** Resolver for `waitForTerminal()`; set once the promise is created. */
	private resolveTerminal: ((r: RpcDriveResult) => void) | null = null;
	/** Cached `waitForTerminal()` promise (idempotent across calls). */
	private terminalPromise: Promise<RpcDriveResult> | null = null;
	private livenessTimer: NodeJS.Timeout | null = null;

	constructor(child: ChildProcess, options: OrchestrateRpcClientOptions = {}) {
		this.child = child;
		this.stdin = child.stdin ?? null;
		this.opts = {
			childlogPath: options.childlogPath,
			// Issue #8 — clamp to an absolute ceiling: a caller-supplied
			// `Infinity` (or any huge value) would otherwise disable the stall
			// detector entirely and wedge the parent forever on a stalled-but-
			// alive child. Non-finite / non-positive values fall back to the
			// default; finite values are capped at MAX_LIVENESS_CEILING_MS.
			livenessCeilingMs: clampLivenessCeiling(options.livenessCeilingMs),
			sigkillBackstopMs:
				options.sigkillBackstopMs ?? DEFAULT_SIGKILL_BACKSTOP_MS,
			now: options.now ?? Date.now,
		};

		// ── Attach the readers SYNCHRONOUSLY, before any write. ──
		// (REQ-RPC-2) The child pauses its agent loop on stdout backpressure, so
		// the stdout reader must be draining before the first `{prompt}` and must
		// never stop until exit. The stderr collector is attached here too.
		if (child.stdout) {
			this.detachStdout = attachJsonlLineReader(child.stdout, (line) =>
				this.handleLine(line),
			);
		}
		child.stderr?.on("data", (chunk: Buffer | string) => {
			// HARDENING (MR !2 review finding #3): bound the capture. A verbose /
			// looping child otherwise grows this string for the whole run (OOM
			// vector). Keep the FIRST MAX_STDERR_BYTES (the failure origin is
			// almost always at the start) + a truncation marker.
			if (this.stderrTruncated) return;
			this.stderr += typeof chunk === "string" ? chunk : chunk.toString();
			if (this.stderr.length > MAX_STDERR_BYTES) {
				this.stderr = `${this.stderr.slice(0, MAX_STDERR_BYTES)}\n[stderr truncated at ${MAX_STDERR_BYTES} bytes]`;
				this.stderrTruncated = true;
			}
		});

		// Exit / error / stdin-EPIPE race the qualifying agent_end (REQ-RPC-3).
		child.once("exit", (code, signal) => {
			this.exited = true;
			this.exitCode = code;
			this.signalCode = signal;
			this.onProcessGone();
		});
		child.once("error", (err) => {
			this.exited = true;
			if (!this.spawnError) {
				this.spawnError = err instanceof Error ? err.message : String(err);
			}
			this.onProcessGone();
		});
		this.stdin?.on("error", (err) => {
			// A write to a dead child surfaces here (EPIPE). Record it as a
			// transport error AND race it to terminal immediately (REQ-RPC-3): a
			// stdin EPIPE before any qualifying agent_end means the transport is
			// gone, so we must fail NOW rather than wait for the process-exit event
			// or the liveness ceiling. Idempotent: reachTerminal/onProcessGone
			// no-op once terminal is reached.
			if (!this.spawnError) {
				this.spawnError = err instanceof Error ? err.message : String(err);
			}
			this.transportGone = true;
			this.onProcessGone();
		});
	}

	/** Whether the child is mid-turn (between agent_start and agent_end). */
	get isStreaming(): boolean {
		return this.streaming;
	}

	/** The live child process (spec 0013 node B's facade hangs steer/cancel off this). */
	get childProcess(): ChildProcess {
		return this.child;
	}

	/**
	 * Send a raw RPC command on stdin (EPIPE-safe). Returns false if stdin is not
	 * writable (a dead/closed child) — NEVER throws, so a write to a dying child
	 * cannot reject the runner / orphan the detached process. Node B layers
	 * steer/follow_up/abort over this; node A only sends the initial prompt.
	 */
	send(command: Record<string, unknown>): boolean {
		const stdin = this.stdin;
		if (!stdin || stdin.destroyed || !stdin.writable) return false;
		try {
			stdin.write(serializeJsonLine(command));
			return true;
		} catch {
			// EPIPE / closed pipe — best-effort; the exit race owns the terminal.
			return false;
		}
	}

	/**
	 * Interrupt the agent MID-RUN with a steer (spec 0013 node B, REQ-RPC-7).
	 * Maps to pi's `{type:'steer', message}` RPC command — the same verb
	 * `AgentSession.steer()` drives in-process. EPIPE-safe (delegates to
	 * `send`): returns false on a dead/closed stdin, NEVER throws. The caller
	 * (the SteerableSession facade) gates this on `isStreaming` so a steer is
	 * only written while a turn is actually in flight to interrupt.
	 */
	steer(message: string): boolean {
		return this.send({ type: "steer", message });
	}

	/**
	 * Queue a follow-up delivered AFTER the agent finishes its current work
	 * (REQ-RPC-7). Maps to pi's `{type:'follow_up', message}`. EPIPE-safe. Note
	 * the facade does NOT promote an idle steer to a follow_up — an idle
	 * follow_up only enqueues without a trigger and is lost; this is the
	 * explicit follow_up path the control consumer uses for genuine queuing.
	 */
	followUp(message: string): boolean {
		return this.send({ type: "follow_up", message });
	}

	/**
	 * Write the in-protocol `{type:'abort'}` graceful-stop command (REQ-RPC-7,
	 * the FIRST half of the double-path abort). EPIPE-safe (delegates to
	 * `send`): returns false on a dead/closed stdin, NEVER throws — so a write to
	 * a dying child cannot reject the runner / orphan the detached process. The
	 * SteerableSession facade calls this THEN falls through to the bounded
	 * SIGTERM→SIGKILL signal backstop regardless of the return value.
	 */
	abort(): boolean {
		this.callerAbortRequested = true;
		return this.send({ type: "abort" });
	}

	/** Send the initial `{type:'prompt'}` ONCE to start the run (REQ-RPC-2). */
	start(task: string): void {
		if (this.started) return;
		this.started = true;
		this.armLiveness();
		this.send({ type: "prompt", message: task });
	}

	/**
	 * Resolve when the run reaches a qualifying terminal, having torn the child
	 * down first (REQ-RPC-6). Idempotent: subsequent calls return the same
	 * promise.
	 */
	waitForTerminal(): Promise<RpcDriveResult> {
		// Idempotent: cache the promise so repeated calls return the SAME one
		// (and don't clobber `resolveTerminal`).
		if (this.terminalPromise) return this.terminalPromise;
		this.terminalPromise = new Promise<RpcDriveResult>((resolve) => {
			this.resolveTerminal = resolve;
			// If the process is already gone OR the transport died (raced before
			// this was called), settle immediately (REQ-RPC-3 EPIPE/exit race).
			if ((this.exited || this.transportGone) && !this.terminalReached) {
				this.reachTerminal("process_exit");
			}
		});
		return this.terminalPromise;
	}

	// ── Internal: line handling ──

	/**
	 * Bounded `outcome.rawLines` append (MR !2 review finding #4): a child
	 * emitting unbounded unparseable output (corrupted stream, accidental
	 * non-JSONL logging) must not grow the array for the whole run. Keeps the
	 * first MAX_RAW_LINES + one truncation marker, then drops.
	 */
	private pushRawLine(line: string): void {
		if (this.outcome.rawLines.length > MAX_RAW_LINES) return;
		if (this.outcome.rawLines.length === MAX_RAW_LINES) {
			this.outcome.rawLines.push(`[rawLines truncated at ${MAX_RAW_LINES} lines]`);
			return;
		}
		this.outcome.rawLines.push(line);
	}

	private handleLine(line: string): void {
		// ANY observed line is liveness — reset the ceiling (REQ-RPC-10): a
		// long-but-emitting turn must NOT be killed.
		this.armLiveness();

		const trimmed = line.trim();
		if (!trimmed) return;

		let ev: PiRpcLine;
		try {
			ev = JSON.parse(trimmed) as PiRpcLine;
		} catch {
			this.pushRawLine(trimmed);
			return;
		}
		if (!ev || typeof ev !== "object" || typeof ev.type !== "string") {
			this.pushRawLine(trimmed);
			return;
		}

		switch (ev.type) {
			case "agent_start":
				this.streaming = true;
				this.currentTurnMessages = [];
				return;
			case "tool_execution_start":
				if (typeof ev.toolName === "string") {
					this.outcome.toolStarts.push(ev.toolName);
				}
				return;
			case "tool_execution_end":
				// Harvest the work boundary, not only a tool's optional terminate
				// declaration. A finalized tool may end the hosted turn without
				// carrying `terminate:true`.
				this.runEndingToolObserved = true;
				if (typeof ev.result === "object" && ev.result !== null &&
					(ev.result as { terminate?: unknown }).terminate === true) {
					this.runEndingToolDeclared = true;
				}
				return;
			case "message_end":
				this.onMessageEnd(ev.message);
				return;
			case "agent_end":
				this.onAgentEnd(ev);
				return;
			case "extension_ui_request":
				this.onExtensionUiRequest(ev);
				return;
			default:
				// response acks (`{type:'response',command,success}`),
				// message_update, queue_update, etc. — ignored for terminal
				// detection; text is accumulated from message_end.
				return;
		}
	}

	/** Collect one request-scoped message_end carrier and account for it once. */
	private onMessageEnd(message: PiMessage | undefined): void {
		if (!message || !isHarvestRole(message)) return;
		if (message.role === "user") {
			// A later genuine request opens a new authoritative window. Tool or
			// incomplete-work evidence from the prior window must not trigger a
			// continuation for this unanswered request.
			this.runEndingToolObserved = false;
			this.runEndingToolDeclared = false;
		}
		this.harvestMessages.push(message);
		this.currentTurnMessages.push(message);
		this.recordAssistantMessage(message);
	}

	private recordAssistantMessage(message: PiMessage): void {
		if (message.role !== "assistant") return;
		const text = extractTextFromContent(message.content);
		if (text) this.outcome.finalText = text;
		if (message.errorMessage) this.outcome.assistantError = message.errorMessage;
		const u = message.usage;
		if (!u) return;
		this.outcome.usage.turns++;
		this.outcome.usage.input = saturatingAdd(this.outcome.usage.input, u.input ?? u.inputTokens ?? 0);
		this.outcome.usage.output = saturatingAdd(this.outcome.usage.output, u.output ?? u.outputTokens ?? 0);
		const cacheRead = u.cacheRead ?? u.cacheReadTokens ?? 0;
		const cacheWrite = u.cacheWrite ?? u.cacheWriteTokens ?? 0;
		if (cacheRead) this.outcome.usage.cacheRead = saturatingAdd(this.outcome.usage.cacheRead ?? 0, cacheRead);
		if (cacheWrite) this.outcome.usage.cacheWrite = saturatingAdd(this.outcome.usage.cacheWrite ?? 0, cacheWrite);
		this.outcome.usage.cost = saturatingAdd(this.outcome.usage.cost, u.cost?.total ?? 0);
	}

	/** Add agent_end carrier messages not already delivered through message_end. */
	private collectAgentEndMessages(messages: readonly PiMessage[]): void {
		const unmatchedMessageEnds = [...this.currentTurnMessages];
		for (const message of messages) {
			if (!isHarvestRole(message)) continue;
			const duplicateIndex = unmatchedMessageEnds.findIndex((seen) =>
				sameHarvestMessage(seen, message)
			);
			if (duplicateIndex >= 0) {
				unmatchedMessageEnds.splice(duplicateIndex, 1);
				continue;
			}
			this.harvestMessages.push(message);
			this.recordAssistantMessage(message);
		}
	}

	/**
	 * Handle an `agent_end`. willRetry===true means pi will start ANOTHER turn —
	 * IGNORE it (REQ-RPC-3); only `willRetry===false` qualifies as terminal. On a
	 * qualifying end, apply the clean-stop predicate to the terminating assistant
	 * message (the spec-0007 REQ-PICLI-4 logic, preserved) and reach terminal.
	 */
	private onAgentEnd(ev: PiRpcLine): void {
		this.streaming = false;

		// Terminal ONLY on a strict `willRetry === false` (REQ-RPC-3, stricter than
		// pi's own RpcClient which ignores willRetry). willRetry:true means another
		// turn is coming; a MISSING/undefined willRetry is a protocol-shape anomaly
		// (pi always stamps it, agent-session.ts:503) — treat it as non-terminal
		// rather than risk an early resolve on a malformed/older-pi event.
		if (ev.willRetry !== false) return;

		const messages = Array.isArray(ev.messages) ? ev.messages : [];
		this.collectAgentEndMessages(messages);
		let terminatingAssistant: PiMessage | undefined;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i]?.role === "assistant") {
				terminatingAssistant = messages[i];
				break;
			}
		}
		terminatingAssistant ??= latestAssistantInAuthoritativeWindow(this.harvestMessages);

		const harvest = classifyHarvestOutcome(this.harvestMessages);
		const lastAssistantStopReason = typeof terminatingAssistant?.stopReason === "string"
			? terminatingAssistant.stopReason
			: undefined;
		if (
			!this.callerAbortRequested &&
			shouldAttemptHarvestContinuation(
				harvest,
				{
					runEndingToolObserved: this.runEndingToolObserved,
					...(this.runEndingToolDeclared ? { runEndingToolDeclared: true } : {}),
					settled: true,
					...(lastAssistantStopReason ? { lastAssistantStopReason } : {}),
					hasUserMessage: this.harvestMessages.some((message) => message.role === "user"),
				},
				this.continuationAttempts,
			)
		) {
			this.continuationAttempts += 1;
			this.runEndingToolObserved = false;
			this.currentTurnMessages = [];
			if (!this.send({ type: "prompt", message: RUN_ENDING_CONTINUATION_PROMPT })) {
				this.transportGone = true;
				this.spawnError ??= "failed to write harvest continuation prompt";
				this.reachTerminal("process_exit");
				return;
			}
			this.armLiveness();
			return;
		}

		const terminatingText = terminatingAssistant
			? extractTextFromContent(terminatingAssistant.content)
			: "";
		const isCleanStop = terminatingAssistant?.stopReason === "stop" &&
			!terminatingAssistant.errorMessage &&
			!hasToolCall(terminatingAssistant.content);
		this.outcome.cleanStop = isCleanStop;
		this.outcome.cleanStopText = undefined;
		this.outcome.assistantError = harvest.kind === "failure" ? harvest.error : undefined;
		if (harvest.kind === "substantive") {
			this.outcome.finalText = harvest.text;
			if (isCleanStop && terminatingText.trim()) {
				this.outcome.cleanStopText = harvest.text;
			}
		} else if (terminatingText) {
			this.outcome.finalText = terminatingText;
		}

		this.reachTerminal("agent_end");
	}

	/**
	 * Reply to a BLOCKING `extension_ui_request` with the non-interactive default
	 * (REQ-RPC-5), keyed by `id`. Fire-and-forget methods get NO reply.
	 *   - confirm                  → {confirmed:false}
	 *   - select | input | editor  → {cancelled:true}
	 */
	private onExtensionUiRequest(ev: PiRpcLine): void {
		const { id, method } = ev;
		if (typeof id !== "string" || typeof method !== "string") return;
		if (!BLOCKING_UI_METHODS.has(method)) return; // fire-and-forget → no reply
		if (method === "confirm") {
			this.send({ type: "extension_ui_response", id, confirmed: false });
		} else {
			this.send({ type: "extension_ui_response", id, cancelled: true });
		}
	}

	// ── Internal: liveness + terminal + teardown ──

	/** (Re)arm the liveness ceiling. Cleared on terminal. Unref'd. */
	private armLiveness(): void {
		if (this.terminalReached) return;
		if (this.livenessTimer) clearTimeout(this.livenessTimer);
		this.livenessTimer = setTimeout(() => {
			// Fire ONLY if the process is still alive (a dead process is owned by
			// the exit race, not the stall path).
			if (this.terminalReached || this.exited) return;
			this.reachTerminal("stalled");
		}, this.opts.livenessCeilingMs);
		if (typeof this.livenessTimer.unref === "function") {
			this.livenessTimer.unref();
		}
	}

	/** Process exit/error fired — race the qualifying agent_end (REQ-RPC-3). */
	private onProcessGone(): void {
		if (this.terminalReached) return;
		// Only settle here if `waitForTerminal()` has a resolver waiting; if it
		// has not been called yet, `waitForTerminal` itself settles on the
		// already-exited flag.
		if (this.resolveTerminal) this.reachTerminal("process_exit");
	}

	/**
	 * Reach the terminal: classify, tear the child down (end stdin → bounded
	 * SIGTERM → SIGKILL), THEN resolve. Idempotent.
	 */
	private reachTerminal(reason: RpcTerminalReason): void {
		if (this.terminalReached) return;
		this.terminalReached = true;
		if (this.livenessTimer) {
			clearTimeout(this.livenessTimer);
			this.livenessTimer = null;
		}

		const terminal = classifyRpcTerminal({
			outcome: this.outcome,
			reason,
			exitCode: this.exitCode,
			stderr: this.stderr,
			childlogPath: this.opts.childlogPath,
		});

		// Tear the child down BEFORE resolving (REQ-RPC-6): RPC never self-exits,
		// so the runner must end stdin → bounded SIGTERM → SIGKILL. A child that
		// already exited skips straight to resolve. Teardown is best-effort and
		// must never throw into the resolve path.
		this.teardown(() => {
			const result: RpcDriveResult = {
				terminal,
				reason,
				outcome: this.outcome,
				exitCode: this.exitCode,
				stderr: this.stderr,
				...(this.spawnError ? { spawnError: this.spawnError } : {}),
			};
			const resolve = this.resolveTerminal;
			this.resolveTerminal = null;
			resolve?.(result);
		});
	}

	/**
	 * Tear the child down: end stdin (signals the child to shut down — its stdin
	 * `end` triggers a graceful exit per rpc-mode.ts), then a bounded
	 * SIGTERM→SIGKILL backstop if it has not exited. Stops draining stdout only
	 * AFTER the child is gone. Calls `done` once teardown is initiated (it does
	 * not block on the child actually dying — the SIGKILL backstop is unref'd).
	 */
	private teardown(done: () => void): void {
		// Stop nothing yet: keep draining stdout until the child is gone.
		if (this.exited) {
			this.detachStdout?.();
			this.detachStdout = null;
			done();
			return;
		}

		// End stdin to ask the child to shut down gracefully.
		try {
			if (this.stdin && this.stdin.writable && !this.stdin.destroyed) {
				this.stdin.end();
			}
		} catch {
			/* best-effort */
		}

		// `finalize` is the SINGLE resolve path: detach stdout, clear the backstop
		// timer, and call `done` EXACTLY ONCE. The lifecycle promise resolves ONLY
		// after the child has actually exited (or been SIGKILLed) — NOT eagerly
		// after merely sending SIGTERM. This is the REQ-RPC-6 fix: the prior code
		// called `done()` immediately + unref'd the SIGKILL timer, so `main()`'s
		// `process.exit()` could fire before the backstop ran, orphaning a child
		// that ignores SIGTERM / stdin-end.
		let finalized = false;
		let killTimer: ReturnType<typeof setTimeout> | null = null;
		const finalize = () => {
			if (finalized) return;
			finalized = true;
			if (killTimer) {
				clearTimeout(killTimer);
				killTimer = null;
			}
			this.detachStdout?.();
			this.detachStdout = null;
			done();
		};

		if (this.hasExited()) {
			finalize();
			return;
		}

		// SIGTERM, then a bounded SIGKILL backstop. We RESOLVE ONLY after the child
		// is actually gone (the `exit` listener or the SIGKILL backstop calls
		// `finalize`). The timer is deliberately NOT unref'd — it must keep the
		// runner process alive until the child is reaped, so the backstop is
		// guaranteed to run before `main()` exits.
		try {
			this.child.kill("SIGTERM");
		} catch {
			/* best-effort */
		}
		killTimer = setTimeout(() => {
			if (!this.hasExited()) {
				try {
					this.child.kill("SIGKILL");
				} catch {
					/* best-effort */
				}
			}
			finalize();
		}, this.opts.sigkillBackstopMs);

		// Finalize promptly if the child exits before the backstop fires.
		this.child.once("exit", finalize);
	}

	/**
	 * REAL exit detection: Node sets `child.killed=true` when a signal is SENT,
	 * NOT when the process exits. The sound "has it exited?" signal is
	 * `exitCode !== null || signalCode != null` (a real ChildProcess sets one on
	 * close). Mirrors the spec-0007-B `hasExited()` gate.
	 */
	private hasExited(): boolean {
		return (
			this.exited ||
			this.child.exitCode !== null ||
			this.child.signalCode != null
		);
	}
}
