/**
 * Fail-closed validation of the `handoff` field (#266, spec §5).
 *
 * `handoff` carries namespaced payloads to a worker: `handoff: { tasks: [...] }`
 * seeds a task checklist and `handoff.focus` seeds a session objective. Every namespace other than delegate's own belongs to a
 * receiving extension, so the dispatch schema treats the object as opaque and
 * does not descend into it.
 *
 * Opaque must not mean unchecked. Before this module, two mistakes passed
 * silently:
 *
 *   handoff: { bogus: {...} }        the namespace was dropped; the caller's
 *                                    payload vanished with no error
 *   handoff: { tasks: "oops" }       the wrong type was forwarded verbatim and
 *                                    surfaced later as a malformed checklist
 *
 * Both lose the caller's intent without saying so, which is the worst outcome
 * for a field whose entire job is to carry intent. Validation is therefore
 * fail-closed: an unknown namespace or a contract violation REJECTS the
 * dispatch, and the error names what was wrong and what is accepted.
 *
 * The `tasks` contract is pinned here against the same bounds the receiver
 * enforces (`context-aware.tasks.v1`). A payload that would be silently trimmed
 * on arrival is rejected at dispatch instead, where the caller can still act on
 * the message.
 */

import {
	FOCUS_SEED_CONTRACT_VERSION,
	MAX_FOCUS_BOUNDARIES,
	MAX_FOCUS_BOUNDARY_CHARS,
	MAX_FOCUS_HOST_CHARS,
	MAX_FOCUS_OBJECTIVE_CHARS,
	MAX_FOCUS_PARENT_SESSION_ID_CHARS,
} from "./focus-seam.js";
import {
	MAX_SEED_NOTE_CHARS,
	MAX_SEED_REF_CHARS,
	MAX_SEED_SUBTASKS,
	MAX_SEED_TASKS,
	MAX_SEED_TITLE_CHARS,
	TASKS_SEED_CONTRACT_VERSION,
	isValidSeedRef,
} from "./task-seam.js";

/**
 * Namespaces delegate itself understands and validates.
 *
 * A namespace listed here is contract-checked below. Anything else is rejected.
 * Adding a namespace means adding its validator, not just its name — an entry
 * with no validator would reintroduce silent pass-through.
 */
export const KNOWN_HANDOFF_NAMESPACES = ["tasks", "focus"] as const;
export type KnownHandoffNamespace = (typeof KNOWN_HANDOFF_NAMESPACES)[number];

export class HandoffValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HandoffValidationError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Describe a value's type the way a caller would recognise it. */
function typeName(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

/**
 * Validate one task, recursively for its sub-tasks.
 *
 * `path` names the offending element so a caller with a hundred tasks is told
 * which one is wrong rather than being handed a bare type error.
 */
function validateTask(value: unknown, path: string, depth: number): void {
	if (typeof value === "string") {
		// A bare string is the documented shorthand for a title.
		if (value.length === 0) throw new HandoffValidationError(`handoff.${path} is an empty string`);
		if (value.trim().length === 0) {
			throw new HandoffValidationError(`handoff.${path} is whitespace-only; provide a non-empty title`);
		}
		if (value.length > MAX_SEED_TITLE_CHARS) {
			throw new HandoffValidationError(
				`handoff.${path} title is ${value.length} characters; the limit is ${MAX_SEED_TITLE_CHARS}`,
			);
		}
		return;
	}
	if (!isRecord(value)) {
		throw new HandoffValidationError(
			`handoff.${path} must be a string or an object, not ${typeName(value)}`,
		);
	}

	const title = value.title;
	if (typeof title !== "string" || title.length === 0) {
		throw new HandoffValidationError(`handoff.${path} requires a non-empty \`title\``);
	}
	if (title.trim().length === 0) {
		throw new HandoffValidationError(`handoff.${path}.title is whitespace-only; provide non-whitespace text`);
	}
	if (title.length > MAX_SEED_TITLE_CHARS) {
		throw new HandoffValidationError(
			`handoff.${path}.title is ${title.length} characters; the limit is ${MAX_SEED_TITLE_CHARS}`,
		);
	}

	if (value.status !== undefined) {
		const allowed = ["pending", "active", "done", "blocked", "deferred"];
		if (typeof value.status !== "string" || !allowed.includes(value.status)) {
			throw new HandoffValidationError(
				`handoff.${path}.status must be one of ${allowed.join(", ")}, not ${JSON.stringify(value.status)}`,
			);
		}
		// The receiver requires a reason for these two; a blocked task with no
		// stated reason is exactly the kind of thing that gets lost.
		if (
			(value.status === "blocked" || value.status === "deferred") &&
			(typeof value.note !== "string" || value.note.trim().length === 0)
		) {
			throw new HandoffValidationError(
				`handoff.${path} has status "${value.status}", which requires a \`note\` saying why (with non-whitespace text)`,
			);
		}
	}

	if (value.note !== undefined) {
		if (typeof value.note !== "string") {
			throw new HandoffValidationError(`handoff.${path}.note must be a string, not ${typeName(value.note)}`);
		}
		if (value.note.trim().length === 0) {
			throw new HandoffValidationError(`handoff.${path}.note is whitespace-only; provide non-whitespace text`);
		}
		if (value.note.length > MAX_SEED_NOTE_CHARS) {
			throw new HandoffValidationError(
				`handoff.${path}.note is ${value.note.length} characters; the limit is ${MAX_SEED_NOTE_CHARS}`,
			);
		}
	}

	if (value.ref !== undefined && !isValidSeedRef(value.ref)) {
		if (typeof value.ref !== "string") {
			throw new HandoffValidationError(`handoff.${path}.ref must be a string matching ^[A-Za-z0-9][A-Za-z0-9._-]*$`);
		}
		if (value.ref.length > MAX_SEED_REF_CHARS) {
			throw new HandoffValidationError(
				`handoff.${path}.ref is ${value.ref.length} characters; the limit is ${MAX_SEED_REF_CHARS}`,
			);
		}
		throw new HandoffValidationError(`handoff.${path}.ref must match ^[A-Za-z0-9][A-Za-z0-9._-]*$`);
	}

	if (value.subtasks !== undefined) {
		if (depth > 0) {
			throw new HandoffValidationError(
				`handoff.${path}.subtasks nests too deeply; sub-tasks cannot have their own sub-tasks`,
			);
		}
		if (!Array.isArray(value.subtasks)) {
			throw new HandoffValidationError(
				`handoff.${path}.subtasks must be an array, not ${typeName(value.subtasks)}`,
			);
		}
		if (value.subtasks.length > MAX_SEED_SUBTASKS) {
			throw new HandoffValidationError(
				`handoff.${path}.subtasks has ${value.subtasks.length} entries; the limit is ${MAX_SEED_SUBTASKS}`,
			);
		}
		value.subtasks.forEach((sub, index) => validateTask(sub, `${path}.subtasks[${index}]`, depth + 1));
	}
}

/** Validate the `focus` namespace against the pinned receiver contract. */
function validateFocusNamespace(value: unknown): void {
	if (!isRecord(value)) {
		throw new HandoffValidationError(`handoff.focus must be an object, not ${typeName(value)}`);
	}
	if (value.schemaVersion !== undefined && value.schemaVersion !== FOCUS_SEED_CONTRACT_VERSION) {
		throw new HandoffValidationError(
			`handoff.focus declares schemaVersion ${JSON.stringify(value.schemaVersion)}; this delegate speaks version ${FOCUS_SEED_CONTRACT_VERSION}`,
		);
	}
	const objective = value.objective;
	if (typeof objective !== "string" || objective.trim().length === 0) {
		throw new HandoffValidationError("handoff.focus.objective must be a non-empty string");
	}
	if (objective.length > MAX_FOCUS_OBJECTIVE_CHARS) {
		throw new HandoffValidationError(
			`handoff.focus.objective is ${objective.length} characters; the limit is ${MAX_FOCUS_OBJECTIVE_CHARS}`,
		);
	}
	if (value.boundaries !== undefined) {
		if (!Array.isArray(value.boundaries)) {
			throw new HandoffValidationError(`handoff.focus.boundaries must be an array, not ${typeName(value.boundaries)}`);
		}
		if (value.boundaries.length > MAX_FOCUS_BOUNDARIES) {
			throw new HandoffValidationError(
				`handoff.focus.boundaries has ${value.boundaries.length} entries; the limit is ${MAX_FOCUS_BOUNDARIES}`,
			);
		}
		value.boundaries.forEach((boundary, index) => {
			if (typeof boundary !== "string" || boundary.trim().length === 0) {
				throw new HandoffValidationError(`handoff.focus.boundaries[${index}] must be a non-empty string`);
			}
			if (boundary.length > MAX_FOCUS_BOUNDARY_CHARS) {
				throw new HandoffValidationError(
					`handoff.focus.boundaries[${index}] is ${boundary.length} characters; the limit is ${MAX_FOCUS_BOUNDARY_CHARS}`,
				);
			}
		});
	}
	for (const [key, max] of [
		["host", MAX_FOCUS_HOST_CHARS],
		["parentPiSessionId", MAX_FOCUS_PARENT_SESSION_ID_CHARS],
	] as const) {
		const field = value[key];
		if (field !== undefined && (typeof field !== "string" || field.trim().length === 0)) {
			throw new HandoffValidationError(`handoff.focus.${key} must be a non-empty string`);
		}
		if (typeof field === "string" && field.length > max) {
			throw new HandoffValidationError(`handoff.focus.${key} is ${field.length} characters; the limit is ${max}`);
		}
	}
	if (value.refs !== undefined && !Array.isArray(value.refs)) {
		throw new HandoffValidationError(`handoff.focus.refs must be an array, not ${typeName(value.refs)}`);
	}
}

/** Validate the `tasks` namespace against the pinned receiver contract. */
function validateTasksNamespace(value: unknown): void {
	// Two accepted spellings: a bare array, or an envelope carrying one.
	let tasks: unknown;
	if (Array.isArray(value)) {
		tasks = value;
	} else if (isRecord(value)) {
		const declared = value.schemaVersion;
		if (declared !== undefined && declared !== TASKS_SEED_CONTRACT_VERSION) {
			throw new HandoffValidationError(
				`handoff.tasks declares schemaVersion ${JSON.stringify(declared)}; this delegate speaks version ${TASKS_SEED_CONTRACT_VERSION}`,
			);
		}
		if (!Array.isArray(value.tasks)) {
			throw new HandoffValidationError(
				`handoff.tasks envelope requires a \`tasks\` array, not ${typeName(value.tasks)}`,
			);
		}
		tasks = value.tasks;
	} else {
		throw new HandoffValidationError(
			`handoff.tasks must be an array or an envelope object, not ${typeName(value)}`,
		);
	}

	const list = tasks as unknown[];
	if (list.length === 0) {
		// An empty checklist is almost always a construction bug upstream, and it
		// would otherwise seed nothing while looking like it worked.
		throw new HandoffValidationError("handoff.tasks is empty; omit it rather than passing an empty list");
	}
	if (list.length > MAX_SEED_TASKS) {
		throw new HandoffValidationError(
			`handoff.tasks has ${list.length} entries; the limit is ${MAX_SEED_TASKS}`,
		);
	}
	list.forEach((task, index) => validateTask(task, `tasks[${index}]`, 0));
}

const VALIDATORS: Record<KnownHandoffNamespace, (value: unknown) => void> = {
	tasks: validateTasksNamespace,
	focus: validateFocusNamespace,
};

/**
 * Validate a whole `handoff` object, throwing on the first problem.
 *
 * `where` locates the payload for the caller — "handoff" for the top-level
 * field, or "runs[2].handoff" for an entry — because the two are merged and an
 * unlocated error would leave the caller guessing which one was wrong.
 */
export function validateHandoff(value: unknown, where = "handoff"): void {
	if (value === undefined) return;
	if (!isRecord(value)) {
		throw new HandoffValidationError(`${where} must be an object, not ${typeName(value)}`);
	}
	for (const [namespace, payload] of Object.entries(value)) {
		if (payload === undefined) continue;
		const validator = VALIDATORS[namespace as KnownHandoffNamespace];
		if (!validator) {
			throw new HandoffValidationError(
				`${where} names unknown namespace \`${namespace}\`; this delegate carries ${KNOWN_HANDOFF_NAMESPACES.join(", ")}. ` +
					"An unrecognised namespace is rejected rather than dropped, because a silently discarded payload looks like success.",
			);
		}
		try {
			validator(payload);
		} catch (error) {
			// Re-anchor the message on the caller's actual field path.
			if (error instanceof HandoffValidationError && where !== "handoff") {
				throw new HandoffValidationError(error.message.replace(/^handoff\./, `${where}.`));
			}
			throw error;
		}
	}
}
