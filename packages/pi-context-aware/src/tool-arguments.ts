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
 */

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

/** session_tasks: tasks, updates, ids, and each task's subtasks. */
export function prepareSessionTasksArguments<T>(input: unknown): T {
	if (!isRecord(input)) return input as T;
	const args: Record<string, unknown> = { ...input };
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
	return args as T;
}

export const SESSION_FOCUS_ACTIONS = ["get", "start", "edit", "ref", "boundary", "status", "detach", "activity", "pin"] as const;

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
	if (action === "ref" && args.ref == null && (args.refKind == null || args.refValue == null)) {
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
			(lookalikes.length > 0 ? ` The field ${lookalikes.join(", ")} is not recognised; use objective.` : ""),
		);
	}
	const missing = missingFieldMessage(action, args);
	if (missing !== undefined) throw new Error(missing);
	return args as T;
}
