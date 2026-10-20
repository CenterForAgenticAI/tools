#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BCP_INTEGRITY, differentialExitCode, inspectParityCase, mechanismFailures, verifyCorpusEvidence, verifyTarball } from "./parity-differential-support.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// PARITY_MECHANISMS (below) runs only the named turn-preparation cases, without the corpus.
const cases = process.env.PARITY_MECHANISMS ? [] : JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/parity-corpus/cases.json"), "utf8"));
const worker = process.argv[2] === "--worker";
if (!worker) {
	const args = process.argv.slice(2);
	if (args.length && (args[0] !== "--cache" || args.length !== 2)) throw new Error("usage: node scripts/parity-differential.mjs [--cache <directory>]");
	const cache = path.resolve(args[1] ?? path.join(os.tmpdir(), "pi-parity-bcp-0.1.83-cache"));
	fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
	const result = spawnSync(process.execPath, [path.join(root, "scripts/with-temp-root.mjs"), process.execPath, fileURLToPath(import.meta.url), "--worker", cache], { cwd: root, stdio: "inherit", timeout: 480_000 });
	if (result.error) console.error(result.error.message);
	process.exit(result.status ?? 1);
}

// The worker is launched through with-temp-root: HOME and every host-session override are isolated.
const cache = process.argv[3];
const agentDir = path.join(os.tmpdir(), "agent");
fs.mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.ACP_LOG_FILE = path.join(os.tmpdir(), "acp.log");
fs.writeFileSync(path.join(agentDir, "context-aware.json"), JSON.stringify({ summarizer: { enabled: false }, proactiveCompaction: { enabled: false }, contextCache: { enabled: false }, restartNotice: { enabled: false } }));
const exec = (cmd, args, options = {}) => execFileSync(cmd, args, { timeout: 120_000, ...options });
const tarball = path.join(cache, "billion-context-pi-0.1.83.tgz");
if (!fs.existsSync(tarball)) {
	const npmEnv = { ...process.env, npm_config_cache: path.join(cache, "npm"), npm_config_userconfig: path.join(os.tmpdir(), "empty-npmrc") };
	fs.writeFileSync(npmEnv.npm_config_userconfig, "");
	const integrity = exec("npm", ["view", "billion-context-pi@0.1.83", "dist.integrity"], { encoding: "utf8", env: npmEnv }).trim();
	assert.equal(integrity, BCP_INTEGRITY, "registry integrity changed from pinned bcp");
	exec("npm", ["pack", "billion-context-pi@0.1.83", "--pack-destination", cache, "--json", "--ignore-scripts"], { env: npmEnv });
}
verifyTarball(fs.readFileSync(tarball));
console.log(`bcp billion-context-pi@0.1.83 integrity OK: ${BCP_INTEGRITY}`);
const unpack = path.join(os.tmpdir(), "bcp");
fs.mkdirSync(unpack);
exec("tar", ["-xzf", tarball, "-C", unpack]);
const bcp = path.join(unpack, "package");
assert.equal(JSON.parse(fs.readFileSync(path.join(bcp, "package.json"), "utf8")).version, "0.1.83");
fs.symlinkSync(path.join(root, "node_modules"), path.join(bcp, "node_modules"), "dir");

const { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall, InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
const { Type } = await import("typebox");
const { PARITY_RECORD_VERSION, readParityRecords } = await import("../dist/parity/records.js");
const { processParityBudget } = await import("../dist/parity/budget.js");
const { configuredFoldFingerprint, foldEngineFingerprint } = await import("../dist/parity/fingerprint.js");
const { resolveFoldConfig } = await import("../dist/folds/fold-engine.js");
const { PARITY_REGISTER } = await import("../dist/parity/register.js");
const { buildFoldParityReport, judgeParityCalls } = await import("../dist/parity/report.js");
const engineFingerprint = foldEngineFingerprint(path.join(root, "dist", "folds"));
const fingerprints = new Set();
const allRecords = [];
let failed = false;
const totals = new Map();

/** About `tokens` tokens of invented text (four characters per token). */
const sized = (label, tokens) => `${label}\n${"Invented archive review: keep the numbered decision. ".repeat(Math.ceil((tokens * 4) / 52))}`;
const LONG_SUMMARY = "The synthetic archive review settled every numbered item in this range; retain the decisions and their reversible ordering. ".repeat(130);

/**
 * Turn-preparation cases (pi-context-aware#186, pi-context-aware#184). Each builds its own session,
 * so the protected recent tail falls where the mechanism matters, and states what real bcp does.
 * Refs are bcp's: one per message of its projection, in session order. After the built entries
 * come the prompt, this extension's usage marker (a custom message bcp reads as a user message) and
 * the in-flight compress call. bcp protects the last five visible messages, then back until 5,000
 * tokens, plus the last user message. Coverage counts are what real bcp 0.1.83 folds.
 */
/** One step's compress arguments: a bare range list, or the full arguments with top-level fields. */
const compressArgs = (step) => Array.isArray(step) ? { content: step } : step;
const archive = (s) => [s.user(sized("Q1", 2_000)), s.assistant(sized("A1", 2_000)), s.user(sized("Q2", 2_000)), s.assistant(sized("A2", 2_000))];
/**
 * summaryMaxChars (pi-context-aware#183): a 22,000-character summary is over the default 20,000
 * limit, and each case raises it a different way. bcp 0.1.83's compress tool honours only the
 * top-level value: its normalizeRanges keeps no per-range summaryMaxChars, and its schema has none.
 * Pi validates the arguments first and converts a top-level "30000" to 30000, so that call passes too.
 */
const MAX_SUMMARY = `${"The synthetic archive review settled every numbered item in this range; retain the decisions and their order. ".repeat(210).slice(0, 21_999)}.`;
const maxCharsBuild = (s) => { archive(s); for (const i of [1, 2, 3]) s.assistant(sized(`T${i}`, 2_000)); s.user(sized("Later", 6_000)); };
const maxCharsRange = (extra = {}) => ({ startId: "m00002", endId: "m00005", topic: "archive", summary: MAX_SUMMARY, ...extra });
const MAX_CHARS_CASES = [
	{ id: "mechanism-max-chars-top", build: maxCharsBuild, steps: [{ content: [maxCharsRange()], summaryMaxChars: 30_000 }], expect: [{ outcome: "accepted" }] },
	{ id: "mechanism-max-chars-range", build: maxCharsBuild, steps: [[maxCharsRange({ summaryMaxChars: 30_000 })]], expect: [{ outcome: "rejected", reasons: ["summary-long"] }] },
	{ id: "mechanism-max-chars-string", build: maxCharsBuild, steps: [{ content: [maxCharsRange()], summaryMaxChars: "30000" }], expect: [{ outcome: "accepted" }] },
	{ id: "mechanism-max-chars-range-string", build: maxCharsBuild, steps: [[maxCharsRange({ summaryMaxChars: "30000" })]], expect: [{ outcome: "rejected", reasons: ["summary-long"] }] },
];
const MECHANISMS = [
	// m1-m4 archive, then three probes (m5-m10) whose text and call bcp keeps as one message. Its five
	// newest messages are the third probe, its result, the prompt, the marker and the compress call; the
	// old native projection splits the third probe in two and cuts between its halves.
	{ id: "mechanism-projection", build(s) { archive(s); for (const i of [1, 2, 3]) { s.assistant([fauxText(`Probe ${i}.`), fauxToolCall("archive_probe", { item: i }, { id: `p${i}` })]); s.result(`p${i}`, sized(`R${i}`, 6_000)); } },
		steps: [[{ startId: "m00002", endId: "m00010", topic: "archive", summary: "The synthetic archive and the first probes are settled. Retain the numbered decisions and continue with the later review." }]],
		expect: [{ outcome: "accepted", coverage: 7 }] },
	// The second fold runs inside a nested tool after a probe, so its parent call has no result yet.
	// With b1 active bcp prunes and strips that call, and its five newest messages reach back to the
	// first turn's closing text (m13); the old native engine kept the call in a slot and folded m13.
	// The step-zero compress call and result (m11, m12) are protected tools and never fold.
	{ id: "mechanism-prune", nestedSteps: [1], probeBefore: [1], doneText: sized("Done", 6_000), prompts: [sized("Prompt zero", 6_000), sized("Prompt one", 6_000)],
		build(s) { archive(s); for (const i of [1, 2, 3, 4]) s.assistant(sized(`T${i}`, 2_000)); },
		steps: [[{ startId: "m00002", endId: "m00003", topic: "first", summary: "The first synthetic archive exchange is settled. Retain the numbered decision and continue with the later review." }],
			[{ startId: "m00004", endId: "m00013", topic: "second", summary: "The second synthetic archive stretch is settled. Retain the numbered decisions and continue with the later review." }]],
		expect: [{ outcome: "accepted", coverage: 2 }, { outcome: "accepted", coverage: 7 }] },
	// The in-flight compress call carries a 16,000-character summary. bcp counts it as a 200-character
	// stub, so its 5,000 recent tokens reach back to T3; counted in full they stop at T6.
	{ id: "mechanism-compaction", build(s) { archive(s); for (const i of [1, 2, 3, 4, 5, 6]) s.assistant(sized(`T${i}`, 1_500)); },
		steps: [[{ startId: "m00002", endId: "m00010", topic: "archive", summary: LONG_SUMMARY }]],
		expect: [{ outcome: "accepted", coverage: 5 }] },
	// Each recent step carries 6,000 tokens of thinking. bcp counts them, so its 5,000 recent tokens
	// end at the newest step; without them the window reaches back into the range.
	{ id: "mechanism-thinking", build(s) { archive(s); for (const i of [1, 2, 3, 4, 5, 6]) s.assistant([fauxThinking(sized(`Thinking ${i}`, 6_000)), fauxText(`Step ${i}.`)]); },
		steps: [[{ startId: "m00002", endId: "m00010", topic: "archive", summary: "The synthetic archive and its early steps are settled. Retain the numbered decisions and continue with the later review." }]],
		expect: [{ outcome: "accepted", coverage: 7 }] },
	// s12: the protected tail ends between the text and the call of the second probe in the old native
	// projection, which refused the fold; bcp protects the whole probe and folds the rest.
	{ id: "mechanism-s12-split", build(s) { archive(s); for (const i of [1, 2]) { s.assistant([fauxText(`Probe ${i}.`), fauxToolCall("archive_probe", { item: i }, { id: `p${i}` })]); s.result(`p${i}`, sized(`R${i}`, 500)); } s.user(sized("Later", 6_000)); },
		steps: [[{ startId: "m00002", endId: "m00008", topic: "archive", summary: "The synthetic archive and the first probe are settled. Retain the numbered decisions and continue with the later review." }]],
		expect: [{ outcome: "accepted", coverage: 5 }] },
	// s15: a range that ends on a call well outside the protected tail extends to its result in both engines.
	{ id: "mechanism-s15-call-end", build(s) { archive(s); s.assistant([fauxText("Probe one."), fauxToolCall("archive_probe", { item: 1 }, { id: "p1" })]); s.result("p1", sized("R1", 2_000)); for (const i of [1, 2, 3]) s.assistant(sized(`T${i}`, 2_000)); s.user(sized("Later", 6_000)); },
		steps: [[{ startId: "m00002", endId: "m00005", topic: "archive", summary: "The synthetic archive and its probe are settled. Retain the numbered decisions and continue with the later review." }]],
		expect: [{ outcome: "accepted", coverage: 5 }] },
	// s3 (pi-context-aware#184): the second range starts inside b1. bcp has pruned b1's messages and refuses.
	{ id: "mechanism-s3-overlap", build(s) { archive(s); s.user(sized("Q3", 2_000)); s.assistant(sized("A3", 2_000)); s.assistant(sized("T1", 2_000)); s.assistant(sized("T2", 2_000)); },
		steps: [[{ startId: "m00002", endId: "m00005", topic: "first", summary: "The first synthetic archive stretch is settled. Retain the numbered decisions and continue with the later review." }],
			[{ startId: "m00004", endId: "m00008", topic: "overlap", summary: "An overlapping synthetic stretch that is already folded. Retain the numbered decisions and continue with the later review." }]],
		expect: [{ outcome: "accepted", coverage: 4 }, { outcome: "rejected", reasons: ["consumed"] }] },
	...MAX_CHARS_CASES,
];

async function runCase(item) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `${item.id}-`));
	const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
	const text = (i) => `Synthetic archive item ${i}.\n${"Invented archive review: keep the numbered decision and its reversible ordering. ".repeat(2000)}`;
	if (item.build) item.build({
		user: (content) => manager.appendMessage({ role: "user", content, timestamp: 1 }),
		assistant: (content) => manager.appendMessage(fauxAssistantMessage(content, { stopReason: Array.isArray(content) && content.some((part) => part.type === "toolCall") ? "toolUse" : "stop" })),
		result: (toolCallId, content) => manager.appendMessage({ role: "toolResult", toolCallId, toolName: "archive_probe", content: [{ type: "text", text: content }], isError: false, timestamp: 1 }),
	});
	else for (let i = 1; i <= 16; i++) {
		if (item.toolPairs && [2, 5].includes(i)) manager.appendMessage(fauxAssistantMessage(fauxToolCall("archive_probe", { item: i }, { id: `edge-${i}` }), { stopReason: "toolUse" }));
		else if (item.toolPairs && [3, 6].includes(i)) manager.appendMessage({ role: "toolResult", toolCallId: `edge-${i - 1}`, toolName: "archive_probe", content: [{ type: "text", text: text(i) }], isError: false, timestamp: 1 });
		else manager.appendMessage(i % 2 === 1 || (item.toolPairs && i === 4) ? { role: "user", content: text(i), timestamp: 1 } : fauxAssistantMessage(text(i)));
	}
	if (!item.build) for (let i = 0; i < 8; i++) manager.appendMessage({ role: "user", content: `Synthetic recent review ${i}.\n${"Keep this recent invented work visible. ".repeat(1600)}`, timestamp: 1 });
	const nestedAt = (step) => item.nested || (item.nestedSteps ?? []).includes(step);
	let current = 0;
	const observer = (pi) => {
		pi.registerTool({ name: "archive_probe", label: "synthetic archive", description: "Synthetic fixture tool", parameters: Type.Object({ item: Type.Number() }), async execute() { return { content: [{ type: "text", text: "Synthetic archive result." }], details: {} }; } });
		if (item.nested || item.nestedSteps) pi.registerTool({ name: "nested_probe", label: "nested synthetic", description: "Execute a synthetic compress through the real host boundary", parameters: Type.Object({}), async execute(_id, _params, _signal, _update, ctx) {
			return (await ctx.executeTool("compress", compressArgs(item.steps[current]))).result;
		} });
	};
	const faux = fauxProvider({ provider: "parity-differential", models: [{ id: "synthetic", contextWindow: 2_000_000, maxTokens: 4096 }], tokensPerSecond: Infinity });
	faux.setResponses(item.steps.flatMap((step, i) => [
		...((item.probeBefore ?? []).includes(i) ? [fauxAssistantMessage(fauxToolCall("archive_probe", { item: 90 + i }, { id: `probe-${i}` }), { stopReason: "toolUse" })] : []),
		fauxAssistantMessage(fauxToolCall(nestedAt(i) ? "nested_probe" : "compress", nestedAt(i) ? {} : compressArgs(step), { id: item.nested ? "fabric_synthetic_parent" : nestedAt(i) ? `fabric_${item.id}_${i}` : `${item.id}-${i}` }), { stopReason: "toolUse" }), fauxAssistantMessage(item.doneText ?? "Synthetic fold turn complete.")]));
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore() });
	runtime.registerNativeProvider(faux.provider);
	await runtime.setRuntimeApiKey("parity-differential", "synthetic-not-a-key");
	let session;
	const deadline = setTimeout(() => { console.error(`case ${item.id}: deadline exceeded`); process.exit(1); }, 60_000);
	try {
		const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime: runtime, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }), resourceLoaderOptions: {
			additionalExtensionPaths: [path.join(bcp, "dist/index.js"), path.join(root, "dist/extension.js")], extensionFactories: [observer], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		} });
		const loaded = services.resourceLoader.getExtensions();
		assert.deepEqual(loaded.errors, [], "real extensions must load");
		assert.equal(loaded.extensions.length, 3, "bcp, our extension, and fixture observer must load");
		session = (await createAgentSessionFromServices({ services, sessionManager: manager, model: faux.getModel() })).session;
		await session.bindExtensions({ uiContext: { ...session.extensionRunner.createContext().ui, notify() {} } });
		assert.ok(session.getAllTools().some((tool) => tool.name === "acp_status"), "real bcp must own compress");
		for (let step = 0; step < item.steps.length; step++) {
			current = step;
			await session.prompt(item.prompts?.[step] ?? "Complete the next synthetic archive fold.");
			await session.waitForIdle();
			await processParityBudget().idle();
		}
		const records = (await readParityRecords(agentDir)).filter((r) => r.sessionId === manager.getSessionId());
		if (!item.expect) verifyCorpusEvidence(records, item);
		// The recorder keys records by the engine hash plus the session's effective fold settings.
		const fingerprint = configuredFoldFingerprint(engineFingerprint, resolveFoldConfig({ cwd, sessionManager: manager }, agentDir));
		return { records, fingerprint };
	} finally { clearTimeout(deadline); session?.dispose(); }
}

for (const item of cases) {
	try {
		const { records, fingerprint } = await runCase(item);
		allRecords.push(...records);
		fingerprints.add(fingerprint);
		const result = inspectParityCase(records, PARITY_REGISTER, fingerprint, PARITY_RECORD_VERSION, judgeParityCalls);
		console.log(`case ${item.id}: calls=${result.count} records=${records.length} failures=${result.failures.length}`);
		for (const failure of result.failures) {
			failed = true;
			console.log(`UNEXPLAINED ${item.id} ${JSON.stringify(failure)}`);
			const key = `${item.id} ${failure.kind}`;
			totals.set(key, (totals.get(key) ?? 0) + 1);
		}
	} catch (error) { failed = true; console.error(`INCONCLUSIVE ${item.id}: ${error.stack ?? error}`); }
}
// Turn-preparation cases: real bcp takes the stated path and the native plan agrees with it on every call.
// PARITY_MECHANISMS=<id,...> runs only the named ones.
const only = process.env.PARITY_MECHANISMS?.split(",").filter(Boolean);
for (const item of MECHANISMS.filter((candidate) => !only || only.includes(candidate.id))) {
	try {
		const { records } = await runCase(item);
		const failures = mechanismFailures(records, item);
		console.log(`mechanism ${item.id}: ${failures.length ? "FAIL" : "PASS"}`);
		for (const failure of failures) { failed = true; console.log(`MECHANISM ${item.id} ${failure}`); }
	} catch (error) { failed = true; console.error(`INCONCLUSIVE ${item.id}: ${error.stack ?? error}`); }
}
for (const fingerprint of fingerprints) console.log(buildFoldParityReport(allRecords, PARITY_REGISTER, fingerprint).text);
for (const [key, count] of totals) console.log(`difference ${key}: ${count}`);
console.log(`Synthetic corpus: ${cases.length} cases; ${failed ? "FAIL" : "PASS"}`);
process.exitCode = differentialExitCode(failed);
