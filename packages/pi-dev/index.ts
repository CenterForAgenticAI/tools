import { existsSync } from "node:fs";
import { writeFile as writeTextFile } from "node:fs/promises";
import { copyToClipboard, VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDevCommand } from "./src/command.ts";
import {
  CONTEXT_USAGE_SHORTCUT,
  ContextUsageTracker,
  openContextUsageOverlay,
} from "./src/context-usage-ui.ts";
import { registerDemoFeatures } from "./src/demo.ts";
import {
  devModeSkillPaths,
  devModeSystemPrompt,
  PI_DEV_MODE_FLAG,
} from "./src/dev-mode.ts";
import type {
  DevCommandDependencies,
  DevExtensionDependencies,
  DoctorDependencies,
} from "./src/dev-types.ts";
import { EventTraceBuffer, wireEventTrace } from "./src/event-trace.ts";
import { createTextPresenter, registerTextPresentationRenderer } from "./src/presenter.ts";
import { UiDemoController } from "./src/ui-demo.ts";

function doctorDependencies(overrides: DevExtensionDependencies["doctor"]): DoctorDependencies {
  return {
    pathExists: existsSync,
    piVersion: VERSION,
    ...overrides,
  };
}

export function createPiDevExtension(dependencies: DevExtensionDependencies = {}): (pi: ExtensionAPI) => void {
  return (pi) => {
    const trace = new EventTraceBuffer({
      ...(dependencies.eventCapacity !== undefined ? { capacity: dependencies.eventCapacity } : {}),
      ...(dependencies.now !== undefined ? { now: dependencies.now } : {}),
    });
    const uiDemo = new UiDemoController();
    const contextUsage = new ContextUsageTracker();
    const commandDependencies: DevCommandDependencies = {
      present: dependencies.present ?? createTextPresenter(pi),
      openContextUsage: dependencies.openContextUsage
        ?? ((ctx, options) => openContextUsageOverlay(pi, ctx, contextUsage, options)),
      doctor: doctorDependencies(dependencies.doctor),
      copyToClipboard: dependencies.copyToClipboard ?? copyToClipboard,
      writeFile: dependencies.writeFile ?? ((file, data) => writeTextFile(file, data, "utf8")),
      ...(dependencies.readPackageJson ? { readPackageJson: dependencies.readPackageJson } : {}),
    };

    pi.registerFlag(PI_DEV_MODE_FLAG, {
      description: "Contribute Pi extension-authoring guidance and skills to this session.",
      type: "boolean",
      default: false,
    });

    registerDemoFeatures(pi);
    registerTextPresentationRenderer(pi);
    wireEventTrace(pi, trace);

    // Both handlers contribute nothing at all unless the flag was passed, which
    // is what makes the mode genuinely off by default rather than merely quiet.
    pi.on("before_agent_start", (event) => {
      const beforePiDev = event.systemPrompt;
      const systemPrompt = devModeSystemPrompt(pi, beforePiDev);
      contextUsage.capture(event.systemPromptOptions, beforePiDev, systemPrompt ?? beforePiDev);
      return systemPrompt === undefined ? {} : { systemPrompt };
    });
    pi.on("resources_discover", () => {
      const skillPaths = devModeSkillPaths(pi);
      return skillPaths.length === 0 ? {} : { skillPaths };
    });

    pi.on("session_start", (_event, ctx) => {
      contextUsage.clear();
      if (uiDemo.isEnabled()) uiDemo.apply(ctx);
    });
    pi.on("session_shutdown", (_event, ctx) => {
      if (uiDemo.isEnabled()) uiDemo.clear(ctx);
    });
    pi.registerShortcut(CONTEXT_USAGE_SHORTCUT, {
      description: "Open the live context-usage breakdown",
      handler: (ctx) => commandDependencies.openContextUsage(ctx),
    });
    pi.registerCommand("dev", createDevCommand(pi, { trace, uiDemo }, commandDependencies));
  };
}

export default createPiDevExtension();
