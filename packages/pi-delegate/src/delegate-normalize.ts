import * as path from "node:path";

/** A decoded JSON object. Delegate arguments are provider-supplied JSON. */
type JsonObject = Record<string, unknown>;

const REMOVED_ARTIFACT_FIELDS = ["output", "outputFrom"] as const;

/** Reject one removed artifact field on a delegate grammar object. */
export function assertNoRemovedArtifactFields(value: unknown, context: string): void {
	if (!isRecord(value)) return;
	for (const field of REMOVED_ARTIFACT_FIELDS) {
		if (Object.prototype.hasOwnProperty.call(value, field)) {
			throw new TypeError(`${context} ${field} is removed; declare artifact: instead`);
		}
	}
}

/** Reject removed artifact fields on every delegate run-entry ingress shape. */
export function assertNoRemovedArtifactFieldsAtIngress(input: unknown): void {
	if (!isRecord(input)) return;
	assertNoRemovedArtifactFields(input, "delegate field");
	const inspectSlot = (slot: unknown, context: string): void => {
		if (!isRecord(slot)) return;
		assertNoRemovedArtifactFields(slot, context);
		if (Array.isArray(slot.parallel)) {
			for (let index = 0; index < slot.parallel.length; index++) {
				inspectSlot(slot.parallel[index], `${context}.parallel[${index}]`);
			}
		}
	};
	for (const key of ["runs", "agents", "tasks", "chain"] as const) {
		const entries = input[key];
		if (!Array.isArray(entries)) continue;
		for (let index = 0; index < entries.length; index++) inspectSlot(entries[index], `${key}[${index}] field`);
	}
	inspectSlot(input.orchestrate, "orchestrate field");
}

/** Reversible canonical-to-runtime run-key aliases. */
export const RUNTIME_RUN_KEY_BY_CANONICAL = {
	skills: "skill",
	rounds: "max_rounds",
	depth: "maxSubagentDepth",
} as const;

const CANONICAL_RUN_KEY_BY_RUNTIME: Record<string, string> = Object.fromEntries(
	Object.entries(RUNTIME_RUN_KEY_BY_CANONICAL).map(([canonical, runtime]) => [runtime, canonical]),
);

/** Canonical dispatch argument normalizer. It never mutates its input. */
export function normalizeDelegateParams(input: unknown): JsonObject {
	if (!isRecord(input)) return input as JsonObject;
	const value = normalizeObject(input);
	assertNoRemovedArtifactFieldsAtIngress(value);
	if (value.action !== undefined) return value;

	if (Array.isArray(value.runs)) {
		return normalizeCanonical(value);
	}
	const agents = parseArray(value.agents);
	if (agents) {
		return withRuns(value, agents.map((entry, i) => normalizeRun(entry, "supervised", i)));
	}
	const tasks = parseArray(value.tasks);
	if (tasks) {
		return withRuns(value, tasks.map((entry, i) => normalizeRun(entry, "solo", i)));
	}
	const chain = parseArray(value.chain);
	if (chain) {
		return normalizeInlineChain(value, chain);
	}
	if (typeof value.chainName === "string") {
		// A saved chain keeps its top-level `task`: it is the chain's input, not a
		// dispatch selector. Only the chainName spelling is retired.
		return withoutSelectors({ ...value, chain: value.chainName }, { keepTask: true });
	}
	if (typeof value.chain === "string") {
		return withoutSelectors(value, { keepTask: true });
	}
	if (isRecord(value.orchestrate)) {
		const driver = normalizeRun(value.orchestrate, "driver", 0);
		return withRuns(value, [driver]);
	}
	if (typeof value.agent === "string" || typeof value.task === "string") {
		// The legacy direct shape carries entry-scoped and dispatch-scoped keys in
		// one flat object. Entry keys MOVE into the run: leaving a canonicalized
		// copy at the root makes the closed schema reject a call that worked
		// before, which breaks permanent legacy acceptance.
		return withRuns(withoutRunFields(value), [normalizeRun(pickRunFields(value), "solo", 0)]);
	}
	return value;
}

function normalizeCanonical(value: JsonObject): JsonObject {
	const source = Array.isArray(value.runs) ? value.runs : [];
	const runs = source.map((run: unknown, i: number) => normalizeRun(run, undefined, i));
	// A canonical dispatch's top-level `task` is the shared task for entries that
	// omit one, not a legacy `agent`+`task` selector, so it must survive.
	return { ...withoutSelectors(value, { keepTask: true }), runs };
}

function normalizeInlineChain(value: JsonObject, chain: unknown[]): JsonObject {
	const runs: JsonObject[] = [];
	const layers: string[][] = [];
	for (let index = 0; index < chain.length; index++) {
		const step = chain[index];
		if (isRecord(step) && Array.isArray(step.parallel)) {
			const names: string[] = [];
			for (let childIndex = 0; childIndex < step.parallel.length; childIndex++) {
				const child = step.parallel[childIndex];
				const run = normalizeRun(child, "solo", childIndex, `step${index + 1}`);
				if (!run.name) run.name = uniqueName(`${run.agent ?? "step"}`, runNames(runs));
				names.push(String(run.name));
				if (index > 0) run.after = [...layers[index - 1]];
				// Each legacy parallel group carries its OWN concurrency/failFast,
				// which the chain runner reads per group. Lifting only the first
				// group's values to the dispatch level made later groups silently
				// inherit the first group's policy.
				for (const key of ["concurrency", "failFast"] as const) {
					if (step[key] !== undefined) run[`group_${key}`] = step[key];
				}
				runs.push(run);
			}
			layers.push(names);
			continue;
		}
		const run = normalizeRun(step, "solo", 0, `step${index + 1}`);
		if (!run.name) run.name = uniqueName(`${run.agent ?? "step"}`, runNames(runs));
		if (index > 0) run.after = [...layers[index - 1]];
		layers.push([String(run.name)]);
		runs.push(run);
	}
	const lifted = liftChainOptions(value, chain);
	// A chain's top-level task is the shared task for steps that omit one (the
	// legacy chain runner defaulted the first step to it and substituted it for
	// `{task}`), so it must survive normalization rather than be stripped as a
	// direct-shape selector.
	const result: JsonObject = { ...withoutSelectors({ ...value, ...lifted }, { keepTask: true }), runs };
	delete result.chain;
	return result;
}

/** Names already assigned in this chain, used for `#N` de-duplication. */
function runNames(runs: JsonObject[]): string[] {
	return runs.map((run) => run.name).filter((name): name is string => typeof name === "string");
}

/**
 * Only a caller-supplied DISPATCH-level value is carried here.
 *
 * A group-local `concurrency`/`failFast` must NOT be lifted: promoting the first
 * group's value to dispatch scope makes it the default for every other group,
 * so an uncontrolled group silently inherits another group's throttle and abort
 * policy. Those travel per-run instead (`group_concurrency`/`group_failFast`)
 * and are reattached to their own group at compile time.
 *
 * `worktree` is different: it is uniform across a dispatch by contract, so a
 * group-level value legitimately describes the whole dispatch.
 */
function liftChainOptions(value: JsonObject, chain: unknown[]): JsonObject {
	const result: JsonObject = {};
	for (const key of ["concurrency", "failFast"]) {
		if (value[key] !== undefined) result[key] = value[key];
	}
	if (value.worktree !== undefined) result.worktree = value.worktree;
	else {
		for (const item of chain) {
			if (isRecord(item) && item.worktree !== undefined) { result.worktree = item.worktree; break; }
		}
	}
	return result;
}

function normalizeRun(raw: unknown, mode: string | undefined, index: number, prefix = "run"): JsonObject {
	const value = isRecord(raw) ? normalizeObject(raw) : {};
	assertNoRemovedArtifactFields(value, `${prefix}${index + 1} field`);
	const out: JsonObject = { ...value };
	if (mode && out.mode === undefined) out.mode = mode;
	if (out.name === undefined && out.agent !== undefined) out.name = prefix.startsWith("step") ? `${prefix}-${out.agent}` : `${prefix}${index + 1}-${out.agent}`;
	return out;
}

function withRuns(value: JsonObject, runs: JsonObject[]): JsonObject {
	const result = { ...withoutSelectors(value), runs };
	return result;
}

function withoutSelectors(value: JsonObject, options: { keepTask?: boolean } = {}): JsonObject {
	const result = { ...value };
	for (const key of ["agents", "tasks", "chainName", "orchestrate", "agent"]) delete result[key];
	if (!options.keepTask) delete result.task;
	return result;
}

/**
 * Entry-scoped fields for the legacy `agent`+`task` shape. Dispatch-level keys
 * (`await`, `concurrency`, `failFast`, `chainDir`, `action`, …) must stay at the
 * top level; the internal run schema is closed and rejects them.
 */
const RUN_SCOPED_KEYS = [
	"agent", "task", "name", "mode", "after", "count", "rounds", "clone_mode", "task_delivery", "depth",
	"model", "cwd", "env", "skills", "thinking", "artifact", "check", "reads", "progress",
	"interactive", "worktree", "escalation", "handoff", "retryOf",
	// runtime tail (accepted per entry, validated by DelegateParamsInternal)
	"maxSubagentDepth", "max_rounds", "skill", "thinkingMin", "thinkingMax", "fallbackModels",
	"writableRoots", "confineWrites", "readOnly", "heartbeat_interval_ms",
	"max_consecutive_heartbeats", "collapse_mode", "summary_model",
	"supervisor_instructions", "snippet_last_n", "max_duration_ms", "wind_down_grace_ms",
];

/**
 * Legacy spellings of entry-scoped keys. `normalizeObject` has already renamed
 * them by the time the direct shape is split, but the pre-alias name can still
 * be present on an object that was not routed through the alias pass.
 */
const LEGACY_RUN_SPELLINGS = ["maxSubagentDepth", "max_rounds", "skill", "checklist"];

function pickRunFields(value: JsonObject): JsonObject {
	assertNoRemovedArtifactFields(value, "legacy run field");
	const result: JsonObject = {};
	for (const key of RUN_SCOPED_KEYS) {
		if (value[key] !== undefined) result[key] = value[key];
	}
	return result;
}

/**
 * The counterpart to `pickRunFields`: strip the keys that moved onto the run so
 * no canonicalized duplicate is left at the dispatch level. Both the canonical
 * spelling and the legacy spelling are removed, because either one stranded at
 * the root is rejected by the closed runtime schema.
 */
function withoutRunFields(value: JsonObject): JsonObject {
	const result = { ...value };
	for (const key of RUN_SCOPED_KEYS) delete result[key];
	for (const legacy of LEGACY_RUN_SPELLINGS) delete result[legacy];
	return result;
}

/**
 * Keys whose values are caller-owned data, not delegate grammar. The normalizer
 * must never look inside them: renaming an environment variable changes what the
 * worker process sees, `config` is validated by the management grammar (which
 * keeps its own spellings), and a `handoff` namespace payload belongs to the
 * receiving extension's wire contract.
 */
const OPAQUE_VALUE_KEYS = new Set(["config", "env", "handoff"]);

function normalizeObject(value: JsonObject, handoffContext = false): JsonObject {
	const result: JsonObject = {};
	for (const [key, raw] of Object.entries(value)) {
		if (key === "decisionPlane" || key === "decisionRouting") continue;
		if (key === "checklist") {
			// `checklist` is delegate grammar, so its position moves; the task
			// entries inside are caller data and are copied verbatim.
			const tasks = raw;
			if (handoffContext) result.tasks = tasks;
			else {
				const handoff = isRecord(result.handoff) ? { ...result.handoff } : {};
				handoff.tasks = tasks;
				result.handoff = handoff;
			}
			continue;
		}
		const nextKey = aliasKey(key);
		if (nextKey === "escalation" && isRecord(raw)) {
			// Only the policy discriminator is renamed; nothing deeper is grammar.
			const escalation: JsonObject = { ...raw };
			if (escalation.escalation_mode === undefined && escalation.mode !== undefined) {
				escalation.escalation_mode = escalation.mode;
				delete escalation.mode;
			}
			result[nextKey] = escalation;
		} else if (nextKey === "handoff" && isRecord(raw)) {
			// An explicit handoff payload is advertised as opaque, so it is copied
			// unchanged. Only the separate root/run-level legacy `checklist` key
			// relocates into it (handled above); rewriting a namespace the caller
			// wrote inside handoff would mutate another extension's wire contract.
			result[nextKey] = isRecord(result.handoff)
				? { ...(result.handoff as JsonObject), ...raw }
				: raw;
		} else if (OPAQUE_VALUE_KEYS.has(nextKey)) {
			result[nextKey] = raw;
		} else {
			result[nextKey] = normalizeNested(raw);
		}
	}
	return result;
}

/**
 * Recurse only through delegate's own structural positions. Arrays of slots and
 * nested run entries are grammar; anything reached through an opaque key above
 * is not, and never arrives here.
 */
function normalizeNested(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => isRecord(item) ? normalizeObject(item) : normalizeNested(item));
	if (isRecord(value)) return normalizeObject(value);
	return value;
}

function aliasKey(key: string): string {
	if (key === "sync") return "await";
	if (key === "checklist") return "handoff";
	return CANONICAL_RUN_KEY_BY_RUNTIME[key] ?? key;
}

function parseArray(value: unknown): unknown[] | undefined {
	if (Array.isArray(value)) return value;
	if (typeof value !== "string") return undefined;
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : undefined;
	} catch { return undefined; }
}

function uniqueName(base: string, used: string[]): string {
	if (!used.includes(base)) return base;
	let n = 2;
	while (used.includes(`${base}#${n}`)) n++;
	return `${base}#${n}`;
}

function isRecord(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Resolve legacy chain step cwd against the chain base without mutating input. */
export function resolveLegacyChainCwd(chainCwd: string | undefined, stepCwd: string | undefined): string | undefined {
	if (!stepCwd) return chainCwd;
	if (!chainCwd || path.isAbsolute(stepCwd)) return stepCwd;
	return path.resolve(chainCwd, stepCwd);
}
