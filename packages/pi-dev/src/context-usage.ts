import type {
  sessionEntryToContextMessages,
  BuildSystemPromptOptions,
  ContextUsage,
  SourceInfo,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";

export type ContextMessage = ReturnType<typeof sessionEntryToContextMessages>[number];

export type ContextContributionKind =
  | "system-prompt"
  | "system-core"
  | "system-custom-prompt"
  | "system-append"
  | "system-context-file"
  | "system-skill"
  | "system-tool-snippet"
  | "system-tool-guideline"
  | "system-extension"
  | "tool-definitions"
  | "tool-source"
  | "tool"
  | "tool-description"
  | "tool-schema"
  | "messages"
  | "message-user"
  | "message-assistant-text"
  | "message-assistant-thinking"
  | "message-tool-call"
  | "message-tool-result"
  | "message-extension"
  | "message-shell"
  | "message-compaction"
  | "message-branch-summary";

export interface ContextContribution {
  readonly id: string;
  readonly label: string;
  readonly kind: ContextContributionKind;
  readonly characters: number;
  readonly estimatedTokens: number;
  readonly source?: string;
  readonly detail?: string;
  readonly children: readonly ContextContribution[];
}

export interface PromptContributionStage {
  readonly id: string;
  readonly label: string;
  readonly before: string;
  readonly after: string;
  readonly source?: string;
}

export interface ContextUsageSnapshotInput {
  readonly baseSystemPrompt: string;
  readonly effectiveSystemPrompt: string;
  readonly systemPromptOptions?: BuildSystemPromptOptions;
  readonly promptStages?: readonly PromptContributionStage[];
  readonly activeToolNames: readonly string[];
  readonly tools: readonly ToolInfo[];
  readonly messages: readonly ContextMessage[];
  readonly measuredUsage?: ContextUsage;
  readonly updatedAt?: string;
}

export interface ContextUsageSnapshot {
  readonly updatedAt: string;
  readonly measuredUsage?: ContextUsage;
  readonly estimatedTokens: number;
  readonly sections: readonly [ContextContribution, ContextContribution, ContextContribution];
  readonly notes: readonly string[];
}

interface ContributionCandidate {
  readonly id: string;
  readonly label: string;
  readonly kind: ContextContributionKind;
  readonly text: string;
  readonly source?: string;
  readonly detail?: string;
}

interface MutableAggregate {
  id: string;
  label: string;
  kind: ContextContributionKind;
  characters: number;
  source?: string;
  detail?: string;
}

const ESTIMATED_IMAGE_CHARACTERS = 4_800;

function estimatedTokens(characters: number): number {
  return characters <= 0 ? 0 : Math.ceil(characters / 4);
}

function contribution(
  id: string,
  label: string,
  kind: ContextContributionKind,
  characters: number,
  options: {
    readonly source?: string;
    readonly detail?: string;
    readonly children?: readonly ContextContribution[];
    readonly tokenEstimate?: number;
  } = {},
): ContextContribution {
  return {
    id,
    label,
    kind,
    characters,
    estimatedTokens: options.tokenEstimate ?? estimatedTokens(characters),
    ...(options.source !== undefined ? { source: options.source } : {}),
    ...(options.detail !== undefined ? { detail: options.detail } : {}),
    children: options.children ?? [],
  };
}

function parentContribution(
  id: string,
  label: string,
  kind: ContextContributionKind,
  children: readonly ContextContribution[],
  options: { readonly characters?: number; readonly detail?: string; readonly source?: string; readonly tokenEstimate?: number } = {},
): ContextContribution {
  return contribution(
    id,
    label,
    kind,
    options.characters ?? children.reduce((sum, child) => sum + child.characters, 0),
    {
      ...(options.detail !== undefined ? { detail: options.detail } : {}),
      ...(options.source !== undefined ? { source: options.source } : {}),
      children,
      tokenEstimate: options.tokenEstimate ?? children.reduce((sum, child) => sum + child.estimatedTokens, 0),
    },
  );
}

function sourceName(sourceInfo: SourceInfo | undefined): string | undefined {
  return sourceInfo?.source || undefined;
}

function xmlEscape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function activeToolMap(input: ContextUsageSnapshotInput): Map<string, ToolInfo> {
  const active = new Set(input.activeToolNames);
  return new Map(input.tools.filter((tool) => active.has(tool.name)).map((tool) => [tool.name, tool]));
}

function guidelineSource(guideline: string, tools: ReadonlyMap<string, ToolInfo>): string | undefined {
  const sources = new Set<string>();
  for (const tool of tools.values()) {
    if (tool.promptGuidelines?.some((candidate) => candidate.trim() === guideline)) {
      const source = sourceName(tool.sourceInfo);
      if (source) sources.add(source);
    }
  }
  if (sources.size === 1) return [...sources][0];
  if (sources.size > 1) return "multiple tool sources";
  return undefined;
}

function systemPromptCandidates(
  options: BuildSystemPromptOptions | undefined,
  tools: ReadonlyMap<string, ToolInfo>,
): ContributionCandidate[] {
  if (!options) return [];
  const candidates: ContributionCandidate[] = [];
  if (options.customPrompt) {
    candidates.push({
      id: "system/custom-prompt",
      label: "Custom system prompt",
      kind: "system-custom-prompt",
      text: options.customPrompt,
      source: "Pi configuration",
    });
  }
  if (options.appendSystemPrompt) {
    candidates.push({
      id: "system/append",
      label: "Appended system prompt",
      kind: "system-append",
      text: options.appendSystemPrompt,
      source: "Pi configuration",
    });
  }
  for (const [index, file] of (options.contextFiles ?? []).entries()) {
    candidates.push({
      id: `system/context-file/${index}`,
      label: file.path,
      kind: "system-context-file",
      text: `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>`,
      source: file.path,
      detail: "Loaded context file, including its prompt wrapper.",
    });
  }
  for (const [index, skill] of (options.skills ?? []).filter((item) => !item.disableModelInvocation).entries()) {
    candidates.push({
      id: `system/skill/${index}`,
      label: skill.name,
      kind: "system-skill",
      text: [
        "  <skill>",
        `    <name>${xmlEscape(skill.name)}</name>`,
        `    <description>${xmlEscape(skill.description)}</description>`,
        `    <location>${xmlEscape(skill.filePath)}</location>`,
        "  </skill>",
      ].join("\n"),
      source: sourceName(skill.sourceInfo) ?? skill.filePath,
      detail: "Loaded skill catalog entry. The SKILL.md body is not in the prompt until it is read or invoked.",
    });
  }
  for (const [name, snippet] of Object.entries(options.toolSnippets ?? {})) {
    if (options.selectedTools ? !options.selectedTools.includes(name) : !tools.has(name)) continue;
    const source = sourceName(tools.get(name)?.sourceInfo);
    candidates.push({
      id: `system/tool-snippet/${name}`,
      label: `${name} prompt snippet`,
      kind: "system-tool-snippet",
      text: `- ${name}: ${snippet}`,
      ...(source ? { source } : {}),
    });
  }
  const seenGuidelines = new Set<string>();
  for (const [index, value] of (options.promptGuidelines ?? []).entries()) {
    const guideline = value.trim();
    if (!guideline || seenGuidelines.has(guideline)) continue;
    seenGuidelines.add(guideline);
    const source = guidelineSource(guideline, tools);
    candidates.push({
      id: `system/tool-guideline/${index}`,
      label: "Tool prompt guideline",
      kind: "system-tool-guideline",
      text: `- ${guideline}`,
      ...(source ? { source } : {}),
      detail: guideline,
    });
  }
  return candidates;
}

function claimCandidateSpans(text: string, candidates: readonly ContributionCandidate[]): ContextContribution[] {
  const claimed = new Uint8Array(text.length);
  const matches: Array<{ candidate: ContributionCandidate; start: number }> = [];
  const longestFirst = [...candidates].filter((candidate) => candidate.text.length > 0)
    .sort((left, right) => right.text.length - left.text.length);

  for (const candidate of longestFirst) {
    let from = 0;
    while (from <= text.length - candidate.text.length) {
      const start = text.indexOf(candidate.text, from);
      if (start < 0) break;
      let available = true;
      for (let index = start; index < start + candidate.text.length; index += 1) {
        if (claimed[index] === 1) {
          available = false;
          break;
        }
      }
      if (available) {
        claimed.fill(1, start, start + candidate.text.length);
        matches.push({ candidate, start });
        break;
      }
      from = start + 1;
    }
  }

  return matches.sort((left, right) => left.start - right.start).map(({ candidate }) => contribution(
    candidate.id,
    candidate.label,
    candidate.kind,
    candidate.text.length,
    {
      ...(candidate.source !== undefined ? { source: candidate.source } : {}),
      ...(candidate.detail !== undefined ? { detail: candidate.detail } : {}),
    },
  ));
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

function commonSuffixLength(left: string, right: string, prefix: number): number {
  const limit = Math.min(left.length, right.length) - prefix;
  let suffix = 0;
  while (suffix < limit && left[left.length - suffix - 1] === right[right.length - suffix - 1]) suffix += 1;
  return suffix;
}

function extensionStages(input: ContextUsageSnapshotInput): {
  readonly appendOnly: boolean;
  readonly contributions: readonly ContextContribution[];
} {
  const supplied = input.promptStages ?? [];
  const stages = supplied.length > 0
    ? supplied
    : input.effectiveSystemPrompt === input.baseSystemPrompt
      ? []
      : [{
          id: "unattributed",
          label: "Unattributed extension chain",
          before: input.baseSystemPrompt,
          after: input.effectiveSystemPrompt,
        }];
  let appendOnly = true;
  const nodes: ContextContribution[] = [];
  for (const stage of stages) {
    if (stage.after === stage.before) continue;
    if (stage.after.startsWith(stage.before)) {
      const added = stage.after.length - stage.before.length;
      nodes.push(contribution(stage.id, stage.label, "system-extension", added, {
        ...(stage.source !== undefined ? { source: stage.source } : {}),
        detail: "Append-only change observed in the public before_agent_start chain.",
      }));
      continue;
    }
    appendOnly = false;
    const prefix = commonPrefixLength(stage.before, stage.after);
    const suffix = commonSuffixLength(stage.before, stage.after, prefix);
    const added = stage.after.length - prefix - suffix;
    const removed = stage.before.length - prefix - suffix;
    nodes.push(contribution(stage.id, `${stage.label} (rewrite)`, "system-extension", added, {
      ...(stage.source !== undefined ? { source: stage.source } : {}),
      detail: `This stage rewrote the prompt: ${added} characters added and ${removed} removed or replaced.`,
    }));
  }
  if (!appendOnly) {
    return {
      appendOnly: false,
      contributions: nodes.map((node) => ({
        ...node,
        characters: 0,
        estimatedTokens: 0,
        detail: `${node.detail ?? "Prompt stage observed."} Its size is not allocated because the chain contains an arbitrary rewrite.`,
      })),
    };
  }
  return {
    appendOnly: true,
    contributions: nodes,
  };
}

function buildSystemPromptSection(input: ContextUsageSnapshotInput, tools: ReadonlyMap<string, ToolInfo>): ContextContribution {
  const stages = extensionStages(input);
  let baseChildren: ContextContribution[];
  if (stages.appendOnly) {
    const attributed = claimCandidateSpans(
      input.baseSystemPrompt,
      systemPromptCandidates(input.systemPromptOptions, tools),
    );
    const attributedCharacters = attributed.reduce((sum, node) => sum + node.characters, 0);
    const coreCharacters = Math.max(0, input.baseSystemPrompt.length - attributedCharacters);
    baseChildren = [
      contribution(
        "system/core",
        "Pi scaffold and unattributed prompt text",
        "system-core",
        coreCharacters,
        { detail: "Prompt text not attributable to one structured public input." },
      ),
      ...attributed,
    ];
  } else {
    baseChildren = [contribution(
      "system/retained",
      "Final prompt after rewrite (unattributed)",
      "system-core",
      input.effectiveSystemPrompt.length,
      { detail: "Structured attribution is suppressed because an extension rewrote or replaced the base prompt." },
    )];
  }
  return parentContribution(
    "system",
    "System prompt",
    "system-prompt",
    [...baseChildren, ...stages.contributions],
    {
      characters: input.effectiveSystemPrompt.length,
      tokenEstimate: estimatedTokens(input.effectiveSystemPrompt.length),
      detail: "Character spans are exact for append-only prompt chains; token counts use Pi's chars/4 estimate.",
    },
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function buildToolSection(tools: ReadonlyMap<string, ToolInfo>, activeOrder: readonly string[]): ContextContribution {
  const bySource = new Map<string, { source: string; detail: string; tools: ContextContribution[] }>();
  for (const name of activeOrder) {
    const tool = tools.get(name);
    if (!tool) continue;
    const source = sourceName(tool.sourceInfo) ?? "unknown source";
    const key = JSON.stringify([source, tool.sourceInfo.path]);
    const group = bySource.get(key) ?? { source, detail: tool.sourceInfo.path, tools: [] };
    const description = contribution(`${name}/description`, "Description", "tool-description", tool.description.length);
    const schemaText = safeJson(tool.parameters);
    const schema = contribution(`${name}/schema`, "Parameters schema", "tool-schema", schemaText.length);
    group.tools.push(parentContribution(
      `tool/${name}`,
      name,
      "tool",
      [description, schema],
      { source, detail: tool.sourceInfo.path },
    ));
    bySource.set(key, group);
  }
  const sourceNodes = [...bySource.values()].map((group, index) => parentContribution(
    `tool-source/${index}`,
    group.source,
    "tool-source",
    group.tools,
    { source: group.source, detail: group.detail },
  ));
  return parentContribution(
    "tools",
    "Active tool definitions",
    "tool-definitions",
    sourceNodes,
    { detail: "Descriptions and exact public parameter schemas only; provider-specific wrappers are unavailable." },
  );
}

function contentCharacters(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let characters = 0;
  for (const block of content) {
    if (typeof block !== "object" || block === null || !("type" in block)) continue;
    if (block.type === "text" && "text" in block && typeof block.text === "string") characters += block.text.length;
    if (block.type === "image") characters += ESTIMATED_IMAGE_CHARACTERS;
  }
  return characters;
}

function addAggregate(
  aggregates: Map<string, MutableAggregate>,
  value: Omit<MutableAggregate, "characters"> & { readonly characters: number },
): void {
  if (value.characters <= 0) return;
  const key = JSON.stringify([value.kind, value.label, value.source ?? ""]);
  const prior = aggregates.get(key);
  if (prior) {
    prior.characters += value.characters;
    return;
  }
  aggregates.set(key, { ...value });
}

function messageSource(toolName: string, tools: ReadonlyMap<string, ToolInfo>): string | undefined {
  return sourceName(tools.get(toolName)?.sourceInfo);
}

function buildMessageSection(messages: readonly ContextMessage[], tools: ReadonlyMap<string, ToolInfo>): ContextContribution {
  const aggregates = new Map<string, MutableAggregate>();
  for (const message of messages) {
    switch (message.role) {
      case "user":
        addAggregate(aggregates, {
          id: "messages/user",
          label: "User text and images",
          kind: "message-user",
          characters: contentCharacters(message.content),
        });
        break;
      case "assistant":
        for (const block of message.content) {
          if (block.type === "text") {
            addAggregate(aggregates, {
              id: "messages/assistant-text",
              label: "Assistant text",
              kind: "message-assistant-text",
              characters: block.text.length,
            });
          } else if (block.type === "thinking") {
            addAggregate(aggregates, {
              id: "messages/assistant-thinking",
              label: "Assistant reasoning",
              kind: "message-assistant-thinking",
              characters: block.thinking.length,
            });
          } else if (block.type === "toolCall") {
            const source = messageSource(block.name, tools);
            addAggregate(aggregates, {
              id: `messages/tool-call/${block.name}`,
              label: `Tool calls: ${block.name}`,
              kind: "message-tool-call",
              characters: block.name.length + safeJson(block.arguments).length,
              ...(source ? { source } : {}),
            });
          }
        }
        break;
      case "toolResult":
        {
          const source = messageSource(message.toolName, tools);
          addAggregate(aggregates, {
            id: `messages/tool-result/${message.toolName}`,
            label: `Tool results: ${message.toolName}`,
            kind: "message-tool-result",
            characters: contentCharacters(message.content),
            ...(source ? { source } : {}),
          });
          break;
        }
      case "custom":
        addAggregate(aggregates, {
          id: `messages/extension/${message.customType}`,
          label: `Custom messages: ${message.customType}`,
          kind: "message-extension",
          characters: contentCharacters(message.content),
        });
        break;
      case "bashExecution":
        addAggregate(aggregates, {
          id: "messages/shell",
          label: "Direct shell commands and output",
          kind: "message-shell",
          characters: message.command.length + message.output.length,
        });
        break;
      case "compactionSummary":
        addAggregate(aggregates, {
          id: "messages/compaction",
          label: "Compaction summaries",
          kind: "message-compaction",
          characters: message.summary.length,
        });
        break;
      case "branchSummary":
        addAggregate(aggregates, {
          id: "messages/branch-summary",
          label: "Branch summaries",
          kind: "message-branch-summary",
          characters: message.summary.length,
        });
        break;
    }
  }
  const children = [...aggregates.values()].map((item) => contribution(
    item.id,
    item.label,
    item.kind,
    item.characters,
    {
      ...(item.source !== undefined ? { source: item.source } : {}),
      ...(item.detail !== undefined ? { detail: item.detail } : {}),
    },
  ));
  return parentContribution(
    "messages",
    "Compaction-aware messages",
    "messages",
    children,
    { detail: "Current active branch only, split by semantic content." },
  );
}

export function buildContextUsageSnapshot(input: ContextUsageSnapshotInput): ContextUsageSnapshot {
  const tools = activeToolMap(input);
  const sections = [
    buildSystemPromptSection(input, tools),
    buildToolSection(tools, input.activeToolNames),
    buildMessageSection(input.messages, tools),
  ] as const;
  const snapshot: ContextUsageSnapshot = {
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    ...(input.measuredUsage !== undefined ? { measuredUsage: input.measuredUsage } : {}),
    estimatedTokens: sections.reduce((sum, section) => sum + section.estimatedTokens, 0),
    sections,
    notes: [
      "Token allocation uses Pi's conservative chars/4 heuristic; the provider's tokenizer (its text-to-token conversion rules) and serialization can differ.",
      "Images have no character length; each image uses a 4,800-character stand-in, or about 1,200 local estimated tokens.",
      "The latest provider context total is kept separate from this local allocation estimate rather than scaled into false precision.",
      "Pi's public API does not expose per-extension source metadata for before_agent_start handlers. pi-dev labels its own stage, groups later changes, and leaves earlier prompt-chain text unattributed.",
      "Skill rows measure catalog definitions in the system prompt, not full SKILL.md bodies. Tool rows omit provider-specific schema wrappers that public APIs do not expose.",
    ],
  };
  return snapshot;
}
