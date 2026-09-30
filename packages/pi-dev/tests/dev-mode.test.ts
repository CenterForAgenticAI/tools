import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { VERSION, type ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { createPiDevExtension } from "../index.ts";
import {
  AUTHORING_SKILL_NAME,
  authoringSkillRoot,
  devModeGuidance,
  devModeSkillPaths,
  devModeSystemPrompt,
  GUIDANCE_VERIFIED_AGAINST,
  isDevModeActive,
  minorSeries,
  PI_DEV_MODE_FLAG,
} from "../src/dev-mode.ts";
import { runDoctor } from "../src/doctor.ts";

const off = { getFlag: () => false };
const on = { getFlag: () => true };

test("dev mode contributes nothing at all when the flag is absent", () => {
  assert.equal(isDevModeActive(off), false);
  assert.equal(devModeSystemPrompt(off, "host prompt"), undefined);
  assert.deepEqual(devModeSkillPaths(off), []);
});

test("dev mode contributes guidance and exactly one skill root when the flag is set", () => {
  assert.equal(isDevModeActive(on), true);

  const prompt = devModeSystemPrompt(on, "host prompt");
  assert.ok(prompt);
  assert.match(prompt, new RegExp(AUTHORING_SKILL_NAME));
  assert.match(prompt, new RegExp(`--${PI_DEV_MODE_FLAG}`));

  assert.deepEqual(devModeSkillPaths(on), [authoringSkillRoot()]);
});

test("the injection appends to the incoming prompt rather than replacing it", () => {
  const host = "HOST PROMPT FROM ANOTHER EXTENSION";
  const prompt = devModeSystemPrompt(on, host);
  assert.ok(prompt);
  // systemPrompt replaces the turn's prompt, so discarding the incoming value
  // would silently drop whatever earlier extensions contributed.
  assert.ok(prompt.startsWith(host), "incoming prompt must be preserved, and first");
  assert.ok(prompt.includes(devModeGuidance()), "guidance must be appended");
});

test("a missing incoming prompt still yields usable guidance", () => {
  const prompt = devModeSystemPrompt(on, undefined);
  assert.ok(prompt);
  assert.ok(prompt.includes(devModeGuidance()));
});

test("reapplying active guidance preserves the prompt without duplicating the pointer", () => {
  const once = devModeSystemPrompt(on, "host prompt");
  assert.ok(once);
  assert.equal(devModeSystemPrompt(on, once), once);
});

test("a flag API that throws is treated as off rather than breaking the session", () => {
  const hostile = { getFlag: () => { throw new Error("flags unavailable"); } };
  assert.equal(isDevModeActive(hostile), false);
  assert.equal(devModeSystemPrompt(hostile, "host"), undefined);
  assert.deepEqual(devModeSkillPaths(hostile), []);
});

test("the contributed skill root actually contains the skill it promises", () => {
  const root = authoringSkillRoot();
  assert.equal(path.basename(root), "skills");
  assert.ok(
    existsSync(path.join(root, AUTHORING_SKILL_NAME, "SKILL.md")),
    `${AUTHORING_SKILL_NAME}/SKILL.md must exist under the contributed root`,
  );
});

test("the active authoring skill carries the requirement-escalation guardrail", () => {
  const [root] = devModeSkillPaths(on);
  assert.ok(root, "active dev mode must contribute the authoring skill root");

  const guidance = readFileSync(
    path.join(root, AUTHORING_SKILL_NAME, "SKILL.md"),
    "utf8",
  );
  const normalizedGuidance = guidance.replace(/\s+/g, " ");
  const requiredConcepts = [
    "source requirements",
    "repository invariants",
    "proposed design choices",
    "cryptography",
    "credentials",
    "authorization",
    "new protocol",
    "durable recovery behavior",
    "new trust boundary",
    "simplest sufficient design",
    "concrete attacker",
    "human approval",
    "optional-defense failure",
    "source-contract failure",
    "practical severity",
  ];

  for (const concept of requiredConcepts) {
    assert.ok(
      normalizedGuidance.includes(concept),
      `authoring guidance must retain the ${concept} concept`,
    );
  }
});

test("the active authoring skill documents parallel test guidance", () => {
  const [root] = devModeSkillPaths(on);
  assert.ok(root, "active dev mode must contribute the authoring skill root");

  const guidance = readFileSync(
    path.join(root, AUTHORING_SKILL_NAME, "SKILL.md"),
    "utf8",
  );
  const normalizedGuidance = guidance.replace(/\s+/g, " ").toLowerCase();
  const requiredConcepts: Array<[string, RegExp]> = [
    ["parallel whole-repository gates", /whole-repository gates run test files in parallel/],
    ["Node process-level concurrency", /node's test runner.*process-level concurrency.*no serializing flag/],
    ["named serial suite script", /genuinely serial suite.*own named serial script.*nearby written reason/],
    ["narrow serialization", /never serialize the whole gate for one suite/],
    ["transparent c8 wrapper", /c8.*transparent.*underlying runner's concurrency/],
    ["optional CI concurrency", /optional `test_concurrency`.*reduce ci pressure.*runner default/],
    ["no fixed low ceiling", /reject.*fixed low ceiling/],
    ["slowest-file floor", /slowest file.*lower bound.*parallel wall time/],
    ["slow-file split signal", /around 30 seconds or slower.*split candidates/],
    ["deterministic waits", /fakes or event hooks.*settimeout.*sleep waits/],
    ["unique temporary directories", /unique temporary directories/],
    ["fixed shared resources", /fixed shared paths.*socket names.*ports.*daemons/],
    ["serialization isolation review", /serialization pressure.*isolation review/],
  ];

  for (const [concept, pattern] of requiredConcepts) {
    assert.match(
      normalizedGuidance,
      pattern,
      `authoring guidance must retain the ${concept} concept`,
    );
  }
});

test("the dev-mode pointer routes UI-seam tests at the conformance fake", () => {
  const normalizedPointer = devModeGuidance().replace(/\s+/g, " ");

  // Each entry is a fact an agent gets wrong from memory, and each maps to a
  // defect that shipped. They are asserted on the pointer itself, not the
  // skill, because the pointer is what reaches the turn.
  const requiredFacts: Array<[string, RegExp]> = [
    ["conformance fake import", /@caair\/pi-dev\/testing/],
    ["handwritten double warning", /instead of using a handwritten double/],
    ["seams the fake covers", /ctx\.ui.+pi\.events.+pi\.on.+handlers/],
    ["RPC ignores widget factories", /RPC mode.*silently ignores widget factories/],
    ["RPC stores string arrays", /stores string-array widgets/],
    ["hasUI is not a surface promise", /RPC mode can report .?hasUI=true/],
    ["empty string does not clear", /empty status string remains stored/],
    ["only undefined clears", /only .?undefined.? clears keyed status or widget state/],
    ["dispose on shutdown", /Dispose registrations created on .?session_start.? during .?session_shutdown.?/],
    ["prove no leak", /repeated-start tests that no registration leaks/],
  ];

  for (const [fact, pattern] of requiredFacts) {
    assert.match(
      normalizedPointer,
      pattern,
      `dev-mode pointer must state the ${fact} fact`,
    );
  }
});

test("the UI-seam facts stay out of a session that did not ask for dev mode", () => {
  assert.equal(
    devModeSystemPrompt(off, "host prompt"),
    undefined,
    "an inactive session must receive no UI-seam guidance at all",
  );

  const active = devModeSystemPrompt(on, "host prompt");
  assert.ok(active?.includes("@caair/pi-dev/testing"), "active dev mode must carry the fake pointer");
  assert.ok(active?.startsWith("host prompt"), "the host prompt must survive ahead of the guidance");
});

function registerExtension(flagValue: boolean): {
  flags: Map<string, Record<string, unknown>>;
  handlers: Map<string, (event: ExtensionEvent, ctx: unknown) => unknown>;
} {
  const flags = new Map<string, Record<string, unknown>>();
  const handlers = new Map<string, (event: ExtensionEvent, ctx: unknown) => unknown>();
  const pi = {
    registerCommand: () => {},
    registerShortcut: () => {},
    registerFlag: (name: string, options: Record<string, unknown>) => { flags.set(name, options); },
    getFlag: (name: string) => (name === PI_DEV_MODE_FLAG ? flagValue : undefined),
    registerTool: () => {},
    registerMessageRenderer: () => {},
    registerEntryRenderer: () => {},
    on: (name: string, handler: (event: ExtensionEvent, ctx: unknown) => unknown) => { handlers.set(name, handler); },
    getActiveTools: () => [],
    getAllTools: () => [],
    getCommands: () => [],
    sendMessage: () => {},
    appendEntry: () => {},
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  } as never;
  createPiDevExtension({ present: async () => {} })(pi);
  return { flags, handlers };
}

test("the extension registers the mode flag as a boolean defaulting to off", () => {
  const { flags } = registerExtension(false);
  const flag = flags.get(PI_DEV_MODE_FLAG);
  assert.ok(flag, `${PI_DEV_MODE_FLAG} must be registered`);
  assert.equal(flag.type, "boolean");
  assert.equal(flag.default, false);
});

test("registered handlers contribute nothing when the flag is off", () => {
  const { handlers } = registerExtension(false);

  const before = handlers.get("before_agent_start");
  assert.ok(before);
  assert.deepEqual(before({ type: "before_agent_start", systemPrompt: "host" } as never, {}), {});

  const discover = handlers.get("resources_discover");
  assert.ok(discover);
  assert.deepEqual(discover({ type: "resources_discover", cwd: "/tmp", reason: "startup" } as never, {}), {});
});

test("registered handlers contribute guidance and skills when the flag is on", () => {
  const { handlers } = registerExtension(true);

  const before = handlers.get("before_agent_start");
  assert.ok(before);
  const result = before({ type: "before_agent_start", systemPrompt: "host" } as never, {}) as { systemPrompt?: string };
  assert.ok(result.systemPrompt?.startsWith("host"));
  assert.match(result.systemPrompt ?? "", new RegExp(AUTHORING_SKILL_NAME));

  const discover = handlers.get("resources_discover");
  assert.ok(discover);
  const discovered = discover({ type: "resources_discover", cwd: "/tmp", reason: "startup" } as never, {}) as { skillPaths?: string[] };
  assert.deepEqual(discovered.skillPaths, [authoringSkillRoot()]);
});

test("doctor reports the mode, and says how to turn it on when it is off", async () => {
  const ctx = { cwd: "/tmp", sessionManager: {} } as never;
  const dependencies = {
    pathExists: () => false,
    piVersion: VERSION,
  };

  const offChecks = await runDoctor({ getFlag: () => false } as never, ctx, dependencies);
  const offCheck = offChecks.find((check) => check.name === "Extension-authoring mode");
  assert.ok(offCheck);
  assert.match(offCheck.detail, /^Off\./);
  assert.match(offCheck.detail, new RegExp(`--${PI_DEV_MODE_FLAG}`));

  const onChecks = await runDoctor({ getFlag: () => true } as never, ctx, dependencies);
  const onCheck = onChecks.find((check) => check.name === "Extension-authoring mode");
  assert.ok(onCheck);
  assert.match(onCheck.detail, /^Active/);
});

test("minorSeries reduces a version to its series and leaves odd input alone", () => {
  assert.equal(minorSeries("0.80.10"), "0.80");
  assert.equal(minorSeries("1.2.3-beta.4"), "1.2");
  assert.equal(minorSeries("nonsense"), "nonsense");
});

/**
 * AC-5 is a claim about whether prose is correct, which no test can establish.
 * This is the next best thing: it fails when the documented API surface could
 * have moved, forcing a human to re-read the skill and move the constant
 * deliberately rather than by accident.
 */
test("shipped guidance is pinned to the pi-coding-agent series it was checked against", () => {
  assert.equal(
    minorSeries(VERSION),
    GUIDANCE_VERIFIED_AGAINST,
    `@earendil-works/pi-coding-agent is now ${VERSION}, but skills/${AUTHORING_SKILL_NAME}/SKILL.md was last verified against ${GUIDANCE_VERIFIED_AGAINST}.x. Re-read that skill against the installed typings, then update GUIDANCE_VERIFIED_AGAINST in src/dev-mode.ts.`,
  );
});

test("shipped guidance names every installed lifecycle event overload", () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const typings = readFileSync(
    path.join(testDir, "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts"),
    "utf8",
  );
  const guidance = readFileSync(
    path.join(testDir, `../skills/${AUTHORING_SKILL_NAME}/SKILL.md`),
    "utf8",
  );
  const eventNames = [...typings.matchAll(/\bon\s*\(\s*event:\s*"([^"]+)"/g)].map((match) => match[1]);

  assert.ok(eventNames.length > 0, "the installed typings must declare lifecycle event overloads");
  for (const eventName of eventNames) {
    assert.ok(guidance.includes("`" + eventName + "`"), `${eventName} is missing from shipped guidance`);
  }
});
