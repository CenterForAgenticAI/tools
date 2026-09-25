/**
 * Phase 3c — worker-side UI context factories.
 *
 * The worker session is a regular `AgentSession`. When it runs with
 * `interactive: true` we route blocking UI prompts (command-guard, etc.)
 * to the delegate overlay by binding a custom `ExtensionUIContext`
 * whose `confirm/select/input` register a pending prompt in the runtime
 * and await its resolution. Everything else on the context is a no-op.
 *
 * When the run entry is NOT interactive we bind *no* uiContext at all — see
 * the call site in `fork-runner.ts` for the rationale. `buildNoUIContext`
 * below exists for parity and tests (it mirrors the in-pkg
 * `noOpUIContext` template), but it is deliberately never
 * `bindExtensions`'d because the ExtensionRunner's `hasUI()` check is
 * identity-based (`uiContext !== noOpUIContext`) and binding any other
 * object — even all-no-op — flips `ctx.hasUI` to true and defeats
 * command-guard's auto-deny.
 */

import type {
	ExtensionAPI,
	ExtensionUIContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	addPendingPrompt,
	capturePendingPromptAdmission,
	resolvePendingPrompt,
} from "./runtime.js";

/**
 * Default auto-deny for blocking worker prompts. 60 seconds matches the
 * spec; exposed for tests that want to shorten it.
 */
export const DEFAULT_WORKER_PROMPT_TIMEOUT_MS = 60_000;

/**
 * A minimally-valid stub `Theme` used by `buildNoUIContext()`. The real
 * `noOpUIContext` in pi-coding-agent pulls in the default theme module,
 * which isn't accessible from extension code, so we provide an identity
 * passthrough that's only useful for shape compatibility in tests.
 */
export const STUB_THEME: Theme = {
	fg: (_role: string, s: string) => s,
	bg: (_role: string, s: string) => s,
	bold: (s: string) => s,
	italic: (s: string) => s,
	dim: (s: string) => s,
	underline: (s: string) => s,
	inverse: (s: string) => s,
	strikethrough: (s: string) => s,
	hex: (_color: string, s: string) => s,
	hexBg: (_color: string, s: string) => s,
} as unknown as Theme;

/**
 * Mirrors `noOpUIContext` from pi-coding-agent's extensions/runner.js.
 * Returned object is a fresh instance every call — do **not** bind this
 * with `bindExtensions({ uiContext })`: binding any object other than
 * the package-private `noOpUIContext` makes `ctx.hasUI === true`, which
 * defeats command-guard's auto-deny for non-interactive run entries. Exported
 * so tests can assert the shape and so downstream code can reference a
 * canonical no-op implementation.
 */
export function buildNoUIContext(): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: () => {},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async () => undefined,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		setEditorComponent: () => {},
		get theme() {
			return STUB_THEME;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "UI not available" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	} as unknown as ExtensionUIContext;
}

export interface RoutedUIContextDeps {
	runId: string;
	forkName: string;
	/** Event emitter for `luthen.delegate.worker_notify`. Optional in tests. */
	pi?: Pick<ExtensionAPI, "events">;
	/** Override for unit tests; defaults to `DEFAULT_WORKER_PROMPT_TIMEOUT_MS`. */
	timeoutMs?: number;
	/**
	 * Optional gate consulted on every blocking call. When it returns
	 * false the call resolves with the default (confirm→false,
	 * select→undefined, input→undefined) without ever registering a
	 * pending prompt. Used by the overlay's `s` (skip-all) action:
	 * flipping `RunLiveState.interactive` to false mid-run-entry is
	 * best-effort, so this closure reads the live state each time.
	 */
	isInteractive?: () => boolean;
}

/**
 * Build a routed `ExtensionUIContext` for an interactive worker. The
 * three blocking methods (`confirm`, `select`, `input`) register a
 * pending prompt in the runtime and await its resolution; an auto-deny
 * timer races the user answer so the worker never hangs indefinitely.
 * `notify` emits `luthen.delegate.worker_notify` for the overlay
 * transcript. Every other method is a no-op — widgets, editor surface,
 * theme, etc. are main-agent concerns and must not leak into the worker.
 */
export function buildRoutedUIContext(deps: RoutedUIContextDeps): ExtensionUIContext {
	const timeoutMs = deps.timeoutMs ?? DEFAULT_WORKER_PROMPT_TIMEOUT_MS;
	const { runId, forkName, pi } = deps;
	const interactive = () => (deps.isInteractive ? deps.isInteractive() : true);
	const promptAdmission = capturePendingPromptAdmission(runId, forkName);

	const waitWithTimeout = <T>(
		pending: { id: string; promise: Promise<unknown> },
		fallback: T,
	): Promise<T> => {
		return new Promise<T>((resolve) => {
			const timer = setTimeout(() => {
				// Resolve through the runtime boundary so the pending entry and its
				// widget phase disappear in the same transition as the fallback.
				// A simultaneous user answer wins by removing the id first.
				if (!resolvePendingPrompt(runId, forkName, pending.id, fallback)) {
					resolve(fallback);
				}
			}, timeoutMs);
			(timer as unknown as { unref?: () => void }).unref?.();
			pending.promise.then(
				(value) => {
					clearTimeout(timer);
					resolve(value as T);
				},
				() => {
					clearTimeout(timer);
					resolve(fallback);
				},
			);
		});
	};

	const base = buildNoUIContext() as any;

	base.confirm = async (title: string, description?: string) => {
		if (!interactive()) return false;
		const pending = addPendingPrompt(runId, forkName, {
			kind: "confirm",
			title,
			description,
			defaultValue: false,
			timeoutMs,
		}, promptAdmission);
		return waitWithTimeout<boolean>(pending, false);
	};

	base.select = async (message: string, options: unknown) => {
		if (!interactive()) return undefined;
		// ExtensionUIContext.select accepts a rich options object; for the
		// overlay we only need string labels, so coerce whatever we get.
		const labels: string[] = Array.isArray(options)
			? options.map((o: any) => (typeof o === "string" ? o : (o?.label ?? String(o))))
			: [];
		const pending = addPendingPrompt(runId, forkName, {
			kind: "select",
			title: message,
			options: labels,
			defaultValue: undefined,
			timeoutMs,
		}, promptAdmission);
		return waitWithTimeout<string | undefined>(
			pending,
			undefined,
		);
	};

	base.input = async (prompt: string, _opts?: unknown) => {
		if (!interactive()) return undefined;
		const pending = addPendingPrompt(runId, forkName, {
			kind: "input",
			title: prompt,
			defaultValue: undefined,
			timeoutMs,
		}, promptAdmission);
		return waitWithTimeout<string | undefined>(
			pending,
			undefined,
		);
	};

	base.notify = (msg: string, kind?: "info" | "warning" | "error") => {
		try {
			pi?.events.emit("luthen.delegate.worker_notify", {
				runId,
				forkName,
				message: msg,
				kind: kind ?? "info",
			});
		} catch {
			/* emitter failures must not break worker tools. */
		}
	};

	return base as ExtensionUIContext;
}
