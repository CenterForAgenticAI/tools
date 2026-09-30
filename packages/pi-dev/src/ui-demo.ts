import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  PI_DEV_ABOVE_WIDGET_KEY,
  PI_DEV_BELOW_WIDGET_KEY,
  PI_DEV_UI_STATUS_KEY,
} from "./ui-keys.ts";

// Re-bound as module-scope constants on purpose. The cross-repository UI-surface
// checker resolves a key from a string literal or a local `const`, but it does not
// follow an imported binding used directly at the call site: such a key is reported
// as `<unresolved>`, which is a non-failing finding and therefore a silent blind
// spot. Binding them here keeps `src/ui-keys.ts` the single source of truth while
// leaving every key mechanically visible to that checker.
const UI_STATUS_KEY = PI_DEV_UI_STATUS_KEY;
const ABOVE_WIDGET_KEY = PI_DEV_ABOVE_WIDGET_KEY;
const BELOW_WIDGET_KEY = PI_DEV_BELOW_WIDGET_KEY;

export type UiDemoAction = "on" | "off" | "toggle" | "status";

export interface UiDemoResult {
  readonly enabled: boolean;
  readonly changed: boolean;
  readonly message: string;
}

export class UiDemoController {
  private enabled = false;

  isEnabled(): boolean {
    return this.enabled;
  }

  apply(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    ctx.ui.setHeader((_tui, theme) => ({
      invalidate() {},
      render: () => [
        theme.fg("accent", "π pi-dev — extension development UI"),
        theme.fg("dim", "Header marker installed by /dev ui; /dev ui off restores the built-in header."),
      ],
    }));
    ctx.ui.setFooter((_tui, theme, footerData) => ({
      invalidate() {},
      render: () => [
        theme.fg("dim", `pi-dev footer • ${footerData.getGitBranch() ?? "no branch"} • ${ctx.model?.id ?? "no model"}`),
      ],
    }));
    ctx.ui.setStatus(UI_STATUS_KEY, "dev UI on");
    ctx.ui.setWidget(ABOVE_WIDGET_KEY, ["[pi-dev] above-editor widget"], { placement: "aboveEditor" });
    ctx.ui.setWidget(BELOW_WIDGET_KEY, ["[pi-dev] below-editor widget"], { placement: "belowEditor" });
    ctx.ui.setTitle("pi-dev UI demo");
    ctx.ui.setWorkingMessage("pi-dev working area");
    ctx.ui.setWorkingIndicator({ frames: ["◇", "◆"], intervalMs: 300 });
    ctx.ui.setHiddenThinkingLabel("pi-dev hidden thinking");
  }

  clear(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    ctx.ui.setHeader(undefined);
    ctx.ui.setFooter(undefined);
    ctx.ui.setStatus(UI_STATUS_KEY, undefined);
    ctx.ui.setWidget(ABOVE_WIDGET_KEY, undefined);
    ctx.ui.setWidget(BELOW_WIDGET_KEY, undefined);
    // The public UI API has no title getter or clear operation. "pi" is the
    // built-in title, so this restores Pi rather than leaving our marker behind.
    ctx.ui.setTitle("pi");
    ctx.ui.setWorkingMessage();
    ctx.ui.setWorkingIndicator();
    ctx.ui.setHiddenThinkingLabel();
  }

  handle(action: UiDemoAction, ctx: ExtensionCommandContext): UiDemoResult {
    if (ctx.mode !== "tui") {
      return { enabled: this.enabled, changed: false, message: "The UI demonstration requires TUI mode." };
    }
    if (action === "status") {
      return {
        enabled: this.enabled,
        changed: false,
        message: `Pi development UI markers are ${this.enabled ? "enabled" : "disabled"}.`,
      };
    }
    const target = action === "toggle" ? !this.enabled : action === "on";
    if (target === this.enabled) {
      return {
        enabled: this.enabled,
        changed: false,
        message: `Pi development UI markers are already ${this.enabled ? "enabled" : "disabled"}.`,
      };
    }
    this.enabled = target;
    if (target) {
      this.apply(ctx);
      return { enabled: true, changed: true, message: "Pi development UI markers enabled. Public Pi APIs cannot preserve global UI factories previously installed by another extension; /dev ui off restores Pi defaults." };
    }
    this.clear(ctx);
    return { enabled: false, changed: true, message: "Pi development UI markers cleared." };
  }
}
