import test from "node:test";
import assert from "node:assert/strict";
import {
	MAX_ADVISORY_ENTRY_BYTES,
	MAX_INSTRUCTION_CHARS,
	WORKER_COMPACTION_CHANNEL,
	WORKER_COMPACTION_INSTRUCTIONS,
	appendWorkerCompactionPressure,
	appendWorkerCompactionSatisfied,
	buildWorkerCompactionAdvisory,
	latestWorkerCompactionAdvisory,
	parseWorkerCompactionAdvisory,
	type WorkerCompactionAdvisoryV1,
	type WorkerCompactionSessionEntries,
} from "../worker-compaction-contract.js";

const observedAt = "2026-08-18T12:34:56.000Z";
const usage = { tokens: 212_160, contextWindow: 272_000, fraction: 0.78 };

function required(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: 1,
		state: "required",
		revision: 1,
		observedAt,
		usage,
		reason: "generation-reserve",
		instructions: WORKER_COMPACTION_INSTRUCTIONS,
		...overrides,
	};
}

function byteLength(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function createSession(initialEntries: unknown[] = []): {
	session: WorkerCompactionSessionEntries;
	entries: unknown[];
} {
	const entries = [...initialEntries];
	return {
		entries,
		session: {
			getEntries: () => entries,
			appendCustomEntry: (customType, data) => {
				entries.push({ type: "custom", customType, data });
			},
		},
	};
}

function advisories(entries: readonly unknown[]): WorkerCompactionAdvisoryV1[] {
	return entries.flatMap((entry) => {
		if (typeof entry !== "object" || entry === null) return [];
		const candidate = entry as { customType?: unknown; data?: unknown };
		if (candidate.customType !== WORKER_COMPACTION_CHANNEL) return [];
		const parsed = parseWorkerCompactionAdvisory(candidate.data);
		return parsed === undefined ? [] : [parsed];
	});
}

test("valid advisories round-trip through plain JSON", () => {
	const advised = buildWorkerCompactionAdvisory({
		state: "advised",
		revision: 1,
		observedAt,
		usage,
		reason: "threshold",
		instructions: WORKER_COMPACTION_INSTRUCTIONS,
	});
	const requiredEntry = buildWorkerCompactionAdvisory({
		state: "required",
		revision: 2,
		observedAt,
		usage,
		reason: "output-limit",
		instructions: WORKER_COMPACTION_INSTRUCTIONS,
	});
	const satisfied = buildWorkerCompactionAdvisory({
		state: "satisfied",
		revision: 3,
		observedAt,
		satisfiedRevision: 2,
	});

	for (const advisory of [advised, requiredEntry, satisfied]) {
		assert.deepEqual(parseWorkerCompactionAdvisory(JSON.parse(JSON.stringify(advisory))), advisory);
	}
});

test("validator and builder accept only canonical UTC observedAt timestamps", () => {
	const canonical = buildWorkerCompactionAdvisory({
		state: "required",
		revision: 1,
		observedAt,
		reason: "generation-reserve",
		instructions: WORKER_COMPACTION_INSTRUCTIONS,
	});
	assert.equal(canonical.observedAt, observedAt);
	assert.deepEqual(parseWorkerCompactionAdvisory(required()), required());

	const rejected = [
		"2026-08-18",
		"2026-08-18T12:34:56+01:00",
	].map((candidate) => {
		const parsed = parseWorkerCompactionAdvisory(required({ observedAt: candidate })) !== undefined;
		let built = true;
		try {
			buildWorkerCompactionAdvisory({
				state: "required",
				revision: 1,
				observedAt: candidate,
				reason: "generation-reserve",
				instructions: WORKER_COMPACTION_INSTRUCTIONS,
			});
		} catch {
			built = false;
		}
		return { candidate, parsed, built };
	});
	assert.deepEqual(rejected, [
		{ candidate: "2026-08-18", parsed: false, built: false },
		{ candidate: "2026-08-18T12:34:56+01:00", parsed: false, built: false },
	]);
});

test("every malformed wire condition is ignored without throwing", () => {
	const malformed: Array<[string, unknown]> = [
		["null", null],
		["wrong schema", required({ schemaVersion: 2 })],
		["unknown state", required({ state: "urgent" })],
		["zero revision", required({ revision: 0 })],
		["unsafe revision", required({ revision: Number.MAX_SAFE_INTEGER + 1 })],
		["unparseable timestamp", required({ observedAt: "not-a-date" })],
		["usage is not an object", required({ usage: "many" })],
		["non-finite usage tokens", required({ usage: { ...usage, tokens: Number.NaN } })],
		["non-finite context window", required({ usage: { ...usage, contextWindow: Number.POSITIVE_INFINITY } })],
		["non-finite fraction", required({ usage: { ...usage, fraction: Number.NaN } })],
		["fraction below zero", required({ usage: { ...usage, fraction: -0.01 } })],
		["fraction above one", required({ usage: { ...usage, fraction: 1.01 } })],
		["instructions is not a string", required({ instructions: 42 })],
		["instructions exceeds the character bound", required({ instructions: "x".repeat(MAX_INSTRUCTION_CHARS + 1) })],
		["payload exceeds the byte bound", required({ future: "x".repeat(MAX_ADVISORY_ENTRY_BYTES) })],
		["advisory lacks instructions", required({ instructions: undefined })],
		["advisory lacks a reason", required({ reason: undefined })],
		["satisfied lacks its discharged revision", required({ state: "satisfied", reason: undefined, instructions: undefined })],
	];
	const circular = required();
	circular.self = circular;
	malformed.push(["circular payload", circular]);
	const throwingField = {};
	Object.defineProperty(throwingField, "schemaVersion", {
		enumerable: false,
		get: () => { throw new Error("malformed getter must not escape"); },
	});
	malformed.push(["throwing property", throwingField]);

	for (const [label, candidate] of malformed) {
		assert.doesNotThrow(() => parseWorkerCompactionAdvisory(candidate), label);
		assert.equal(parseWorkerCompactionAdvisory(candidate), undefined, label);
	}
});

test("unknown fields are tolerated while known fields are projected", () => {
	const parsed = parseWorkerCompactionAdvisory(required({ futureStateDetail: { mode: "later" } }));
	assert.ok(parsed);
	assert.equal("futureStateDetail" in parsed, false);
	assert.equal(parsed.state, "required");
});

test("the builder enforces instruction characters and whole-payload bytes", () => {
	const ascii = buildWorkerCompactionAdvisory({
		state: "advised",
		revision: 1,
		observedAt,
		reason: "threshold",
		instructions: "x".repeat(MAX_INSTRUCTION_CHARS + 500),
	});
	assert.equal(ascii.instructions?.length, MAX_INSTRUCTION_CHARS);
	assert.ok(byteLength(ascii) <= MAX_ADVISORY_ENTRY_BYTES);

	const multibyte = buildWorkerCompactionAdvisory({
		state: "required",
		revision: 2,
		observedAt,
		reason: "generation-reserve",
		instructions: "界".repeat(MAX_INSTRUCTION_CHARS),
	});
	assert.ok((multibyte.instructions?.length ?? 0) < MAX_INSTRUCTION_CHARS);
	assert.ok(byteLength(multibyte) <= MAX_ADVISORY_ENTRY_BYTES);
	assert.deepEqual(parseWorkerCompactionAdvisory(multibyte), multibyte);
});

test("same-state pressure is coalesced below one percentage point", () => {
	const { session, entries } = createSession();
	assert.ok(appendWorkerCompactionPressure(session, {
		state: "advised",
		reason: "threshold",
		usage,
		observedAt,
	}));
	assert.equal(appendWorkerCompactionPressure(session, {
		state: "advised",
		reason: "threshold",
		usage: { ...usage, fraction: 0.789 },
		observedAt,
	}), undefined);
	assert.ok(appendWorkerCompactionPressure(session, {
		state: "advised",
		reason: "threshold",
		usage: { ...usage, fraction: 0.80 },
		observedAt,
	}));
	assert.ok(appendWorkerCompactionPressure(session, {
		state: "required",
		reason: "generation-reserve",
		usage: { ...usage, fraction: 0.80 },
		observedAt,
	}), "required supersedes advised at the same pressure");
	assert.equal(appendWorkerCompactionPressure(session, {
		state: "advised",
		reason: "threshold",
		usage: { ...usage, fraction: 0.90 },
		observedAt,
	}), undefined, "an outstanding required entry is never weakened to advised");
	assert.deepEqual(advisories(entries).map((entry) => [entry.revision, entry.state]), [
		[1, "advised"],
		[2, "advised"],
		[3, "required"],
	]);
});

test("same-state pressure appends at an exact one percentage point rise across base values", () => {
	const results = [
		{ base: 0.40, next: 0.41 },
		{ base: 0.10, next: 0.11 },
		{ base: 0.78, next: 0.79 },
	].map(({ base, next }) => {
		const { session, entries } = createSession();
		appendWorkerCompactionPressure(session, {
			state: "advised",
			reason: "threshold",
			usage: { ...usage, fraction: base },
			observedAt,
		});
		const appended = appendWorkerCompactionPressure(session, {
			state: "advised",
			reason: "threshold",
			usage: { ...usage, fraction: next },
			observedAt,
		});
		return { base, next, appended: appended !== undefined, entryCount: advisories(entries).length };
	});

	assert.deepEqual(results, [
		{ base: 0.40, next: 0.41, appended: true, entryCount: 2 },
		{ base: 0.10, next: 0.11, appended: true, entryCount: 2 },
		{ base: 0.78, next: 0.79, appended: true, entryCount: 2 },
	]);
});

test("a worker compaction appends satisfied for the latest outstanding revision", () => {
	const malformedHigherRevision = {
		type: "custom",
		customType: WORKER_COMPACTION_CHANNEL,
		data: required({ revision: 99, observedAt: "bad" }),
	};
	const { session, entries } = createSession([malformedHigherRevision]);
	const pressure = appendWorkerCompactionPressure(session, {
		state: "required",
		reason: "output-limit",
		usage,
		observedAt,
	});
	assert.equal(pressure?.revision, 1);
	const satisfied = appendWorkerCompactionSatisfied(session, observedAt);
	assert.deepEqual(satisfied, {
		schemaVersion: 1,
		state: "satisfied",
		revision: 2,
		observedAt,
		satisfiedRevision: 1,
	});
	assert.equal(appendWorkerCompactionSatisfied(session, observedAt), undefined);
	assert.deepEqual(latestWorkerCompactionAdvisory(entries), satisfied);
});
