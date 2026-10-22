import test from "node:test";
import assert from "node:assert/strict";

import { findTask, resolveAuthoritativeTasks } from "../src/session-tasks/session-tasks.js";
import {
	ANSWER_ENTRY_TYPE,
	ASK_ANSWER_MESSAGE_TYPE,
	ASK_CLOSED_ENTRY_TYPE,
	ASK_ENTRY_TYPE,
	ASK_RAISED_ENTRY_TYPE,
	FABRIC_DECISION_REQUEST_EVENT,
	FABRIC_DECISIONS_CAPABILITY_EVENT,
	replayAsks,
} from "../src/session-tasks/session-asks.js";
import { focusFixture, type FixtureEventBus, type FocusFixture } from "./session-focus-harness.js";

// issue #214: a blocked task can ask the user a question.
// Assertions read replayed session entries, the per-turn message, the messages
// sent through pi.sendMessage, and the requests a fake Fabric received.

interface FakeRequest {
	readonly id: string;
	readonly question: { title: string; body?: string; options?: Array<{ id: string; label: string }> };
	readonly source: unknown;
	readonly signal: AbortSignal;
	readonly respond: (result: unknown) => void;
	readonly responses: unknown[];
}

interface FakeFabric {
	readonly bus: FixtureEventBus;
	readonly requests: FakeRequest[];
	answer(index: number, answer: { text?: string; optionId?: string }): void;
	settle(index: number, status: "cancelled" | "expired"): void;
}

let decisionCounter = 0;

/** A Fabric stand-in that claims the capability and request events, as pi-fabric does. */
function fakeFabric(): FakeFabric {
	const requests: FakeRequest[] = [];
	const bus: FixtureEventBus = {
		emit(channel, data) {
			const record = data as Record<string, unknown>;
			if (channel === FABRIC_DECISIONS_CAPABILITY_EVENT) {
				if (!(record.claim as () => boolean)()) return;
				// Fabric answers after an import, so the response is asynchronous.
				queueMicrotask(() => (record.respond as (result: unknown) => void)({
					ok: true, available: true, inputs: ["text", "select", "confirm", "editor"],
					maxOptions: 8, maxTitleChars: 120, maxBodyChars: 2_000, maxTextChars: 2_000, minTimeoutMs: 1_000, maxTimeoutMs: 86_400_000,
				}));
				return;
			}
			if (channel === FABRIC_DECISION_REQUEST_EVENT) {
				if (record.version !== 1 || !(record.claim as () => boolean)()) return;
				decisionCounter += 1;
				const id = `dec-${decisionCounter}`;
				const responses: unknown[] = [];
				const respond = (result: unknown) => {
					responses.push(result);
					(record.respond as (result: unknown) => void)(result);
				};
				const request: FakeRequest = {
					id,
					question: record.question as FakeRequest["question"],
					source: record.source,
					signal: record.signal as AbortSignal,
					respond,
					responses,
				};
				requests.push(request);
				(record.onRaised as (decisionId: string) => void)(id);
				// Aborting the signal cancels the decision and responds ok: false.
				request.signal.addEventListener("abort", () => respond({ ok: false, error: "cancelled by the asking extension", id }), { once: true });
			}
		},
		on() {
			return () => {};
		},
	};
	return {
		bus,
		requests,
		answer(index, answer) {
			const request = requests[index];
			assert.ok(request, `expected decision request ${index}`);
			request.respond({ ok: true, id: request.id, status: "answered", answer: { ...answer, answeredBy: "user", via: "tui", at: Date.now() } });
		},
		settle(index, status) {
			const request = requests[index];
			assert.ok(request, `expected decision request ${index}`);
			request.respond({ ok: true, id: request.id, status });
		},
	};
}

async function settle(): Promise<void> {
	for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function withFixture(
	body: (fixture: FocusFixture) => Promise<void>,
	options: { entries?: unknown[]; fabric?: FakeFabric; sessionName?: string } = {},
): Promise<void> {
	const fixture = await focusFixture(options.entries ?? [], {
		...(options.fabric === undefined ? {} : { events: options.fabric.bus }),
		...(options.sessionName === undefined ? {} : { sessionName: options.sessionName }),
	});
	try {
		await settle();
		await body(fixture);
	} finally {
		fixture.cleanup();
	}
}

function customData(entries: readonly unknown[], customType: string): Record<string, unknown>[] {
	return entries
		.filter((entry) => (entry as { customType?: string }).customType === customType)
		.map((entry) => (entry as { data: Record<string, unknown> }).data);
}

function task(entries: readonly unknown[], id: string) {
	const snapshot = resolveAuthoritativeTasks(entries);
	assert.ok(snapshot, "expected a task list");
	const found = findTask(snapshot.tasks, id);
	assert.ok(found, `expected task ${id}`);
	return found.task;
}

async function planAndAsk(fixture: FocusFixture, ask: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<void> {
	const planned = await fixture.call("session_tasks", { action: "plan", tasks: [{ title: "pick the database" }, { title: "write the migration" }] });
	assert.notEqual(planned.isError, true, planned.content[0]?.text);
	const asked = await fixture.call("session_tasks", { action: "update", updates: [{ id: "t1", status: "blocked", ask, ...extra }] });
	assert.notEqual(asked.isError, true, asked.content[0]?.text);
	await settle();
}

const DB_ASK = { question: "Which database should the service use?", options: [{ id: "pg", label: "Postgres" }, { id: "sqlite", label: "SQLite" }] };

test("blocking with ask records an ask entry and shows the question in the session-tasks envelope", async () => {
	await withFixture(async (fixture) => {
		await planAndAsk(fixture, DB_ASK);
		const asks = customData(fixture.entries, ASK_ENTRY_TYPE);
		assert.equal(asks.length, 1);
		const [ask] = asks;
		assert.equal(ask?.schemaVersion, 1);
		assert.equal(ask?.taskId, "t1");
		assert.equal(ask?.question, DB_ASK.question);
		assert.deepEqual(ask?.options, DB_ASK.options);
		assert.match(String(ask?.askId), /^ask-/u);
		assert.ok(Number.isFinite(Date.parse(String(ask?.createdAt))));

		const blocked = task(fixture.entries, "t1");
		assert.equal(blocked.status, "blocked");
		assert.equal(blocked.note, DB_ASK.question, "a missing note defaults to the question");

		const message = await fixture.turnMessage();
		assert.match(message, /<task id="t1" status="blocked" waiting-on="user" question="Which database should the service use\?">pick the database<\/task>/u);
		assert.match(message, /<task id="t2" status="pending">write the migration<\/task>/u, "a task without an ask is not marked");
	});
});

test("an ask on a task linked to a goal records the goal", async () => {
	await withFixture(async (fixture) => {
		await fixture.call("session_tasks", { action: "plan", tasks: [{ title: "pick the database", goal: "g1" }] });
		await fixture.call("session_tasks", { action: "update", updates: [{ id: "t1", status: "blocked", note: "needs a choice", ask: { question: "Which one?" } }] });
		const [ask] = customData(fixture.entries, ASK_ENTRY_TYPE);
		assert.equal(ask?.goal, "g1");
		assert.equal(task(fixture.entries, "t1").note, "needs a choice", "an explicit note is kept");
	});
});

test("with a Fabric claimant an ask raises exactly one decision whose title names the session and the task", async () => {
	const fabric = fakeFabric();
	await withFixture(async (fixture) => {
		await planAndAsk(fixture, DB_ASK);
		assert.equal(fabric.requests.length, 1);
		const [request] = fabric.requests;
		assert.equal(request?.source, "pi-context-aware");
		assert.match(request?.question.title ?? "", /db-migration/u, "the title names the session");
		assert.match(request?.question.title ?? "", /task t1\b/u, "the title names the task");
		assert.ok((request?.question.title.length ?? 0) <= 120, "the title respects maxTitleChars");
		assert.equal(request?.question.body, DB_ASK.question);
		assert.deepEqual(request?.question.options, DB_ASK.options);
		assert.equal(request?.signal.aborted, false);

		const raised = customData(fixture.entries, ASK_RAISED_ENTRY_TYPE);
		const [ask] = customData(fixture.entries, ASK_ENTRY_TYPE);
		assert.deepEqual(raised, [{ askId: ask?.askId, decisionId: request?.id }]);
	}, { fabric, sessionName: "db-migration" });
});

test("a Fabric answer unblocks the task, records the answer as its note, and sends one follow-up that starts a turn", async () => {
	const fabric = fakeFabric();
	await withFixture(async (fixture) => {
		await planAndAsk(fixture, DB_ASK);
		fabric.answer(0, { optionId: "pg" });
		await settle();

		const answered = task(fixture.entries, "t1");
		assert.equal(answered.status, "pending");
		assert.equal(answered.note, "Postgres", "an option answer is recorded as the option's label");
		const answers = customData(fixture.entries, ANSWER_ENTRY_TYPE);
		assert.equal(answers.length, 1);
		assert.equal(answers[0]?.route, "fabric");
		assert.equal(answers[0]?.answer, "Postgres");

		assert.equal(fixture.sent.length, 1, "exactly one follow-up");
		const [sent] = fixture.sent;
		assert.equal(sent?.message.customType, ASK_ANSWER_MESSAGE_TYPE);
		assert.deepEqual(sent?.options, { triggerTurn: true, deliverAs: "followUp" });
		assert.match(String(sent?.message.content), /The user answered the question on task t1/u);
		assert.match(String(sent?.message.content), /relays the answer/u);
		assert.match(String(sent?.message.content), /Postgres/u);

		const message = await fixture.turnMessage();
		assert.doesNotMatch(message, /waiting-on="user"/u, "an answered ask is no longer shown");

		// A second Fabric response and a later /answer change nothing.
		const entryCount = fixture.entries.length;
		fabric.answer(0, { text: "SQLite" });
		await fixture.command("answer", "t1 SQLite");
		await settle();
		assert.equal(fixture.entries.length, entryCount);
		assert.equal(fixture.sent.length, 1);
		assert.equal(task(fixture.entries, "t1").note, "Postgres");
	}, { fabric });
});

test("a cancelled or expired Fabric decision does not answer the ask", async () => {
	const fabric = fakeFabric();
	await withFixture(async (fixture) => {
		await planAndAsk(fixture, DB_ASK);
		fabric.settle(0, "expired");
		await settle();
		assert.equal(customData(fixture.entries, ANSWER_ENTRY_TYPE).length, 0);
		assert.equal(task(fixture.entries, "t1").status, "blocked");
		assert.equal(fixture.sent.length, 0);
	}, { fabric });
});

test("/answer unblocks the task, aborts the Fabric request, and a second answer changes nothing", async () => {
	const fabric = fakeFabric();
	await withFixture(async (fixture) => {
		await planAndAsk(fixture, DB_ASK);
		const request = fabric.requests[0];
		assert.ok(request);

		await fixture.command("answer", "t1 sqlite");
		await settle();
		assert.equal(request.signal.aborted, true, "the pending decision is cancelled");
		const answered = task(fixture.entries, "t1");
		assert.equal(answered.status, "pending");
		assert.equal(answered.note, "SQLite", "an option id resolves to its label");
		const answers = customData(fixture.entries, ANSWER_ENTRY_TYPE);
		assert.deepEqual(answers.map((answer) => [answer.route, answer.answer]), [["command", "SQLite"]]);
		assert.equal(fixture.sent.length, 1);
		assert.deepEqual(fixture.sent[0]?.options, { triggerTurn: true, deliverAs: "followUp" });

		const entryCount = fixture.entries.length;
		await fixture.command("answer", "t1 Postgres");
		const agentRetry = await fixture.call("session_tasks", { action: "update", updates: [{ id: "t1", answer: "Postgres" }] });
		assert.equal(agentRetry.isError, true, "an answered ask cannot be answered again");
		await settle();
		assert.equal(fixture.entries.length, entryCount);
		assert.equal(fixture.sent.length, 1);
		assert.equal(task(fixture.entries, "t1").note, "SQLite");
	}, { fabric });
});

test("an answer the agent records from chat unblocks the task and aborts the Fabric request", async () => {
	const fabric = fakeFabric();
	await withFixture(async (fixture) => {
		await planAndAsk(fixture, DB_ASK);
		const request = fabric.requests[0];
		assert.ok(request);

		const result = await fixture.call("session_tasks", { action: "update", updates: [{ id: "t1", answer: "Use Postgres 16" }] });
		assert.notEqual(result.isError, true, result.content[0]?.text);
		await settle();
		assert.equal(request.signal.aborted, true);
		const answered = task(fixture.entries, "t1");
		assert.equal(answered.status, "pending");
		assert.equal(answered.note, "Use Postgres 16");
		assert.deepEqual(customData(fixture.entries, ANSWER_ENTRY_TYPE).map((answer) => answer.route), ["agent"]);
		assert.equal(fixture.sent.length, 0, "the agent is already in a turn, so nothing wakes it");

		// The aborted decision's response and a later /answer change nothing.
		const entryCount = fixture.entries.length;
		fabric.answer(0, { text: "SQLite" });
		await fixture.command("answer", "t1 SQLite");
		await settle();
		assert.equal(fixture.entries.length, entryCount);
		assert.equal(fixture.sent.length, 0);
	}, { fabric });
});

test("an answer on a task without an open question is refused", async () => {
	await withFixture(async (fixture) => {
		await fixture.call("session_tasks", { action: "plan", tasks: [{ title: "pick the database" }] });
		const result = await fixture.call("session_tasks", { action: "update", updates: [{ id: "t1", answer: "Postgres" }] });
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /no open question/u);
		const notBlocked = await fixture.call("session_tasks", { action: "update", updates: [{ id: "t1", status: "active", ask: { question: "Which?" } }] });
		assert.equal(notBlocked.isError, true, "ask needs status blocked");
		assert.equal(customData(fixture.entries, ASK_ENTRY_TYPE).length, 0);
	});
});

test("after a restart each unanswered ask is raised again and an answered one is not", async () => {
	const entries: unknown[] = [];
	const first = fakeFabric();
	await withFixture(async (fixture) => {
		await fixture.call("session_tasks", { action: "plan", tasks: [{ title: "pick the database" }, { title: "pick the region" }] });
		await fixture.call("session_tasks", { action: "update", updates: [
			{ id: "t1", status: "blocked", ask: { question: "Which database?" } },
			{ id: "t2", status: "blocked", ask: { question: "Which region?" } },
		] });
		await settle();
		assert.equal(first.requests.length, 2);
		await fixture.command("answer", "t1 Postgres");
		await fixture.shutdown();
		assert.ok(first.requests.every((request) => request.signal.aborted), "shutdown aborts in-flight requests");
	}, { entries, fabric: first });

	const second = fakeFabric();
	await withFixture(async (fixture) => {
		assert.equal(second.requests.length, 1, "only the open ask is raised again");
		assert.match(second.requests[0]?.question.title ?? "", /task t2\b/u);
		assert.equal(second.requests[0]?.question.body, "Which region?");
		const open = customData(fixture.entries, ASK_ENTRY_TYPE).find((ask) => ask.taskId === "t2");
		const raised = customData(fixture.entries, ASK_RAISED_ENTRY_TYPE).filter((entry) => entry.askId === open?.askId);
		assert.equal(raised.length, 2, "the new decision is recorded next to the first");

		second.answer(0, { text: "eu-west" });
		await settle();
		assert.equal(task(fixture.entries, "t2").status, "pending");
		assert.equal(task(fixture.entries, "t2").note, "eu-west");
		assert.equal(fixture.sent.length, 1);
	}, { entries, fabric: second });
});

test("with no Fabric claimant asking and answering still work in-session", async () => {
	await withFixture(async (fixture) => {
		await planAndAsk(fixture, DB_ASK);
		assert.equal(customData(fixture.entries, ASK_ENTRY_TYPE).length, 1);
		assert.equal(customData(fixture.entries, ASK_RAISED_ENTRY_TYPE).length, 0, "nothing was raised");
		assert.match(await fixture.turnMessage(), /waiting-on="user"/u);

		await fixture.command("answer", "t1 Postgres");
		await settle();
		assert.equal(task(fixture.entries, "t1").status, "pending");
		assert.equal(task(fixture.entries, "t1").note, "Postgres");
		assert.equal(fixture.sent.length, 1);
		assert.deepEqual(fixture.sent[0]?.options, { triggerTurn: true, deliverAs: "followUp" });
	});
});

test("secret-shaped question text is redacted and extra caller fields are not stored", async () => {
	const fabric = fakeFabric();
	await withFixture(async (fixture) => {
		await planAndAsk(fixture, {
			question: "Deploy with token=secret-value or wait?",
			options: [{ id: "go", label: "Deploy now", extra: "leak-option" }],
			smuggled: "leak-ask",
		});
		const [ask] = customData(fixture.entries, ASK_ENTRY_TYPE);
		assert.ok(ask);
		assert.deepEqual(Object.keys(ask).sort(), ["askId", "createdAt", "options", "question", "schemaVersion", "taskId"]);
		assert.deepEqual(ask.options, [{ id: "go", label: "Deploy now" }]);
		const serialized = JSON.stringify(fixture.entries);
		assert.doesNotMatch(serialized, /secret-value/u, "the session file must not hold the secret");
		assert.doesNotMatch(serialized, /leak-option|leak-ask/u, "caller fields outside the contract are dropped");
		assert.match(String(ask.question), /\[REDACTED\]/u);
		assert.doesNotMatch(JSON.stringify(fabric.requests[0]?.question), /secret-value/u);
		assert.doesNotMatch(await fixture.turnMessage(), /secret-value/u);

		await fixture.command("answer", "t1 yes, password=hunter2-value");
		assert.doesNotMatch(JSON.stringify(fixture.entries), /hunter2-value/u, "answers are redacted too");
		assert.doesNotMatch(JSON.stringify(fixture.sent), /hunter2-value/u);
	}, { fabric });
});

test("over-long asks and answers are refused with a reason, not truncated", async () => {
	await withFixture(async (fixture) => {
		await fixture.call("session_tasks", { action: "plan", tasks: [{ title: "pick the database" }] });
		const cases = [
			{ question: "q".repeat(501) },
			{ question: "Which?", options: Array.from({ length: 9 }, (_, index) => ({ id: `o${index}`, label: "x" })) },
			{ question: "Which?", options: [{ id: "a", label: "l".repeat(81) }] },
		];
		for (const ask of cases) {
			const result = await fixture.callUnprepared("session_tasks", { action: "update", updates: [{ id: "t1", status: "blocked", ask }] });
			assert.equal(result.isError, true, JSON.stringify(ask).slice(0, 80));
		}
		assert.equal(customData(fixture.entries, ASK_ENTRY_TYPE).length, 0);
		assert.equal(task(fixture.entries, "t1").status, "pending", "a refused batch changes nothing");

		await fixture.call("session_tasks", { action: "update", updates: [{ id: "t1", status: "blocked", ask: { question: "Which?" } }] });
		const long = await fixture.callUnprepared("session_tasks", { action: "update", updates: [{ id: "t1", answer: "a".repeat(501) }] });
		assert.equal(long.isError, true);
		assert.equal(customData(fixture.entries, ANSWER_ENTRY_TYPE).length, 0);
	});
});

test("replay keeps the first answer for an ask even when a later answer entry exists", () => {
	const at = "2026-10-21T00:00:00.000Z";
	const custom = (customType: string, data: unknown) => ({ type: "custom", customType, data });
	const states = replayAsks([
		custom(ASK_ENTRY_TYPE, { schemaVersion: 1, askId: "ask-a", taskId: "t1", question: "Which?", createdAt: at }),
		custom(ANSWER_ENTRY_TYPE, { askId: "ask-a", answer: "first", route: "command", answeredAt: at }),
		custom(ANSWER_ENTRY_TYPE, { askId: "ask-a", answer: "second", route: "fabric", answeredAt: at }),
	]);
	assert.equal(states.length, 1);
	assert.equal(states[0]?.answer?.answer, "first");
	assert.equal(states[0]?.answer?.route, "command");
});

// Review findings on issue #214: an ask is bound to its task,
// /tree reconciles Fabric requests, mixed batches are refused, and Fabric
// answers keep the 500-character limit.

test("a plan replacement closes the open ask: Fabric is aborted, late answers are refused, and replay shows no open ask", async () => {
	const entries: unknown[] = [];
	const fabric = fakeFabric();
	await withFixture(async (fixture) => {
		await planAndAsk(fixture, DB_ASK);
		const request = fabric.requests[0];
		assert.ok(request);
		const [ask] = customData(fixture.entries, ASK_ENTRY_TYPE);

		const replanned = await fixture.call("session_tasks", { action: "plan", tasks: [{ title: "rename the service" }] });
		assert.notEqual(replanned.isError, true, replanned.content[0]?.text);
		await settle();
		assert.equal(request.signal.aborted, true, "the replaced task's decision is cancelled");
		const closed = customData(fixture.entries, ASK_CLOSED_ENTRY_TYPE);
		assert.deepEqual(closed.map((entry) => [entry.askId, entry.reason]), [[ask?.askId, "task-replaced"]]);
		const closeIndex = fixture.entries.findIndex((entry) => (entry as { customType?: string }).customType === ASK_CLOSED_ENTRY_TYPE);
		const lastIndex = fixture.entries.length - 1;
		assert.ok(closeIndex < lastIndex, "the close is written before the replacing snapshot");

		const entryCount = fixture.entries.length;
		fabric.answer(0, { text: "SQLite" });
		await fixture.command("answer", "t1 SQLite");
		const agent = await fixture.call("session_tasks", { action: "update", updates: [{ id: "t1", answer: "SQLite" }] });
		await settle();
		assert.equal(agent.isError, true, "the new t1 has no question to answer");
		assert.equal(fixture.entries.length, entryCount, "no late answer is recorded");
		assert.equal(customData(fixture.entries, ANSWER_ENTRY_TYPE).length, 0);
		assert.equal(fixture.sent.length, 0, "no turn is started");
		const fresh = task(fixture.entries, "t1");
		assert.equal(fresh.title, "rename the service");
		assert.equal(fresh.status, "pending");
		assert.equal(fresh.note, undefined, "the new task's note is untouched");
		assert.doesNotMatch(await fixture.turnMessage(), /waiting-on="user"/u);
		assert.ok(fixture.notifications.some((text) => /no open question/u.test(text)));
	}, { entries, fabric });

	const second = fakeFabric();
	await withFixture(async () => {
		assert.equal(second.requests.length, 0, "replay raises no question for the replaced task");
	}, { entries, fabric: second });
});

test("removing or clearing a task with an open ask closes it and aborts its Fabric request", async () => {
	const fabric = fakeFabric();
	await withFixture(async (fixture) => {
		await planAndAsk(fixture, DB_ASK);
		const removed = await fixture.call("session_tasks", { action: "remove", ids: ["t1"] });
		assert.notEqual(removed.isError, true, removed.content[0]?.text);
		assert.equal(fabric.requests[0]?.signal.aborted, true);
		assert.deepEqual(customData(fixture.entries, ASK_CLOSED_ENTRY_TYPE).map((entry) => entry.reason), ["task-removed"]);

		await fixture.call("session_tasks", { action: "update", updates: [{ id: "t2", status: "blocked", ask: { question: "Which schema?" } }] });
		await settle();
		const request = fabric.requests[1];
		assert.ok(request);
		await fixture.command("tasks", "clear");
		assert.equal(request.signal.aborted, true, "/tasks clear aborts the request too");
		assert.equal(customData(fixture.entries, ASK_CLOSED_ENTRY_TYPE).length, 2);
	}, { fabric });
});

test("/tree navigation aborts stale Fabric requests and raises the selected branch's open asks", async () => {
	const fabric = fakeFabric();
	await withFixture(async (fixture) => {
		await planAndAsk(fixture, DB_ASK);
		const beforeAnswer = [...fixture.entries];
		await fixture.command("answer", "t1 Postgres");
		await settle();
		const afterAnswer = [...fixture.entries];
		assert.equal(fabric.requests.length, 1);

		await fixture.navigate(beforeAnswer);
		await settle();
		assert.equal(fabric.requests.length, 2, "the ask open on the selected branch is raised again");
		const raisedAgain = fabric.requests[1];
		assert.ok(raisedAgain);
		assert.match(raisedAgain.question.title, /task t1\b/u);
		assert.equal(raisedAgain.signal.aborted, false);
		assert.match(await fixture.turnMessage(), /waiting-on="user"/u);

		await fixture.navigate(afterAnswer);
		await settle();
		assert.equal(raisedAgain.signal.aborted, true, "the request for the other branch is aborted");
		assert.equal(fabric.requests.length, 2, "an answered ask is not raised");
		const entryCount = fixture.entries.length;
		fabric.answer(1, { text: "SQLite" });
		await settle();
		assert.equal(fixture.entries.length, entryCount, "a late answer to the aborted request is ignored");
		assert.equal(task(fixture.entries, "t1").note, "Postgres");
	}, { fabric });
});

test("a batch that names a task twice alongside ask or answer is refused and writes nothing, in either order", async () => {
	await withFixture(async (fixture) => {
		await planAndAsk(fixture, DB_ASK);
		const batches = [
			[{ id: "t1", answer: "Postgres" }, { id: "t1", status: "blocked", note: "waiting" }],
			[{ id: "t1", status: "blocked", note: "waiting" }, { id: "t1", answer: "Postgres" }],
			[{ id: "t2", status: "blocked", ask: { question: "Which schema?" } }, { id: "t2", status: "pending" }],
			[{ id: "t2", status: "pending" }, { id: "t2", status: "blocked", ask: { question: "Which schema?" } }],
		];
		const entryCount = fixture.entries.length;
		for (const updates of batches) {
			const result = await fixture.call("session_tasks", { action: "update", updates });
			assert.equal(result.isError, true, JSON.stringify(updates));
		}
		assert.equal(fixture.entries.length, entryCount, "a refused batch writes nothing");
		assert.equal(task(fixture.entries, "t1").status, "blocked");
		assert.equal(task(fixture.entries, "t1").note, DB_ASK.question);
		assert.equal(task(fixture.entries, "t2").status, "pending");
	});
});

test("a Fabric answer of 500 characters is accepted and one of 501 is refused, leaving the ask open", async () => {
	const fabric = fakeFabric();
	await withFixture(async (fixture) => {
		await fixture.call("session_tasks", { action: "plan", tasks: [{ title: "pick the database" }, { title: "pick the region" }] });
		await fixture.call("session_tasks", { action: "update", updates: [
			{ id: "t1", status: "blocked", ask: { question: "Which database?" } },
			{ id: "t2", status: "blocked", ask: { question: "Which region?" } },
		] });
		await settle();
		assert.equal(fabric.requests.length, 2);
		const fiveHundred = `${"yes ".repeat(124)}yesy`;
		assert.equal(fiveHundred.length, 500);
		const fiveHundredOne = `${fiveHundred}y`;

		fabric.answer(0, { text: fiveHundredOne });
		await settle();
		assert.equal(customData(fixture.entries, ANSWER_ENTRY_TYPE).length, 0, "an over-long answer is not recorded");
		assert.equal(task(fixture.entries, "t1").status, "blocked");
		assert.equal(fixture.sent.length, 0);
		assert.match(await fixture.turnMessage(), /<task id="t1" status="blocked" waiting-on="user"/u, "the ask stays open");

		fabric.answer(1, { text: fiveHundred });
		await settle();
		const answers = customData(fixture.entries, ANSWER_ENTRY_TYPE);
		assert.equal(answers.length, 1);
		assert.equal(answers[0]?.answer, fiveHundred, "a 500-character answer is kept whole");
		assert.equal(task(fixture.entries, "t2").status, "pending");
	}, { fabric });
});
