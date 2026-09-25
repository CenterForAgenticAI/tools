import type { WorkerArtifactReference } from "./artifact-workspace.js";
import { validateHandoff } from "./handoff-validation.js";
import { RUNTIME_RUN_KEY_BY_CANONICAL } from "./delegate-normalize.js";

/** A decoded JSON object. Delegate arguments are provider-supplied JSON. */
type JsonObject = Record<string, unknown>;

/**
 * Thrown by `validateRuns` for a dispatch that is well-formed but names an
 * unsupported combination of options. It carries a stable `kind` so a caller
 * such as the runtime-api client can map it to a precise error code without
 * parsing the message, while the tool path surfaces the message directly.
 */
export class UnsupportedRunOptionError extends Error {
	constructor(
		readonly kind: "worktree-reads",
		message: string,
	) {
		super(message);
		this.name = "UnsupportedRunOptionError";
	}
}

export type RunMode = "solo" | "supervised" | "driver";
/**
 * How a supervised slot's task reaches its worker. `direct-first-turn` (the
 * default) has the runtime deliver the caller's exact task to the worker first,
 * then seeds the supervisor with that completed exchange. `supervisor-mediated`
 * is the explicit compatibility mode in which the supervisor composes the first
 * `message_subagent` turn.
 */
export type TaskDeliveryMode = "supervisor-mediated" | "direct-first-turn";
export const DEFAULT_TASK_DELIVERY_MODE: TaskDeliveryMode = "direct-first-turn";
export interface CanonicalRun {
	name?: string;
	agent: string;
	task?: string;
	mode?: RunMode;
	after?: string[] | "previous";
	count?: number;
	rounds?: number;
	clone_mode?: "full" | "snippet" | "task_only";
	/** Supervised-only first-turn delivery mode; omission uses the direct-first-turn default. */
	task_delivery?: TaskDeliveryMode;
	depth?: number;
	model?: string;
	cwd?: string;
	env?: Record<string, string | null>;
	skills?: string | string[] | false;
	thinking?: string | false;
	artifact?: string | false;
	reads?: Array<string | WorkerArtifactReference> | false;
	parentTranscriptSearch?: boolean;
	progress?: boolean;
	interactive?: boolean;
	worktree?: boolean;
	escalation?: unknown;
	handoff?: Record<string, unknown>;
	[k: string]: unknown;
}
export interface CanonicalDispatch {
	runs: CanonicalRun[];
	task?: string;
	cwd?: string;
	model?: string;
	thinking?: string | false;
	skills?: string | string[] | false;
	env?: Record<string, string | null>;
	chainDir?: string;
	concurrency?: number;
	failFast?: boolean;
	worktree?: boolean;
	[k: string]: unknown;
}

const MATRIX_BASES: Record<string, string> = {
	after_supervised: "`after` requires mode solo; supervised entries have no completion-ordering runner",
	after_driver: "after is not valid on a driver entry",
	count_supervised: "`count` fan-out exists only for solo entries",
	count_driver: "count is not valid on a driver entry",
	rounds_solo: "`rounds` configures supervision; this entry is solo",
	rounds_driver: "rounds is not valid on a driver entry",
	// `clone_mode` on a solo entry is accepted and dropped at compile time (#286),
	// so there is no solo rejection base to keep here.
	clone_mode_driver: "`clone_mode` is not valid on a driver entry",
	parentTranscriptSearch_driver: "parentTranscriptSearch is not valid on a driver entry",
	stream_supervised: "the supervisor controls the message stream; use handoff or the task text",
	escalation_driver: "driver escalation is governed by the driver's own dispatches",
};
const DIRECT_STREAM_FIELDS = ["artifact", "reads"] as const;
export const SUPERVISED_PROGRESS_WARNING = "warning [progress]: `progress` is ignored for supervised runs; the supervisor controls the message stream";
const LAYER_DOCTRINE = "not expressible as layers in v1; name the whole preceding layer";
const DRIVER_DOCTRINE = "exactly one driver entry per dispatch; split into separate calls";

export function hasSupervisedProgress(input: JsonObject): boolean {
	if (!Array.isArray(input.runs)) return false;
	return input.runs.some((run) => {
		if (!run || typeof run !== "object") return false;
		const entry = run as JsonObject;
		return (entry.mode ?? "solo") === "supervised" && Object.prototype.hasOwnProperty.call(entry, "progress");
	});
}

export function rejection(base: string, kind: "A" | "B" | "C", issue?: number, doctrine?: string): Error {
	if (kind === "A") return new Error(`${base} — not supported yet${issue ? ` (tracked in #${issue})` : ""}`);
	if (kind === "B") return new Error(`${base} — not a meaningful configuration`);
	return new Error(`${base} — ${doctrine ?? LAYER_DOCTRINE}`);
}

/** Validate canonical runs and compile them to the legacy runner shapes. */
export function compileDelegateRuns(input: JsonObject): JsonObject {
	if (!Array.isArray(input.runs)) return input;
	// Management wins over dispatch, exactly as the legacy `detectShape()` router
	// decides it. Compiling an accompanying runs[] would drop `action`/`config`
	// and silently turn "create this agent" into "dispatch a worker".
	if (input.action !== undefined) return input;
	const params: CanonicalDispatch = input as CanonicalDispatch;
	// Fail closed on handoff BEFORE merging (#266): an unknown namespace or a
	// contract violation must reject the dispatch rather than be dropped or
	// forwarded verbatim. Checked on the caller's own spellings so the error
	// names the field they wrote, not a merged intermediate.
	validateHandoff(params.handoff, "handoff");
	params.runs.forEach((run, index) => {
		validateHandoff((run as JsonObject).handoff, `runs[${index}].handoff`);
	});
	const runs = params.runs.map((run, index) => mergeDefaults(params, { ...run, mode: run.mode ?? "solo", name: run.name ?? `${run.agent ?? "run"}${index + 1}` }));
	validateRuns(params, runs);
	const common = copyCommon(params);
	const modes = new Set(runs.map((run) => run.mode));
	if (modes.has("driver")) {
		const driver = runs[0];
		const task = driver.task ?? params.task ?? "";
		return { ...common, orchestrate: { ...toLegacySlot(driver), agent: driver.agent, task: driverTask(task, driver.handoff) } };
	}
	// A uniform per-entry worktree compiles to the batch flag, which is the only
	// spelling the runners read. Left on the slot it is silently inert, so the
	// workers would run in the ordinary checkout.
	const worktree = params.worktree ?? (runs.every((run) => run.worktree === true) ? true : undefined);
	if (worktree !== undefined) common.worktree = worktree;

	if (modes.has("supervised")) {
		// The shared top-level task is materialized per slot: the supervised
		// runner reads each slot's own task and never falls back.
		return { ...common, agents: runs.map((run) => ({ ...toLegacySlot(run), task: run.task ?? params.task ?? "" })) };
	}
	// A group-local control is only honoured by the chain runner, so any dispatch
	// carrying one must compile to a chain even when no entry is `after`-gated.
	// A lone controlled parallel group otherwise compiled to `tasks`, where
	// fail-fast is never read and the internal carriers leaked into the output.
	const carriesGroupControls = runs.some((run) => {
		const slot = run as JsonObject;
		return slot.group_concurrency !== undefined || slot.group_failFast !== undefined;
	});
	if (runs.some((run) => run.after !== undefined) || carriesGroupControls) {
		// Dispatch-level values apply to every layer; group-local values win for
		// their own group and are never promoted into a default for the others.
		const groupOptions: JsonObject = {};
		for (const key of ["concurrency", "failFast"] as const) {
			if (params[key] !== undefined) {
				groupOptions[key] = params[key];
				delete common[key];
			}
		}
		return { ...common, chain: compileLayers(runs, params.task, groupOptions) };
	}
	if (runs.length === 1) {
		const run = runs[0];
		// Preserve the requested name: receipts and control verbs use this
		// legacy entry-addressing key, and the single-direct runtime otherwise
		// falls back to the agent name.
		return { ...common, agent: run.agent, task: run.task ?? params.task ?? "", ...toLegacySlot(run, ["agent", "task"]), name: run.name };
	}
	return { ...common, tasks: runs.map((run) => ({ ...toLegacySlot(run), agent: run.agent, task: run.task ?? params.task ?? "" })) };
}

export function validateRuns(params: JsonObject, suppliedRuns = params.runs): void {
	if (!Array.isArray(suppliedRuns) || suppliedRuns.length === 0) throw new Error("runs must contain at least one entry");
	const runs = suppliedRuns as CanonicalRun[];
	const modes = runs.map((run) => run.mode ?? "solo");
	const drivers = modes.filter((mode) => mode === "driver").length;
	if (drivers > 1 || (drivers === 1 && runs.length !== 1)) throw rejection("run modes are not homogeneous", "C", undefined, DRIVER_DOCTRINE);
	if (drivers === 1 && params.readOnly !== undefined) throw rejection("readOnly is not valid on a driver dispatch", "B");
	if (drivers === 0 && new Set(modes).size > 1) throw rejection("mixed run modes are not dispatchable in one call in v1; split the dispatch", "A", 268);
	const names = new Set<string>();
	for (const [index, run] of runs.entries()) {
		const mode = run.mode ?? "solo";
		if (typeof run.agent !== "string" || run.agent.length === 0) throw new Error(`runs[${index}].agent is required`);
		const name = run.name ?? `${run.agent}${index + 1}`;
		if (names.has(name)) throw new Error(`duplicate run name '${name}'`);
		names.add(name);
		validateModeFields(run, mode);
		if (run.worktree === true && run.cwd !== undefined) throw new Error(`runs[${index}].cwd conflicts with worktree`);
		validateTemplates(run, index);
		// An after-gated entry defaults to "{previous}" (applied by
		// validateTemplates). Any other entry needs a task from somewhere, or it
		// would dispatch a worker with nothing to do.
		if (run.after === undefined && run.task === undefined && typeof params.task !== "string") {
			throw new Error(`runs[${index}].task is required unless the dispatch supplies a shared task`);
		}
	}
	// Compare EFFECTIVE values, treating an unspecified entry as false. Filtering
	// undefined out first made [true, undefined] look uniform, so the true flag
	// landed on an inert slot and a request for isolated work would have run in
	// the ordinary checkout.
	const worktrees = runs.map((run) => (run.worktree ?? params.worktree ?? false) === true);
	if (new Set(worktrees).size > 1) {
		throw new Error("worktree must be uniform across a dispatch: set it on every entry or none");
	}
	validateTopology(runs);
	if (runs.some((run) => run.after !== undefined) && (params.worktree === true || runs.some((run) => run.worktree === true))) {
		throw rejection("worktree-backed after chains cannot continue a predecessor's tree", "A", 271);
	}
	// A worktree is created off HEAD and carries only committed/tracked files, so
	// pre-dispatch code cannot attest the bytes any `reads` entry would resolve
	// inside the isolated tree — an untracked or gitignored input silently goes
	// missing and the worker fails late in artifact harvest. This is a blanket
	// reject: even an absolute path or a typed artifact reference is refused,
	// because the whole combination is unsupported, so the message names the
	// remedies that actually work. Thrown as a tagged error so the runtime-api
	// client maps it to `unsupported-option` at the same pipeline position its
	// own check used, keeping error-code precedence unchanged.
	if (params.worktree === true || runs.some((run) => run.worktree === true)) {
		const readsIndex = runs.findIndex((run) => Array.isArray(run.reads) && run.reads.length > 0);
		if (readsIndex >= 0) {
			throw new UnsupportedRunOptionError(
				"worktree-reads",
				`runs[${readsIndex}].reads is not supported with worktree: true: an isolated worktree carries only committed files, so its bytes cannot be attested before dispatch — copy the input into the worktree with a worktreeSetupHook, or drop worktree isolation for this worker`,
			);
		}
	}
}

function validateModeFields(run: CanonicalRun, mode: RunMode): void {
	if (mode !== "solo" && run.after !== undefined) {
		if (mode === "supervised") throw rejection(MATRIX_BASES.after_supervised, "A", 268);
		throw rejection(MATRIX_BASES.after_driver, "B");
	}
	if (mode !== "solo" && run.count !== undefined) {
		if (mode === "supervised") throw rejection(MATRIX_BASES.count_supervised, "A");
		throw rejection(MATRIX_BASES.count_driver, "B");
	}
	if (mode === "solo" && run.rounds !== undefined) throw rejection(MATRIX_BASES.rounds_solo, "B");
	if (mode === "driver" && run.rounds !== undefined) throw rejection(MATRIX_BASES.rounds_driver, "B");
	// #286: a solo entry has no supervisor history to seed, so `clone_mode` is
	// inert rather than contradictory — and the tool's own promptGuidelines
	// recommend it without naming a mode, so rejecting it made the advertised
	// surface lie. Accepted and dropped at compile time (see `toLegacySlot`).
	// A driver run entry still refuses it: a driver dispatches its own runs/work,
	// so a seeding mode named there would silently govern nothing.
	if (mode === "driver" && run.clone_mode !== undefined) {
		throw rejection(MATRIX_BASES.clone_mode_driver, "B");
	}
	// #452: direct-first-turn delivery drives a supervisor clone, so the field
	// is meaningful only where a supervisor exists. A solo/driver entry has no
	// supervisor to seed, so naming it there is rejected rather than ignored.
	if (mode !== "supervised" && run.task_delivery !== undefined) {
		throw rejection("task_delivery is valid only on supervised entries", "B");
	}
	if (mode === "driver" && run.parentTranscriptSearch !== undefined) {
		throw rejection(MATRIX_BASES.parentTranscriptSearch_driver, "B");
	}
	if (mode === "supervised" && DIRECT_STREAM_FIELDS.some((key) => run[key] !== undefined)) {
		throw rejection(MATRIX_BASES.stream_supervised, "A", 269);
	}
	if (mode === "driver" && run.progress !== undefined) throw rejection("progress is not valid on a driver entry", "B");
	if (mode === "driver" && run.interactive !== undefined) throw rejection("interactive is not valid on a driver entry", "B");
	if (mode === "driver" && run.escalation !== undefined) throw rejection(MATRIX_BASES.escalation_driver, "A", 270);
	if (mode === "driver" && run.worktree !== undefined) throw rejection("worktree is not valid on a driver entry", "A");
	if (mode === "driver" && run.cwd !== undefined) throw rejection("cwd is not valid on a driver entry", "A");
	if (mode === "driver" && run.readOnly !== undefined) throw rejection("readOnly is not valid on a driver entry", "B");
	if (mode === "driver" && run.retryOf !== undefined) throw rejection("retryOf is not valid on a driver entry", "B");
	for (const key of DIRECT_STREAM_FIELDS) {
		if (mode === "driver" && run[key] !== undefined) throw rejection(`${key} is not valid on a driver entry`, "B");
	}
	// #287: solo and supervised entries both carry a real wall-clock budget.
	// Solo enforcement lives in the direct dispatch path (steer, then grace,
	// then abort via the per-task controller); supervised keeps reading it from
	// `buildSlotOverride`. A driver entry still refuses both: it is a detached
	// child process that owns its own budget, so a limit named here would
	// validate and then govern nothing.
	for (const key of ["max_duration_ms", "wind_down_grace_ms"] as const) {
		if (mode === "driver" && (run as JsonObject)[key] !== undefined) {
			throw rejection(`\`${key}\` is governed by the driver's own dispatches; this entry is a driver`, "A", 270);
		}
	}
}

function validateTopology(runs: CanonicalRun[]): void {
	const names = runs.map((run, i) => run.name ?? `${run.agent}${i + 1}`);
	const index = new Map(names.map((name, i) => [name, i]));
	const layers: string[][] = [];
	let cursor = 0;
	while (cursor < runs.length && runs[cursor].after === undefined) {
		if (!layers[0]) layers[0] = [];
		layers[0].push(names[cursor++]);
	}
	if (!layers[0]?.length) throw new Error("the first run layer cannot be after-gated");
	while (cursor < runs.length) {
		const first = runs[cursor];
		const requested = first.after === "previous" ? layers[layers.length - 1] : first.after;
		if (!Array.isArray(requested) || requested.length === 0) throw new Error(`runs[${cursor}].after must name the preceding layer`);
		if (requested.some((name) => !index.has(name))) throw new Error(`runs[${cursor}].after references an unknown or forward run`);
		if (requested.includes(names[cursor])) throw new Error(`runs[${cursor}].after cannot reference itself`);
		const expected = layers[layers.length - 1].slice().sort();
		if (requested.slice().sort().join("\0") !== expected.join("\0")) throw rejection("after names a subset or non-preceding layer", "C", undefined, LAYER_DOCTRINE);
		const layer: string[] = [];
		while (cursor < runs.length) {
			const run = runs[cursor];
			if (run.after === undefined) throw rejection("ungated runs cannot follow a gated layer", "C", undefined, LAYER_DOCTRINE);
			const parent = run.after === "previous" ? layers[layers.length - 1] : run.after;
			if (!Array.isArray(parent) || parent.slice().sort().join("\0") !== expected.join("\0")) break;
			if (parent.includes(names[cursor])) throw new Error(`runs[${cursor}].after cannot reference itself`);
			layer.push(names[cursor++]);
		}
		if (layer.length === 0) throw new Error("after layer is empty");
		layers.push(layer);
	}
}

function validateTemplates(run: CanonicalRun, index: number): void {
	const after = run.after !== undefined;
	for (const key of ["task", "artifact", "reads"] as const) {
		const value = run[key];
		if (typeof value === "string" && (value.includes("{previous}") || value.includes("{chain_dir}")) && !after) {
			throw new Error(`runs[${index}].${key} uses a template restricted to after-gated entries`);
		}
	}
	if (after && run.task === undefined) run.task = "{previous}";
}

/**
 * Compile ordered runs into legacy chain steps.
 *
 * Runs sharing an `after` parent set form one layer and must be emitted as a
 * single `{parallel: [...]}` step. Emitting them as consecutive sequential steps
 * changes what actually executes: the steps stop running concurrently, and
 * `{previous}` resolves to only the immediately preceding result instead of the
 * parallel aggregate that `src/chain-execution.ts` builds.
 *
 * Per-layer `concurrency` and `failFast` ride on the group, because that is
 * where the chain runner reads them.
 */
function compileLayers(runs: CanonicalRun[], task: string | undefined, groupOptions: JsonObject = {}): JsonObject[] {
	// Group by the RESOLVED parent layer, not the raw `after` spelling. Topology
	// validation already treats `"previous"` and an explicit list naming the same
	// layer as equivalent, so keying on the literal value would split one layer
	// into two sequential steps whenever a caller mixed the two spellings.
	const names = runs.map((run, i) => run.name ?? `${run.agent}${i + 1}`);
	const grouped: CanonicalRun[][] = [];
	const layerNames: string[][] = [];
	for (const [index, run] of runs.entries()) {
		// Both spellings are canonicalized the same way — sorted — or two
		// equivalent parent sets produce different keys whenever the predecessor
		// names are not already in lexical order, splitting one parallel layer
		// into sequential steps.
		const parents = run.after === undefined
			? []
			: run.after === "previous"
				? [...(layerNames[layerNames.length - 1] ?? [])].sort()
				: [...(run.after as string[])].sort();
		const key = JSON.stringify(parents);
		const previous = grouped[grouped.length - 1];
		const previousKey = previous === undefined ? undefined : (previous as CanonicalRun[] & { key?: string }).key;
		if (previous !== undefined && previousKey === key) {
			previous.push(run);
			layerNames[layerNames.length - 1].push(names[index]);
		} else {
			const layer = [run] as CanonicalRun[] & { key?: string };
			layer.key = key;
			grouped.push(layer);
			layerNames.push([names[index]]);
		}
	}

	return grouped.map((layer) => {
		const steps = layer.map((run) => ({
			...toLegacySlot(run, ["group_concurrency", "group_failFast"]),
			task: run.after === undefined ? (run.task ?? task) : (run.task ?? "{previous}"),
		}));
		if (steps.length === 1) return steps[0];
		const group: JsonObject = { parallel: steps };
		// A legacy group's own controls travel on its member runs and win, so two
		// groups in one chain keep distinct policy. A canonical dispatch has no
		// per-group spelling, so its top-level values apply to every layer.
		for (const [canonical, carried] of [["concurrency", "group_concurrency"], ["failFast", "group_failFast"]] as const) {
			const own = layer.find((run) => (run as JsonObject)[carried] !== undefined);
			if (own !== undefined) group[canonical] = (own as JsonObject)[carried];
			else if (groupOptions[canonical] !== undefined) group[canonical] = groupOptions[canonical];
		}
		return group;
	});
}

/**
 * Translate the canonical escalation discriminator back to the spelling the
 * live policy parser accepts (`src/escalation-policy.ts` takes `mode`).
 *
 * The rename to `escalation_mode` exists to avoid colliding with a run entry's
 * own `mode`, which is a presentation concern of the advertised grammar. The
 * runtime parser is unchanged, so a compiled value carrying the canonical
 * spelling is rejected at dispatch time — later than the ingress, and for a
 * safety-relevant field.
 */
function toRuntimeEscalation(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const policy = value as JsonObject;
	if (policy.escalation_mode === undefined) return policy;
	const out: JsonObject = { ...policy, mode: policy.escalation_mode };
	delete out.escalation_mode;
	return out;
}

function toLegacySlot(run: CanonicalRun, omit: string[] = []): JsonObject {
	const out: JsonObject = {};
	for (const [key, value] of Object.entries(run)) {
		// The group carriers are an internal transport for a legacy group's own
		// controls. Stripping them here means no compile path can leak them into
		// user-visible output, whatever shape it produces.
		if (key === "group_concurrency" || key === "group_failFast") continue;
		// #286: `clone_mode` seeds a supervisor. A solo entry accepts it (the
		// guidelines recommend it without naming a mode) but has nothing to seed,
		// so drop it here rather than hand a runner a field it silently ignores.
		if (key === "clone_mode" && (run.mode ?? "solo") !== "supervised") continue;
		if (key === "progress" && (run.mode ?? "solo") === "supervised") continue;
		if (omit.includes(key) || ["mode", "after", "handoff"].includes(key)) continue;
		if (key === "escalation") out.escalation = toRuntimeEscalation(value);
		else {
			const runtimeKey = RUNTIME_RUN_KEY_BY_CANONICAL[
				key as keyof typeof RUNTIME_RUN_KEY_BY_CANONICAL
			] ?? key;
			out[runtimeKey] = value;
		}
	}
	if (run.handoff?.tasks !== undefined) out.checklist = run.handoff.tasks;
	if (run.handoff?.focus !== undefined) out.focus = run.handoff.focus;
	return out;
}

function mergeDefaults(params: JsonObject, run: JsonObject): CanonicalRun {
	const out = { ...run };
	for (const key of ["model", "thinking", "skills", "env", "cwd", "worktree", "parentTranscriptSearch"]) {
		if (out[key] === undefined && params[key] !== undefined) out[key] = params[key];
	}
	// The advertised description promises the top-level task is shared with every
	// entry that omits one. Resolve it here so each compiled slot carries a real
	// task, rather than relying on a per-runner fallback that supervised slots
	// do not have. After-gated entries keep their "{previous}" default.
	if (out.task === undefined && out.after === undefined && typeof params.task === "string") out.task = params.task;
	if (params.handoff !== undefined) out.handoff = { ...(params.handoff as Record<string, unknown>), ...(out.handoff as Record<string, unknown> ?? {}) };
	return out as CanonicalRun;
}

function copyCommon(params: JsonObject): JsonObject {
	const out: JsonObject = {};
	for (const key of ["task", "cwd", "model", "thinking", "skills", "env", "chainDir", "concurrency", "failFast", "worktree", "await", "agent_scope", "notifyOnFailure", "writableRoots", "confineWrites", "readOnly", "escalation"]) {
		if (params[key] === undefined) continue;
		const value = key === "escalation" ? toRuntimeEscalation(params[key]) : params[key];
		out[key === "skills" ? "skill" : key] = value;
	}
	return out;
}

function driverTask(task: string, handoff: unknown): string {
	if (!handoff || typeof handoff !== "object") return task;
	const tasks = (handoff as JsonObject).tasks;
	if (!Array.isArray(tasks) || tasks.length === 0) return task;
	// Deliberately NOT rendered here. The detached runner owns the authoritative
	// child session and chooses durable seed versus Markdown fallback after its
	// resource preflight. Rendering in the compiler would lose that decision and
	// could duplicate the checklist. The compiled `checklist` field is carried
	// through untouched.
	void tasks;
	return task;
}
