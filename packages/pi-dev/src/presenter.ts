import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { SessionTextPresentationData, TextPresenter, TextPresentation } from "./dev-types.ts";
import { withOverlayBackground } from "./overlay.ts";

export const PI_DEV_PRESENTATION_ENTRY = "pi-dev-presentation";

function sessionPresentationData(value: unknown): SessionTextPresentationData {
  if (typeof value !== "object" || value === null) {
    return { version: 1, title: "pi-dev output", body: "Presentation data is unavailable.", warning: true };
  }
  const candidate = value as Partial<SessionTextPresentationData>;
  return {
    version: 1,
    title: typeof candidate.title === "string" ? candidate.title : "pi-dev output",
    body: typeof candidate.body === "string" ? candidate.body : "Presentation data is unavailable.",
    warning: candidate.warning === true,
  };
}

export function registerTextPresentationRenderer(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<SessionTextPresentationData>(PI_DEV_PRESENTATION_ENTRY, (entry, _options, theme) => ({
    render(width: number): string[] {
      const data = sessionPresentationData(entry.data);
      const title = wrapTerminalSafeText(data.title, width)
        .map((line) => theme.fg(data.warning ? "warning" : "accent", theme.bold(line)));
      const note = wrapTerminalSafeText("pi-dev session-only output • not sent to the model", width)
        .map((line) => theme.fg("dim", line));
      return [...title, ...note, "", ...wrapTerminalSafeText(data.body, width)];
    },
    invalidate(): void {},
  }));
}

export function createTextPresenter(pi: ExtensionAPI): TextPresenter {
  return async (ctx, presentation): Promise<void> => {
    if (ctx.mode === "tui" && presentation.delivery === "session-entry") {
      pi.appendEntry<SessionTextPresentationData>(PI_DEV_PRESENTATION_ENTRY, {
        version: 1,
        title: presentation.title,
        body: presentation.body,
        warning: presentation.warning === true,
      });
      return;
    }
    await defaultTextPresenter(ctx, presentation);
  };
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Make raw terminal controls visible without allowing them to affect the TUI. */
export function terminalSafeText(text: string): string {
  // This is intentionally the complete terminal-control range we must neutralize.
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, (character) => {
    if (character === "\t") return "\\t";
    if (character === "\r") return "\\r";
    const code = character.codePointAt(0) ?? 0;
    return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

/** Hard-wrap by terminal display columns while preserving every safe grapheme. */
export function wrapTerminalSafeText(text: string, width: number): string[] {
  const safe = terminalSafeText(text);
  const maximum = Math.max(1, Math.trunc(Number.isFinite(width) ? width : 1));
  const output: string[] = [];
  for (const logicalLine of safe.split("\n")) {
    if (logicalLine === "") {
      output.push("");
      continue;
    }
    let current = "";
    let currentWidth = 0;
    for (const part of graphemes.segment(logicalLine)) {
      const segment = part.segment;
      const segmentWidth = Math.max(0, visibleWidth(segment));
      if (current && currentWidth + segmentWidth > maximum) {
        output.push(current);
        current = "";
        currentWidth = 0;
      }
      current += segment;
      currentWidth += segmentWidth;
    }
    if (current || logicalLine === "") output.push(current);
  }
  return output;
}

class TextViewer {
  private offset = 0;
  private lastLineCount = 0;
  private readonly presentation: TextPresentation;
  private readonly theme: Theme;
  private readonly done: (result: undefined) => void;
  private readonly requestRender: () => void;
  private readonly notify: ExtensionCommandContext["ui"]["notify"];

  constructor(
    presentation: TextPresentation,
    theme: Theme,
    done: (result: undefined) => void,
    requestRender: () => void,
    notify: ExtensionCommandContext["ui"]["notify"],
  ) {
    this.presentation = presentation;
    this.theme = theme;
    this.done = done;
    this.requestRender = requestRender;
    this.notify = notify;
  }

  handleInput(data: string): void {
    if (data === "q" || data === "\u001b" || data === "\r" || data === "\n") {
      this.done(undefined);
      return;
    }
    if (data === "c" && this.presentation.onCopy) {
      void this.copyToClipboard();
      return;
    }
    if (data === "\u001b[A" || data === "k") this.offset = Math.max(0, this.offset - 1);
    if (data === "\u001b[B" || data === "j") this.offset = Math.min(Math.max(0, this.lastLineCount - 1), this.offset + 1);
    if (data === "\u001b[5~") this.offset = Math.max(0, this.offset - 15);
    if (data === "\u001b[6~") this.offset = Math.min(Math.max(0, this.lastLineCount - 1), this.offset + 15);
    this.requestRender();
  }
  private async copyToClipboard(): Promise<void> {
    try {
      await this.presentation.onCopy?.(this.presentation.body);
      this.notify("Copied viewer contents to clipboard.", "info");
    } catch (error) {
      this.notify(error instanceof Error ? error.message : String(error), "error");
    }
  }

  render(width: number): string[] {
    const lines = wrapTerminalSafeText(this.presentation.body, width);
    this.lastLineCount = lines.length;
    this.offset = Math.min(this.offset, Math.max(0, lines.length - 1));
    const visible = lines.slice(this.offset, this.offset + 28);
    const title = wrapTerminalSafeText(this.presentation.title, width)
      .map((line) => this.theme.fg(this.presentation.warning ? "warning" : "accent", this.theme.bold(line)));
    const help = wrapTerminalSafeText(`↑/↓ or j/k scroll • PgUp/PgDn • Enter/Esc/q close${this.presentation.onCopy ? " • c copy" : ""}`, width)
      .map((line) => this.theme.fg("dim", line));
    return [
      ...title,
      this.theme.fg("dim", `lines ${this.offset + 1}-${Math.min(lines.length, this.offset + visible.length)} of ${lines.length}`),
      "",
      ...visible,
      "",
      ...help,
    ];
  }

  invalidate(): void {}
}

export const defaultTextPresenter: TextPresenter = async (ctx: ExtensionCommandContext, presentation: TextPresentation): Promise<void> => {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(`${terminalSafeText(presentation.title)}\n${terminalSafeText(presentation.body)}`, presentation.warning ? "warning" : "info");
    return;
  }
  await ctx.ui.custom<undefined>((tui, theme, _keybindings, done) => withOverlayBackground(new TextViewer(
    presentation,
    theme,
    done,
    () => tui.requestRender(),
    ctx.ui.notify,
  ), theme), { overlay: true });
};
