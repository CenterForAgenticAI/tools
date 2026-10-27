/**
 * Session skill registry for `load_skill` (pi-context-aware#181).
 *
 * Every `load_skill` call that returns a body appends one custom entry of type
 * {@link SKILL_REGISTRY_ENTRY_TYPE}. The registry is that list of entries on the
 * current branch, so it survives a restart and follows branch switches without a
 * separate store. The state of a load (visible, compressed, partial, gone) is
 * never stored: it is derived from the branch each time, so it cannot drift from
 * what the fold engine and Pi's compaction actually did.
 *
 * - **visible**: the tool result that carried the body is still sent to the model,
 *   with the same text it was delivered with.
 * - **compressed**: an active native fold record (`context-aware.fold.v1`) covers
 *   that result. billion-context-pi folds are not read here; while it owns
 *   compression, `load_skill` always returns the body (see `pointersEnabled`).
 * - **partial**: the body did not reach the transcript in full. A load made by
 *   another tool (Fabric's `fabric_exec`, a Jev program) runs with a nested tool
 *   call id and its result goes to that program, which may cut it. A visible
 *   result whose text no longer matches what was delivered is partial too.
 * - **gone**: the result is not on this branch or not in context any more, for
 *   example after a compaction.
 *
 * Protection keys on the exact recorded result, not on the tool name: the fold
 * kernel's `isToolProtected(toolName, text)` hook is answered by comparing the
 * sha256 of the message text with the result hashes this registry recorded.
 * That protection is proven against the kernel (`planFold`) only; production
 * compression is billion-context-pi until pi-context-aware#137.
 */

import { createHash } from "node:crypto";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

import { foldStateFromBranch } from "../folds/fold-adapter.js";
import { coveredEntryIds } from "../folds/fold-entries.js";
import { stripLeadingTag } from "../folds/kernel/ccr.js";
import { BLOCKED_REF, refForRaw } from "../folds/kernel/refs.js";

/** Custom entry type of one recorded skill load. */
export const SKILL_REGISTRY_ENTRY_TYPE = "context-aware.skill-registry.v1";

/** The tool whose results this registry tracks. */
export const LOAD_SKILL_TOOL_NAME = "load_skill";

/** One recorded skill load, as persisted in a custom entry. */
export interface SkillLoadRecord {
	readonly version: 1;
	readonly name: string;
	readonly path: string;
	/** sha256 of the SKILL.md text that was read. */
	readonly bodyHash: string;
	/** sha256 of the full tool result text, header included. */
	readonly resultHash: string;
	readonly bytes: number;
	readonly toolCallId: string;
	/** The tool call that made this load, when another tool made it. */
	readonly parentToolCallId?: string;
	/** `partial` when the body went to another tool rather than the transcript. */
	readonly delivery: "full" | "partial";
	readonly loadedAt: string;
}

/** Derived state of one recorded load on the current branch. */
export type SkillLoadState =
	| { readonly kind: "visible"; readonly entryId: string; readonly ref?: string }
	| { readonly kind: "compressed"; readonly entryId: string; readonly blockId: string }
	| { readonly kind: "partial"; readonly reason: "nested" | "edited" }
	| { readonly kind: "gone" };

/** One loaded skill as `/context-status` and the context service report it. */
export interface LoadedSkillView {
	readonly name: string;
	readonly path: string;
	readonly bytes: number;
	readonly state: SkillLoadState["kind"];
	readonly ref?: string;
	readonly blockId?: string;
	readonly loadedAt: string;
}

/** What `load_skill` should return for a skill it is about to deliver. */
export type RepeatDecision =
	| { readonly kind: "pointer"; readonly text: string; readonly details: Readonly<Record<string, unknown>> }
	| { readonly kind: "body"; readonly changed: boolean; readonly reason: RepeatReason };

export type RepeatReason = "first" | "force" | "changed" | "partial" | "gone" | "pointers-off" | "restore-unavailable";

export function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function isRecord(value: unknown): value is SkillLoadRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return record.version === 1
		&& typeof record.name === "string"
		&& typeof record.path === "string"
		&& typeof record.bodyHash === "string"
		&& typeof record.resultHash === "string"
		&& typeof record.bytes === "number"
		&& typeof record.toolCallId === "string"
		&& (record.parentToolCallId === undefined || typeof record.parentToolCallId === "string")
		&& (record.delivery === "full" || record.delivery === "partial")
		&& typeof record.loadedAt === "string";
}

/** Every valid skill load record on a branch, oldest first. Malformed entries are skipped. */
export function skillRecordsOnBranch(branch: readonly SessionEntry[]): SkillLoadRecord[] {
	const records: SkillLoadRecord[] = [];
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== SKILL_REGISTRY_ENTRY_TYPE) continue;
		if (isRecord(entry.data)) records.push(entry.data);
	}
	return records;
}

function resultTextOf(entry: SessionEntry): string | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message as { role?: unknown; content?: unknown };
	if (message.role !== "toolResult" || !Array.isArray(message.content)) return undefined;
	return message.content
		.flatMap((part: { type?: unknown; text?: unknown }) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
		.join("\n");
}

function resultEntryId(branch: readonly SessionEntry[], toolCallId: string): string | undefined {
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: unknown; toolCallId?: unknown };
		if (message.role === "toolResult" && message.toolCallId === toolCallId) return entry.id;
	}
	return undefined;
}

/**
 * Derive the state of a recorded load from the branch and the entries Pi still
 * sends to the model.
 */
export function skillStateOf(
	record: SkillLoadRecord,
	branch: readonly SessionEntry[],
	contextEntries: readonly SessionEntry[],
): SkillLoadState {
	if (record.delivery === "partial") return { kind: "partial", reason: "nested" };
	const entryId = resultEntryId(branch, record.toolCallId);
	if (!entryId) return { kind: "gone" };
	const folds = foldStateFromBranch(branch, contextEntries);
	const covering = folds.active.find((fold) => coveredEntryIds(fold).includes(entryId));
	if (covering) return { kind: "compressed", entryId, blockId: covering.blockId };
	const visible = contextEntries.find((entry) => entry.id === entryId);
	if (!visible) return { kind: "gone" };
	const text = resultTextOf(visible);
	if (text === undefined || sha256(text) !== record.resultHash) return { kind: "partial", reason: "edited" };
	const ref = refForRaw(folds.kernel.messageRefs, entryId);
	return { kind: "visible", entryId, ...(ref && ref !== BLOCKED_REF ? { ref } : {}) };
}

function latestFor(records: readonly SkillLoadRecord[], path: string): SkillLoadRecord | undefined {
	for (let index = records.length - 1; index >= 0; index -= 1) {
		if (records[index]!.path === path) return records[index];
	}
	return undefined;
}

/** The newest load of each skill path on the branch, with its derived state. */
export function loadedSkills(branch: readonly SessionEntry[], contextEntries: readonly SessionEntry[]): LoadedSkillView[] {
	const records = skillRecordsOnBranch(branch);
	const newest = new Map<string, SkillLoadRecord>();
	for (const record of records) newest.set(record.path, record);
	return [...newest.values()].map((record) => {
		const state = skillStateOf(record, branch, contextEntries);
		return {
			name: record.name,
			path: record.path,
			bytes: record.bytes,
			state: state.kind,
			...(state.kind === "visible" && state.ref ? { ref: state.ref } : {}),
			...(state.kind === "compressed" ? { blockId: state.blockId } : {}),
			loadedAt: record.loadedAt,
		};
	});
}

/** Input to {@link decideRepeat}. */
export interface RepeatInput {
	readonly name: string;
	readonly path: string;
	readonly body: string;
	readonly force: boolean;
	readonly pointersEnabled: boolean;
	readonly restoreInvocation: string | undefined;
	readonly branch: readonly SessionEntry[];
	readonly contextEntries: readonly SessionEntry[];
}

/**
 * Decide whether a load returns the body or a pointer to an earlier copy.
 *
 * A pointer is returned only when the native fold engine owns compression, the
 * caller did not pass `force`, the file is unchanged since the newest load of the
 * same path, and that load reached the transcript in full and is still visible or
 * folded by a native fold that this session can restore.
 */
export function decideRepeat(input: RepeatInput): RepeatDecision {
	const previous = latestFor(skillRecordsOnBranch(input.branch), input.path);
	if (!previous) return { kind: "body", changed: false, reason: "first" };
	const changed = previous.bodyHash !== sha256(input.body);
	if (changed) return { kind: "body", changed: true, reason: "changed" };
	if (input.force) return { kind: "body", changed: false, reason: "force" };
	if (!input.pointersEnabled) return { kind: "body", changed: false, reason: "pointers-off" };
	const state = skillStateOf(previous, input.branch, input.contextEntries);
	if (state.kind === "partial") return { kind: "body", changed: false, reason: "partial" };
	if (state.kind === "gone") return { kind: "body", changed: false, reason: "gone" };
	if (state.kind === "visible") {
		const where = state.ref ? `at ${state.ref}` : `in the result of tool call ${previous.toolCallId}`;
		return {
			kind: "pointer",
			text: `Skill "${input.name}" is already loaded ${where} (unchanged). Re-read that result; do not load it again. Pass force: true only if you need a fresh copy.`,
			details: { name: input.name, path: input.path, pointer: "visible", toolCallId: previous.toolCallId, ...(state.ref ? { ref: state.ref } : {}) },
		};
	}
	if (input.restoreInvocation === undefined) return { kind: "body", changed: false, reason: "restore-unavailable" };
	return {
		kind: "pointer",
		text: `Skill "${input.name}" was loaded earlier and is now folded into block ${state.blockId} (unchanged). Restore it with ${input.restoreInvocation}({ blockId: "${state.blockId}" }); do not load it again. Pass force: true only if the block cannot be restored.`,
		details: { name: input.name, path: input.path, pointer: "compressed", blockId: state.blockId, toolCallId: previous.toolCallId },
	};
}

/** The session reads the registry needs; a host shim may lack any of them. */
export type SkillSessionReader = Partial<Pick<SessionManager, "getBranch" | "buildContextEntries" | "buildSessionProjection">>;

/**
 * The entries the model sees, with context edits applied. Pi applies a
 * `context_edit` only in its projection, so a message entry is rebuilt from its
 * projected message when the projection is available.
 */
export function modelVisibleEntries(session: SkillSessionReader, branch: readonly SessionEntry[]): SessionEntry[] {
	if (typeof session.buildSessionProjection === "function") {
		return session.buildSessionProjection().entries.map(({ sourceEntry, messages }) =>
			sourceEntry.type === "message" && messages.length === 1 ? { ...sourceEntry, message: messages[0]! } as SessionEntry : sourceEntry);
	}
	if (typeof session.buildContextEntries === "function") return session.buildContextEntries();
	return [...branch];
}

/** Loaded skills on the session's current branch; empty when the session cannot be read. */
export function loadedSkillsOf(session: SkillSessionReader): LoadedSkillView[] {
	if (typeof session.getBranch !== "function") return [];
	const branch = session.getBranch();
	return loadedSkills(branch, modelVisibleEntries(session, branch));
}

/** The `/context-status` line block for loaded skills. */
export function formatLoadedSkills(views: readonly LoadedSkillView[]): string {
	if (views.length === 0) return "Loaded skills: none";
	const lines = views.map((view) => {
		const where = view.state === "visible" && view.ref ? ` at ${view.ref}`
			: view.state === "compressed" && view.blockId ? ` in block ${view.blockId}` : "";
		return `  ${view.name}: ${view.state}${where}, ${view.bytes.toLocaleString("en-US")} bytes`;
	});
	return `Loaded skills (${views.length}):\n${lines.join("\n")}`;
}

/** The calls `load_skill` makes into the registry. */
export interface SkillLoadHooks {
	decide(input: { name: string; path: string; body: string; force: boolean; sessionManager?: SkillSessionReader }): RepeatDecision;
	record(input: { toolCallId: string; name: string; path: string; body: string; resultText: string }): void;
}

/** The session-wide registry the extension wires into `load_skill` and the fold engine. */
export interface SkillRegistry {
	readonly hooks: SkillLoadHooks;
	/** Fold kernel hook: protects exactly the recorded `load_skill` results. */
	isToolProtected(toolName: string, text?: string): boolean;
	/** Note a `tool_call` event, so a nested load knows the call that made it. */
	noteToolCall(event: { toolCallId: string; toolName: string; parentToolCallId?: string }): void;
	/** Rebuild the in-memory protection set from a branch (session start or switch). */
	reset(branch: readonly SessionEntry[]): void;
}

export interface SkillRegistryOptions {
	/** Persist one record. In production `pi.appendEntry`. */
	readonly append: (customType: string, data: SkillLoadRecord) => void;
	/** True while the native fold engine owns compression (billion-context-pi is not loaded). */
	readonly pointersEnabled: () => boolean;
	/** Callable restore tool name for this session, or undefined when a folded result cannot be restored. */
	readonly restoreInvocation: () => string | undefined;
	readonly now?: () => Date;
}

/**
 * Fabric and Jev give nested calls their own id formats when the host has no
 * native nested calls: `fabric_<uuid>`, `jev:<id>:<n>`. Pi's own nested ids are
 * `<calling id>/<n>`.
 */
export function isNestedToolCallId(toolCallId: string): boolean {
	return toolCallId.includes("/") || toolCallId.startsWith("fabric_") || toolCallId.startsWith("jev:");
}

export function createSkillRegistry(options: SkillRegistryOptions): SkillRegistry {
	const protectedResults = new Set<string>();
	const parents = new Map<string, string>();
	const now = options.now ?? (() => new Date());
	return {
		hooks: {
			decide({ name, path, body, force, sessionManager }) {
				// A host or worker shim without a session reader gets the body, never a pointer.
				if (typeof sessionManager?.getBranch !== "function") return { kind: "body", changed: false, reason: "first" };
				const branch = sessionManager.getBranch();
				return decideRepeat({
					name,
					path,
					body,
					force,
					pointersEnabled: options.pointersEnabled(),
					restoreInvocation: options.restoreInvocation(),
					branch,
					contextEntries: modelVisibleEntries(sessionManager, branch),
				});
			},
			record({ toolCallId, name, path, body, resultText }) {
				const parentToolCallId = parents.get(toolCallId);
				parents.delete(toolCallId);
				const nested = parentToolCallId !== undefined || isNestedToolCallId(toolCallId);
				const record: SkillLoadRecord = {
					version: 1,
					name,
					path,
					bodyHash: sha256(body),
					resultHash: sha256(resultText),
					bytes: new TextEncoder().encode(body).length,
					toolCallId,
					...(parentToolCallId ? { parentToolCallId } : {}),
					delivery: nested ? "partial" : "full",
					loadedAt: now().toISOString(),
				};
				// A nested result goes to the calling program, not the transcript: there is
				// nothing to protect, and the parent's result is not a skill body.
				if (!nested) protectedResults.add(record.resultHash);
				options.append(SKILL_REGISTRY_ENTRY_TYPE, record);
			},
		},
		isToolProtected(toolName, text) {
			// The kernel may pass the rendered text with its leading history tag.
			return toolName === LOAD_SKILL_TOOL_NAME && text !== undefined && protectedResults.has(sha256(stripLeadingTag(text)));
		},
		noteToolCall(event) {
			if (event.toolName === LOAD_SKILL_TOOL_NAME && event.parentToolCallId) parents.set(event.toolCallId, event.parentToolCallId);
		},
		reset(branch) {
			protectedResults.clear();
			parents.clear();
			for (const record of skillRecordsOnBranch(branch)) {
				if (record.delivery === "full") protectedResults.add(record.resultHash);
			}
		},
	};
}
