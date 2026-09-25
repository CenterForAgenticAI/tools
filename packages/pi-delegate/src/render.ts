/**
 * TUI rendering for the delegate tool call and result.
 */
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { normalizeDelegateParams } from "./delegate-normalize.js";
import type { RunResult } from "./fork-runner.js";
import { formatForkWarningLines } from "./fork-warnings.js";
import { renderPromptRepairReport } from "./prompt-repair-seam.js";
import {
	countProjectedActiveRuns,
	projectToRunStatus,
	type RunLiveStatus,
} from "./runtime.js";
import {
	getDelegatePresentationTerminology,
	type DelegatePresentationShape,
} from "./footer-presentation.js";

function fmt(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

function usageLine(r: RunResult, theme: any): string {
	const parts: string[] = [];
	if (r.roundsUsed) parts.push(`${r.roundsUsed}/${r.maxRounds} rounds`);
	const sIn = r.usage.supervisorInput;
	const sOut = r.usage.supervisorOutput;
	const wIn = r.usage.workerInput;
	const wOut = r.usage.workerOutput;
	if (sIn || sOut) parts.push(`sup ↑${fmt(sIn)}↓${fmt(sOut)}`);
	if (wIn || wOut) parts.push(`wk ↑${fmt(wIn)}↓${fmt(wOut)}`);
	if (r.usage.cost) parts.push(`$${r.usage.cost.toFixed(4)}`);
	return theme.fg("dim", parts.join(" "));
}

function statusIcon(status: RunLiveStatus, theme: any): string {
	switch (projectToRunStatus(status)) {
		case "completed":
			return theme.fg("success", "✓");
		case "failed":
			return theme.fg("error", "✗");
		case "aborted":
			return theme.fg("warning", "⊘");
		// Spec 0019 / REQ-PAUSE-4 — a paused run entry (supervisor forced to finish
		// at max_rounds) gets the DISTINCT non-green pause glyph, NEVER the
		// success ✓: it is parked mid-work, not done. Matches status-widget.ts.
		case "paused":
			return theme.fg("warning", "⏸");
		case "running":
		case "pending":
			return theme.fg("warning", "⏳");
	}
}

/**
 * Coerce a tool-arg value to an array, or report that it's malformed.
 *
 * Specifically guards against the Claude Opus 4.x failure mode where the
 * model emits an array tool-arg as a JSON-encoded *string* (see
 * `docs/string-encoded-args.md` and the Apr 2026 "1488 forks" incident).
 * The renderer used to do `args?.agents ?? []` and then iterate it, which
 * silently treated the string as character-iterable — `length` returned the
 * char count and each character became a `?` row in the panel.
 *
 * Behaviour:
 *   - Arrays are returned as-is.
 *   - `undefined` / `null` → empty array (the field wasn't supplied).
 *   - Strings → ONE `JSON.parse` rescue attempt; if that yields an array,
 *     return it. Otherwise return `{ malformed: "string" }` so callers can
 *     render a clear marker instead of leaking characters.
 *   - Anything else (number, object, boolean) → `{ malformed: typeof v }`.
 *
 * Exported for unit testing.
 *
 * NAMING NOTE (issue #10 nit): despite "coerce", this function only
 * VALIDATES/CLASSIFIES for preview rendering — it never mutates the call
 * args, and a string-encoded array is deliberately reported `malformed`
 * (see the renderer-policy comment below). The runtime recovery that
 * actually coerces lives in `coerceStringifiedArrayParams`.
 */
export function coerceArrayArg(
	v: unknown,
): { ok: true; value: any[] } | { ok: false; malformed: string } {
	if (Array.isArray(v)) return { ok: true, value: v };
	if (v == null) return { ok: true, value: [] };
	if (typeof v === "string") {
		// Renderer policy: even if the string JSON-parses to a valid array,
		// we still report it as malformed. Pi-ai's tool-arg validator will
		// reject the call regardless (the schema requires an array, not a
		// string), and showing a "successful" preview here would lie to
		// the user about what's about to happen. Runtime recovery for
		// direct callers lives in `coerceStringifiedArrayParams` instead.
		try {
			const parsed = JSON.parse(v);
			if (Array.isArray(parsed)) {
				return {
					ok: false,
					malformed: `string-encoded array (length ${parsed.length}, will fail validation)`,
				};
			}
			return { ok: false, malformed: `string-encoded ${typeof parsed}` };
		} catch {
			return { ok: false, malformed: "string (not JSON-parseable)" };
		}
	}
	return { ok: false, malformed: typeof v };
}

/**
 * Render a level-2 preview row for one mode entry. Defensive about all
 * fields so that even partially-streamed JSON (which is fed into the
 * renderer live by pi as the model emits the call) doesn't crash on
 * undefined `.agent` / `.task` lookups.
 */
function renderEntryRow(a: any, theme: any): string {
	const task = typeof a?.task === "string" ? a.task : "";
	const preview = task.length > 60 ? `${task.slice(0, 60)}…` : task;
	let label: string;
	if (a && typeof a === "object" && a.parallel) {
		const slotCount = Array.isArray(a.parallel) ? a.parallel.length : "?";
		label = `(parallel ×${slotCount})`;
	} else if (a?.name && a.name !== a.agent) {
		label = `${a.agent ?? "?"}:${a.name}`;
	} else {
		label = (typeof a?.agent === "string" && a.agent) || "?";
	}
	return `  ${theme.fg("accent", label)} ${theme.fg("dim", preview)}`;
}

interface DelegateCallRenderContext {
	argsComplete: boolean;
}

/**
 * The slice of pi's `Theme` the call preview actually uses.
 *
 * Structural on purpose: the surrounding helpers in this file predate it and
 * take `theme: any`, but new code here does not need to spend the repository's
 * lint-warning budget (`eslint-budget.json`) to say "an object with `fg` and
 * `bold`". Tests pass an identity or key-recording stub, which satisfies this.
 */
type CallTheme = {
	fg: (kind: string, text: string) => string;
	bold: (text: string) => string;
};

/**
 * Render every state that is NOT a recognized call shape.
 *
 * While pi is still streaming the args (`argsComplete: false`) all of them
 * are neutral: partial JSON is *supposed* to look incomplete, and a warning
 * that resolves itself one keystroke later is noise. Once the args are
 * complete, say what is actually wrong — `detail` is the whole parenthetical,
 * so callers choose between `malformed args — …`, `ambiguous args — …`, and
 * the generic marker.
 */
function renderInvalidCall(
	theme: CallTheme,
	context: DelegateCallRenderContext | undefined,
	detail?: string,
): Text {
	const title = theme.fg("toolTitle", theme.bold("delegate "));
	if (context?.argsComplete === false) {
		return new Text(title + theme.fg("muted", "preparing…"), 0, 0);
	}
	return new Text(title + theme.fg("warning", `(${detail ?? "incomplete/invalid args"})`), 0, 0);
}

function renderCountedEntries(
	shape: DelegatePresentationShape,
	items: unknown[],
	theme: CallTheme,
): Text {
	const terminology = getDelegatePresentationTerminology(shape);
	const noun = items.length === 1 ? terminology.singular : terminology.plural;
	let text =
		theme.fg("toolTitle", theme.bold("delegate ")) +
		theme.fg("accent", `${items.length} ${noun}`);
	for (const a of items.slice(0, 4)) {
		text += `\n${renderEntryRow(a, theme)}`;
	}
	if (items.length > 4) {
		text += `\n  ${theme.fg("muted", `… +${items.length - 4} more`)}`;
	}
	return new Text(text, 0, 0);
}

/** Element count when `value` is a JSON-encoded array string, else `null`. */
function stringifiedArrayLength(value: unknown): number | null {
	if (typeof value !== "string") return null;
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed.length : null;
	} catch {
		return null;
	}
}

export function renderDelegateCall(
	args: any,
	theme: any,
	context?: DelegateCallRenderContext,
) {
	// Management actions take precedence over every run selector, matching
	// detectShape(). Targets such as `agent` and `chainName` are management
	// payload in this mode, not competing worker selectors.
	if (typeof args?.action === "string" && args.action.length > 0) {
		const text =
			theme.fg("toolTitle", theme.bold("delegate ")) +
			theme.fg("accent", `management: ${args.action}`);
		return new Text(text, 0, 0);
	}

	// Render ingress (spec §4, consumer 3). Pi persists RAW tool-call arguments,
	// so a resumed session replays legacy shapes here. Normalizing first makes a
	// legacy call and its canonical equivalent render identically.
	//
	// This is best-effort by design: while arguments are still streaming the
	// object is incomplete, and the normalizer must never throw on the render
	// path. A failure falls through to the defensive raw rendering below, which
	// already handles malformed and partial input.
	//
	// Scope note: only the flat `{agent, task}` shape is normalized for
	// rendering. The other legacy selectors keep their existing dedicated
	// rendering because it is strictly more informative than the canonical
	// panel — it distinguishes a parallel chain layer ("1 step (parallel ×3)")
	// from three independent tasks, names colliding selectors, and reports a
	// string-encoded array as malformed rather than silently recovering it.
	// Normalizing those would trade real information for uniformity.
	//
	// Both fields must be present: pi streams arguments incrementally, and a
	// half-arrived `{agent}` must still render as "preparing…" rather than
	// asserting a dispatch that the model has not finished describing.
	let call = args;
	const legacySelector = ["agents", "tasks", "chain", "chainName", "orchestrate"]
		.some((key) => args?.[key] !== undefined);
	const completeDirect = typeof args?.agent === "string" && args.agent.length > 0
		&& typeof args?.task === "string" && args.task.length > 0;
	if (!Array.isArray(args?.runs) && !legacySelector && completeDirect) {
		try {
			const normalized = normalizeDelegateParams(args);
			if (Array.isArray((normalized as { runs?: unknown })?.runs)) call = normalized;
		} catch {
			// Keep the raw arguments; partial input renders on the legacy path.
		}
	}

	// Canonical calls render through the same concise entry panel. Legacy calls
	// remain on the defensive raw path so malformed streamed arrays are shown.
	if (Array.isArray(call?.runs)) return renderCanonicalRuns(call, theme, context);

	// Pi feeds raw arguments while they stream. Array fields must be validated
	// before reading length or iterating, so a string can never become a fake
	// entry count. A non-array string `chain` is the saved-chain
	// selector; JSON-encoded arrays retain the existing malformed warning.
	const chainJsonArrayLength = stringifiedArrayLength(args?.chain);
	const supervised = coerceArrayArg(args?.agents);
	const direct = coerceArrayArg(args?.tasks);
	const chain = typeof args?.chain === "string" && chainJsonArrayLength === null
		? { ok: true as const, value: [] }
		: coerceArrayArg(args?.chain);
	const malformed: Array<{ key: string; reason: string }> = [];
	if (supervised.ok === false) malformed.push({ key: "agents", reason: supervised.malformed });
	if (direct.ok === false) malformed.push({ key: "tasks", reason: direct.malformed });
	if (chain.ok === false) {
		// `coerceArrayArg` says "will fail validation", which is true for
		// `agents`/`tasks` (the schema demands an array) but NOT for `chain`:
		// the schema accepts a string there, and detectShape() reads it as a
		// saved-chain NAME. A JSON-encoded array would be looked up as an
		// absurd name, so name that specific mistake instead.
		malformed.push({
			key: "chain",
			reason: chainJsonArrayLength === null
				? chain.malformed
				: `JSON-encoded array (length ${chainJsonArrayLength}), not a saved-chain name`,
		});
	}
	if (malformed.length > 0) {
		return renderInvalidCall(
			theme,
			context,
			`malformed args — ${malformed.map((m) => `${m.key}: ${m.reason}`).join(", ")}`,
		);
	}

	const supervisedItems = supervised.ok ? supervised.value : [];
	const directItems = direct.ok ? direct.value : [];
	const chainItems = chain.ok ? chain.value : [];
	const hasAgents = Array.isArray(args?.agents);
	const hasTasks = Array.isArray(args?.tasks);
	const hasInlineChain = Array.isArray(args?.chain);
	const hasChainName = typeof args?.chainName === "string" && args.chainName.length > 0;
	const hasSavedChain = hasChainName || (
		typeof args?.chain === "string" &&
		args.chain.length > 0 &&
		chainJsonArrayLength === null
	);
	const hasOrchestrate = args?.orchestrate !== null &&
		typeof args?.orchestrate === "object" &&
		!Array.isArray(args.orchestrate);
	// Deliberately stricter than the other selectors: this mirrors the
	// executor's own rule (src/index.ts requires both fields non-blank), and
	// an orchestrate object arrives whole rather than growing row by row. The
	// array modes stay shallow on purpose — an entry missing `agent` mid-stream
	// is normal, and `renderEntryRow` already shows it as `?`. Do not
	// "harmonize" these two by validating array entries here.
	const hasValidOrchestrate = hasOrchestrate &&
		typeof args.orchestrate.agent === "string" &&
		args.orchestrate.agent.trim() !== "" &&
		typeof args.orchestrate.task === "string" &&
		args.orchestrate.task.trim() !== "";
	const hasSingleDirect = typeof args?.agent === "string" && typeof args?.task === "string";
	// Named, not just counted: detectShape() distinguishes `unknown` from
	// `ambiguous`, so the preview should too — "which two selectors collided"
	// is the whole useful content of that error.
	const selectors = [
		hasAgents ? "agents" : "",
		hasTasks ? "tasks" : "",
		hasInlineChain ? "chain" : "",
		hasSavedChain ? (hasChainName ? "chainName" : "chain") : "",
		hasOrchestrate ? "orchestrate" : "",
		hasSingleDirect ? "agent+task" : "",
	].filter((key) => key !== "");

	if (selectors.length > 1) {
		return renderInvalidCall(theme, context, `ambiguous args — ${selectors.join(" + ")}`);
	}
	if (selectors.length === 0) return renderInvalidCall(theme, context);
	if (hasOrchestrate && !hasValidOrchestrate) return renderInvalidCall(theme, context);
	if (hasAgents) return supervisedItems.length > 0
		? renderCountedEntries("supervised", supervisedItems, theme)
		: renderInvalidCall(theme, context);
	if (hasTasks) return directItems.length > 0
		? renderCountedEntries("direct", directItems, theme)
		: renderInvalidCall(theme, context);
	if (hasInlineChain) return chainItems.length > 0
		? renderCountedEntries("chain", chainItems, theme)
		: renderInvalidCall(theme, context);
	if (hasSavedChain) {
		const name = hasChainName ? args.chainName : args.chain;
		const text =
			theme.fg("toolTitle", theme.bold("delegate ")) +
			theme.fg("accent", `saved chain: ${name}`);
		return new Text(text, 0, 0);
	}
	if (hasOrchestrate) {
		const driver = typeof args.orchestrate.agent === "string" && args.orchestrate.agent.length > 0
			? `: ${args.orchestrate.agent}`
			: "";
		const text =
			theme.fg("toolTitle", theme.bold("delegate ")) +
			theme.fg("accent", `driver${driver}`);
		return new Text(text, 0, 0);
	}

	const preview = args.task.length > 60 ? `${args.task.slice(0, 60)}…` : args.task;
	const text =
		theme.fg("toolTitle", theme.bold("delegate ")) +
		theme.fg("accent", `direct: ${args.agent}`) +
		(preview ? ` ${theme.fg("dim", preview)}` : "");
	return new Text(text, 0, 0);
}

/** A run entry as it arrives from raw persisted arguments: shape not yet proven. */
type RawRun = { mode?: unknown; after?: unknown; agent?: unknown; task?: unknown } | undefined;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches renderDelegateCall's provider-args signature
function renderCanonicalRuns(args: any, theme: any, context?: DelegateCallRenderContext) {
	const runs: RawRun[] = Array.isArray(args.runs) ? args.runs : [];
	if (runs.length === 0) return renderInvalidCall(theme, context);
	const modes = new Set(runs.map((run) => run?.mode ?? "solo"));
	if (modes.size !== 1) return renderCountedEntries("unknown", runs, theme);
	const [mode] = modes;
	if (mode === "driver") {
		if (runs.length !== 1) return renderCountedEntries("unknown", runs, theme);
		const driver = runs[0];
		const label = typeof driver?.agent === "string" && driver.agent ? `: ${driver.agent}` : "";
		return new Text(theme.fg("toolTitle", theme.bold("delegate ")) + theme.fg("accent", `driver${label}`), 0, 0);
	}
	if (mode !== "solo" && mode !== "supervised") {
		return renderCountedEntries("unknown", runs, theme);
	}
	if (modes.has("supervised")) return renderCountedEntries("supervised", runs, theme);
	if (runs.some((run) => run?.after !== undefined)) return renderCountedEntries("chain", runs, theme);
	if (runs.length === 1) {
		const run = runs[0] ?? {};
		const agent = typeof run.agent === "string" ? run.agent : "?";
		const task = typeof run.task === "string" ? run.task : "";
		const preview = task.length > 60 ? `${task.slice(0, 60)}…` : task;
		return new Text(theme.fg("toolTitle", theme.bold("delegate ")) + theme.fg("accent", `direct: ${agent}`) + (preview ? ` ${theme.fg("dim", preview)}` : ""), 0, 0);
	}
	return renderCountedEntries("direct", runs, theme);
}

function resultShape(details: { shape?: unknown }): DelegatePresentationShape {
	// Result presentation trusts only the additive shape field. Legacy `mode`
	// remains on result details for compatibility, but it is not shape metadata:
	// hydrated or older results without an explicit shape stay neutral.
	return details.shape === "direct" || details.shape === "supervised" || details.shape === "chain" || details.shape === "unknown"
		? details.shape
		: "unknown";
}

export function renderDelegateResult(result: any, options: any, theme: any) {
	const details = result.details as { forks?: RunResult[]; shape?: unknown; mode?: unknown } | undefined;
	const mdTheme = getMarkdownTheme();
	if (!details || !Array.isArray(details.forks) || details.forks.length === 0) {
		const t = result.content?.[0];
		return new Text(t?.type === "text" ? t.text : "(no output)", 0, 0);
	}

	const { expanded } = options ?? {};
	const runs = details.forks;
	const shape = resultShape(details);
	const terminology = getDelegatePresentationTerminology(shape);

	const header = () => {
		const entryNoun = runs.length === 1 ? terminology.singular : terminology.plural;
		const entryLabel = entryNoun ? `${entryNoun} ` : "";
		const done = runs.filter((f) => f.status === "completed").length;
		const failed = runs.filter((f) => f.status === "failed" || f.status === "aborted").length;
		const running = countProjectedActiveRuns(runs);
		// Spec 0019 / REQ-PAUSE-4 — paused run entries (supervisor forced to finish at
		// max_rounds) are terminal-but-NOT-done. They must never roll into the
		// green-success header: an all-paused result is the literal silent-success
		// illusion this spec exists to kill (header would read '0/N complete' ✓).
		const paused = runs.filter((f) => f.status === "paused").length;
		const icon =
			running > 0
				? theme.fg("warning", "⏳")
				: failed > 0
					? theme.fg("warning", "◐")
					: paused > 0
						? theme.fg("warning", "⏸")
						: theme.fg("success", "✓");
		let status: string;
		if (running > 0) {
			status = `${done + failed + paused}/${runs.length} ${entryLabel}done, ${running} running`;
		} else if (paused > 0) {
			// Lead with the paused count so the header NEVER reads as a completion
			// claim (no leading 'N/N complete ✓') when run entries are parked mid-work.
			const extras: string[] = [];
			if (done > 0) extras.push(`${done} complete`);
			if (failed > 0) extras.push(`${failed} failed`);
			status = `${paused}/${runs.length} ${entryLabel}paused${extras.length ? `, ${extras.join(", ")}` : ""}`;
		} else {
			status = `${done}/${runs.length} ${entryLabel}complete${failed > 0 ? `, ${failed} failed` : ""}`;
		}
		return `${icon} ${theme.fg("toolTitle", theme.bold("delegate "))}${theme.fg("accent", status)}`;
	};

	if (expanded) {
		const container = new Container();
		container.addChild(new Text(header(), 0, 0));

		for (const f of runs) {
			container.addChild(new Spacer(1));
			const label = f.name && f.name !== f.agent ? `${f.agent}:${f.name}` : f.agent;
			container.addChild(
				new Text(
					`${statusIcon(f.status, theme)} ${theme.fg("muted", "─── ")}${theme.fg("accent", label)} ${theme.fg("muted", `(${f.agentSource})`)}`,
					0,
					0,
				),
			);
			container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", f.task), 0, 0));
			if (f.workerSessionFile) {
				container.addChild(
					new Text(theme.fg("muted", "Worker session: ") + theme.fg("dim", f.workerSessionFile), 0, 0),
				);
			}
			if (f.error) {
				container.addChild(new Text(theme.fg("error", `Error: ${f.error}`), 0, 0));
			}
			if (f.recoveredOutput) {
				const message = f.status === "failed"
					? `Recovered worker output is shown below; ${terminology.singular} status remains failed.`
					: `Recovered worker output is shown below; ${terminology.singular} status: ${f.status}.`;
				container.addChild(new Text(theme.fg("warning", message), 0, 0));
			}
			for (const warning of formatForkWarningLines(f.warnings)) {
				container.addChild(new Text(theme.fg("warning", warning), 0, 0));
			}
			const repairReport = renderPromptRepairReport(f.promptRepairs ?? []);
			if (repairReport) {
				container.addChild(new Spacer(1));
				container.addChild(new Markdown(repairReport, 0, 0, mdTheme));
			}
			if (f.collapsedContent) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", `─── Collapsed (${f.collapseMode}) ───`), 0, 0));
				container.addChild(new Markdown(f.collapsedContent.trim(), 0, 0, mdTheme));
			}
			const u = usageLine(f, theme);
			if (u) container.addChild(new Text(u, 0, 0));
		}
		return container;
	}

	// Collapsed view
	let text = header();
	for (const f of runs) {
		const label = f.name && f.name !== f.agent ? `${f.agent}:${f.name}` : f.agent;
		text += `\n\n${statusIcon(f.status, theme)} ${theme.fg("accent", label)} ${theme.fg("muted", `(${f.agentSource})`)}`;
		if (f.error) text += `\n${theme.fg("error", f.error)}`;
		if (f.recoveredOutput) {
			const message = f.status === "failed"
				? `Recovered worker output; ${terminology.singular} status remains failed.`
				: `Recovered worker output; ${terminology.singular} status: ${f.status}.`;
			text += `\n${theme.fg("warning", message)}`;
		}
		for (const warning of formatForkWarningLines(f.warnings)) {
			text += `\n${theme.fg("warning", warning)}`;
		}
		if (f.promptRepairs?.length) {
			const noun = f.promptRepairs.length === 1 ? "attempt" : "attempts";
			text += `\n${theme.fg("warning", `prompt repair: ${f.promptRepairs.length} ${noun}`)}`;
		}
		if (f.collapsedContent) {
			const preview = f.collapsedContent.split("\n").slice(0, 3).join("\n");
			text += `\n${theme.fg("toolOutput", preview)}`;
			if (f.collapsedContent.split("\n").length > 3) {
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
			}
		}
		const u = usageLine(f, theme);
		if (u) text += `\n${u}`;
	}
	return new Text(text, 0, 0);
}

/** The custom-message shape the completion/recovery renderers read (issue #451). */
type DelegateResultMessage = { details?: unknown; content?: unknown };
/** Just the expand flag a registered message renderer receives. */
type MessageExpandOptions = { expanded?: boolean };
/** Minimal theme surface these renderers touch; method syntax keeps the real
 * pi-core `Theme` and the tests' stub theme both assignable without `any`. */
type MessageRenderTheme = { fg(role: string, text: string): string };

/** True when a message carries at least one per-run result to render structurally. */
function messageForks(message: DelegateResultMessage | null | undefined): unknown[] | undefined {
	const details = message?.details as { forks?: unknown } | undefined;
	return details && Array.isArray(details.forks) && details.forks.length > 0 ? details.forks : undefined;
}

/**
 * Collapse a completion message's own textual `content` (issue #451). Used for
 * completion shapes that carry no per-run `forks` — driver/orchestrate results
 * and recovery notices — so they too collapse on first paint and toggle with
 * Ctrl+O instead of pi-core painting their full body unconditionally. Expanded
 * reproduces pi-core's default full-Markdown view; collapsed shows the leading
 * lines (the run header) plus the standard expand affordance.
 */
function renderCollapsibleMessageBody(content: string, expanded: boolean, theme: MessageRenderTheme) {
	if (expanded) {
		return new Markdown(content.trim(), 0, 0, getMarkdownTheme());
	}
	const lines = content.split("\n");
	let text = lines.slice(0, 3).join("\n");
	if (lines.length > 3) {
		text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	}
	return new Text(text, 0, 0);
}

/**
 * Renderer for the `delegate:complete` background-completion custom message
 * (issue #451). A background dispatch returns a small acknowledgement as the
 * tool result and later delivers the finished run(s) as this custom message.
 * Without a registered renderer, pi-core's CustomMessageComponent falls back to
 * rendering the message's full `content` as Markdown and ignores its expand
 * flag entirely — so the completed result always paints expanded and cannot be
 * collapsed with Ctrl+O.
 *
 * A registered message renderer receives `options.expanded` (pi-core's
 * `toolOutputExpanded`, default false) and is re-invoked on `setExpanded`,
 * which gives us: collapsed on first paint (REQ-DELEGATE-COLLAPSE-001); Ctrl+O
 * toggling the two views (REQ-DELEGATE-COLLAPSE-002); and, for the common
 * direct/supervised/chain completions that carry `details.forks` in the exact
 * shape `renderDelegateResult` consumes, an expanded view byte-for-byte equal
 * to today's tool-result output (REQ-DELEGATE-COLLAPSE-003).
 *
 * Driver/orchestrate completions carry free-form `content` and no `forks`; they
 * fall back to collapsing that content. This changes DISPLAY only — the
 * message's `content` (what the model reads) is untouched. A completion with no
 * forks and no content returns undefined so pi-core keeps its default.
 */
export function renderDelegateCompletionMessage(
	message: DelegateResultMessage | null | undefined,
	options: MessageExpandOptions | undefined,
	theme: MessageRenderTheme,
) {
	const expanded = Boolean(options?.expanded);
	if (messageForks(message)) {
		return renderDelegateResult(message, { expanded }, theme);
	}
	const content = typeof message?.content === "string" ? message.content : "";
	return content ? renderCollapsibleMessageBody(content, expanded, theme) : undefined;
}

/**
 * Renderer for the `delegate:sync-orphan-recovery` custom message (issue #451).
 * Like a completion it otherwise paints its full body unconditionally. It does
 * carry `forks`, but its `content` leads with a recovery-provenance banner that
 * the structured per-run view would drop, so we collapse the textual content
 * (banner included) rather than route it through `renderDelegateResult`.
 */
export function renderDelegateRecoveryMessage(
	message: DelegateResultMessage | null | undefined,
	options: MessageExpandOptions | undefined,
	theme: MessageRenderTheme,
) {
	const content = typeof message?.content === "string" ? message.content : "";
	return content ? renderCollapsibleMessageBody(content, Boolean(options?.expanded), theme) : undefined;
}
