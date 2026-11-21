import { typedLiteral } from "./schema-values.js";
import type { SchemaValue } from "./schema-errors.js";
import * as jsonSchema from "@earendil-works/pi-schema";
import type { Schema } from "@earendil-works/pi-schema";
import { checkSchema, firstSchemaIssue } from "./schema-errors.js";
import { sanitizeName, ManagementConfigSchema, type ManagementAction, type ManagementConfig } from "./agent-management.js";

type Intersection<S extends readonly Schema[]> = S extends readonly [infer Head extends Schema, ...infer Tail extends readonly Schema[]] ? SchemaValue<Head> & Intersection<Tail> : unknown;

const finiteNumberBounds = { minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE };
const text = jsonSchema.str();
const strings = jsonSchema.arr(text);
const optionalText = jsonSchema.opt(text);
const optionalBoolean = jsonSchema.opt(jsonSchema.bool());
const object = jsonSchema.map(jsonSchema.unknown());
const RuntimeDigestSchema = jsonSchema.obj({ kind: jsonSchema.union([typedLiteral("task"), typedLiteral("read"), typedLiteral("checklist"), typedLiteral("focus")]), name: text, algorithm: typedLiteral("sha256"), digest: text }, { open: true });
const RuntimeStepSchema = jsonSchema.obj({ id: text, name: text, agent: text, kind: jsonSchema.union([typedLiteral("worker"), typedLiteral("command")]), stepIndex: jsonSchema.int(), dependsOn: strings, state: jsonSchema.union([typedLiteral("planned"), typedLiteral("started"), typedLiteral("completed"), typedLiteral("failed"), typedLiteral("aborted"), typedLiteral("skipped")]), inputDigests: jsonSchema.arr(RuntimeDigestSchema), actualInputDigests: jsonSchema.arr(jsonSchema.obj({ sequence: jsonSchema.int(), algorithm: typedLiteral("sha256"), digest: text }, { open: true })) }, { open: true });
const runtimeStatusDetailsSchema = jsonSchema.obj({ steps: jsonSchema.opt(jsonSchema.arr(RuntimeStepSchema)), recovery: jsonSchema.opt(jsonSchema.obj({ recovered: jsonSchema.bool(), partial: jsonSchema.bool(), orphanedAt: jsonSchema.opt(jsonSchema.num(finiteNumberBounds)), totalForks: jsonSchema.int(), recoveredForks: jsonSchema.int(), completedForks: jsonSchema.int(), pausedForks: jsonSchema.int(), failedForks: jsonSchema.int(), abortedForks: jsonSchema.int() }, { open: true })), terminalReason: optionalText, childlogTail: optionalText, childlogTailTruncated: optionalBoolean, stderrTruncated: optionalBoolean }, { open: true });
// The object constraint preserves native Static inference with strictNullChecks disabled.
const RuntimeStatusDetailsSchema: Schema<SchemaValue<typeof runtimeStatusDetailsSchema> & object> = runtimeStatusDetailsSchema;
export const RuntimeStatusSchema = jsonSchema.obj({
 dispatches: jsonSchema.arr(jsonSchema.obj({ runId: text, shape: jsonSchema.union([typedLiteral("supervised"), typedLiteral("direct"), typedLiteral("chain"), typedLiteral("driver"), typedLiteral("orchestrate"), typedLiteral("unknown")]), state: jsonSchema.union([typedLiteral("constructing"), typedLiteral("running"), typedLiteral("terminal-done"), typedLiteral("terminal-failed"), typedLiteral("terminal-steered"), typedLiteral("terminal-paused")]), source: jsonSchema.union([typedLiteral("in-memory"), typedLiteral("detached")]), startedAt: jsonSchema.opt(jsonSchema.num(finiteNumberBounds)), lastActivityAt: jsonSchema.opt(jsonSchema.num(finiteNumberBounds)), details: jsonSchema.opt(RuntimeStatusDetailsSchema) }, { open: true })),
 runs: jsonSchema.opt(jsonSchema.arr(object)), degraded: optionalBoolean, truncated: optionalBoolean,
}, { open: true });
export type DelegateRuntimeStatus = SchemaValue<typeof RuntimeStatusSchema>;
export type DelegateRuntimeRunObservation =
 | { kind: "pending"; run: DelegateRuntimeStatus["dispatches"][number] }
 | { kind: "terminal"; run: DelegateRuntimeStatus["dispatches"][number] }
 | { kind: "orphan"; run: DelegateRuntimeStatus["dispatches"][number] }
 | { kind: "unavailable"; runId: string };
/** Classify the native uniform status without parsing presentation text. */
export function observeDelegateRuntimeStatus(status: DelegateRuntimeStatus, runId: string): DelegateRuntimeRunObservation {
 const run = status.dispatches.find(item => item.runId === runId);
 if (!run) return { kind: "unavailable", runId };
 if (run.details?.recovery?.orphanedAt !== undefined) return { kind: "orphan", run };
 return { kind: run.state.startsWith("terminal-") ? "terminal" : "pending", run };
}
const RuntimeControlFields = jsonSchema.obj({
 runId: optionalText, forkName: optionalText, targetLineagePath: optionalText, requestId: optionalText,
 status: optionalText, delivered: optionalText, recoveryRunId: optionalText, strategy: optionalText,
 queued: optionalBoolean, inputId: optionalText, answered: optionalBoolean, questionId: optionalText,
 alreadyTerminal: optionalBoolean, neverConstructed: optionalBoolean, posted: optionalBoolean, ok: optionalBoolean,
 aborted: optionalBoolean, cursor: jsonSchema.opt(jsonSchema.obj({ entryId: jsonSchema.union([text, jsonSchema.nul()]), epoch: jsonSchema.int() }, { open: true })), promptId: optionalText, closedPromptIds: jsonSchema.opt(strings),
 mode: optionalText,
}, { open: true });
const controlIdentity = jsonSchema.union([jsonSchema.obj({ runId: text }, { open: true }), jsonSchema.obj({ targetLineagePath: text }, { open: true })]);
const routedControl = jsonSchema.obj({ requestId: text, ok: optionalBoolean }, { open: true });
const terminalControl = jsonSchema.obj({ alreadyTerminal: typedLiteral(true) }, { open: true });
const RuntimeSteerSchemaParts = [RuntimeControlFields, controlIdentity, jsonSchema.union([
 routedControl, terminalControl, jsonSchema.obj({ delivered: jsonSchema.union([typedLiteral("steer"), typedLiteral("followUp"), typedLiteral("queued")]) }, { open: true }),
 jsonSchema.obj({ mode: typedLiteral("driver"), queued: jsonSchema.bool(), inputId: text }, { open: true }),
])] as const;
export const RuntimeSteerSchema: Schema<Intersection<typeof RuntimeSteerSchemaParts>> = { allOf: RuntimeSteerSchemaParts };
const RuntimeCancelSchemaParts = [RuntimeControlFields, controlIdentity, jsonSchema.union([
 routedControl, terminalControl, jsonSchema.obj({ neverConstructed: typedLiteral(true) }, { open: true }), jsonSchema.obj({ cancelled: typedLiteral(true) }, { open: true }),
 jsonSchema.obj({ mode: typedLiteral("driver"), aborted: jsonSchema.bool(), cursor: jsonSchema.obj({ entryId: jsonSchema.union([text, jsonSchema.nul()]), epoch: jsonSchema.int() }, { open: true }) }, { open: true }),
])] as const;
export const RuntimeCancelSchema: Schema<Intersection<typeof RuntimeCancelSchemaParts>> = { allOf: RuntimeCancelSchemaParts };
export const RuntimeControlSchema = jsonSchema.union([RuntimeSteerSchema, RuntimeCancelSchema]);
export type DelegateRuntimeControlResult = SchemaValue<typeof RuntimeControlSchema>;
export const RuntimePromptStatusSchema = jsonSchema.obj({ runId: text, mode: typedLiteral("driver"), promptStatus: jsonSchema.obj({ state: jsonSchema.union([typedLiteral("pending"), typedLiteral("unknown"), typedLiteral("settled"), typedLiteral("failed"), typedLiteral("aborted")]), promptId: optionalText, acceptedAt: optionalText, settledAt: optionalText, terminalOutcome: optionalText, finalCursor: jsonSchema.opt(jsonSchema.obj({ entryId: jsonSchema.union([text, jsonSchema.nul()]), epoch: jsonSchema.int() }, { open: true })), errorCode: optionalText, reason: optionalText }, { open: true }) }, { open: true });
export type DelegateRuntimePromptStatus = SchemaValue<typeof RuntimePromptStatusSchema>;
export const RuntimeRecoverySchema = jsonSchema.union([
 jsonSchema.obj({ runId: text, forkName: text, status: jsonSchema.union([typedLiteral("recovered"), typedLiteral("already-recovered")]), recoveryRunId: text, strategy: jsonSchema.union([typedLiteral("fresh"), typedLiteral("resume")]) }, { open: true }),
 jsonSchema.obj({ runId: text, mode: typedLiteral("driver"), status: typedLiteral("recovered"), closedPromptIds: strings }, { open: true }),
 jsonSchema.obj({ runId: text, mode: typedLiteral("driver"), status: typedLiteral("reconciled"), promptId: text }, { open: true }),
]);
export type DelegateRuntimeRecovery = SchemaValue<typeof RuntimeRecoverySchema>;
export const RuntimeFollowUpSchema = jsonSchema.obj({ runId: text, mode: typedLiteral("driver"), queued: jsonSchema.bool(), inputId: text }, { open: true });
export type DelegateRuntimeFollowUp = SchemaValue<typeof RuntimeFollowUpSchema>;
export const RuntimeUiAnswerSchema = jsonSchema.obj({ runId: text, mode: typedLiteral("driver"), answered: jsonSchema.bool(), questionId: text }, { open: true });
export type DelegateRuntimeUiAnswerResult = SchemaValue<typeof RuntimeUiAnswerSchema>;
export interface DelegateRuntimeRecoverRequest { runId: string; forkName?: string; strategy?: "auto" | "fresh" | "resume"; message?: string }
export interface DelegateRuntimeFollowUpRequest { runId: string; message: string }
export type DelegateRuntimeUiAnswer = { value: string; confirmed?: never; cancelled?: never } | { confirmed: boolean; value?: never; cancelled?: never } | { cancelled: true; value?: never; confirmed?: never };
export interface DelegateRuntimeUiAnswerRequest { runId: string; questionId: string; answer: DelegateRuntimeUiAnswer }
export interface DelegateRuntimeEscalationFilter { rootRunId?: string; requestIds?: string[] }
export interface DelegateRuntimeResolveEscalationRequest { rootRunId?: string; requestId: string; selected: number | number[]; customInstruction?: string; note?: string; onBehalfOfUser?: boolean }
export interface DelegateRuntimePassUpRequest extends DelegateRuntimeEscalationFilter { context?: string; recommendation?: string }
export const RuntimeEscalationsSchema = jsonSchema.obj({ escalations: jsonSchema.arr(jsonSchema.obj({ requestId: text, rootRunId: text, kind: text, payloadSummary: text, category: optionalText, origin: optionalText, holder: jsonSchema.obj({ id: text, kind: text, position: text, isRootHolder: jsonSchema.bool(), isUser: jsonSchema.bool() }, { open: true }), resolutionOptions: jsonSchema.arr(jsonSchema.obj({ index: jsonSchema.int(), label: text }, { open: true })), raisedAt: text, deadlines: jsonSchema.obj({ request: optionalText, hop: optionalText }, { open: true }), traceLength: jsonSchema.int(), latestAnnotation: jsonSchema.opt(jsonSchema.obj({ context: optionalText, recommendation: optionalText }, { open: true })) }, { open: true })) }, { open: true });
export type DelegateRuntimeEscalations = SchemaValue<typeof RuntimeEscalationsSchema>;
const RuntimeEscalationMutationFields = jsonSchema.obj({ rootRunId: optionalText, requestId: optionalText, terminal: optionalBoolean, resolved: optionalBoolean, duplicate: optionalBoolean, selected: jsonSchema.opt(jsonSchema.arr(jsonSchema.int())), selectedLabels: jsonSchema.opt(strings), outcome: jsonSchema.opt(jsonSchema.obj({ requestId: text, status: text, at: text }, { open: true })), forwarded: jsonSchema.opt(jsonSchema.arr(jsonSchema.obj({ requestId: text, rootRunId: text, holderId: text, holderKind: text, holderLabel: optionalText, hopDeadlineAt: optionalText }, { open: true }))), noops: jsonSchema.opt(jsonSchema.arr(jsonSchema.obj({ requestId: text, rootRunId: text, status: optionalText, holderKind: optionalText, reason: optionalText }, { open: true }))), errors: jsonSchema.opt(jsonSchema.arr(jsonSchema.obj({ requestId: text, rootRunId: text, error: text }, { open: true }))), reason: optionalText }, { open: true });
const RuntimeResolveEscalationSchemaParts = [RuntimeEscalationMutationFields, jsonSchema.obj({ rootRunId: text, requestId: text, outcome: jsonSchema.obj({ requestId: text, status: text, at: text }, { open: true }) }, { open: true }), jsonSchema.union([
 jsonSchema.obj({ terminal: typedLiteral(true) }, { open: true }),
 jsonSchema.obj({ resolved: jsonSchema.bool(), duplicate: jsonSchema.bool(), selected: jsonSchema.arr(jsonSchema.int()), selectedLabels: strings }, { open: true }),
])] as const;
export const RuntimeResolveEscalationSchema: Schema<Intersection<typeof RuntimeResolveEscalationSchemaParts>> = { allOf: RuntimeResolveEscalationSchemaParts };
export const RuntimePassUpSchema: Schema<SchemaValue<typeof RuntimeEscalationMutationFields> & Required<Pick<SchemaValue<typeof RuntimeEscalationMutationFields>, "forwarded" | "noops" | "errors">>> = {
 allOf: [RuntimeEscalationMutationFields, { type: "object", required: ["forwarded", "noops", "errors"] }],
};
export const RuntimeEscalationMutationSchema = jsonSchema.union([RuntimeResolveEscalationSchema, RuntimePassUpSchema]);
export type DelegateRuntimeEscalationMutation = SchemaValue<typeof RuntimeEscalationMutationSchema>;
export interface DelegateRuntimeManagementRequest { action: ManagementAction; agent?: string; chainName?: string; agentScope?: "user" | "project" | "both"; config?: ManagementConfig }
export const RuntimeDefinitionSchema = jsonSchema.obj({ kind: jsonSchema.union([typedLiteral("agent"), typedLiteral("chain")]), name: text, description: text, source: text, filePath: text, config: ManagementConfigSchema, envKeys: jsonSchema.opt(strings) }, { open: true });
export type DelegateRuntimeDefinition = SchemaValue<typeof RuntimeDefinitionSchema>;
const RuntimeManagementMutationParts = [jsonSchema.obj({ action: jsonSchema.union([typedLiteral("create"), typedLiteral("update"), typedLiteral("delete"), typedLiteral("canonicalize")]), filePath: text, scope: text, warnings: jsonSchema.opt(strings), definitions: jsonSchema.opt(({ not: {} } as Schema<never>)) }, { open: true }), jsonSchema.union([jsonSchema.obj({ agent: text }, { open: true }), jsonSchema.obj({ chainName: text }, { open: true })])] as const;
const RuntimeManagementMutationSchema: Schema<Intersection<typeof RuntimeManagementMutationParts>> = { allOf: RuntimeManagementMutationParts };

export const RuntimeManagementResultSchema = jsonSchema.union([
 jsonSchema.obj({ action: jsonSchema.union([typedLiteral("list"), typedLiteral("get")]), definitions: jsonSchema.arr(RuntimeDefinitionSchema), warnings: jsonSchema.opt(strings) }, { open: true }),
 RuntimeManagementMutationSchema,
]);
export type DelegateRuntimeManagementResult = SchemaValue<typeof RuntimeManagementResultSchema>;
export const RuntimeHealthSchema = jsonSchema.obj({ activeRuns: jsonSchema.num(finiteNumberBounds), completedRuns: jsonSchema.num(finiteNumberBounds), registryActiveRuns: jsonSchema.num(finiteNumberBounds), registryCompletedRuns: jsonSchema.num(finiteNumberBounds), totalRunsInRegistry: jsonSchema.num(finiteNumberBounds), activeDetachedDrivers: jsonSchema.num(finiteNumberBounds), terminalDetachedDrivers: jsonSchema.num(finiteNumberBounds), detachedStatusDegraded: jsonSchema.bool(), detachedStatusTruncated: jsonSchema.bool(), agentSurfaces: jsonSchema.arr(jsonSchema.obj({ name: text, source: text, filePath: text, status: jsonSchema.union([typedLiteral("OK"), typedLiteral("BROKEN"), typedLiteral("UNKNOWN")]), unresolvedSelectors: strings, uncertainSelectors: strings, missingPackages: strings }, { open: true })), agentSurfaceScanDegraded: jsonSchema.bool(), agentSurfaceScanTruncated: jsonSchema.bool(), agentSurfaceFilesRead: jsonSchema.num(finiteNumberBounds), runStateBytes: jsonSchema.num(finiteNumberBounds), driverStorageBytes: jsonSchema.num(finiteNumberBounds), eventBusDirBytes: jsonSchema.num(finiteNumberBounds), pendingWakes: jsonSchema.num(finiteNumberBounds), pendingDriverResults: jsonSchema.num(finiteNumberBounds), staleClaims: jsonSchema.num(finiteNumberBounds), maintenance: jsonSchema.obj({ running: jsonSchema.bool(), ticks: jsonSchema.num(finiteNumberBounds), startedAt: jsonSchema.opt(jsonSchema.num(finiteNumberBounds)), lastTickAt: jsonSchema.opt(jsonSchema.num(finiteNumberBounds)), lastSweepAt: jsonSchema.opt(jsonSchema.num(finiteNumberBounds)), lastError: optionalText }, { open: true }) }, { open: true });
export type DelegateRuntimeHealth = SchemaValue<typeof RuntimeHealthSchema>;
export interface DelegateRuntimeLogsRequest { runId: string; tail?: boolean; tailLines?: number }
export type DelegateRuntimeLogs = { kind: "available"; runId: string; text: string; truncated: boolean } | { kind: "unavailable"; runId: string; reason: "not-found" | "no-log" };
export interface DelegateRuntimeWaitRequest { runId: string; timeoutMs: number }
export type DelegateRuntimeWaitResult = { kind: "terminal"; runId: string; state: string } | { kind: "timeout" | "aborted"; runId: string } | { kind: "unavailable"; runId: string; reason: string };
export const DELEGATE_RUNTIME_CAPABILITIES = ["dispatch", "status", "harvest", "steer", "cancel", "listRuns", "logs", "wait", "recover", "promptStatus", "followUp", "uiAnswer", "listEscalations", "resolveEscalation", "passUpEscalations", "manage", "health"] as const;
export type DelegateRuntimeCapability = typeof DELEGATE_RUNTIME_CAPABILITIES[number];

export class RuntimeResultContractError extends Error {
 readonly code = "unsupported-capability";
}

/** Match successful evidence to the requested target, never to an unrelated run. */
export function assertRuntimeCorrespondence(request: Record<string, unknown>, value: unknown): void {
 if (!value || typeof value !== "object") throw new RuntimeResultContractError("Missing result identity");
 const result = value as Record<string, unknown>;
 const matchesName = (actual: unknown, expected: unknown) => typeof expected === "string" && (actual === expected.trim() || actual === sanitizeName(expected));
 if (request.action === "get") {
  const definitions = Array.isArray(result.definitions) ? result.definitions : [];
  if (definitions.length === 0 || definitions.some((definition) => {
   if (!definition || typeof definition !== "object") return true;
   const row = definition as Record<string, unknown>;
   return !(row.kind === "agent" && matchesName(row.name, request.agent) || row.kind === "chain" && matchesName(row.name, request.chainName));
  })) throw new RuntimeResultContractError("Mismatched management definition");
 }
 if (["create", "update", "delete", "canonicalize"].includes(String(request.action))) {
  const config = request.config && typeof request.config === "object" ? request.config as Record<string, unknown> : {};
  // Native create chooses its kind/name from config; only update may rename a selector.
  if (request.action !== "create" && request.agent && request.chainName) throw new RuntimeResultContractError("Ambiguous management identity");
  if (request.action === "canonicalize" && (!request.agent || request.chainName)) throw new RuntimeResultContractError("Canonicalize requires an agent identity");
  const kind = request.action === "create" ? (Object.hasOwn(config, "steps") ? "chainName" : "agent") : request.agent ? "agent" : "chainName";
  const expected = request.action === "create" ? config.name : request.action === "update" ? config.name ?? request[kind] : request[kind];
  if (!matchesName(result[kind], expected) || result[kind === "agent" ? "chainName" : "agent"] !== undefined) throw new RuntimeResultContractError("Mismatched management identity");
 }
 if (request.requestId !== undefined && result.outcome && typeof result.outcome === "object" && (result.outcome as Record<string, unknown>).requestId !== request.requestId) throw new RuntimeResultContractError("Mismatched escalation outcome");
 for (const key of ["runId", "rootRunId", "requestId", "questionId", "forkName", "action", "targetLineagePath"]) {
  if (request[key] !== undefined && !(key === "runId" && request.targetLineagePath !== undefined) && result[key] !== request[key]) throw new RuntimeResultContractError(`Mismatched runtime result: ${key}`);
 }
}

/** Runtime validation narrows data; callers never assert a native payload into a public type. */
export function decodeRuntimeResult<S extends Schema>(schema: S, value: unknown): SchemaValue<S> {
 if (!checkSchema(schema, value)) throw new RuntimeResultContractError(`Incompatible runtime result: ${firstSchemaIssue(schema, value)?.path || "root"}`);
 return value;
}
