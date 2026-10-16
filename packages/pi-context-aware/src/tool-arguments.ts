/**
 * Repair tool arguments that some models send in the wrong JSON shape, before
 * Pi validates them against the schema.
 *
 * Several Claude models sometimes send a list argument as a JSON string
 * (`"tasks": "[{...}]"`) instead of an array. Pi does not parse strings for
 * TypeBox schemas: Value.Convert wraps the string in a one-item array, and
 * validation then fails with a misleading "tasks.0: must be object". Pi's own
 * edit tool repairs the same mistake in its prepareArguments hook; these hooks
 * do the same for session_tasks and session_focus. The advertised schema is
 * unchanged, so the prompt cache is not affected.
 *
 * Only a string that parses to the expected JSON type is replaced. Anything
 * else is left alone so that validation reports it as before.
 *
 * The hooks also report an invalid action, status, or reference kind with the
 * valid values named, so the schemas do not need to repeat those rules in
 * their descriptions.
 */

import { Type } from "typebox";
import { TASK_STATUSES } from "./session-tasks/session-tasks.js";
import { REF_KINDS, WORKSTREAM_STATUSES } from "./workstream/workstream-schema.js";

/**
 * A string enum as a plain JSON Schema `enum`. A TypeBox union of literals
 * sends every value as its own `{ type, const }` branch, which costs about
 * three times the characters and fails with "must be equal to constant".
 */
export function stringEnum<const T extends readonly string[]>(values: T, options: { description?: string } = {}) {
	return Type.Unsafe<T[number]>({ type: "string", enum: [...values], ...options });
}

/** Name the valid values when a caller sends one the tool does not know. */
function notValid(tool: string, field: string, value: unknown, plural: string, valid: readonly string[]): string {
	const got = value === undefined ? `no ${field}` : `${field} ${JSON.stringify(value)}`;
	return `${tool}: ${got} is not valid. Valid ${plural}: ${valid.join(", ")}.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Limits on what the hooks will repair. Parsing a huge string hands Pi's
 * validator a huge array that takes seconds to reject, where the unparsed
 * string fails at once, so larger values are left as they are.
 *
 * The schema allows up to 100 tasks of 50 sub-tasks, so a valid stringified
 * plan could in theory reach about 2.7 million characters. No model sends that
 * in one call (it would be hundreds of thousands of output tokens); real lists
 * are a few kilobytes. The item limit is ten times the schema's maxItems, so a
 * slightly-too-long list is still repaired and gets the schema's own error.
 */
export const MAX_REPAIRABLE_ARGUMENT_CHARS = 1_000_000;
export const MAX_REPAIRABLE_ARRAY_ITEMS = 1_000;

function parsedAs<T>(value: unknown, accept: (parsed: unknown) => parsed is T): T | undefined {
	if (typeof value !== "string" || value.length > MAX_REPAIRABLE_ARGUMENT_CHARS) return undefined;
	try {
		const parsed: unknown = JSON.parse(value);
		return accept(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

const isArray = (value: unknown): value is unknown[] => Array.isArray(value) && value.length <= MAX_REPAIRABLE_ARRAY_ITEMS;

/** Replace `record[key]` with its parsed array when it is a JSON-encoded array. */
function repairArrayField(record: Record<string, unknown>, key: string): void {
	const parsed = parsedAs(record[key], isArray);
	if (parsed !== undefined) record[key] = parsed;
}

export const SESSION_TASKS_ACTIONS = ["plan", "add", "update", "remove", "reorder", "list", "subtree"] as const;

/** The first task or update status that is a string but not a task status. */
function invalidTaskStatus(args: Record<string, unknown>): string | undefined {
	const statuses: unknown[] = [];
	const collect = (item: unknown) => { if (isRecord(item)) statuses.push(item.status); };
	if (Array.isArray(args.tasks)) {
		for (const task of args.tasks) {
			collect(task);
			if (isRecord(task) && Array.isArray(task.subtasks)) task.subtasks.forEach(collect);
		}
	}
	if (Array.isArray(args.updates)) args.updates.forEach(collect);
	return statuses.find((status): status is string => typeof status === "string" && !(TASK_STATUSES as readonly string[]).includes(status));
}

/**
 * session_tasks: repair tasks, updates, ids, and each task's subtasks, then
 * report an unknown action or status with the valid values named.
 */
export function prepareSessionTasksArguments<T>(input: unknown): T {
	if (!isRecord(input)) return input as T;
	const args: Record<string, unknown> = { ...input };
	const action = args.action;
	if (typeof action !== "string" || !(SESSION_TASKS_ACTIONS as readonly string[]).includes(action)) {
		throw new Error(notValid("session_tasks", "action", action, "actions", SESSION_TASKS_ACTIONS));
	}
	repairArrayField(args, "tasks");
	repairArrayField(args, "updates");
	repairArrayField(args, "ids");
	if (Array.isArray(args.tasks)) {
		args.tasks = args.tasks.map((task) => {
			if (!isRecord(task) || typeof task.subtasks !== "string") return task;
			const repaired = { ...task };
			repairArrayField(repaired, "subtasks");
			return repaired;
		});
	}
	const status = invalidTaskStatus(args);
	if (status !== undefined) {
		throw new Error(`${notValid("session_tasks", "status", status, "statuses", TASK_STATUSES)} blocked and deferred need a note.`);
	}
	return args as T;
}

export const SESSION_FOCUS_ACTIONS = ["get", "start", "edit", "ref", "boundary", "status", "detach", "activity", "pin"] as const;
export const SESSION_FOCUS_STATUSES = WORKSTREAM_STATUSES;
export const SESSION_FOCUS_REF_KINDS = REF_KINDS;
/** Bound on a reference value, shared by the schema and the legacy flat form. */
export const MAX_FOCUS_REF_VALUE_CHARS = 512;

/** Field names models have used for the objective. They are reported, never accepted. */
const OBJECTIVE_LOOKALIKES = ["focus", "purpose", "text", "goal", "description"] as const;

/**
 * The actions other than start and edit that need a field of their own. Only an
 * absent or null field is reported here; a present field of the wrong type or
 * value is left to schema validation, which names the allowed values.
 */
function missingFieldMessage(action: string, args: Record<string, unknown>): string | undefined {
	if (action === "status" && args.status == null) {
		return 'session_focus status requires the field status (active, paused, completed or detached), e.g. {"action":"status","status":"paused"}.';
	}
	if (action === "boundary" && args.boundary == null) {
		return 'session_focus boundary requires the field boundary: one lasting constraint, e.g. {"action":"boundary","boundary":"<constraint>"}. Add remove: true to drop it.';
	}
	if (action === "ref" && args.ref == null && (args.refKind == null || !("refValue" in args))) {
		return 'session_focus ref requires the field ref with kind and value, e.g. {"action":"ref","ref":{"kind":"gitlab-mr","value":"group/project!12"}}. Add remove: true to drop it.';
	}
	return undefined;
}

/**
 * session_focus: repair a JSON-encoded `ref` object, and replace the schema's
 * generic union error with one that names the valid actions and the missing
 * field. Pi turns an error thrown here into the tool result, as it does for a
 * validation failure. Invented actions and fields are reported, not aliased.
 */
export function prepareSessionFocusArguments<T>(input: unknown): T {
	if (!isRecord(input)) return input as T;
	const args: Record<string, unknown> = { ...input };
	if (args.refKind === null) delete args.refKind;
	if (args.refValue === null) delete args.refValue;
	const ref = parsedAs(args.ref, isRecord);
	if (ref !== undefined) args.ref = ref;

	const action = args.action;
	const known = typeof action === "string" && (SESSION_FOCUS_ACTIONS as readonly string[]).includes(action);
	const lookalikes = OBJECTIVE_LOOKALIKES.filter((key) => key in args);
	if (!known) {
		const got = action === undefined ? "no action" : `action ${JSON.stringify(action)}`;
		throw new Error(
			`session_focus: ${got} is not valid. Valid actions: ${SESSION_FOCUS_ACTIONS.join(", ")}. ` +
			"Use start to create focus and edit to change it; both take the field objective, e.g. " +
			'{"action":"start","objective":"<one overall purpose>"}.' +
			(lookalikes.length > 0 ? ` The field ${lookalikes.join(", ")} is not recognised; use objective.` : ""),
		);
	}
	if ((action === "start" || action === "edit") && typeof args.objective !== "string") {
		throw new Error(
			`session_focus ${action} requires the field objective, e.g. {"action":"${action}","objective":"<one overall purpose>"}.` +
			(lookalikes.length > 0 ? ` The field ${lookalikes.join(", ")} is not recognised; use objective.` : "") +
			(args.status == null ? "" : ` To change lifecycle instead, use {"action":"status","status":${JSON.stringify(args.status)}}.`),
		);
	}
	const missing = missingFieldMessage(action, args);
	if (missing !== undefined) throw new Error(missing);
	const invalid = invalidFocusValue(args);
	if (invalid !== undefined) throw new Error(invalid);
	return args as T;
}

/**
 * A status or reference kind the tool does not know, named with the valid
 * values. The legacy flat reference form (refKind and refValue) is no longer
 * advertised in the schema, so its kind and length are checked here.
 */
function invalidFocusValue(args: Record<string, unknown>): string | undefined {
	if (typeof args.status === "string" && !(SESSION_FOCUS_STATUSES as readonly string[]).includes(args.status)) {
		return notValid("session_focus", "status", args.status, "statuses", SESSION_FOCUS_STATUSES);
	}
	const kinds = [isRecord(args.ref) ? args.ref.kind : undefined, args.refKind];
	for (const kind of kinds) {
		if (typeof kind === "string" && !(SESSION_FOCUS_REF_KINDS as readonly string[]).includes(kind)) {
			return notValid("session_focus", "ref kind", kind, "kinds", SESSION_FOCUS_REF_KINDS);
		}
	}
	if ("refKind" in args && typeof args.refKind !== "string") return "session_focus: refKind must be a string.";
	if ("refValue" in args) {
		if (typeof args.refValue === "number" || typeof args.refValue === "boolean") args.refValue = String(args.refValue);
		if (typeof args.refValue !== "string") return "session_focus: refValue must be a string.";
		if (args.refValue.length > MAX_FOCUS_REF_VALUE_CHARS) {
			return `session_focus: refValue must be at most ${MAX_FOCUS_REF_VALUE_CHARS} characters; prefer ref: {"kind":"...","value":"..."}.`;
		}
	}
	return undefined;
}
