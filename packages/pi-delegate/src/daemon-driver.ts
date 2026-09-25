import * as fs from "node:fs";
import * as path from "node:path";

import type {
	DaemonAttachment,
	DaemonClient,
	DaemonLease,
} from "@caair/pi-daemon/client";
import type {
	Cursor,
	OperationResult,
	PromptStatusResult,
	StreamFrame,
} from "@caair/pi-daemon/protocol";

import {
	readOrchestrateCfg,
	resolveOrchestrateCfgDir,
	type DaemonConnectionRecord,
	type DaemonPendingLaunchRecord,
	type DaemonRunLocator,
	type OrchestrateCfg,
} from "./detached-spawn.js";
import { isSafeRunId } from "./run-id.js";
import { readJsonFile, replaceJsonFile, withStateFileLock } from "./state-io.js";

/**
 * The daemon client is an optional peer dependency (#35): pi-delegate ships and
 * imports standalone, and only a `mode: "driver"` dispatch needs the daemon
 * runtime. Load it lazily so importing pi-delegate never eagerly requires it.
 */
let daemonClientModulePromise: Promise<typeof import("@caair/pi-daemon/client")> | undefined;
function loadDaemonClient(): Promise<typeof import("@caair/pi-daemon/client")> {
	return (daemonClientModulePromise ??= import("@caair/pi-daemon/client"));
}
async function connectDaemonLazy(
	options: Parameters<typeof import("@caair/pi-daemon/client")["connectDaemon"]>[0],
): Promise<DaemonClient> {
	const { connectDaemon } = await loadDaemonClient();
	return await connectDaemon(options);
}

/** Match the daemon client's DaemonRequestError structurally, without importing the class. */
export function isDaemonRequestError(error: unknown): error is Error & { code?: string; details?: unknown } {
	return error instanceof Error && error.name === "DaemonRequestError";
}

const CLIENT_IDENTITY = { name: "pi-delegate", version: "0.6.0" } as const;
const DEFAULT_LEASE_TTL_MS = 30_000;
const REPLAY_FRAME_TIMEOUT_MS = 10_000;
const DAEMON_OPERATION_TIMEOUT_MS = 5_000;
const WAKE_CONTENTION_TIMEOUT_MS = 2_000;

async function boundedDaemonOperation<T>(label: string, operation: Promise<T>): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error(`${label} timed out after ${DAEMON_OPERATION_TIMEOUT_MS}ms`)),
					DAEMON_OPERATION_TIMEOUT_MS,
				);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

export interface DaemonDriverLaunchResult {
	runId: string;
	locator: DaemonRunLocator;
	accepted: true;
	disposition: "started" | "queued" | "known";
}

type DaemonSessionStatus = Extract<OperationResult<"status">, { session: unknown }>;

export interface DaemonDriverReplayResult {
	locator: DaemonRunLocator;
	status: PromptStatusResult;
	output?: string;
	entries: Array<Record<string, unknown>>;
}

export type DaemonUiAnswer =
	| { value: string }
	| { confirmed: boolean }
	| { cancelled: true };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCursor(value: unknown): value is Cursor {
	return (
		isRecord(value) &&
		(value.entryId === null || typeof value.entryId === "string") &&
		typeof value.epoch === "number" &&
		Number.isInteger(value.epoch) &&
		value.epoch >= 0
	);
}

function isDaemonPendingLaunchRecord(value: unknown): value is DaemonPendingLaunchRecord {
	return (
		isRecord(value) &&
		Object.keys(value).length === 3 &&
		typeof value.daemonSessionId === "string" &&
		value.daemonSessionId.length > 0 &&
		typeof value.idempotencyKey === "string" &&
		value.idempotencyKey.length > 0 &&
		isCursor(value.cursor)
	);
}

export function isDaemonRunLocator(value: unknown): value is DaemonRunLocator {
	return (
		isRecord(value) &&
		Object.keys(value).length === 5 &&
		typeof value.daemonSessionId === "string" &&
		value.daemonSessionId.length > 0 &&
		typeof value.promptId === "string" &&
		value.promptId.length > 0 &&
		typeof value.idempotencyKey === "string" &&
		value.idempotencyKey.length > 0 &&
		isCursor(value.cursor) &&
		typeof value.generation === "number" &&
		Number.isInteger(value.generation) &&
		value.generation >= 0
	);
}

function connectionRecordFromEnvironment(
	agentDir: string,
	environment: NodeJS.ProcessEnv,
): DaemonConnectionRecord {
	return {
		...(environment.PI_DAEMON_SOCKET ? { socketPath: environment.PI_DAEMON_SOCKET } : {}),
		...(environment.PI_DAEMON_STATE_DIR ? { stateDir: environment.PI_DAEMON_STATE_DIR } : {}),
		agentDir: environment.PI_DAEMON_AGENT_DIR ?? agentDir,
	};
}

function isDaemonConnectionRecord(value: unknown): value is DaemonConnectionRecord {
	if (!isRecord(value)) return false;
	for (const key of ["socketPath", "stateDir", "agentDir"] as const) {
		if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].length === 0)) {
			return false;
		}
	}
	return true;
}

function cfgFile(agentDir: string, runId: string): string {
	if (!isSafeRunId(runId)) throw new Error(`unsafe daemon driver runId: ${JSON.stringify(runId)}`);
	return path.join(resolveOrchestrateCfgDir(agentDir), `${runId}.cfg.json`);
}

function persistDaemonPendingCfg(
	cfg: OrchestrateCfg,
	pending: DaemonPendingLaunchRecord,
	connection: DaemonConnectionRecord,
): void {
	const file = cfgFile(cfg.agentDir, cfg.runId);
	withStateFileLock(file, () => {
		const { env: _transportOnly, daemonLocator: _locator, daemonPendingLaunch: _pending, ...durableCfg } = cfg;
		replaceJsonFile(file, {
			...durableCfg,
			mode: "driver",
			startedAt: cfg.startedAt ?? Date.now(),
			daemonPendingLaunch: pending,
			daemonConnection: connection,
		});
	});
}

function persistDaemonCfg(cfg: OrchestrateCfg, locator: DaemonRunLocator, connection: DaemonConnectionRecord): void {
	const file = cfgFile(cfg.agentDir, cfg.runId);
	withStateFileLock(file, () => {
		const { env: _transportOnly, daemonPendingLaunch: _pending, ...durableCfg } = cfg;
		replaceJsonFile(file, {
			...durableCfg,
			mode: "driver",
			startedAt: cfg.startedAt ?? Date.now(),
			daemonLocator: locator,
			daemonConnection: connection,
		});
	});
}

function sameCursor(left: Cursor, right: Cursor): boolean {
	return left.entryId === right.entryId && left.epoch === right.epoch;
}

function sameLocatorIdentity(left: DaemonRunLocator, right: DaemonRunLocator): boolean {
	return left.daemonSessionId === right.daemonSessionId &&
		left.promptId === right.promptId &&
		left.idempotencyKey === right.idempotencyKey;
}

function updateDaemonGeneration(agentDir: string, runId: string, generation: number): DaemonRunLocator {
	const file = cfgFile(agentDir, runId);
	return withStateFileLock(file, () => {
		const cfg = readOrchestrateCfg(agentDir, runId);
		if (
			!cfg ||
			!isDaemonConnectionRecord(cfg.daemonConnection) ||
			!isDaemonRunLocator(cfg.daemonLocator)
		) {
			throw new Error(`daemon driver run record is unavailable for runId=${runId}`);
		}
		const locator = {
			...cfg.daemonLocator,
			generation: Math.max(cfg.daemonLocator.generation, generation),
		};
		replaceJsonFile(file, { ...cfg, daemonLocator: locator });
		return locator;
	});
}

function advanceDaemonCursor(
	agentDir: string,
	runId: string,
	expected: DaemonRunLocator,
	next: DaemonRunLocator,
): DaemonRunLocator {
	const file = cfgFile(agentDir, runId);
	return withStateFileLock(file, () => {
		const cfg = readOrchestrateCfg(agentDir, runId);
		if (
			!cfg ||
			!isDaemonConnectionRecord(cfg.daemonConnection) ||
			!isDaemonRunLocator(cfg.daemonLocator) ||
			!sameLocatorIdentity(cfg.daemonLocator, expected) ||
			!sameLocatorIdentity(expected, next)
		) {
			throw new Error(`daemon driver run record is unavailable for runId=${runId}`);
		}
		const cursor = sameCursor(cfg.daemonLocator.cursor, expected.cursor)
			? next.cursor
			: cfg.daemonLocator.cursor;
		const locator = {
			...cfg.daemonLocator,
			cursor,
			generation: Math.max(cfg.daemonLocator.generation, next.generation),
		};
		replaceJsonFile(file, { ...cfg, daemonLocator: locator });
		return locator;
	});
}

export function readDaemonDriverCfg(agentDir: string, runId: string): OrchestrateCfg | undefined {
	if (!isSafeRunId(runId)) return undefined;
	const read = readJsonFile(cfgFile(agentDir, runId));
	if (read.kind !== "ok" || !isRecord(read.value)) return undefined;
	const cfg = readOrchestrateCfg(agentDir, runId);
	if (!cfg || !isDaemonRunLocator(cfg.daemonLocator) || !isDaemonConnectionRecord(cfg.daemonConnection)) {
		return undefined;
	}
	return cfg;
}

/** Bounded restart-time visibility probe over durable driver cfg records. */
export function hasOwnedDaemonDriverRun(
	agentDir: string,
	ownerSessionId: string | undefined,
): boolean {
	if (!ownerSessionId) return false;
	let directory: fs.Dir | undefined;
	try {
		directory = fs.opendirSync(resolveOrchestrateCfgDir(agentDir));
		let inspected = 0;
		for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
			if (++inspected > 4096) return false;
			if (!entry.isFile() || !entry.name.endsWith(".cfg.json")) continue;
			const runId = entry.name.slice(0, -".cfg.json".length);
			const cfg = readDaemonDriverCfg(agentDir, runId);
			if (cfg?.ownerSessionId === ownerSessionId) return true;
		}
		return false;
	} catch {
		return false;
	} finally {
		try {
			directory?.closeSync();
		} catch {
			/* Visibility is best-effort and never changes daemon authority. */
		}
	}
}

function connectOptions(
	connection: DaemonConnectionRecord,
	environment: NodeJS.ProcessEnv,
	autoSpawn: boolean,
) {
	return {
		client: CLIENT_IDENTITY,
		autoSpawn,
		...(connection.socketPath ? { socketPath: connection.socketPath } : {}),
		...(connection.stateDir ? { stateDir: connection.stateDir } : {}),
		...(connection.agentDir ? { agentDir: connection.agentDir } : {}),
		environment,
	};
}

async function wakeAfterContention(
	attachment: DaemonAttachment,
	generation: number,
): Promise<Awaited<ReturnType<DaemonAttachment["wake"]>>> {
	const deadline = Date.now() + WAKE_CONTENTION_TIMEOUT_MS;
	for (;;) {
		try {
			return await boundedDaemonOperation("wake", attachment.wake(generation));
		} catch (error) {
			// The daemon maps host contention (another_session_awake / host_busy) to the
			// wire code "busy" (pi-daemon #50). Retry the wake until the awake session
			// idle-sleeps and frees the process SDK host, or the contention window elapses.
			if (!isDaemonRequestError(error) || error.code !== "busy" || Date.now() >= deadline) {
				throw error;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
		}
	}
}

async function openOrCreateSession(client: DaemonClient, cfg: OrchestrateCfg, sessionId: string) {
	try {
		return await client.request("create", {
			cwd: cfg.cwd,
			name: cfg.agentName,
			sessionId,
			sleepAfterMs: 100,
		});
	} catch (error) {
		if (!isDaemonRequestError(error) || error.code !== "duplicate_session") throw error;
		return await client.request("open", { sessionId });
	}
}

function promptIdFromResult(result: OperationResult<"prompt">): string | undefined {
	if (result.outcome === "accepted") return result.promptId;
	return "promptId" in result.status ? result.status.promptId : undefined;
}

/**
 * Launch one daemon-backed driver. Returning from this function means the prompt claim is accepted
 * and the complete locator is on disk; the daemon owns the continuing model turn.
 */
export async function launchDaemonDriver(
	cfg: OrchestrateCfg,
	environment: NodeJS.ProcessEnv = process.env,
): Promise<DaemonDriverLaunchResult> {
	const existing = readDaemonDriverCfg(cfg.agentDir, cfg.runId);
	const recordedCfg = readOrchestrateCfg(cfg.agentDir, cfg.runId);
	const pending = isDaemonPendingLaunchRecord(recordedCfg?.daemonPendingLaunch)
		? recordedCfg.daemonPendingLaunch
		: undefined;
	const durableCfg = recordedCfg ?? cfg;
	const daemonSessionId = existing?.daemonLocator?.daemonSessionId
		?? pending?.daemonSessionId
		?? `pi-delegate-${cfg.runId}`;
	const idempotencyKey = existing?.daemonLocator?.idempotencyKey
		?? pending?.idempotencyKey
		?? `pi-delegate-${cfg.runId}-prompt`;
	const connection = existing?.daemonConnection
		?? (isDaemonConnectionRecord(recordedCfg?.daemonConnection) ? recordedCfg.daemonConnection : undefined)
		?? connectionRecordFromEnvironment(cfg.agentDir, environment);
	const client = await connectDaemonLazy(connectOptions(connection, environment, true));
	let attachment: DaemonAttachment | undefined;
	let lease: DaemonLease | undefined;
	let stage = "open/create";
	try {
		const opened = await boundedDaemonOperation(
			"open/create",
			openOrCreateSession(client, durableCfg, daemonSessionId),
		);
		const processedCursor = existing?.daemonLocator?.cursor ?? pending?.cursor ?? opened.session.cursor;
		if (existing === undefined) {
			stage = "persist pending launch";
			persistDaemonPendingCfg(
				durableCfg,
				{ daemonSessionId, idempotencyKey, cursor: processedCursor },
				connection,
			);
		}
		const promptLookup = existing?.daemonLocator !== undefined
			? { promptId: existing.daemonLocator.promptId }
			: pending !== undefined ? { idempotencyKey } : undefined;
		if (promptLookup !== undefined) {
			stage = "prompt_status";
			const known = await boundedDaemonOperation(
				"prompt_status",
				client.promptStatus(daemonSessionId, promptLookup),
			);
			const promptId = "promptId" in known && known.promptId !== undefined
				? known.promptId
				: existing?.daemonLocator?.promptId;
			if (known.state !== "unknown" && promptId !== undefined) {
				const locator: DaemonRunLocator = {
					daemonSessionId,
					promptId,
					idempotencyKey,
					cursor: processedCursor,
					generation: opened.session.generation,
				};
				stage = "persist locator";
				persistDaemonCfg(durableCfg, locator, connection);
				return {
					runId: durableCfg.runId,
					accepted: true,
					locator,
					disposition: "known",
				};
			}
		}
		stage = "attach";
		attachment = await boundedDaemonOperation(
			"attach",
			client.attach(daemonSessionId, {
				fromCursor: processedCursor,
				live: false,
			}),
		);
		let generation = opened.session.generation;
		if (opened.session.runtime === "asleep") {
			stage = "wake";
			const woke = await wakeAfterContention(attachment, generation);
			generation = woke.session.generation;
		}
		stage = "lease";
		lease = await boundedDaemonOperation(
			"lease",
			attachment.acquireLease(generation, { ttlMs: DEFAULT_LEASE_TTL_MS }),
		);
		stage = "prompt";
		const prompt = await boundedDaemonOperation(
			"prompt",
			lease.prompt({
				idempotencyKey,
				text: durableCfg.task,
				whenBusy: "reject",
				attribution: { label: durableCfg.agentName },
			}),
		);
		const promptId = promptIdFromResult(prompt);
		if (!promptId) {
			throw new Error(`daemon did not return a promptId for idempotency key ${idempotencyKey}`);
		}
		const locator: DaemonRunLocator = {
			daemonSessionId,
			promptId,
			idempotencyKey,
			cursor: processedCursor,
			generation: prompt.outcome === "accepted" ? prompt.generation : generation,
		};
		stage = "persist locator";
		persistDaemonCfg(durableCfg, locator, connection);
		return {
			runId: durableCfg.runId,
			locator,
			accepted: true,
			disposition: prompt.outcome === "accepted" ? prompt.disposition : "known",
		};
	} catch (error) {
		const detail = isDaemonRequestError(error)
			? `${error.code}: ${error.message}`
			: error instanceof Error ? error.message : String(error);
		throw new Error(`${stage} failed: ${detail}`, { cause: error });
	} finally {
		if (lease && !lease.released) {
			await boundedDaemonOperation("lease release", lease.release()).catch(() => undefined);
		}
		if (attachment) {
			await boundedDaemonOperation("detach", attachment.detach()).catch(() => undefined);
		}
		client.close();
	}
}

function assistantText(entry: Record<string, unknown>): string | undefined {
	if (entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "assistant") {
		return undefined;
	}
	const content = entry.message.content;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.flatMap((block) => isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [])
		.join("");
	return text.length > 0 ? text : undefined;
}

function nextFrame(iterator: AsyncIterator<StreamFrame>): Promise<IteratorResult<StreamFrame>> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("timed out waiting for daemon replay frame")), REPLAY_FRAME_TIMEOUT_MS);
		void iterator.next().then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

interface CollectedReplay {
	entries: Array<Record<string, unknown>>;
	output?: string;
	locator: DaemonRunLocator;
}

async function collectReplay(
	attachment: DaemonAttachment,
	locator: DaemonRunLocator,
	onEntry?: (expected: DaemonRunLocator, next: DaemonRunLocator) => DaemonRunLocator,
): Promise<CollectedReplay> {
	const iterator = attachment[Symbol.asyncIterator]();
	const entries: Array<Record<string, unknown>> = [];
	let output: string | undefined;
	let current = locator;
	for (;;) {
		const item = await nextFrame(iterator);
		if (item.done) break;
		const frame = item.value;
		if (frame.kind === "entry") {
			const entry = frame.entry;
			const text = assistantText(entry);
			if (text !== undefined) output = text;
			entries.push(entry);
			await attachment.acknowledge(frame);
			const next = { ...current, cursor: frame.cursor };
			current = onEntry?.(current, next) ?? next;
		}
		if (frame.kind === "daemon" && frame.name === "replay_end") break;
	}
	return { locator: current, ...(output === undefined ? {} : { output }), entries };
}

function isTerminalPromptStatus(status: PromptStatusResult): boolean {
	return status.state !== "pending" && status.state !== "unknown";
}

/** Query prompt_status and replay committed entries, advancing the durable cursor only after each entry is processed. */
export async function replayDaemonDriver(
	agentDir: string,
	runId: string,
	environment: NodeJS.ProcessEnv = process.env,
): Promise<DaemonDriverReplayResult> {
	const cfg = readDaemonDriverCfg(agentDir, runId);
	if (!cfg || !cfg.daemonLocator || !cfg.daemonConnection) {
		throw new Error(`no daemon driver locator for runId=${runId}`);
	}
	const locator = cfg.daemonLocator;
	const client = await connectDaemonLazy(connectOptions(cfg.daemonConnection, environment, true));
	let attachment: DaemonAttachment | undefined;
	try {
		const status = await client.promptStatus(locator.daemonSessionId, { promptId: locator.promptId });
		attachment = await client.attach(locator.daemonSessionId, {
			fromCursor: locator.cursor,
			live: false,
		});
		let replayed = await collectReplay(attachment, locator, (expected, next) =>
			advanceDaemonCursor(agentDir, runId, expected, next));
		if (replayed.output === undefined && isTerminalPromptStatus(status)) {
			await attachment.detach();
			attachment = await client.attach(locator.daemonSessionId, {
				fromCursor: null,
				live: false,
			});
			const history = await collectReplay(attachment, replayed.locator);
			replayed = { ...history, locator: replayed.locator };
		}
		return { ...replayed, status };
	} finally {
		if (attachment) await attachment.detach().catch(() => undefined);
		client.close();
	}
}

async function connectRecordedDriver(
	agentDir: string,
	runId: string,
	environment: NodeJS.ProcessEnv,
): Promise<{ cfg: OrchestrateCfg; client: DaemonClient; locator: DaemonRunLocator }> {
	const cfg = readDaemonDriverCfg(agentDir, runId);
	if (!cfg || !cfg.daemonLocator || !cfg.daemonConnection) {
		throw new Error(`no daemon driver locator for runId=${runId}`);
	}
	const client = await connectDaemonLazy(connectOptions(cfg.daemonConnection, environment, true));
	return { cfg, client, locator: cfg.daemonLocator };
}

export async function promptStatusDaemonDriver(
	agentDir: string,
	runId: string,
	environment: NodeJS.ProcessEnv = process.env,
): Promise<PromptStatusResult> {
	const { client, locator } = await connectRecordedDriver(agentDir, runId, environment);
	try {
		return await boundedDaemonOperation(
			"prompt_status",
			client.promptStatus(locator.daemonSessionId, { promptId: locator.promptId }),
		);
	} finally {
		client.close();
	}
}
export async function statusDaemonDriver(
	agentDir: string,
	runId: string,
	environment: NodeJS.ProcessEnv = process.env,
): Promise<DaemonSessionStatus> {
	const { client, locator } = await connectRecordedDriver(agentDir, runId, environment);
	let attachment: DaemonAttachment | undefined;
	try {
		attachment = await boundedDaemonOperation(
			"status attach",
			client.attach(locator.daemonSessionId, { fromCursor: locator.cursor, live: false }),
		);
		const status = await boundedDaemonOperation(
			"status",
			client.request("status", {}, locator.daemonSessionId),
		);
		if (!("session" in status)) {
			throw new Error(`daemon returned global status for session ${locator.daemonSessionId}`);
		}
		return { ...status, session: attachment.result.session };
	} finally {
		if (attachment) {
			await boundedDaemonOperation("status detach", attachment.detach()).catch(() => undefined);
		}
		client.close();
	}
}


async function attachRecordedDriver(
	agentDir: string,
	runId: string,
	environment: NodeJS.ProcessEnv,
	options: { wakeIfAsleep: boolean },
): Promise<{
	cfg: OrchestrateCfg;
	client: DaemonClient;
	attachment: DaemonAttachment;
	locator: DaemonRunLocator;
}> {
	const { cfg, client, locator } = await connectRecordedDriver(agentDir, runId, environment);
	try {
		const attachment = await boundedDaemonOperation(
			"attach",
			client.attach(locator.daemonSessionId, {
				fromCursor: locator.cursor,
				live: false,
			}),
		);
		let generation = attachment.result.session.generation;
		if (options.wakeIfAsleep && attachment.result.session.runtime === "asleep") {
			const woke = await wakeAfterContention(attachment, generation);
			generation = woke.session.generation;
		}
		const current = generation === locator.generation
			? locator
			: updateDaemonGeneration(agentDir, runId, generation);
		return { cfg, client, attachment, locator: current };
	} catch (error) {
		client.close();
		throw error;
	}
}

async function closeAttachedDriver(client: DaemonClient, attachment: DaemonAttachment): Promise<void> {
	await boundedDaemonOperation("detach", attachment.detach()).catch(() => undefined);
	client.close();
}

export async function steerDaemonDriver(
	agentDir: string,
	runId: string,
	text: string,
	attributionLabel?: string,
	environment: NodeJS.ProcessEnv = process.env,
): Promise<OperationResult<"steer">> {
	const { cfg, client, attachment, locator } = await attachRecordedDriver(
		agentDir,
		runId,
		environment,
		{ wakeIfAsleep: true },
	);
	try {
		return await boundedDaemonOperation(
			"steer",
			attachment.steer(locator.generation, {
				text,
				attribution: { label: attributionLabel ?? cfg.agentName },
			}),
		);
	} finally {
		await closeAttachedDriver(client, attachment);
	}
}

export async function followUpDaemonDriver(
	agentDir: string,
	runId: string,
	text: string,
	attributionLabel?: string,
	environment: NodeJS.ProcessEnv = process.env,
): Promise<OperationResult<"follow_up">> {
	const { cfg, client, attachment, locator } = await attachRecordedDriver(
		agentDir,
		runId,
		environment,
		{ wakeIfAsleep: true },
	);
	try {
		return await boundedDaemonOperation(
			"follow_up",
			attachment.followUp(locator.generation, {
				text,
				attribution: { label: attributionLabel ?? cfg.agentName },
			}),
		);
	} finally {
		await closeAttachedDriver(client, attachment);
	}
}

export async function answerDaemonDriverUi(
	agentDir: string,
	runId: string,
	questionId: string,
	answer: DaemonUiAnswer,
	environment: NodeJS.ProcessEnv = process.env,
): Promise<OperationResult<"ui_answer">> {
	const { client, attachment, locator } = await attachRecordedDriver(
		agentDir,
		runId,
		environment,
		{ wakeIfAsleep: true },
	);
	let lease: DaemonLease | undefined;
	try {
		lease = await boundedDaemonOperation(
			"UI answer lease",
			attachment.acquireLease(locator.generation, { ttlMs: DEFAULT_LEASE_TTL_MS }),
		);
		return await boundedDaemonOperation("ui_answer", lease.answerUi({ questionId, answer }));
	} finally {
		if (lease && !lease.released) {
			await boundedDaemonOperation("UI answer lease release", lease.release()).catch(() => undefined);
		}
		await closeAttachedDriver(client, attachment);
	}
}

export async function cancelDaemonDriver(
	agentDir: string,
	runId: string,
	reason?: string,
	environment: NodeJS.ProcessEnv = process.env,
): Promise<OperationResult<"abort">> {
	const { client, attachment, locator } = await attachRecordedDriver(
		agentDir,
		runId,
		environment,
		{ wakeIfAsleep: true },
	);
	let lease: DaemonLease | undefined;
	try {
		lease = await boundedDaemonOperation(
			"cancel lease",
			attachment.acquireLease(locator.generation, { ttlMs: DEFAULT_LEASE_TTL_MS }),
		);
		return await boundedDaemonOperation("abort", lease.abort(reason === undefined ? {} : { reason }));
	} finally {
		if (lease && !lease.released) {
			await boundedDaemonOperation("cancel lease release", lease.release()).catch(() => undefined);
		}
		await closeAttachedDriver(client, attachment);
	}
}

export async function recoverDaemonDriver(
	agentDir: string,
	runId: string,
	environment: NodeJS.ProcessEnv = process.env,
): Promise<OperationResult<"recover">> {
	const { client, attachment, locator } = await attachRecordedDriver(
		agentDir,
		runId,
		environment,
		{ wakeIfAsleep: false },
	);
	try {
		const recovered = await boundedDaemonOperation(
			"recover",
			attachment.recover(locator.generation),
		);
		updateDaemonGeneration(agentDir, runId, recovered.session.generation);
		return recovered;
	} finally {
		await closeAttachedDriver(client, attachment);
	}
}
