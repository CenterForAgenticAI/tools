import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { UserEvidence } from "../schema/workspec.js";
import type { CriterionAttempt, TreeIdentity, UserConfirmationProof, VerificationFailure } from "./results.js";

export interface SessionMessageEntry {
	id?: string;
	parentId?: string | null;
	timestamp?: string | number;
	type?: string;
	message?: unknown;
}

export interface SessionReader {
	getSessionId(): string;
	getSessionFile(): string | undefined;
	getBranch(): readonly SessionMessageEntry[];
}

export interface HostUserCapabilities {
	readonly hasUI: boolean;
	// The inner options keep the host SDK's exact shape: pi owns that signature, and
	// widening it here would make ctx.ui.confirm unassignable. Only the property
	// itself accepts undefined, which is what callers holding an optional pass.
	readonly confirm?: ((title: string, message: string, opts?: { signal?: AbortSignal; timeout?: number }) => Promise<boolean>) | undefined;
	readonly session?: SessionReader | undefined;
}

export interface UserRunInput {
	evidence: UserEvidence;
	specPath: string;
	nodeId: string;
	criterionId: string;
	tree: TreeIdentity;
}

export type UserRunOptions = SessionReader | { host: HostUserCapabilities; signal?: AbortSignal | undefined };

export type UserRunOutcome =
	| { outcome: "passed"; proof: UserConfirmationProof }
	| { outcome: "failed"; attempt: CriterionAttempt; failures: VerificationFailure[] };

function now(): string { return new Date().toISOString(); }

function sha(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

export function userChallenge(input: UserRunInput, sessionId: string): string {
	return sha([sessionId, input.tree.kind === "git" ? input.tree.resolvedCommit : "", input.specPath, input.nodeId, input.criterionId, sha(input.evidence.prompt)].join("\n")).slice(0, 32);
}

export function confirmationLine(challenge: string): string {
	return `I confirm ${challenge}`;
}

function contentText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value.flatMap((part: unknown) => {
		if (typeof part === "string") return [part];
		if (typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string") return [part.text];
		return [];
	}).join("");
}

function entryText(entry: SessionMessageEntry): string {
	if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null || !("role" in entry.message) || entry.message.role !== "user" || !("content" in entry.message)) return "";
	return contentText(entry.message.content);
}

function failure(code: VerificationFailure["code"], message: string, challenge?: string): VerificationFailure {
	if (code === "user-confirmation-required") return { code, message, challenge: challenge ?? "" };
	if (code === "user-not-confirmed") return { code, message };
	return { code: "session-unavailable", message };
}

function attemptFor(input: UserRunInput, startedAt: string, finishedAt: string): CriterionAttempt {
	return { kind: input.evidence.kind, evidence: input.evidence, startedAt, finishedAt, tree: input.tree };
}

function isHostOptions(options: UserRunOptions | undefined): options is { host: HostUserCapabilities; signal?: AbortSignal | undefined } {
	return typeof options === "object" && options !== null && "host" in options;
}

function timestampValue(value: string | number | undefined): string | undefined {
	if (typeof value === "number") return new Date(value).toISOString();
	return value;
}

function parseSessionFile(source: string): SessionMessageEntry[] {
	const entries: SessionMessageEntry[] = [];
	for (const line of source.split(/\r?\n/)) {
		if (line.trim().length === 0) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (typeof value === "object" && value !== null && "type" in value && typeof value.type === "string") entries.push(value as SessionMessageEntry);
		} catch {
			// Pi skips malformed JSONL lines; a valid confirmation must still be present.
		}
	}
	return entries;
}

async function hostBranch(session: SessionReader, sessionId: string, sessionFile: string): Promise<readonly SessionMessageEntry[]> {
	const source = await readFile(sessionFile, "utf8");
	const fileEntries = parseSessionFile(source);
	const header = fileEntries[0];
	if (!header || header.type !== "session") throw new Error("session file has no valid header");
	const branch = session.getBranch();
	const activeIds = new Set(branch.map((entry) => entry.id).filter((id): id is string => typeof id === "string"));
	if (activeIds.size === 0) return [];
	if (header.id && header.id !== sessionId) throw new Error("session file does not match the active session");
	return fileEntries.filter((entry) => typeof entry.id === "string" && activeIds.has(entry.id));
}

async function runLegacyUser(input: UserRunInput, session: SessionReader | undefined): Promise<UserRunOutcome> {
	const startedAt = now();
	const attempt = (finishedAt: string): CriterionAttempt => attemptFor(input, startedAt, finishedAt);
	if (!session) {
		const finishedAt = now();
		return { outcome: "failed", attempt: attempt(finishedAt), failures: [failure("session-unavailable", "session reader is unavailable")] };
	}
	let sessionId: string;
	let sessionFile: string | undefined;
	let branch: readonly SessionMessageEntry[];
	try {
		sessionId = session.getSessionId();
		sessionFile = session.getSessionFile();
		branch = session.getBranch();
	} catch (error) {
		const finishedAt = now();
		return { outcome: "failed", attempt: attempt(finishedAt), failures: [failure("session-unavailable", error instanceof Error ? error.message : String(error))] };
	}
	if (sessionId.length === 0 || !sessionFile) {
		const finishedAt = now();
		return { outcome: "failed", attempt: attempt(finishedAt), failures: [failure("session-unavailable", "explicit confirmation requires a persisted session")] };
	}
	const challenge = userChallenge(input, sessionId);
	const expected = confirmationLine(challenge);
	const entry = branch.find((candidate) => entryText(candidate) === expected);
	const finishedAt = now();
	if (!entry || !entry.id || entry.timestamp === undefined) {
		const message = `explicit confirmation required; reply with exactly: ${expected}`;
		return { outcome: "failed", attempt: attempt(finishedAt), failures: [{ code: "user-confirmation-required", message, challenge }] };
	}
	const entryTimestamp = timestampValue(entry.timestamp);
	if (!entryTimestamp) return { outcome: "failed", attempt: attempt(finishedAt), failures: [{ code: "user-confirmation-required", message: `explicit confirmation required; reply with exactly: ${expected}`, challenge }] };
	const proof: UserConfirmationProof = {
		kind: "user-proof", prompt: input.evidence.prompt, challenge, sessionId, sessionFile,
		entryId: entry.id, entryTimestamp, startedAt, finishedAt,
		durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)), tree: input.tree,
	};
	return { outcome: "passed", proof };
}

/** Capture confirmation from the host, or read the host's real session file. */
async function runHostUser(input: UserRunInput, host: HostUserCapabilities, signal?: AbortSignal): Promise<UserRunOutcome> {
	const startedAt = now();
	const attempt = (finishedAt: string): CriterionAttempt => attemptFor(input, startedAt, finishedAt);
	const session = host.session;
	if (!session) {
		const finishedAt = now();
		return { outcome: "failed", attempt: attempt(finishedAt), failures: [failure("session-unavailable", "host session manager is unavailable")] };
	}
	let sessionId: string;
	let sessionFile: string | undefined;
	try {
		sessionId = session.getSessionId();
		sessionFile = session.getSessionFile();
	} catch (error) {
		const finishedAt = now();
		return { outcome: "failed", attempt: attempt(finishedAt), failures: [failure("session-unavailable", error instanceof Error ? error.message : String(error))] };
	}
	if (sessionId.length === 0) {
		const finishedAt = now();
		return { outcome: "failed", attempt: attempt(finishedAt), failures: [failure("session-unavailable", "host session has no id")] };
	}
	const challenge = userChallenge(input, sessionId);
	const expected = confirmationLine(challenge);
	if (host.hasUI) {
		if (!host.confirm) {
			const finishedAt = now();
			return { outcome: "failed", attempt: attempt(finishedAt), failures: [failure("session-unavailable", "host UI confirmation is unavailable")] };
		}
		try {
			if (signal?.aborted) {
				const finishedAt = now();
				return { outcome: "failed", attempt: attempt(finishedAt), failures: [{ code: "verification-aborted", message: "verification was aborted before user confirmation" }] };
			}
			const accepted = await host.confirm("Confirm verification evidence", `${input.evidence.prompt}\n\nConfirm this exact challenge: ${expected}`, signal === undefined ? {} : { signal });
			const finishedAt = now();
			if (!accepted) return { outcome: "failed", attempt: attempt(finishedAt), failures: [failure("user-not-confirmed", "host confirmation was declined")] };
			if (signal?.aborted) return { outcome: "failed", attempt: attempt(finishedAt), failures: [{ code: "verification-aborted", message: "verification was aborted during user confirmation" }] };
			const proof: UserConfirmationProof = {
				kind: "user-proof", prompt: input.evidence.prompt, challenge, sessionId,
				sessionFile: sessionFile ?? "ui-confirmation", entryId: `ui:${sha(challenge)}`, entryTimestamp: finishedAt,
				startedAt, finishedAt, durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)), tree: input.tree,
			};
			return { outcome: "passed", proof };
		} catch (error) {
			const finishedAt = now();
			return { outcome: "failed", attempt: attempt(finishedAt), failures: [failure("session-unavailable", error instanceof Error ? error.message : String(error))] };
		}
	}
	if (!sessionFile) {
		const finishedAt = now();
		return { outcome: "failed", attempt: attempt(finishedAt), failures: [failure("session-unavailable", "non-UI confirmation requires the host session file")] };
	}
	try {
		const branch = await hostBranch(session, sessionId, sessionFile);
		const entry = branch.find((candidate) => entryText(candidate) === expected);
		const finishedAt = now();
		if (!entry || !entry.id || entry.timestamp === undefined) return { outcome: "failed", attempt: attempt(finishedAt), failures: [{ code: "user-confirmation-required", message: `explicit confirmation required; reply with exactly: ${expected}`, challenge }] };
		const entryTimestamp = timestampValue(entry.timestamp);
		if (!entryTimestamp) return { outcome: "failed", attempt: attempt(finishedAt), failures: [{ code: "user-confirmation-required", message: `explicit confirmation required; reply with exactly: ${expected}`, challenge }] };
		const proof: UserConfirmationProof = {
			kind: "user-proof", prompt: input.evidence.prompt, challenge, sessionId, sessionFile,
			entryId: entry.id, entryTimestamp, startedAt, finishedAt,
			durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)), tree: input.tree,
		};
		return { outcome: "passed", proof };
	} catch (error) {
		const finishedAt = now();
		return { outcome: "failed", attempt: attempt(finishedAt), failures: [failure("session-unavailable", error instanceof Error ? error.message : String(error))] };
	}
}

/** Legacy adapter seam. The authority passes a host capability object instead. */
export async function runUser(input: UserRunInput, options?: UserRunOptions): Promise<UserRunOutcome> {
	return isHostOptions(options) ? runHostUser(input, options.host, options.signal) : runLegacyUser(input, options);
}
