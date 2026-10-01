import type { Static, TSchema } from "typebox";
import { DelegateRuntimeError, type DelegateRuntimeToolResult } from "./runtime-api.js";
import { RuntimeInvocation, type RuntimeContextBinding, type DelegateRuntimeInvocationOptions } from "./runtime-invocation.js";
import { isSafeRunId } from "./run-id.js";
import { watch } from "node:fs";
import { resolveDelegateStateDir } from "./state-io.js";
import * as contract from "./runtime-contract.js";
import { getRunSnapshot, isLiveStatus, type RunLiveState } from "./runtime.js";
import { resolveRunEntryAlias } from "./fork-label.js";
import { CONTROL_ROUTE, ESCALATION_ROUTE } from "./control-surface.js";
import { RuntimeBoundaryError, type RuntimeToolName } from "./runtime-boundary.js";

export interface RuntimeOperationHost {
 agentDir: string;
 binding(): RuntimeContextBinding;
 invoke<T>(options: DelegateRuntimeInvocationOptions | undefined, retain: boolean, operation: (invocation: RuntimeInvocation) => Promise<T>): Promise<T>;
 call(name: RuntimeToolName, params: Record<string, unknown>, invocation: RuntimeInvocation): Promise<DelegateRuntimeToolResult>;
 observe(runId: string, invocation: RuntimeInvocation): () => void;
 inspectWait(runId: string): DelegateRuntimeToolResult | Promise<DelegateRuntimeToolResult>;
 observeDetached(runId: string, invocation: RuntimeInvocation): Promise<boolean>;
 require(result: DelegateRuntimeToolResult, operation: string): DelegateRuntimeToolResult;
 supports(capability: contract.DelegateRuntimeCapability): boolean;
}
/** First read-only liveness check after a wait starts. */
export const WAIT_LIVENESS_INITIAL_MS = 100;
/** Ceiling for the doubling liveness interval (CR-566-WAIT-DAEMON-POLL). */
export const WAIT_LIVENESS_MAX_MS = 2_000;
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}; }

/** Capture native addressing before an operation changes actionable entry state. */
export function resolveRuntimeForkName(action: "recover" | "steer" | "cancel", runId: string | undefined, forkName: string | undefined): string | undefined {
 if (forkName === undefined || runId === undefined) return forkName;
 const target = resolveRunEntryAlias({ requested: forkName, forks: getRunSnapshot(runId)?.forks,
  actionable: entry => action === "recover" ? entry.status === "failed" : isLiveStatus(entry.status as RunLiveState["status"]),
 });
 return target.kind === "exact" || target.kind === "resolved" ? target.name : forkName;
}
export function runtimeOperations(host: RuntimeOperationHost) {
 const decode = <S extends TSchema>(schema: S, value: unknown): Static<S> => {
  try { return contract.decodeRuntimeResult(schema, value); }
  catch (error) { throw new DelegateRuntimeError("unsupported-capability", "Installed core returned an incompatible structured result", error); }
 };
 const call = <S extends TSchema>(capability: contract.DelegateRuntimeCapability, name: RuntimeToolName, params: Record<string, unknown>, schema: S, options?: DelegateRuntimeInvocationOptions, field?: string): Promise<Static<S>> => host.invoke(options, false, async invocation => {
  if (capability === "manage" && !["list", "get", "create", "update", "delete", "canonicalize"].includes(String(params.action))) throw new DelegateRuntimeError("invalid-request", "manage requires an explicit management action");
  if (!host.supports(capability)) throw new DelegateRuntimeError("unsupported-capability", `Installed core does not support ${capability}`);
  // Resolve before recovery changes the source entry. Native results use the
  // canonical name even when the caller used a unique failed-entry display label.
  const expected = { ...params };
  if (capability === "recover" && typeof params.forkName === "string" && typeof params.runId === "string") {
   expected.forkName = resolveRuntimeForkName("recover", params.runId, params.forkName);
  }
  const response = await host.call(name, params, invocation);
  const detail = record(response.details);
  const partial = capability === "listRuns" && detail.degraded === true && (detail.errorCode === undefined || detail.errorCode === "core-error");
  const raw = partial ? response : host.require(response, capability);
  const result = decode(schema, field ? record(raw.details)[field] : raw.details);
  if (["recover", "promptStatus", "followUp", "uiAnswer", "resolveEscalation", "manage"].includes(capability)) contract.assertRuntimeCorrespondence(expected, result);
  const data = record(result);
  if (capability === "logs" && Array.isArray(data.dispatches)) for (const run of data.dispatches) contract.assertRuntimeCorrespondence({ runId: params.runId }, run);
  if (capability === "listEscalations" || capability === "passUpEscalations") {
   for (const key of capability === "listEscalations" ? ["escalations"] : ["forwarded", "noops", "errors"]) {
    for (const row of Array.isArray(data[key]) ? data[key] : []) {
     if (params.rootRunId !== undefined) contract.assertRuntimeCorrespondence({ rootRunId: params.rootRunId }, row);
     if (Array.isArray(params.requestIds) && !params.requestIds.includes(record(row).requestId)) throw new contract.RuntimeResultContractError("Mismatched escalation filter");
    }
   }
  }
  return result;
 });
 const status = (params: Record<string, unknown>, options?: DelegateRuntimeInvocationOptions) => call("listRuns", CONTROL_ROUTE.status, params, contract.RuntimeStatusSchema, options);
 return {
  listRuns: (options?: DelegateRuntimeInvocationOptions) => status({}, options),
  logs: async (request: contract.DelegateRuntimeLogsRequest, options?: DelegateRuntimeInvocationOptions): Promise<contract.DelegateRuntimeLogs> => {
   if (!isSafeRunId(request.runId)) throw new DelegateRuntimeError("invalid-request", "logs requires a safe runId");
   const result = await call("logs", CONTROL_ROUTE.status, { runId: request.runId, tail: request.tail, tailLines: request.tailLines }, contract.RuntimeStatusSchema, options);
   const run = result.dispatches[0];
   if (!run) return { kind: "unavailable", runId: request.runId, reason: "not-found" };
   const details = record(run.details);
   if (typeof details.childlogTail !== "string") return { kind: "unavailable", runId: request.runId, reason: "no-log" };
   return { kind: "available", runId: request.runId, text: details.childlogTail, truncated: details.childlogTailTruncated === true };
  },
  recover: (request: contract.DelegateRuntimeRecoverRequest, options?: DelegateRuntimeInvocationOptions) => call("recover", CONTROL_ROUTE.recover, { runId: request.runId, forkName: request.forkName, strategy: request.strategy, message: request.message }, contract.RuntimeRecoverySchema, options),
  promptStatus: (runId: string, options?: DelegateRuntimeInvocationOptions) => call("promptStatus", CONTROL_ROUTE.prompt_status, { runId }, contract.RuntimePromptStatusSchema, options),
  followUp: (request: contract.DelegateRuntimeFollowUpRequest, options?: DelegateRuntimeInvocationOptions) => call("followUp", CONTROL_ROUTE.follow_up, { runId: request.runId, message: request.message }, contract.RuntimeFollowUpSchema, options),
  uiAnswer: (request: contract.DelegateRuntimeUiAnswerRequest, options?: DelegateRuntimeInvocationOptions) => call("uiAnswer", CONTROL_ROUTE.ui_answer, { runId: request.runId, questionId: request.questionId, answer: request.answer }, contract.RuntimeUiAnswerSchema, options),
  listEscalations: (request: contract.DelegateRuntimeEscalationFilter = {}, options?: DelegateRuntimeInvocationOptions) => call("listEscalations", ESCALATION_ROUTE.list, { rootRunId: request.rootRunId, requestIds: request.requestIds }, contract.RuntimeEscalationsSchema, options),
  resolveEscalation: (request: contract.DelegateRuntimeResolveEscalationRequest, options?: DelegateRuntimeInvocationOptions) => call("resolveEscalation", ESCALATION_ROUTE.resolve, { rootRunId: request.rootRunId, requestId: request.requestId, selected: request.selected, customInstruction: request.customInstruction, note: request.note, onBehalfOfUser: request.onBehalfOfUser }, contract.RuntimeResolveEscalationSchema, options),
  passUpEscalations: (request: contract.DelegateRuntimePassUpRequest = {}, options?: DelegateRuntimeInvocationOptions) => call("passUpEscalations", ESCALATION_ROUTE.pass_up, { rootRunId: request.rootRunId, requestIds: request.requestIds, context: request.context, recommendation: request.recommendation }, contract.RuntimePassUpSchema, options),
  manage: (request: contract.DelegateRuntimeManagementRequest, options?: DelegateRuntimeInvocationOptions) => call("manage", "delegate", { action: request.action, agent: request.agent, chainName: request.chainName, agent_scope: request.agentScope, config: request.config }, contract.RuntimeManagementResultSchema, options, "managementResult"),
  health: (options?: DelegateRuntimeInvocationOptions) => call("health", "delegate", { action: "health" }, contract.RuntimeHealthSchema, options, "health"),
  wait: async (request: contract.DelegateRuntimeWaitRequest, options?: DelegateRuntimeInvocationOptions): Promise<contract.DelegateRuntimeWaitResult> => {
   if (options !== undefined && (options === null || typeof options !== "object" || (options.signal !== undefined && !(options.signal instanceof AbortSignal)) || (options.onUpdate !== undefined && typeof options.onUpdate !== "function"))) throw new DelegateRuntimeError("invalid-request", "Invalid wait invocation options");
   const { runId, timeoutMs } = request;
   if (!isSafeRunId(runId) || !Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) throw new DelegateRuntimeError("invalid-request", "wait requires a safe runId and finite timeoutMs in [0, 2147483647]");
   if (options?.signal?.aborted) return { kind: "aborted", runId };
   try {
    return await host.invoke(undefined, false, async lifetime => new Promise<contract.DelegateRuntimeWaitResult>(resolve => {
     let finished = false;
     let observer: RuntimeInvocation | undefined;
     const finish = (result: contract.DelegateRuntimeWaitResult) => { if (finished) return; finished = true; clearTimeout(timer); options?.signal?.removeEventListener("abort", abort); observer?.dispose(); resolve(result); };
     const abort = () => finish({ kind: "aborted", runId });
     const timer = setTimeout(() => finish({ kind: "timeout", runId }), timeoutMs);
     options?.signal?.addEventListener("abort", abort, { once: true });
     lifetime.own(() => finish({ kind: "unavailable", runId, reason: "context-invalidated" }));
     if (options?.signal?.aborted) { abort(); return; }
     void (async () => {
      if (!host.supports("wait")) throw new DelegateRuntimeError("unsupported-capability", "Installed core does not support wait");
      observer = new RuntimeInvocation(host.binding(), { onUpdate(update) {
       if ((update.kind === "accepted" ? update.acceptance.runId : update.runId) !== runId) { finish({ kind: "unavailable", runId, reason: "mismatched-result" }); return; }
       if (update.kind === "terminal") finish({ kind: "terminal", runId, state: update.state });
       if (options?.onUpdate) { try { void Promise.resolve(options.onUpdate(update)).catch(() => finish({ kind: "unavailable", runId, reason: "observer-error" })); } catch { finish({ kind: "unavailable", runId, reason: "observer-error" }); } }
      } });
      observer.own(() => { if (!finished) finish({ kind: "unavailable", runId, reason: "observation-ended" }); });
      // Subscribe before inspecting; an update cannot fall into a check/subscribe gap.
      observer.own(host.observe(runId, observer));
      observer.observeExisting();
      if (finished) return;
      let inspecting = false;
      const inspect = async () => {
       if (finished || inspecting) return;
       inspecting = true;
       try {
        const statuses = decode(contract.RuntimeStatusSchema, host.require(await host.inspectWait(runId), "wait").details);
        for (const run of statuses.dispatches) contract.assertRuntimeCorrespondence({ runId }, run);
        const status = statuses.dispatches[0];
        if (!finished && status?.state.startsWith("terminal-")) observer!.update({ kind: "terminal", runId, state: status.state });
       } catch { finish({ kind: "unavailable", runId, reason: "record-read-failed" }); }
       finally { inspecting = false; }
      };
      // Process death need not write a file or emit an event. Bound read-only
      // liveness checks by the same deadline and observer lifetime. Events,
      // record watches and the daemon attachment report ordinary progress, so
      // the fallback backs off: a daemon status check opens connections.
      let livenessDelay = WAIT_LIVENESS_INITIAL_MS;
      let livenessStopped = false;
      let liveness: ReturnType<typeof setTimeout> | undefined;
      const scheduleLiveness = () => {
       if (finished || livenessStopped) return;
       liveness = setTimeout(() => { void inspect().finally(scheduleLiveness); }, livenessDelay);
       livenessDelay = Math.min(livenessDelay * 2, WAIT_LIVENESS_MAX_MS);
      };
      observer.own(() => { livenessStopped = true; clearTimeout(liveness); });
      scheduleLiveness();
      let watchingRecords = false;
      try {
       const watcher = watch(resolveDelegateStateDir(host.agentDir), { recursive: true }, (_event, filename) => {
        if (!finished && filename?.includes(runId)) void inspect();
       });
       watcher.on("error", () => finish({ kind: "unavailable", runId, reason: "record-watch-failed" }));
       observer.own(() => watcher.close());
       watchingRecords = true;
      } catch { /* An in-process run needs only its event subscription. */ }
      const raw = host.require(await host.inspectWait(runId), "wait");
      if (finished) return;
      const statuses = decode(contract.RuntimeStatusSchema, raw.details);
      for (const row of statuses.dispatches) contract.assertRuntimeCorrespondence({ runId }, row);
      const run = statuses.dispatches[0];
      if (!run) { finish({ kind: "unavailable", runId, reason: "not-found" }); return; }
      if (run.state.startsWith("terminal-")) { observer.update({ kind: "terminal", runId, state: run.state }); return; }
      if (run.source === "detached" && !await host.observeDetached(runId, observer) && !watchingRecords) finish({ kind: "unavailable", runId, reason: "record-watch-unavailable" });
     })().catch(error => finish({ kind: "unavailable", runId, reason: error instanceof DelegateRuntimeError || error instanceof RuntimeBoundaryError ? error.code : "core-error" }));
    }));
   } catch (error) { return { kind: "unavailable", runId, reason: error instanceof DelegateRuntimeError || error instanceof RuntimeBoundaryError ? error.code : "core-error" }; }
  },
 };
}
