import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildContextUsageSnapshot, type ContextMessage, type ContextUsageSnapshot } from "../src/context-usage.ts";
import {
  collectContextUsageSnapshot,
  CONTEXT_USAGE_REFRESH_MS,
  ContextUsageOverlay,
  ContextUsageTracker,
  contextUsageDisplayRows,
  openContextUsageOverlay,
} from "../src/context-usage-ui.ts";
import { withOverlayBackground } from "../src/overlay.ts";

function promptOptions() {
  return {
    cwd: "/tmp/project",
    selectedTools: ["read"],
    toolSnippets: { read: "Read files" },
    contextFiles: [{ path: "/tmp/AGENTS.md", content: "Project rules" }],
    skills: [],
  };
}

function toolInfo() {
  return [{
    name: "read",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    sourceInfo: { path: "/extensions/files.ts", source: "files-extension", scope: "user", origin: "package" },
  }] as never;
}

function snapshot(tokens: number, userText = "hello"): ContextUsageSnapshot {
  return buildContextUsageSnapshot({
    baseSystemPrompt: "BASE",
    effectiveSystemPrompt: "BASE\nEXTENSION",
    promptStages: [{
      id: "extension",
      label: "Extension chain",
      before: "BASE",
      after: "BASE\nEXTENSION",
      source: "sample-extension",
    }],
    activeToolNames: ["read"],
    tools: toolInfo(),
    messages: [{ role: "user", content: userText, timestamp: 0 }] as ContextMessage[],
    measuredUsage: { tokens, contextWindow: 1_000, percent: tokens / 10 },
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
}

function snapshotWithTools(count: number): ContextUsageSnapshot {
  const tools = Array.from({ length: count }, (_, index) => ({
    name: `tool-${index}`,
    description: `Tool ${index}`,
    parameters: { type: "object" },
    sourceInfo: { path: "/extensions/tools.ts", source: "tools-extension", scope: "user", origin: "package" },
  }));
  return buildContextUsageSnapshot({
    baseSystemPrompt: "BASE",
    effectiveSystemPrompt: "BASE",
    activeToolNames: tools.map((tool) => tool.name),
    tools: tools as never,
    messages: [],
    measuredUsage: { tokens: 100, contextWindow: 1_000, percent: 10 },
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
}

function snapshotWithSources(): ContextUsageSnapshot {
  const tools = [
    {
      name: "a-small",
      description: "A",
      parameters: { type: "object" },
      sourceInfo: { path: "/extensions/a.ts", source: "a-source", scope: "user", origin: "package" },
    },
    {
      name: "z-medium",
      description: "M".repeat(100),
      parameters: { type: "object" },
      sourceInfo: { path: "/extensions/a.ts", source: "a-source", scope: "user", origin: "package" },
    },
    {
      name: "z-large",
      description: "Z".repeat(400),
      parameters: { type: "object", properties: { value: { type: "string" } } },
      sourceInfo: { path: "/extensions/z.ts", source: "z-source", scope: "user", origin: "package" },
    },
  ];
  return buildContextUsageSnapshot({
    baseSystemPrompt: "BASE",
    effectiveSystemPrompt: "BASE",
    activeToolNames: tools.map((tool) => tool.name),
    tools: tools as never,
    messages: [],
    measuredUsage: { tokens: 100, contextWindow: 1_000, percent: 10 },
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
}

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as never;

test("overlay background forwards disposal to stop live refresh work", () => {
  let disposed = 0;
  const wrapped = withOverlayBackground({
    render: () => [""],
    invalidate() {},
    dispose: () => { disposed += 1; },
  }, theme);

  wrapped.dispose?.();

  assert.equal(disposed, 1);
});

test("overlay background adds Pi-standard full-width borders", () => {
  const wrapped = withOverlayBackground({
    render: () => ["body"],
    invalidate() {},
  }, theme);

  const lines = wrapped.render(12);

  assert.equal(lines[0], "─".repeat(12));
  assert.equal(lines.at(-1), "─".repeat(12));
});

test("tracks the observable prompt stages without inventing extension identities", () => {
  const tracker = new ContextUsageTracker();
  const options = promptOptions();
  const beforePiDev = "PI CORE\nPRIOR EXTENSION TEXT";
  const afterPiDev = `${beforePiDev}\nPI DEV`;
  const effective = `${afterPiDev}\nLATER`;

  tracker.capture(options, beforePiDev, afterPiDev);
  const state = tracker.state(effective);

  assert.equal(state.baseSystemPrompt, beforePiDev);
  assert.equal(state.options, options);
  assert.deepEqual(state.stages.map((stage) => [stage.label, stage.source]), [
    ["@caair/pi-dev", "@caair/pi-dev"],
    ["Extensions after pi-dev", undefined],
  ]);
  assert.deepEqual(state.stages.map((stage) => [stage.before, stage.after]), [
    [beforePiDev, afterPiDev],
    [afterPiDev, effective],
  ]);

  tracker.clear();
  assert.deepEqual(tracker.state("NO CAPTURE"), {
    baseSystemPrompt: "NO CAPTURE",
    stages: [],
  });
});

test("collects a fresh compaction-aware snapshot from public runtime APIs", () => {
  const tracker = new ContextUsageTracker();
  const options = promptOptions();
  const beforePiDev = [
    "PI CORE",
    "- read: Read files",
    "<project_instructions path=\"/tmp/AGENTS.md\">\nProject rules\n</project_instructions>",
  ].join("\n");
  tracker.capture(options, beforePiDev, beforePiDev);
  const effective = `${beforePiDev}\nLATER`;
  const pi = {
    getActiveTools: () => ["read"],
    getAllTools: toolInfo,
  };
  const ctx = {
    getSystemPrompt: () => effective,
    getContextUsage: () => ({ tokens: 42, contextWindow: 1_000, percent: 4.2 }),
    sessionManager: {
      buildContextEntries: () => [{
        type: "message",
        id: "user-entry",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "fresh message", timestamp: 0 },
      }],
    },
  };

  const result = collectContextUsageSnapshot(pi as never, ctx as never, tracker);

  assert.equal(result.measuredUsage?.tokens, 42);
  assert.equal(result.sections[2].children.find((item) => item.kind === "message-user")?.characters, 13);
  assert.ok(result.sections[0].children.some((item) => item.label === "Extensions after pi-dev"));
  assert.equal(result.sections[1].children[0]?.source, "files-extension");
});

test("flattens category, source, tool, and leaf rows in hierarchical order", () => {
  const rows = contextUsageDisplayRows(snapshot(100));
  const tools = rows.find((row) => row.node.kind === "tool-definitions");
  const source = rows.find((row) => row.node.kind === "tool-source");
  const tool = rows.find((row) => row.node.kind === "tool");
  const schema = rows.find((row) => row.node.kind === "tool-schema");
  const extension = rows.find((row) => row.node.kind === "system-extension");

  assert.equal(tools?.depth, 0);
  assert.equal(source?.depth, 1);
  assert.equal(source?.node.source, "files-extension");
  assert.equal(tool?.depth, 2);
  assert.equal(schema?.depth, 3);
  assert.equal(extension?.node.source, "sample-extension");
  assert.equal(source?.parentKey, tools?.key);
  assert.equal(source?.expanded, true);
});

test("orders descendants by usage while keeping categories fixed, with source order available", () => {
  const data = snapshotWithSources();
  const usageRows = contextUsageDisplayRows(data);
  const sourceRows = contextUsageDisplayRows(data, () => true, "source");
  const categoryLabels = (rows: ReturnType<typeof contextUsageDisplayRows>) => rows
    .filter((row) => row.depth === 0)
    .map((row) => row.node.label);
  const toolSources = (rows: ReturnType<typeof contextUsageDisplayRows>) => rows
    .filter((row) => row.node.kind === "tool-source")
    .map((row) => row.node.source);
  const aSourceTools = (rows: ReturnType<typeof contextUsageDisplayRows>) => rows
    .filter((row) => row.node.kind === "tool" && row.node.source === "a-source")
    .map((row) => row.node.label);

  assert.deepEqual(categoryLabels(usageRows), [
    "System prompt",
    "Active tool definitions",
    "Compaction-aware messages",
  ]);
  assert.deepEqual(categoryLabels(sourceRows), categoryLabels(usageRows));
  assert.deepEqual(toolSources(usageRows), ["z-source", "a-source"]);
  assert.deepEqual(toolSources(sourceRows), ["a-source", "z-source"]);
  assert.deepEqual(aSourceTools(usageRows), ["z-medium", "a-small"]);
  assert.deepEqual(aSourceTools(sourceRows), ["a-small", "z-medium"]);
});

test("toggles between usage and source ordering without losing the selected row", () => {
  let renderRequests = 0;
  const overlay = new ContextUsageOverlay({
    readSnapshot: snapshotWithSources,
    theme,
    done: () => {},
    requestRender: () => { renderRequests += 1; },
    scheduleRefresh: () => () => {},
  });

  const usage = overlay.render(120).join("\n");
  assert.match(usage, /order usage/);
  assert.match(usage, /o order/);
  assert.ok(usage.indexOf("z-source") < usage.indexOf("a-source"));

  for (let index = 0; index < 3; index += 1) overlay.handleInput("j");
  assert.match(overlay.render(120).join("\n"), /›\s+▸ z-source/);

  overlay.handleInput("o");
  const source = overlay.render(120).join("\n");
  assert.match(source, /order source/);
  assert.ok(source.indexOf("a-source") < source.indexOf("z-source"));
  assert.match(source, /›\s+▸ z-source/);

  overlay.handleInput("o");
  const usageAgain = overlay.render(120).join("\n");
  assert.match(usageAgain, /order usage/);
  assert.ok(usageAgain.indexOf("z-source") < usageAgain.indexOf("a-source"));
  assert.equal(renderRequests, 5);
  overlay.dispose();
});

test("shows two levels by default and expands the selected branch", () => {
  let renderRequests = 0;
  const overlay = new ContextUsageOverlay({
    readSnapshot: () => snapshot(100),
    theme,
    done: () => {},
    requestRender: () => { renderRequests += 1; },
    scheduleRefresh: () => () => {},
  });

  const initial = overlay.render(100).join("\n");
  assert.match(initial, /› ▾ System prompt/);
  assert.match(initial, /▸ files-extension/);
  assert.doesNotMatch(initial, /▸ read/);

  for (let index = 0; index < 4; index += 1) overlay.handleInput("\u001b[B");
  overlay.handleInput(" ");

  const expanded = overlay.render(100).join("\n");
  assert.match(expanded, /›\s+▾ files-extension/);
  assert.match(expanded, /▸ read/);
  assert.doesNotMatch(expanded, /Parameters schema/);

  overlay.handleInput(" ");
  assert.doesNotMatch(overlay.render(100).join("\n"), /▸ read/);
  assert.equal(renderRequests, 6);
  overlay.dispose();
});

test("uses left and right arrows to navigate nested branches", () => {
  const overlay = new ContextUsageOverlay({
    readSnapshot: () => snapshot(100),
    theme,
    done: () => {},
    requestRender: () => {},
    scheduleRefresh: () => () => {},
  });

  overlay.render(100);
  for (let index = 0; index < 4; index += 1) overlay.handleInput("\u001b[B");
  overlay.handleInput("\u001b[C");
  overlay.render(100);
  overlay.handleInput("\u001b[C");

  assert.match(overlay.render(100).join("\n"), /›\s+▸ read/);

  overlay.handleInput("\u001b[C");
  assert.match(overlay.render(100).join("\n"), /›\s+▾ read/);
  assert.match(overlay.render(100).join("\n"), /Parameters schema/);

  overlay.handleInput("\u001b[D");
  const collapsed = overlay.render(100).join("\n");
  assert.match(collapsed, /›\s+▸ read/);
  assert.doesNotMatch(collapsed, /Parameters schema/);

  overlay.handleInput("\u001b[D");
  assert.match(overlay.render(100).join("\n"), /›\s+▾ files-extension/);
  overlay.dispose();
});

test("page, home, and end keys move the selection and keep it visible", () => {
  const overlay = new ContextUsageOverlay({
    readSnapshot: () => snapshotWithTools(30),
    theme,
    done: () => {},
    requestRender: () => {},
    scheduleRefresh: () => () => {},
  });

  overlay.render(100);
  for (let index = 0; index < 3; index += 1) overlay.handleInput("j");
  overlay.handleInput("\u001b[C");
  overlay.render(100);
  overlay.handleInput("\u001b[6~");

  const paged = overlay.render(100).join("\n");
  assert.match(paged, /›\s+▸ tool-19/);
  assert.match(paged, /rows 5-24 of 35/);

  overlay.handleInput("\u001b[F");
  assert.match(overlay.render(100).join("\n"), /›\s+Compaction-aware messages/);

  overlay.handleInput("\u001b[H");
  const home = overlay.render(100).join("\n");
  assert.match(home, /› ▾ System prompt/);
  assert.match(home, /rows 1-20 of 35/);
  overlay.dispose();
});

test("clamps every overlay line to a very narrow terminal width", () => {
  const overlay = new ContextUsageOverlay({
    readSnapshot: () => snapshot(100, "a message long enough to overflow"),
    theme,
    done: () => {},
    requestRender: () => {},
    scheduleRefresh: () => () => {},
  });
  const width = 7;

  assert.ok(overlay.render(width).every((line) => visibleWidth(line) <= width));
  overlay.dispose();
});

test("clamps every exception line to a very narrow terminal width", () => {
  const overlay = new ContextUsageOverlay({
    readSnapshot: () => { throw new Error("a message long enough to overflow"); },
    theme,
    done: () => {},
    requestRender: () => {},
    scheduleRefresh: () => () => {},
  });
  const width = 7;

  assert.ok(overlay.render(width).every((line) => visibleWidth(line) <= width));
  overlay.dispose();
});

test("requests and renders fresh snapshots on the near-real-time refresh schedule", () => {
  let current = snapshot(100, "first");
  let scheduled: (() => void) | undefined;
  let cancelled = 0;
  let renderRequests = 0;
  let closes = 0;
  const overlay = new ContextUsageOverlay({
    readSnapshot: () => current,
    theme,
    done: () => { closes += 1; },
    requestRender: () => { renderRequests += 1; },
    scheduleRefresh: (callback, intervalMs) => {
      assert.equal(intervalMs, CONTEXT_USAGE_REFRESH_MS);
      scheduled = callback;
      return () => { cancelled += 1; };
    },
  });

  assert.match(overlay.render(100).join("\n"), /Provider total\s+100 \/ 1\.0k/);
  assert.match(overlay.render(100).join("\n"), /files-extension/);
  assert.match(overlay.render(100).join("\n"), /Images: fixed ~1\.2k-token estimate/);
  for (let index = 0; index < 4; index += 1) overlay.handleInput("j");
  overlay.handleInput(" ");
  assert.match(overlay.render(100).join("\n"), /›\s+▾ files-extension/);
  renderRequests = 0;

  current = snapshot(250, "second message is longer");
  scheduled?.();
  assert.equal(renderRequests, 1);
  const refreshed = overlay.render(100).join("\n");
  assert.match(refreshed, /Provider total\s+250 \/ 1\.0k/);
  assert.match(refreshed, /›\s+▾ files-extension/);

  overlay.handleInput("r");
  assert.equal(renderRequests, 2);
  overlay.handleInput("q");
  assert.equal(closes, 1);
  overlay.dispose();
  overlay.dispose();
  assert.equal(cancelled, 1);
});

test("falls back to a concise notification outside the TUI", async () => {
  const notices: string[] = [];
  const ctx = {
    mode: "print",
    getSystemPrompt: () => "BASE",
    getContextUsage: () => ({ tokens: 100, contextWindow: 1_000, percent: 10 }),
    sessionManager: { buildContextEntries: () => [] },
    ui: { notify: (message: string) => { notices.push(message); } },
  };

  await openContextUsageOverlay({ getActiveTools: () => [], getAllTools: () => [] } as never, ctx as never, new ContextUsageTracker());

  assert.equal(notices.length, 1);
  assert.match(notices[0] ?? "", /Provider total: 100 \/ 1\.0k \(10\.0%\)/);
  assert.match(notices[0] ?? "", /Local allocation estimate:/);
});
