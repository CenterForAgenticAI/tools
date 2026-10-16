import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";

import {
	CONTEXT_AWARE_POLICY_CHANGED_EVENT,
	discoverContextAwareServiceV1,
	supportsContextAwarePolicyV1,
	type ContextAwarePolicyChangedEventV1,
	type ContextAwarePolicyV1,
} from "../src/context-service.js";
import { CONFIG_POLICY_ENTRY_TYPE, configPolicyEntry } from "../src/platform/config-layers.js";

// End to end through real Pi agent sessions. A second extension stands in for
// a consumer: it discovers the context service, reads the policy capability,
// and listens for the policy-changed event.

interface Consumer {
	policy?: ContextAwarePolicyV1;
	readonly events: ContextAwarePolicyChangedEventV1[];
}

function consumerExtension(consumer: Consumer): ExtensionFactory {
	return (pi) => {
		pi.events.on(CONTEXT_AWARE_POLICY_CHANGED_EVENT, (event) => {
			consumer.events.push(event as ContextAwarePolicyChangedEventV1);
		});
		pi.on("session_start", () => {
			const service = discoverContextAwareServiceV1(pi.events, "policy-consumer");
			consumer.policy = supportsContextAwarePolicyV1(service) ? service.policy : undefined;
		});
	};
}

interface Harness {
	readonly cwd: string;
	readonly faux: ReturnType<typeof fauxProvider>;
	readonly modelRuntime: ModelRuntime;
}

async function createHarness(prefix: string): Promise<Harness> {
	const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	const faux = fauxProvider({
		provider: "context-policy",
		models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
		tokensPerSecond: Number.POSITIVE_INFINITY,
	});
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore() });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.setRuntimeApiKey("context-policy", "test-only");
	return { cwd, faux, modelRuntime };
}

async function openSession(harness: Harness, sessionManager: SessionManager, consumer: Consumer) {
	const contextAware: ExtensionFactory = async (pi) => {
		const extension = await import(`../src/index.js?context-policy-session=${Date.now()}-${Math.random()}`);
		extension.default(pi);
	};
	const services = await createAgentSessionServices({
		cwd: harness.cwd,
		agentDir: path.join(harness.cwd, "agent"),
		modelRuntime: harness.modelRuntime,
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
		resourceLoaderOptions: { extensionFactories: [contextAware, consumerExtension(consumer)], noExtensions: true },
	});
	const { session } = await createAgentSessionFromServices({ services, sessionManager, model: harness.faux.getModel() });
	await session.bindExtensions({});
	return session;
}

function policyEntryCount(sessionManager: SessionManager): number {
	return sessionManager.getEntries().filter((entry) =>
		entry.type === "custom" && (entry as { customType?: string }).customType === CONFIG_POLICY_ENTRY_TYPE).length;
}

test("the context policy follows the branch, survives a restart, and reaches a consumer", async () => {
	const harness = await createHarness("context-aware-policy-branch-");
	harness.faux.setResponses([
		fauxAssistantMessage("Root answer."),
		fauxAssistantMessage("Branch A answer."),
		fauxAssistantMessage("Branch B answer."),
	]);
	const sessionDir = path.join(harness.cwd, "sessions");
	const manager = SessionManager.create(harness.cwd, sessionDir);
	const first: Consumer = { events: [] };
	let session: Awaited<ReturnType<typeof openSession>> | undefined;
	let leafA: string | null | undefined;
	let leafB: string | null | undefined;
	let onA: ReturnType<ContextAwarePolicyV1["current"]> | undefined;
	let onB: ReturnType<ContextAwarePolicyV1["current"]> | undefined;
	try {
		session = await openSession(harness, manager, first);
		const policy = first.policy;
		assert.ok(policy, "a consumer must discover the policy capability");
		assert.equal(policy.current().value, "summaries");
		assert.equal(policy.current().source, "default");
		assert.deepEqual(policy.current().bands, { warnFraction: 0.45, urgentFraction: 0.9 });

		await session.prompt("Start.");
		await session.waitForIdle();
		const root = manager.getLeafId();
		assert.ok(root);

		// The command refuses an unsupported value without touching the session.
		await session.prompt("/context-policy recent");
		assert.equal(policyEntryCount(manager), 0, "an unsupported value must not be recorded");
		assert.equal(first.events.length, 0);
		assert.equal(policy.current().source, "default");

		// Branch A: the policy is recorded through the command.
		await session.prompt("/context-policy summaries");
		assert.equal(policyEntryCount(manager), 1);
		assert.equal(first.events.length, 1);
		assert.equal(first.events[0]?.reason, "command");
		assert.equal(first.events[0]?.current.source, "session");
		await session.prompt("Work on branch A.");
		await session.waitForIdle();
		leafA = manager.getLeafId();
		onA = policy.current();
		assert.equal(onA.source, "session");
		assert.equal(onA.ladder.foldNudgeStartFraction, 0.45);

		// Branch B: back at the root, a host seeds a different ladder.
		await session.navigateTree(root);
		assert.equal(policy.current().source, "default", "branch A's entry must not leak to its sibling");
		assert.equal(first.events.at(-1)?.reason, "branch");
		manager.appendCustomEntry(
			CONFIG_POLICY_ENTRY_TYPE,
			configPolicyEntry("session", { "pressureLadder.foldNudgeStartFraction": 0.5 }, { declaredBy: "test-host" }),
		);
		await session.prompt("Work on branch B.");
		await session.waitForIdle();
		leafB = manager.getLeafId();
		onB = policy.current();
		assert.equal(onB.source, "default");
		assert.equal(onB.ladder.foldNudgeStartFraction, 0.5);
		assert.equal(onB.ladderSources.foldNudgeStartFraction, "session");
		assert.deepEqual(onB.bands, { warnFraction: 0.5, urgentFraction: 0.9 });
		assert.equal(first.events.at(-1)?.reason, "session-entry", "a host-appended entry is announced at the next turn end");
		assert.deepEqual(first.events.at(-1)?.current, onB);

		// Moving between the two branches returns each branch's own value.
		const eventsBefore = first.events.length;
		await session.navigateTree(leafA!);
		assert.deepEqual(policy.current(), onA);
		assert.equal(first.events.length, eventsBefore + 1);
		assert.deepEqual(first.events.at(-1)?.previous, onB);
		assert.deepEqual(first.events.at(-1)?.current, onA);
		await session.navigateTree(leafB!);
		assert.deepEqual(policy.current(), onB);
	} finally {
		session?.dispose();
	}

	// Restart: a new process reopens the session file on branch B.
	const sessionFile = manager.getSessionFile();
	assert.ok(sessionFile && fs.existsSync(sessionFile));
	const reopened = SessionManager.open(sessionFile, sessionDir);
	assert.equal(reopened.getLeafId(), leafB);
	const second: Consumer = { events: [] };
	let restarted: Awaited<ReturnType<typeof openSession>> | undefined;
	try {
		restarted = await openSession(harness, reopened, second);
		assert.ok(second.policy);
		assert.deepEqual(second.policy.current(), onB, "a restart returns the same policy");
		assert.equal(second.events.length, 0, "starting a session is not a policy change");
		await restarted.navigateTree(leafA!);
		assert.deepEqual(second.policy.current(), onA);
		assert.equal(second.events.at(-1)?.reason, "branch");
	} finally {
		restarted?.dispose();
		fs.rmSync(harness.cwd, { recursive: true, force: true });
	}
});

test("an unsupported contextPolicy in a project config file never changes the policy", async () => {
	const harness = await createHarness("context-aware-policy-config-");
	fs.mkdirSync(path.join(harness.cwd, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(harness.cwd, ".pi", "context-aware.json"), JSON.stringify({ contextPolicy: "recent" }));
	const consumer: Consumer = { events: [] };
	let session: Awaited<ReturnType<typeof openSession>> | undefined;
	try {
		session = await openSession(harness, SessionManager.inMemory(harness.cwd), consumer);
		const current = consumer.policy?.current();
		assert.ok(current);
		assert.equal(current.value, "summaries");
		assert.equal(current.source, "default");
		assert.match(current.diagnostic ?? "", /Ignored an unsupported contextPolicy in the project layer/u);
	} finally {
		session?.dispose();
		fs.rmSync(harness.cwd, { recursive: true, force: true });
	}
});
