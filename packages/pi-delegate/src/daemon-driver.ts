import * as fs from "node:fs";
import { assertInvocationPreparing, acceptInvocation, type RuntimeInvocation } from "./runtime-invocation.js";
import type { DispatchAcceptance } from "./dispatch-evidence.js";
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

export class DaemonLaunchError extends Error {
	constructor(message: string, readonly acceptance: DispatchAcceptance, readonly stage: "submission" | "locator", cause?: unknown) {
		super(message, { cause });
		this.name = "DaemonLaunchError";
	}
}
/**
 * A steer or follow-up addressed to a driver whose prompt has no active turn.
 * The daemon queues both only behind a running turn, so once the prompt is
 * terminal there is nothing to deliver into. Raised before any wake, so a
 * rejected control call never revives a slept session.
 */
export class DaemonDriverTurnSettledError extends Error {
	constructor(readonly operation: "steer" | "follow_up", readonly promptState: string) {
		super(`driver turn has ${promptState}; ${operation} needs an active turn`);
		this.name = "DaemonDriverTurnSettledError";
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

/** Includes uncertain submissions so restart discovery never hides a pending claim. */
export function readDaemonDriverRecord(agentDir: string, runId: string): OrchestrateCfg | undefined {
	if (!isSafeRunId(runId)) return undefined;
	const cfg = readOrchestrateCfg(agentDir, runId);
	return cfg && isDaemonConnectionRecord(cfg.daemonConnection) &&
		(isDaemonRunLocator(cfg.daemonLocator) || isDaemonPendingLaunchRecord(cfg.daemonPendingLaunch)) ? cfg : undefined;
}

/** Read-only claim lookup, then locator repair. This path never submits a prompt. */
export async function reconcileDaemonPendingLaunch(agentDir: string, runId: string, environment: NodeJS.ProcessEnv = process.env, connect: typeof connectDaemonLazy = connectDaemonLazy): Promise<OrchestrateCfg> {
	const cfg = readDaemonDriverRecord(agentDir, runId);
	if (!cfg) throw new Error(`no daemon driver claim for runId=${runId}`);
	if (isDaemonRunLocator(cfg.daemonLocator)) return cfg;
	const pending = cfg.daemonPendingLaunch!;
	const client = await connect(connectOptions(cfg.daemonConnection!, environment, true));
	try {
		const status = await boundedDaemonOperation("pending prompt_status", client.promptStatus(pending.daemonSessionId, { idempotencyKey: pending.idempotencyKey }));
		if (status.state === "unknown" || !("promptId" in status) || !status.promptId) throw new Error(`daemon claim remains uncertain for runId=${runId}; no prompt was submitted by recovery`);
		const current = await boundedDaemonOperation("pending session status", client.request("status", {}, pending.daemonSessionId));
		if (!("session" in current)) throw new Error("daemon returned global status during pending recovery");
		const locator: DaemonRunLocator = { daemonSessionId: pending.daemonSessionId, idempotencyKey: pending.idempotencyKey, promptId: status.promptId, cursor: pending.cursor, generation: current.session.generation };
		persistDaemonCfg(cfg, locator, cfg.daemonConnection!);
		return { ...cfg, daemonLocator: locator };
	} finally { client.close(); }
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
			const cfg = readDaemonDriverRecord(agentDir, runId);
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

function canonicalPathFromExistingAncestor(candidate: string): string {
	const resolved = path.resolve(candidate);
	let existing = resolved;
	const missing: string[] = [];
	while (true) {
		try {
			return path.resolve(fs.realpathSync(existing), ...missing);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			try {
				fs.lstatSync(existing);
			} catch (lstatError) {
				if ((lstatError as NodeJS.ErrnoException).code !== "ENOENT") throw lstatError;
				const parent = path.dirname(existing);
				if (parent === existing) throw error;
				missing.unshift(path.basename(existing));
				existing = parent;
				continue;
			}
			throw error;
		}
	}
}

function connectOptions(
	connection: DaemonConnectionRecord,
	environment: NodeJS.ProcessEnv,
	autoSpawn: boolean,
) {
	// The test wrapper marks its run root. Never let a missing socket override
	// fall back to pi-daemon's per-user endpoint, even when a test supplies a
	// custom environment instead of inheriting the wrapper's variables.
	const testRoot = process.env.PI_DELEGATE_TEST_ROOT;
	if (testRoot) {
		const home = environment.HOME ?? process.env.PI_DELEGATE_TEST_USER_HOME ?? process.env.HOME ?? "";
		const defaultSocket = (runtimeDir: string | undefined) => runtimeDir !== undefined
			? path.resolve(runtimeDir, "pi-daemon", "pi-daemon.sock")
			: path.resolve(home, ".local", "state", "pi-daemon", "run", "pi-daemon.sock");
		const socket = connection.socketPath ?? environment.PI_DAEMON_SOCKET ?? defaultSocket(environment.XDG_RUNTIME_DIR);
		const state = connection.stateDir ?? environment.PI_DAEMON_STATE_DIR ??
			path.resolve(environment.XDG_STATE_HOME ?? path.resolve(home, ".local", "state"), "pi-daemon");
		const userDefault = process.env.PI_DELEGATE_TEST_USER_RUNTIME_DIR
			? path.resolve(process.env.PI_DELEGATE_TEST_USER_RUNTIME_DIR, "pi-daemon", "pi-daemon.sock")
			: path.resolve(process.env.PI_DELEGATE_TEST_USER_HOME ?? home, ".local", "state", "pi-daemon", "run", "pi-daemon.sock");
		const userStateDefault = path.resolve(
			process.env.PI_DELEGATE_TEST_USER_STATE_HOME || path.resolve(process.env.PI_DELEGATE_TEST_USER_HOME ?? home, ".local", "state"),
			"pi-daemon",
		);
		const canonicalTestRoot = canonicalPathFromExistingAncestor(testRoot);
		const canonicalSocket = canonicalPathFromExistingAncestor(socket);
		const canonicalState = canonicalPathFromExistingAncestor(state);
		const insideRoot = (candidate: string) => {
			const relative = path.relative(canonicalTestRoot, candidate);
			return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
		};
		if (!insideRoot(canonicalSocket) || canonicalSocket === canonicalPathFromExistingAncestor(userDefault)) {
			throw new Error(`Test daemon endpoint is not isolated: ${socket}; set PI_DAEMON_SOCKET inside ${testRoot}`);
		}
		if (!insideRoot(canonicalState) || canonicalState === canonicalPathFromExistingAncestor(userStateDefault)) {
			throw new Error(`Test daemon state directory is not isolated: ${state}; set PI_DAEMON_STATE_DIR inside ${testRoot}`);
		}
	}
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
	connect: typeof connectDaemonLazy = connectDaemonLazy,
): Promise<DaemonDriverLaunchResult> {
	assertInvocationPreparing();
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
	let client: DaemonClient;
	try {
		client = await connect(connectOptions(connection, environment, true));
	} catch (error) {
		if (existing || pending) throw new DaemonLaunchError("Could not reconnect to the persisted daemon claim; do not redispatch.", {
			runId: cfg.runId, transport: "daemon", state: existing ? "accepted" : "uncertain", daemonSessionId, idempotencyKey,
			...(existing?.daemonLocator ? { promptId: existing.daemonLocator.promptId } : {}),
		}, "submission", error);
		throw error;
	}
	let attachment: DaemonAttachment | undefined;
	let lease: DaemonLease | undefined;
	let stage = "open/create";
	let submitted = false;
	let acceptedLocator: DaemonRunLocator | undefined = existing?.daemonLocator;
	try {
		const opened = await boundedDaemonOperation(
			"open/create",
			openOrCreateSession(client, durableCfg, daemonSessionId),
		);
		const processedCursor = existing?.daemonLocator?.cursor ?? pending?.cursor ?? opened.session.cursor;
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
				acceptedLocator = locator;
				stage = "persist locator";
				persistDaemonCfg(durableCfg, locator, connection);
				return {
					runId: durableCfg.runId,
					accepted: true,
					locator,
					disposition: "known",
				};
			}
			throw new Error("Persisted prompt claim is unresolved; recover it by idempotency key, never redispatch.");
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
		assertInvocationPreparing();
		stage = "persist pending launch";
		persistDaemonPendingCfg(durableCfg, { daemonSessionId, idempotencyKey, cursor: processedCursor }, connection);
		assertInvocationPreparing();
		stage = "prompt";
		submitted = true;
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
		acceptedLocator = locator;
		acceptInvocation({ runId: cfg.runId, transport: "daemon", state: "accepted", daemonSessionId, promptId, idempotencyKey });
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
		if (error instanceof DaemonLaunchError) throw error;
		if (submitted || acceptedLocator || pending) throw new DaemonLaunchError(`${stage} failed: ${detail}`, {
			runId: cfg.runId, transport: "daemon", state: acceptedLocator ? "accepted" : "uncertain", daemonSessionId, idempotencyKey,
			...(acceptedLocator ? { promptId: acceptedLocator.promptId } : {}),
		}, acceptedLocator ? "locator" : "submission", error);
		assertInvocationPreparing();
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

/** Read-only live observation. No lease, prompt, wake, cancellation, or durable cursor mutation. */
export async function observeDaemonDriver(
	agentDir: string,
	runId: string,
	invocation: RuntimeInvocation,
	environment: NodeJS.ProcessEnv = process.env,
	connect: typeof connectDaemonLazy = connectDaemonLazy,
): Promise<void> {
	if (!invocation.observing) return;
	const cfg = readDaemonDriverCfg(agentDir, runId);
	if (!cfg?.daemonLocator || !cfg.daemonConnection) throw new Error("Accepted daemon observation requires a durable locator");
	const locator = cfg.daemonLocator;
	const client = await connect(connectOptions(cfg.daemonConnection, environment, false));
	let attachment: DaemonAttachment | undefined;
	let cleaned = false;
	const cleanup = () => {
		if (cleaned) return;
		cleaned = true;
		if (attachment) void boundedDaemonOperation("observe detach", attachment.detach()).catch(() => undefined).finally(() => client.close());
		else client.close();
	};
	invocation.own(cleanup);
	if (!invocation.observing) return;
	try {
		attachment = await boundedDaemonOperation("observe attach", client.attach(locator.daemonSessionId, { fromCursor: locator.cursor, live: true }));
		if (cleaned) { await attachment.detach().catch(() => undefined); return; }
		if (!invocation.observing) return;
		const update = async () => {
			const status = await boundedDaemonOperation("observe prompt_status", client.promptStatus(locator.daemonSessionId, { promptId: locator.promptId }));
			if (isTerminalPromptStatus(status)) {
				invocation.update({ kind: "terminal", runId, state: status.state === "failed" || status.state === "aborted" ? "terminal-failed" : "terminal-done" });
			} else invocation.update({ kind: "progress", runId, forks: [{ name: cfg.entryName ?? cfg.agentName, agent: cfg.agentName, status: status.state }] });
		};
		// Subscribe first, then query: a terminal transition between launch and attach is not missed.
		await update();
		if (!invocation.observing) return;
		for await (const frame of attachment) {
			if (!invocation.observing) break;
			if (frame.kind === "entry") await attachment.acknowledge(frame);
			await update();
			if (!invocation.observing) break;
		}
	} finally {
		cleanup();
		invocation.dispose();
	}
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
	const cfg = await reconcileDaemonPendingLaunch(agentDir, runId, environment);
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
	connect: typeof connectDaemonLazy = connectDaemonLazy,
): Promise<{ cfg: OrchestrateCfg; client: DaemonClient; locator: DaemonRunLocator }> {
	const cfg = await reconcileDaemonPendingLaunch(agentDir, runId, environment, connect);
	if (!cfg || !cfg.daemonLocator || !cfg.daemonConnection) {
		throw new Error(`no daemon driver locator for runId=${runId}`);
	}
	const client = await connect(connectOptions(cfg.daemonConnection, environment, true));
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
		const status = await readRegistryStatus(client, locator.daemonSessionId);
		return { ...status, session: currentSessionSummary(status.session, attachment.result.session) };
	} finally {
		if (attachment) {
			await boundedDaemonOperation("status detach", attachment.detach()).catch(() => undefined);
		}
		client.close();
	}
}

/**
 * Prefer the attach snapshot, which carries live state (pending questions,
 * observed phase) that the registry-only `status` summary lacks, but only
 * when it describes the registry's current generation. A snapshot from an
 * older generation is a host that has since slept, so the registry summary
 * wins.
 */
function currentSessionSummary(
	registry: DaemonSessionStatus["session"],
	attached: DaemonAttachment["result"]["session"],
): DaemonSessionStatus["session"] {
	return attached.generation === registry.generation && attached.runtime === registry.runtime ? attached : registry;
}

/**
 * The daemon registry's view of a session. Runtime state and generation come
 * from here, never from an attach snapshot: the registry is what the daemon
 * checks generations against, and it advances on every sleep.
 */
async function readRegistryStatus(client: DaemonClient, daemonSessionId: string): Promise<DaemonSessionStatus> {
	const status = await boundedDaemonOperation("status", client.request("status", {}, daemonSessionId));
	if (!("session" in status)) {
		throw new Error(`daemon returned global status for session ${daemonSessionId}`);
	}
	return status;
}

/** Refuse a steer or follow-up when the recorded prompt has reached a terminal state. */
async function assertDriverTurnActive(
	client: DaemonClient,
	locator: DaemonRunLocator,
	operation: "steer" | "follow_up",
): Promise<void> {
	const status = await boundedDaemonOperation(
		"prompt_status",
		client.promptStatus(locator.daemonSessionId, { promptId: locator.promptId }),
	);
	if (isTerminalPromptStatus(status)) throw new DaemonDriverTurnSettledError(operation, status.state);
}

/**
 * Deliver a steer or follow-up to a driver whose turn is still running.
 *
 * The prompt state is checked before attaching, and again immediately before
 * any wake, so a turn that settled and slept in between is refused rather than
 * woken. The daemon has no atomic "queue only behind an active run" operation,
 * so a turn can still settle between the last check and delivery. The daemon
 * then rejects the input with invalid_state (no active run) or stale_generation
 * (the session slept again); both are re-checked against prompt_status and
 * reported as a settled turn with its actual terminal state.
 */
async function sendDriverInput<T>(
	agentDir: string,
	runId: string,
	operation: "steer" | "follow_up",
	environment: NodeJS.ProcessEnv,
	connect: typeof connectDaemonLazy,
	send: (attachment: DaemonAttachment, generation: number, cfg: OrchestrateCfg) => Promise<T>,
): Promise<T> {
	const { cfg, client, locator } = await connectRecordedDriver(agentDir, runId, environment, connect);
	let attachment: DaemonAttachment | undefined;
	try {
		await assertDriverTurnActive(client, locator, operation);
		attachment = await boundedDaemonOperation(
			"attach",
			client.attach(locator.daemonSessionId, { fromCursor: locator.cursor, live: false }),
		);
		const { session } = await readRegistryStatus(client, locator.daemonSessionId);
		let generation = session.generation;
		if (session.runtime === "asleep") {
			await assertDriverTurnActive(client, locator, operation);
			generation = (await wakeAfterContention(attachment, generation)).session.generation;
		}
		if (generation !== locator.generation) updateDaemonGeneration(agentDir, runId, generation);
		try {
			return await boundedDaemonOperation(operation, send(attachment, generation, cfg));
		} catch (error) {
			if (isDaemonRequestError(error) && (error.code === "invalid_state" || error.code === "stale_generation")) {
				await assertDriverTurnActive(client, locator, operation);
			}
			throw error;
		}
	} finally {
		if (attachment) await boundedDaemonOperation("detach", attachment.detach()).catch(() => undefined);
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
		const { session } = await readRegistryStatus(client, locator.daemonSessionId);
		let generation = session.generation;
		if (options.wakeIfAsleep && session.runtime === "asleep") {
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
	connect: typeof connectDaemonLazy = connectDaemonLazy,
): Promise<OperationResult<"steer">> {
	return await sendDriverInput(agentDir, runId, "steer", environment, connect, (attachment, generation, cfg) =>
		attachment.steer(generation, { text, attribution: { label: attributionLabel ?? cfg.agentName } }));
}

export async function followUpDaemonDriver(
	agentDir: string,
	runId: string,
	text: string,
	attributionLabel?: string,
	environment: NodeJS.ProcessEnv = process.env,
	connect: typeof connectDaemonLazy = connectDaemonLazy,
): Promise<OperationResult<"follow_up">> {
	return await sendDriverInput(agentDir, runId, "follow_up", environment, connect, (attachment, generation, cfg) =>
		attachment.followUp(generation, { text, attribution: { label: attributionLabel ?? cfg.agentName } }));
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
