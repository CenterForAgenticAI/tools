#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BCP_INTEGRITY, differentialExitCode, inspectParityCase, verifyCorpusEvidence, verifyTarball } from "./parity-differential-support.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cases = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/parity-corpus/cases.json"), "utf8"));
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
const { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
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

async function runCase(item) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `${item.id}-`));
	const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
	const text = (i) => `Synthetic archive item ${i}.\n${"Invented archive review: keep the numbered decision and its reversible ordering. ".repeat(2000)}`;
	for (let i = 1; i <= 16; i++) {
		if (item.toolPairs && [2, 5].includes(i)) manager.appendMessage(fauxAssistantMessage(fauxToolCall("archive_probe", { item: i }, { id: `edge-${i}` }), { stopReason: "toolUse" }));
		else if (item.toolPairs && [3, 6].includes(i)) manager.appendMessage({ role: "toolResult", toolCallId: `edge-${i - 1}`, toolName: "archive_probe", content: [{ type: "text", text: text(i) }], isError: false, timestamp: 1 });
		else manager.appendMessage(i % 2 === 1 || (item.toolPairs && i === 4) ? { role: "user", content: text(i), timestamp: 1 } : fauxAssistantMessage(text(i)));
	}
	for (let i = 0; i < 8; i++) manager.appendMessage({ role: "user", content: `Synthetic recent review ${i}.\n${"Keep this recent invented work visible. ".repeat(1600)}`, timestamp: 1 });
	const observer = (pi) => {
		pi.registerTool({ name: "archive_probe", label: "synthetic archive", description: "Synthetic fixture tool", parameters: Type.Object({ item: Type.Number() }), async execute() { return { content: [{ type: "text", text: "Synthetic archive result." }], details: {} }; } });
		if (item.nested) pi.registerTool({ name: "nested_probe", label: "nested synthetic", description: "Execute a synthetic compress through the real host boundary", parameters: Type.Object({}), async execute(_id, _params, _signal, _update, ctx) {
			return (await ctx.executeTool("compress", { content: item.steps[0] })).result;
		} });
	};
	const faux = fauxProvider({ provider: "parity-differential", models: [{ id: "synthetic", contextWindow: 2_000_000, maxTokens: 4096 }], tokensPerSecond: Infinity });
	faux.setResponses(item.steps.flatMap((step, i) => [fauxAssistantMessage(fauxToolCall(item.nested ? "nested_probe" : "compress", item.nested ? {} : { content: step }, { id: item.nested ? "fabric_synthetic_parent" : `${item.id}-${i}` }), { stopReason: "toolUse" }), fauxAssistantMessage("Synthetic fold turn complete.")]));
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
			await session.prompt("Complete the next synthetic archive fold.");
			await session.waitForIdle();
			await processParityBudget().idle();
		}
		const records = (await readParityRecords(agentDir)).filter((r) => r.sessionId === manager.getSessionId());
		verifyCorpusEvidence(records, item);
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
for (const fingerprint of fingerprints) console.log(buildFoldParityReport(allRecords, PARITY_REGISTER, fingerprint).text);
for (const [key, count] of totals) console.log(`difference ${key}: ${count}`);
console.log(`Synthetic corpus: ${cases.length} cases; ${failed ? "FAIL" : "PASS"}`);
process.exitCode = differentialExitCode(failed);
