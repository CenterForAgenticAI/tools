import type { ExtensionAPI, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { runDemoAction, type DemoAction } from "./demo.ts";
import { formatDoctor, runDoctor } from "./doctor.ts";
import type { DevCommandDependencies, DevSubcommand } from "./dev-types.ts";
import { PI_DEV_VERSION } from "./dev-types.ts";
import type { EventTraceBuffer } from "./event-trace.ts";
import {
  collectObservableSources,
  formatContextInspection,
  formatExtensionsInspection,
  formatPromptInspection,
  formatToolsInspection,
  formatYaml,
} from "./inspect.ts";
import type { UiDemoAction, UiDemoController } from "./ui-demo.ts";

export const DEV_HELP = [
  "pi-dev extension development hub",
  "",
  "/dev help                    show this view",
  "/dev tools [active|all]      exact tool schemas in main transcript",
  "/dev prompt [--write PATH]   effective injected system prompt; optionally save exact text",
  "/dev context                 compaction-aware effective model context",
  "/dev usage                   live hierarchical context-usage sidebar",
  "/dev extensions              observable extension provenance and versions",
  "/dev ui [toggle|on|off|status] demonstrate and restore TUI markers",
  "/dev demo [kind]             messages, entries, tool, dialogs, overlay",
  "/dev events [status|on|off|show [N]|clear] bounded privacy-safe tracing",
  "/dev doctor                  runtime, version, and session diagnostics",
  "",
  "No subcommand defaults to this help view; invalid arguments report the accepted usage.",
].join("\n");

export interface DevCommandState {
  readonly trace: EventTraceBuffer;
  readonly uiDemo: UiDemoController;
}

const SUBCOMMANDS: readonly DevSubcommand[] = [
  "help", "tools", "prompt", "context", "usage", "extensions", "ui", "demo", "events", "doctor",
];

function parseWords(input: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaping = false;
  let started = false;
  for (const character of input) {
    if (escaping) {
      current += character;
      escaping = false;
      started = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaping = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      started = true;
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        words.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }
  if (quote) throw new Error("Unterminated quoted argument.");
  if (escaping) throw new Error("Trailing escape in argument string.");
  if (started) words.push(current);
  return words;
}

function requireNoExtra(args: readonly string[], usage: string): void {
  if (args.length > 0) throw new Error(`Unexpected arguments. Usage: ${usage}`);
}

function isSubcommand(value: string): value is DevSubcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value);
}

function eventReport(trace: EventTraceBuffer, limit: number): string {
  const all = trace.records();
  const selected = all.slice(Math.max(0, all.length - limit));
  return formatYaml({
    enabled: trace.isEnabled(),
    capacity: trace.capacity,
    retained: all.length,
    showing: selected.length,
    records: selected,
  });
}

function parsePositiveLimit(value: string | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!/^\d+$/.test(value)) throw new Error("Event display limit must be a positive integer.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("Event display limit must be a positive integer.");
  return Math.min(parsed, maximum);
}

function completions(prefix: string): Array<{ value: string; label: string }> {
  const words = prefix.trimStart().split(/\s+/);
  const base = words[0] ?? "";
  if (words.length <= 1 && !prefix.endsWith(" ")) {
    return SUBCOMMANDS.filter((name) => name.startsWith(base)).map((name) => ({ value: name, label: name }));
  }
  const choices: Record<string, readonly string[]> = {
    prompt: ["--write"],
    tools: ["active", "all"],
    ui: ["toggle", "on", "off", "status"],
    demo: ["help", "message", "entry", "tool", "dialogs", "overlay", "all"],
    events: ["status", "on", "off", "show", "clear"],
  };
  const subcommand = words[0] ?? "";
  const current = prefix.endsWith(" ") ? "" : words.at(-1) ?? "";
  return (choices[subcommand] ?? [])
    .filter((choice) => choice.startsWith(current))
    .map((choice) => ({ value: `${subcommand} ${choice}`, label: choice }));
}

export function createDevCommand(
  pi: ExtensionAPI,
  state: DevCommandState,
  dependencies: DevCommandDependencies,
): Omit<RegisteredCommand, "name" | "sourceInfo"> {
  return {
    description: "Pi extension development introspection and diagnostics hub",
    getArgumentCompletions: completions,
    handler: async (rawArgs, ctx) => {
      try {
        const words = parseWords(rawArgs);
        const rawRequested = words.shift() ?? "help";
        const requested = rawRequested === "--help" || rawRequested === "-h" ? "help" : rawRequested;
        if (!isSubcommand(requested)) throw new Error(`Unknown /dev subcommand: ${requested}. Run /dev help for usage.`);
        switch (requested) {
          case "help":
            requireNoExtra(words, "/dev help");
            await dependencies.present(ctx, { title: "pi-dev", body: DEV_HELP });
            return;
          case "tools": {
            const scope = words.shift() ?? "active";
            if (scope !== "active" && scope !== "all") throw new Error("Usage: /dev tools [active|all]");
            requireNoExtra(words, "/dev tools [active|all]");
            await dependencies.present(ctx, {
              title: `Agent-visible tools (${scope})`,
              body: formatToolsInspection(pi, scope),
              delivery: "session-entry",
            });
            return;
          }
          case "prompt": {
            const option = words.shift();
            if (option !== undefined && option !== "--write") throw new Error(`Unexpected arguments. Usage: /dev prompt [--write PATH]`);
            const outputFile = option === "--write" ? words.shift() : undefined;
            if (option === "--write" && outputFile === undefined) throw new Error("Usage: /dev prompt [--write PATH]");
            requireNoExtra(words, "/dev prompt [--write PATH]");
            const body = formatPromptInspection(ctx, pi);
            if (outputFile !== undefined) {
              await dependencies.writeFile(outputFile, body);
              ctx.ui.notify(`pi-dev wrote effective system prompt to ${outputFile}`, "info");
            } else {
              await dependencies.present(ctx, {
                title: "Effective system prompt",
                body,
                onCopy: dependencies.copyToClipboard,
              });
            }
            return;
          }
          case "context":
            requireNoExtra(words, "/dev context");
            await dependencies.present(ctx, { title: "Effective model context", body: formatContextInspection(ctx) });
            return;
          case "usage":
            requireNoExtra(words, "/dev usage");
            await dependencies.openContextUsage(ctx, ctx.getSystemPromptOptions());
            return;
          case "extensions":
            requireNoExtra(words, "/dev extensions");
            await dependencies.present(ctx, {
              title: "Observable extensions",
              body: formatExtensionsInspection(
                collectObservableSources(pi, dependencies.readPackageJson),
                { pi: dependencies.doctor.piVersion, piDev: PI_DEV_VERSION },
              ),
            });
            return;
          case "ui": {
            const action = words.shift() ?? "toggle";
            if (!["toggle", "on", "off", "status"].includes(action)) throw new Error("Usage: /dev ui [toggle|on|off|status]");
            requireNoExtra(words, "/dev ui [toggle|on|off|status]");
            const result = state.uiDemo.handle(action as UiDemoAction, ctx);
            ctx.ui.notify(result.message, result.enabled ? "warning" : result.changed ? "info" : "warning");
            return;
          }
          case "demo": {
            const action = words.shift() ?? "help";
            if (!["help", "message", "entry", "tool", "dialogs", "overlay", "all"].includes(action)) {
              throw new Error("Usage: /dev demo [help|message|entry|tool|dialogs|overlay|all]");
            }
            requireNoExtra(words, "/dev demo [kind]");
            await runDemoAction(action as DemoAction, pi, ctx, dependencies.present);
            return;
          }
          case "events": {
            const action = words.shift() ?? "status";
            if (action === "on" || action === "off") {
              requireNoExtra(words, `/dev events ${action}`);
              state.trace.setEnabled(action === "on");
              ctx.ui.notify(`pi-dev event tracing ${action === "on" ? "enabled" : "disabled"}; ${state.trace.records().length}/${state.trace.capacity} records retained.`, "info");
              return;
            }
            if (action === "clear") {
              requireNoExtra(words, "/dev events clear");
              state.trace.clear();
              ctx.ui.notify("pi-dev event trace cleared.", "info");
              return;
            }
            if (action === "status") {
              requireNoExtra(words, "/dev events status");
              ctx.ui.notify(`pi-dev event tracing is ${state.trace.isEnabled() ? "enabled" : "disabled"}; ${state.trace.records().length}/${state.trace.capacity} records retained.`, "info");
              return;
            }
            if (action === "show") {
              const limit = parsePositiveLimit(words.shift(), state.trace.capacity);
              requireNoExtra(words, "/dev events show [N]");
              await dependencies.present(ctx, { title: "Privacy-safe Pi lifecycle events", body: eventReport(state.trace, limit) });
              return;
            }
            throw new Error("Usage: /dev events [status|on|off|show [N]|clear]");
          }
          case "doctor": {
            requireNoExtra(words, "/dev doctor");
            const checks = await runDoctor(pi, ctx, dependencies.doctor);
            await dependencies.present(ctx, {
              title: "pi-dev doctor",
              body: formatDoctor(checks),
              warning: checks.some((check) => check.status !== "pass"),
            });
            return;
          }
        }
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  };
}
