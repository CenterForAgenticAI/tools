import { typedLiteral } from "./schema-values.js";
import * as jsonSchema from "@earendil-works/pi-schema";
import { admitsObject, checkSchema, coerceSchema, firstSchemaIssue, schemasAt, type SchemaValue } from "./schema-errors.js";
import { normalizeDelegateParams } from "./delegate-normalize.js";
import { compileDelegateRuns, validateRuns, UnsupportedRunOptionError } from "./delegate-runs.js";
import { ManagementConfigSchema, RuntimeManagementSchema } from "./agent-management.js";
import { validateWorkerArtifactName } from "./artifact-workspace.js";
import { HARD_MAX_DEPTH } from "./depth-guard.js";
import { MAX_TIMEOUT_MS } from "./fork-timeout.js";
type JsonObject = Record<string, unknown>;
const skill = jsonSchema.union([jsonSchema.str(), jsonSchema.arr(jsonSchema.str()), typedLiteral(false)]);
const env = jsonSchema.map(jsonSchema.union([jsonSchema.str(), jsonSchema.nul()]));
const artifactReference = jsonSchema.obj({
    schema: typedLiteral("pi-worker-artifact"),
    version: typedLiteral(2),
    artifactId: jsonSchema.str(),
    worktreeHash: jsonSchema.str(),
    runId: jsonSchema.str(),
    forkName: jsonSchema.str(),
    attempt: jsonSchema.int({ minimum: 1 }),
    artifactName: jsonSchema.str(),
    sha256: jsonSchema.str(),
    bytes: jsonSchema.int({ minimum: 1 }),
    createdAt: jsonSchema.str(),
    expiresAt: jsonSchema.str(),
    absolutePath: jsonSchema.str(),
    snapshotDev: jsonSchema.num({ minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE }),
    snapshotIno: jsonSchema.num({ minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE }),
}, { open: false });
const reads = jsonSchema.union([jsonSchema.arr(jsonSchema.union([jsonSchema.str(), artifactReference])), typedLiteral(false)]);
const escalation = jsonSchema.union([
    typedLiteral("off"),
    typedLiteral("local"),
    jsonSchema.obj({
        escalation_mode: jsonSchema.opt(jsonSchema.union([typedLiteral("off"), typedLiteral("local")])),
        mode: jsonSchema.opt(jsonSchema.union([typedLiteral("off"), typedLiteral("local")])),
        authority: jsonSchema.opt(jsonSchema.map(jsonSchema.unknown())),
        intermediate: jsonSchema.opt(jsonSchema.bool()),
        hopTimeoutMs: jsonSchema.opt(jsonSchema.union([jsonSchema.int({ minimum: 1 }), jsonSchema.nul()])),
        timeoutMs: jsonSchema.opt(jsonSchema.union([jsonSchema.int({ minimum: 1 }), jsonSchema.map(jsonSchema.int({ minimum: 1 }))])),
        timeoutBehavior: jsonSchema.opt(jsonSchema.union([jsonSchema.str(), jsonSchema.map(jsonSchema.str())])),
        holdStrategy: jsonSchema.opt(jsonSchema.union([typedLiteral("hold-open"), typedLiteral("park")])),
    }, { open: false }),
]);
/**
 * Namespaced handoff payloads. `tasks` is delegate's own namespace (the
 * relocated checklist); every other namespace belongs to a receiving extension
 * and is opaque here, so unknown-field detection must not descend into it.
 */
const handoff = jsonSchema.opt(({ ...jsonSchema.obj({
        // Typed opaque, not as an array: tool-ingress coercion can wrap a scalar as a
        // single-element array, so typing this `Array` turned `tasks:
        // "not-a-list"` — a plain mistake — into a plausible one-item checklist
        // titled "not-a-list", and the worker ran with no actionable task. The
        // real contract lives in handoff-validation.ts, which fail-closed rejects
        // what the caller actually wrote at compile time (C264-007: this layer
        // treats payloads as data, not grammar).
        tasks: jsonSchema.opt(jsonSchema.unknown({ description: "With a task-list claimant (workstream_tasks or session_tasks), task titles or objects seed durable list; otherwise a prompt checklist." })),
    }, { open: true, description: "Entry handoff. With a task-list claimant (workstream_tasks or session_tasks), tasks seed durable list; otherwise a prompt checklist." }), opaquePayload: true }));
/**
 * Indexes the runtime tail by name (spec §3.3). These fields are accepted and
 * strictly validated at runtime but are not advertised field-by-field; the
 * authoring-delegate-agents skill documents their grammar.
 */
const RUN_TAIL_INDEX = "Run entry. Also accepted, validated at runtime, documented in the skill: confineWrites, writableRoots, readOnly, fabric, fallbackModels, thinkingMin, thinkingMax, collapse_mode, summary_model, supervisor_instructions, snippet_last_n, heartbeat_interval_ms, max_consecutive_heartbeats, max_duration_ms, wind_down_grace_ms.";
const retryOf = jsonSchema.opt(jsonSchema.obj({
    runId: jsonSchema.str(),
    forkName: jsonSchema.str(),
}, { open: false, description: "Prior run and worker this entry retries." }));
const runCoreProperties = {
    retryOf,
    name: jsonSchema.opt(jsonSchema.str()),
    agent: jsonSchema.str(),
    task: jsonSchema.opt(jsonSchema.str({ description: "Initial task. Exact first worker turn by default; supervisor-mediated delivery may refine it." })),
    mode: jsonSchema.opt(jsonSchema.union([typedLiteral("solo"), typedLiteral("supervised"), typedLiteral("driver")])),
    after: jsonSchema.opt(jsonSchema.union([jsonSchema.arr(jsonSchema.str()), typedLiteral("previous")])),
    count: jsonSchema.opt(jsonSchema.int({ minimum: 1 })),
    rounds: jsonSchema.opt(jsonSchema.int({ minimum: 1, description: "Maximum accepted worker-message rounds, including the direct first turn." })),
    clone_mode: jsonSchema.opt(jsonSchema.union([typedLiteral("full"), typedLiteral("snippet"), typedLiteral("task_only")])),
    task_delivery: jsonSchema.opt(jsonSchema.union([
        typedLiteral("supervisor-mediated"),
        typedLiteral("direct-first-turn"),
    ], { description: "Supervised-only first-turn delivery. Defaults to direct-first-turn; set supervisor-mediated explicitly to let the supervisor compose it." })),
    // Bounds mirror the retained runtime constraints: the advertised schema
    // shrank, so the runtime validator must not weaken. Both ceilings are the
    // live exported constants, not copies that could drift.
    depth: jsonSchema.opt(jsonSchema.int({ minimum: 0, maximum: HARD_MAX_DEPTH })),
    model: jsonSchema.opt(jsonSchema.str()),
    cwd: jsonSchema.opt(jsonSchema.str()),
    env: jsonSchema.opt(env),
    skills: jsonSchema.opt(skill),
    thinking: jsonSchema.opt(jsonSchema.union([jsonSchema.str(), typedLiteral(false)])),
    artifact: jsonSchema.opt(jsonSchema.union([jsonSchema.str({ description: "Private returned file: one canonical basename with an extension, never a workspace path." }), typedLiteral(false)])),
    check: jsonSchema.opt(jsonSchema.str({
        description: "Shell command that validates the produced artifact and retries its producer once on failure. Per-run check is supported only on an independent solo run; after-gated dispatches reject it.",
    })),
    reads: jsonSchema.opt(reads),
    parentTranscriptSearch: jsonSchema.opt(jsonSchema.bool({ description: "Grant the worker capped search excerpts from this parent transcript." })),
    progress: jsonSchema.opt(jsonSchema.bool({ description: "Direct and chain runs append progress; supervised runs ignore this field with one warning." })),
    interactive: jsonSchema.opt(jsonSchema.bool()),
    worktree: jsonSchema.opt(jsonSchema.bool()),
    // Advertised as the two policy strings only. The full policy object is
    // accepted and validated by DelegateParamsInternal (runtime tail) and is
    // indexed in RUN_TAIL_INDEX; serializing it here cost 840 chars per entry.
    escalation: jsonSchema.opt(jsonSchema.union([typedLiteral("off"), typedLiteral("local")], {
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
function buildDelegateParams(managementActions: boolean) {
    return jsonSchema.obj({
    runs: jsonSchema.opt(jsonSchema.arr(jsonSchema.obj(runCoreProperties, { open: true, description: RUN_TAIL_INDEX }), { minItems: 1, description: "Dispatch entries. One dispatch is all-solo (optionally `after`-ordered), all-supervised, or exactly one driver entry." })),
    chain: jsonSchema.opt(jsonSchema.str({ description: "Saved chain name to invoke." })),
    task: jsonSchema.opt(jsonSchema.str({ description: "Task shared by every run entry that omits its own `task`." })),
    await: jsonSchema.opt(jsonSchema.bool({ description: "Block until the dispatch completes. Default false: results arrive by an automatic wake." })),
    concurrency: jsonSchema.opt(jsonSchema.int({ minimum: 1, description: "Maximum concurrent solo workers." })),
    failFast: jsonSchema.opt(jsonSchema.bool({ description: "Stop an ordered solo dispatch at the first failed layer." })),
    cwd: jsonSchema.opt(jsonSchema.str()),
    model: jsonSchema.opt(jsonSchema.str()),
    thinking: jsonSchema.opt(jsonSchema.union([jsonSchema.str(), typedLiteral(false)])),
    skills: jsonSchema.opt(skill),
    env: jsonSchema.opt(env),
    chainDir: jsonSchema.opt(jsonSchema.str()),
    handoff: jsonSchema.opt(({ ...jsonSchema.obj({}, { open: true, description: "Shared handoff defaults merge into entries; per-entry namespaces override. With a task-list claimant (workstream_tasks or session_tasks), tasks seed durable list; otherwise a prompt checklist." }), opaquePayload: true })),
    ...(managementActions
        ? {
            action: jsonSchema.opt(jsonSchema.str({ description: "Agent/chain management: list | get | create | update | delete | canonicalize | health." })),
            agent_scope: jsonSchema.opt(jsonSchema.union([typedLiteral("user"), typedLiteral("project"), typedLiteral("both")])),
            // Advertised as an opaque object (spec §B/§3.3): the closed management grammar
            // is validated at runtime by ManagementConfigSchema and documented in the
            // authoring-delegate-agents skill. Serializing it here cost 5,434 chars.
            config: jsonSchema.opt(jsonSchema.obj({}, { open: true, description: "Agent/chain definition for create/update. Runtime-validated; grammar in the authoring-delegate-agents skill." })),
        }
        // `managementActions: false` (host provisions the roster): only the
        // read-only health probe stays advertised; list/get/create and their
        // `config`/`agent_scope` fields are neither offered nor accepted.
        : { action: jsonSchema.opt(typedLiteral("health")) }),
}, { open: true, description: "Canonical delegate dispatch. Legacy call shapes remain accepted and are normalized on ingress." });
}
export const DelegateParams = buildDelegateParams(true);
/** Advertised schema for hosts that set `managementActions: false`. */
export const DelegateParamsWithoutManagement = buildDelegateParams(false);
let managementActionsEnabled = true;
/**
 * Apply the `managementActions` config key to ingress. Called once when the
 * extension loads, from the same value that selects the advertised schema.
 */
export function setManagementActionsEnabled(enabled: boolean): void {
    managementActionsEnabled = enabled;
}
const MANAGEMENT_ACTIONS = new Set(["list", "get", "create", "update", "delete", "canonicalize"]);
function assertManagementActionAllowed(normalized: Record<string, unknown>): void {
    if (managementActionsEnabled)
        return;
    const action = normalized.action;
    if ((typeof action === "string" && MANAGEMENT_ACTIONS.has(action)) || normalized.config !== undefined) {
        throw new Error("delegate: agent-management actions (list, get, create, update, delete, canonicalize) are disabled in this workspace " +
            "(managementActions: false); the agent roster is provisioned by the host. Dispatch with `runs[]` instead.");
    }
}
const tailProperties = {
    ...runCoreProperties,
    // Runtime accepts the full policy object; the advertised core narrows this to
    // the two literals. Must be re-widened here or the object form would reject.
    escalation: jsonSchema.opt(escalation),
    maxSubagentDepth: jsonSchema.opt(jsonSchema.int({ minimum: 0, maximum: HARD_MAX_DEPTH })),
    max_rounds: jsonSchema.opt(jsonSchema.int({ minimum: 1 })),
    skill: jsonSchema.opt(skill),
    thinkingMin: jsonSchema.opt(jsonSchema.union([jsonSchema.str(), typedLiteral(false)])),
    thinkingMax: jsonSchema.opt(jsonSchema.union([jsonSchema.str(), typedLiteral(false)])),
    fallbackModels: jsonSchema.opt(jsonSchema.union([jsonSchema.str(), jsonSchema.arr(jsonSchema.str())])),
    writableRoots: jsonSchema.opt(jsonSchema.arr(jsonSchema.str())),
    confineWrites: jsonSchema.opt(jsonSchema.bool()),
    readOnly: jsonSchema.opt(jsonSchema.bool()),
    fabric: jsonSchema.opt(jsonSchema.bool()),
    heartbeat_interval_ms: jsonSchema.opt(jsonSchema.int({ minimum: 0, maximum: MAX_TIMEOUT_MS })),
    max_consecutive_heartbeats: jsonSchema.opt(jsonSchema.int({ minimum: 0 })),
    collapse_mode: jsonSchema.opt(jsonSchema.union([typedLiteral("final_output"), typedLiteral("summary")])),
    summary_model: jsonSchema.opt(jsonSchema.str()),
    supervisor_instructions: jsonSchema.opt(jsonSchema.str()),
    snippet_last_n: jsonSchema.opt(jsonSchema.int({ minimum: 0 })),
    // Advertised by name in RUN_TAIL_INDEX, so the closed validator must accept
    // them or the index would name fields the runtime rejects.
    max_duration_ms: jsonSchema.opt(jsonSchema.int({ minimum: 0, maximum: MAX_TIMEOUT_MS })),
    wind_down_grace_ms: jsonSchema.opt(jsonSchema.int({ minimum: 0, maximum: MAX_TIMEOUT_MS })),
    // Internal, never advertised: a legacy parallel group's own concurrency and
    // failFast ride on its member runs so distinct groups keep distinct policy
    // through canonicalization. The compiler moves them back onto the group.
    group_concurrency: jsonSchema.opt(jsonSchema.int({ minimum: 1 })),
    group_failFast: jsonSchema.opt(jsonSchema.bool()),
};
/** Closed runtime schema. The advertised schema is intentionally smaller. */
export const DelegateParamsInternal = jsonSchema.obj({
    runs: jsonSchema.opt(jsonSchema.arr(jsonSchema.obj(tailProperties, { open: false }))),
    chain: jsonSchema.opt(jsonSchema.str()),
    task: jsonSchema.opt(jsonSchema.str()),
    await: jsonSchema.opt(jsonSchema.bool()),
    concurrency: jsonSchema.opt(jsonSchema.int({ minimum: 1 })),
    failFast: jsonSchema.opt(jsonSchema.bool()),
    cwd: jsonSchema.opt(jsonSchema.str()),
    model: jsonSchema.opt(jsonSchema.str()),
    thinking: jsonSchema.opt(jsonSchema.union([jsonSchema.str(), typedLiteral(false)])),
    skills: jsonSchema.opt(skill),
    env: jsonSchema.opt(env),
    chainDir: jsonSchema.opt(jsonSchema.str()),
    notifyOnFailure: jsonSchema.opt(jsonSchema.bool()),
    handoff: jsonSchema.opt(({ ...jsonSchema.obj({}, { open: true }), opaquePayload: true })),
    action: jsonSchema.opt(jsonSchema.str()),
    agent_scope: jsonSchema.opt(jsonSchema.union([typedLiteral("user"), typedLiteral("project"), typedLiteral("both")])),
    // Keep the canonical management fields while admitting its opaque extensions.
    config: jsonSchema.opt({ ...ManagementConfigSchema, additionalProperties: true }),
    clone_mode: runCoreProperties.clone_mode,
    task_delivery: runCoreProperties.task_delivery,
    maxSubagentDepth: jsonSchema.opt(jsonSchema.int({ minimum: 0, maximum: HARD_MAX_DEPTH })),
    max_rounds: jsonSchema.opt(jsonSchema.int({ minimum: 1 })),
    skill: jsonSchema.opt(skill),
    thinkingMin: jsonSchema.opt(jsonSchema.union([jsonSchema.str(), typedLiteral(false)])),
    thinkingMax: jsonSchema.opt(jsonSchema.union([jsonSchema.str(), typedLiteral(false)])),
    fallbackModels: jsonSchema.opt(jsonSchema.union([jsonSchema.str(), jsonSchema.arr(jsonSchema.str())])),
    writableRoots: jsonSchema.opt(jsonSchema.arr(jsonSchema.str())),
    confineWrites: jsonSchema.opt(jsonSchema.bool()),
    readOnly: jsonSchema.opt(jsonSchema.bool()),
    fabric: jsonSchema.opt(jsonSchema.bool()),
    interactive: jsonSchema.opt(jsonSchema.bool()),
    artifact: jsonSchema.opt(jsonSchema.union([jsonSchema.str(), typedLiteral(false)])),
    check: jsonSchema.opt(jsonSchema.str()),
    reads: jsonSchema.opt(reads),
    parentTranscriptSearch: jsonSchema.opt(jsonSchema.bool()),
    progress: jsonSchema.opt(jsonSchema.bool()),
    worktree: jsonSchema.opt(jsonSchema.bool()),
    escalation: jsonSchema.opt(escalation),
    heartbeat_interval_ms: jsonSchema.opt(jsonSchema.int({ minimum: 0, maximum: MAX_TIMEOUT_MS })),
    max_consecutive_heartbeats: jsonSchema.opt(jsonSchema.int({ minimum: 0 })),
    collapse_mode: jsonSchema.opt(jsonSchema.union([typedLiteral("final_output"), typedLiteral("summary")])),
    summary_model: jsonSchema.opt(jsonSchema.str()),
    supervisor_instructions: jsonSchema.opt(jsonSchema.str()),
    snippet_last_n: jsonSchema.opt(jsonSchema.int({ minimum: 0 })),
}, { open: false });
export type DelegateParamsValue = SchemaValue<typeof DelegateParamsInternal>;
/** Validate legacy field ownership without compiling away native execution semantics. */
export function prepareRuntimeDispatchArguments(input: Record<string, unknown>): Record<string, unknown> {
    const normalized = normalizeDelegateParams(input);
    if (input.runs !== undefined || normalized.action !== undefined)
        return prepareArguments(normalized);
    const unknown = firstUnknown(normalized, DelegateParamsInternal, "");
    if (unknown)
        throw new Error(unknown);
    const runs = Array.isArray(normalized.runs) ? normalized.runs : [];
    if ((normalized.worktree === true || runs.some(run => run?.worktree === true)) && runs.some(run => Array.isArray(run?.reads) && run.reads.length > 0)) {
        throw new UnsupportedRunOptionError("worktree-reads", "reads is not supported with worktree: true; copy inputs with a worktreeSetupHook or drop worktree isolation");
    }
    const legacy: Record<string, unknown> = {};
    const keys = new Set([...Object.keys(propertiesOf(DelegateParamsInternal)), ...Object.keys(tailProperties), "agent", "agents", "tasks", "orchestrate", "chainName", "sync", "checklist"]);
    for (const key of keys)
        if (input[key] !== undefined)
            legacy[key] = structuredClone(input[key]);
    return legacy;
}
/** Coercion keeps explicit nulls and wraps a non-array only into a valid item or an object-shaped one, so a bad scalar is blamed at the array. */
function preserveInputStructure(original: unknown, converted: unknown, path: string[] = []): unknown {
    if (original === null)
        return original;
    if (Array.isArray(converted) && !Array.isArray(original)) {
        if (converted.length !== 1)
            return original;
        const wrapped = preserveInputStructure(original, converted[0], [...path, "0"]);
        return schemasAt(DelegateParamsInternal, [...path, "0"]).some(schema => checkSchema(schema, wrapped) || (typeof original === "object" && admitsObject(schema))) ? [wrapped] : original;
    }
    if (Array.isArray(original) && Array.isArray(converted) && original.length === converted.length) {
        return converted.map((item, index) => preserveInputStructure(original[index], item, [...path, String(index)]));
    }
    if (original && typeof original === "object" && !Array.isArray(original) && converted && typeof converted === "object" && !Array.isArray(converted)) {
        const result: Record<string, unknown> = { ...(converted as Record<string, unknown>) };
        for (const [key, value] of Object.entries(original as Record<string, unknown>)) {
            if (key in result || value === null)
                result[key] = preserveInputStructure(value, result[key], [...path, key]);
        }
        return result;
    }
    return converted;
}
/**
 * Providers JSON-encode `runs` or its entries. Ingress recovers a `runs` string as JSON, so its parse error is
 * actionable; an entry string earns a hint only when it encodes the object the entry needs.
 */
function runsStringHint(path: string | undefined, runs: unknown): string {
    const match = path === undefined ? null : /^\/runs(?:\/(\d+))?$/.exec(path);
    const entry = match?.[1] !== undefined;
    const value = entry ? (Array.isArray(runs) ? runs[Number(match[1])] : undefined) : runs;
    if (!match || typeof value !== "string")
        return "";
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    }
    catch (error) {
        return entry ? "" : `; the string is not valid JSON: ${(error as Error).message}`;
    }
    return parsed !== null && typeof parsed === "object" && (!entry || !Array.isArray(parsed)) ? "; send the JSON value itself, not a string encoding it" : "";
}
export function prepareArguments(input: unknown): Record<string, unknown> {
    const normalized = normalizeDelegateParams(input);
    if (!normalized || typeof normalized !== "object")
        throw new Error("delegate arguments must be an object");
    assertManagementActionAllowed(normalized as Record<string, unknown>);
    if ((normalized as Record<string, unknown>).action !== undefined) {
        const management: Record<string, unknown> = {};
        for (const key of Object.keys(propertiesOf(RuntimeManagementSchema)))
            if ((normalized as Record<string, unknown>)[key] !== undefined)
                management[key] = (normalized as Record<string, unknown>)[key];
        if (!checkSchema(RuntimeManagementSchema, management))
            throw new Error("Invalid management request");
        if (management.config !== undefined) {
            const config = typeof management.config === "string" ? JSON.parse(management.config) : management.config;
            if (!checkSchema(ManagementConfigSchema, config))
                throw new Error("Invalid management config");
            management.config = structuredClone(config);
        }
        return management;
    }
    const converted = preserveInputStructure(normalized, coerceSchema(DelegateParamsInternal, structuredClone(normalized)));
    const error = firstUnknown(converted, DelegateParamsInternal, "");
    if (error)
        throw new Error(error);
    if (!checkSchema(DelegateParamsInternal, converted)) {
        const detail = firstSchemaIssue(DelegateParamsInternal, converted);
        throw new Error(`${detail?.path || "delegate"}: ${detail?.message || "invalid delegate arguments"}${runsStringHint(detail?.path, (converted as JsonObject).runs)}`);
    }
    // Semantic validation runs at the ingress too, so a contract violation is
    // reported where every other one is rather than later at dispatch time.
    const candidate = converted as JsonObject;
    if (Array.isArray(candidate.runs)) {
        for (let index = 0; index < candidate.runs.length; index++) {
            const run = candidate.runs[index];
            if (!run || typeof run !== "object" || Array.isArray(run))
                continue;
            const entry = run as JsonObject;
            if (typeof entry.artifact === "string") {
                try {
                    validateWorkerArtifactName(entry.artifact);
                }
                catch {
                    throw new Error(`runs[${index}].artifact must be one canonical basename with an extension; ` +
                        "for a workspace path, omit artifact and instruct the worker to use write");
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
        const checkedRunIndex = candidate.runs.findIndex((run) => run && typeof run === "object" && !Array.isArray(run) && (run as JsonObject).check !== undefined);
        const compilesThroughLegacyChain = candidate.runs.some((run) => {
            if (!run || typeof run !== "object" || Array.isArray(run))
                return false;
            const entry = run as JsonObject;
            return entry.after !== undefined || entry.group_concurrency !== undefined || entry.group_failFast !== undefined;
        });
        if (checkedRunIndex >= 0 && compilesThroughLegacyChain) {
            throw new Error(`runs[${checkedRunIndex}].check is not valid in an after-gated dispatch; checked producers must be independent solo runs`);
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
function propertiesOf(schema: jsonSchema.Schema): Record<string, jsonSchema.Schema> {
    const properties = schema.properties;
    return properties && typeof properties === "object" && !Array.isArray(properties)
        ? properties as Record<string, jsonSchema.Schema>
        : {};
}

function firstUnknown(value: unknown, schema: jsonSchema.Schema | undefined, base: string, inRunEntry = false): string | undefined {
    if (!value || typeof value !== "object" || !schema)
        return undefined;
    const properties = (schema as {
        properties?: Record<string, jsonSchema.Schema>;
    }).properties;
    if (!properties)
        return undefined;
    // An opaque payload is caller- or peer-owned data, not delegate grammar, so
    // its keys are not "unknown fields" and must not be reported as typos.
    if ((schema as {
        opaquePayload?: boolean;
    }).opaquePayload === true)
        return undefined;
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
        const itemSchema = (childSchema as {
            items?: jsonSchema.Schema;
        }).items ?? childSchema;
        const child = record[key];
        // Only descending into the top-level `runs` array enters a run entry.
        // Everything deeper keeps whatever the parent was, so a nested object
        // inside an entry still counts and an opaque payload never starts.
        const childInRunEntry = inRunEntry || (base === "" && key === "runs");
        if (Array.isArray(child)) {
            for (let i = 0; i < child.length; i++) {
                const nested = firstUnknown(child[i], itemSchema, `${base}.${key}[${i}]`, childInRunEntry);
                if (nested)
                    return nested;
            }
        }
        else {
            const nested = firstUnknown(child, childSchema, `${base}.${key}`, childInRunEntry);
            if (nested)
                return nested;
        }
    }
    return undefined;
}
function nearest(value: string, candidates: string[]): string | undefined {
    let best: string | undefined;
    let score = Infinity;
    for (const candidate of candidates) {
        const distance = levenshtein(value, candidate);
        if (distance < score) {
            score = distance;
            best = candidate;
        }
    }
    return score <= Math.max(2, Math.floor(value.length / 2)) ? best : undefined;
}
function levenshtein(a: string, b: string): number {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        let previous = row[0];
        row[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const next = row[j];
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
            previous = next;
        }
    }
    return row[b.length];
}
