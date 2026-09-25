/** Local namespace-owner API. HTTP/operator authentication belongs to the host. */
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import {
	readOutcome,
	readEscalationRequest,
	resolveEscalation,
	resolveEscalationRequestsDir,
	resolveEscalationResultsDir,
	type EscalationOutcome, type EscalationRequest,
} from "./escalation-store.js";
import { listEscalationRootRunIds, readHeldEscalationRequest, summarizePayload } from "./escalation-surface.js";
import { normalizeEscalationSelection, renderRaiseOutcome } from "./escalation-tools.js";
import { applyRequestTimeout } from "./escalation-runtime.js";

export interface EscalationScope {
	agentDir: string;
	/** Supplied by the host's durable investigation/session bindings, never the response body. */
	ownerSessionIds: readonly string[];
}

export interface OperatorEscalationResponse extends EscalationScope {
	rootRunId: string;
	requestId: string;
	raiserRunId: string;
	selected: number[];
	customInstruction?: string;
	note?: string;
	claimedBy: string;
}

export class EscalationResponseError extends Error {
	constructor(readonly code: "not-found" | "wrong-raiser" | "not-user-held" | "busy" | "invalid-selection", message: string) {
		super(message);
	}
}

function contained(root: string, file: string): boolean {
	const path = relative(realpathSync(root), realpathSync(file));
	return !path.startsWith("..") && !isAbsolute(path);
}

function readRequest(args: { agentDir: string; rootRunId: string; requestId: string }) {
	const file = join(resolveEscalationRequestsDir(args.agentDir, args.rootRunId), `${args.requestId}.json`);
	try {
		if (!contained(args.agentDir, file)) return null;
		const owned = readHeldEscalationRequest(args);
		return owned && readEscalationRequest({ ...args, credential: owned.replyEndpoint.credential });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

function received(scope: EscalationScope, request: EscalationRequest, outcome: EscalationOutcome): boolean {
	if (!request.consumer) return false;
	let text: string;
	try {
		if (!contained(scope.agentDir, request.consumer.sessionFile)) throw new Error("consumer transcript escapes agent directory");
		text = readFileSync(request.consumer.sessionFile, "utf8");
	}
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	// A concurrently appended final line is not durable receipt evidence yet.
	const expected = renderRaiseOutcome(request.requestId, request.kind, request.payload, outcome);
	const entries = parseSessionEntries(text.slice(0, text.lastIndexOf("\n") + 1));
	return entries.some((entry) => {
		const message = entry?.type === "message" ? entry.message : undefined;
		return message?.role === "toolResult" && message.toolCallId === request.consumer!.toolCallId &&
			message.isError !== true &&
			isDeepStrictEqual(message.content, expected.content) &&
			Object.entries(expected.details).every(([key, value]) => isDeepStrictEqual(message.details?.[key], value));
	});
}

function snapshot(scope: EscalationScope, request: EscalationRequest) {
	const resultFile = join(resolveEscalationResultsDir(scope.agentDir, request.rootRunId), `${request.requestId}.json`);
	if (existsSync(resultFile) && !contained(scope.agentDir, resultFile)) throw new Error("escalation result escapes agent directory");
	const outcome = readOutcome({ ...scope, rootRunId: request.rootRunId, requestId: request.requestId,
		credential: request.replyEndpoint.credential });
	const holder = request.chain[request.holderIndex];
	return {
		requestId: request.requestId, rootRunId: request.rootRunId, raiserRunId: request.raiser.runId,
		consumerSessionId: request.consumer?.sessionId ?? null,
		ownerSessionId: request.ownerSessionId!, kind: request.kind, summary: summarizePayload(request),
		holder: { id: holder.id, kind: holder.kind, position: holder.kind === "user" ? "user-held" : holder.kind === "root" ? "root-held" : "below-root" },
		resolutionOptions: request.resolutionOptions.map((option, index) => ({ ...option, index })),
		multi: request.kind === "decision" && "multi" in request.payload && request.payload.multi === true,
		raisedAt: request.raisedAt,
		state: outcome === null ? "pending" as const
			: received(scope, request, outcome) ? "received" as const : outcome.status,
		outcome,
	};
}

export type EscalationSnapshot = ReturnType<typeof snapshot>;

export function inspectEscalations(scope: EscalationScope): EscalationSnapshot[] {
	const requests: EscalationSnapshot[] = [];
	for (const rootRunId of listEscalationRootRunIds(scope.agentDir)) {
		try {
			const directory = resolveEscalationRequestsDir(scope.agentDir, rootRunId);
			if (!contained(scope.agentDir, directory)) continue;
			for (const name of readdirSync(directory).sort()) {
				if (!name.endsWith(".json")) continue;
				const request = readRequest({ ...scope, rootRunId, requestId: name.slice(0, -5) });
				if (request?.ownerSessionId && scope.ownerSessionIds.includes(request.ownerSessionId)) requests.push(snapshot(scope, request));
			}
		} catch (error) {
			// Retention may remove a namespace after discovery.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return requests;
}

/** Resolve an explicit operator response through the canonical outcome writer. */
export function resolveOperatorEscalation(args: OperatorEscalationResponse): EscalationSnapshot {
	if (args.note !== undefined && typeof args.note !== "string") throw new EscalationResponseError("invalid-selection", "note must be a string");
	if (!args.claimedBy?.trim()) throw new EscalationResponseError("invalid-selection", "operator identity must not be empty");
	const request = readRequest(args);
	if (!request?.ownerSessionId || !args.ownerSessionIds.includes(request.ownerSessionId)) throw new EscalationResponseError("not-found", "escalation not found in owner scope");
	if (request.raiser.runId !== args.raiserRunId) throw new EscalationResponseError("wrong-raiser", "escalation raiser mismatch");
	const current = snapshot(args, request);
	if (current.outcome) return current;
	if (request.timeout.deadlineAt && Date.parse(request.timeout.deadlineAt) <= Date.now()) {
		applyRequestTimeout(args.agentDir, request, new Date());
		return snapshot(args, request);
	}
	const holder = request.chain[request.holderIndex];
	if (holder.kind !== "user") throw new EscalationResponseError("not-user-held", "escalation is not user-held");
	const customInstruction = args.customInstruction?.trim() || undefined;
	let selected: number[];
	try { selected = normalizeEscalationSelection(args.selected, request, customInstruction); }
	catch (error) { throw new EscalationResponseError("invalid-selection", (error as Error).message); }
	resolveEscalation({
		agentDir: args.agentDir,
		rootRunId: args.rootRunId,
		requestId: args.requestId,
		credential: request.replyEndpoint.credential,
		resolution: { selected, customInstruction, note: args.note, resolvedBy: args.claimedBy },
	});
	return snapshot(args, request);
}
