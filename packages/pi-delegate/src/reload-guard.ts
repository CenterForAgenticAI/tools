import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";
import {
	isLiveStatus,
	isOwnedByThisProcess,
	listActiveRuns,
	type RunLiveStatus,
} from "./runtime.js";

type EditorFactory = NonNullable<
	Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]
>;

export interface ReloadGuardRun {
	forks: Readonly<Record<string, { status: RunLiveStatus }>>;
}

export interface ReloadBlockerSummary {
	runCount: number;
	forkCount: number;
}

export interface ReloadGuardEditorOptions {
	getBlockers: () => ReloadBlockerSummary;
	notifyBlocked: (message: string) => void;
}

/** Count runs and delegate entries that are genuinely live according to the runtime's canonical predicate. */
export function summarizeReloadBlockers(
	runs: readonly ReloadGuardRun[],
): ReloadBlockerSummary {
	let runCount = 0;
	let entryCount = 0;
	for (const run of runs) {
		const liveEntries = Object.values(run.forks).filter((entry) => isLiveStatus(entry.status)).length;
		if (liveEntries === 0) continue;
		runCount += 1;
		entryCount += liveEntries;
	}
	return { runCount, forkCount: entryCount };
}

/** Return only this process' in-process runs; detached orchestrate children survive reload. */
export function getCurrentReloadBlockers(): ReloadBlockerSummary {
	return summarizeReloadBlockers(listActiveRuns().filter(isOwnedByThisProcess));
}

export function formatReloadBlockedMessage(summary: ReloadBlockerSummary): string {
	const entryNoun = summary.forkCount === 1 ? "entry is" : "entries are";
	const runNoun = summary.runCount === 1 ? "run" : "runs";
	const pronoun = summary.forkCount === 1 ? "it" : "them";
	return (
		`Reload blocked: ${summary.forkCount} delegate ${entryNoun} still in flight across ` +
		`${summary.runCount} ${runNoun}. Wait for ${pronoun} to finish or cancel ${pronoun} via ` +
		"/delegate-inspector, then retry."
	);
}

/**
 * Wrap any Pi editor component by guarding its submission callback.
 *
 * Pi wires the built-in submit handler after an editor factory returns. The
 * proxy therefore retains a guarded callback on the underlying editor while
 * capturing later `onSubmit` assignments as the downstream handler. This
 * covers Enter and Pi's direct submit paths without replacing the wrapped
 * editor's key handling, rendering, autocomplete, or app-action surface.
 */
export function createReloadGuardEditor(
	base: EditorComponent,
	options: ReloadGuardEditorOptions,
): EditorComponent {
	let downstreamSubmit = base.onSubmit;
	const guardedSubmit = (text: string): void => {
		if (text.trim() === "/reload") {
			const blockers = options.getBlockers();
			if (blockers.forkCount > 0) {
				options.notifyBlocked(formatReloadBlockedMessage(blockers));
				return;
			}
		}
		downstreamSubmit?.(text);
	};

	base.onSubmit = guardedSubmit;

	return new Proxy(base, {
		get(target, property) {
			if (property === "onSubmit") return guardedSubmit;
			const value = Reflect.get(target, property, target) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
		set(target, property, value) {
			if (property === "onSubmit") {
				downstreamSubmit = typeof value === "function" ? (value as (text: string) => void) : undefined;
				return true;
			}
			return Reflect.set(target, property, value, target);
		},
	});
}

/** Install the interactive-only workaround around the currently configured editor. */
export function installReloadGuard(
	ctx: ExtensionContext,
	getBlockers: () => ReloadBlockerSummary = getCurrentReloadBlockers,
): void {
	if (ctx.mode !== "tui") return;
	const previousFactory = ctx.ui.getEditorComponent();
	const guardedFactory: EditorFactory = (tui, theme, keybindings) => {
		const base = previousFactory?.(tui, theme, keybindings) ??
			new CustomEditor(tui, theme, keybindings);
		return createReloadGuardEditor(base, {
			getBlockers,
			notifyBlocked: (message) => ctx.ui.notify(message, "warning"),
		});
	};
	ctx.ui.setEditorComponent(guardedFactory);
}
