/**
 * Recursion depth guard for delegate.
 *
 * Tracks how many delegate calls deep we are using `AsyncLocalStorage`, so
 * a worker that recursively invokes `delegate` can't loop unbounded.
 *
 * Semantics (mirrors §2.6 of docs/subagent-parity-plan.md):
 *   - Default cap is `DEFAULT_MAX_DEPTH` (currently `3`).
 *   - At a fresh root, an explicit per-agent max can raise that conservative
 *     default up to `HARD_MAX_DEPTH` (currently `16`).
 *   - Once a root frame exists, descendants may tighten but never relax its
 *     inherited cap.
 *   - Exceeding the cap throws a `DepthGuardError` synchronously from
 *     `runWithDepth`, BEFORE the inner work starts.
 *
 * The guard is enforced in-process per call site via `runWithDepth`. The
 * fork-runner / direct-runner wrap their entry points in `runWithDepth`;
 * any worker that calls back into `delegate` re-enters the guard
 * automatically through AsyncLocalStorage propagation.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { logDelegateDiagnostic } from "./diagnostics.js";
import { deserializeLineage, mintCapToken, serializeLineage } from "./lineage.js";

/** Conservative fallback used when a fresh root has no explicit depth policy. */
// Three levels cover the ordinary orchestrator → implementer → reviewer
// pattern. Deeper recursion still requires an explicit root policy.
export const DEFAULT_MAX_DEPTH = 3;

/**
 * Absolute recursion ceiling, even for an explicit `maxSubagentDepth`.
 *
 * This is deliberately much higher than the conservative default: deliberate
 * orchestrator pipelines can legitimately need 3–5 levels, while 16 still
 * bounds accidental or adversarial recursive delegation.
 */
export const HARD_MAX_DEPTH = 16;

/**
 * Validate a configured depth policy before it participates in cap math.
 * Runtime configuration and internal callers are not guaranteed to pass
 * through the TypeBox tool schema, so this check is the authoritative defense
 * against `NaN` (which would make every `attemptedDepth > effectiveMax` check
 * false) and other malformed numeric values.
 */
export function validateMaxSubagentDepth(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new TypeError(
			`delegate: maxSubagentDepth must be a non-negative safe integer; received ${String(value)}.`,
		);
	}
	return value;
}

/**
 * The unified lineage frame. This single type is BOTH the in-process
 * AsyncLocalStorage frame AND the shape that serializes to / deserializes
 * from the environment (see `src/lineage.ts`). There is no parallel
 * "ALS-only" struct — the env-serialized form is the authoritative
 * boundary-crossing source of truth, and within a process the same frame
 * flows via `AsyncLocalStorage`.
 */
export interface DepthFrame {
	/** Current depth (number of nested `runWithDepth` invocations). 0 = top level. */
	depth: number;
	/**
	 * Agent-name chain for diagnostics. NOTE (issue #11): despite the name
	 * this is the delegation LINEAGE PATH (root → … → this frame's agent),
	 * one entry per nesting level — it has nothing to do with the sequential
	 * `chain: [...]` pipeline mode of the delegate tool. Kept as `chain` for
	 * wire/persistence compatibility (serialized lineage frames embed it).
	 */
	chain: string[];
	/**
	 * Authorized cap carried by this frame. Ordinary descendants can only
	 * tighten it; detached orchestrate owns a separately modeled minimum-3
	 * re-root boundary.
	 */
	effectiveMax: number;
	/** This node's run-id within the delegation tree. */
	runId: string;
	/** The outermost (root) run-id — anchors the whole tree. */
	rootRunId: string;
	/** This node's ordinal among its siblings under a common parent. */
	childIndex: number;
	/**
	 * The accumulated root→self ANCESTOR id-path: one `${runId}#${childIndex}`
	 * segment per level of the delegation tree, in order. Built additively in
	 * `runWithDepth` (each frame appends its own segment to the parent's
	 * idPath), so an ancestor's idPath is always a strict PREFIX of any
	 * descendant's. The event bus (spec 0004) uses this for TRUE ancestry
	 * discrimination via `lineageAncestorPath` — a depth comparison alone
	 * wrongly treats a same-root COUSIN at greater depth as a descendant.
	 *
	 * OPTIONAL because it is an in-process ALS accumulation only: it is NOT
	 * serialized into the env (it would otherwise have to enter the cap-token
	 * MAC payload, which the spec-0003 integrity model owns) and so a frame
	 * reconstructed across a process boundary via `deserializeLineage` carries
	 * no idPath. Consumers fall back to the leaf-only `lineagePath` then
	 * (suppress-only safe — see `lineageAncestorPath`).
	 */
	idPath?: string[];
	/**
	 * Issue #9 — set by `deserializeLineage` when the presented env frame's
	 * MAC did not verify under THIS process's rootSecret. The frame is
	 * already fail-closed (depth/cap clamped); this flag only drives a
	 * diagnostics warning in `runWithDepth`. Never serialized.
	 */
	tampered?: boolean;
	/**
	 * Per-tree capability nonce. Minted once at the root frame and propagated
	 * unchanged down the tree. A child that cannot present a valid token (a
	 * tampered/partial env) is denied any depth headroom — see
	 * `deserializeLineage`'s fail-closed contract (REQ-LIN-4).
	 */
	capToken: string;
}

/** Optional lineage identity for a new frame (run-ids / sibling ordinal). */
export interface LineageIdentity {
	/** This node's run-id. Defaults to the agent name when omitted. */
	runId?: string;
	/** Ordinal among siblings (0 when unspecified). */
	childIndex?: number;
}

/** Explicit context owned by the caller of the generic depth guard. */
export interface DepthGuardOptions {
	/** Destination for diagnostics emitted while checking this invocation. */
	agentDir?: string;
}

const storage = new AsyncLocalStorage<DepthFrame>();

/**
 * Capture the caller's complete async context and return a runner that restores
 * it around later work. Completion/failure wakes use this at dispatch time so
 * a callback fired by a child runs in the recipient's lineage, not the child's
 * (runbook field note: failure-wake ALS contamination). `snapshot()`
 * preserves a legitimate nested-originator frame; unlike `exit()`, it does not
 * flatten every recipient to depth zero.
 */
export function captureCurrentAsyncContext(): <T>(fn: () => T) => T {
	const snapshot = AsyncLocalStorage.snapshot();
	return <T>(fn: () => T): T => snapshot(fn);
}

export class DepthGuardError extends Error {
	readonly code = "PI_DELEGATE_DEPTH_EXCEEDED" as const;
	readonly attemptedDepth: number;
	readonly maxAllowed: number;
	readonly chain: string[];
	constructor(attempted: number, max: number, chain: string[]) {
		super(
			`delegate: maximum subagent depth ${max} exceeded (attempted depth ${attempted}; chain: ${chain.join(" → ")}). ` +
				"Set a higher `maxSubagentDepth` on the root agent or root driver run " +
				`(cannot exceed an inherited parent cap or the hard ceiling ${HARD_MAX_DEPTH}), ` +
				"or restructure to avoid recursive delegation.",
		);
		this.name = "DepthGuardError";
		this.attemptedDepth = attempted;
		this.maxAllowed = max;
		this.chain = chain;
	}
}

/**
 * Read the current depth. Inside a `runWithDepth` frame this is the live
 * in-process depth. OUTSIDE any frame (e.g. at session_start of a process
 * spawned across a boundary) it falls back to the inherited lineage env so
 * a freshly-started process reports its TRUE inherited depth rather than 0
 * (REQ-LIN-2). A genuine top-level process with no inherited lineage still
 * reports 0.
 */
export function currentDepth(): number {
	const frame = storage.getStore() ?? deserializeLineage(process.env);
	return frame?.depth ?? 0;
}

/**
 * Read the current agent-name chain. Like `currentDepth`, falls back to the
 * inherited lineage env outside any in-process frame so a cross-boundary
 * process reports its TRUE inherited chain rather than an empty one
 * (REQ-LIN-2).
 */
export function currentChain(): string[] {
	const frame = storage.getStore() ?? deserializeLineage(process.env);
	return frame?.chain ?? [];
}

/**
 * Run `fn` inside a depth frame. Increments the depth, appends `agentName`
 * to the chain, computes the effective cap (`min(parentCap, requestedMax)`),
 * and throws a `DepthGuardError` synchronously if the new depth exceeds the
 * effective cap. A fresh root's explicit max may raise the conservative
 * `defaultMax`, but never above `HARD_MAX_DEPTH`.
 *
 * `agentMax` is the per-agent override (frontmatter `maxSubagentDepth`);
 * `defaultMax` is only consulted at the outermost frame and falls back to
 * `DEFAULT_MAX_DEPTH`. Tests pass an explicit `defaultMax` to flip
 * semantics quickly.
 *
 * ## Outermost-frame seeding (REQ-LIN-2 / REQ-LIN-3)
 *
 * When there is NO in-process ALS parent, the frame is no longer assumed to
 * be a depth-0 root. Instead we attempt to recover an inherited frame from
 * `process.env` via `deserializeLineage`: a process spawned across a
 * boundary (a detached `orchestrate` child, or a `pi -c` session launched by
 * a parent delegate) thereby recovers its TRUE inherited depth + chain
 * rather than restarting at 0. When the env carries no lineage, the
 * outermost frame is a freshly-minted root (depth 1, new cap-token,
 * `rootRunId === runId`) — identical to the historical top-level behavior.
 *
 * The cap algorithm is: at a fresh root, use the explicit agent max when
 * present (otherwise `defaultMax`) and clamp it to `HARD_MAX_DEPTH`; below a
 * root, `effectiveMax = min(parentMax, requestedMax, HARD_MAX_DEPTH)` so the
 * inherited cap can only tighten. A synchronous `DepthGuardError` is checked
 * BEFORE `fn` runs so a depth-violating call never spawns a session.
 */
export function runWithDepth<T>(
	agentName: string,
	agentMax: number | undefined,
	fn: () => Promise<T>,
	defaultMax: number = DEFAULT_MAX_DEPTH,
	identity?: LineageIdentity,
	options?: DepthGuardOptions,
): Promise<T> {
	// At the outermost frame (no ALS parent) seed from inherited env so a
	// cross-boundary process recovers its true depth; in-process recursion
	// keeps flowing through the ALS parent.
	const parent = storage.getStore() ?? deserializeLineage(process.env);
	// Issue #9 — a non-verifying env frame previously clamped in complete
	// silence; bypass probes were invisible. The clamping (fail-closed
	// authority) is unchanged — this is observability only, throttled so a
	// busy tampered tree logs once a minute, not once per call.
	if (parent?.tampered) {
		logDelegateDiagnostic(
			`lineage env frame did not verify under this process's root secret ` +
				`(rootRunId=${parent.rootRunId || "?"}, claimed depth=${parent.depth}); ` +
				`fail-closed clamping applied (zero depth headroom). Expected for a process ` +
				`spawned WITHOUT re-anchoring; a forged/tampered frame looks identical.`,
			{
				level: "warn",
				throttleKey: "lineage-tamper",
				...(options?.agentDir ? { agentDir: options.agentDir } : {}),
			},
		);
	}
	const parentDepth = parent?.depth ?? 0;
	const inheritedMax = parent
		? validateMaxSubagentDepth(parent.effectiveMax)
		: HARD_MAX_DEPTH;
	const requestedMax = validateMaxSubagentDepth(
		agentMax ?? parent?.effectiveMax ?? defaultMax,
	);
	// The default is a conservative fallback, not a hard ceiling. An explicit
	// max may raise it only when minting a fresh root. Once lineage exists, the
	// inherited cap remains authoritative and descendants can only tighten it.
	const effectiveMax = parent
		? Math.min(inheritedMax, requestedMax, HARD_MAX_DEPTH)
		: Math.min(requestedMax, HARD_MAX_DEPTH);
	const attemptedDepth = parentDepth + 1;
	const chain = parent ? [...parent.chain, agentName] : [agentName];
	if (attemptedDepth > effectiveMax) {
		throw new DepthGuardError(attemptedDepth, effectiveMax, chain);
	}
	// Lineage identity: a new frame keeps the inherited tree's rootRunId +
	// capToken (propagated unchanged); a fresh root mints both.
	const runId = identity?.runId ?? agentName;
	const rootRunId = parent?.rootRunId ?? runId;
	const capToken = parent?.capToken ?? mintCapToken();
	const childIndex = identity?.childIndex ?? 0;
	// Accumulate the root→self id-path: append THIS node's segment to the
	// parent's idPath (or the parent's leaf segment when the parent predates
	// the field), so an ancestor's idPath stays a strict prefix of every
	// descendant's (spec 0004 ancestry discrimination).
	const parentIdPath =
		parent?.idPath ??
		(parent ? [`${parent.runId}#${parent.childIndex}`] : []);
	const idPath = [...parentIdPath, `${runId}#${childIndex}`];
	const frame: DepthFrame = {
		depth: attemptedDepth,
		chain,
		effectiveMax,
		runId,
		rootRunId,
		childIndex,
		idPath,
		capToken,
	};
	return storage.run(frame, fn);
}

/**
 * Read the CURRENT live lineage frame straight from `AsyncLocalStorage`,
 * WITH its in-process-only fields (notably `idPath`) intact.
 *
 * This is the in-process counterpart to `currentLineageEnv()`. The env path
 * deliberately DROPS `idPath` (it must not enter the cap-token MAC payload —
 * spec 0003's integrity model owns the env shape), so a frame round-tripped
 * through `deserializeLineage(currentLineageEnv())` always reads back with
 * `idPath === undefined` and `lineageAncestorPath` falls back to the
 * leaf-only `lineagePath`. The event bus (spec 0004 / REQ-BUS-2) needs the
 * TRUE root→self id-path for ancestry discrimination, so its same-process
 * emit/probe path reads the live frame HERE rather than via the env
 * round-trip.
 *
 * Returns `undefined` when there is no active frame (a genuine top-level
 * caller outside any `runWithDepth`) — bus emits then no-op (best-effort,
 * REQ-BUS-4). NOTE: this reads ONLY the in-process ALS store; it does NOT
 * fall back to the inherited env, because a cross-process frame has no
 * `idPath` to recover (the leaf-only fallback in `lineageAncestorPath` is
 * the correct, suppress-only-safe behavior there).
 */
export function currentLineageFrame(): DepthFrame | undefined {
	return storage.getStore();
}

/**
 * Serialize the CURRENT lineage frame into namespaced env vars for injection
 * into a child process's environment. This is the run-construction seam:
 * callers spreading the result over a child env
 * (`{ ...process.env, ...currentLineageEnv() }`) hand the child everything it
 * needs to recover its true depth + lineage on start.
 *
 * Returns `undefined` when there is no active frame (no work to propagate).
 * NOTE: this spec wires + unit-tests the seam; it does NOT spawn a detached
 * child — that arrives with the `orchestrate` shape (spec 0005), which calls
 * this helper to populate the child env.
 */
export function currentLineageEnv(): Record<string, string> | undefined {
	const frame = storage.getStore();
	return frame ? serializeLineage(frame) : undefined;
}

/** Safe diagnostic view: lineage variable names only, never capability values. */
export function currentLineageEnvKeyNames(): string[] {
	return Object.keys(currentLineageEnv() ?? {}).sort();
}

/**
 * Test-only escape hatch: clear any in-flight async-local store. Production
 * code never needs this — tests use it to ensure depth state from one test
 * doesn't bleed into the next.
 */
export function __clearDepthForTests(): void {
	// AsyncLocalStorage doesn't expose a public reset for the *current* store;
	// production code propagates frames through `storage.run`, so leaving the
	// outer scope automatically pops the frame. This helper just signals
	// intent — there's no actual state to wipe at module level.
}
