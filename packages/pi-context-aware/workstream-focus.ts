/** Authorized, transcript-friendly focus mutations over a canonical workstream snapshot. */

import { randomUUID } from "node:crypto";
import {
	createWorkstreamSnapshot,
	detachWorkstream,
} from "./workstream-state.js";
import {
	parseWorkstreamSnapshot,
	type WorkstreamGoal,
	type WorkstreamMutation,
	type WorkstreamRef,
	type WorkstreamSnapshot,
	type WorkstreamStatus,
} from "./workstream-schema.js";

export type FocusActor = WorkstreamMutation["actor"];
export type FocusMutationKind = WorkstreamMutation["kind"];

export interface FocusMutationOptions {
	readonly actor: FocusActor;
	readonly reason: string;
	readonly now?: string | Date;
	readonly eventId?: string;
	readonly idFactory?: () => string;
	readonly workstreamId?: string;
	readonly piSessionId?: string;
}

export type FocusMutation = WorkstreamMutation;

export interface FocusResult {
	/** The snapshot to append, or the unchanged authoritative snapshot on rejection. */
	readonly snapshot: WorkstreamSnapshot | null;
	readonly accepted: boolean;
	readonly changed: boolean;
	readonly mutation?: FocusMutation;
	readonly message?: string;
}

export type FocusCommand =
	| { readonly action: "get" }
	| { readonly action: "start"; readonly objective: string }
	| { readonly action: "edit"; readonly objective: string }
	| { readonly action: "goal"; readonly goal: WorkstreamGoal; readonly remove?: boolean }
	| { readonly action: "ref"; readonly ref: WorkstreamRef; readonly remove?: boolean }
	| { readonly action: "boundary"; readonly boundary: string; readonly remove?: boolean }
	| { readonly action: "status"; readonly status: WorkstreamStatus }
	| { readonly action: "detach" };

function generatedId(options: Pick<FocusMutationOptions, "idFactory">, label: string): string {
	const value = (options.idFactory ?? randomUUID)();
	if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) throw new Error(`${label} must be a bounded non-empty string`);
	return value;
}

function timestamp(value: string | Date | undefined, fallback: string): string {
	const result = value === undefined ? fallback : value instanceof Date ? value.toISOString() : value;
	if (!Number.isFinite(Date.parse(result))) throw new Error("focus mutation timestamp must be an ISO date");
	return result;
}

function reason(value: string): string {
	const result = value.trim();
	if (result.length === 0 || result.length > 240) throw new Error("focus mutation reason must be a bounded non-empty string");
	return result;
}

function mutation(
	source: WorkstreamSnapshot,
	kind: FocusMutationKind,
	options: FocusMutationOptions,
	accepted: boolean,
	newRevision: number,
	timestampValue: string,
	extra: Pick<FocusMutation, "workstreamId" | "previousWorkstreamId" | "newWorkstreamId" | "proposedObjective"> = { workstreamId: source.workstreamId },
): FocusMutation {
	return {
		kind,
		actor: options.actor,
		reason: reason(options.reason),
		timestamp: timestampValue,
		priorRevision: source.revision,
		newRevision,
		accepted,
		...extra,
	};
}

function rejected(
	source: WorkstreamSnapshot,
	kind: FocusMutationKind,
	options: FocusMutationOptions,
	message: string,
	proposedObjective?: string,
): FocusResult {
	const timestampValue = timestamp(options.now, source.updatedAt);
	return {
		snapshot: source,
		accepted: false,
		changed: false,
		mutation: mutation(source, kind, options, false, source.revision, timestampValue, {
			workstreamId: source.workstreamId,
			...(proposedObjective === undefined ? {} : { proposedObjective }),
		}),
		message,
	};
}

function nextSnapshot(
	source: WorkstreamSnapshot,
	patch: Partial<Pick<WorkstreamSnapshot, "objective" | "objectivePinned" | "status" | "goals" | "refs" | "boundaries">>,
	options: FocusMutationOptions,
): WorkstreamSnapshot {
	const updatedAt = timestamp(options.now, source.updatedAt);
	if (Date.parse(updatedAt) < Date.parse(source.createdAt)) throw new Error("focus mutation cannot precede snapshot creation");
	const candidate: WorkstreamSnapshot = {
		...source,
		eventId: options.eventId ?? generatedId(options, "eventId"),
		revision: source.revision + 1,
		updatedAt,
		...(patch.objective === undefined ? {} : { objective: patch.objective }),
		...(patch.objectivePinned === undefined ? {} : { objectivePinned: patch.objectivePinned }),
		...(patch.status === undefined ? {} : { status: patch.status }),
		...(patch.goals === undefined ? {} : { goals: [...patch.goals] }),
		...(patch.refs === undefined ? {} : { refs: [...patch.refs] }),
		...(patch.boundaries === undefined ? {} : { boundaries: [...patch.boundaries] }),
	};
	const parsed = parseWorkstreamSnapshot(candidate);
	if (!parsed) throw new Error("focus mutation produced an invalid workstream snapshot");
	return parsed;
}

function accepted(
	source: WorkstreamSnapshot,
	kind: FocusMutationKind,
	options: FocusMutationOptions,
	snapshot: WorkstreamSnapshot,
	extra: Pick<FocusMutation, "workstreamId" | "previousWorkstreamId" | "newWorkstreamId" | "proposedObjective"> = { workstreamId: snapshot.workstreamId },
): FocusResult {
	return {
		snapshot,
		accepted: true,
		changed: true,
		mutation: mutation(source, kind, options, true, snapshot.revision, snapshot.updatedAt, extra),
	};
}

function initialObjective(objectiveInput: string, pinned: boolean, options: FocusMutationOptions): FocusResult {
	const objective = objectiveInput.trim();
	if (objective.length === 0 || objective.length > 1_000) {
		return { snapshot: null, accepted: false, changed: false, message: "objective must be a bounded non-empty string" };
	}
	if (!options.workstreamId?.trim() || !options.piSessionId?.trim()) {
		return { snapshot: null, accepted: false, changed: false, message: "starting focus requires workstream and Pi session identities" };
	}
	const now = timestamp(options.now, new Date().toISOString());
	const snapshot = createWorkstreamSnapshot({
		workstreamId: options.workstreamId,
		piSessionId: options.piSessionId,
		objective,
		objectivePinned: pinned,
		now,
		eventId: options.eventId,
		idFactory: options.idFactory,
	});
	return {
		snapshot,
		accepted: true,
		changed: true,
		mutation: {
			kind: "objective",
			actor: options.actor,
			reason: reason(options.reason),
			timestamp: now,
			priorRevision: 0,
			newRevision: 1,
			accepted: true,
			workstreamId: snapshot.workstreamId,
			proposedObjective: objective,
		},
	};
}

/** Apply one `/focus` or `session_focus` operation to an authoritative snapshot. */
export function sessionFocus(source: WorkstreamSnapshot | null, command: FocusCommand, options: FocusMutationOptions): FocusResult {
	if (command.action === "get") return { snapshot: source, accepted: true, changed: false };
	if (source === null) {
		if (command.action === "start") {
			if (options.actor !== "agent") return { snapshot: null, accepted: false, changed: false, message: "initial focus start is reserved for an agent-selected purpose" };
			return initialObjective(command.objective, false, options);
		}
		if (command.action === "edit" && options.actor === "user") return initialObjective(command.objective, true, options);
		return { snapshot: null, accepted: false, changed: false, message: "no durable focus is set; use session_focus start only when the purpose must survive an expected compaction, handoff, or restart, or the user explicitly requests focus" };
	}

	if (command.action === "start") {
		return rejected(source, "objective", options, "durable focus has already been started; edit or maintain the existing focus", command.objective.trim());
	}

	if (command.action === "edit") {
		const objective = command.objective.trim();
		if (objective.length === 0 || objective.length > 1_000) return rejected(source, "objective", options, "objective must be a bounded non-empty string", objective);
		if (source.objectivePinned && options.actor !== "user") return rejected(source, "objective", options, "pinned objective replacement requires a user authorization record", objective);
		const next = nextSnapshot(source, { objective, objectivePinned: source.objectivePinned || options.actor === "user" }, options);
		return accepted(source, "objective", options, next, { workstreamId: next.workstreamId, proposedObjective: objective });
	}

	if (command.action === "goal") {
		const goalId = command.goal.id.trim();
		const goalText = command.goal.text.trim();
		if (goalId.length === 0 || (!command.remove && goalText.length === 0)) return rejected(source, "goal", options, "goal id and text must be non-empty");
		const goals = source.goals.filter((goal) => goal.id !== goalId);
		if (!command.remove) goals.push({ ...command.goal, id: goalId, text: goalText });
		const next = nextSnapshot(source, { goals }, options);
		return accepted(source, "goal", options, next);
	}

	if (command.action === "ref") {
		const refValue = command.ref.value.trim();
		if (refValue.length === 0) return rejected(source, "ref", options, "reference value must be non-empty");
		const refs = source.refs.filter((ref) => !(ref.kind === command.ref.kind && ref.value === refValue));
		if (!command.remove) refs.push({ ...command.ref, value: refValue });
		const next = nextSnapshot(source, { refs }, options);
		return accepted(source, "ref", options, next);
	}

	if (command.action === "boundary") {
		const boundary = command.boundary.trim();
		if (boundary.length === 0) return rejected(source, "boundary", options, "boundary must be non-empty");
		const boundaries = source.boundaries.filter((item) => item !== boundary);
		if (!command.remove) boundaries.push(boundary);
		const next = nextSnapshot(source, { boundaries }, options);
		return accepted(source, "boundary", options, next);
	}

	if (command.action === "status") {
		const next = nextSnapshot(source, { status: command.status }, options);
		return accepted(source, "status", options, next);
	}

	const detached = detachWorkstream(source, {
		piSessionId: options.piSessionId,
		workstreamId: options.workstreamId,
		eventId: options.eventId,
		now: options.now ?? source.updatedAt,
		idFactory: options.idFactory,
	});
	return accepted(source, "detach", options, detached, {
		workstreamId: detached.workstreamId,
		previousWorkstreamId: source.workstreamId,
		newWorkstreamId: detached.workstreamId,
	});
}

/** Parse the textual `/focus` command without performing a mutation. */
export function parseFocusCommand(input: string): FocusCommand | null {
	const text = input.trim();
	if (text === "/focus" || text === "/focus get") return { action: "get" };
	if (!text.startsWith("/focus ")) return null;
	const rest = text.slice("/focus ".length).trim();
	const space = rest.indexOf(" ");
	const action = space < 0 ? rest : rest.slice(0, space);
	const argument = space < 0 ? "" : rest.slice(space + 1).trim();
	if (action === "edit" && argument) return { action, objective: argument };
	if (action === "goal" && argument) {
		const parts = argument.split(/\s+/);
		const remove = parts[0] === "remove";
		if (remove) parts.shift();
		const id = parts.shift() ?? "";
		let status: WorkstreamGoal["status"] = "active";
		if (parts[0] === "pending" || parts[0] === "active" || parts[0] === "blocked" || parts[0] === "done") status = parts.shift() as WorkstreamGoal["status"];
		const goalText = parts.join(" ").trim();
		if (id && (remove || goalText)) return { action, goal: { id, text: goalText, status }, ...(remove ? { remove: true } : {}) };
	}
	if (action === "ref" && argument) {
		const parts = argument.split(/\s+/);
		const remove = parts[0] === "remove";
		if (remove) parts.shift();
		const kind = parts.shift();
		const value = parts.join(" ").trim();
		const kinds: readonly WorkstreamRef["kind"][] = ["gitlab-mr", "github-issue", "graft-spec", "branch", "commit", "path", "url", "other"];
		if (kind && kinds.includes(kind as WorkstreamRef["kind"]) && value) return { action, ref: { kind: kind as WorkstreamRef["kind"], value }, ...(remove ? { remove: true } : {}) };
	}
	if (action === "boundary" && argument) {
		const remove = argument.startsWith("remove ");
		const boundary = remove ? argument.slice("remove ".length).trim() : argument;
		if (boundary) return { action, boundary, ...(remove ? { remove: true } : {}) };
	}
	if (action === "status" && (argument === "active" || argument === "paused" || argument === "completed" || argument === "detached")) return { action, status: argument };
	if (action === "detach" && !argument) return { action };
	return null;
}

/** Snake-case alias for integrations that expose the tool as `session_focus`. */
export const session_focus = sessionFocus;
