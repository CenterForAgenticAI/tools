import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { normalizeDelegateParams } from "./delegate-normalize.js";
import { compileDelegateRuns, validateRuns } from "./delegate-runs.js";
import { ManagementConfigSchema } from "./agent-management.js";
import { validateWorkerArtifactName } from "./artifact-workspace.js";
import { HARD_MAX_DEPTH } from "./depth-guard.js";
import { MAX_TIMEOUT_MS } from "./fork-timeout.js";

type JsonObject = Record<string, unknown>;

const skill = Type.Union([Type.String(), Type.Array(Type.String()), Type.Literal(false)]);
const env = Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]));
const artifactReference = Type.Object({
	schema: Type.Literal("pi-worker-artifact"),
	version: Type.Literal(2),
	artifactId: Type.String(),
	worktreeHash: Type.String(),
	runId: Type.String(),
	forkName: Type.String(),
	attempt: Type.Integer({ minimum: 1 }),
	artifactName: Type.String(),
	sha256: Type.String(),
	bytes: Type.Integer({ minimum: 1 }),
	createdAt: Type.String(),
	expiresAt: Type.String(),
	absolutePath: Type.String(),
	snapshotDev: Type.Number(),
	snapshotIno: Type.Number(),
}, { additionalProperties: false });
const reads = Type.Union([Type.Array(Type.Union([Type.String(), artifactReference])), Type.Literal(false)]);
const escalation = Type.Union([
	Type.Literal("off"), Type.Literal("local"),
	Type.Object({
		escalation_mode: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("local")])),
		mode: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("local")])),
		authority: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		intermediate: Type.Optional(Type.Boolean()),
		hopTimeoutMs: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
		timeoutMs: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Record(Type.String(), Type.Integer({ minimum: 1 }))])),
		timeoutBehavior: Type.Optional(Type.Union([Type.String(), Type.Record(Type.String(), Type.String())])),
		holdStrategy: Type.Optional(Type.Union([Type.Literal("hold-open"), Type.Literal("park")])),
	}, { additionalProperties: false }),
]);

/**
 * Namespaced handoff payloads. `tasks` is delegate's own namespace (the
 * relocated checklist); every other namespace belongs to a receiving extension
 * and is opaque here, so unknown-field detection must not descend into it.
 */
const handoff = Type.Optional(Type.Object({
	// Typed opaque, NOT as an array: Value.Convert coerces a scalar to a
	// single-element array, so typing this `Array` turned `tasks:
	// "not-a-list"` — a plain mistake — into a plausible one-item checklist
	// titled "not-a-list", and the worker ran with no actionable task. The
	// real contract lives in handoff-validation.ts, which fail-closed rejects
	// what the caller actually wrote at compile time (C264-007: this layer
	// treats payloads as data, not grammar).
	tasks: Type.Optional(Type.Unknown({ description: "With a session_tasks claimant, task titles or objects seed durable list; otherwise a prompt checklist." })),
}, { additionalProperties: true, opaquePayload: true, description: "Entry handoff. With a session_tasks claimant, tasks seed durable list; otherwise a prompt checklist." }));

/**
 * Indexes the runtime tail by name (spec §3.3). These fields are accepted and
 * strictly validated at runtime but are not advertised field-by-field; the
 * authoring-delegate-agents skill documents their grammar.
 */
const RUN_TAIL_INDEX =
	"Run entry. Also accepted, validated at runtime, documented in the skill: confineWrites, writableRoots, readOnly, fallbackModels, thinkingMin, thinkingMax, collapse_mode, summary_model, supervisor_instructions, snippet_last_n, heartbeat_interval_ms, max_consecutive_heartbeats, max_duration_ms, wind_down_grace_ms.";

const retryOf = Type.Optional(Type.Object({
	runId: Type.String(),
	forkName: Type.String(),
}, { additionalProperties: false, description: "Prior run and worker this entry retries." }));

const runCoreProperties = {
	retryOf,
	name: Type.Optional(Type.String()),
	agent: Type.String(),
	task: Type.Optional(Type.String({ description: "Initial task. Exact first worker turn by default; supervisor-mediated delivery may refine it." })),
	mode: Type.Optional(Type.Union([Type.Literal("solo"), Type.Literal("supervised"), Type.Literal("driver")])),
	after: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Literal("previous")])),
	count: Type.Optional(Type.Integer({ minimum: 1 })),
	rounds: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum accepted worker-message rounds, including the direct first turn." })),
	clone_mode: Type.Optional(Type.Union([Type.Literal("full"), Type.Literal("snippet"), Type.Literal("task_only")])),
	task_delivery: Type.Optional(Type.Union([
		Type.Literal("supervisor-mediated"),
		Type.Literal("direct-first-turn"),
	], { description: "Supervised-only first-turn delivery. Defaults to direct-first-turn; set supervisor-mediated explicitly to let the supervisor compose it." })),
	// Bounds mirror the retained runtime constraints: the advertised schema
	// shrank, so the runtime validator must not weaken. Both ceilings are the
	// live exported constants, not copies that could drift.
	depth: Type.Optional(Type.Integer({ minimum: 0, maximum: HARD_MAX_DEPTH })),
	model: Type.Optional(Type.String()),
	cwd: Type.Optional(Type.String()),
	env: Type.Optional(env),
	skills: Type.Optional(skill),
	thinking: Type.Optional(Type.Union([Type.String(), Type.Literal(false)])),
	artifact: Type.Optional(Type.Union([Type.String({ description: "Private returned file: one canonical basename with an extension, never a workspace path." }), Type.Literal(false)])),
	check: Type.Optional(Type.String({
		description: "Shell command that validates the produced artifact and retries its producer once on failure. Per-run check is supported only on an independent solo run; after-gated dispatches reject it.",
	})),
	reads: Type.Optional(reads),
	parentTranscriptSearch: Type.Optional(Type.Boolean({ description: "Grant the worker capped search excerpts from this parent transcript." })),
	progress: Type.Optional(Type.Boolean({ description: "Direct and chain runs append progress; supervised runs ignore this field with one warning." })),
	interactive: Type.Optional(Type.Boolean()),
	worktree: Type.Optional(Type.Boolean()),
	// Advertised as the two policy strings only. The full policy object is
	// accepted and validated by DelegateParamsInternal (runtime tail) and is
	// indexed in RUN_TAIL_INDEX; serializing it here cost 840 chars per entry.
	escalation: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("local")], {
		description: "Escalation policy. The object form is accepted at runtime.",
	})),
	handoff,
};

/**
 * Compact provider-facing schema (spec §3.3).
 *
 * Only the canonical `runs[]` grammar and the canonical top-level fields are
 * advertised to the model. Every legacy call shape (`agents`, `tasks`, array
 * `chain`, `chainName`, `agent`+`task`, `orchestrate`, `sync`, `skill`,
 * `checklist`, `decisionPlane`/`decisionRouting`) is absorbed permanently by
 * `normalizeDelegateParams()` and is therefore never serialized to the model.
 * Runtime-tail fields are structurally admitted (`additionalProperties: true`)
 * and strictly validated by `DelegateParamsInternal`, not advertised here.
 */
export const DelegateParams = Type.Object({
	runs: Type.Optional(Type.Array(Type.Object(runCoreProperties, {
		additionalProperties: true,
		description: RUN_TAIL_INDEX,
	}), { minItems: 1, description: "Dispatch entries. One dispatch is all-solo (optionally `after`-ordered), all-supervised, or exactly one driver entry." })),
	chain: Type.Optional(Type.String({ description: "Saved chain name to invoke." })),
	task: Type.Optional(Type.String({ description: "Task shared by every run entry that omits its own `task`." })),
	await: Type.Optional(Type.Boolean({ description: "Block until the dispatch completes. Default false: results arrive by an automatic wake." })),
	concurrency: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum concurrent solo workers." })),
	failFast: Type.Optional(Type.Boolean({ description: "Stop an ordered solo dispatch at the first failed layer." })),
	cwd: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	thinking: Type.Optional(Type.Union([Type.String(), Type.Literal(false)])),
	skills: Type.Optional(skill),
	env: Type.Optional(env),
	chainDir: Type.Optional(Type.String()),
	handoff: Type.Optional(Type.Object({}, { additionalProperties: true, opaquePayload: true, description: "Shared handoff defaults merge into entries; per-entry namespaces override. With a session_tasks claimant, tasks seed durable list; otherwise a prompt checklist." })),
	action: Type.Optional(Type.String({ description: "Agent/chain management: list | get | create | update | delete | canonicalize | health." })),
	agent_scope: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")])),
	// Advertised as an opaque object (spec §B/§3.3): the closed management grammar
	// is validated at runtime by ManagementConfigSchema and documented in the
	// authoring-delegate-agents skill. Serializing it here cost 5,434 chars.
	config: Type.Optional(Type.Object({}, {
		additionalProperties: true,
		description: "Agent/chain definition for create/update. Runtime-validated; grammar in the authoring-delegate-agents skill.",
	})),
}, { additionalProperties: true, description: "Canonical delegate dispatch. Legacy call shapes remain accepted and are normalized on ingress." });

const tailProperties = {
	...runCoreProperties,
	// Runtime accepts the full policy object; the advertised core narrows this to
	// the two literals. Must be re-widened here or the object form would reject.
	escalation: Type.Optional(escalation),
	maxSubagentDepth: Type.Optional(Type.Integer({ minimum: 0, maximum: HARD_MAX_DEPTH })),
	max_rounds: Type.Optional(Type.Integer({ minimum: 1 })),
	skill: Type.Optional(skill),
	thinkingMin: Type.Optional(Type.Union([Type.String(), Type.Literal(false)])),
	thinkingMax: Type.Optional(Type.Union([Type.String(), Type.Literal(false)])),
	fallbackModels: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
	writableRoots: Type.Optional(Type.Array(Type.String())),
	confineWrites: Type.Optional(Type.Boolean()),
	readOnly: Type.Optional(Type.Boolean()),
	heartbeat_interval_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_TIMEOUT_MS })),
	max_consecutive_heartbeats: Type.Optional(Type.Integer({ minimum: 0 })),
	collapse_mode: Type.Optional(Type.Union([Type.Literal("final_output"), Type.Literal("summary")])),
	summary_model: Type.Optional(Type.String()),
	supervisor_instructions: Type.Optional(Type.String()),
	snippet_last_n: Type.Optional(Type.Integer({ minimum: 0 })),
	// Advertised by name in RUN_TAIL_INDEX, so the closed validator must accept
	// them or the index would name fields the runtime rejects.
	max_duration_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_TIMEOUT_MS })),
	wind_down_grace_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_TIMEOUT_MS })),
	// Internal, never advertised: a legacy parallel group's own concurrency and
	// failFast ride on its member runs so distinct groups keep distinct policy
	// through canonicalization. The compiler moves them back onto the group.
	group_concurrency: Type.Optional(Type.Integer({ minimum: 1 })),
	group_failFast: Type.Optional(Type.Boolean()),
};

/** Closed runtime schema. The advertised schema is intentionally smaller. */
export const DelegateParamsInternal = Type.Object({
	runs: Type.Optional(Type.Array(Type.Object(tailProperties, { additionalProperties: false }))),
	chain: Type.Optional(Type.String()),
	task: Type.Optional(Type.String()),
	await: Type.Optional(Type.Boolean()),
	concurrency: Type.Optional(Type.Integer({ minimum: 1 })),
	failFast: Type.Optional(Type.Boolean()),
	cwd: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	thinking: Type.Optional(Type.Union([Type.String(), Type.Literal(false)])),
	skills: Type.Optional(skill),
	env: Type.Optional(env),
	chainDir: Type.Optional(Type.String()),
	notifyOnFailure: Type.Optional(Type.Boolean()),
	handoff: Type.Optional(Type.Object({}, { additionalProperties: true, opaquePayload: true })),
	action: Type.Optional(Type.String()),
	agent_scope: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")])),
	config: Type.Optional(Type.Composite([ManagementConfigSchema], { additionalProperties: true })),
	maxSubagentDepth: Type.Optional(Type.Integer({ minimum: 0, maximum: HARD_MAX_DEPTH })),
	max_rounds: Type.Optional(Type.Integer({ minimum: 1 })),
	skill: Type.Optional(skill),
	thinkingMin: Type.Optional(Type.Union([Type.String(), Type.Literal(false)])),
	thinkingMax: Type.Optional(Type.Union([Type.String(), Type.Literal(false)])),
	fallbackModels: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
	writableRoots: Type.Optional(Type.Array(Type.String())),
	confineWrites: Type.Optional(Type.Boolean()),
	readOnly: Type.Optional(Type.Boolean()),
	interactive: Type.Optional(Type.Boolean()),
	artifact: Type.Optional(Type.Union([Type.String(), Type.Literal(false)])),
	check: Type.Optional(Type.String()),
	reads: Type.Optional(reads),
	parentTranscriptSearch: Type.Optional(Type.Boolean()),
	progress: Type.Optional(Type.Boolean()),
	worktree: Type.Optional(Type.Boolean()),
	escalation: Type.Optional(escalation),
	heartbeat_interval_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_TIMEOUT_MS })),
	max_consecutive_heartbeats: Type.Optional(Type.Integer({ minimum: 0 })),
	collapse_mode: Type.Optional(Type.Union([Type.Literal("final_output"), Type.Literal("summary")])),
	summary_model: Type.Optional(Type.String()),
	supervisor_instructions: Type.Optional(Type.String()),
	snippet_last_n: Type.Optional(Type.Integer({ minimum: 0 })),
}, { additionalProperties: false });

export type DelegateParamsValue = Static<typeof DelegateParamsInternal>;

export function prepareArguments(input: unknown): Record<string, unknown> {
	const normalized = normalizeDelegateParams(input);
	if (!normalized || typeof normalized !== "object") throw new Error("delegate arguments must be an object");
	if ((normalized as Record<string, unknown>).action !== undefined) return normalized as Record<string, unknown>;
	const converted = Value.Convert(DelegateParamsInternal, normalized);
	const error = firstUnknown(converted, DelegateParamsInternal, "");
	if (error) throw new Error(error);
	if (!Value.Check(DelegateParamsInternal, converted)) {
		const detail = [...Value.Errors(DelegateParamsInternal, converted)][0];
		throw new Error(`${detail?.path || "delegate"}: ${detail?.message || "invalid delegate arguments"}`);
	}
	// Semantic validation runs at the ingress too, so a contract violation is
	// reported where every other one is rather than later at dispatch time.
	const candidate = converted as JsonObject;
	if (Array.isArray(candidate.runs)) {
		for (let index = 0; index < candidate.runs.length; index++) {
			const run = candidate.runs[index];
			if (!run || typeof run !== "object" || Array.isArray(run)) continue;
			const entry = run as JsonObject;
			if (typeof entry.artifact === "string") {
				try {
					validateWorkerArtifactName(entry.artifact);
				} catch {
					throw new Error(
						`runs[${index}].artifact must be one canonical basename with an extension; ` +
						"for a workspace path, omit artifact and instruct the worker to use write",
					);
				}
			}
			if (entry.check !== undefined && typeof entry.artifact !== "string") {
				throw new Error(`runs[${index}].check requires a sibling artifact string; there is nothing to validate without an artifact`);
			}
		}
		// Any ordering/group field sends the whole dispatch through the retired chain
		// compiler. Its step schema has no per-step check field, so reject here rather
		// than silently dropping a caller-supplied checker. Agent-frontmatter checks
		// remain available to saved/after-gated chain steps through AgentConfig.
		const checkedRunIndex = candidate.runs.findIndex((run) =>
			run && typeof run === "object" && !Array.isArray(run) && (run as JsonObject).check !== undefined,
		);
		const compilesThroughLegacyChain = candidate.runs.some((run) => {
			if (!run || typeof run !== "object" || Array.isArray(run)) return false;
			const entry = run as JsonObject;
			return entry.after !== undefined || entry.group_concurrency !== undefined || entry.group_failFast !== undefined;
		});
		if (checkedRunIndex >= 0 && compilesThroughLegacyChain) {
			throw new Error(
				`runs[${checkedRunIndex}].check is not valid in an after-gated dispatch; checked producers must be independent solo runs`,
			);
		}
		validateRuns(candidate);
	}
	return converted as Record<string, unknown>;
}

export function prepareAndCompileArguments(input: unknown): Record<string, unknown> {
	return compileDelegateRuns(prepareArguments(input));
}

/**
 * Fields that are valid in an agent's own definition file but never on a
 * dispatch. Naming where they belong turns a dead-end error into a fix: a
 * smoke test hit this with `allowNestedDelegate` and could only report that the
 * message "gave no supported replacement spelling or location".
 */
const AGENT_DEFINITION_ONLY_FIELDS = new Set([
	"allowNestedDelegate",
	"nestedDelegateAgents",
	"maxSubagentDepth",
	"systemPrompt",
	"systemPromptMode",
	"inheritSkills",
	"inheritProjectContext",
	"defaultReads",
	"stopConditionHint",
	"collapseMode",
	"defaultMaxRounds",
	"summaryModel",
]);

/**
 * Where a real field belongs when it turns up inside a run entry (#288).
 *
 * `await` is the one models get wrong most often: it is the single largest
 * error bucket in real dispatch logs, because every other control a caller
 * reaches for — `thinking`, `cwd`, `model`, `readOnly` — IS per-entry, so the
 * odd one out gets written where the others live.
 *
 * The advice is per-field on purpose. An early version told every one of these
 * to move "beside `runs`", which is confidently wrong for three of them and is
 * worse than the original dead end: `chain` REPLACES `runs` as the selector
 * (supplying both silently drops the chain), and `action`/`config` switch the
 * call to management mode, where run entries are ignored entirely.
 *
 * `task`, `cwd`, `model`, `thinking`, `skills`, `env` and `handoff` are
 * deliberately absent: those are valid in both places, where the top-level
 * value is a default and the entry value overrides it. `runs` is absent too —
 * "set `runs` beside `runs`" says nothing.
 */
const MISPLACED_DISPATCH_FIELD_ADVICE: Record<string, string> = {
	await: "set it beside `runs`, not on a run entry",
	concurrency: "set it beside `runs`, not on a run entry",
	failFast: "set it beside `runs`, not on a run entry",
	chainDir: "set it beside `runs`, not on a run entry",
	agent_scope: "set it beside `runs`, not on a run entry",
	chain: "it selects a saved chain INSTEAD of `runs`; use one or the other, not a run entry",
	action: "management calls are a separate dispatch; send `action` on its own, without `runs`",
	config: "management calls are a separate dispatch; send `action` plus `config` on their own, without `runs`",
};

/**
 * `inRunEntry` tracks whether traversal is genuinely inside a `runs[]` entry.
 * Depth alone is not a proxy for it: `config` is an opaque management payload
 * reached at depth 1, and a relocation hint fired there told the caller their
 * field was "not on a run entry" when it indeed was not on one.
 */
function firstUnknown(value: unknown, schema: TSchema | undefined, base: string, inRunEntry = false): string | undefined {
	if (!value || typeof value !== "object" || !schema) return undefined;
	const properties = (schema as { properties?: Record<string, TSchema> }).properties;
	if (!properties) return undefined;
	// An opaque payload is caller- or peer-owned data, not delegate grammar, so
	// its keys are not "unknown fields" and must not be reported as typos.
	if ((schema as { opaquePayload?: boolean }).opaquePayload === true) return undefined;
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!properties[key]) {
			// A field that is real but belongs elsewhere is not a typo, so the
			// nearest-name suggester says nothing about it and the caller is told
			// only that the field is unknown. Naming its actual home is the
			// difference between a dead end and a one-line fix.
			const misplaced = inRunEntry ? MISPLACED_DISPATCH_FIELD_ADVICE[key] : undefined;
			const elsewhere = AGENT_DEFINITION_ONLY_FIELDS.has(key)
				? `; \`${key}\` is an agent-definition field — set it in the agent's own \`.md\` frontmatter, not on a dispatch`
				: misplaced
					? `; \`${key}\` is a dispatch-level field — ${misplaced}`
					: "";
			const suggestion = elsewhere ? "" : nearest(key, Object.keys(properties));
			return `${base || "delegate"}: unknown field ${key}${suggestion ? `; did you mean ${suggestion}` : elsewhere}`;
		}
		const childSchema = properties[key];
		const itemSchema = (childSchema as { items?: TSchema }).items ?? childSchema;
		const child = record[key];
		// Only descending into the top-level `runs` array enters a run entry.
		// Everything deeper keeps whatever the parent was, so a nested object
		// inside an entry still counts and an opaque payload never starts.
		const childInRunEntry = inRunEntry || (base === "" && key === "runs");
		if (Array.isArray(child)) {
			for (let i = 0; i < child.length; i++) {
				const nested = firstUnknown(child[i], itemSchema, `${base}.${key}[${i}]`, childInRunEntry);
				if (nested) return nested;
			}
		} else {
			const nested = firstUnknown(child, childSchema, `${base}.${key}`, childInRunEntry);
			if (nested) return nested;
		}
	}
	return undefined;
}

function nearest(value: string, candidates: string[]): string | undefined {
	let best: string | undefined;
	let score = Infinity;
	for (const candidate of candidates) {
		const distance = levenshtein(value, candidate);
		if (distance < score) { score = distance; best = candidate; }
	}
	return score <= Math.max(2, Math.floor(value.length / 2)) ? best : undefined;
}

function levenshtein(a: string, b: string): number {
	const row = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let previous = row[0]; row[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const next = row[j];
			row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
			previous = next;
		}
	}
	return row[b.length];
}
