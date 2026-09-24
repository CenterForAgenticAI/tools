import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	createEventBus,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

interface FlagObservation {
	phase: "factory" | "session_start";
	value: boolean | string | undefined;
}

test("createAgentSessionServices applies extension flag values after loading and before session_start", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extension-flag-loading-"));
	const agentDir = path.join(root, "agent");
	const extensionPath = path.join(root, "timing-extension.mjs");
	const eventBus = createEventBus();
	const channel = `extension-flag-timing-${process.pid}-${Date.now()}`;
	const observations: FlagObservation[] = [];
	const unsubscribe = eventBus.on(channel, (data) => observations.push(data as FlagObservation));

	t.after(() => {
		unsubscribe();
		eventBus.clear();
		fs.rmSync(root, { recursive: true, force: true });
	});

	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(
		extensionPath,
		`export default function timingExtension(pi) {
	pi.registerFlag("timing-flag", { type: "string", default: "factory-default" });
	pi.events.emit(${JSON.stringify(channel)}, { phase: "factory", value: pi.getFlag("timing-flag") });
	pi.on("session_start", () => {
		pi.events.emit(${JSON.stringify(channel)}, { phase: "session_start", value: pi.getFlag("timing-flag") });
	});
}
`,
	);

	const services = await createAgentSessionServices({
		cwd: root,
		agentDir,
		extensionFlagValues: new Map<string, boolean | string>([["timing-flag", "cli-value"]]),
		resourceLoaderOptions: {
			eventBus,
			additionalExtensionPaths: [extensionPath],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		},
	});

	assert.deepEqual(services.diagnostics, []);
	assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
	assert.deepEqual(observations, [{ phase: "factory", value: "factory-default" }]);
	assert.equal(services.resourceLoader.getExtensions().runtime.flagValues.get("timing-flag"), "cli-value");

	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager: SessionManager.inMemory(root),
		noTools: "all",
	});
	t.after(() => session.dispose());
	await session.bindExtensions({});

	assert.deepEqual(observations, [
		{ phase: "factory", value: "factory-default" },
		{ phase: "session_start", value: "cli-value" },
	]);
});
