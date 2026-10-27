/**
 * Condensed skill text (pi-context-aware#181, extension).
 *
 * A skill may ship a `condensed.md` beside its `SKILL.md`: a short version of
 * its rules written by its author. The text is captured when the skill is
 * injected and stored in a custom entry, which Pi never sends to the model. It
 * is shown only in place of the full skill block, when a native fold covers
 * the message that carries the block, or once after a compaction.
 *
 * Three sources can supply the text:
 *
 * - `load_skill`, from the discovered skill it resolved;
 * - a `/skill:` or verb message, only when its `<skill location>` exactly
 *   equals the file path of a skill Pi loaded for this run;
 * - another extension, through the context service's registration call.
 *
 * A path named only in message text is never read. The whole capability is off
 * unless `folds.condensedSkills` is true.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { ContextEditableContent, SessionEntry } from "@earendil-works/pi-coding-agent";

import type { FoldCondenser } from "../folds/fold-adapter.js";

/** Custom entry type of one captured condensed text. */
export const CONDENSED_SKILL_ENTRY_TYPE = "context-aware.skill-condensed.v1";
/** Custom entry type that ends an owner key. */
export const SKILL_OWNER_ENDED_ENTRY_TYPE = "context-aware.skill-owner-ended.v1";
/** Custom message type of the post-compaction resend. */
export const CONDENSED_RESEND_MESSAGE_TYPE = "context-aware.skill-condensed-resend";
/** File name read beside a skill's SKILL.md. */
export const CONDENSED_FILE_NAME = "condensed.md";
/** Longest condensed text accepted, in characters. */
export const MAX_CONDENSED_CHARS = 32_000;

const DIGEST = /^sha256-tree\/1:[0-9a-f]{64}$/u;

export type CondensedSource = "load_skill" | "skill-message" | "registered";

/** One captured condensed text, as persisted. */
export interface CondensedSkillRecord {
	readonly version: 1;
	readonly name: string;
	/** The skill's SKILL.md path; a block is matched on its `location` attribute. */
	readonly location: string;
	/** `sha256-tree/1:<hex>` when the source gave one; a block must then carry the same digest. */
	readonly digest?: string;
	readonly condensed: string;
	/** sha256 of `condensed`; a record whose text does not match is ignored. */
	readonly condensedHash: string;
	readonly source: CondensedSource;
	/** Set for registrations. Ending the key turns its skills into stubs. */
	readonly ownerKey?: string;
	readonly capturedAt: string;
}

export type CondensedLevel = "condensed" | "stub";

/** A captured skill and the level a fold shows it at. */
export interface CondensedSkillState {
	readonly record: CondensedSkillRecord;
	readonly level: CondensedLevel;
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/** Read one record from session data. Session files are not trusted. */
export function readCondensedRecord(value: unknown): CondensedSkillRecord | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const data = value as Record<string, unknown>;
	if (data.version !== 1 || !nonEmpty(data.name) || !nonEmpty(data.location) || !nonEmpty(data.condensed) || !nonEmpty(data.capturedAt)) return undefined;
	if (data.condensed.length > MAX_CONDENSED_CHARS || data.condensedHash !== sha256(data.condensed)) return undefined;
	if (data.digest !== undefined && (typeof data.digest !== "string" || !DIGEST.test(data.digest))) return undefined;
	if (data.source !== "load_skill" && data.source !== "skill-message" && data.source !== "registered") return undefined;
	if (data.ownerKey !== undefined && !nonEmpty(data.ownerKey)) return undefined;
	if (data.source === "registered" && (data.ownerKey === undefined || data.digest === undefined)) return undefined;
	return {
		version: 1,
		name: data.name,
		location: data.location,
		...(data.digest !== undefined ? { digest: data.digest as string } : {}),
		condensed: data.condensed,
		condensedHash: data.condensedHash as string,
		source: data.source,
		...(data.ownerKey !== undefined ? { ownerKey: data.ownerKey as string } : {}),
		capturedAt: data.capturedAt,
	};
}

/** All current captured forms, grouped by location and then by exact digest. */
export type CondensedSkillForms = ReadonlyMap<string, ReadonlyMap<string | undefined, CondensedSkillState>>;

function condensedSkillStateOnBranch(branch: readonly SessionEntry[]): {
	forms: Map<string, Map<string | undefined, CondensedSkillState>>;
	newest: Map<string, CondensedSkillState>;
	recency: Map<CondensedSkillState, number>;
} {
	const forms = new Map<string, Map<string | undefined, CondensedSkillState>>();
	const newest = new Map<string, CondensedSkillState>();
	const recency = new Map<CondensedSkillState, number>();
	let captureSequence = 0;
	for (const entry of branch) {
		if (entry.type !== "custom") continue;
		if (entry.customType === CONDENSED_SKILL_ENTRY_TYPE) {
			const record = readCondensedRecord(entry.data);
			if (!record) continue;
			const state: CondensedSkillState = { record, level: "condensed" };
			const locationForms = forms.get(record.location) ?? new Map<string | undefined, CondensedSkillState>();
			locationForms.set(record.digest, state);
			forms.set(record.location, locationForms);
			newest.set(record.location, state);
			recency.set(state, captureSequence++);
		} else if (entry.customType === SKILL_OWNER_ENDED_ENTRY_TYPE) {
			const ownerKey = (entry.data as { ownerKey?: unknown } | undefined)?.ownerKey;
			if (!nonEmpty(ownerKey)) continue;
			for (const [location, locationForms] of forms) {
				for (const [digest, state] of locationForms) {
					if (state.record.ownerKey !== ownerKey) continue;
					const stubbed: CondensedSkillState = { record: state.record, level: "stub" };
					locationForms.set(digest, stubbed);
					recency.set(stubbed, recency.get(state)!);
					if (newest.get(location) === state) newest.set(location, stubbed);
				}
			}
		}
	}
	return { forms, newest, recency };
}

/** The newest record for each captured form on a branch, with its level. */
export function condensedSkillFormsOnBranch(branch: readonly SessionEntry[]): Map<string, Map<string | undefined, CondensedSkillState>> {
	return condensedSkillStateOnBranch(branch).forms;
}

/** The newest record for each location on a branch, with its level. */
export function condensedSkillsOnBranch(branch: readonly SessionEntry[]): Map<string, CondensedSkillState> {
	return condensedSkillStateOnBranch(branch).newest;
}

function attr(name: string, value: string | undefined): string {
	return value === undefined ? "" : ` ${name}="${value}"`;
}

/** The block a fold shows in place of a skill's full text. */
export function renderCondensedBlock(record: CondensedSkillRecord, level: CondensedLevel): string {
	const open = `<skill${attr("name", record.name)}${attr("location", record.location)}${attr("digest", record.digest)} form="${level}">`;
	if (level === "stub") {
		return `${open}\nSkill "${record.name}" is no longer in use; its text was removed. Load it again if you need it.\n</skill>`;
	}
	return `${open}\n${record.condensed.trim()}\n\nThis is the condensed form of the skill. For the full text, call load_skill with name "${record.name}" and force: true, or read ${record.location}.\n</skill>`;
}

/** One `<skill ...>` block in message text. */
export interface SkillBlock {
	readonly start: number;
	readonly end: number;
	readonly attributes: Readonly<Record<string, string>>;
}

const OPEN_TAG = /<skill((?:\s+[a-z-]+="[^"]*")+)\s*>/gu;
const ATTRIBUTE = /([a-z-]+)="([^"]*)"/gu;
const CLOSE = "\n</skill>";

/**
 * Find skill blocks. A block closes at the first `</skill>` on its own line; a
 * block with another opening tag before that close is skipped rather than cut.
 */
export function findSkillBlocks(text: string): SkillBlock[] {
	const blocks: SkillBlock[] = [];
	OPEN_TAG.lastIndex = 0;
	for (let match = OPEN_TAG.exec(text); match; match = OPEN_TAG.exec(text)) {
		const close = text.indexOf(CLOSE, match.index + match[0].length);
		if (close < 0) break;
		const end = close + CLOSE.length;
		const inner = text.slice(match.index + match[0].length, close);
		if (inner.includes("<skill ")) continue;
		const attributes: Record<string, string> = {};
		for (const pair of match[1]!.matchAll(ATTRIBUTE)) attributes[pair[1]!] = pair[2]!;
		blocks.push({ start: match.index, end, attributes });
		OPEN_TAG.lastIndex = end;
	}
	return blocks;
}

/**
 * Replace each captured skill block in `text` with its condensed or stub form.
 * Text outside the blocks is kept byte for byte. `undefined` when the text holds
 * no block of a captured skill.
 */
export function condenseText(text: string, skills: CondensedSkillForms): string | undefined {
	let out = "";
	let cursor = 0;
	let matched = false;
	for (const block of findSkillBlocks(text)) {
		const state = block.attributes.location === undefined ? undefined : skills.get(block.attributes.location)?.get(block.attributes.digest);
		if (!state) continue;
		const { record } = state;
		// A digest on either side must agree; a registration always carries one.
		if (record.digest !== undefined && block.attributes.digest !== record.digest) continue;
		if (record.digest === undefined && block.attributes.digest !== undefined) continue;
		if (block.attributes.name !== record.name) continue;
		matched = true;
		out += text.slice(cursor, block.start) + renderCondensedBlock(record, state.level);
		cursor = block.end;
	}
	return matched ? out + text.slice(cursor) : undefined;
}

type Part = { type?: unknown; text?: unknown };

/** Condense a user or custom message's content, keeping its shape. */
function condenseContent(content: unknown, skills: CondensedSkillForms): ContextEditableContent | undefined {
	if (typeof content === "string") return condenseText(content, skills);
	if (!Array.isArray(content)) return undefined;
	let matched = false;
	const parts = content.map((part: Part) => {
		if (part?.type !== "text" || typeof part.text !== "string") return part;
		const text = condenseText(part.text, skills);
		if (text === undefined) return part;
		matched = true;
		return { ...part, text };
	});
	return matched ? (parts as ContextEditableContent) : undefined;
}

/**
 * The fold condenser: a user or custom message entry that carries a captured
 * skill block stays out of the fold and shows its blocks condensed instead.
 * Tool results are not condensed; `load_skill` results stay protected.
 */
export function createSkillCondenser(branch: readonly SessionEntry[]): FoldCondenser | undefined {
	const skills = condensedSkillFormsOnBranch(branch);
	if (skills.size === 0) return undefined;
	return {
		condense(entry) {
			if (entry.type === "custom_message") return condenseContent(entry.content, skills);
			if (entry.type !== "message") return undefined;
			const message = entry.message as { role?: unknown; content?: unknown };
			if (message.role !== "user") return undefined;
			return condenseContent(message.content, skills);
		},
	};
}

/** Locations of skill blocks in `text` that show a skill's full text (no `form` attribute). */
export function fullSkillBlockLocations(text: string): Set<string> {
	const locations = new Set<string>();
	for (const block of findSkillBlocks(text)) {
		if (block.attributes.form === undefined && block.attributes.location !== undefined) locations.add(block.attributes.location);
	}
	return locations;
}

/** A skill Pi loaded for this run, as `systemPromptOptions.skills` lists it. */
export interface LoadedSkillFile {
	readonly name: string;
	readonly filePath: string;
}

/** Input of a registration from another extension. */
export interface CondensedSkillRegistration {
	readonly name: string;
	readonly location: string;
	readonly digest: string;
	readonly condensed: string;
	readonly ownerKey: string;
}

export type CondensedRegistrationResult =
	| { readonly ok: true; readonly stored: boolean }
	| { readonly ok: false; readonly error: string };

export interface CondensedSkillsOptions {
	/** Persist one custom entry. In production `pi.appendEntry`. */
	readonly append: (customType: string, data: unknown) => void;
	/** Read a file; injected so tests can prove which paths are read. */
	readonly readFile?: (filePath: string) => string;
	readonly now?: () => Date;
}

/** The session reads capture needs. */
export interface CondensedSessionReader {
	getBranch(): SessionEntry[];
}

export interface CondensedSkills {
	/** After `load_skill` delivered a body: capture `condensed.md` beside the resolved SKILL.md. */
	captureLoaded(skill: LoadedSkillFile, session: CondensedSessionReader): boolean;
	/**
	 * From `before_agent_start`: capture each `<skill>` block in the prompt whose
	 * location equals the file path of a skill Pi loaded. Returns the locations captured.
	 */
	capturePrompt(prompt: string, loaded: readonly LoadedSkillFile[], session: CondensedSessionReader): string[];
	/** Store text another extension supplied. No file is read. */
	register(registration: unknown, session: CondensedSessionReader): CondensedRegistrationResult;
	/** End an owner key: its skills show as stubs at the next fold. */
	endOwner(ownerKey: unknown, session: CondensedSessionReader): boolean;
	/**
	 * The post-compaction resend: at most one latest live form per location.
	 * A form whose full text is still shown is left out. `undefined` when none.
	 */
	resendText(session: CondensedSessionReader, shownInFull: (record: CondensedSkillRecord) => boolean): { content: string; locations: string[] } | undefined;
}

function defaultRead(filePath: string): string {
	return readFileSync(filePath, "utf8");
}

export function createCondensedSkills(options: CondensedSkillsOptions): CondensedSkills {
	const read = options.readFile ?? defaultRead;
	const now = options.now ?? (() => new Date());

	const readCondensedFile = (skillFile: string): string | undefined => {
		let text: string;
		try {
			text = read(path.join(path.dirname(skillFile), CONDENSED_FILE_NAME));
		} catch {
			return undefined; // No condensed.md: the skill behaves as without the extension.
		}
		const trimmed = text.trim();
		return trimmed.length > 0 && trimmed.length <= MAX_CONDENSED_CHARS ? trimmed : undefined;
	};

	const store = (session: CondensedSessionReader, draft: Omit<CondensedSkillRecord, "version" | "condensedHash" | "capturedAt">): boolean => {
		const current = condensedSkillFormsOnBranch(session.getBranch()).get(draft.location)?.get(draft.digest);
		if (current?.level === "condensed" && current.record.source === "registered" && draft.ownerKey === undefined) {
			return false; // An ownerless capture cannot replace a live registered form.
		}
		const condensedHash = sha256(draft.condensed);
		if (current && current.level === "condensed" && current.record.condensedHash === condensedHash
			&& current.record.name === draft.name && current.record.digest === draft.digest && current.record.ownerKey === draft.ownerKey) {
			return false; // Already captured: the stored text stays what it was.
		}
		const record: CondensedSkillRecord = { version: 1, ...draft, condensedHash, capturedAt: now().toISOString() };
		options.append(CONDENSED_SKILL_ENTRY_TYPE, record);
		return true;
	};

	return {
		captureLoaded(skill, session) {
			const condensed = readCondensedFile(skill.filePath);
			if (condensed === undefined) return false;
			return store(session, { name: skill.name, location: skill.filePath, condensed, source: "load_skill" });
		},
		capturePrompt(prompt, loaded, session) {
			if (!prompt.includes("<skill ")) return [];
			const byPath = new Map(loaded.map((skill) => [skill.filePath, skill]));
			const captured: string[] = [];
			for (const block of findSkillBlocks(prompt)) {
				// The location only selects among skills Pi loaded; the path read is the loaded skill's own.
				const skill = block.attributes.location === undefined ? undefined : byPath.get(block.attributes.location);
				if (!skill || block.attributes.name !== skill.name || block.attributes.form !== undefined) continue;
				const digest = block.attributes.digest;
				if (digest !== undefined && !DIGEST.test(digest)) continue;
				const condensed = readCondensedFile(skill.filePath);
				if (condensed === undefined) continue;
				store(session, { name: skill.name, location: skill.filePath, ...(digest ? { digest } : {}), condensed, source: "skill-message" });
				captured.push(skill.filePath);
			}
			return captured;
		},
		register(registration, session) {
			if (typeof registration !== "object" || registration === null) return { ok: false, error: "registration must be an object" };
			const input = registration as Record<string, unknown>;
			// Copy named fields only; nothing else from the caller reaches the session.
			const { name, location, digest, condensed, ownerKey } = input;
			if (!nonEmpty(name) || !nonEmpty(location) || !nonEmpty(ownerKey)) return { ok: false, error: "name, location and ownerKey must be non-empty strings" };
			if (typeof digest !== "string" || !DIGEST.test(digest)) return { ok: false, error: "digest must be sha256-tree/1:<64 hex>" };
			if (typeof condensed !== "string" || condensed.trim().length === 0) return { ok: false, error: "condensed must be non-empty text" };
			const text = condensed.trim();
			if (text.length > MAX_CONDENSED_CHARS) return { ok: false, error: `condensed must be at most ${MAX_CONDENSED_CHARS} characters` };
			return { ok: true, stored: store(session, { name, location, digest, condensed: text, source: "registered", ownerKey }) };
		},
		endOwner(ownerKey, session) {
			if (!nonEmpty(ownerKey)) return false;
			const owned = [...condensedSkillFormsOnBranch(session.getBranch()).values()]
				.some((forms) => [...forms.values()].some((state) => state.record.ownerKey === ownerKey && state.level === "condensed"));
			if (!owned) return false;
			options.append(SKILL_OWNER_ENDED_ENTRY_TYPE, { version: 1, ownerKey, endedAt: now().toISOString() });
			return true;
		},
		resendText(session, shownInFull) {
			const { forms, recency } = condensedSkillStateOnBranch(session.getBranch());
			const live: CondensedSkillState[] = [];
			for (const locationForms of forms.values()) {
				let latest: CondensedSkillState | undefined;
				for (const state of locationForms.values()) {
					if (state.level !== "condensed" || shownInFull(state.record)) continue;
					if (!latest || recency.get(state)! > recency.get(latest)!) latest = state;
				}
				if (latest) live.push(latest);
			}
			if (live.length === 0) return undefined;
			const blocks = live.map((state) => renderCondensedBlock(state.record, "condensed"));
			return {
				content: `Skills still in use after the compaction, in condensed form:\n\n${blocks.join("\n\n")}`,
				locations: live.map((state) => state.record.location),
			};
		},
	};
}
