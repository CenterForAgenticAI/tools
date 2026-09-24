import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const rememberedSessionKeys = new WeakMap<object, string>();

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** True only for the invalidation errors Pi raises after disposing an extension context. */
export function isCtxInvalidationError(error: unknown): boolean {
	const message = errorMessage(error);
	return message === "stale"
		|| /extension\s+(?:ctx|context).*(?:stale|invalidat|dispos)/iu.test(message)
		|| /session\s+(?:replacement|reload).*(?:stale|invalidat|dispos)/iu.test(message);
}

function recordUnexpectedError(label: string, error: unknown): void {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
	const detail = error instanceof Error
		? `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`
		: String(error);
	try {
		fs.appendFileSync(
			path.join(agentDir, "context-aware-debug.log"),
			`[${new Date().toISOString()}] ${label}: ${detail}\n`,
		);
	} catch {
		// Diagnostics are best effort and must not make a liveness probe throw.
	}
}

/**
 * Probe a captured context without allowing an invalidation exception to
 * escape. Pi guards context methods with its active-session assertion.
 */
export function isCtxUsable(ctx: ExtensionContext): boolean {
	try {
		ctx.isIdle();
		return true;
	} catch (error) {
		if (!isCtxInvalidationError(error)) recordUnexpectedError("ctx liveness probe failed", error);
		return false;
	}
}

/**
 * Whether an agent loop currently holds its own copy of the message array.
 *
 * Pi's `ctx.signal` is the active run's abort signal and is `undefined` between
 * runs, so it — not `isIdle()` — is the seam that matters for a compaction
 * commit: `isIdle()` is also false in the benign window where Pi runs its own
 * automatic compaction after a run ended, and where the next continuation takes
 * a fresh snapshot anyway.
 *
 * `null` means the host does not expose run liveness at all.
 */
export function readRunInFlight(ctx: ExtensionContext): boolean | null {
	if (!isCtxUsable(ctx)) return null;
	if (!("signal" in (ctx as unknown as object))) return null;
	try {
		return ctx.signal !== undefined;
	} catch (error) {
		if (isCtxInvalidationError(error)) return null;
		recordUnexpectedError("ctx run-liveness probe failed", error);
		return null;
	}
}

function rememberedKey(ctx: ExtensionContext): string | undefined {
	return rememberedSessionKeys.get(ctx as unknown as object);
}

/**
 * Resolve a session metadata key while remembering the last successful result
 * for this exact context object. A disposed context can therefore clean up its
 * own state without borrowing a key from another session; if that context was
 * never resolved successfully, the empty string prevents cross-session cleanup.
 */
export function sessionMetadataKey(
	ctx: ExtensionContext | null | undefined,
	fallbackKey?: string,
): string {
	if (!ctx) return fallbackKey ?? "";
	const prior = rememberedKey(ctx);
	if (!isCtxUsable(ctx)) return prior ?? fallbackKey ?? "";
	try {
		const sessionManager = ctx.sessionManager;
		const sessionId = sessionManager.getSessionId();
		const resolved = sessionId || sessionManager.getSessionFile() || ctx.cwd;
		if (typeof resolved !== "string" || resolved.length === 0) return prior ?? fallbackKey ?? "";
		rememberedSessionKeys.set(ctx as unknown as object, resolved);
		return resolved;
	} catch (error) {
		if (!isCtxInvalidationError(error)) throw error;
		return prior ?? fallbackKey ?? "";
	}
}

/** Read the Pi UI expansion state, preserving the existing missing-method fallback. */
export function readToolsExpanded(ctx: ExtensionContext): boolean {
	if (!isCtxUsable(ctx)) return false;
	try {
		const ui = ctx.ui as unknown as { getToolsExpanded?: () => boolean };
		return typeof ui.getToolsExpanded === "function" ? ui.getToolsExpanded() === true : false;
	} catch (error) {
		if (isCtxInvalidationError(error)) return false;
		throw error;
	}
}

/** Run a callback only while its captured context remains usable. */
export function withLiveCtx<T>(ctx: ExtensionContext, label: string, fn: () => T): T {
	if (!isCtxUsable(ctx)) return undefined as T;
	try {
		return fn();
	} catch (error) {
		if (isCtxInvalidationError(error)) return undefined as T;
		// Keep unrelated implementation errors visible; the caller's existing
		// error boundary records them too, while this preserves the label here.
		recordUnexpectedError(`${label} failed`, error);
		throw error;
	}
}
