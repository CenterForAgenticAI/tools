/**
 * The out-of-process strategy adapter (pi-context-aware#470, REQ-STRAT-005): a strategy in any language runs
 * in the bench as a program that reads one request line and writes one reply line (external-protocol.ts,
 * docs/strategy-protocol.md). Bench only: a live session runs only the built-in methods (src/strategy/methods.ts),
 * and every id this module gives starts with `external/`, which names no method.
 *
 * The program is hostile or careless until shown otherwise. Per request it is started without a shell,
 * with a fixed `PATH` as its whole environment (`STRATEGY_PATH`; nothing of the bench's own environment),
 * in a fresh empty directory that is removed afterwards, and with
 * the request on standard input as its only input. It is killed at the per-request timeout or once it
 * has written more than the reply cap, and its standard error is discarded. A refused reply is counted
 * under its code and the run goes on.
 *
 * One process per request: a strategy keeps no state between requests, so the same view always gets the
 * same plans, and no request can see another session.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { STRATEGY_CONTRACT_VERSION, type ContextPlan, type ContextView, type Stage } from "../../strategy/contract.js";
import { DEFAULT_EXTERNAL_LIMITS, EXTERNAL_PROTOCOL_VERSION, parseReply, requestLine, type ExternalLimits, type ExternalReply } from "./external-protocol.js";
import type { BenchRecipe, StrategySpec } from "./recipes.js";

/** How to start one external strategy. The bench's operator gives it; nothing from a session reaches it. */
export interface ExternalCommand {
	/** Names the strategy in the report as `external/<label>`. */
	readonly label: string;
	/** The program to run, started directly, never through a shell. */
	readonly file: string;
	/** Fixed arguments, such as a script for an interpreter. */
	readonly args?: readonly string[];
}

/** The id prefix of every external strategy: no built-in recipe id starts with it. */
export const EXTERNAL_ID_PREFIX = "external/";
/** An external strategy's id: `external/<label>`. */
export type ExternalRecipeId = `${typeof EXTERNAL_ID_PREFIX}${string}`;

const LABEL = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

/**
 * The strategy's whole environment: `PATH` set to the directory of the Node that runs the bench, then the
 * usual system directories, so a `#!/usr/bin/env node` or `python3` script starts. It is built here, not
 * copied: the bench's own `PATH` names directories under the operator's home.
 */
export const STRATEGY_PATH = [...new Set([path.dirname(process.execPath), "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"])].join(path.delimiter);

/** The id the bench gives an external strategy. Throws on a label that is not 1 to 64 lower-case letters, digits, `.`, `_` or `-`. */
export function externalStrategyId(label: string): ExternalRecipeId {
	if (!LABEL.test(label)) throw new RangeError(`an external strategy label is 1 to 64 lower-case letters, digits, ".", "_" or "-", starting with a letter or digit; got ${JSON.stringify(label.slice(0, 40).replace(/[^\x20-\x7e]/gu, "?"))}`);
	return `${EXTERNAL_ID_PREFIX}${label}`;
}

/** Run the strategy on one view and read its reply. Never throws for anything the strategy does. */
export function askExternal(command: ExternalCommand, view: ContextView, limits: ExternalLimits = DEFAULT_EXTERNAL_LIMITS): ExternalReply {
	const input = requestLine(view);
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-strategy-"));
	try {
		const result = spawnSync(command.file, [...(command.args ?? [])], {
			input,
			cwd,
			// Node adds NODE_V8_COVERAGE to this when the bench itself runs under coverage; nothing else is added.
			env: { PATH: STRATEGY_PATH },
			shell: false,
			stdio: ["pipe", "pipe", "ignore"],
			timeout: limits.timeoutMs,
			maxBuffer: limits.maxReplyBytes,
			killSignal: "SIGKILL",
			windowsHide: true,
		});
		const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
		if (code === "ETIMEDOUT") return { ok: false, code: "external-timeout", message: `The strategy did not answer within ${limits.timeoutMs} ms and was killed.` };
		if (code === "ENOBUFS") return { ok: false, code: "external-reply-too-large", message: `The strategy wrote more than ${limits.maxReplyBytes} bytes and was killed.` };
		if (result.error !== undefined && result.pid === 0) return { ok: false, code: "external-spawn-failed", message: "The strategy could not be started." };
		// A program that answers and exits without reading the whole request closes the pipe early, and Node
		// reports EPIPE writing the request. Its reply still counts when it exited with status 0.
		const unread = code === "EPIPE";
		if ((result.error !== undefined && !unread) || result.status !== 0) return { ok: false, code: "external-crash", message: `The strategy ended with ${result.signal === null ? `status ${String(result.status)}` : `signal ${result.signal}`}.` };
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
		} catch {
			return { ok: false, code: "external-malformed", message: "The reply is not UTF-8." };
		}
		return parseReply(text, view);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

/**
 * The bench recipe for one external strategy: one stage that asks the strategy once per request and
 * hands its plans to the runner one at a time, each checked on the view the one before left. The runner
 * takes every queued plan (`queuedPlans`): none is dropped after a plan that changes nothing.
 */
export function externalBenchRecipe(command: ExternalCommand, limits: ExternalLimits = DEFAULT_EXTERNAL_LIMITS): BenchRecipe {
	const id = externalStrategyId(command.label);
	let queue: ContextPlan[] = [];
	const refused: string[] = [];
	const stage: Stage = {
		id: "external",
		wants: (view) => {
			const reply = askExternal(command, view, limits);
			queue = reply.ok ? [...reply.plans] : [];
			if (!reply.ok) refused.push(reply.code);
			return queue.length > 0 ? "now" : null;
		},
		plan: () => queue.shift() ?? [],
		offers: [],
	};
	return {
		recipe: { id, contractVersion: STRATEGY_CONTRACT_VERSION, stages: [stage] },
		compactionStages: new Set(),
		takeRefusals: () => refused.splice(0),
		queuedPlans: (stageId) => (stageId === stage.id ? queue.length : undefined),
	};
}

/** The bench strategy for one external command. */
export function externalStrategy(command: ExternalCommand, limits: ExternalLimits = DEFAULT_EXTERNAL_LIMITS): StrategySpec {
	const id = externalStrategyId(command.label);
	return {
		id,
		recipe: id,
		mode: "external",
		params: { protocol: EXTERNAL_PROTOCOL_VERSION, timeoutMs: limits.timeoutMs, maxReplyBytes: limits.maxReplyBytes },
		build: () => externalBenchRecipe(command, limits),
	};
}
