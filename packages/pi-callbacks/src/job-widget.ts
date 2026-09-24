import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isActiveJob, jobOwnedBySession, listJobs } from "./store.ts";
import type { CallbackJob, SessionRef } from "./types.ts";
import { formatJobBlock } from "./utils.ts";

export const JOB_WIDGET_KEY = "caair.pi-callbacks/jobs-widget";
export const JOB_WIDGET_REFRESH_INTERVAL_MS = 10_000;
const MAX_WIDGET_LINES = 3;

export interface JobWidgetLoopOptions {
  intervalMs?: number;
  setInterval?: (callback: () => void, delay: number) => ReturnType<typeof globalThis.setInterval>;
  clearInterval?: (handle: ReturnType<typeof globalThis.setInterval>) => void;
}

export interface JobWidgetLoop {
  start(refresh: () => void): void;
  stop(): void;
}

export function createJobWidgetLoop(options: JobWidgetLoopOptions = {}): JobWidgetLoop {
  let timer: ReturnType<typeof globalThis.setInterval> | undefined;
  const intervalMs = options.intervalMs ?? JOB_WIDGET_REFRESH_INTERVAL_MS;
  const schedule = options.setInterval ?? ((callback, delay) => globalThis.setInterval(callback, delay));
  const cancel = options.clearInterval ?? ((handle) => globalThis.clearInterval(handle));

  return {
    start(refresh): void {
      if (timer !== undefined) cancel(timer);
      timer = schedule(refresh, intervalMs);
    },
    stop(): void {
      if (timer === undefined) return;
      cancel(timer);
      timer = undefined;
    },
  };
}

export function updateJobWidget(ctx: ExtensionContext, now = Date.now()): void {
  if (!ctx.hasUI) return;

  const sessionFile = ctx.sessionManager.getSessionFile();
  const session: SessionRef = {
    sessionId: ctx.sessionManager.getSessionId(),
    ...(sessionFile === undefined ? {} : { sessionFile }),
    cwd: ctx.cwd,
  };
  const activeJobs = listJobs()
    .filter((job) => isActiveJob(job))
    .filter((job) => jobOwnedBySession(job, session));

  if (activeJobs.length === 0) {
    ctx.ui.setWidget(JOB_WIDGET_KEY, undefined);
    return;
  }

  if (ctx.mode === "tui") {
    ctx.ui.setWidget(
      JOB_WIDGET_KEY,
      (_tui, theme) => ({
        render(width: number): string[] {
          // Rebuild per render: the tier a line qualifies for depends on the current width,
          // so a resize must be able to restore detail rather than only ever remove it.
          return formatJobWidgetLines(activeJobs, now, width)
            .map((line) => theme.fg("accent", truncateWidgetLine(line, width)));
        },
        invalidate(): void {},
      }),
      { placement: "belowEditor" },
    );
    return;
  }
  // RPC is never told a display width, so it receives full detail rather than a guessed size.
  ctx.ui.setWidget(JOB_WIDGET_KEY, formatJobWidgetLines(activeJobs, now), { placement: "belowEditor" });
}

/**
 * Build the widget lines for a given display width.
 *
 * `width` is the terminal width when known. Pass `undefined` where it is not — RPC mode never
 * reports one — and every line keeps its full detail rather than guessing at a size.
 */
export function formatJobWidgetLines(jobs: CallbackJob[], now: number, width?: number): string[] {
  // No count header: the footer status already reads "callbacks: N active" whenever this
  // widget has content, so a header would repeat it and cost a line the jobs need.
  const hasMoreJobs = jobs.length > MAX_WIDGET_LINES;
  const visibleJobLimit = hasMoreJobs ? MAX_WIDGET_LINES - 1 : MAX_WIDGET_LINES;
  const visibleJobs = jobs.slice(0, visibleJobLimit);
  const lines = visibleJobs.map((job) => compactJobLine(job, now, width));
  if (hasMoreJobs) {
    lines.push(`… and ${jobs.length - visibleJobs.length} more active`);
  }
  return lines.slice(0, MAX_WIDGET_LINES);
}

/**
 * Fit one job onto one line, shedding the least informative detail first.
 *
 * Tiers, widest to narrowest: full, then without `status:`, then without `kind:` as well.
 * `status:` goes first because the widget lists only non-terminal jobs, so it is almost always
 * `pending`; `kind:` survives longer because a poll and a reminder behave differently. The id
 * and label are kept longest, because the label is what identifies a job to a reader and the id
 * is what cancels it.
 *
 * A source status (a watched GitLab pipeline, say) is real news rather than boilerplate, so it
 * is held at the same tier as `kind:`.
 */
function compactJobLine(job: CallbackJob, now: number, width?: number): string {
  const [title, status] = formatJobBlock(job, { now }).split("\n");
  const head = title ?? job.id;
  const statusText = (status ?? `status: ${job.status}`).trim();
  const sourceStatus = job.kind === "poll" ? job.lastResult?.status : undefined;
  const kindText = `kind: ${job.kind}`;
  const sourceText = sourceStatus === undefined ? "" : ` · source=${sourceStatus}`;

  const full = `${head} · ${statusText}${sourceText}`;
  if (width === undefined) return full;

  // statusText from formatJobBlock already carries the kind, so dropping status means
  // reinstating the kind explicitly at the middle tier.
  const withoutStatus = `${head} · ${kindText}${sourceText}`;
  for (const candidate of [full, withoutStatus, head]) {
    if (visibleWidth(candidate) <= width) return candidate;
  }
  return head;
}

function truncateWidgetLine(line: string, width: number): string {
  return truncateToWidth(line, Math.max(0, Math.floor(width)), "…");
}
