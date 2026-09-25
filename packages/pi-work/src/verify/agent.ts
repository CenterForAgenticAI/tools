import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { AgentEvidence } from "../schema/workspec.js";
import type { AgentJudgmentProof, CriterionAttempt, NamedInputDigest, TreeIdentity, VerificationFailure } from "./results.js";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;

export interface AgentInput {
	authoredPath: string;
	canonicalPath: string;
	bytes: Uint8Array;
	digest: string;
}

export interface AgentJudgeRequest {
	agent: string;	rubric: string;
	inputs: readonly AgentInput[];
	tree: TreeIdentity;
	signal?: AbortSignal | undefined;
}

export type AgentVerdict =
	| { verdict: "approve"; dispatchReceipt: string; inputDigests: readonly string[] }
	| { verdict: "reject"; dispatchReceipt?: string; reason: string }
	| { verdict: "unavailable"; reason: string }
	| { verdict: "infrastructure-failure"; reason: string };

export type AgentJudge = (request: AgentJudgeRequest) => Promise<AgentVerdict>;

export interface AgentRunnerOptions {
	judge?: AgentJudge | undefined;
	maxInputBytes?: number | undefined;
}

export type AgentRunOutcome =
	| { outcome: "passed"; proof: AgentJudgmentProof }
	| { outcome: "failed"; attempt: CriterionAttempt; failures: VerificationFailure[] };

function digest(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function now(): string { return new Date().toISOString(); }

function failure(code: VerificationFailure["code"], message: string, authoredPath = ""): VerificationFailure {
	if (code === "agent-inputs-empty") return { code, message };
	if (code === "verification-aborted") return { code, message };
	if (code === "input-missing") return { code, message, path: authoredPath };
	if (code === "input-unreadable") return { code, message, path: authoredPath };
	if (code === "input-not-file") return { code, message, path: authoredPath };
	if (code === "input-too-large") return { code, message, path: authoredPath };
	if (code === "input-path-escape") return { code, message, path: authoredPath };
	if (code === "agent-unavailable") return { code, message };
	if (code === "agent-rejected") return { code, message };
	if (code === "agent-malformed") return { code, message };
	if (code === "dispatch-failed") return { code, message };
	return { code: "agent-malformed", message };
}

function isPathInside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function loadInput(root: string, authoredPath: string, maxBytes: number): Promise<{ ok: true; input: AgentInput } | { ok: false; failure: VerificationFailure }> {
	if (path.isAbsolute(authoredPath)) return { ok: false, failure: failure("input-path-escape", "agent input must be relative to the target worktree", authoredPath) };
	const candidate = path.resolve(root, authoredPath);
	try {
		const canonicalPath = await realpath(candidate);
		if (!isPathInside(root, canonicalPath)) return { ok: false, failure: failure("input-path-escape", "agent input resolves outside the target worktree", authoredPath) };
		const info = await stat(canonicalPath);
		if (!info.isFile()) return { ok: false, failure: failure("input-not-file", "agent input is not a regular file", authoredPath) };
		if (info.size > maxBytes) return { ok: false, failure: failure("input-too-large", `agent input exceeds ${maxBytes} bytes`, authoredPath) };
		const bytes = await readFile(canonicalPath);
		return { ok: true, input: { authoredPath, canonicalPath, bytes, digest: digest(bytes) } };
	} catch (error) {
		const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "";
		const failureCode = code === "EACCES" || code === "EPERM" ? "input-unreadable" : "input-missing";
		return { ok: false, failure: failure(failureCode, error instanceof Error ? error.message : String(error), authoredPath) };
	}
}

function unavailableJudge(): Promise<AgentVerdict> {
	return Promise.resolve({ verdict: "unavailable", reason: "pi-delegate programmatic judgment is not available in v1 (pi-delegate #82)" });
}

function isAgentVerdict(value: unknown): value is AgentVerdict {
	if (typeof value !== "object" || value === null || !("verdict" in value) || typeof value.verdict !== "string") return false;
	if (value.verdict === "approve") return "dispatchReceipt" in value && typeof value.dispatchReceipt === "string" && value.dispatchReceipt.trim().length > 0 && "inputDigests" in value && Array.isArray(value.inputDigests) && value.inputDigests.every((item: unknown) => typeof item === "string");
	return (value.verdict === "reject" || value.verdict === "unavailable" || value.verdict === "infrastructure-failure") && "reason" in value && typeof value.reason === "string";
}

/** Read and hash all named artifacts before the future pi-delegate judgment adapter. */
export async function runAgent(input: { evidence: AgentEvidence; tree: TreeIdentity; signal?: AbortSignal | undefined }, options: AgentRunnerOptions = {}): Promise<AgentRunOutcome> {
	const startedAt = now();
	const attemptFor = (finishedAt: string): CriterionAttempt => ({ kind: input.evidence.kind, evidence: input.evidence, startedAt, finishedAt, tree: input.tree });
	const maxBytes = options.maxInputBytes ?? MAX_INPUT_BYTES;
	if (input.evidence.inputs.length === 0) {
		const finishedAt = now();
		return { outcome: "failed", attempt: attemptFor(finishedAt), failures: [failure("agent-inputs-empty", "agent evidence requires at least one named input")] };
	}
	if (input.signal?.aborted) {
		const finishedAt = now();
		return { outcome: "failed", attempt: attemptFor(finishedAt), failures: [failure("verification-aborted", "verification was aborted before agent dispatch")] };
	}
	const loaded: AgentInput[] = [];
	for (const authoredPath of input.evidence.inputs) {
		const result = await loadInput(input.tree.worktreePath, authoredPath, maxBytes);
		if (!result.ok) {
			const finishedAt = now();
			return { outcome: "failed", attempt: attemptFor(finishedAt), failures: [result.failure] };
		}
		loaded.push(result.input);
		if (input.signal?.aborted) {
			const finishedAt = now();
			return { outcome: "failed", attempt: attemptFor(finishedAt), failures: [failure("verification-aborted", "verification was aborted while loading agent inputs")] };
		}
	}
	if (input.signal?.aborted) {
		const finishedAt = now();
		return { outcome: "failed", attempt: attemptFor(finishedAt), failures: [failure("verification-aborted", "verification was aborted before agent dispatch")] };
	}
	let verdict: AgentVerdict;
	try {
		verdict = await (options.judge ?? ((_request: AgentJudgeRequest) => unavailableJudge()))({ agent: input.evidence.agent, rubric: input.evidence.rubric, inputs: loaded, tree: input.tree, signal: input.signal });
	} catch (error) {
		const finishedAt = now();
		return { outcome: "failed", attempt: attemptFor(finishedAt), failures: [failure("dispatch-failed", error instanceof Error ? error.message : String(error))] };
	}
	const finishedAt = now();
	const attempt = attemptFor(finishedAt);
	if (input.signal?.aborted) return { outcome: "failed", attempt, failures: [failure("verification-aborted", "verification was aborted during agent dispatch")] };
	if (!isAgentVerdict(verdict)) return { outcome: "failed", attempt, failures: [failure("agent-malformed", "agent judge returned a malformed verdict")] };
	if (verdict.verdict === "unavailable") return { outcome: "failed", attempt, failures: [failure("agent-unavailable", verdict.reason)] };
	if (verdict.verdict === "infrastructure-failure") return { outcome: "failed", attempt, failures: [failure("dispatch-failed", verdict.reason)] };
	if (verdict.verdict === "reject") return { outcome: "failed", attempt, failures: [failure("agent-rejected", verdict.reason)] };
	const expectedDigests = loaded.map((item) => item.digest);
	const actualDigests = [...verdict.inputDigests];
	if (expectedDigests.length !== actualDigests.length || expectedDigests.some((item, index) => item !== actualDigests[index])) {
		return { outcome: "failed", attempt, failures: [failure("agent-malformed", "approved judgment did not account for every input digest in order")] };
	}
	const digestValues = loaded.map((item) => ({ path: item.canonicalPath, digest: item.digest, bytes: item.bytes.byteLength }));
	const [firstDigest, ...restDigests] = digestValues;
	if (!firstDigest) return { outcome: "failed", attempt, failures: [failure("agent-malformed", "approved judgment contained no named input proof")] };
	const inputDigests: [NamedInputDigest, ...NamedInputDigest[]] = [firstDigest, ...restDigests];
	if (input.signal?.aborted) return { outcome: "failed", attempt, failures: [failure("verification-aborted", "verification was aborted before agent proof construction")] };
	const proof: AgentJudgmentProof = {
		kind: "agent-proof",
		agent: input.evidence.agent,
		rubric: input.evidence.rubric,
		rubricDigest: digest(Buffer.from(input.evidence.rubric, "utf8")),
		inputs: inputDigests,
		verdict: "approve",
		dispatchReceipt: verdict.dispatchReceipt,
		startedAt,
		finishedAt,
		durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
		tree: input.tree,
	};
	return { outcome: "passed", proof };
}

export { MAX_INPUT_BYTES };
