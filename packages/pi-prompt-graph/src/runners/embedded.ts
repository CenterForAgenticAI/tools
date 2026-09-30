import { randomUUID } from "node:crypto";
import { Compile } from "typebox/compile";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CommandAdapter } from "../adapters/command.js";
import { HumanAdapter } from "../adapters/human.js";
import { SetAdapter } from "../adapters/set.js";
import { missingTemplateCapabilities, type TemplateCapabilities } from "../adapters/template.js";
import type { NodeAdapter } from "../adapters/index.js";
import { activationIdentityKey, applyStateDelta, readStateCache, replayJournal, RunJournal, sameActivationIdentity, writeStateCache } from "../journal.js";
import type { JournalReplay } from "../journal.js";
import { step } from "../pure/routing.js";
import { artifactFor } from "../pure/artifact.js";
import { addUsage, effectiveCostCeiling, EMPTY_LEDGER, statusLine, type CostLedger, type RunStatusLine } from "../pure/status.js";
import { unenforceableDetail, unenforceableToolPolicies } from "../pure/guard.js";
import { decideAtBoundary, type InterruptionSource } from "../pure/lifecycle.js";
import { reapIfSame, type ProcessIdentity } from "./process-identity.js";
import type {
	CompiledNode,
	Destination,
	EdgeReason,
	ExecutableGraph,
	FanOutIdentity,
	JsonObject,
	JsonValue,
	NodeOutcome,
	NodeResult,
	RunFailureCode,
	RunOptions,
	RunState,
	RunStatus,
	ScheduledActivation,
	StateDelta,
	StateOpSource,
	UnprovenActivation,
	VerdictName,
	VerdictSource,
} from "../model.js";

export interface RunHandle {
	readonly runId: string;
	readonly directory: string;
	readonly status: RunStatus;
	readonly state: RunState;
	readonly result?: JsonObject;
	readonly failure?: { code: RunFailureCode; detail: string };
	/** The bounded status line for this run, cost included exactly when a ceiling is in force. */
	readonly statusLine?: RunStatusLine;
	/** Present while the run is `waiting-human`: the node asking, and what it asked. */
	readonly waitingHuman?: { nodeId: string; question: string; accepts: string[]; refusal?: string };
	/**
	 * Present when the run stopped `paused` or `suspended`: what the live session
	 * was doing at the time, for a person to read. Never parsed.
	 */
	readonly interruption?: string;
	/**
	 * Present while the run is `waiting-recovery`: every activation this resume
	 * could not prove finished. All of them, not the first — a kill can leave a
	 * whole batch in flight (D-056), and reporting one would understate the
	 * decision a person is being asked to make (D-065).
	 */
	readonly unproven?: UnprovenActivation[];
}

export interface EmbeddedRunnerConfig {
	readonly adapters?: Partial<Record<CompiledNode["kind"], NodeAdapter>>;
	/**
	 * What the session's PTM can do, for a graph containing `template` nodes.
	 *
	 * Absent means "not checked", which is what every non-Mode-A run passes. A
	 * run whose graph has no `template` node never consults it, so a Stage 2
	 * command-and-set graph is unaffected by PTM's presence or absence.
	 */
	readonly templateCapabilities?: TemplateCapabilities;
	/**
	 * Where the run asks, at each node boundary, whether a live session wants to
	 * interrupt it.
	 *
	 * Absent means nothing can interrupt, which is every Mode B and every test
	 * that is not about this: a run with no session behind it has no operator to
	 * type at it and no session to end.
	 */
	readonly interruptions?: InterruptionSource;
	/**
	 * Where to publish which nodes are current, for a live session's tool guard.
	 *
	 * Absent means nothing is watching, which is every Mode B run and every test
	 * that is not about the guard.
	 */
	readonly currentNodes?: CurrentNodes;
	readonly now?: () => Date;
	readonly id?: () => string;
}

/**
 * Where the runner publishes which nodes are current.
 *
 * A live session needs this to hold a tool call to the node that asked for it:
 * `tools.allow` is a property of the node, so nothing can be enforced without
 * knowing which node the agent is working for right now.
 *
 * It takes a batch rather than a node because concurrent steps are real
 * (D-056). Declared allowlists are combined by `SessionGuard`; an unrestricted
 * sibling does not erase a restriction another current node declared.
 */
export interface CurrentNodes {
	enter(nodes: readonly CompiledNode[]): void;
	leave(): void;
}

export interface StartRunInput {
	readonly graph: ExecutableGraph;
	readonly input: JsonObject;
	readonly options: RunOptions;
	readonly graphName?: string;
	readonly runId?: string;
}

/** What `resume` carries back into a run that is waiting for a person. */
export interface ResumeOptions {
	/** The operator's answer, injected into the interrupted `human` node only. */
	readonly answer?: JsonValue;
	/**
	 * What to do about activations a previous resume could not prove finished,
	 * keyed `node#visit#attempt`. When `fanOut` is present the canonical key is
	 * `node#visit#attempt#fanOutNode#fanOutVisit`; the shorter legacy key is accepted
	 * only when it names one queued activation unambiguously.
	 *
	 * `rerun` runs the node again. `skip` accepts that it already happened and
	 * routes on the supplied verdict instead, which must be one the node can
	 * actually produce (D-065).
	 */
	readonly recovery?: RecoveryDecisions;
}

export type RecoveryDecisions = Record<string, { action: "rerun" | "skip"; verdict?: VerdictName }>;

/** An operator's recovery decision the runner cannot honour. */
export class RecoveryDecisionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RecoveryDecisionError";
	}
}

export class RunStartError extends Error {
	readonly code: "RUN-CONFIRMATION-REQUIRED";

	constructor(message: string) {
		super(message);
		this.name = "RunStartError";
		this.code = "RUN-CONFIRMATION-REQUIRED";
	}
}

interface QueueEntry extends ScheduledActivation {
	attempt: number;
	/** A finished result replay must apply without executing the node again. */
	replayed?: JournalReplay["reapply"][number]["resolved"];
	/**
	 * The attempt a crash cut short, when this entry is one a resume recovered.
	 * Distinct from `attempt`, which is the next one to run: durable evidence was
	 * written under the interrupted attempt's name (#17, D-063).
	 */
	interruptedAttempt?: number;
}

/** What a finished run reports beyond its state: the numbers the status line shows. */
interface FinishSummary {
	readonly ledger?: CostLedger;
	readonly attemptsUsed?: number;
	readonly lastVerdict?: VerdictName;
	readonly invokedCostCeiling?: number;
}

const defaultOptions = (options: RunOptions): RunOptions => ({
	mode: options.mode,
	interactive: options.interactive,
	allowNonInteractive: options.allowNonInteractive,
	allowNonInteractiveMutating: options.allowNonInteractiveMutating,
	...(options.maxCostUsd === undefined ? {} : { maxCostUsd: options.maxCostUsd }),
	runsRoot: options.runsRoot,
});

/** Stage-2 in-process runner. It honours graph concurrency without a lease protocol. */
export class EmbeddedRunner {
	private readonly command: CommandAdapter;
	private readonly set: SetAdapter;
	private readonly human: HumanAdapter;
	private readonly adapters: Partial<Record<CompiledNode["kind"], NodeAdapter>>;
	private readonly templateCapabilities: TemplateCapabilities | undefined;
	private readonly interruptions: InterruptionSource | undefined;
	private readonly currentNodes: CurrentNodes | undefined;
	private readonly now: () => Date;
	protected readonly id: () => string;

	constructor(config: EmbeddedRunnerConfig = {}) {
		this.command = new CommandAdapter();
		this.set = new SetAdapter();
		this.human = new HumanAdapter();
		this.adapters = config.adapters ?? {};
		this.templateCapabilities = config.templateCapabilities;
		this.interruptions = config.interruptions;
		this.currentNodes = config.currentNodes;
		this.now = config.now ?? (() => new Date());
		this.id = config.id ?? randomUUID;
	}

	async start(input: StartRunInput): Promise<RunHandle>;
	async start(graph: ExecutableGraph, input: JsonObject, options: RunOptions): Promise<RunHandle>;
	async start(requestOrGraph: StartRunInput | ExecutableGraph, inputValue?: JsonObject, optionsValue?: RunOptions): Promise<RunHandle> {
		const input: StartRunInput = "graph" in requestOrGraph
			? requestOrGraph
			: { graph: requestOrGraph, input: inputValue ?? {}, options: optionsValue ?? { mode: requestOrGraph.mode, interactive: true, allowNonInteractive: false, allowNonInteractiveMutating: false, runsRoot: ".pi/runs" } };
		const options = defaultOptions(input.options);
		if (!options.interactive && (!options.allowNonInteractive || input.graph.policy.requireInteractive)) throw new RunStartError("RUN-CONFIRMATION-REQUIRED: this graph requires an interactive run or an explicit non-interactive grant.");
		if (!options.interactive && !options.allowNonInteractiveMutating && Object.values(input.graph.nodes).some((node) => node.kind === "command" || node.kind === "set")) throw new RunStartError("RUN-CONFIRMATION-REQUIRED: non-interactive mutating execution requires an explicit grant.");
		const runId = input.runId ?? this.id();
		const directory = join(options.runsRoot, runId);
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "graph.json"), `${JSON.stringify(input.graph, null, 2)}\n`, "utf8");
		const journal = new RunJournal(directory, runId);
		await journal.append({ type: "run-started", graphName: input.graphName ?? input.graph.name, graphHash: input.graph.hash, options, input: structuredClone(input.input) });
		const state = makeState(runId, input.graph, input.input, this.now());
		// A declared tools.allow that nothing can honour fails the run here, before any
		// unrestricted work has run. Silently ignoring it is the one outcome forbidden
		// outright (§3.3.1).
		const unenforceable = unenforceableToolPolicies(input.graph, (kind) => this.canEnforceTools(kind));
		if (unenforceable.length) {
			await writeStateCache(directory, state);
			return this.finish(journal, state, "failed", { code: "RUN-TOOL-POLICY-UNENFORCEABLE", detail: unenforceableDetail(unenforceable) }, input.graph, input.graph.name);
		}
		// Mode A's two PTM capabilities are preconditions with no fallback, so a
		// graph that needs them and cannot have them refuses here rather than
		// discovering it on the fourth node of a cycle (§11.2, D-038, D-039).
		const capabilityDetail = this.missingTemplateSupport(input.graph);
		if (capabilityDetail) {
			await writeStateCache(directory, state);
			return this.finish(journal, state, "failed", { code: "RUN-COMPLETION-SIGNAL-UNAVAILABLE", detail: capabilityDetail }, input.graph, input.graph.name);
		}
		await writeStateCache(directory, state);
		return this.execute(input.graph, options, journal, state, [{ node: input.graph.entry, visit: 1, attempt: 1, via: { kind: "next" } }], {}, 0, [], input.graphName ?? input.graph.name);
	}

	async resume(runId: string, graph: ExecutableGraph, options: RunOptions, resumeOptions: ResumeOptions = {}): Promise<RunHandle> {
		const directory = join(options.runsRoot, runId);
		const replay = await replayJournal(directory, graph, options);
		const journal = new RunJournal(directory, runId);
		// Before anything is re-executed. A node whose command is still running from
		// the previous runner must not be started a second time beside it.
		await this.reapOrphans(journal, replay.unreapedProcesses);
		const reapplyQueue: QueueEntry[] = replay.reapply.map((entry) => ({
			node: entry.activation.node,
			visit: entry.activation.visit,
			attempt: entry.attempt,
			via: { kind: "next" },
			...(entry.fanOut ? { fanOut: entry.fanOut } : {}),
			replayed: entry.resolved,
		}));
		// A run waiting for a person resumes only when one supplies an answer. A
		// finished sibling's pending application is the exception: applying its
		// durable result is not another model or human turn, and must happen before
		// the waiting handle is returned.
		if (replay.status === "waiting-human" && resumeOptions.answer === undefined && reapplyQueue.length === 0) return this.handleFromReplay(directory, replay.state, replay.status, replay.result, replay.waitingHuman, graph);
		await journal.append({ type: "run-resumed", by: "operator", forced: false, ...(resumeOptions.answer === undefined ? {} : { value: resumeOptions.answer }) });
		if (replay.status === "waiting-human" && replay.waitingHuman) {
			// A human may have shared its batch with independent siblings. Replay owns
			// the exact asking activation and every durable successor; resume must not
			// rediscover either identity from whichever sibling happened to start last.
			if (resumeOptions.answer === undefined) return this.execute(graph, defaultOptions(options), journal, replay.state, [...reapplyQueue, ...replay.next], replay.visits, replay.attemptsUsed, replay.arrivals, graph.name, undefined, replay.ledger, undefined, true, new Map(), { status: "waiting-human", waiting: replay.waitingHuman });
			const humans = replay.waitingHumans.map((waiting) => ({ node: waiting.nodeId, visit: waiting.visit, attempt: waiting.attempt, via: { kind: "next" as const }, ...(waiting.fanOut ? { fanOut: waiting.fanOut } : {}) }));
			return this.execute(graph, defaultOptions(options), journal, replay.state, [...reapplyQueue, ...humans, ...replay.next], replay.visits, replay.attemptsUsed, replay.arrivals, graph.name, undefined, replay.ledger, resumeOptions.answer);
		}
		if (replay.status !== "running" && replay.status !== "waiting-recovery") {
			if (reapplyQueue.length && (replay.status === "waiting-human" || replay.status === "waiting-escalation" || replay.status === "suspended")) return this.execute(graph, defaultOptions(options), journal, replay.state, [...reapplyQueue, ...replay.next], replay.visits, replay.attemptsUsed, replay.arrivals, graph.name, undefined, replay.ledger, undefined, true, new Map(), { status: replay.status });
			return this.handleFromReplay(directory, replay.state, replay.status, replay.result, undefined, graph);
		}
		const cache = await readStateCache(directory);
		if (!cache || JSON.stringify(cache.data) !== JSON.stringify(replay.state.data) || cache.revision !== replay.state.revision) await writeStateCache(directory, replay.state);
		const node = replay.currentNode ?? graph.entry;
		const visit = replay.visits[node] ?? 0;
		const recovered = replay.recover;
		// Every activation that was in flight is owed a run, not just the last one
		// started: a kill can land with a whole batch running (Stage 5, criterion 4).
		const inFlight = replay.recoverAll.filter((entry) => !(recovered?.result && sameActivationIdentity({ ...entry.activation, ...(entry.fanOut ? { fanOut: entry.fanOut } : {}) }, { ...recovered.activation, ...(recovered.fanOut ? { fanOut: recovered.fanOut } : {}) })));
		const recoveredQueue = recovered && !recovered.result && inFlight.length === 0
			? [{ node: recovered.activation.node, visit: recovered.activation.visit, attempt: recovered.attempt, interruptedAttempt: Math.max(1, recovered.attempt - 1), via: { kind: "next" as const }, ...(recovered.fanOut ? { fanOut: recovered.fanOut } : {}) }]
			: inFlight.map((entry) => ({ node: entry.activation.node, visit: entry.activation.visit, attempt: entry.attempt, interruptedAttempt: entry.interruptedAttempt, via: { kind: "next" as const }, ...(entry.fanOut ? { fanOut: entry.fanOut } : {}) }));
		const next = [...reapplyQueue, ...recoveredQueue, ...replay.next].length
			? [...reapplyQueue, ...recoveredQueue, ...replay.next]
			: recovered?.result ? [] : [{ node, visit: Math.max(visit, 1), attempt: 1, via: { kind: "next" as const } }];

		// Every activation this resume must re-run, that cannot prove it finished, and
		// that nobody has ruled on yet. Under `suspend` the run stops here rather than
		// silently repeating an effect the operator cannot take back (D-065).
		const gate = await this.recoveryGate(graph, options, journal, recoveredQueue, replay, resumeOptions.recovery);
		if (gate.suspended) return this.handleFromReplay(directory, replay.state, "waiting-recovery", replay.result, undefined, graph, gate.unproven);
		// A skipped activation keeps its place in the queue. It is not re-executed —
		// `execute` reads the same decision and routes on the verdict the operator
		// supplied — so the journal, commit and routing path stay identical to a node
		// that ran. Dropping it from the queue instead would leave the run with
		// nothing to route and stall it.
		// An activation that left durable evidence of its work is adopted rather than
		// re-run. This is the part of #17 that can be settled on fact rather than on an
		// author's promise: the worker's contract result outlives the crash, so the
		// runner can know the node finished (D-063). Marked here and read in `execute`,
		// so an adopted activation takes exactly the same journal, verdict, commit and
		// routing path as one that ran — the alternative is a second, divergent copy of
		// the apply path, which is how a resume comes to behave unlike a run.
		return this.execute(graph, defaultOptions(options), journal, replay.state, next, replay.visits, replay.attemptsUsed, replay.arrivals, graph.name, recovered?.result, replay.ledger, undefined, true, gate.skipped);
	}

	private async execute(graph: ExecutableGraph, options: RunOptions, journal: RunJournal, initialState: RunState, initialQueue: QueueEntry[], initialVisits: Record<string, number>, initialAttempts: number, initialArrivals: Array<{ at: string; from: { node: string; visit: number }; fanOut?: FanOutIdentity; via: EdgeReason }>, graphName: string, initialResult?: NodeResult, initialLedger: CostLedger = EMPTY_LEDGER, humanAnswer?: JsonValue, resuming = false, skipped: Map<string, VerdictName | undefined> = new Map(), stopAfterReplay?: { status: "waiting-human" | "waiting-escalation" | "suspended"; waiting?: JournalReplay["waitingHuman"] }): Promise<RunHandle> {
		let state = initialState;
		const queue = initialQueue;
		// The activations this resume is recovering, which are the only ones whose
		// durable evidence may be adopted. A node reached again later in the same run
		// has done no work yet, and must never inherit an earlier crash's result.
		const recoveredEntries = resuming ? initialQueue.filter((entry) => entry.interruptedAttempt !== undefined) : [];
		const recoveringActivations = new Map<string, number>(recoveredEntries.map((entry) => [activationIdentityKey(entry, entry.attempt), entry.interruptedAttempt ?? entry.attempt]));
		const evidenceIdentityCounts = new Map<string, number>();
		for (const entry of recoveredEntries) {
			const interruptedAttempt = entry.interruptedAttempt ?? entry.attempt;
			const key = `${entry.node}#${entry.visit}#${interruptedAttempt}`;
			evidenceIdentityCounts.set(key, (evidenceIdentityCounts.get(key) ?? 0) + 1);
		}
		const visits = { ...initialVisits };
		let attemptsUsed = initialAttempts;
		let arrivals = initialArrivals.map((arrival) => ({ ...arrival, from: { ...arrival.from }, ...(arrival.fanOut ? { fanOut: { ...arrival.fanOut } } : {}) }));
		const runStartedAt = this.now();
		// The ceiling in force is the lower of what the graph declared and what the
		// invocation supplied; an invocation may lower one and never raise one (§12).
		const costCeiling = effectiveCostCeiling(graph.limits.maxCostUsd, options.maxCostUsd);
		let ledger = initialLedger;
		// An answer belongs to the node that was interrupted, and to nothing after it.
		let pendingAnswer = humanAnswer;
		let lastVerdict: VerdictName | undefined;
		const summary = (): FinishSummary => ({ ledger, attemptsUsed, ...(lastVerdict ? { lastVerdict } : {}), ...(options.maxCostUsd === undefined ? {} : { invokedCostCeiling: options.maxCostUsd }) });
		if (initialResult) {
			visits[initialResult.activation.node] = Math.max(visits[initialResult.activation.node] ?? 0, initialResult.activation.visit);
			const plan = step({ graph, state: state.data, results: [initialResult], visits, attemptsUsed: initialAttempts, arrivals });
			const targets = [...plan.schedule.map((item) => item.node as Destination), ...(plan.terminal ? [plan.terminal.terminal] : [])];
			if (targets.length) await journal.append({ type: "edge-fired", from: initialResult.activation.node, to: targets, via: plan.terminal?.via ?? plan.schedule[0]?.via ?? { kind: "next" }, ...(plan.schedule[0]?.fanOut ? { fanOut: plan.schedule[0].fanOut } : {}) });
			if (plan.halt) return this.finish(journal, state, "failed", plan.halt, graph, graphName, summary());
			if (plan.terminal) return this.finish(journal, state, plan.terminal.terminal === "done" ? "completed" : "failed", plan.terminal.terminal === "fail" ? { code: "RUN-NODE-FAILED", detail: "Graph routed to fail." } : undefined, graph, graphName, summary());
			arrivals = plan.arrivals as typeof arrivals;
			queue.push(...plan.schedule.map((scheduled) => ({ ...scheduled, attempt: 1 })));
		}
		while (queue.length) {
			// The node boundary, and the only place a live session may interrupt the
			// run. Checked before a batch is taken rather than after it finishes, so
			// an interruption that arrives while a node runs takes effect here and
			// never inside that node's turn (D-021, D-022).
			const boundary = decideAtBoundary(this.interruptions?.pending());
			if (boundary.action === "pause") return await this.pauseHere(journal, state, boundary.reason, boundary.detail, graph, graphName, summary());
			if (boundary.action === "suspend") return await this.suspendHere(journal, state, boundary.reason, boundary.detail, graph, graphName, summary());
			if (graph.limits.graphTimeoutMs !== undefined && this.now().getTime() - runStartedAt.getTime() >= graph.limits.graphTimeoutMs) return this.finish(journal, state, "failed", { code: "RUN-GRAPH-TIMEOUT", detail: `Graph timeout of ${graph.limits.graphTimeoutMs}ms exceeded.` }, graph, graphName, summary());
			// A batch of one behaves exactly as the sequential runner always has. Above
			// one, the nodes run concurrently and their results are then applied in the
			// order they were scheduled, never the order they happened to finish.
			const batch = this.takeBatch(queue, graph);
			const missing = batch.find((entry) => !graph.nodes[entry.node]);
			if (missing) return this.finish(journal, state, "failed", { code: "RUN-NODE-FAILED", detail: `Node ${missing.node} does not exist.` }, graph, graphName, summary());
			const executing = batch.filter((entry) => entry.replayed === undefined);
			for (const entry of executing) {
				const scheduled = graph.nodes[entry.node]!;
				await journal.append({ type: "node-started", nodeId: scheduled.id, visit: entry.visit, attempt: entry.attempt, adapter: scheduled.kind, ...(entry.fanOut ? { fanOut: entry.fanOut } : {}) });
			}
			// What is current, for a live session's guard. Published after the
			// journal records the start, so anything acting on it is acting on a node
			// the run has already committed to.
			if (executing.length) this.currentNodes?.enter(executing.map((entry) => graph.nodes[entry.node]!));
			// Every node in the batch sees the state as it stood when the batch began.
			const snapshot = state.data;
			const startedAt = this.now();
			const ran = await Promise.all(batch.map(async (entry) => {
				const node = graph.nodes[entry.node]!;
				if (entry.replayed) return { entry, node, rawOutcome: entry.replayed.outcome, skipVerdict: undefined, persisted: entry.replayed };
				// Only the activations recovered by this resume, and only until they have
				// been dealt with once: a later visit to the same node is a new activation
				// and must actually run.
				const recoveryKey = activationIdentityKey(entry, entry.attempt);
				const interruptedAttempt = recoveringActivations.get(recoveryKey);
				recoveringActivations.delete(recoveryKey);
				// Evidence was written under the attempt that was interrupted, not the
				// attempt about to run.
				const evidenceKey = interruptedAttempt === undefined ? undefined : `${entry.node}#${entry.visit}#${interruptedAttempt}`;
				const evidence = interruptedAttempt === undefined || (evidenceKey !== undefined && (evidenceIdentityCounts.get(evidenceKey) ?? 0) > 1)
					? undefined
					: await this.recoveredEvidence(node, { visit: entry.visit, attempt: interruptedAttempt });
				if (evidence) {
					await journal.append({ type: "node-recovered", nodeId: node.id, visit: entry.visit, attempt: entry.attempt, ...(entry.fanOut ? { fanOut: entry.fanOut } : {}), evidence: "contract-result" });
					return { entry, node, rawOutcome: evidence, skipVerdict: undefined, persisted: undefined };
				}
				// The operator inspected the world and told us this activation already
				// happened. It is not executed again; it routes on the verdict they
				// supplied, through the same path any other outcome takes (D-065).
				if (skipped.has(recoveryKey)) {
					await journal.append({ type: "operator-move", action: "skip", to: node.id });
					const skippedOutcome: NodeOutcome = { status: "completed", changed: false, completionSignal: "not-applicable" };
					return { entry, node, rawOutcome: skippedOutcome, skipVerdict: skipped.get(recoveryKey), persisted: undefined };
				}
				// The operator's answer reaches the interrupted node and is spent there:
				// it must not be delivered into a later node's turn (D-021).
				const answer = node.kind === "human" ? pendingAnswer : undefined;
				if (node.kind === "human") pendingAnswer = undefined;
				// Journalled against this activation, and awaited, so the record is
				// durable before the node can finish or the runner can be killed.
				const onSpawn = async (identity: ProcessIdentity): Promise<void> => {
					await journal.append({ type: "process-spawned", nodeId: node.id, visit: entry.visit, attempt: entry.attempt, ...(entry.fanOut ? { fanOut: entry.fanOut } : {}), pid: identity.pid, ...(identity.startTicks === undefined ? {} : { startTicks: identity.startTicks }) });
				};
				return { entry, node, rawOutcome: await this.runNode(node, snapshot, options, answer, onSpawn, { visit: entry.visit, attempt: entry.attempt }), skipVerdict: undefined, persisted: undefined };
			}));
			// Nothing is current between batches. A tool call arriving now is the
			// operator's own, not a node's, and is not held to any node's allowlist.
			if (executing.length) this.currentNodes?.leave();
			interface DeferredStop {
				readonly index: number;
				readonly finish: () => RunHandle | Promise<RunHandle>;
			}
			let deferredStop: DeferredStop | undefined;
			const deferStop = (candidate: DeferredStop): void => {
				if (!deferredStop || candidate.index < deferredStop.index) deferredStop = candidate;
			};
			const applied: Array<{ index: number; node: CompiledNode; activation: QueueEntry; resolved: ReturnType<typeof resolveOutcome> }> = [];
			for (const [index, { entry, node: ranNode, rawOutcome, skipVerdict, persisted }] of ran.entries()) {
				// A human node with no answer has not run: the run suspends and waits for a
				// person. Not a failure, so it never reaches `onError` and consumes no retry
				// attempt (§11.5, D-060).
				if (rawOutcome.awaitingHuman) {
					const awaiting = rawOutcome.awaitingHuman;
					await journal.append({ type: "node-finished", nodeId: ranNode.id, visit: entry.visit, attempt: entry.attempt, ...(entry.fanOut ? { fanOut: entry.fanOut } : {}), status: rawOutcome.status, changed: false, durationMs: Math.max(0, this.now().getTime() - startedAt.getTime()), completionSignal: rawOutcome.completionSignal });
					await journal.append({ type: "human-requested", nodeId: ranNode.id, question: awaiting.question, visit: entry.visit, attempt: entry.attempt, ...(entry.fanOut ? { fanOut: entry.fanOut } : {}) });
					deferStop({ index, finish: () => {
						const waiting = { nodeId: ranNode.id, question: awaiting.question, accepts: this.human.accepts(ranNode), ...(awaiting.refusal ? { refusal: awaiting.refusal } : {}) };
						return { runId: state.runId, directory: journal.directory, status: "waiting-human", state, result: projectResult(state.data, graph), waitingHuman: waiting, statusLine: statusLine({ runId: state.runId, graph, graphName, status: "waiting-human", currentNode: ranNode.id, visit: entry.visit, ...(lastVerdict ? { lastVerdict } : {}), attemptsUsed, ledger, ...(costCeiling === undefined ? {} : { costCeilingUsd: costCeiling }), question: awaiting.question }) };
					} });
					continue;
				}
				// An escalation suspends the run before anything can route it. It is not a node
				// failure, never reaches `onError`, and schedules no retry (§11.4.3, D-054).
				if (rawOutcome.escalation) {
					await journal.append({ type: "node-finished", nodeId: ranNode.id, visit: entry.visit, attempt: entry.attempt, ...(entry.fanOut ? { fanOut: entry.fanOut } : {}), status: rawOutcome.status, changed: false, durationMs: Math.max(0, this.now().getTime() - startedAt.getTime()), completionSignal: rawOutcome.completionSignal });
					await journal.append({ type: "escalation-raised", nodeId: ranNode.id, requestId: rawOutcome.escalation.requestId });
					deferStop({ index, finish: () => ({ runId: state.runId, directory: journal.directory, status: "waiting-escalation", state, ...(projectResult(state.data, graph) ? { result: projectResult(state.data, graph) } : {}) }) });
					continue;
				}
				// A peer that stopped responding is a RUN-level fault, not a node failure:
				// the session is broken, so retrying the node walks into the same wall and
				// every node after it inherits the same session. This is the one case where
				// a node-level fault MUST be escalated to the run (§11.2.2, D-051).
				if (rawOutcome.peerUnresponsive) {
					const detail = rawOutcome.peerUnresponsive.detail;
					await journal.append({ type: "node-finished", nodeId: ranNode.id, visit: entry.visit, attempt: entry.attempt, ...(entry.fanOut ? { fanOut: entry.fanOut } : {}), status: rawOutcome.status, changed: false, durationMs: Math.max(0, this.now().getTime() - startedAt.getTime()), completionSignal: rawOutcome.completionSignal });
					deferStop({ index, finish: () => this.finish(journal, state, "failed", { code: "RUN-PEER-UNRESPONSIVE", detail }, graph, graphName, summary()) });
					continue;
				}
				const resolvedEntry = persisted ?? resolveOutcome(ranNode, entry, rawOutcome, skipVerdict);
				if (!persisted) {
					ledger = addUsage(ledger, resolvedEntry.outcome.usage);
					attemptsUsed += 1;
				}
				// The adapter's own reason is journalled with the finish. It is the only
				// record of why a node failed: the halt detail comes from the pure
				// routing layer, which never sees it (#34).
				if (!persisted) await journal.append({
					type: "node-finished",
					nodeId: ranNode.id,
					visit: entry.visit,
					attempt: entry.attempt,
					...(entry.fanOut ? { fanOut: entry.fanOut } : {}),
					status: resolvedEntry.outcome.status,
					changed: resolvedEntry.outcome.changed,
					durationMs: Math.max(0, this.now().getTime() - startedAt.getTime()),
					...(resolvedEntry.outcome.usage ? { usage: resolvedEntry.outcome.usage } : {}),
					completionSignal: resolvedEntry.outcome.completionSignal,
					...(resolvedEntry.outcome.diagnostics?.length ? { diagnostics: [...resolvedEntry.outcome.diagnostics] } : {}),
					application: {
						outcome: structuredClone(resolvedEntry.result.outcome),
						source: resolvedEntry.source,
						...(resolvedEntry.result.terminal ? { terminal: true } : {}),
						...(isJsonValue(resolvedEntry.outcome.output) ? { output: structuredClone(resolvedEntry.outcome.output) } : {}),
					},
				});
				applied.push({ index, node: ranNode, activation: entry, resolved: resolvedEntry });
			}
			// Every activation in the batch has already resolved. Apply every ordinary
			// result before returning a terminal or suspension, otherwise an earlier
			// scheduled branch can silently discard a later sibling's completed work.
			for (const { index, node, activation, resolved } of applied) {
			const outcome = resolved.outcome;
			const costExceeded = costCeiling !== undefined && ledger.costUsd >= costCeiling;
			const result = resolved.result;
			lastVerdict = result.outcome.verdict;
			await journal.append({ type: "verdict-resolved", nodeId: node.id, visit: activation.visit, verdict: result.outcome.verdict, source: result.outcome.kind === "engine" ? "engine" : resolved.source });
			if (outcome.status === "completed" && node.kind === "human" && result.outcome.kind === "verdict") {
				await journal.append({ type: "human-answered", nodeId: node.id, verdict: result.outcome.verdict, visit: activation.visit, attempt: activation.attempt, ...(activation.fanOut ? { fanOut: activation.fanOut } : {}), ...(isJsonValue(outcome.output) ? { value: outcome.output } : {}) });
			}
			// `storage: artifact` externalises the body before it can reach state, so the
			// path holds a reference and the bytes live in the run directory (D-058).
			const externalised = await this.externalise(journal, node, outcome, state.runId);
			const delta = this.deltaFor(node, externalised, state.data);
			const committed = commitState(state, delta, this.now());
			const pathViolation = graph.statePolicy.paths.find((policy) => {
				const value = valueAt(committed.data, policy.path);
				return value !== undefined && Buffer.byteLength(JSON.stringify(value)) > policy.maxBytes;
			});
			if (committed.bytes > graph.limits.maxStateBytes || pathViolation) return this.finish(journal, state, "failed", { code: "RUN-STATE-BYTES", detail: pathViolation ? `State path ${pathViolation.path} exceeds its ${pathViolation.maxBytes}-byte budget.` : `State commit would be ${committed.bytes} bytes; maximum is ${graph.limits.maxStateBytes}.` }, graph, graphName, summary());
			await this.beforeCommit();
			state = committed;
			await journal.append({ type: "state-committed", revision: state.revision, bytes: state.bytes, delta });
			await writeStateCache(journal.directory, state);
			if (costExceeded) deferStop({ index, finish: () => this.finish(journal, state, "failed", { code: "RUN-COST-CEILING", detail: `Cost ceiling of ${costCeiling} USD reached.` }, graph, graphName, summary()) });
			visits[node.id] = Math.max(visits[node.id] ?? 0, activation.visit);
			const plan = step({ graph, state: state.data, results: [result], visits, attemptsUsed, arrivals });
			const candidateArrivals = [...plan.arrivals, ...plan.consumed].filter((token, index, all) => all.findIndex((item) => sameToken(item, token)) === index);
			const newArrivals = candidateArrivals.filter((token) => !arrivals.some((existing) => sameToken(existing, token)));
			for (const token of newArrivals) await journal.append({ type: "join-arrived", joinId: token.at, from: token.from, ...(token.fanOut ? { fanOut: token.fanOut } : {}), via: token.via });
			for (const joinId of [...new Set(plan.consumed.map((token) => token.at))]) {
				const join = graph.nodes[joinId];
				if (join?.join) await journal.append({ type: "join-fired", joinId, consumed: plan.consumed.filter((item) => item.at === joinId).map((item) => ({ ...item.from, ...(item.fanOut ? { fanOut: item.fanOut } : {}) })), mode: join.join });
			}
			arrivals = plan.arrivals as typeof arrivals;
			const edgeTargets = [...newArrivals.map((token) => token.at as Destination), ...plan.schedule.map((item) => item.node as Destination)];
			if (plan.terminal) edgeTargets.push(plan.terminal.terminal);
			const edgeFanOut = plan.schedule[0]?.fanOut ?? newArrivals[0]?.fanOut;
			if (edgeTargets.length) await journal.append({ type: "edge-fired", from: node.id, to: edgeTargets, via: plan.terminal?.via ?? plan.schedule[0]?.via ?? newArrivals[0]?.via ?? { kind: "next" }, ...(edgeFanOut ? { fanOut: edgeFanOut } : {}) });
			if (plan.halt) deferStop({ index, finish: () => this.finish(journal, state, "failed", plan.halt!, graph, graphName, summary()) });
			if (plan.terminal) {
				const terminal = plan.terminal.terminal;
				deferStop({ index, finish: () => this.finish(journal, state, terminal === "done" ? "completed" : "failed", terminal === "fail" ? { code: "RUN-NODE-FAILED", detail: "Graph routed to fail." } : undefined, graph, graphName, summary()) });
			}
			const applicationSchedule: QueueEntry[] = plan.schedule.map((scheduled) => ({ ...scheduled, attempt: 1 }));
			queue.push(...applicationSchedule);
			for (const retry of plan.retry) {
				if (retry.delayMs > 0) await delay(retry.delayMs);
				const scheduled = { node: retry.activation.node, visit: retry.activation.visit, via: { kind: "on-error" as const }, attempt: retry.attempt, ...(retry.fanOut ? { fanOut: retry.fanOut } : {}) };
				applicationSchedule.push(scheduled);
				queue.push(scheduled);
			}
			await journal.append({
				type: "node-applied",
				nodeId: node.id,
				visit: activation.visit,
				attempt: activation.attempt,
				...(activation.fanOut ? { fanOut: activation.fanOut } : {}),
				scheduled: applicationSchedule.map((scheduled) => ({ node: scheduled.node, visit: scheduled.visit, attempt: scheduled.attempt, via: scheduled.via, ...(scheduled.fanOut ? { fanOut: scheduled.fanOut } : {}) })),
			});
			}
			if (stopAfterReplay && queue[0]?.replayed === undefined) return this.handleFromReplay(journal.directory, state, stopAfterReplay.status, projectResult(state.data, graph), stopAfterReplay.waiting, graph);
			const stop = deferredStop as DeferredStop | undefined;
			if (stop) return await stop.finish();
		}
		return this.finish(journal, state, "failed", { code: "RUN-NODE-FAILED", detail: "Run stopped without reaching a terminal." }, graph, graphName, summary());
	}

	/**
	 * Reap process groups a previous runner left behind.
	 *
	 * Only a process **proven** to be the recorded one is signalled. A process id
	 * is not evidence on its own, because the operating system reuses them, so an
	 * id that cannot be matched against its recorded start time is left alone and
	 * journalled as unproven. Killing on a guess would end an unrelated program,
	 * which is worse than the overlap being prevented (D-062).
	 */
	private async reapOrphans(journal: RunJournal, processes: ReadonlyArray<{ nodeId: string; pid: number; startTicks?: number }>): Promise<void> {
		for (const entry of processes) {
			const { reaped, verdict } = await reapIfSame({ pid: entry.pid, ...(entry.startTicks === undefined ? {} : { startTicks: entry.startTicks }) });
			await journal.append({
				type: "process-reaped",
				nodeId: entry.nodeId,
				pid: entry.pid,
				outcome: reaped ? "reaped" : verdict.state === "gone" ? "gone" : verdict.state === "recycled" ? "recycled" : "unproven",
				...("detail" in verdict && verdict.detail ? { detail: verdict.detail } : {}),
			});
		}
	}

	/** The graph's declared concurrency. A specialised runner may impose a lower cap. */
	protected batchWidth(graph: ExecutableGraph): number {
		return Math.max(1, graph.limits.maxConcurrency);
	}

	/**
	 * Take the next deterministic queue prefix that can share one batch.
	 *
	 * Template activations all use the user's one live PTM session. Two of them
	 * must therefore never overlap, while one template may overlap independent
	 * command or delegated-agent work. When the next queued activation would need
	 * the same session, stop the batch there: a smaller prefix preserves schedule
	 * order, whereas skipping over it would make execution order resource-dependent.
	 */
	private takeBatch(queue: QueueEntry[], graph: ExecutableGraph): QueueEntry[] {
		const batch: QueueEntry[] = [];
		let hasTemplate = false;
		const replaying = queue[0]?.replayed !== undefined;
		const width = this.batchWidth(graph);
		while (batch.length < width && queue.length) {
			const next = queue[0]!;
			// Finished applications must reach their durable boundary before a queued
			// successor can observe state. Keep those phases in separate batches.
			if ((next.replayed !== undefined) !== replaying) break;
			const isTemplate = graph.nodes[next.node]?.kind === "template";
			if (isTemplate && hasTemplate) break;
			batch.push(queue.shift()!);
			hasTemplate ||= isTemplate;
		}
		return batch;
	}

	/** Whether an installed adapter for this kind can narrow a worker's tool surface. */
	protected canEnforceTools(kind: CompiledNode["kind"]): boolean {
		return Boolean(this.adapters[kind]);
	}

	/**
	 * Why this graph cannot run in Mode A, or `undefined` when it can.
	 *
	 * Two narrowings, and both are the difference between a real precondition and
	 * a false gate:
	 *
	 * - **Only a graph with a `template` node is asked.** A command-and-set graph
	 *   does not care what PTM can do.
	 * - **Only a caller who declared capabilities is judged.** Supplying a
	 *   `template` adapter through the port IS the answer to "can this session run
	 *   a template" — that is what the port is for, and it is how every test and
	 *   any future second runner drives one. Declaring capabilities is how a live
	 *   Mode A session reports what the PTM it found can actually do; a caller
	 *   that declares them and comes up short is refused, and a caller that
	 *   brought its own way to run the node is not second-guessed.
	 *
	 * Getting this wrong the first time refused `release-gate.md`, a worked
	 * example, which D-043 makes a finding about this code rather than the fixture.
	 */
	private missingTemplateSupport(graph: ExecutableGraph): string | undefined {
		const templates = Object.values(graph.nodes).filter((node) => node.kind === "template");
		if (!templates.length) return undefined;
		const capabilities = this.templateCapabilities;
		// No adapter and no declared capabilities: nothing here can start a template.
		if (!capabilities) return this.adapters.template ? undefined : `This graph has ${templates.length} template node${templates.length === 1 ? "" : "s"} (${templates.map((node) => node.id).join(", ")}), and this runner has no way to run one: no template adapter is installed and no pi-prompt-template-model capabilities were declared. Mode A has no fallback (D-038, D-039).`;
		// Declared and short: this is a live Mode A session reporting what its PTM
		// lacks, which is the case §11.2 refuses.
		const detail = missingTemplateCapabilities(capabilities);
		if (!detail) return undefined;
		return `${detail} Affected nodes: ${templates.map((node) => node.id).join(", ")}.`;
	}

	/**
	 * Records a manual move by the operator.
	 *
	 * Journalled as operator-initiated so a later reading of the run does not
	 * attribute it to the graph ([0005](../../.spec/0005-node-adapters.md) §7). The
	 * operator is not held to the compiled edges — overriding them is the point of a
	 * manual move; the agent's own `graph_transition` is checked instead.
	 */
	async recordOperatorMove(runId: string, options: RunOptions, move: { action: "goto" | "stop" | "skip"; to?: string }): Promise<void> {
		const directory = join(options.runsRoot, runId);
		const journal = new RunJournal(directory, runId);
		await journal.append({ type: "operator-move", action: move.action, ...(move.to ? { to: move.to } : {}) });
	}

	/**
	 * Durable evidence that this activation already did its work, or `undefined`.
	 *
	 * The runner asks the adapter rather than reading a path itself: what counts as
	 * evidence is the adapter's business, and only the `agent` adapter currently has
	 * any. A `command` node leaves no trace the runner can attribute, and a
	 * `template` node is Stage 3 — for those this returns `undefined` and the node
	 * re-runs exactly as before (#17, D-063).
	 */
	private async recoveredEvidence(node: CompiledNode, activation: { visit: number; attempt: number }): Promise<NodeOutcome | undefined> {
		const adapter = this.adapters[node.kind];
		if (!adapter?.recoveredResult) return undefined;
		return await adapter.recoveredResult(node.id, activation);
	}

	/**
	 * Decides what a resume does with activations it cannot prove finished.
	 *
	 * Under the default `rerun` this does nothing at all and the resume behaves
	 * exactly as it did before the option existed, which is what keeps an unattended
	 * run working. Under `suspend` it stops the run and records every unprovable
	 * activation, so a person sees the whole batch a kill left behind rather than the
	 * first of them (D-056, D-065).
	 *
	 * An activation is unprovable only when its adapter cannot produce evidence. An
	 * `agent` node writes a contract result that outlives the crash, so it is proven
	 * or genuinely absent; a `command` node leaves nothing the runner can attribute
	 * (D-063).
	 */
	private async recoveryGate(graph: ExecutableGraph, options: RunOptions, journal: RunJournal, queue: QueueEntry[], replay: JournalReplay, supplied?: RecoveryDecisions): Promise<{ suspended: boolean; unproven: UnprovenActivation[]; skipped: Map<string, VerdictName | undefined> }> {
		const suppliedCanonical = new Map<string, { decision: RecoveryDecisions[string]; identity: { node: string; visit: number; fanOut?: FanOutIdentity }; attempt: number }>();
		for (const [suppliedKey, decision] of Object.entries(supplied ?? {})) {
			const parts = suppliedKey.split("#");
			if (parts.length !== 3 && parts.length !== 5) throw new RecoveryDecisionError(`Recovery key ${suppliedKey} must be node#visit#attempt or node#visit#attempt#fanOutNode#fanOutVisit.`);
			const [node, visitText, attemptText, fanOutNode, fanOutVisitText] = parts;
			const visit = Number(visitText);
			const attempt = Number(attemptText);
			const fanOutVisit = fanOutVisitText === undefined ? undefined : Number(fanOutVisitText);
			if (!node || !Number.isInteger(visit) || visit < 1 || !Number.isInteger(attempt) || attempt < 1 || (parts.length === 5 && (!fanOutNode || !Number.isInteger(fanOutVisit) || fanOutVisit! < 1))) throw new RecoveryDecisionError(`Recovery key ${suppliedKey} has an invalid activation identity.`);
			let identity: { node: string; visit: number; fanOut?: FanOutIdentity } = { node, visit };
			if (fanOutNode && fanOutVisit !== undefined) identity = { ...identity, fanOut: { node: fanOutNode, visit: fanOutVisit } };
			else {
				const candidates = queue.filter((entry) => entry.node === node && entry.visit === visit && entry.attempt === attempt);
				if (candidates.length > 1) throw new RecoveryDecisionError(`Legacy recovery key ${suppliedKey} is ambiguous. Use one of: ${candidates.map((entry) => activationIdentityKey(entry, entry.attempt)).join(", ")}.`);
				if (candidates[0]?.fanOut) identity = { ...identity, fanOut: candidates[0].fanOut };
			}
			suppliedCanonical.set(activationIdentityKey(identity, attempt), { decision, identity, attempt });
		}

		const skipped = new Map<string, VerdictName | undefined>();
		for (const [key, decision] of Object.entries(replay.recoveryDecisions)) if (decision.action === "skip") skipped.set(key, decision.verdict as VerdictName | undefined);
		for (const [key, { decision }] of suppliedCanonical) if (decision.action === "skip") skipped.set(key, decision.verdict);
		if ((options.onUncertainRecovery ?? "rerun") === "rerun") return { suspended: false, unproven: [], skipped };

		const answered = new Set([...Object.keys(replay.recoveryDecisions), ...suppliedCanonical.keys()]);
		const unproven: UnprovenActivation[] = [];
		for (const entry of queue) {
			const key = activationIdentityKey(entry, entry.attempt);
			if (entry.interruptedAttempt === undefined || answered.has(key)) continue;
			const node = graph.nodes[entry.node];
			if (!node) continue;
			// Existing durable evidence names node/visit/attempt, not fan-out. It proves
			// one activation only while that tuple is unique in this recovered queue.
			const evidenceAmbiguous = queue.filter((candidate) => candidate.node === entry.node && candidate.visit === entry.visit && candidate.interruptedAttempt === entry.interruptedAttempt).length > 1;
			if (!evidenceAmbiguous) {
				if (await this.recoveredEvidence(node, { visit: entry.visit, attempt: entry.interruptedAttempt })) continue;
				if (this.adapters[node.kind]?.recoveredResult) continue;
			}
			unproven.push({ nodeId: node.id, visit: entry.visit, attempt: entry.attempt, ...(entry.fanOut ? { fanOut: entry.fanOut } : {}), kind: node.kind, ...(node.output ? { output: node.output } : {}) });
		}
		for (const [key, { decision, identity, attempt }] of suppliedCanonical) {
			// A skip routes on the operator's verdict, so it must be one the node can
			// actually produce. Without this a person could send the run down an edge
			// the compiler proved impossible, and the run would dead-end with a generic
			// "stopped without reaching a terminal" that names nothing they did.
			if (decision.action === "skip") {
				const target = graph.nodes[identity.node];
				const allowed = target ? verdictsFor(target) : [];
				if (!decision.verdict) throw new RecoveryDecisionError(`Skipping ${key} needs a verdict to route on. This node accepts: ${allowed.join(", ") || "none"}.`);
				if (allowed.length && !allowed.includes(decision.verdict)) throw new RecoveryDecisionError(`Node ${identity.node} cannot produce the verdict ${decision.verdict}. It accepts: ${allowed.join(", ")}.`);
			}
			await journal.append({ type: "recovery-decided", nodeId: identity.node, visit: identity.visit, attempt, ...(identity.fanOut ? { fanOut: identity.fanOut } : {}), action: decision.action, ...(decision.verdict ? { verdict: decision.verdict } : {}) });
		}
		if (!unproven.length) return { suspended: false, unproven: [], skipped };
		await journal.append({ type: "run-suspended", reason: "uncertain-recovery", unproven });
		return { suspended: true, unproven, skipped };
	}

	/** Called before every state commit. The durable runner uses it to check it still owns the run. */
	protected beforeCommit(): Promise<void> {
		return Promise.resolve();
	}

	private async runNode(node: CompiledNode, state: JsonObject, options: RunOptions, answer?: JsonValue, onSpawn?: (identity: ProcessIdentity) => void | Promise<void>, activation?: { visit: number; attempt: number }): Promise<NodeOutcome> {
		if (node.kind === "set") return this.set.run(node, { state });
		// A `human` node in a run with nobody present cannot be answered. Failing it
		// fast and specifically is the rule; retrying into the same wall is not
		// ([0009](../../.spec/0009-ecosystem-integration.md) G1).
		if (node.kind === "human") {
			// Terminal, not merely failed: nobody arrives to answer between attempts.
			// This held before only because a `human` node cannot declare `retry`,
			// which is the compiler's doing rather than this rule's (§11.5.4).
			if (!options.interactive) return { status: "failed", changed: false, completionSignal: "not-applicable", terminal: true, diagnostics: [`Node ${node.id} asks a person, and this run has nobody to ask. Run it interactively, or replace the node.`] };
			return (this.adapters.human ?? this.human).run(node, { state, ...(answer === undefined ? {} : { answer }) });
		}
		const adapter = this.adapters[node.kind] ?? (node.kind === "command" ? this.command : undefined);
		if (!adapter) return { status: "failed", changed: false, completionSignal: "not-applicable", diagnostics: [`No adapter is installed for ${node.kind} nodes.`] };
		if (!options.interactive && node.kind !== "command") return { status: "failed", changed: false, completionSignal: "not-applicable", diagnostics: ["This adapter requires an interactive run."] };
		return adapter.run(node, { state, ...(onSpawn ? { onSpawn } : {}), ...(activation ? { activation } : {}) });
	}

	/**
	 * Writes a declared artifact to a content-addressed file and returns the outcome
	 * with an `ArtifactRef` in place of the body.
	 *
	 * The declaration is the threshold: `storage: artifact` externalises whatever
	 * the size, and nothing externalises a `storage: state` output behind the
	 * author's back (D-058).
	 */
	private async externalise(journal: RunJournal, node: CompiledNode, outcome: NodeOutcome, runId: string): Promise<NodeOutcome> {
		if (node.storage !== "artifact" || outcome.status !== "completed" || !node.output || !isJsonValue(outcome.output)) return outcome;
		const { content, ref } = artifactFor(runId, outcome.output);
		const directory = join(journal.directory, "artifacts");
		await mkdir(directory, { recursive: true });
		// Content-addressed, so writing the same body twice is the same file.
		await writeFile(join(directory, ref.sha256), content, "utf8");
		await journal.append({ type: "artifact-written", nodeId: node.id, path: node.output, ref });
		return { ...outcome, output: ref as unknown as JsonValue, artifacts: [...(outcome.artifacts ?? []), ref] };
	}

	private deltaFor(node: CompiledNode, outcome: NodeOutcome, state: JsonObject): StateDelta[] {
		if (outcome.status !== "completed") return [];
		const delta: StateDelta[] = [];
		if (node.kind === "set" && node.binding.kind === "set") delta.push(...applyOperations(node.binding.ops, state));
		if (node.output && isJsonValue(outcome.output)) {
			if (node.writeMode === "unset") delta.push({ path: node.output, op: "unset" });
			else delta.push({ path: node.output, op: "set", value: node.writeMode === "reduce" ? mergeAt(state, node.output, outcome.output) : outcome.output });
		}
		return delta;
	}

	/**
	 * Stop at a node boundary because a person is about to say something.
	 *
	 * A pause is **not** a terminal: no `run-finished` is written, the state
	 * cache is left as it stands, and the operator resumes, cancels, or sends
	 * their message from here. The run keeps everything it has done (D-021).
	 */
	private async pauseHere(journal: RunJournal, state: RunState, reason: "operator-input", detail: string | undefined, graph: ExecutableGraph, graphName: string, summary: FinishSummary = {}): Promise<RunHandle> {
		await journal.append({ type: "run-paused", reason });
		const ledger = summary.ledger ?? EMPTY_LEDGER;
		const costCeiling = effectiveCostCeiling(graph.limits.maxCostUsd, summary.invokedCostCeiling);
		return {
			runId: state.runId,
			directory: journal.directory,
			status: "paused",
			state,
			result: projectResult(state.data, graph),
			...(detail ? { interruption: detail } : {}),
			statusLine: statusLine({ runId: state.runId, graph, graphName, status: "paused", attemptsUsed: summary.attemptsUsed ?? 0, ledger, ...(costCeiling === undefined ? {} : { costCeilingUsd: costCeiling }), ...(summary.lastVerdict ? { lastVerdict: summary.lastVerdict } : {}) }),
		};
	}

	/**
	 * Stop at a node boundary because the session is going away.
	 *
	 * Journalled rather than merely returned: nobody is present to read a return
	 * value, and the record is what the next session in this directory reads to
	 * tell the operator that a run is waiting. It never restarts itself (D-022).
	 */
	private async suspendHere(journal: RunJournal, state: RunState, reason: "session-ended", detail: string | undefined, graph: ExecutableGraph, graphName: string, summary: FinishSummary = {}): Promise<RunHandle> {
		await journal.append({ type: "run-suspended", reason });
		await writeStateCache(journal.directory, state);
		const ledger = summary.ledger ?? EMPTY_LEDGER;
		const costCeiling = effectiveCostCeiling(graph.limits.maxCostUsd, summary.invokedCostCeiling);
		return {
			runId: state.runId,
			directory: journal.directory,
			status: "suspended",
			state,
			result: projectResult(state.data, graph),
			...(detail ? { interruption: detail } : {}),
			statusLine: statusLine({ runId: state.runId, graph, graphName, status: "suspended", attemptsUsed: summary.attemptsUsed ?? 0, ledger, ...(costCeiling === undefined ? {} : { costCeilingUsd: costCeiling }), ...(summary.lastVerdict ? { lastVerdict: summary.lastVerdict } : {}) }),
		};
	}

	private async finish(journal: RunJournal, state: RunState, status: "completed" | "failed", failure: { code: RunFailureCode; detail: string } | undefined, graph: ExecutableGraph, graphName: string, summary: FinishSummary = {}): Promise<RunHandle> {
		const result = projectResult(state.data, graph);
		await journal.append({ type: "run-finished", status, ...(failure ? { code: failure.code } : {}), result });
		const ledger = summary.ledger ?? EMPTY_LEDGER;
		const costCeiling = effectiveCostCeiling(graph.limits.maxCostUsd, summary.invokedCostCeiling);
		return {
			runId: state.runId,
			directory: journal.directory,
			status,
			state,
			result,
			...(failure ? { failure } : {}),
			statusLine: statusLine({ runId: state.runId, graph, graphName, status, attemptsUsed: summary.attemptsUsed ?? 0, ledger, ...(costCeiling === undefined ? {} : { costCeilingUsd: costCeiling }), ...(summary.lastVerdict ? { lastVerdict: summary.lastVerdict } : {}), ...(failure ? { failure } : {}) }),
		};
	}

	/** A run waiting on a person or an escalation is returned as it stands: it never restarts itself (D-022, §11.4.3, §11.5). */
	private handleFromReplay(directory: string, state: RunState, status: "completed" | "failed" | "cancelled" | "waiting-escalation" | "waiting-human" | "suspended" | "waiting-recovery", result?: JsonObject, waiting?: { nodeId: string; question: string; visit: number; attempt: number }, graph?: ExecutableGraph, unproven?: UnprovenActivation[]): RunHandle {
		const node = waiting && graph ? graph.nodes[waiting.nodeId] : undefined;
		return {
			runId: state.runId,
			directory,
			status,
			state,
			...(result ? { result } : {}),
			...(waiting ? { waitingHuman: { nodeId: waiting.nodeId, question: waiting.question, accepts: node ? this.human.accepts(node) : [] } } : {}),
			...(unproven?.length ? { unproven } : {}),
		};
	}
}

/**
 * The verdicts a node can produce, for checking an operator's skip against.
 *
 * An open verdict set returns nothing, which means "cannot be enumerated" rather
 * than "none": the check then accepts whatever the operator supplies, because the
 * compiler could not have proved it impossible either.
 */
function verdictsFor(node: CompiledNode): string[] {
	const declared = node.verdicts.kind === "closed" ? node.verdicts.verdicts : [];
	const routed = Object.keys(node.transitions.on);
	return [...new Set([...declared, ...routed])];
}

function contractValid(contract: JsonObject, value: unknown): boolean {
	try { return Compile(contract as never).Check(value); } catch { return false; }
}

function resolveOutcome(node: CompiledNode, activation: QueueEntry, outcome: NodeOutcome, skipVerdict?: VerdictName): { outcome: NodeOutcome; result: NodeResult; source: VerdictSource } {
	// An operator who skipped an activation supplies the verdict themselves. It is
	// recorded as `operator` rather than borrowing the node's own source, because a
	// reading of the run must not attribute a person's decision to the graph
	// (`.spec/0006` §4, D-065).
	if (skipVerdict !== undefined) return { outcome, result: resultFor(node, activation, activation.attempt, outcome, activation.fanOut, skipVerdict), source: "operator" };
	if (outcome.status === "completed" && node.contract) {
		if (!contractValid(node.contract, outcome.output)) {
			const failed: NodeOutcome = { ...outcome, status: "failed", changed: false, diagnostics: [...(outcome.diagnostics ?? []), `Output for ${node.id} does not satisfy its contract.`] };
			return { outcome: failed, result: resultFor(node, activation, activation.attempt, failed, activation.fanOut), source: "engine" };
		}
		const verdict = isObject(outcome.output) && typeof outcome.output.verdict === "string" ? outcome.output.verdict : undefined;
		// A contract without a `verdict` field validates the output and takes no part in
		// routing; resolution falls through to the next source (§5.2 rule 1).
		if (verdict !== undefined) return { outcome, result: resultFor(node, activation, activation.attempt, outcome, activation.fanOut, verdict), source: "contract" };
	}
	return { outcome, result: resultFor(node, activation, activation.attempt, outcome, activation.fanOut), source: sourceFor(node, outcome) };
}

/**
 * Which rule of §5.2 supplied the verdict, for the journal.
 *
 * It mirrors `resultFor` exactly. A source that disagreed with the verdict it
 * labels would make `/graph explain` a narrative rather than a reconstruction.
 */
function sourceFor(node: CompiledNode, outcome: NodeOutcome): VerdictSource {
	if (outcome.status !== "completed") return "engine";
	if (node.kind === "human") return "human";
	if (node.kind === "command") return "exit-code";
	if (node.kind === "agent") return "delegate-status";
	if (node.kind === "set") return "engine";
	return "effect";
}

function resultFor(node: CompiledNode, activation: QueueEntry, attempt: number, outcome: NodeOutcome, fanOut?: FanOutIdentity, explicitVerdict?: string): NodeResult {
	if (outcome.status !== "completed") return { activation: { node: node.id, visit: activation.visit }, attempt, ...(fanOut ? { fanOut } : {}), ...(outcome.terminal ? { terminal: true } : {}), outcome: { kind: "engine", verdict: outcome.status === "timeout" ? "timeout" : outcome.status === "aborted" ? "aborted" : "error" } };
	// Mirrors §5.2 rule for rule. `agent` yields `pass` on a completed delegate
	// result, which is what the compiler derives for it (§5.3 rule 6); resolving
	// `changed` there dead-ended every contract-free agent node.
	const verdict = explicitVerdict ?? (node.kind === "human" ? outcome.humanVerdict ?? "answered"
		: node.kind === "command" ? (outcome.exitCode === 0 ? "pass" : "fail")
		: node.kind === "set" ? "ok"
		: node.kind === "agent" ? "pass"
		: outcome.changed ? "changed" : "unchanged");
	return { activation: { node: node.id, visit: activation.visit }, attempt, ...(fanOut ? { fanOut } : {}), outcome: { kind: "verdict", verdict } };
}

function makeState(runId: string, graph: ExecutableGraph, input: JsonObject, now: Date): RunState {
	const data: JsonObject = { input: structuredClone(input) };
	return { schemaVersion: 1, runId, graphHash: graph.hash, revision: 0, updatedAt: now.toISOString(), data, bytes: Buffer.byteLength(JSON.stringify(data)) };
}

function commitState(state: RunState, delta: StateDelta[], now: Date): RunState {
	const data = applyStateDelta(state.data, delta);
	return { ...state, revision: state.revision + 1, updatedAt: now.toISOString(), data, bytes: Buffer.byteLength(JSON.stringify(data)) };
}

function applyOperations(operations: StateOpSource[], state: JsonObject): StateDelta[] {
	const delta: StateDelta[] = [];
	let current = structuredClone(state);
	for (const operation of operations) {
		if (operation.op === "unset") {
			delta.push({ path: operation.path, op: "unset" });
			current = applyStateDelta(current, [{ path: operation.path, op: "unset" }]);
		} else if (operation.op === "set") {
			const value = operation.value ?? null;
			delta.push({ path: operation.path, op: "set", value });
			current = applyStateDelta(current, [{ path: operation.path, op: "set", value }]);
		} else {
			const old = valueAt(current, operation.path);
			if (old !== undefined && typeof old !== "number") continue;
			const value = (typeof old === "number" ? old : 0) + (operation.by ?? 1);
			delta.push({ path: operation.path, op: "set", value });
			current = applyStateDelta(current, [{ path: operation.path, op: "set", value }]);
		}
	}
	return delta;
}

function mergeAt(state: JsonObject, path: string, output: JsonValue): JsonValue {
	const existing = valueAt(state, path);
	return isObject(existing) && isObject(output) ? deepMerge(existing, output) : output;
}

function deepMerge(left: JsonObject, right: JsonObject): JsonObject {
	const merged: JsonObject = structuredClone(left);
	for (const [key, value] of Object.entries(right)) merged[key] = isObject(value) && isObject(merged[key]) ? deepMerge(merged[key] as JsonObject, value) : structuredClone(value);
	return merged;
}

function valueAt(state: JsonObject, path: string): JsonValue | undefined {
	let value: unknown = state;
	for (const part of path.split(".")) {
		if (!isObject(value) || !Object.prototype.hasOwnProperty.call(value, part)) return undefined;
		value = value[part];
	}
	return value as JsonValue;
}

function projectResult(data: JsonObject, graph: ExecutableGraph): JsonObject {
	const result: JsonObject = {};
	for (const path of graph.result.paths) {
		const value = valueAt(data, path);
		if (value !== undefined) assignPath(result, path, value);
	}
	if (graph.result.includeState) result.state = structuredClone(data);
	return result;
}

function assignPath(target: JsonObject, path: string, value: JsonValue): void {
	const parts = path.split(".");
	let cursor = target;
	for (const part of parts.slice(0, -1)) {
		if (!isObject(cursor[part])) cursor[part] = {};
		cursor = cursor[part] as JsonObject;
	}
	cursor[parts.at(-1)!] = structuredClone(value);
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	return isObject(value) && Object.values(value).every(isJsonValue);
}

function sameToken(left: { at: string; from: { node: string; visit: number }; fanOut?: FanOutIdentity }, right: { at: string; from: { node: string; visit: number }; fanOut?: FanOutIdentity }): boolean {
	return left.at === right.at && left.from.node === right.from.node && left.from.visit === right.from.visit && left.fanOut?.node === right.fanOut?.node && left.fanOut?.visit === right.fanOut?.visit;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
