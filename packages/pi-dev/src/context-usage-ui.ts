import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type {
  BuildSystemPromptOptions,
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
  buildContextUsageSnapshot,
  type ContextContribution,
  type ContextUsageSnapshot,
  type PromptContributionStage,
} from "./context-usage.ts";
import { withOverlayBackground } from "./overlay.ts";

export const CONTEXT_USAGE_SHORTCUT = "ctrl+shift+u" as const;
export const CONTEXT_USAGE_REFRESH_MS = 750;
export type ContextUsageOrder = "usage" | "source";

const PI_DEV_SOURCE = "@caair/pi-dev";
const DISPLAY_ROW_COUNT = 20;

export interface TrackedPromptState {
  readonly options?: BuildSystemPromptOptions;
  readonly baseSystemPrompt: string;
  readonly stages: readonly PromptContributionStage[];
}

interface PromptCapture {
  readonly options: BuildSystemPromptOptions;
  readonly beforePiDev: string;
  readonly afterPiDev: string;
}

export class ContextUsageTracker {
  private captureState: PromptCapture | undefined;

  capture(options: BuildSystemPromptOptions, beforePiDev: string, afterPiDev: string): void {
    this.captureState = { options, beforePiDev, afterPiDev };
  }

  clear(): void {
    this.captureState = undefined;
  }

  state(effectiveSystemPrompt: string, options?: BuildSystemPromptOptions): TrackedPromptState {
    const capture = this.captureState;
    if (!capture) {
      return {
        ...(options !== undefined ? { options } : {}),
        baseSystemPrompt: effectiveSystemPrompt,
        stages: [],
      };
    }

    const stages: PromptContributionStage[] = [];
    if (capture.beforePiDev !== capture.afterPiDev) {
      stages.push({
        id: "system-extension/pi-dev",
        label: PI_DEV_SOURCE,
        before: capture.beforePiDev,
        after: capture.afterPiDev,
        source: PI_DEV_SOURCE,
      });
    }
    if (capture.afterPiDev !== effectiveSystemPrompt) {
      stages.push({
        id: "system-extension/after-pi-dev",
        label: "Extensions after pi-dev",
        before: capture.afterPiDev,
        after: effectiveSystemPrompt,
      });
    }
    return {
      options: capture.options,
      baseSystemPrompt: capture.beforePiDev,
      stages,
    };
  }
}

export interface ContextUsageDisplayRow {
  readonly node: ContextContribution;
  readonly depth: number;
  readonly key: string;
  readonly parentKey?: string;
  readonly expanded: boolean;
}

export type ContextUsageExpansionReader = (
  node: ContextContribution,
  depth: number,
  key: string,
) => boolean;

const sourceOrderCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function compareSourceText(left: string, right: string): number {
  const collated = sourceOrderCollator.compare(left, right);
  if (collated !== 0) return collated;
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareBySource(left: ContextContribution, right: ContextContribution): number {
  const source = compareSourceText(left.source ?? left.label, right.source ?? right.label);
  if (source !== 0) return source;
  const label = compareSourceText(left.label, right.label);
  return label !== 0 ? label : compareSourceText(left.id, right.id);
}

function orderedChildren(
  node: ContextContribution,
  order: ContextUsageOrder,
): readonly ContextContribution[] {
  return [...node.children].sort((left, right) => order === "usage"
    ? right.estimatedTokens - left.estimatedTokens || compareBySource(left, right)
    : compareBySource(left, right));
}

function appendRows(
  target: ContextUsageDisplayRow[],
  node: ContextContribution,
  depth: number,
  parentKey: string | undefined,
  ancestors: readonly string[],
  isExpanded: ContextUsageExpansionReader,
  order: ContextUsageOrder,
): void {
  const key = JSON.stringify([...ancestors, node.id]);
  const expanded = node.children.length > 0 && isExpanded(node, depth, key);
  target.push({
    node,
    depth,
    key,
    ...(parentKey !== undefined ? { parentKey } : {}),
    expanded,
  });
  if (!expanded) return;
  for (const child of orderedChildren(node, order)) {
    appendRows(target, child, depth + 1, key, [...ancestors, node.id], isExpanded, order);
  }
}

export function contextUsageDisplayRows(
  snapshot: ContextUsageSnapshot,
  isExpanded: ContextUsageExpansionReader = () => true,
  order: ContextUsageOrder = "usage",
): readonly ContextUsageDisplayRow[] {
  const rows: ContextUsageDisplayRow[] = [];
  for (const section of snapshot.sections) appendRows(rows, section, 0, undefined, [], isExpanded, order);
  return rows;
}

export type ContextUsageSnapshotReader = () => ContextUsageSnapshot;
export type ContextUsageRefreshScheduler = (callback: () => void, intervalMs: number) => () => void;

export interface ContextUsageOverlayOptions {
  readonly readSnapshot: ContextUsageSnapshotReader;
  readonly theme: Theme;
  readonly done: (result: undefined) => void;
  readonly requestRender: () => void;
  readonly scheduleRefresh?: ContextUsageRefreshScheduler;
}

function defaultScheduleRefresh(callback: () => void, intervalMs: number): () => void {
  const timer = setInterval(callback, intervalMs);
  return () => clearInterval(timer);
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return Math.round(value).toString();
}

function percent(value: number | null): string {
  return value === null ? "unknown" : `${value.toFixed(1)}%`;
}

function measuredSummary(snapshot: ContextUsageSnapshot): string {
  const measured = snapshot.measuredUsage;
  if (!measured) return "Provider total unavailable until Pi receives usage data.";
  const tokens = measured.tokens === null ? "unknown" : compactNumber(measured.tokens);
  return `Provider total: ${tokens} / ${compactNumber(measured.contextWindow)} (${percent(measured.percent)})`;
}

function contributionLine(
  row: ContextUsageDisplayRow,
  localTotal: number,
  width: number,
  theme: Theme,
  selected: boolean,
): string {
  const { node, depth } = row;
  const selection = selected ? "› " : "  ";
  const indentation = "  ".repeat(depth);
  const branch = node.children.length === 0 ? "  " : row.expanded ? "▾ " : "▸ ";
  const source = node.source && node.source !== node.label ? ` · ${node.source}` : "";
  const rawLabel = `${selection}${indentation}${branch}${node.label}${source}`;
  const ratio = localTotal > 0 ? (node.estimatedTokens / localTotal) * 100 : 0;
  const right = `~${compactNumber(node.estimatedTokens)} tok  ${ratio.toFixed(1)}%`;
  const availableLabel = Math.max(1, width - visibleWidth(right) - 1);
  const label = truncateToWidth(rawLabel, availableLabel);
  const gap = " ".repeat(Math.max(1, width - visibleWidth(label) - visibleWidth(right)));
  const line = `${label}${gap}${right}`;
  const themed = depth === 0
    ? theme.fg("accent", theme.bold(line))
    : node.kind === "tool-source" || node.kind === "system-extension"
      ? theme.fg("warning", line)
      : `${label}${gap}${theme.fg("dim", right)}`;
  return selected ? theme.bg("selectedBg", themed) : themed;
}

export class ContextUsageOverlay implements Component {
  private offset = 0;
  private rowCount = 0;
  private rows: readonly ContextUsageDisplayRow[] = [];
  private selectedKey: string | undefined;
  private order: ContextUsageOrder = "usage";
  private readonly expansionOverrides = new Map<string, boolean>();
  private disposed = false;
  private readonly readSnapshot: ContextUsageSnapshotReader;
  private readonly theme: Theme;
  private readonly done: (result: undefined) => void;
  private readonly requestRender: () => void;
  private readonly cancelRefresh: () => void;

  constructor(options: ContextUsageOverlayOptions) {
    this.readSnapshot = options.readSnapshot;
    this.theme = options.theme;
    this.done = options.done;
    this.requestRender = options.requestRender;
    this.cancelRefresh = (options.scheduleRefresh ?? defaultScheduleRefresh)(
      () => this.requestRender(),
      CONTEXT_USAGE_REFRESH_MS,
    );
  }

  handleInput(data: string): void {
    if (data === "q" || matchesKey(data, "escape") || matchesKey(data, "return")) {
      this.done(undefined);
      return;
    }
    if (data === "r") {
      this.requestRender();
      return;
    }

    let changed: boolean;
    if (data === "k" || matchesKey(data, "up")) changed = this.moveSelection(-1);
    else if (data === "j" || matchesKey(data, "down")) changed = this.moveSelection(1);
    else if (matchesKey(data, "pageUp")) changed = this.moveSelection(-DISPLAY_ROW_COUNT);
    else if (matchesKey(data, "pageDown")) changed = this.moveSelection(DISPLAY_ROW_COUNT);
    else if (matchesKey(data, "home")) changed = this.selectIndex(0);
    else if (matchesKey(data, "end")) changed = this.selectIndex(this.rows.length - 1);
    else if (matchesKey(data, "left")) changed = this.collapseOrSelectParent();
    else if (matchesKey(data, "right")) changed = this.expandOrSelectChild();
    else if (matchesKey(data, "space")) changed = this.toggleSelected();
    else if (data === "o") changed = this.toggleOrder();
    else return;

    if (changed) this.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.trunc(Number.isFinite(width) && width > 0 ? width : 20));
    try {
      const snapshot = this.readSnapshot();
      const rows = contextUsageDisplayRows(
        snapshot,
        (_node, depth, key) => this.expansionOverrides.get(key) ?? depth === 0,
        this.order,
      );
      this.setRows(rows);
      const visible = this.rows.slice(this.offset, this.offset + DISPLAY_ROW_COUNT);
      const measured = snapshot.measuredUsage;
      const providerTokens = measured?.tokens === null || measured?.tokens === undefined
        ? "unknown"
        : compactNumber(measured.tokens);
      const providerLine = measured
        ? `Provider total  ${providerTokens} / ${compactNumber(measured.contextWindow)}  ${percent(measured.percent)}`
        : "Provider total  unavailable";
      const localLine = `Local allocation estimate  ~${compactNumber(snapshot.estimatedTokens)} tokens  (not scaled to provider total)`;
      const rangeEnd = Math.min(rows.length, this.offset + visible.length);
      return [
        this.theme.fg("accent", this.theme.bold("Context usage breakdown")),
        this.theme.fg("text", providerLine),
        this.theme.fg("dim", localLine),
        this.theme.fg("dim", `Updated ${snapshot.updatedAt} · order ${this.order} · rows ${rows.length === 0 ? 0 : this.offset + 1}-${rangeEnd} of ${rows.length}`),
        "",
        ...visible.map((row) => contributionLine(
          row,
          snapshot.estimatedTokens,
          safeWidth,
          this.theme,
          row.key === this.selectedKey,
        )),
        "",
        this.theme.fg("dim", "↑/↓ or j/k select · ←/→ collapse/expand · Space toggle"),
        this.theme.fg("dim", "PgUp/PgDn/Home/End jump · o order · r refresh · Enter/Esc/q close"),
        this.theme.fg("dim", "~ = local chars/4 estimate; provider total is reported separately"),
        this.theme.fg("dim", "Images: fixed ~1.2k-token estimate when present"),
      ].map((line) => truncateToWidth(line, safeWidth));
    } catch (error) {
      return [
        this.theme.fg("error", this.theme.bold("Context usage breakdown unavailable")),
        error instanceof Error ? error.message : String(error),
        "",
        this.theme.fg("dim", "r retry · Enter/Esc/q close"),
      ].map((line) => truncateToWidth(line, safeWidth));
    }
  }

  invalidate(): void {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelRefresh();
  }

  private setRows(rows: readonly ContextUsageDisplayRow[]): void {
    const priorIndex = this.selectedIndex();
    this.rows = rows;
    this.rowCount = rows.length;
    if (rows.length === 0) {
      this.selectedKey = undefined;
      this.offset = 0;
      return;
    }

    let selectedIndex = this.selectedKey === undefined
      ? -1
      : rows.findIndex((row) => row.key === this.selectedKey);
    if (selectedIndex < 0) selectedIndex = Math.min(Math.max(priorIndex, 0), rows.length - 1);
    this.selectedKey = rows[selectedIndex]?.key;
    this.offset = Math.min(this.offset, this.maximumOffset());
    this.ensureSelectedVisible(selectedIndex);
  }

  private selectedIndex(): number {
    if (this.selectedKey === undefined) return -1;
    return this.rows.findIndex((row) => row.key === this.selectedKey);
  }

  private selectedRow(): ContextUsageDisplayRow | undefined {
    const index = this.selectedIndex();
    return index < 0 ? undefined : this.rows[index];
  }

  private selectIndex(index: number): boolean {
    if (this.rows.length === 0) return false;
    const nextIndex = Math.min(Math.max(index, 0), this.rows.length - 1);
    const next = this.rows[nextIndex];
    if (!next || next.key === this.selectedKey) return false;
    this.selectedKey = next.key;
    this.ensureSelectedVisible(nextIndex);
    return true;
  }

  private moveSelection(delta: number): boolean {
    const current = this.selectedIndex();
    return this.selectIndex((current < 0 ? 0 : current) + delta);
  }

  private collapseOrSelectParent(): boolean {
    const row = this.selectedRow();
    if (!row) return false;
    if (row.node.children.length > 0 && row.expanded) return this.setExpanded(row, false);
    if (row.parentKey === undefined) return false;
    return this.selectIndex(this.rows.findIndex((candidate) => candidate.key === row.parentKey));
  }

  private expandOrSelectChild(): boolean {
    const row = this.selectedRow();
    if (!row || row.node.children.length === 0) return false;
    if (!row.expanded) return this.setExpanded(row, true);
    return this.selectIndex(this.rows.findIndex((candidate) => candidate.parentKey === row.key));
  }

  private toggleSelected(): boolean {
    const row = this.selectedRow();
    if (!row || row.node.children.length === 0) return false;
    return this.setExpanded(row, !row.expanded);
  }

  private toggleOrder(): boolean {
    this.order = this.order === "usage" ? "source" : "usage";
    return true;
  }

  private setExpanded(row: ContextUsageDisplayRow, expanded: boolean): boolean {
    if (row.expanded === expanded) return false;
    this.expansionOverrides.set(row.key, expanded);
    return true;
  }

  private ensureSelectedVisible(index: number): void {
    if (index < this.offset) this.offset = index;
    else if (index >= this.offset + DISPLAY_ROW_COUNT) this.offset = index - DISPLAY_ROW_COUNT + 1;
    this.offset = Math.min(Math.max(0, this.offset), this.maximumOffset());
  }

  private maximumOffset(): number {
    return Math.max(0, this.rowCount - DISPLAY_ROW_COUNT);
  }
}

export function collectContextUsageSnapshot(
  pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">,
  ctx: Pick<ExtensionContext, "getSystemPrompt" | "getContextUsage" | "sessionManager">,
  tracker: ContextUsageTracker,
  options?: BuildSystemPromptOptions,
): ContextUsageSnapshot {
  const effectiveSystemPrompt = ctx.getSystemPrompt();
  const prompt = tracker.state(effectiveSystemPrompt, options);
  const messages = ctx.sessionManager.buildContextEntries()
    .flatMap((entry) => sessionEntryToContextMessages(entry));
  const measuredUsage = ctx.getContextUsage();
  return buildContextUsageSnapshot({
    baseSystemPrompt: prompt.baseSystemPrompt,
    effectiveSystemPrompt,
    ...(prompt.options !== undefined ? { systemPromptOptions: prompt.options } : {}),
    promptStages: prompt.stages,
    activeToolNames: pi.getActiveTools(),
    tools: pi.getAllTools(),
    messages,
    ...(measuredUsage !== undefined ? { measuredUsage } : {}),
  });
}

export async function openContextUsageOverlay(
  pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">,
  ctx: ExtensionContext,
  tracker: ContextUsageTracker,
  options?: BuildSystemPromptOptions,
): Promise<void> {
  const readSnapshot = (): ContextUsageSnapshot => collectContextUsageSnapshot(pi, ctx, tracker, options);
  if (ctx.mode !== "tui") {
    const snapshot = readSnapshot();
    ctx.ui.notify(`${measuredSummary(snapshot)}\nLocal allocation estimate: ~${compactNumber(snapshot.estimatedTokens)} tokens.`, "info");
    return;
  }
  await ctx.ui.custom<undefined>(
    (tui, theme, _keybindings, done) => withOverlayBackground(new ContextUsageOverlay({
      readSnapshot,
      theme,
      done,
      requestRender: () => tui.requestRender(),
    }), theme),
    {
      overlay: true,
      overlayOptions: {
        width: "60%",
        minWidth: 52,
        maxHeight: "90%",
        anchor: "right-center",
        margin: 1,
      },
    },
  );
}
