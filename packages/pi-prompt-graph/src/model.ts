export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type GraphName = string;
export type NodeId = string;
export type RunId = string;
export type VerdictName = string;
export type StatePath = string;
export type Destination = NodeId | "done" | "fail";
export type WriteMode = "reduce" | "overwrite" | "unset";
export type JoinMode = "all" | "any" | { quorum: number };

export interface GraphSource {
	description?: string;
	graph: GraphSourceBody | string;
	budget: number;
	mode?: "session" | "orchestrated";
	collapse?: "off" | "on-back-edge";
	maxConcurrency?: number;
	graphTimeoutMs?: number;
	maxCostUsd?: number;
	maxStateBytes?: number;
	maxPromptBytes?: number;
	result?: { paths: StatePath[]; includeState?: boolean };
	statePolicy?: { paths: Array<{ path: StatePath; maxBytes: number }> };
	policy?: GraphPolicy;
}

export interface GraphSourceBody {
	entry: NodeId;
	nodes: Record<NodeId, NodeSource>;
}

export interface GraphPolicy {
	requireInteractive?: boolean;
}

export type NodeSource =
	| TemplateNodeSource
	| AgentNodeSource
	| CommandNodeSource
	| HumanNodeSource
	| SetNodeSource;

export interface NodeSourceCommon {
	output?: StatePath;
	writeMode?: WriteMode;
	storage?: "state" | "artifact";
	contract?: JsonObject;
	reads?: StatePath[];
	tools?: { allow: string[] };
	join?: JoinMode;
	limit?: number;
	onLimit?: Destination;
	retry?: { attempts?: number; backoffMs?: number; multiplier?: number };
	onError?: "fail" | "continue" | { route: Destination };
	timeoutMs?: number;
	next?: Destination | Destination[];
	on?: Record<string, Destination>;
	when?: Array<{ if: ConditionSource; to: Destination }>;
	default?: Destination;
}

export interface TemplateNodeSource extends NodeSourceCommon {
	template: string;
	args?: string;
	thinking?: string;
	sentinel?: { pattern: string; flags?: string; verdicts: Record<string, VerdictName> };
}

export interface AgentNodeSource extends NodeSourceCommon {
	agent: string;
	task?: string;
	thinking?: string;
	cwd?: string;
	worktree?: boolean;
	escalation?: "off" | "local";
}

export interface CommandNodeSource extends NodeSourceCommon {
	command: string[];
	cwd?: string;
	env?: Record<string, string>;
}

export interface HumanNodeSource extends NodeSourceCommon {
	human: string;
	kind: "confirm" | "choice" | "text";
	options?: Array<{ id: VerdictName; label: string }>;
}

export interface SetNodeSource extends NodeSourceCommon {
	set: StateOpSource[];
}

export interface StateOpSource {
	path: StatePath;
	op: "set" | "unset" | "increment";
	value?: JsonValue;
	by?: number;
}

export type ConditionSource =
	| { path: StatePath; op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte"; value: JsonValue }
	| { path: StatePath; op: "exists" | "truthy" }
	| { path: StatePath; op: "includes"; value: JsonPrimitive }
	| { path: StatePath; op: "matches"; pattern: string; flags?: string }
	| { all: ConditionSource[] }
	| { any: ConditionSource[] }
	| { not: ConditionSource };

export interface CompileInput {
	document: unknown;
	bodyBytes: number;
	origin: { scope: "user" | "project"; path: string; sha256: string };
	templates?: TemplateCatalog;
	agents?: AgentCatalog;
}

export interface TemplateCatalog {
	capturedAt: string;
	entries: Record<string, { deterministic: boolean; invocable: boolean }>;
}

export interface AgentCatalog {
	readonly entries: Readonly<Record<string, true>>;
}

export interface CompileResult {
	diagnostics: Diagnostic[];
	graph?: ExecutableGraph;
	report?: CompileReport;
}

export interface ExecutableGraph {
	schemaVersion: 1;
	name: GraphName;
	hash: string;
	mode: "session" | "orchestrated";
	entry: NodeId;
	nodes: Record<NodeId, CompiledNode>;
	limits: CompiledLimits;
	collapse: "off" | "on-back-edge";
	result: { paths: StatePath[]; includeState: boolean };
	statePolicy: { paths: Array<{ path: StatePath; maxBytes: number }> };
	policy: { requireInteractive: boolean };
}

export interface CompiledLimits {
	budget: number;
	maxConcurrency: number;
	graphTimeoutMs?: number;
	maxCostUsd?: number;
	maxStateBytes: number;
	maxPromptBytes?: number;
}

export interface CompiledNode {
	id: NodeId;
	kind: "template" | "agent" | "command" | "human" | "set";
	binding: AdapterBinding;
	output?: StatePath;
	writeMode: WriteMode;
	storage: "state" | "artifact";
	contract?: JsonObject;
	reads: StatePath[];
	tools?: { allow: string[] };
	join?: JoinMode;
	transitions: CompiledTransitions;
	verdicts: VerdictSet;
	limit?: { max: number; onLimit: Destination };
	retry: { attempts: number; backoffMs: number; multiplier: number };
	onError: { kind: "fail" } | { kind: "continue" } | { kind: "route"; to: Destination };
	timeoutMs: number | null;
}

export interface CompileReport {
	schemaVersion: 1;
	graphHash: string;
	source: { scope: "user" | "project"; path: string; bytes: number; sha256: string };
	description?: string;
	authoredForm: "long" | "shorthand";
	templatesCapturedAt?: string;
	derived: { exits: NodeId[]; inCycle: NodeId[]; reachable: NodeId[] };
	diagnostics: Diagnostic[];
}

export type AdapterBinding =
	| { kind: "template"; command: string; args?: Interpolated; thinking?: string; deterministic?: boolean; sentinel?: { pattern: string; flags?: string; verdicts: Record<string, VerdictName> } }
	| { kind: "agent"; agent: string; task?: Interpolated; thinking?: string; cwd?: Interpolated; worktree: boolean; escalation: "off" | "local" }
	| { kind: "command"; argv: Interpolated[]; cwd?: string; env?: Record<string, string> }
	| { kind: "human"; question: Interpolated; form: HumanForm }
	| { kind: "set"; ops: StateOpSource[] };

export type HumanForm =
	| { kind: "confirm" }
	| { kind: "choice"; options: Array<{ id: VerdictName; label: string }> }
	| { kind: "text" };

export type Interpolated = Array<{ literal: string } | { path: StatePath }>;

export interface CompiledTransitions {
	kind: "next" | "conditional";
	next?: Destination[];
	when: Array<{ condition: Condition; to: Destination }>;
	on: Record<VerdictName, Destination>;
	default?: Destination;
}

export type Condition =
	| { op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte"; path: StatePath; value: JsonValue }
	| { op: "exists" | "truthy"; path: StatePath }
	| { op: "includes"; path: StatePath; value: JsonPrimitive }
	| { op: "matches"; path: StatePath; pattern: string; flags: string }
	| { op: "all" | "any"; of: Condition[] }
	| { op: "not"; of: Condition };

export interface Diagnostic {
	code: string;
	severity: "error" | "warning";
	message: string;
	nodeId?: NodeId;
	path?: string;
	line?: number;
}

export type VerdictSet = { kind: "closed"; verdicts: VerdictName[] } | { kind: "open" };

export interface Activation {
	node: NodeId;
	visit: number;
}

/** The activation that created one static fan-out instance. */
export type FanOutIdentity = Activation;

export interface JoinToken {
	at: NodeId;
	from: Activation;
	/** The activation whose static fan-out scheduled this branch, when applicable. */
	fanOut?: FanOutIdentity;
	/** The edge that produced this arrival, retained for deterministic plans and replay. */
	via: EdgeReason;
}

export interface RoutingInput {
	graph: ExecutableGraph;
	state: JsonObject;
	results: NodeResult[];
	visits: Record<NodeId, number>;
	attemptsUsed: number;
	arrivals: JoinToken[];
}

export interface NodeResult {
	activation: Activation;
	/** Echoed from the schedule entry for a branch of a static fan-out. */
	fanOut?: FanOutIdentity;
	attempt: number;
	outcome: { kind: "verdict"; verdict: VerdictName } | { kind: "engine"; verdict: "error" | "aborted" | "timeout" };
	/**
	 * The adapter reported this failure as terminal, so the routing machine MUST
	 * NOT schedule a retry however many attempts the node declares. It still
	 * routes through `onError` like any other failure (§2.4, §11.5.4).
	 */
	terminal?: boolean;
}

export interface ScheduledActivation {
	node: NodeId;
	visit: number;
	via: EdgeReason;
	/** The activation that performed the fan-out which scheduled this branch. */
	fanOut?: FanOutIdentity;
}

export interface RetryEntry {
	activation: Activation;
	attempt: number;
	delayMs: number;
	/** Preserve branch identity when a fan-out branch is retried. */
	fanOut?: FanOutIdentity;
}

export interface StepPlan {
	schedule: ScheduledActivation[];
	retry: RetryEntry[];
	awaiting: Array<{ at: NodeId; have: number; need: number }>;
	consumed: JoinToken[];
	arrivals: JoinToken[];
	terminal?: { terminal: "done" | "fail"; via: EdgeReason };
	halt?: { code: RunFailureCode; detail: string };
}

export type EdgeReason =
	| { kind: "next" }
	| { kind: "on"; verdict: VerdictName }
	| { kind: "when"; index: number }
	| { kind: "default" }
	| { kind: "on-limit"; node: NodeId }
	| { kind: "on-error" };

export interface RunState {
	schemaVersion: 1;
	runId: RunId;
	graphHash: string;
	revision: number;
	updatedAt: string;
	data: JsonObject;
	bytes: number;
}

export interface ArtifactRef {
	uri: string;
	mediaType: string;
	bytes: number;
	sha256: string;
	preview: string;
}

export type NodeOutcomeStatus = "completed" | "failed" | "aborted" | "timeout";

export type VerdictSource = "contract" | "exit-code" | "delegate-status" | "effect" | "sentinel" | "engine" | "human" | "operator";

export interface NodeOutcome {
	status: NodeOutcomeStatus;
	output?: unknown;
	exitCode?: number;
	changed: boolean;
	text?: string;
	usage?: UsageDelta;
	artifacts?: ArtifactRef[];
	completionSignal: "reported" | "not-applicable";
	/** Agent nodes only. Set with status `aborted`: the run suspends into `waiting-escalation` rather than routing (§11.4.3, D-054). */
	escalation?: { requestId: string };
	/**
	 * Human nodes only. Set with status `aborted`: the run suspends into
	 * `waiting-human` rather than routing, and no `retry` attempt is consumed
	 * (§11.5, D-060). `refusal` is present when an answer arrived and was not in
	 * the fixed verdict namespace.
	 */
	awaitingHuman?: { question: string; refusal?: string };
	/**
	 * Human nodes only. The verdict an accepted answer resolved to, in the fixed
	 * namespace of §5.4. An adapter reports it rather than resolving routing: it
	 * is the only source of a human node's verdict, and the engine still decides
	 * what it means.
	 */
	humanVerdict?: VerdictName;
	/**
	 * Template nodes only. Set with status `aborted`: a peer the run depends on
	 * stopped responding, with no error and no timeout of its own, so the run
	 * suspends with `RUN-PEER-UNRESPONSIVE` rather than continuing (§11.2.2).
	 *
	 * This is the one case where a node-level fault MUST be escalated to the run.
	 * Retrying the node is pointless: the fault is in the session, and every node
	 * after it inherits the same session.
	 */
	peerUnresponsive?: { peer: string; detail: string };
	/**
	 * Template nodes only. The node reported a completion that the run could not
	 * corroborate, so it failed rather than passed (§11.2.1, D-051).
	 *
	 * Recorded separately from `status` because "failed having done nothing it
	 * can prove" and "failed having tried" route identically but read very
	 * differently, and a run of these is the signature of a session that has
	 * stopped working.
	 */
	uncorroborated?: boolean;
	/**
	 * This failure will not become a success by asking again with the same
	 * request, so `retry` MUST NOT schedule another attempt.
	 *
	 * The specification says "never retried into the same wall" in three places —
	 * a PTM refusal (§2.4), an unknown template, and a `human` node in a run with
	 * nobody present (§11.5.4) — and until Stage 3 nothing in the model could
	 * express it. The `human` case appeared to work only because that kind cannot
	 * declare `retry` at all, which is an accident of the compiler rather than
	 * the rule being enforced.
	 *
	 * It is a property of the FAILURE, not of the node: the same node retried
	 * happily when the template existed. That is why it is not a `retry` field,
	 * which is the shape D-053 removed.
	 */
	terminal?: boolean;
	diagnostics?: string[];
}

export interface UsageDelta {
	inputTokens: number;
	outputTokens: number;
	costUsd?: number;
}

export interface RunOptions {
	mode: "session" | "orchestrated";
	interactive: boolean;
	allowNonInteractive: boolean;
	allowNonInteractiveMutating: boolean;
	maxCostUsd?: number;
	runsRoot: string;
	/**
	 * What a resume does with an activation it cannot prove finished.
	 *
	 * `rerun` is the default and is what every run did before this option existed:
	 * the node runs again, and an effect it already had happens twice. `suspend`
	 * stops the run instead and leaves the decision to a person.
	 *
	 * Set at invocation rather than declared on a node. A node field would be an
	 * author promising at authoring time something only the world can settle, which
	 * is the shape D-053 removed; the operator launching a run is the one who knows
	 * whether anybody is watching it (D-065).
	 */
	onUncertainRecovery?: "rerun" | "suspend";
}

export type StateDelta =
	| { path: StatePath; op: "set"; value: JsonValue }
	| { path: StatePath; op: "unset" };

type JournalEnvelope = { schemaVersion: 1; seq: number; at: string; runId: RunId };

/**
 * The original schema-v1 human records omitted activation identity. Readers
 * keep accepting those exact legacy shapes under the bounded rules in D-071;
 * new writes use `JournalBody` below.
 */
type LegacyHumanRequestedBody = { type: "human-requested"; nodeId: NodeId; question: string };
type LegacyHumanAnsweredBody = { type: "human-answered"; nodeId: NodeId; verdict: VerdictName; value?: JsonValue };

export type JournalRecord = JournalEnvelope & (JournalBody | LegacyHumanRequestedBody | LegacyHumanAnsweredBody);

export type JournalBody =
	| { type: "run-started"; graphName: GraphName; graphHash: string; options: RunOptions; input: JsonObject }
	| { type: "node-started"; nodeId: NodeId; visit: number; attempt: number; adapter: AdapterBinding["kind"]; fanOut?: FanOutIdentity }
	// `diagnostics` is why the adapter said what it said. Without it a failed node
	// records only that it failed: the routing machine's halt detail is built in a
	// pure layer that never sees an adapter's reason, so a careful message like
	// "names agent X, which no definition declares" was computed and discarded, and
	// the operator got "ended with engine verdict error" and nowhere to look (#34).
	| { type: "node-finished"; nodeId: NodeId; visit: number; attempt: number; fanOut?: FanOutIdentity; status: NodeOutcomeStatus; changed: boolean; durationMs: number; usage?: UsageDelta; completionSignal: "reported" | "not-applicable"; diagnostics?: string[]; application?: { outcome: NodeResult["outcome"]; terminal?: boolean; source: VerdictSource; output?: JsonValue } }
	| { type: "node-applied"; nodeId: NodeId; visit: number; attempt: number; fanOut?: FanOutIdentity; scheduled: Array<ScheduledActivation & { attempt: number }> }
	| { type: "verdict-resolved"; nodeId: NodeId; visit: number; verdict: VerdictName; source: VerdictSource }
	| { type: "edge-fired"; from: NodeId; to: Destination[]; via: EdgeReason; fanOut?: FanOutIdentity }
	| { type: "join-arrived"; joinId: NodeId; from: Activation; fanOut?: FanOutIdentity; via: EdgeReason }
	| { type: "join-fired"; joinId: NodeId; consumed: Array<Activation & { fanOut?: FanOutIdentity }>; mode: JoinMode }
	| { type: "state-committed"; revision: number; bytes: number; delta: StateDelta[] }
	| { type: "run-paused"; reason: "operator-input" | "node-timeout" | "confirmation" }
	| { type: "run-resumed"; by: "operator" | "auto"; forced: boolean; value?: JsonValue }
	| { type: "run-suspended"; reason: "session-ended" | "session-replaced" | "operator" | "uncertain-recovery"; unproven?: UnprovenActivation[] }
	| { type: "recovery-decided"; nodeId: NodeId; visit: number; attempt: number; fanOut?: FanOutIdentity; action: "rerun" | "skip"; verdict?: VerdictName }
	| { type: "suspension-notified"; sessionId: string }
	| { type: "human-requested"; nodeId: NodeId; question: string; visit: number; attempt: number; fanOut?: FanOutIdentity }
	| { type: "human-answered"; nodeId: NodeId; verdict: VerdictName; visit: number; attempt: number; fanOut?: FanOutIdentity; value?: JsonValue }
	| { type: "artifact-written"; nodeId: NodeId; path: StatePath; ref: ArtifactRef }
	/**
	 * The process group a `command` node started, recorded while it is running so
	 * a resume after a kill can reap a survivor rather than overlap it (#16,
	 * D-062). `startTicks` is the kernel's start time for that process; without
	 * it the id cannot be told apart from one the operating system reused, and a
	 * resume MUST NOT signal it.
	 */
	| { type: "node-recovered"; nodeId: NodeId; visit: number; attempt: number; fanOut?: FanOutIdentity; evidence: "contract-result" }
	| { type: "process-spawned"; nodeId: NodeId; visit: number; attempt: number; fanOut?: FanOutIdentity; pid: number; startTicks?: number }
	/** What a resume did about a recorded process it found. */
	| { type: "process-reaped"; nodeId: NodeId; pid: number; outcome: "reaped" | "gone" | "recycled" | "unproven"; detail?: string }
	| { type: "escalation-raised"; nodeId: NodeId; requestId: string }
	| { type: "escalation-resolved"; nodeId: NodeId; requestId: string; by: "operator" | "root-agent" }
	| { type: "compaction"; phase: "observed" | "requested" | "completed"; requestId?: string; band?: "OK" | "WARN" | "URGENT" | "UNKNOWN" }
	| { type: "anchor-set"; anchorId: string }
	| { type: "operator-move"; action: "goto" | "stop" | "skip"; to?: NodeId }
	| { type: "guard-refusal"; nodeId: NodeId; tool: string }
	| { type: "run-finished"; status: "completed" | "failed" | "cancelled"; code?: RunFailureCode; result: JsonObject };

export type RunStatus =
	| "running" | "paused" | "suspended" | "waiting-human" | "waiting-escalation"
	| "waiting-recovery"
	| "completed" | "failed" | "cancelled";

/**
 * An activation a resume could not prove finished, and what a person needs to
 * know to decide about it.
 *
 * `kind` is here because it is the whole reason the activation is unprovable: an
 * `agent` node would have left a contract result, and this one could not (D-063).
 */
export interface UnprovenActivation {
	nodeId: NodeId;
	visit: number;
	attempt: number;
	/** Distinguishes otherwise equal activations carried by separate static fan-outs. */
	fanOut?: FanOutIdentity;
	kind: AdapterBinding["kind"];
	/** What the node writes, so a person can look at it before deciding. */
	output?: StatePath;
}

export type RunFailureCode =
	| "RUN-BUDGET-EXCEEDED" | "RUN-LIMIT-UNRESOLVABLE" | "RUN-COST-CEILING"
	| "RUN-STATE-BYTES" | "RUN-GRAPH-TIMEOUT" | "RUN-NODE-FAILED"
	| "RUN-CANCELLED" | "RUN-CONFIRMATION-REQUIRED"
	| "RUN-COMPLETION-SIGNAL-UNAVAILABLE" | "RUN-TOOL-POLICY-UNENFORCEABLE"
	| "RUN-GRAPH-HASH-MISMATCH" | "RUN-JOURNAL-WRITE-FAILED"
	| "RUN-PEER-UNRESPONSIVE" | "RUN-ALREADY-OWNED";

export interface GraphRunEventBase {
	protocolVersion: 1;
	runId: RunId;
	graphName: GraphName;
}

export type GraphRunEvent = GraphRunEventBase & { type: string };

export interface GraphRunSnapshot {
	protocolVersion: 1;
	runs: Array<{ runId: RunId; graphName: GraphName; status: RunStatus; currentNode?: NodeId; visitsUsed: number; budget: number; costUsd?: number }>;
}
