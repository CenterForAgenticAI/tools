import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { firstSchemaIssue } from "./schema-errors.js";
import { CONTROL_ROUTE, ESCALATION_ROUTE, resolveControlCall, resolveEscalationCall, type ControlAction, type EscalationAction } from "./control-surface.js";
import { prepareRuntimeDispatchArguments } from "./delegate-params.js";
import { UnsupportedRunOptionError } from "./delegate-runs.js";
import { isSafeRunId } from "./run-id.js";

export class RuntimeBoundaryError extends Error {
 constructor(readonly code: "invalid-request" | "authorization-denied" | "unsupported-option", message: string) { super(message); }
}

/** Validate before projection: unknown envelope fields cannot become executor input. */
export function prepareRuntimeToolArguments(name: string, schema: TSchema, input: Record<string, unknown>, grants: { control?: readonly string[]; escalation?: readonly string[]; workerDenied: boolean }): Record<string, unknown> {
 if (input === null || typeof input !== "object" || Array.isArray(input)) throw new RuntimeBoundaryError("invalid-request", "Tool arguments must be an object");
 if (name === "delegate") {
  try {
   if (Object.hasOwn(input, "action") && input.action === undefined) throw new RuntimeBoundaryError("invalid-request", "Management action must not be undefined");
   return prepareRuntimeDispatchArguments(input);
  }
  catch (error) { throw new RuntimeBoundaryError(error instanceof UnsupportedRunOptionError ? "unsupported-option" : "invalid-request", error instanceof Error ? error.message : "Invalid dispatch"); }
 }
 if ((name === "delegate_control" || name === "delegate_escalation") && (typeof input.action !== "string" || !(input.action in (name === "delegate_control" ? CONTROL_ROUTE : ESCALATION_ROUTE)))) {
  try { if (name === "delegate_control") resolveControlCall(input); else resolveEscalationCall(input); }
  catch (error) { throw new RuntimeBoundaryError("invalid-request", error instanceof Error ? error.message : "Invalid action"); }
 }
 if (input.forkName === "") throw new RuntimeBoundaryError("invalid-request", "invalid entry name: forkName must be nonblank");
 // Omitted JS optionals are absent, exactly as they are on the wire.
 const properties: Record<string, TSchema> = {};
 const declared = (schema as { properties?: Record<string, TSchema & { enum?: unknown }> }).properties ?? {};
 for (const [key, field] of Object.entries(declared)) properties[key] = Array.isArray(field.enum) ? { ...field, ...Type.Union(field.enum.map((value: string) => Type.Literal(value))) } : field;
 schema = { ...schema, properties } as TSchema;
 const params: Record<string, unknown> = {};
 for (const key of Object.keys(properties)) if (input[key] !== undefined) params[key] = input[key];
 if (!Value.Check(schema, params)) {
  const error = firstSchemaIssue(schema, params);
  throw new RuntimeBoundaryError("invalid-request", `${error?.path ?? name}: ${error?.message ?? "invalid parameters"}`);
 }
 for (const key of ["runId", "rootRunId", "requestId"]) {
  if (params[key] !== undefined && (typeof params[key] !== "string" || !isSafeRunId(params[key]))) throw new RuntimeBoundaryError("invalid-request", `${key} must be a safe identifier`);
 }
 if (Array.isArray(params.requestIds) && params.requestIds.some((id) => typeof id !== "string" || !isSafeRunId(id))) throw new RuntimeBoundaryError("invalid-request", "requestIds must contain safe identifiers");
 for (const key of ["forkName", "questionId"]) if (params[key] !== undefined && (typeof params[key] !== "string" || !params[key].trim() || /[\0\r\n]/.test(params[key]))) throw new RuntimeBoundaryError("invalid-request", `${key} must be nonblank and contain no control lines`);
 const control = Object.entries(CONTROL_ROUTE).find(([, route]) => route === name)?.[0];
 const escalation = Object.entries(ESCALATION_ROUTE).find(([, route]) => route === name)?.[0];
 const controlAction = name === "delegate_control" ? params.action : control;
 const escalationAction = name === "delegate_escalation" ? params.action : escalation;
 try {
  if (typeof controlAction === "string") resolveControlCall({ ...params, action: controlAction }, { workerDenied: grants.workerDenied, grantedActions: grants.control });
  if (typeof escalationAction === "string") resolveEscalationCall({ ...params, action: escalationAction }, { grantedActions: grants.escalation });
 } catch (error) {
  const denied = typeof controlAction === "string" && ((grants.workerDenied && controlAction === "recover") || (grants.control !== undefined && !grants.control.includes(controlAction))) || typeof escalationAction === "string" && grants.escalation !== undefined && !grants.escalation.includes(escalationAction);
  throw new RuntimeBoundaryError(denied ? "authorization-denied" : "invalid-request", error instanceof Error ? error.message : "Invalid action");
 }
 return Value.Clone(params);
}

export type RuntimeToolName = "delegate" | "delegate_control" | "delegate_escalation" | typeof CONTROL_ROUTE[ControlAction] | typeof ESCALATION_ROUTE[EscalationAction];

