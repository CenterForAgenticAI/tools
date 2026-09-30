import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { sanitizeName, ManagementConfigSchema, type ManagementAction, type ManagementConfig } from "./agent-management.js";

const text = Type.String();
const strings = Type.Array(text);
const optionalText = Type.Optional(text);
const optionalBoolean = Type.Optional(Type.Boolean());
const object = Type.Record(text, Type.Unknown());
const RuntimeDigestSchema = Type.Object({ kind: Type.Union([Type.Literal("task"), Type.Literal("read"), Type.Literal("checklist"), Type.Literal("focus")]), name: text, algorithm: Type.Literal("sha256"), digest: text }, { additionalProperties: true });
const RuntimeStepSchema = Type.Object({ id: text, name: text, agent: text, kind: Type.Union([Type.Literal("worker"), Type.Literal("command")]), stepIndex: Type.Integer(), dependsOn: strings, state: Type.Union((["planned", "started", "completed", "failed", "aborted", "skipped"] as const).map(value => Type.Literal(value))), inputDigests: Type.Array(RuntimeDigestSchema), actualInputDigests: Type.Array(Type.Object({ sequence: Type.Integer(), algorithm: Type.Literal("sha256"), digest: text })) });
export const RuntimeStatusSchema = Type.Object({
 dispatches: Type.Array(Type.Object({ runId: text, shape: Type.Union((["supervised", "direct", "chain", "driver", "orchestrate", "unknown"] as const).map(value => Type.Literal(value))), state: Type.Union((["constructing", "running", "terminal-done", "terminal-failed", "terminal-steered", "terminal-paused"] as const).map(value => Type.Literal(value))), source: Type.Union([Type.Literal("in-memory"), Type.Literal("detached")]), startedAt: Type.Optional(Type.Number()), lastActivityAt: Type.Optional(Type.Number()), details: Type.Optional(Type.Object({ steps: Type.Optional(Type.Array(RuntimeStepSchema)), recovery: Type.Optional(Type.Object({ recovered: Type.Boolean(), partial: Type.Boolean(), orphanedAt: Type.Optional(Type.Number()), totalForks: Type.Integer(), recoveredForks: Type.Integer(), completedForks: Type.Integer(), pausedForks: Type.Integer(), failedForks: Type.Integer(), abortedForks: Type.Integer() })), terminalReason: optionalText, childlogTail: optionalText, childlogTailTruncated: optionalBoolean, stderrTruncated: optionalBoolean }, { additionalProperties: true })) })),
 runs: Type.Optional(Type.Array(object)), degraded: optionalBoolean, truncated: optionalBoolean,
});
export type DelegateRuntimeStatus = Static<typeof RuntimeStatusSchema>;
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
const RuntimeControlFields = Type.Object({
 runId: optionalText, forkName: optionalText, targetLineagePath: optionalText, requestId: optionalText,
 status: optionalText, delivered: optionalText, recoveryRunId: optionalText, strategy: optionalText,
 queued: optionalBoolean, inputId: optionalText, answered: optionalBoolean, questionId: optionalText,
 alreadyTerminal: optionalBoolean, neverConstructed: optionalBoolean, posted: optionalBoolean, ok: optionalBoolean,
 aborted: optionalBoolean, cursor: Type.Optional(Type.Object({ entryId: Type.Union([text, Type.Null()]), epoch: Type.Integer() })), promptId: optionalText, closedPromptIds: Type.Optional(strings),
 mode: optionalText,
});
const controlIdentity = Type.Union([Type.Object({ runId: text }), Type.Object({ targetLineagePath: text })]);
const routedControl = Type.Object({ requestId: text, ok: optionalBoolean });
const terminalControl = Type.Object({ alreadyTerminal: Type.Literal(true) });
export const RuntimeSteerSchema = Type.Intersect([RuntimeControlFields, controlIdentity, Type.Union([
 routedControl, terminalControl, Type.Object({ delivered: Type.Union([Type.Literal("steer"), Type.Literal("followUp"), Type.Literal("queued")]) }),
 Type.Object({ mode: Type.Literal("driver"), queued: Type.Boolean(), inputId: text }),
])]);
export const RuntimeCancelSchema = Type.Intersect([RuntimeControlFields, controlIdentity, Type.Union([
 routedControl, terminalControl, Type.Object({ neverConstructed: Type.Literal(true) }), Type.Object({ cancelled: Type.Literal(true) }),
 Type.Object({ mode: Type.Literal("driver"), aborted: Type.Boolean(), cursor: Type.Object({ entryId: Type.Union([text, Type.Null()]), epoch: Type.Integer() }) }),
])]);
export const RuntimeControlSchema = Type.Union([RuntimeSteerSchema, RuntimeCancelSchema]);
export type DelegateRuntimeControlResult = Static<typeof RuntimeControlSchema>;
export const RuntimePromptStatusSchema = Type.Object({ runId: text, mode: Type.Literal("driver"), promptStatus: Type.Object({ state: Type.Union((["pending", "unknown", "settled", "failed", "aborted"] as const).map(value => Type.Literal(value))), promptId: optionalText, acceptedAt: optionalText, settledAt: optionalText, terminalOutcome: optionalText, finalCursor: Type.Optional(Type.Object({ entryId: Type.Union([text, Type.Null()]), epoch: Type.Integer() })), errorCode: optionalText, reason: optionalText }, { additionalProperties: true }) });
export type DelegateRuntimePromptStatus = Static<typeof RuntimePromptStatusSchema>;
export const RuntimeRecoverySchema = Type.Union([
 Type.Object({ runId: text, forkName: text, status: Type.Union([Type.Literal("recovered"), Type.Literal("already-recovered")]), recoveryRunId: text, strategy: Type.Union([Type.Literal("fresh"), Type.Literal("resume")]) }),
 Type.Object({ runId: text, mode: Type.Literal("driver"), status: Type.Literal("recovered"), closedPromptIds: strings }),
 Type.Object({ runId: text, mode: Type.Literal("driver"), status: Type.Literal("reconciled"), promptId: text }),
]);
export type DelegateRuntimeRecovery = Static<typeof RuntimeRecoverySchema>;
export const RuntimeFollowUpSchema = Type.Object({ runId: text, mode: Type.Literal("driver"), queued: Type.Boolean(), inputId: text });
export type DelegateRuntimeFollowUp = Static<typeof RuntimeFollowUpSchema>;
export const RuntimeUiAnswerSchema = Type.Object({ runId: text, mode: Type.Literal("driver"), answered: Type.Boolean(), questionId: text });
export type DelegateRuntimeUiAnswerResult = Static<typeof RuntimeUiAnswerSchema>;
export interface DelegateRuntimeRecoverRequest { runId: string; forkName?: string; strategy?: "auto" | "fresh" | "resume"; message?: string }
export interface DelegateRuntimeFollowUpRequest { runId: string; message: string }
export type DelegateRuntimeUiAnswer = { value: string; confirmed?: never; cancelled?: never } | { confirmed: boolean; value?: never; cancelled?: never } | { cancelled: true; value?: never; confirmed?: never };
export interface DelegateRuntimeUiAnswerRequest { runId: string; questionId: string; answer: DelegateRuntimeUiAnswer }
export interface DelegateRuntimeEscalationFilter { rootRunId?: string; requestIds?: string[] }
export interface DelegateRuntimeResolveEscalationRequest { rootRunId?: string; requestId: string; selected: number | number[]; customInstruction?: string; note?: string; onBehalfOfUser?: boolean }
export interface DelegateRuntimePassUpRequest extends DelegateRuntimeEscalationFilter { context?: string; recommendation?: string }
export const RuntimeEscalationsSchema = Type.Object({ escalations: Type.Array(Type.Object({ requestId: text, rootRunId: text, kind: text, payloadSummary: text, category: optionalText, origin: optionalText, holder: Type.Object({ id: text, kind: text, position: text, isRootHolder: Type.Boolean(), isUser: Type.Boolean() }, { additionalProperties: true }), resolutionOptions: Type.Array(Type.Object({ index: Type.Integer(), label: text })), raisedAt: text, deadlines: Type.Object({ request: optionalText, hop: optionalText }), traceLength: Type.Integer(), latestAnnotation: Type.Optional(Type.Object({ context: optionalText, recommendation: optionalText })) })) });
export type DelegateRuntimeEscalations = Static<typeof RuntimeEscalationsSchema>;
const RuntimeEscalationMutationFields = Type.Object({ rootRunId: optionalText, requestId: optionalText, terminal: optionalBoolean, resolved: optionalBoolean, duplicate: optionalBoolean, selected: Type.Optional(Type.Array(Type.Integer())), selectedLabels: Type.Optional(strings), outcome: Type.Optional(Type.Object({ requestId: text, status: text, at: text }, { additionalProperties: true })), forwarded: Type.Optional(Type.Array(Type.Object({ requestId: text, rootRunId: text, holderId: text, holderKind: text, holderLabel: optionalText, hopDeadlineAt: optionalText }))), noops: Type.Optional(Type.Array(Type.Object({ requestId: text, rootRunId: text, status: optionalText, holderKind: optionalText, reason: optionalText }))), errors: Type.Optional(Type.Array(Type.Object({ requestId: text, rootRunId: text, error: text }))), reason: optionalText }, { additionalProperties: true });
export const RuntimeResolveEscalationSchema = Type.Intersect([RuntimeEscalationMutationFields, Type.Object({ rootRunId: text, requestId: text, outcome: Type.Object({ requestId: text, status: text, at: text }) }), Type.Union([
 Type.Object({ terminal: Type.Literal(true) }),
 Type.Object({ resolved: Type.Boolean(), duplicate: Type.Boolean(), selected: Type.Array(Type.Integer()), selectedLabels: strings }),
])]);
export const RuntimePassUpSchema = Type.Intersect([RuntimeEscalationMutationFields, Type.Required(Type.Pick(RuntimeEscalationMutationFields, ["forwarded", "noops", "errors"]))]);
export const RuntimeEscalationMutationSchema = Type.Union([RuntimeResolveEscalationSchema, RuntimePassUpSchema]);
export type DelegateRuntimeEscalationMutation = Static<typeof RuntimeEscalationMutationSchema>;
export interface DelegateRuntimeManagementRequest { action: ManagementAction; agent?: string; chainName?: string; agentScope?: "user" | "project" | "both"; config?: ManagementConfig }
export const RuntimeDefinitionSchema = Type.Object({ kind: Type.Union([Type.Literal("agent"), Type.Literal("chain")]), name: text, description: text, source: text, filePath: text, config: ManagementConfigSchema, envKeys: Type.Optional(strings) });
export type DelegateRuntimeDefinition = Static<typeof RuntimeDefinitionSchema>;
export const RuntimeManagementResultSchema = Type.Union([
 Type.Object({ action: Type.Union([Type.Literal("list"), Type.Literal("get")]), definitions: Type.Array(RuntimeDefinitionSchema), warnings: Type.Optional(strings) }),
 Type.Intersect([Type.Object({ action: Type.Union([Type.Literal("create"), Type.Literal("update"), Type.Literal("delete"), Type.Literal("canonicalize")]), filePath: text, scope: text, warnings: Type.Optional(strings), definitions: Type.Optional(Type.Never()) }), Type.Union([Type.Object({ agent: text }), Type.Object({ chainName: text })])]),
]);
export type DelegateRuntimeManagementResult = Static<typeof RuntimeManagementResultSchema>;
export const RuntimeHealthSchema = Type.Object({ activeRuns: Type.Number(), completedRuns: Type.Number(), registryActiveRuns: Type.Number(), registryCompletedRuns: Type.Number(), totalRunsInRegistry: Type.Number(), activeDetachedDrivers: Type.Number(), terminalDetachedDrivers: Type.Number(), detachedStatusDegraded: Type.Boolean(), detachedStatusTruncated: Type.Boolean(), agentSurfaces: Type.Array(Type.Object({ name: text, source: text, filePath: text, status: Type.Union([Type.Literal("OK"), Type.Literal("BROKEN"), Type.Literal("UNKNOWN")]), unresolvedSelectors: strings, uncertainSelectors: strings, missingPackages: strings })), agentSurfaceScanDegraded: Type.Boolean(), agentSurfaceScanTruncated: Type.Boolean(), agentSurfaceFilesRead: Type.Number(), runStateBytes: Type.Number(), driverStorageBytes: Type.Number(), eventBusDirBytes: Type.Number(), pendingWakes: Type.Number(), pendingDriverResults: Type.Number(), staleClaims: Type.Number(), maintenance: Type.Object({ running: Type.Boolean(), ticks: Type.Number(), startedAt: Type.Optional(Type.Number()), lastTickAt: Type.Optional(Type.Number()), lastSweepAt: Type.Optional(Type.Number()), lastError: optionalText }) });
export type DelegateRuntimeHealth = Static<typeof RuntimeHealthSchema>;
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
export function decodeRuntimeResult<S extends TSchema>(schema: S, value: unknown): Static<S> {
 if (!Value.Check(schema, value)) throw new RuntimeResultContractError(`Incompatible runtime result: ${Value.Errors(schema, value).First()?.path ?? "root"}`);
 return value;
}
