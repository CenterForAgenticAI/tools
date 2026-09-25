/**
 * Shared best-effort diagnostics logger for the delegate extension (spec 0017,
 * REQ-CONLOG-1..4).
 *
 * ## Why
 *
 * Delegate accumulated 16 ungated `console.log/warn(`[delegate] ...`)` calls —
 * dispatch lifecycle, persistence failures, per-run tool-surface diagnostics,
 * config warnings — all writing straight to stdout/stderr. In a pi TUI those
 * raw console calls are captured into the user-facing stream and flash on every
 * dispatch / run. None of them is intentional user-facing UI (the real
 * user-facing surfaces are `api.notify`, the status widget, and the collapsed
 * run result), so they are pure noise by default.
 *
 * Spec 0010 already established the RIGHT pattern in `logBusDiagnostic`
 * (src/event-bus.ts): write the message to a best-effort diagnostics FILE log
 * by default, and echo to the console ONLY when `PI_DELEGATE_DEBUG === "1"`.
 * This module GENERALIZES that single-site pattern into one shared logger that
 * both the event-bus warn and the 16 general sites route through — so the file
 * is the default sink and the console is strictly opt-in.
 *
 * ## Design (locked by spec-0017 design review)
 *
 * - **`agentDir` is explicit when the caller has it** — callers pass the
 *   directory they already resolved, avoiding ambient-state drift. The
 *   environment-derived `getAgentDir()` fallback remains only for the
 *   context-free call sites enumerated below.
 * - **File-by-default, console opt-in** — the line is always appended to the
 *   diagnostics file; it is echoed to `console.log` / `console.warn` (per the
 *   `level`) ONLY when `process.env.PI_DELEGATE_DEBUG === "1"` (strict `===`,
 *   per 0010 REQ-BUSWARN-2, so a stray truthy value can't re-leak).
 * - **Per-KEY throttle, one-shots UNthrottled** — `logDelegateDiagnostic(msg)`
 *   with no `throttleKey` is never throttled (each one-shot lifecycle message is
 *   a discrete event; the file is bounded by the size-cap-reset, not by time).
 *   A `throttleKey` opts into a per-key 60s window (a `Map<key, lastAt>`, NOT a
 *   single global var — a single global would let a per-dispatch message starve
 *   an unrelated warning landing within 60s, strictly WORSE than today).
 * - **Best-effort / never-throw** — every IO step is wrapped so a write failure
 *   can NEVER propagate into dispatch/run execution (0010 REQ-BUSWARN-3).
 * - **Size-cap-reset** — the diagnostics file sits at the `event-bus/` ROOT (a
 *   FILE, exempt from the directory sweep), so it is explicitly capped: reset to
 *   empty before an append once it exceeds `DIAGNOSTICS_LOG_MAX_BYTES`.
 *
 * ## Leaf module
 *
 * This module depends ONLY on `node:fs` / `node:path` + pi-core `getAgentDir()`.
 * `event-bus.ts` imports IT (its `logBusDiagnostic` becomes a thin caller), not
 * vice-versa — no circular import.
 *
 * ## Sink layout
 *
 *   <agentDir>/extensions/pi-delegate/event-bus/diagnostics.log
 *
 * One shared file for all delegate diagnostics (event-bus warns + the 16
 * general sites). It is the SAME file 0010 already writes to, so the existing
 * event-bus diagnostics tests keep passing unchanged. Concurrent appends from
 * sibling runs race best-effort (acceptable: the log is a diagnostic aid, not
 * a transactional record).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Per-key throttle window. A keyed diagnostic re-emits at most once per window. */
const THROTTLE_MS = 60_000;
/** Reset the diagnostics log when it exceeds this size (size-cap-reset). */
const DIAGNOSTICS_LOG_MAX_BYTES = 1024 * 1024;

/**
 * Per-key last-emit timestamps. NO entry = the key has never emitted (or was
 * reset). A single shared Map keyed by `throttleKey` keeps each spammy channel
 * (bus-warn / control-inbox / tool-surface) on its OWN 60s window so they never
 * starve each other.
 */
const lastEmitByKey = new Map<string, number>();

/**
 * Resolve the shared diagnostics log file under a given agent dir. Kept here
 * (NOT imported from event-bus) so this module stays a leaf. The file sits at
 * the `event-bus/` ROOT — a sibling of the per-rootRunId sink DIRECTORIES — so
 * it is exempt from the directory sweep and is the SAME file 0010 writes to.
 */
export function resolveDelegateDiagnosticsFile(agentDir: string): string {
	return path.join(agentDir, "extensions", "pi-delegate", "event-bus", "diagnostics.log");
}

/** Options for {@link logDelegateDiagnostic}. */
export interface DelegateDiagnosticOptions {
	/** Destination agent directory when the caller already has it. */
	agentDir?: string;
	/**
	 * When set, the message is throttled to one emit per {@link THROTTLE_MS}
	 * window PER KEY. When omitted, the message is a one-shot and is NEVER
	 * throttled. Use a key only for spammy channels (bus warn, per-run
	 * tool-surface diagnostics).
	 */
	throttleKey?: string;
	/** Console method to use for the opt-in echo. Defaults to `"warn"`. */
	level?: "log" | "warn";
}

/**
 * Best-effort append of a single diagnostic line to a resolved file, with the
 * size-cap-reset BEFORE the append so the sweep-exempt log can't grow unbounded.
 * Every IO step is swallowed — this can NEVER throw into the caller.
 */
function appendDiagnosticLine(file: string, line: string, now: number): void {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		try {
			if (fs.statSync(file).size > DIAGNOSTICS_LOG_MAX_BYTES) {
				fs.truncateSync(file, 0);
			}
		} catch {
			/* no existing file (or stat failed); nothing to truncate */
		}
		fs.appendFileSync(file, `${new Date(now).toISOString()} ${line}\n`, "utf-8");
	} catch {
		/* swallow; the diagnostics log is strictly best-effort (REQ-CONLOG-4) */
	}
}

/**
 * Shared core: emit one already-prefixed diagnostic line to an EXPLICIT file.
 * Applies the per-key throttle, the file append, and the strict-`=== "1"`
 * console echo. Both {@link logDelegateDiagnostic} (resolves the file from
 * its explicit option or documented fallback) and the event-bus `logBusDiagnostic` (threads its own
 * `agentDir`, preserving the 0010 test seam) call through here.
 *
 * @param file    resolved diagnostics-log path (empty string = skip the file
 *                write but still honor the throttle + console echo)
 * @param message the message WITHOUT the `[delegate] ` prefix (added here)
 */
export function emitDelegateDiagnosticToFile(
	file: string,
	message: string,
	opts: DelegateDiagnosticOptions = {},
): void {
	const { throttleKey, level = "warn" } = opts;
	const now = Date.now();
	if (throttleKey) {
		const last = lastEmitByKey.get(throttleKey) ?? 0;
		if (now - last < THROTTLE_MS) return;
		lastEmitByKey.set(throttleKey, now);
	}
	const testMarker = process.env.PI_DELEGATE_TEST_MARKER;
	const line = `[delegate] ${message}${testMarker ? ` testMarker=${testMarker}` : ""}`;
	if (file) {
		appendDiagnosticLine(file, line, now);
	}
	// Console echo (opt-in only). Strict `=== "1"` so a stray truthy value can't
	// re-expose the noise in the TUI (REQ-CONLOG-1, mirrors 0010 REQ-BUSWARN-2).
	if (process.env.PI_DELEGATE_DEBUG === "1") {
		if (level === "log") console.log(line);
		else console.warn(line);
	}
}

/**
 * Route a `[delegate]`-prefixed diagnostic through the shared file-logger
 * (spec 0017). Writes to the diagnostics file by default; echoes to the console
 * ONLY when `PI_DELEGATE_DEBUG === "1"`. When `opts.agentDir` is present it is
 * the destination; otherwise `getAgentDir()` supplies the best-effort fallback.
 * With no `throttleKey` the message is a
 * one-shot (never throttled); with a key it is throttled per-key to one emit
 * per 60s. NEVER throws into the caller.
 *
 * @param message the diagnostic text (the `[delegate] ` prefix is added; pass a
 *                channel sub-prefix yourself, e.g. `event-bus: ...`)
 */
export function logDelegateDiagnostic(message: string, opts: DelegateDiagnosticOptions = {}): void {
	let file = "";
	if (opts.agentDir) {
		file = resolveDelegateDiagnosticsFile(opts.agentDir);
	} else {
		// Environment-derived fallback is intentionally limited to these named
		// context-free entry points (each has no agentDir in hand):
		//   - config.ts: the process-global default configDiagnosticSink, used by
		//     parseConfigJson and warnRemovedPlaneConfigKey outside loadConfig
		//   - index.ts: containDispatchTail (its public signature has only runId,
		//     label, and fn); executeChainShape's and executeDirectShape's
		//     run-failure wake catches (the wake callback has no directory field);
		//     queueEscalationDelivery (the promise catch has no run context);
		//     queueEscalationService (the service options have only advance/label);
		//     executeSupervisedShape's synchronous lifecycle diagnostics (the
		//     lifecycle block predates destination capture); the supervised
		//     dispatch tail catch (the continuation captures only runId/owner);
		//     the runtime API completion callback (only runId/context are closed
		//     over); and startup reconciliation/recovery catches plus the startup
		//     retention sweep (session-level callbacks, not run-owned callbacks).
		//   - maintenance.ts: startPeriodicMaintenance's process-level tick
		//     callback; its options intentionally carry no agentDir
		//   - fork-runner.ts: resolveThinkingLevel, a pure helper whose signature
		//     is (raw, agentName); worker-channel.ts: resolveHeartbeatIntervalMs,
		//     a pure helper whose signature is (raw, clock). Neither is reachable
		//     from a run context (#306).
		//   - configured-package-roots.ts: its discovery-failure warn, whose
		//     `agentDir` option is itself optional (#306).
		// These are the only callers permitted to omit opts.agentDir.
		try {
			const agentDir = getAgentDir();
			if (agentDir) file = resolveDelegateDiagnosticsFile(agentDir);
		} catch {
			/* getAgentDir is best-effort; fall back to console-echo-only (file="") */
		}
	}
	emitDelegateDiagnosticToFile(file, message, opts);
}

/**
 * Test-only: clear ALL per-key throttle state so a test can assert a fresh
 * diagnostic. The diagnostics file itself is per-`agentDir` (the test's tmp dir
 * via `PI_CODING_AGENT_DIR`), so it needs no reset here.
 */
export function __resetDelegateDiagnosticsForTests(): void {
	lastEmitByKey.clear();
}
