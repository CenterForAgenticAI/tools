import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TextPresenter } from "./dev-types.ts";
import { withOverlayBackground } from "./overlay.ts";
import { PI_DEV_DEMO_STATUS_KEY } from "./ui-keys.ts";

// Re-bound as a module-scope constant on purpose; see the note in src/ui-demo.ts.
// The cross-repository UI-surface checker cannot resolve an imported binding used
// directly at a call site, and reports it as a non-failing `<unresolved>` finding.
const DEMO_STATUS_KEY = PI_DEV_DEMO_STATUS_KEY;

export type DemoAction = "help" | "message" | "entry" | "tool" | "dialogs" | "overlay" | "all";

interface DemoDetails {
  readonly kind: string;
  readonly createdAt: string;
}

function oneLine(theme: Theme, prefix: string, content: string): { render(width: number): string[]; invalidate(): void } {
  return {
    render: (width) => [theme.fg("accent", prefix) + " " + content.slice(0, Math.max(0, width - prefix.length - 1))],
    invalidate() {},
  };
}

export function demoEcho(text: string, uppercase: boolean): string {
  const value = uppercase ? text.toUpperCase() : text;
  return `pi-dev demo echo: ${value}`;
}

export function registerDemoFeatures(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<DemoDetails>("pi-dev-demo-message", (message, { expanded }, theme) => {
    const detail = expanded && message.details?.createdAt ? ` (${message.details.createdAt})` : "";
    return oneLine(theme, "[pi-dev message]", `${typeof message.content === "string" ? message.content : "structured content"}${detail}`);
  });
  pi.registerEntryRenderer<DemoDetails>("pi-dev-demo-entry", (entry, { expanded }, theme) => {
    const detail = expanded && entry.data?.createdAt ? ` (${entry.data.createdAt})` : "";
    return oneLine(theme, "[pi-dev entry]", `${entry.data?.kind ?? "demo"}${detail}`);
  });
  pi.registerTool({
    name: "pi_dev_demo",
    label: "Pi dev demo",
    description: "Echo text through the pi-dev demonstration tool.",
    promptSnippet: "Exercise the pi-dev tool registration and rendering path.",
    parameters: Type.Object({
      text: Type.String({ description: "Text to echo." }),
      uppercase: Type.Optional(Type.Boolean({ description: "Uppercase the echoed text." })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
      const text = demoEcho(params.text, params.uppercase ?? false);
      return { content: [{ type: "text", text }], details: { echoed: true } };
    },
  });
}

async function showOverlay(ctx: ExtensionCommandContext): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("The overlay demonstration requires TUI mode.", "warning");
    return;
  }
  await ctx.ui.custom<undefined>((_tui, theme, _keybindings, done) => withOverlayBackground({
    handleInput(data: string) {
      if (data === "\u001b" || data === "\r" || data === "\n" || data === "q") done(undefined);
    },
    invalidate() {},
    render: () => [
      theme.fg("accent", "╭─ pi-dev overlay ─╮"),
      "│ Public ctx.ui.custom API │",
      theme.fg("dim", "╰─ Enter/Esc/q closes ─╯"),
    ],
  }, theme), { overlay: true });
}

async function showDialogs(ctx: ExtensionCommandContext, present: TextPresenter): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("The dialog demonstration requires a UI-capable mode.", "warning");
    return;
  }
  const selected = await ctx.ui.select("pi-dev select demo", ["alpha", "beta", "cancel"]);
  const input = await ctx.ui.input("pi-dev input demo", "Type sample text");
  const confirmed = await ctx.ui.confirm("pi-dev confirm demo", "Confirm the dialog round trip?");
  await present(ctx, {
    title: "pi-dev dialog results",
    body: JSON.stringify({ selected: selected ?? null, input: input ?? null, confirmed }, null, 2),
  });
}

async function runOne(action: Exclude<DemoAction, "all">, pi: ExtensionAPI, ctx: ExtensionCommandContext, present: TextPresenter): Promise<void> {
  const now = new Date().toISOString();
  switch (action) {
    case "help":
      await present(ctx, {
        title: "pi-dev demonstrations",
        body: [
          "/dev demo message  custom message + renderer (participates in model context)",
          "/dev demo entry    durable custom entry + renderer (not sent to model)",
          "/dev demo tool     preview the registered pi_dev_demo tool behavior",
          "/dev demo dialogs  select/input/confirm UI APIs",
          "/dev demo overlay  custom overlay API",
          "/dev demo all      run all demonstrations in sequence",
        ].join("\n"),
      });
      return;
    case "message":
      pi.sendMessage({ customType: "pi-dev-demo-message", content: "Custom message rendering demonstration", display: true, details: { kind: "message", createdAt: now } });
      ctx.ui.notify("pi-dev custom message appended (and visible to the model context).", "info");
      return;
    case "entry":
      pi.appendEntry("pi-dev-demo-entry", { kind: "durable entry rendering demonstration", createdAt: now });
      ctx.ui.notify("pi-dev custom entry appended (not sent to the model).", "info");
      return;
    case "tool":
      await present(ctx, { title: "pi_dev_demo result", body: demoEcho("public tool execution path", false) });
      return;
    case "dialogs":
      await showDialogs(ctx, present);
      return;
    case "overlay":
      await showOverlay(ctx);
      return;
  }
}

export async function runDemoAction(
  action: DemoAction,
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  present: TextPresenter,
): Promise<void> {
  if (action !== "all") {
    await runOne(action, pi, ctx, present);
    return;
  }
  const steps = [
    ["message", "custom message renderer"],
    ["entry", "durable custom entry renderer"],
    ["tool", "registered tool preview"],
    ["dialogs", "select, input, and confirm dialogs"],
    ["overlay", "custom overlay"],
  ] as const;
  try {
    for (const [index, [part, label]] of steps.entries()) {
      const progress = `${index + 1}/${steps.length}: ${label}`;
      ctx.ui.setStatus(DEMO_STATUS_KEY, progress);
      ctx.ui.notify(`pi-dev demo ${progress}.`, "info");
      await runOne(part, pi, ctx, present);
    }
  } finally {
    ctx.ui.setStatus(DEMO_STATUS_KEY, undefined);
  }
  ctx.ui.notify("pi-dev demo complete.", "info");
}
