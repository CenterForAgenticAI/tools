import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import {
	CONTEXT_AWARE_SERVICE_DISCOVERY_EVENT,
	CONTEXT_AWARE_SERVICE_PROTOCOL_VERSION,
	buildContextAwareSnapshotV1,
	discoverContextAwareServiceV1,
	provideContextAwareServiceV1,
	supportsContextAwareArtifactPromotionV1,
	validateContextAwareArtifactPromotionRequestV1,
	validateContextAwareHandoffRequestV1,
	type ContextAwareHandoffNothingToCompactV1,
	type ContextAwareHandoffRequestV1,
	type ContextAwareServiceV1,
	type ContextAwareSnapshotV1,
} from "../src/context-service.js";
import { compactionStarts, largeHistory, NOTHING_TO_COMPACT, SEED, settle, smallHistory, waitFor, withSession } from "./compaction-preflight-harness.js";

function createEventBus(): EventBus {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	return {
		emit(channel, data) {
			for (const handler of handlers.get(channel) ?? []) handler(data);
		},
		on(channel, handler) {
			const listeners = handlers.get(channel) ?? new Set<(data: unknown) => void>();
			listeners.add(handler);
			handlers.set(channel, listeners);
			return () => {
				listeners.delete(handler);
			};
		},
	};
}

test("snapshot pressure changes produce typed phase-boundary guidance", () => {
	const base = {
		capturedAt: "2026-07-17T00:00:00.000Z",
		session: {
			id: "session-1",
			cwd: "/workspace/project",
			sessionFile: "/state/sessions/session-1.jsonl",
			leafEntryId: "leaf-1",
		},
		lineageSessionFiles: ["/state/sessions/parent.jsonl"],
		artifacts: [],
		compaction: { state: "idle" as const },
		effectiveMode: {
			seedMode: "auto-gen" as const,
			seedRewrite: true,
			ambiguityMode: "inherit" as const,
			effectiveAmbiguityMode: "cautious-proceed" as const,
			compactionModel: null,
		},
	};

	const ok = buildContextAwareSnapshotV1({
		...base,
		pressure: { tokens: 20_000, contextWindow: 200_000 },
	});
	const warn = buildContextAwareSnapshotV1({
		...base,
		pressure: { tokens: 130_000, contextWindow: 200_000 },
	});

	assert.equal(ok.protocolVersion, CONTEXT_AWARE_SERVICE_PROTOCOL_VERSION);
	assert.deepEqual(ok.pressure, {
		available: true,
		tokens: 20_000,
		contextWindow: 200_000,
		fraction: 0.1,
		headroom: 180_000,
		band: "OK",
		phaseBoundary: "not-advised",
	});
	assert.equal(warn.pressure.band, "WARN");
	assert.equal(warn.pressure.phaseBoundary, "advised");
	assert.equal(warn.pressure.headroom, 70_000);
	assert.equal(warn.session.current.uri, "file:///state/sessions/session-1.jsonl");
	assert.equal(warn.session.lineage[0]?.uri, "file:///state/sessions/parent.jsonl");
	assert.equal(ok.effectiveMode.proactiveCompaction, undefined, "protocol v1 remains compatible with older producers");
	assert.deepEqual(ok.session.compactions, []);

	const legacyProactive = buildContextAwareSnapshotV1({
		...base,
		pressure: { tokens: 20_000, contextWindow: 200_000 },
		effectiveMode: {
			...base.effectiveMode,
			proactiveCompaction: {
				enabled: true,
				thresholdFraction: 0.82,
				outputReserveTokens: 24_000,
				preparationStallTimeoutMs: 30_000,
				preparationFirstOutputGraceMs: 90_000,
				source: "project",
				sources: {
					enabled: "project",
					thresholdFraction: "project",
					outputReserveTokens: "project",
					preparationStallTimeoutMs: "project",
					preparationFirstOutputGraceMs: "project",
				},
			},
		},
	});
	assert.equal(
		"commitDrainTimeoutMs" in (legacyProactive.effectiveMode.proactiveCompaction ?? {}),
		false,
		"older protocol-v1 proactive producers may omit the additive commit-drain leaf",
	);
	assert.equal(
		"commitDrainTimeoutMs" in (legacyProactive.effectiveMode.proactiveCompaction?.sources ?? {}),
		false,
		"older protocol-v1 provenance may omit the additive commit-drain leaf",
	);

	const proactive = buildContextAwareSnapshotV1({
		...base,
		pressure: { tokens: 20_000, contextWindow: 200_000 },
		proactiveCompaction: {
			state: "generating",
			trigger: "generation-reserve",
			updatedAt: "2026-07-17T00:00:01.000Z",
			coalescedTriggers: 2,
			lastFailure: {
				stage: "seed-generation",
				message: "Prior seed request failed",
				at: "2026-07-17T00:00:00.500Z",
			},
		},
		effectiveMode: {
			...base.effectiveMode,
			proactiveCompaction: {
				enabled: true,
				thresholdFraction: 0.82,
				outputReserveTokens: 24_000,
				preparationStallTimeoutMs: 30_000,
				preparationFirstOutputGraceMs: 90_000,
				commitDrainTimeoutMs: 10_000,
				source: "project" as const,
				sources: {
					enabled: "project" as const,
					thresholdFraction: "project" as const,
					outputReserveTokens: "project" as const,
					preparationStallTimeoutMs: "project" as const,
					preparationFirstOutputGraceMs: "project" as const,
					commitDrainTimeoutMs: "project" as const,
				},
			},
		},
	});
	assert.deepEqual(proactive.effectiveMode.proactiveCompaction, {
		enabled: true,
		thresholdFraction: 0.82,
		outputReserveTokens: 24_000,
		preparationStallTimeoutMs: 30_000,
		preparationFirstOutputGraceMs: 90_000,
		commitDrainTimeoutMs: 10_000,
		source: "project",
		sources: {
			enabled: "project",
			thresholdFraction: "project",
			outputReserveTokens: "project",
			preparationStallTimeoutMs: "project",
			preparationFirstOutputGraceMs: "project",
			commitDrainTimeoutMs: "project",
		},
	});
	assert.deepEqual(proactive.proactiveCompaction, {
		state: "generating",
		trigger: "generation-reserve",
		updatedAt: "2026-07-17T00:00:01.000Z",
		coalescedTriggers: 2,
		lastFailure: {
			stage: "seed-generation",
			message: "Prior seed request failed",
			at: "2026-07-17T00:00:00.500Z",
		},
	});
	assert.equal(ok.proactiveCompaction, undefined, "the additive lifecycle field remains optional for older producers");
});

test("session compaction boundaries are additive and legacy projections remain unchanged", () => {
	const source = {
		pressure: null,
		session: { id: "legacy", cwd: "/workspace", sessionFile: "/state/legacy.jsonl" },
		lineageSessionFiles: [],
		compactions: [{
			ordinal: 1,
			id: "c1",
			parentId: null,
			timestamp: "2026-08-12T00:00:00.000Z",
			firstKeptEntryId: "kept-1",
			tokensBefore: 100,
			fromHook: false,
			priorTranscriptPath: "/state/legacy.jsonl",
		}],
		artifacts: [],
		compaction: { state: "idle" as const },
		effectiveMode: {
			seedMode: "auto-gen" as const,
			seedRewrite: true,
			ambiguityMode: "inherit" as const,
			effectiveAmbiguityMode: "cautious-proceed" as const,
			compactionModel: null,
		},
	};
	const snapshot = buildContextAwareSnapshotV1(source);
	assert.equal(snapshot.protocolVersion, 1);
	assert.equal(snapshot.session.compactions?.[0]?.id, "c1");
	source.compactions[0]!.id = "mutated-after-snapshot";
	assert.equal(snapshot.session.compactions?.[0]?.id, "c1");
	type LegacySnapshotV1 = Omit<ContextAwareSnapshotV1, "session"> & {
		session: Omit<ContextAwareSnapshotV1["session"], "compactions">;
	};
	const legacyConsumer = (value: LegacySnapshotV1): string => value.session.current.id;
	assert.equal(legacyConsumer(snapshot), "legacy");
	const legacyProjection = {
		protocolVersion: snapshot.protocolVersion,
		current: snapshot.session.current,
		lineage: snapshot.session.lineage,
		artifacts: snapshot.artifacts,
		compaction: snapshot.compaction,
		effectiveMode: snapshot.effectiveMode,
	};
	assert.equal("compactions" in legacyProjection, false);
	assert.equal(legacyProjection.protocolVersion, 1);
	assert.equal(legacyProjection.current.path, "/state/legacy.jsonl");
	const oldSource = { ...source };
	delete (oldSource as { compactions?: unknown }).compactions;
	assert.deepEqual(buildContextAwareSnapshotV1(oldSource).session.compactions, []);
});

test("snapshot returns bounded artifact and lineage references without file content", () => {
	const artifactPath = path.join("/state/sessions/context", "architecture.md");
	const snapshot = buildContextAwareSnapshotV1({
		capturedAt: "2026-07-17T00:00:00.000Z",
		pressure: null,
		session: {
			id: "session-2",
			cwd: "/workspace/project",
			sessionFile: "/state/sessions/session-2.jsonl",
			parentSessionFile: "/state/sessions/parent.jsonl",
			leafEntryId: null,
		},
		lineageSessionFiles: [
			"/state/sessions/parent.jsonl",
			"/state/sessions/older.jsonl",
			"/state/sessions/older.jsonl",
		],
		artifacts: [{
			id: "artifact-stable-1",
			file: "architecture.md",
			path: artifactPath,
			description: "Architecture decisions",
			sizeBytes: 4_096,
			updated: "2026-07-16T00:00:00.000Z",
			createdBy: "session-1",
			updatedBy: "session-2",
		}],
		compaction: { state: "queued", runId: "run-1" },
		effectiveMode: {
			seedMode: "user-approve",
			seedRewrite: true,
			ambiguityMode: "ask",
			effectiveAmbiguityMode: "ask",
			compactionModel: "openai/gpt-5-mini",
		},
	});

	assert.equal(snapshot.pressure.available, false);
	assert.equal(snapshot.session.lineage.length, 2);
	assert.deepEqual(snapshot.artifacts, [{
		kind: "context-cache-artifact",
		id: "artifact-stable-1",
		name: "architecture.md",
		uri: "file:///state/sessions/context/architecture.md",
		path: artifactPath,
		description: "Architecture decisions",
		sizeBytes: 4_096,
		updated: "2026-07-16T00:00:00.000Z",
		createdBy: "session-1",
		updatedBy: "session-2",
	}]);
	assert.equal("content" in snapshot.artifacts[0]!, false);
	assert.deepEqual(snapshot.compaction, { state: "queued", runId: "run-1" });
});

test("service discovery is synchronous, versioned, and disposable", () => {
	const events = createEventBus();
	const service = {
		protocolVersion: CONTEXT_AWARE_SERVICE_PROTOCOL_VERSION,
		getSnapshot: () => {
			throw new Error("not used");
		},
		promoteArtifact: () => ({
			status: "failed" as const,
			code: "PROMOTION_FAILED" as const,
			message: "not used",
		}),
		requestHandoff: async () => ({
			status: "failed" as const,
			code: "NOT_IMPLEMENTED" as const,
			message: "not used",
			stage: "validation" as const,
			recoverable: false,
		}),
		cancelHandoff: () => ({ status: "not-found" as const }),
	} satisfies ContextAwareServiceV1;

	const dispose = provideContextAwareServiceV1(events, service);
	let incompatibleAccepted = false;
	events.emit(CONTEXT_AWARE_SERVICE_DISCOVERY_EVENT, {
		protocolVersion: 2,
		consumerId: "future-consumer",
		accept: () => { incompatibleAccepted = true; },
	});
	assert.equal(incompatibleAccepted, false);
	assert.equal(discoverContextAwareServiceV1(events, "test-consumer"), service);
	dispose();
	assert.equal(discoverContextAwareServiceV1(events, "test-consumer"), undefined);
});

test("older protocol-v1 producers remain discoverable without promotion capability", () => {
	const events = createEventBus();
	const legacyService = {
		protocolVersion: CONTEXT_AWARE_SERVICE_PROTOCOL_VERSION,
		getSnapshot: () => { throw new Error("not used"); },
		requestHandoff: async () => ({
			status: "failed" as const,
			code: "NOT_IMPLEMENTED" as const,
			message: "not used",
			stage: "validation" as const,
			recoverable: false,
		}),
		cancelHandoff: () => ({ status: "not-found" as const }),
	} satisfies ContextAwareServiceV1;
	const dispose = provideContextAwareServiceV1(events, legacyService);
	const discovered = discoverContextAwareServiceV1(events, "legacy-consumer");

	assert.equal(discovered, legacyService);
	assert.equal(supportsContextAwareArtifactPromotionV1(discovered), false);
	assert.equal("promoteArtifact" in discovered!, false);
	assert.equal(supportsContextAwareArtifactPromotionV1(undefined), false);
	dispose();
});

// The compaction preflight, through a real Pi session: a handoff Pi would
// refuse gets this documented non-failure status at once, and nothing is queued.

function handoffRequest(requestId: string): ContextAwareHandoffRequestV1 {
	return { requestId, purpose: "Start the next phase", nextPhaseSeed: SEED, rewriteSeed: false, interactionMode: "non-interactive" };
}

test("requestHandoff answers nothing-to-compact for a session too small to compact, as Pi does", async () => {
	await withSession(smallHistory, [], async ({ session, events, preparations, service }) => {
		const result = await service.requestHandoff(handoffRequest("handoff-small"));
		if (result.status === "nothing-to-compact") {
			const refusal: ContextAwareHandoffNothingToCompactV1 = result;
			assert.equal(refusal.requestId, "handoff-small");
			assert.equal(refusal.message, "Nothing to compact (session too small); the conversation is unchanged.");
		} else {
			assert.fail(`expected nothing-to-compact, got ${JSON.stringify(result)}`);
		}
		await settle(session);
		assert.equal(compactionStarts(events), 0);
		assert.equal(preparations.length, 0);

		await assert.rejects(session.compact(), { message: NOTHING_TO_COMPACT });
	});
});

test("requestHandoff lets an already-aborted caller take precedence over nothing-to-compact", async () => {
	await withSession(smallHistory, [], async ({ session, events, preparations, service }) => {
		const caller = new AbortController();
		caller.abort();

		const result = await service.requestHandoff(handoffRequest("handoff-small-cancelled"), { signal: caller.signal });

		assert.equal(result.status, "cancelled", JSON.stringify(result));
		assert.equal(result.requestId, "handoff-small-cancelled");
		assert.equal(result.stage, "preparation");
		await settle(session);
		assert.equal(compactionStarts(events), 0);
		assert.equal(preparations.length, 0);
	});
});

test("requestHandoff checks a refused session before default user-approved seed rewriting", async () => {
	await withSession(smallHistory, [], async ({ session, faux, events, notifications, preparations, service }) => {
		fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR!, "context-aware.json"), `${JSON.stringify({
			seedMode: "user-approve",
			seedRewrite: true,
			contextCache: { enabled: false },
			sessionNaming: { scope: "off" },
			workstream: { enabled: false },
			proactiveCompaction: { enabled: false },
		})}\n`);

		const result = await service.requestHandoff({
			requestId: "handoff-small-default-rewrite",
			purpose: "Start the next phase",
			nextPhaseSeed: SEED,
			interactionMode: "non-interactive",
		});

		assert.equal(result.status, "nothing-to-compact", JSON.stringify(result));
		assert.equal(
			(result as { message?: unknown }).message,
			"Nothing to compact (session too small); the conversation is unchanged.",
		);
		assert.equal(faux.state.callCount, 0, "a refused snapshot must not rewrite the seed");
		assert.deepEqual(notifications, [], "a refused snapshot must not ask for clarification");
		await settle(session);
		assert.equal(compactionStarts(events), 0);
		assert.equal(preparations.length, 0);
	});
});

test("requestHandoff answers nothing-to-compact for a session whose newest entry is a compaction, as Pi does", async () => {
	await withSession(largeHistory, [], async ({ session, events, service }) => {
		// Appended once the session exists: creating it records the thinking level
		// after the history, and a compaction that is not newest does not count.
		const kept = session.sessionManager.getBranch().at(-1)!.id;
		session.sessionManager.appendCompaction("Earlier work, summarized.", kept, 30_000);
		const result = await service.requestHandoff(handoffRequest("handoff-compacted"));
		if (result.status === "nothing-to-compact") {
			assert.equal(result.message, "Already compacted; the conversation is unchanged.");
		} else {
			assert.fail(`expected nothing-to-compact, got ${JSON.stringify(result)}`);
		}
		await settle(session);
		assert.equal(compactionStarts(events), 0);

		await assert.rejects(session.compact(), { message: "Already compacted" });
	});
});

test("requestHandoff hands a session Pi compacts to Pi", async () => {
	await withSession(largeHistory, [], async ({ events, preparations, service }) => {
		const result = await service.requestHandoff(handoffRequest("handoff-large"));
		assert.match(result.status, /^(queued|running)$/u, JSON.stringify(result));
		await waitFor(() => preparations.length > 0, "Pi's compaction");
		assert.equal(compactionStarts(events), 1);
		assert.ok(preparations[0]!.messagesToSummarize.length > 0, "Pi found history to summarize");
	});
});

test("handoff validation enforces explicit purpose, seed, and bounded input", () => {
	assert.deepEqual(validateContextAwareHandoffRequestV1({
		requestId: "handoff-1",
		purpose: "Start implementation phase",
		nextPhaseSeed: "Implement the approved contract",
		interactionMode: "non-interactive",
		bounds: { maxSeedCharacters: 100, maxSummaryFocusCharacters: 50 },
	}), {
		ok: true,
		request: {
			requestId: "handoff-1",
			purpose: "Start implementation phase",
			nextPhaseSeed: "Implement the approved contract",
			interactionMode: "non-interactive",
			bounds: { maxSeedCharacters: 100, maxSummaryFocusCharacters: 50 },
		},
	});

	const tooLong = validateContextAwareHandoffRequestV1({
		requestId: "handoff-2",
		purpose: "Start implementation phase",
		nextPhaseSeed: "12345",
		interactionMode: "non-interactive",
		bounds: { maxSeedCharacters: 4 },
	});
	assert.equal(tooLong.ok, false);
	if (!tooLong.ok) assert.equal(tooLong.code, "BOUNDS_EXCEEDED");

	const malformedBounds = validateContextAwareHandoffRequestV1({
		requestId: "handoff-malformed-bounds",
		purpose: "Start implementation phase",
		nextPhaseSeed: "Continue",
		interactionMode: "non-interactive",
		bounds: "not-an-object",
	} as unknown as Parameters<typeof validateContextAwareHandoffRequestV1>[0]);
	assert.equal(malformedBounds.ok, false);
	if (!malformedBounds.ok) assert.equal(malformedBounds.code, "INVALID_REQUEST");

	const missingPurpose = validateContextAwareHandoffRequestV1({
		requestId: "handoff-3",
		purpose: " ",
		nextPhaseSeed: "Continue",
		interactionMode: "non-interactive",
	});
	assert.equal(missingPurpose.ok, false);
	if (!missingPurpose.ok) assert.equal(missingPurpose.code, "INVALID_REQUEST");
});

test("promotion validation projects the typed request fields", () => {
	const validated = validateContextAwareArtifactPromotionRequestV1({
		sourcePath: "  /tmp/workspace/artifacts/plan.md  ",
		file: "  promoted-plan.md  ",
		description: "  Durable plan  ",
	});
	assert.deepEqual(validated, {
		ok: true,
		request: {
			sourcePath: "/tmp/workspace/artifacts/plan.md",
			file: "promoted-plan.md",
			description: "Durable plan",
		},
	});
});

test("promotion validation rejects caller-supplied source-authority properties", () => {
	for (const property of ["workspaceRoot", "trustedRoot", "trusted", "marker", "manifest", "content", "createdBy", "artifactId"]) {
		const request = {
			sourcePath: "/tmp/workspace/artifacts/plan.md",
			file: "promoted-plan.md",
			[property]: property === "trusted" ? true : "/tmp/attacker-controlled",
		} as unknown as Parameters<typeof validateContextAwareArtifactPromotionRequestV1>[0];
		assert.deepEqual(validateContextAwareArtifactPromotionRequestV1(request), {
			ok: false,
			code: "INVALID_REQUEST",
			message: `Promotion request contains an unknown property: ${property}.`,
		});
	}
});

test("promotion validation fails closed when an adversarial request getter throws", () => {
	const request = new Proxy({}, { get() { throw new Error("secret getter"); } }) as unknown as Parameters<typeof validateContextAwareArtifactPromotionRequestV1>[0];
	assert.deepEqual(validateContextAwareArtifactPromotionRequestV1(request), {
		ok: false,
		code: "INVALID_REQUEST",
		message: "Promotion request is malformed.",
	});
});

test("promotion validation rejects every case variant of the reserved manifest name", () => {
	for (const alias of ["_manifest.json", "_MANIFEST.JSON", "_Manifest.Json", "_manifest.JSON", "_MANIFEST.json"]) {
		const result = validateContextAwareArtifactPromotionRequestV1({
			sourcePath: "/tmp/workspace/artifacts/plan.md",
			file: alias,
		});
		assert.equal(result.ok, false, `the reserved manifest alias ${alias} must be refused`);
		if (!result.ok) assert.equal(result.code, "INVALID_REQUEST");
	}
});

test("a producer that implements promotion is recognized by the capability guard", () => {
	const events = createEventBus();
	const service = {
		protocolVersion: CONTEXT_AWARE_SERVICE_PROTOCOL_VERSION,
		getSnapshot: () => { throw new Error("not used"); },
		promoteArtifact: () => ({
			status: "failed" as const,
			code: "PROMOTION_FAILED" as const,
			message: "not used",
		}),
		requestHandoff: async () => ({
			status: "failed" as const,
			code: "NOT_IMPLEMENTED" as const,
			message: "not used",
			stage: "validation" as const,
			recoverable: false,
		}),
		cancelHandoff: () => ({ status: "not-found" as const }),
	} satisfies ContextAwareServiceV1;
	const dispose = provideContextAwareServiceV1(events, service);
	const discovered = discoverContextAwareServiceV1(events, "promotion-consumer");
	assert.equal(discovered, service);
	assert.equal(supportsContextAwareArtifactPromotionV1(discovered), true);
	if (supportsContextAwareArtifactPromotionV1(discovered)) {
		// The guard narrows the type so promoteArtifact is a required member.
		assert.equal(typeof discovered.promoteArtifact, "function");
	}
	dispose();
});
