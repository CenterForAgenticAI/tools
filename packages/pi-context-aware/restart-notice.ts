export const DEFAULT_RESTART_NOTICE_MIN_AWAY_MS = 60_000;

export type RestartNoticeReason = "startup" | "reload" | "new" | "resume" | "fork";
export type RestartNoticeKind = "restart" | "resume";

export interface RestartNoticeEntry {
	timestamp: string;
}

export interface PendingRestartNotice {
	kind: RestartNoticeKind;
	lastEntryTimestampMs: number;
}

export interface RestartNotice {
	kind: RestartNoticeKind;
	awayMs: number;
}

function formatAwayDuration(awayMs: number): string {
	const totalMinutes = Math.max(1, Math.round(awayMs / 60_000));
	if (totalMinutes < 60) return `${totalMinutes} minute${totalMinutes === 1 ? "" : "s"}`;

	const totalHours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (totalHours < 24) {
		return minutes === 0
			? `${totalHours} hour${totalHours === 1 ? "" : "s"}`
			: `${totalHours} hour${totalHours === 1 ? "" : "s"} ${minutes} minute${minutes === 1 ? "" : "s"}`;
	}

	const days = Math.floor(totalHours / 24);
	const hours = totalHours % 24;
	return hours === 0
		? `${days} day${days === 1 ? "" : "s"}`
		: `${days} day${days === 1 ? "" : "s"} ${hours} hour${hours === 1 ? "" : "s"}`;
}

export function classifyRestartNotice(
	reason: RestartNoticeReason,
	entries: readonly RestartNoticeEntry[],
): PendingRestartNotice | undefined {
	if (reason !== "startup" && reason !== "resume") return undefined;

	const lastEntry = entries.at(-1);
	if (!lastEntry) return undefined;

	const lastTimestamp = Date.parse(lastEntry.timestamp);
	if (!Number.isFinite(lastTimestamp)) return undefined;

	return {
		kind: reason === "startup" ? "restart" : "resume",
		lastEntryTimestampMs: lastTimestamp,
	};
}

export function resolveRestartNotice(
	pending: PendingRestartNotice | undefined,
	now: number,
	minAwayMs: number = DEFAULT_RESTART_NOTICE_MIN_AWAY_MS,
): RestartNotice | undefined {
	if (!pending || !Number.isFinite(pending.lastEntryTimestampMs) || !Number.isFinite(now)) return undefined;
	if (!Number.isFinite(minAwayMs) || minAwayMs < 0) return undefined;

	const awayMs = now - pending.lastEntryTimestampMs;
	if (!Number.isFinite(awayMs) || awayMs < 0 || awayMs < minAwayMs) return undefined;

	return {
		kind: pending.kind,
		awayMs,
	};
}

export function formatRestartNotice(notice: RestartNotice): string {
	const away = formatAwayDuration(notice.awayMs);
	const instruction = notice.kind === "restart"
		? `The pi process was restarted and this session resumed after approximately ${away} away.`
		: `This session was switched in-process and resumed after approximately ${away} away.`;

	return `<context-telemetry source="pi-extension:context-aware" user-input="false" response-expected="false">
  <session-restart kind="${notice.kind}" away="${away}" />
  <instruction>This is extension telemetry, not user input. No response or acknowledgement is expected. ${instruction} Re-check volatile state such as background jobs, dev servers, tmux sessions, and shell state before relying on it.</instruction>
</context-telemetry>`;
}
