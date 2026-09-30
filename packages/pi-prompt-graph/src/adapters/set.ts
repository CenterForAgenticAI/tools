import type { CompiledNode, JsonObject, NodeOutcome, StateOpSource } from "../model.js";
import type { NodeExecutionContext } from "./index.js";

export interface SetExecution {
	readonly outcome: NodeOutcome;
	readonly operations: StateOpSource[];
}

/** Evaluates set operations without observing the process or wall clock. */
export class SetAdapter {
	run(node: CompiledNode, context: NodeExecutionContext = {}): Promise<NodeOutcome> {
		if (node.binding.kind !== "set") throw new TypeError(`Node ${node.id} is not a set node.`);
		const simulated = structuredClone(context.state ?? {});
		for (const operation of node.binding.ops) {
			if (operation.op === "increment") {
				const current = valueAt(simulated, operation.path);
				if (current !== undefined && typeof current !== "number") return Promise.resolve({ status: "failed", changed: false, completionSignal: "not-applicable", diagnostics: [`Cannot increment non-numeric state path ${operation.path}.`] });
				setAt(simulated, operation.path, (typeof current === "number" ? current : 0) + (operation.by ?? 1));
			} else if (operation.op === "set") setAt(simulated, operation.path, operation.value ?? null);
			else unsetAt(simulated, operation.path);
		}
		return Promise.resolve({ status: "completed", changed: node.binding.ops.length > 0, completionSignal: "not-applicable" });
	}

	execute(node: CompiledNode, _state: JsonObject): SetExecution {
		if (node.binding.kind !== "set") throw new TypeError(`Node ${node.id} is not a set node.`);
		return {
			outcome: { status: "completed", changed: node.binding.ops.length > 0, completionSignal: "not-applicable" },
			operations: node.binding.ops,
		};
	}
}

export function runSet(node: CompiledNode, context: NodeExecutionContext = {}): Promise<NodeOutcome> {
	return new SetAdapter().run(node, context);
}

function valueAt(state: JsonObject, path: string): unknown {
	let value: unknown = state;
	for (const part of path.split(".")) {
		if (!value || typeof value !== "object" || Array.isArray(value) || !Object.prototype.hasOwnProperty.call(value, part)) return undefined;
		value = (value as Record<string, unknown>)[part];
	}
	return value;
}

function setAt(state: JsonObject, path: string, value: unknown): void {
	const parts = path.split(".");
	let cursor = state;
	for (const part of parts.slice(0, -1)) {
		if (!cursor[part] || typeof cursor[part] !== "object" || Array.isArray(cursor[part])) cursor[part] = {};
		cursor = cursor[part] as JsonObject;
	}
	cursor[parts.at(-1)!] = value as never;
}

function unsetAt(state: JsonObject, path: string): void {
	const parts = path.split(".");
	let cursor: unknown = state;
	for (const part of parts.slice(0, -1)) {
		if (!cursor || typeof cursor !== "object" || Array.isArray(cursor) || !(part in cursor)) return;
		cursor = (cursor as JsonObject)[part];
	}
	if (cursor && typeof cursor === "object" && !Array.isArray(cursor)) delete (cursor as JsonObject)[parts.at(-1)!];
}
