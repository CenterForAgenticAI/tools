import assert from "node:assert/strict";
import test from "node:test";
import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import {
  buildContextUsageSnapshot,
  type ContextContribution,
  type ContextMessage,
} from "../src/context-usage.ts";

function flatten(nodes: readonly ContextContribution[]): ContextContribution[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

function findKind(nodes: readonly ContextContribution[], kind: ContextContribution["kind"]): ContextContribution[] {
  return flatten(nodes).filter((node) => node.kind === kind);
}

function options(): BuildSystemPromptOptions {
  return {
    cwd: "/tmp/project",
    selectedTools: ["read"],
    toolSnippets: { read: "Read files" },
    promptGuidelines: ["Guide"],
    appendSystemPrompt: "APPEND",
    contextFiles: [{ path: "/tmp/A.md", content: "ABCDEF" }],
    skills: [{
      name: "sample-skill",
      description: "Sample <skill>",
      filePath: "/tmp/sample/SKILL.md",
      baseDir: "/tmp/sample",
      sourceInfo: { path: "/tmp/sample/SKILL.md", source: "sample-package", scope: "user", origin: "package" },
      disableModelInvocation: false,
    }],
  } as never;
}

function basePrompt(): string {
  return [
    "PI CORE",
    "- read: Read files",
    "- Guide",
    "",
    "APPEND",
    "<project_instructions path=\"/tmp/A.md\">\nABCDEF\n</project_instructions>",
    "  <skill>\n    <name>sample-skill</name>\n    <description>Sample &lt;skill&gt;</description>\n    <location>/tmp/sample/SKILL.md</location>\n  </skill>",
    "Current working directory: /tmp/project",
  ].join("\n");
}

function emptySnapshot(
  overrides: Partial<Parameters<typeof buildContextUsageSnapshot>[0]> = {},
  includeSystemPromptOptions = true,
) {
  const base = basePrompt();
  return buildContextUsageSnapshot({
    baseSystemPrompt: base,
    effectiveSystemPrompt: base,
    ...(includeSystemPromptOptions ? { systemPromptOptions: options() } : {}),
    activeToolNames: [],
    tools: [],
    messages: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

test("partitions the system prompt into structured Pi inputs and extension additions", () => {
  const base = basePrompt();
  const effective = `${base}\nEXTENSION`;
  const snapshot = emptySnapshot({
    effectiveSystemPrompt: effective,
    promptStages: [{ id: "extensions-after", label: "Later extension chain", before: base, after: effective }],
    measuredUsage: { tokens: 321, contextWindow: 10_000, percent: 3.21 },
  });

  assert.equal(snapshot.updatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(snapshot.measuredUsage?.tokens, 321);
  assert.equal(snapshot.sections[0].characters, effective.length);
  assert.equal(snapshot.sections[0].children.reduce((sum, node) => sum + node.characters, 0), effective.length);
  assert.equal(findKind(snapshot.sections, "system-append")[0]?.characters, 6);
  assert.equal(findKind(snapshot.sections, "system-context-file")[0]?.source, "/tmp/A.md");
  assert.equal(findKind(snapshot.sections, "system-skill")[0]?.source, "sample-package");
  assert.equal(findKind(snapshot.sections, "system-tool-snippet")[0]?.characters, 18);
  assert.equal(findKind(snapshot.sections, "system-tool-guideline")[0]?.characters, 7);
  assert.equal(findKind(snapshot.sections, "system-extension")[0]?.characters, 10);
  assert.ok(findKind(snapshot.sections, "system-core")[0]?.characters);
});
test("attributes prompt snippets when Pi uses its default selected tools", () => {
  const { selectedTools: _selectedTools, ...defaultedOptions } = options();
  const snapshot = emptySnapshot({
    systemPromptOptions: defaultedOptions as never,
    activeToolNames: ["read"],
    tools: [{
      name: "read",
      description: "Read",
      parameters: { type: "object" },
      sourceInfo: { path: "/builtin/read.ts", source: "builtin", scope: "builtin", origin: "builtin" },
    }] as never,
  });

  assert.equal(findKind(snapshot.sections, "system-tool-snippet")[0]?.characters, 18);
});


test("reports arbitrary extension rewrites without pretending they are append-only attribution", () => {
  const snapshot = emptySnapshot({
    baseSystemPrompt: "ORIGINAL BASE",
    effectiveSystemPrompt: "REPLACED",
    promptStages: [{ id: "rewriter", label: "Extension chain", before: "ORIGINAL BASE", after: "REPLACED" }],
  }, false);

  const extension = findKind(snapshot.sections, "system-extension")[0];
  assert.ok(extension);
  assert.match(extension.detail ?? "", /rewrote|removed|replacement/i);
  assert.equal(snapshot.sections[0].characters, 8);
  assert.ok(snapshot.notes.some((note) => /per-extension source metadata/i.test(note)));
});
test("does not allocate transient extension text after an arbitrary prompt rewrite", () => {
  const snapshot = emptySnapshot({
    baseSystemPrompt: "BASE",
    effectiveSystemPrompt: "FINAL",
    promptStages: [
      { id: "append", label: "Appender", before: "BASE", after: "BASE\nTEMP" },
      { id: "rewrite", label: "Rewriter", before: "BASE\nTEMP", after: "FINAL" },
    ],
  }, false);
  const system = snapshot.sections[0];
  const extensions = findKind(snapshot.sections, "system-extension");

  assert.equal(system.characters, 5);
  assert.equal(system.children.reduce((sum, node) => sum + node.characters, 0), 5);
  assert.deepEqual(extensions.map((node) => node.characters), [0, 0]);
  assert.match(extensions[1]?.label ?? "", /rewrite/i);
});


test("splits active tool definitions into descriptions and schemas under their public source", () => {
  const snapshot = emptySnapshot({
    activeToolNames: ["read"],
    tools: [
      {
        name: "read",
        description: "Read",
        parameters: { type: "object" },
        sourceInfo: { path: "/pkg/read.ts", source: "sample-extension", scope: "user", origin: "package" },
      },
      {
        name: "inactive",
        description: "Do not count this",
        parameters: { type: "object", properties: { value: { type: "string" } } },
        sourceInfo: { path: "/pkg/inactive.ts", source: "sample-extension", scope: "user", origin: "package" },
      },
    ] as never,
  });

  const descriptions = findKind(snapshot.sections, "tool-description");
  const schemas = findKind(snapshot.sections, "tool-schema");
  assert.deepEqual(descriptions.map((node) => [node.label, node.characters]), [["Description", 4]]);
  assert.deepEqual(schemas.map((node) => [node.label, node.characters]), [["Parameters schema", 17]]);
  assert.equal(findKind(snapshot.sections, "tool-source")[0]?.source, "sample-extension");
  assert.doesNotMatch(JSON.stringify(snapshot.sections[1]), /inactive|Do not count this/);
});

test("breaks messages down by semantic content, tool, and custom message type rather than role alone", () => {
  const messages = [
    { role: "user", content: "12345678", timestamp: 0 },
    {
      role: "assistant",
      content: [
        { type: "text", text: "1234" },
        { type: "thinking", thinking: "abcdefgh" },
        { type: "toolCall", id: "call", name: "read", arguments: { x: "12345" } },
      ],
      api: "test",
      provider: "test",
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: 0,
    },
    { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "abcdefghijkl" }], isError: false, timestamp: 0 },
    { role: "custom", customType: "arbitrary-custom-message-discriminator", content: "12345678", display: false, timestamp: 0 },
    { role: "compactionSummary", summary: "12345678", tokensBefore: 100, timestamp: 0 },
  ] as ContextMessage[];

  const snapshot = emptySnapshot({
    messages,
    activeToolNames: ["read"],
    tools: [{
      name: "read",
      description: "Read",
      parameters: { type: "object" },
      sourceInfo: { path: "/pkg/read.ts", source: "sample-extension", scope: "user", origin: "package" },
    }] as never,
  });

  assert.equal(findKind(snapshot.sections, "message-user")[0]?.estimatedTokens, 2);
  assert.equal(findKind(snapshot.sections, "message-assistant-text")[0]?.estimatedTokens, 1);
  assert.equal(findKind(snapshot.sections, "message-assistant-thinking")[0]?.estimatedTokens, 2);
  assert.equal(findKind(snapshot.sections, "message-tool-call")[0]?.estimatedTokens, 5);
  assert.equal(findKind(snapshot.sections, "message-tool-result")[0]?.source, "sample-extension");
  const customMessage = findKind(snapshot.sections, "message-extension")[0];
  assert.ok(customMessage);
  assert.equal(customMessage.source, undefined);
  assert.equal(Object.hasOwn(customMessage, "source"), false);
  assert.equal(customMessage.label, "Custom messages: arbitrary-custom-message-discriminator");
  assert.equal(findKind(snapshot.sections, "message-compaction")[0]?.estimatedTokens, 2);
});

test("keeps the latest provider total separate from the local allocation estimate", () => {
  const snapshot = emptySnapshot({
    measuredUsage: { tokens: 9_999, contextWindow: 20_000, percent: 49.995 },
    messages: [{ role: "user", content: "12345678", timestamp: 0 }] as ContextMessage[],
  });

  assert.equal(snapshot.measuredUsage?.tokens, 9_999);
  assert.notEqual(snapshot.estimatedTokens, 9_999);
  assert.ok(snapshot.notes.some((note) => /chars\/4|tokenizer|provider/i.test(note)));
});
