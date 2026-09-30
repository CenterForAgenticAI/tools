import { mkdir, open as fsOpen, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { addUsage, EMPTY_LEDGER, type CostLedger } from "./pure/status.js";
import type {
	Activation,
	EdgeReason,
	ExecutableGraph,
	JournalBody,
	JournalRecord,
	JsonObject,
	NodeOutcome,
	NodeResult,
	RunId,
	RunOptions,
	RunState,
	StateDelta,
	UnprovenActivation,
	VerdictSource,
} from "./model.js";

const JOURNAL_VERSION = 1;

export interface JournalReplay {
	records: JournalRecord[];
	state: RunState;
	visits: Record<string, number>;
	attemptsUsed: number;
	arrivals: Array<{ at: string; from: Activation; fanOut?: Activation; via: EdgeReason }>;
	next: Array<{ node: string; visit: number; attempt: number; via: EdgeReason; fanOut?: Activation }>;
	recover?: { activation: Activation; attempt: number; fanOut?: Activation; result?: NodeResult };
	/**
	 * Every activation that was started and never finished, in the order it was
	 * started. The durable runner can have a whole batch in flight, so recovering
	 * only the most recent one silently drops the rest.
	 */
	recoverAll: Array<{ activation: Activation; attempt: number; fanOut?: Activation; interruptedAttempt: number }>;
	/** Finished activations whose state and routing transaction was not yet acknowledged. */
	reapply: Array<{ activation: Activation; attempt: number; fanOut?: Activation; resolved: { outcome: NodeOutcome; result: NodeResult; source: VerdictSource } }>;
	currentNode?: string;
	status: "running" | "completed" | "failed" | "cancelled" | "waiting-escalation" | "waiting-human" | "suspended" | "waiting-recovery";
	result?: JsonObject;
	/**
	 * The node a person still owes an answer to. Rebuilt from `human-requested`
	 * with no later `human-answered`, so a run that suspended for a person resumes
	 * at the node that asked and nowhere else.
	 */
	waitingHuman?: { nodeId: string; question: string; visit: number; attempt: number; fanOut?: Activation };
	/** Every unanswered human activation, in scheduled request order. */
	waitingHumans: Array<{ nodeId: string; question: string; visit: number; attempt: number; fanOut?: Activation }>;
	/** Token and cost totals, rebuilt from every `node-finished` that reported usage. */
	ledger: CostLedger;
	/**
	 * Process groups a `command` node started and that no later record accounts
	 * for. A runner killed with `SIGKILL` runs no cleanup, so these may still be
	 * running; resume reaps them before re-executing the node (#16, D-062).
	 */
	unreapedProcesses: Array<{ nodeId: string; pid: number; startTicks?: number }>;
	/**
	 * Activations a resume could not prove finished and a person has not yet ruled
	 * on. Non-empty exactly when the status is `waiting-recovery` (D-065).
	 */
	unproven: UnprovenActivation[];
	/** Decisions keyed node#visit#attempt, with #fanOutNode#fanOutVisit when qualified. */
	recoveryDecisions: Record<string, { action: "rerun" | "skip"; verdict?: string }>;
}

export class JournalError extends Error {
	readonly code = "RUN-JOURNAL-WRITE-FAILED" as const;

	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "JournalError";
	}
}

type CausalActivation = { node: string; visit: number; fanOut?: Activation };

/** Compare the full causal identity carried by a scheduled activation. */
export function sameActivationIdentity(left: CausalActivation, right: CausalActivation): boolean {
	return left.node === right.node && left.visit === right.visit
		&& left.fanOut?.node === right.fanOut?.node
		&& left.fanOut?.visit === right.fanOut?.visit;
}

/** Stable internal/public key. Attempts are omitted only for retry-replacement maps. */
export function activationIdentityKey(identity: CausalActivation, attempt?: number): string {
	const base = attempt === undefined ? `${identity.node}#${identity.visit}` : `${identity.node}#${identity.visit}#${attempt}`;
	return identity.fanOut ? `${base}#${identity.fanOut.node}#${identity.fanOut.visit}` : base;
}

/** Tier-T1 append-only journal. Each append is flushed before it resolves. */
/**
 * How the journal opens its file.
 *
 * Indirected for exactly one reason: a short write cannot be provoked from
 * Node, and its module namespace cannot be patched, so the append loop that
 * handles one would otherwise be untestable and its guard unprovable. Tests
 * replace this with a handle that writes a byte at a time; nothing else should.
 */
export type JournalOpen = typeof fsOpen;

let openFile: JournalOpen = fsOpen;

/** Test seam. Returns a function that restores the real implementation. */
export function __setJournalOpenForTest(next: JournalOpen): () => void {
	openFile = next;
	return () => { openFile = fsOpen; };
}

export class RunJournal {
	readonly runId: RunId;
	readonly directory: string;
	private nextSeq = 1;
	private opened = false;
	/** Shared in-flight open, so a concurrent burst scans the file once. */
	private opening: Promise<void> | undefined;
	/** The previous append's completion; each append waits on it in turn. */
	private writing: Promise<void> = Promise.resolve();
	/** Set once an append fails: the instance then refuses every later append. */
	private failure: JournalError | undefined;

	constructor(directory: string, runId: RunId) {
		this.directory = directory;
		this.runId = runId;
	}

	get path(): string {
		return join(this.directory, "journal.jsonl");
	}

	async open(): Promise<void> {
		if (this.opened) return;
		// Concurrent callers must not each run the scan: they would all read the
		// same last record and set the same `nextSeq`. The in-flight promise is
		// shared so the scan happens exactly once.
		//
		// UNPROVEN, stated deliberately: with `append` serialized this is not
		// reachable from `appendLocked`, and a mutation removing it killed no
		// test. `open` is public, so the guard is kept as defence for a caller
		// that does not exist yet — not as a measured fix.
		this.opening ??= (async () => {
			await mkdir(this.directory, { recursive: true });
			const records = await readRecords(this.path);
			this.nextSeq = records.length ? records[records.length - 1].seq + 1 : 1;
			this.opened = true;
		})();
		try {
			await this.opening;
		} finally {
			this.opening = undefined;
		}
	}

	async append(body: JournalBody): Promise<JournalRecord> {
		// Allocating a sequence number and durably writing that record must be one
		// indivisible step. They were not: `seq` was taken synchronously and the
		// open/write/sync that followed were independent awaits, so two concurrent
		// appends could take 11 and 12 and reach disk in the other order. Since
		// `readRecords` requires `seq === index + 1`, the run then became
		// unreadable and unresumable — measured as `Journal sequence gap at 12;
		// expected 11` on a fan-out, which is exactly where concurrent appends
		// come from (D-056).
		//
		// Each append therefore waits for the previous one to be on disk. The
		// journal is the durable record of a run, and correctness of its order
		// outranks the throughput of writing it.
		//
		// An append that FAILS is terminal for this instance. The sequence number
		// is allocated before the write, so a failed write leaves a hole no later
		// record can fill: the next append would take the following number, and
		// `readRecords` would reject the whole journal with a sequence gap. That
		// is the same corruption the ordering fix above exists to prevent, and it
		// was measured — a denied write took seq 1, the next append succeeded with
		// seq 2, and the journal became unreadable.
		//
		// So the instance fails closed. Queued callers are still released, because
		// a hang is worse than a rejection, but every later append rejects instead
		// of writing a record nobody could replay.
		// A fast path only, and deliberately recorded as such: removing it kills no
		// test, because a caller that passes here still meets the same check after
		// the queue and rejects with the same error. It saves a late arrival from
		// waiting behind an append that cannot help it. The load-bearing check is
		// the one after `await previous`.
		if (this.failure) throw this.failure;
		const previous = this.writing;
		let release!: () => void;
		this.writing = new Promise<void>((resolve) => { release = resolve; });
		try {
			await previous;
			if (this.failure) throw this.failure;
			return await this.appendLocked(body);
		} catch (error) {
			this.failure ??= error instanceof JournalError
				? new JournalError(`This journal instance failed and cannot accept further records: ${error.message}`, { cause: error })
				: new JournalError(`This journal instance failed and cannot accept further records: ${String(error)}`, { cause: error });
			throw error;
		} finally {
			release();
		}
	}

	private async appendLocked(body: JournalBody): Promise<JournalRecord> {
		try {
			await this.open();
			const record: JournalRecord = { schemaVersion: JOURNAL_VERSION, seq: this.nextSeq++, at: new Date().toISOString(), runId: this.runId, ...body } as JournalRecord;
			const handle = await openFile(this.path, "a");
			try {
				// `write` may complete SHORT: it returns `bytesWritten` precisely
				// because a partial write is permitted. Discarding that and syncing
				// would durably store half a JSON line and report success, and
				// `readRecords` rejects a file whose last record is partial — the
				// run would be unreadable for the opposite reason to a sequence gap.
				// Every byte goes down before the record is acknowledged.
				const line = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
				let written = 0;
				while (written < line.byteLength) {
					const { bytesWritten } = await handle.write(line, written, line.byteLength - written);
					if (bytesWritten <= 0) throw new Error(`write made no progress after ${written} of ${line.byteLength} bytes`);
					written += bytesWritten;
				}
				await handle.sync();
			} finally {
				await handle.close();
			}
			return record;
		} catch (error) {
			throw new JournalError(`Unable to append journal record: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
		}
	}

	async records(): Promise<JournalRecord[]> {
		return readRecords(this.path, this.runId);
	}
}

export async function readJournal(directory: string, runId?: RunId): Promise<JournalRecord[]> {
	return readRecords(join(directory, "journal.jsonl"), runId);
}

async function readRecords(path: string, runId?: RunId): Promise<JournalRecord[]> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	if (text.length === 0) return [];
	const records: JournalRecord[] = [];
	const lines = text.split("\n");
	if (lines.at(-1) !== "") throw new JournalError("Journal ends with a partial record; durability cannot be proven.");
	for (const [index, line] of lines.slice(0, -1).entries()) {
		let value: unknown;
		try { value = JSON.parse(line); } catch (error) { throw new JournalError(`Invalid journal JSON at line ${index + 1}.`, { cause: error }); }
		if (!isJournalRecord(value)) throw new JournalError(`Invalid journal record at line ${index + 1}.`);
		if (runId && value.runId !== runId) throw new JournalError(`Journal record ${value.seq} belongs to ${value.runId}, not ${runId}.`);
		if (value.seq !== index + 1) throw new JournalError(`Journal sequence gap at ${value.seq}; expected ${index + 1}.`);
		records.push(value);
	}
	return records;
}

function isJournalRecord(value: unknown): value is JournalRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return record.schemaVersion === JOURNAL_VERSION && typeof record.seq === "number" && Number.isInteger(record.seq) && record.seq > 0 && typeof record.at === "string" && typeof record.runId === "string" && typeof record.type === "string";
}

export function applyStateDelta(data: JsonObject, delta: StateDelta[]): JsonObject {
	const next = structuredClone(data);
	for (const change of delta) {
		const parts = change.path.split(".");
		let cursor: JsonObject = next;
		for (const part of parts.slice(0, -1)) {
			const existing = cursor[part];
			if (!existing || typeof existing !== "object" || Array.isArray(existing)) cursor[part] = {};
			cursor = cursor[part] as JsonObject;
		}
		const leaf = parts.at(-1)!;
		if (change.op === "unset") delete cursor[leaf];
		else cursor[leaf] = structuredClone(change.value);
	}
	return next;
}

export async function replayJournal(directory: string, graph: ExecutableGraph, _options: RunOptions): Promise<JournalReplay> {
	const records = await readJournal(directory);
	const started = records.find((record) => record.type === "run-started");
	if (!started || started.type !== "run-started") throw new JournalError("Journal has no run-started record.");
	if (started.graphHash !== graph.hash) throw new Error(`RUN-GRAPH-HASH-MISMATCH: journal has ${started.graphHash}, graph has ${graph.hash}.`);
	let data: JsonObject = { input: structuredClone(started.input) };
	let revision = 0;
	let bytes = Buffer.byteLength(JSON.stringify(data));
	const visits: Record<string, number> = {};
	let attemptsUsed = 0;
	let currentNode: string | undefined = graph.entry;
	let status: JournalReplay["status"] = "running";
	let result: JsonObject | undefined;
	const arrivals: JournalReplay["arrivals"] = [];
	let next: JournalReplay["next"] = [];
	let lastActivation: Activation | undefined;
	const inFlight = new Map<string, { activation: Activation; attempt: number; fanOut?: Activation }>();
	const startedActivations: Array<{ node: string; visit: number; attempt: number; fanOut?: Activation }> = [];
	// Activations a resume could not prove finished, and the decisions a person has
	// since made about them. Both are rebuilt from the journal so a suspension
	// survives the process that recorded it.
	let unproven: UnprovenActivation[] = [];
	const decided = new Map<string, { action: "rerun" | "skip"; verdict?: string }>();
	let lastFanOut: Activation | undefined;
	let lastAttempt = 1;
	let lastFinished = false;
	let lastCommitted = false;
	let lastStatus: "completed" | "failed" | "aborted" | "timeout" | undefined;
	let lastVerdict: string | undefined;
	let ledger: CostLedger = EMPTY_LEDGER;
	const waitingHumans: JournalReplay["waitingHumans"] = [];
	type PendingApplication = JournalReplay["reapply"][number];
	const pendingApplications = new Map<string, PendingApplication>();
	const pendingApplicationOrder: string[] = [];
	const legacyFinished = new Map<string, { node: string; visit: number; attempt: number; fanOut?: Activation }>();
	type ApplicationCheckpoint = {
		data: JsonObject;
		revision: number;
		bytes: number;
		arrivals: JournalReplay["arrivals"];
		next: JournalReplay["next"];
		currentNode?: string;
		status: JournalReplay["status"];
		waitingHumans: JournalReplay["waitingHumans"];
		lastCommitted: boolean;
		lastVerdict?: string;
	};
	const checkpoint = (): ApplicationCheckpoint => ({
		data: structuredClone(data),
		revision,
		bytes,
		arrivals: structuredClone(arrivals),
		next: structuredClone(next),
		...(currentNode === undefined ? {} : { currentNode }),
		status,
		waitingHumans: structuredClone(waitingHumans),
		lastCommitted,
		...(lastVerdict === undefined ? {} : { lastVerdict }),
	});
	let applicationCheckpoint: ApplicationCheckpoint | undefined;
	// Keyed by causal activation without attempt: a retry replaces the previous
	// attempt's process, while equal node/visit values from other fan-outs coexist.
	const spawned = new Map<string, { nodeId: string; pid: number; startTicks?: number }>();
	for (const [recordIndex, record] of records.entries()) {
		switch (record.type) {
			case "node-started": {
				attemptsUsed += 1;
				if (record.attempt === 1) visits[record.nodeId] = Math.max(visits[record.nodeId] ?? 0, record.visit);
				lastActivation = { node: record.nodeId, visit: record.visit };
				lastFanOut = record.fanOut;
				lastAttempt = record.attempt;
				lastFinished = false;
				lastCommitted = false;
				lastStatus = undefined;
				lastVerdict = undefined;
				currentNode = record.nodeId;
				const startedIdentity = { node: record.nodeId, visit: record.visit, ...(record.fanOut ? { fanOut: record.fanOut } : {}) };
				next = next.filter((item) => !sameActivationIdentity(item, startedIdentity));
				inFlight.set(activationIdentityKey(startedIdentity), { activation: { node: record.nodeId, visit: record.visit }, attempt: record.attempt, ...(record.fanOut ? { fanOut: record.fanOut } : {}) });
				startedActivations.push({ ...startedIdentity, attempt: record.attempt });
				break;
			}
			case "edge-fired": {
				for (const target of record.to) {
					if (target === "done" || target === "fail") continue;
					next.push({ node: target, visit: (visits[target] ?? 0) + 1, attempt: 1, via: record.via, ...(record.fanOut ? { fanOut: record.fanOut } : {}) });
				}
				currentNode = next[0]?.node;
				const candidates = [...legacyFinished.entries()].filter(([, finished]) => finished.node === record.from);
				if (candidates.length > 1) throw new JournalError(`Legacy edge-fired record ${record.seq} cannot distinguish ${candidates.length} finished ${record.from} activations.`);
				if (candidates[0]) legacyFinished.delete(candidates[0][0]);
				break;
			}
			case "join-arrived":
				arrivals.push({ at: record.joinId, from: record.from, ...(record.fanOut ? { fanOut: record.fanOut } : {}), via: record.via });
				break;
			case "join-fired":
				for (const consumed of record.consumed) {
					const candidates = arrivals.map((arrival, index) => ({ arrival, index })).filter(({ arrival }) => arrival.at === record.joinId && arrival.from.node === consumed.node && arrival.from.visit === consumed.visit && (!("fanOut" in consumed) || sameActivationIdentity({ node: consumed.node, visit: consumed.visit, ...(consumed.fanOut ? { fanOut: consumed.fanOut } : {}) }, { node: arrival.from.node, visit: arrival.from.visit, ...(arrival.fanOut ? { fanOut: arrival.fanOut } : {}) })));
					if (!("fanOut" in consumed) && candidates.length > 1) throw new JournalError(`Legacy join-fired record ${record.seq} cannot distinguish ${candidates.length} ${record.joinId} arrivals for ${consumed.node}#${consumed.visit}.`);
					if (candidates[0]) arrivals.splice(candidates[0].index, 1);
				}
				break;
			case "node-finished": {
				lastFinished = true;
				lastStatus = record.status;
				ledger = addUsage(ledger, record.usage);
				const exact = "fanOut" in record;
				const candidates = [...inFlight.entries()].filter(([, entry]) => entry.activation.node === record.nodeId && entry.activation.visit === record.visit && entry.attempt === record.attempt && (!exact || sameActivationIdentity({ node: record.nodeId, visit: record.visit, ...(record.fanOut ? { fanOut: record.fanOut } : {}) }, { node: entry.activation.node, visit: entry.activation.visit, ...(entry.fanOut ? { fanOut: entry.fanOut } : {}) })));
				if (!exact && candidates.length > 1) throw new JournalError(`Legacy node-finished record ${record.seq} cannot distinguish ${candidates.length} ${record.nodeId}#${record.visit}#${record.attempt} activations.`);
				const matched = candidates[0];
				if (matched) {
					const [matchedKey, entry] = matched;
					inFlight.delete(matchedKey);
					// The node finished, so this runner saw its process end. Only a node
					// that never reported finishing can have left one behind.
					spawned.delete(matchedKey);
					if (record.application) {
						applicationCheckpoint ??= checkpoint();
						const identity = { node: entry.activation.node, visit: entry.activation.visit, ...(entry.fanOut ? { fanOut: entry.fanOut } : {}) };
						const applicationKey = activationIdentityKey(identity, entry.attempt);
						const outcome: NodeOutcome = {
							status: record.status,
							changed: record.changed,
							completionSignal: record.completionSignal,
							...(record.usage ? { usage: record.usage } : {}),
							...(record.diagnostics ? { diagnostics: [...record.diagnostics] } : {}),
							...(record.application.terminal ? { terminal: true } : {}),
							...("output" in record.application ? { output: structuredClone(record.application.output) } : {}),
						};
						const result: NodeResult = {
							activation: { node: entry.activation.node, visit: entry.activation.visit },
							attempt: entry.attempt,
							...(entry.fanOut ? { fanOut: entry.fanOut } : {}),
							...(record.application.terminal ? { terminal: true } : {}),
							outcome: structuredClone(record.application.outcome),
						};
						pendingApplications.set(applicationKey, { activation: result.activation, attempt: entry.attempt, ...(entry.fanOut ? { fanOut: entry.fanOut } : {}), resolved: { outcome, result, source: record.application.source } });
						pendingApplicationOrder.push(applicationKey);
					} else {
						const identity = { node: entry.activation.node, visit: entry.activation.visit, ...(entry.fanOut ? { fanOut: entry.fanOut } : {}) };
						legacyFinished.set(activationIdentityKey(identity, entry.attempt), { ...identity, attempt: entry.attempt });
					}
				}
				break;
			}
			case "node-applied": {
				const identity = { node: record.nodeId, visit: record.visit, ...(record.fanOut ? { fanOut: record.fanOut } : {}) };
				const applicationKey = activationIdentityKey(identity, record.attempt);
				if (pendingApplications.has(applicationKey)) {
					if (applicationCheckpoint) {
						next = [...applicationCheckpoint.next, ...structuredClone(record.scheduled)];
						currentNode = next[0]?.node;
					}
					pendingApplications.delete(applicationKey);
					if (pendingApplications.size === 0) applicationCheckpoint = undefined;
					else applicationCheckpoint = checkpoint();
				}
				break;
			}
			case "process-spawned": {
				const identity = { node: record.nodeId, visit: record.visit, ...(record.fanOut ? { fanOut: record.fanOut } : {}) };
				let key = activationIdentityKey(identity);
				if (!("fanOut" in record)) {
					const candidates = [...inFlight.entries()].filter(([, entry]) => entry.activation.node === record.nodeId && entry.activation.visit === record.visit && entry.attempt === record.attempt);
					if (candidates.length > 1) throw new JournalError(`Legacy process-spawned record ${record.seq} cannot distinguish ${candidates.length} ${record.nodeId}#${record.visit}#${record.attempt} activations.`);
					// Old EmbeddedRunner records omitted fan-out. When its sequential history
					// proves one activation, keep the process under that activation's full key
					// so its later legacy node-finished record accounts for the same process.
					key = candidates[0]?.[0] ?? key;
				}
				spawned.set(key, { nodeId: record.nodeId, pid: record.pid, ...(record.startTicks === undefined ? {} : { startTicks: record.startTicks }) });
				break;
			}
			case "process-reaped":
				for (const [key, entry] of spawned) if (entry.pid === record.pid) spawned.delete(key);
				break;
			// A run that stopped to ask a person resumes at the node that asked, with
			// the visit and attempt it had. Anything else would re-ask a different node.
			case "human-requested": {
				status = "waiting-human";
				const previous = records[recordIndex - 1];
				let identity: { visit: number; attempt: number; fanOut?: Activation } | undefined;
				if ("visit" in record && "attempt" in record) identity = { visit: record.visit, attempt: record.attempt, ...(record.fanOut ? { fanOut: record.fanOut } : {}) };
				else if (previous?.type === "node-finished" && previous.nodeId === record.nodeId) {
					if ("fanOut" in previous) identity = { visit: previous.visit, attempt: previous.attempt, ...(previous.fanOut ? { fanOut: previous.fanOut } : {}) };
					else {
						const candidates = startedActivations.filter((item) => item.node === record.nodeId && item.visit === previous.visit && item.attempt === previous.attempt);
						if (candidates.length > 1) throw new JournalError(`Legacy human-requested record ${record.seq} cannot distinguish ${candidates.length} adjacent ${record.nodeId} activations.`);
						if (candidates[0]) identity = { visit: previous.visit, attempt: previous.attempt, ...(candidates[0].fanOut ? { fanOut: candidates[0].fanOut } : {}) };
					}
				}
				if (!identity) throw new JournalError(`Legacy human-requested record ${record.seq} cannot be matched to an adjacent ${record.nodeId} activation.`);
				const waiting = { nodeId: record.nodeId, question: record.question, ...identity };
				legacyFinished.delete(activationIdentityKey({ node: record.nodeId, visit: identity.visit, ...(identity.fanOut ? { fanOut: identity.fanOut } : {}) }, identity.attempt));
				const existing = waitingHumans.findIndex((item) => item.nodeId === waiting.nodeId && item.visit === waiting.visit && item.attempt === waiting.attempt && sameActivationIdentity({ node: item.nodeId, visit: item.visit, ...(item.fanOut ? { fanOut: item.fanOut } : {}) }, { node: waiting.nodeId, visit: waiting.visit, ...(waiting.fanOut ? { fanOut: waiting.fanOut } : {}) }));
				if (existing >= 0) waitingHumans.splice(existing, 1, waiting);
				else waitingHumans.push(waiting);
				currentNode = waitingHumans[0]?.nodeId;
				break;
			}
			case "human-answered": {
				const answered = "visit" in record && "attempt" in record
					? waitingHumans.findIndex((item) => item.attempt === record.attempt && sameActivationIdentity({ node: item.nodeId, visit: item.visit, ...(item.fanOut ? { fanOut: item.fanOut } : {}) }, { node: record.nodeId, visit: record.visit, ...(record.fanOut ? { fanOut: record.fanOut } : {}) }))
					: waitingHumans.findIndex((item) => item.nodeId === record.nodeId);
				if (answered >= 0) waitingHumans.splice(answered, 1);
				status = waitingHumans.length ? "waiting-human" : "running";
				currentNode = waitingHumans[0]?.nodeId ?? currentNode;
				break;
			}
			case "verdict-resolved":
				lastVerdict = record.verdict;
				break;
			case "state-committed":
				data = applyStateDelta(data, record.delta);
				revision = record.revision;
				bytes = record.bytes;
				lastCommitted = true;
				break;
			// An escalation suspends the run: it is not a failure, and resume needs to know
			// the run is waiting on a person rather than mid-node (§11.4.3).
			case "escalation-raised": {
				status = "waiting-escalation";
				const candidates = [...legacyFinished.entries()].filter(([, finished]) => finished.node === record.nodeId);
				if (candidates.length > 1) throw new JournalError(`Legacy escalation-raised record ${record.seq} cannot distinguish ${candidates.length} finished ${record.nodeId} activations.`);
				if (candidates[0]) legacyFinished.delete(candidates[0][0]);
				break;
			}
			case "escalation-resolved":
				if (status === "waiting-escalation") status = "running";
				break;
			// A suspension is part of the run's state, not a note in the margin. Until
			// this was read, a run that suspended replayed as `running` and a resume
			// carried on as though nothing had stopped it — which for an uncertain
			// recovery would step straight past the person it stopped to ask (D-065).
			case "run-suspended":
				status = record.reason === "uncertain-recovery" ? "waiting-recovery" : "suspended";
				unproven = record.unproven ? [...record.unproven] : [];
				break;
			// One decision resolves one activation. The run only leaves
			// `waiting-recovery` when nothing is left unanswered, because a batch can
			// suspend several activations at once (D-056).
			case "recovery-decided": {
				let identity: { node: string; visit: number; fanOut?: Activation } = { node: record.nodeId, visit: record.visit, ...(record.fanOut ? { fanOut: record.fanOut } : {}) };
				if (!("fanOut" in record)) {
					const candidates = unproven.filter((item) => item.nodeId === record.nodeId && item.visit === record.visit && item.attempt === record.attempt);
					if (candidates.length > 1) throw new JournalError(`Legacy recovery-decided record ${record.seq} cannot distinguish ${candidates.length} ${record.nodeId}#${record.visit}#${record.attempt} activations.`);
					if (candidates[0]?.fanOut) identity = { ...identity, fanOut: candidates[0].fanOut };
				}
				decided.set(activationIdentityKey(identity, record.attempt), { action: record.action, ...(record.verdict ? { verdict: record.verdict } : {}) });
				unproven = unproven.filter((item) => item.attempt !== record.attempt || !sameActivationIdentity({ node: item.nodeId, visit: item.visit, ...(item.fanOut ? { fanOut: item.fanOut } : {}) }, identity));
				if (status === "waiting-recovery" && unproven.length === 0) status = "running";
				break;
			}
				case "run-finished":
				status = record.status;
				result = record.result;
				currentNode = undefined;
				next = [];
				inFlight.clear();
				pendingApplications.clear();
				legacyFinished.clear();
				applicationCheckpoint = undefined;
				break;
		}
	}
	const unappliedLegacy = legacyFinished.values().next().value as { node: string; visit: number; attempt: number; fanOut?: Activation } | undefined;
	if (unappliedLegacy) {
		const key = activationIdentityKey(unappliedLegacy, unappliedLegacy.attempt);
		throw new JournalError(`Journal finished ${key} without a durable application or special-state record; refusing to repeat or discard its effect.`);
	}
	if (pendingApplications.size > 0 && applicationCheckpoint) {
		data = applicationCheckpoint.data;
		revision = applicationCheckpoint.revision;
		bytes = applicationCheckpoint.bytes;
		arrivals.splice(0, arrivals.length, ...applicationCheckpoint.arrivals);
		next = applicationCheckpoint.next;
		currentNode = applicationCheckpoint.currentNode;
		status = applicationCheckpoint.status;
		waitingHumans.splice(0, waitingHumans.length, ...applicationCheckpoint.waitingHumans);
		lastCommitted = applicationCheckpoint.lastCommitted;
		lastVerdict = applicationCheckpoint.lastVerdict;
	}
	const reapply = status === "completed" || status === "failed" || status === "cancelled"
		? []
		: pendingApplicationOrder.flatMap((key) => {
			const pending = pendingApplications.get(key);
			return pending ? [pending] : [];
		});
	let recover: JournalReplay["recover"];
	if (reapply.length === 0 && status === "running" && next.length === 0 && lastActivation) {
		if (!lastFinished || !lastCommitted) {
			recover = { activation: lastActivation, attempt: lastAttempt + 1, ...(lastFanOut ? { fanOut: lastFanOut } : {}) };
		} else if (lastStatus === "completed" || lastStatus === "failed" || lastStatus === "aborted" || lastStatus === "timeout") {
			const outcome = lastStatus === "completed" && lastVerdict ? { kind: "verdict" as const, verdict: lastVerdict } : { kind: "engine" as const, verdict: lastStatus === "timeout" ? "timeout" as const : lastStatus === "aborted" ? "aborted" as const : "error" as const };
			recover = { activation: lastActivation, attempt: lastAttempt, ...(lastFanOut ? { fanOut: lastFanOut } : {}), result: { activation: lastActivation, attempt: lastAttempt, ...(lastFanOut ? { fanOut: lastFanOut } : {}), outcome } };
		}
	}
	// Anything started and never finished is still owed a run, whether it was the
	// only node in flight or one of a batch.
	// `attempt` is the next one to run; `interruptedAttempt` is the one that was cut
	// short. They differ by one, and the difference matters: durable evidence was
	// written under the attempt that was interrupted, so a resume looking under the
	// next attempt's name would never find it (#17, D-063).
	// `waiting-recovery` counts as well as `running`: those activations are still
	// owed a run, and the suspension is precisely why. Omitting them would leave the
	// resume with an empty queue and nothing for a person's decision to apply to.
	const recoverAll = status === "running" || status === "waiting-recovery"
		? [...inFlight.values()].map((entry) => ({ ...entry, attempt: entry.attempt + 1, interruptedAttempt: entry.attempt }))
		: [];
	const waitingHuman = waitingHumans[0];
	return { records, state: { schemaVersion: 1, runId: started.runId, graphHash: started.graphHash, revision, updatedAt: records.at(-1)?.at ?? new Date(0).toISOString(), data, bytes }, visits, attemptsUsed, arrivals, next, ...(recover ? { recover } : {}), recoverAll, reapply, ...(currentNode === undefined ? {} : { currentNode }), status, ...(result === undefined ? {} : { result }), ...(waitingHuman ? { waitingHuman } : {}), waitingHumans, ledger, unreapedProcesses: [...spawned.values()], unproven, recoveryDecisions: Object.fromEntries(decided) };
}

export async function writeStateCache(directory: string, state: RunState): Promise<void> {
	await writeFile(join(directory, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function readStateCache(directory: string): Promise<RunState | undefined> {
	try { return JSON.parse(await readFile(join(directory, "state.json"), "utf8")) as RunState; } catch { return undefined; }
}
