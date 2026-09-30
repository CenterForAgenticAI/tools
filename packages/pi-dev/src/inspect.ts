import { readFileSync } from "node:fs";
import path from "node:path";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, SourceInfo } from "@earendil-works/pi-coding-agent";
import { stringify as stringifyYaml } from "yaml";
import { devModeSystemPrompt } from "./dev-mode.ts";
import type { ObservableSource } from "./dev-types.ts";

export function formatYaml(value: unknown): string {
  return stringifyYaml(value, { lineWidth: 0 }).trimEnd();
}

export function formatToolsInspection(
  pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">,
  scope: "active" | "all" = "active",
): string {
  const activeNames = pi.getActiveTools();
  const active = new Set(activeNames);
  const configured = pi.getAllTools();
  const selected = scope === "active" ? configured.filter((tool) => active.has(tool.name)) : configured;
  const lines = [
    `Active tools (${activeNames.length}): ${activeNames.length > 0 ? activeNames.join(", ") : "none"}`,
    `Configured tools (${configured.length}); showing ${scope} (${selected.length}).`,
  ];

  for (const tool of selected) {
    lines.push(
      "",
      `## ${tool.name} [${active.has(tool.name) ? "active" : "inactive"}]`,
      tool.description,
      `Source: ${tool.sourceInfo.source} (${tool.sourceInfo.scope}/${tool.sourceInfo.origin})`,
      ...(tool.promptGuidelines?.length ? ["Prompt guidelines:", ...tool.promptGuidelines.map((line) => `- ${line}`)] : []),
      "Parameters schema (YAML rendering of exact public ToolInfo.parameters):",
      formatYaml(tool.parameters),
    );
  }
  return lines.join("\n");
}

export function formatPromptInspection(
  ctx: Pick<ExtensionCommandContext, "getSystemPrompt">,
  pi?: Pick<ExtensionAPI, "getFlag">,
): string {
  const prompt = ctx.getSystemPrompt();
  if (!pi) return prompt;
  return devModeSystemPrompt(pi, prompt) ?? prompt;
}

export function formatContextInspection(
  ctx: Pick<ExtensionCommandContext, "getContextUsage" | "sessionManager" | "model">,
): string {
  const entries = ctx.sessionManager.buildContextEntries();
  const messages = entries.flatMap((entry) => sessionEntryToContextMessages(entry));
  return formatYaml({
    note: "Compaction-aware context assembled from public buildContextEntries()/sessionEntryToContextMessages() APIs.",
    usage: ctx.getContextUsage(),
    runtime: {
      model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null,
    },
    entryCount: entries.length,
    entries,
    effectiveMessages: messages,
  });
}

interface MutableObservableSource {
  path: string;
  source: string;
  scope: SourceInfo["scope"];
  origin: SourceInfo["origin"];
  baseDir?: string;
  version?: string;
  tools: string[];
  commands: string[];
}

function sourceKey(source: SourceInfo): string {
  return JSON.stringify([source.path, source.source, source.scope, source.origin, source.baseDir ?? ""]);
}

function packageVersion(directory: string | undefined, readPackageJson: (directory: string) => string): string | undefined {
  if (!directory) return undefined;
  try {
    const parsed: unknown = JSON.parse(readPackageJson(directory));
    if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) return undefined;
    const version = (parsed as { readonly version?: unknown }).version;
    return typeof version === "string" && version.length > 0 ? version : undefined;
  } catch {
    return undefined;
  }
}

export function collectObservableSources(
  pi: Pick<ExtensionAPI, "getAllTools" | "getCommands">,
  readPackageJson: (directory: string) => string = (directory) => readFileSync(path.join(directory, "package.json"), "utf8"),
): readonly ObservableSource[] {
  const grouped = new Map<string, MutableObservableSource>();
  const ensure = (info: SourceInfo): MutableObservableSource => {
    const key = sourceKey(info);
    const prior = grouped.get(key);
    if (prior) return prior;
    const version = packageVersion(info.baseDir, readPackageJson);
    const created: MutableObservableSource = {
      path: info.path,
      source: info.source,
      scope: info.scope,
      origin: info.origin,
      ...(info.baseDir ? { baseDir: info.baseDir } : {}),
      ...(version ? { version } : {}),
      tools: [],
      commands: [],
    };
    grouped.set(key, created);
    return created;
  };

  for (const tool of pi.getAllTools()) ensure(tool.sourceInfo).tools.push(tool.name);
  for (const command of pi.getCommands()) ensure(command.sourceInfo).commands.push(command.name);

  return [...grouped.values()]
    .map((source) => ({
      ...source,
      tools: source.tools.sort(),
      commands: source.commands.sort(),
    }))
    .sort((a, b) => a.source.localeCompare(b.source) || a.path.localeCompare(b.path));
}

export function formatExtensionsInspection(
  sources: readonly ObservableSource[],
  versions: { readonly pi: string; readonly piDev: string },
): string {
  const lines = [
    `Pi ${versions.pi}`,
    `pi-dev ${versions.piDev}`,
    "",
    "Observable extension provenance from public getAllTools()/getCommands() source metadata:",
  ];
  if (sources.length === 0) lines.push("(No tool or command sources are observable.)");
  for (const source of sources) {
    lines.push(
      "",
      `- ${source.source}${source.version ? ` v${source.version}` : ""}`,
      `  path: ${source.path}`,
      `  scope/origin: ${source.scope}/${source.origin}`,
      `  tools: ${source.tools.length > 0 ? source.tools.join(", ") : "none"}`,
      `  commands: ${source.commands.length > 0 ? source.commands.join(", ") : "none"}`,
    );
  }
  lines.push(
    "",
    "Limitation: Pi exposes source metadata for tools and commands, not a complete loaded-extension registry; extensions with neither are not observable here.",
  );
  return lines.join("\n");
}
