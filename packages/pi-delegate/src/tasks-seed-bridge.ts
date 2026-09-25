/**
 * Detached-child bootstrap for the bounded `context-aware.tasks.v1` seed.
 *
 * The runner loads this after consumer extensions and policy bridges. It chooses
 * structured seeding or a one-time Markdown fallback from the final active tool
 * set, then mirrors bounded progress plus the terminal ledger into the event bus.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { appendBusEvent, resolveBusFrame } from "./event-bus.js";
import {
	buildSessionTasksSeed,
	buildTaskLedgerTransport,
	parseTasksSeedTransport,
	readSeededTasks,
	renderTasksMarkdown,
	taskProgressFieldsFromEntries,
	TASKS_ENTRY_TYPE,
	TASK_ATTEMPT_ENV,
	TASK_ATTEMPT_FIELD,
	TASK_LEDGER_FIELD,
	TASKS_SEED_ENV,
	type TasksSeed,
} from "./task-seam.js";

const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

function taskStateFields(ctx: ExtensionContext, taskAttempt: number): {
	progress: Record<string, unknown>;
	ledger: ReturnType<typeof buildTaskLedgerTransport>;
} | undefined {
	const entries = ctx.sessionManager.getEntries();
	const progress = taskProgressFieldsFromEntries(entries);
	if (!progress) return undefined;
	return {
		progress: { event: "task_progress", [TASK_ATTEMPT_FIELD]: taskAttempt, ...progress },
		ledger: buildTaskLedgerTransport(readSeededTasks(entries)),
	};
}

function publishTaskState(ctx: ExtensionContext, taskAttempt: number): void {
	const fields = taskStateFields(ctx, taskAttempt);
	const frame = resolveBusFrame();
	const agentDir = process.env[PI_AGENT_DIR_ENV];
	if (!fields || !frame || !agentDir) return;
	// Keep progress and the full unfinished ledger in separate bounded events.
	// Combining both valid maximal payloads would exceed MAX_EVENT_BYTES and cause
	// the event bus to discard the fields wholesale.
	appendBusEvent({ agentDir, frame }, { kind: "updated", fields: fields.progress });
	if (fields.ledger !== undefined) {
		appendBusEvent({ agentDir, frame }, {
			kind: "updated",
			fields: { event: "task_ledger", [TASK_ATTEMPT_FIELD]: taskAttempt, [TASK_LEDGER_FIELD]: fields.ledger },
		});
	}
}

function installTransportFailureGate(pi: ExtensionAPI, error: Error): void {
	const reason = `Detached task seed transport is invalid: ${error.message}`;
	const reject = (ctx: ExtensionContext): void => {
		// eslint-disable-next-line no-console -- malformed transport must be visible in the child log
		console.error(`[pi-delegate] ${reason}`);
		ctx.shutdown();
	};
	pi.on("session_start", (_event, ctx) => reject(ctx));
	pi.on("before_agent_start", (_event, ctx) => reject(ctx));
	pi.on("input", (_event, ctx) => {
		reject(ctx);
		return { action: "handled" as const };
	});
	pi.on("tool_call", () => ({ block: true, reason }));
}

export default function tasksSeedBridge(pi: ExtensionAPI): void {
	let seed: TasksSeed;
	let taskAttempt: number;
	try {
		const raw = process.env[TASKS_SEED_ENV];
		const rawAttempt = process.env[TASK_ATTEMPT_ENV];
		if (!raw) throw new Error(`missing ${TASKS_SEED_ENV}`);
		if (!rawAttempt || rawAttempt.length > 16 || !/^(?:0|[1-9]\d*)$/.test(rawAttempt)) {
			throw new Error(`invalid ${TASK_ATTEMPT_ENV}`);
		}
		taskAttempt = Number(rawAttempt);
		if (!Number.isSafeInteger(taskAttempt)) throw new Error(`invalid ${TASK_ATTEMPT_ENV}`);
		seed = parseTasksSeedTransport(raw);
	} catch (error) {
		installTransportFailureGate(pi, error instanceof Error ? error : new Error(String(error)));
		return;
	} finally {
		// The seed has crossed the boundary into this extension's local variable.
		// Do not leave the checklist or trusted attempt marker visible to later child subprocesses.
		delete process.env[TASKS_SEED_ENV];
		delete process.env[TASK_ATTEMPT_ENV];
	}

	type DeliveryMode = "pending" | "seeded" | "fallback" | "failed";
	let deliveryMode: DeliveryMode = "pending";
	let seedAppended = false;
	const hasUsableClaimant = (): boolean =>
		pi.getAllTools().some((tool) => tool.name === "session_tasks") &&
		pi.getActiveTools().includes("session_tasks");
	const ensureSeed = (ctx: ExtensionContext): void => {
		if (deliveryMode === "fallback" || deliveryMode === "failed") return;
		try {
			const entries = ctx.sessionManager.getEntries();
			// A reload or replacement may invoke startup more than once. The child
			// session owns one durable snapshot; never append a duplicate seed. The
			// local guard covers SDK lifecycle handlers that observe a stale entry list
			// between session_start and before_agent_start.
			const hasSeed = readSeededTasks(entries).length > 0;
			if (!seedAppended && !hasSeed) {
				const snapshot = buildSessionTasksSeed(seed, {
					piSessionId: ctx.sessionManager.getSessionId(),
					eventId: `seed-${ctx.sessionManager.getSessionId()}`,
				});
				pi.appendEntry(TASKS_ENTRY_TYPE, snapshot);
				seedAppended = true;
			} else if (hasSeed) {
				seedAppended = true;
			}
			deliveryMode = "seeded";
			publishTaskState(ctx, taskAttempt);
		} catch (error) {
			deliveryMode = "failed";
			// eslint-disable-next-line no-console -- bootstrap failure must be visible in the child log
			console.error(`[pi-delegate] task seed bootstrap failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
			ctx.shutdown();
		}
	};
	// Consumer lifecycle handlers and the delegate-owned scope bridge run first.
	// Decide once in this last before_agent_start handler, after lifecycle-time
	// registrations and final scope enforcement have settled the active tool set.
	pi.on("before_agent_start", (_event, ctx) => {
		if (deliveryMode !== "pending") return;
		if (hasUsableClaimant()) {
			ensureSeed(ctx);
			return;
		}
		deliveryMode = "fallback";
		return {
			message: {
				customType: "pi-delegate:task-fallback",
				content: `## Task checklist\n\nWork through these and report which are done:\n\n${renderTasksMarkdown(seed)}`,
				display: false,
			},
		};
	});
	pi.on("turn_end", (_event, ctx) => {
		if (deliveryMode === "seeded") publishTaskState(ctx, taskAttempt);
	});
	pi.on("agent_end", (_event, ctx) => {
		if (deliveryMode === "seeded") publishTaskState(ctx, taskAttempt);
	});
}
