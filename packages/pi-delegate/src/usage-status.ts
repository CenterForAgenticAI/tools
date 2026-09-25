import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isOwnedByThisProcess, listRuns } from "./runtime.js";
import {
	addDelegateUsageTotals,
	aggregateRunStateUsage,
	aggregateUsageRecords,
	extractDelegateUsageRecordsFromEntries,
	formatDelegateUsageStatus,
	usageHasAnyValue,
} from "./usage-rollup.js";

// Pi renders extension statuses on one alphabetically sorted, terminal-width
// truncated footer line. Keep delegate usage first so long status extensions
// (adaptive-thinking/context-aware) cannot push the cost rollup off-screen.
const STATUS_KEY = "00-delegate-usage";
const LEGACY_STATUS_KEY = "delegate-usage";

export interface UsageStatusHandle {
	dispose(): void;
	requestUpdate(): void;
}

function sessionEntries(ctx: any): any[] {
	try {
		const entries = ctx?.sessionManager?.getEntries?.();
		return Array.isArray(entries) ? entries : [];
	} catch {
		return [];
	}
}

function sessionId(ctx: any): string | undefined {
	try {
		const id = ctx?.sessionManager?.getSessionId?.();
		return typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

function computeUsageForFooter(ctx: any) {
	const records = extractDelegateUsageRecordsFromEntries(sessionEntries(ctx));
	let totals = aggregateUsageRecords(records);
	const countedRunIds = new Set(records.map((r) => r.runId).filter((x): x is string => typeof x === "string"));
	const currentSessionId = sessionId(ctx);

	// Completed delegate calls are normally represented by the foreground
	// session's toolResult/custom_message entries above. Add only live runtime
	// runs (and any just-completed run not yet appended to the session) so the
	// footer stays current without double-counting historical session entries.
	for (const run of listRuns()) {
		if (countedRunIds.has(run.runId)) continue;
		if (run.completedAt !== undefined && !run.finalResult) continue;
		if (run.completedAt !== undefined) {
			// Completed usage is session-scoped, even when the old and new sessions
			// share one process. In particular, `/new` replaces the session while the
			// module-level runtime registry still contains the predecessor's completed
			// runs. Process ownership alone would leak that usage into the fresh footer.
			if (currentSessionId === undefined || run.ownerSessionId !== currentSessionId) continue;
			// A matching completed run missing from the session is usually in the tiny
			// gap between completeRun() and sendMessage()/toolResult append. It can also
			// be from this same foreground session after a pi process replacement/reload:
			// `owningPid` changes, but `ownerSessionId` persists. Once the session entry
			// lands, countedRunIds suppresses this leg.
			totals = addDelegateUsageTotals(totals, aggregateRunStateUsage(run));
			continue;
		}
		if (!isOwnedByThisProcess(run)) continue;
		totals = addDelegateUsageTotals(totals, aggregateRunStateUsage(run));
	}

	return totals;
}

/**
 * Adds a compact footer status line with pi-delegate's session-level subagent
 * usage rollup. This intentionally uses `setStatus` instead of replacing pi's
 * built-in footer: the core footer keeps showing foreground-session usage, and
 * this extension line adds the delegate/subagent delta beside it.
 */
export function setupUsageFooterStatus(pi: ExtensionAPI, ctx: any): UsageStatusHandle | null {
	if (!ctx?.hasUI || typeof ctx?.ui?.setStatus !== "function") return null;

	let disposed = false;
	let lastText: string | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;

	try {
		ctx.ui.setStatus(LEGACY_STATUS_KEY, undefined);
	} catch {
		/* stale ctx / non-interactive mode: best effort */
	}

	const apply = () => {
		if (disposed) return;
		const usage = computeUsageForFooter(ctx);
		const text = usageHasAnyValue(usage) ? formatDelegateUsageStatus(usage) : undefined;
		if (text === lastText) return;
		lastText = text;
		try {
			ctx.ui.setStatus(STATUS_KEY, text);
		} catch {
			/* stale ctx / non-interactive mode: best effort */
		}
	};

	const requestUpdate = () => {
		if (disposed) return;
		if (timer) clearTimeout(timer);
		// Coalesce bursts of transcript/runtime updates, and let pi append the
		// matching toolResult/custom_message entry before re-reading the session.
		timer = setTimeout(() => {
			timer = undefined;
			apply();
		}, 25);
		(timer as any).unref?.();
	};

	const unsubs: Array<() => void> = [];
	unsubs.push(pi.events.on("delegate:register", requestUpdate));
	unsubs.push(pi.events.on("delegate:update", requestUpdate));
	unsubs.push(pi.events.on("luthen.delegate.complete", requestUpdate));
	unsubs.push(pi.events.on("delegate:transcript-append", requestUpdate));

	apply();

	return {
		dispose() {
			disposed = true;
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
			for (const off of unsubs.splice(0)) {
				try {
					off();
				} catch {
					/* noop */
				}
			}
			try {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.setStatus(LEGACY_STATUS_KEY, undefined);
			} catch {
				/* noop */
			}
		},
		requestUpdate,
	};
}
