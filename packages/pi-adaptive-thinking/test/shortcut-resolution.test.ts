import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

import {
	createEventBus,
	DefaultResourceLoader,
	ExtensionRunner,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import adaptiveThinkingExtension from "../index.js";

const CWD = resolve(import.meta.dirname, "..");
const codingAgentEntry = resolve(CWD, "node_modules/@earendil-works/pi-coding-agent/dist/index.js");
const { KeybindingsManager } = await import(pathToFileURL(join(dirname(codingAgentEntry), "core/keybindings.js")).href);
const HOME = mkdtempSync(join(tmpdir(), "adaptive-thinking-shortcuts-"));
const agentDir = join(HOME, ".pi", "agent");

after(() => rmSync(HOME, { recursive: true, force: true }));

test("real Pi extension resolution accepts amended shortcuts without reserved-key diagnostics", async () => {
	const eventBus = createEventBus();
	const resourceLoader = new DefaultResourceLoader({
		cwd: CWD,
		agentDir,
		eventBus,
		extensionFactories: [{ name: "adaptive-thinking-shortcuts-under-test", factory: adaptiveThinkingExtension }],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const loaded = resourceLoader.getExtensions();
	assert.deepEqual(loaded.errors, []);

	const sessionManager = SessionManager.inMemory(CWD);
	const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
	const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, CWD, sessionManager, new ModelRegistry(modelRuntime));
	const keybindings = new KeybindingsManager();
	const resolved = runner.getShortcuts(keybindings.getEffectiveConfig());

	assert.ok(resolved.has("alt+."));
	assert.ok(resolved.has("alt+,"));
	for (const swallowed of ["shift+tab", "alt+shift+tab", "ctrl+shift+tab"] as const) {
		assert.equal(resolved.has(swallowed), false);
	}
	assert.deepEqual(runner.getShortcutDiagnostics(), []);
});
