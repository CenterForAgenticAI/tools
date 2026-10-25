// @centerforagenticai/kleya-server/context: conversation context and parameter binding (K3 part 2). WP-4a.
// The host writes a conversation's context when it creates it; neither the model nor a tool can change it (K3-I1).
// Tools read security-bearing scope keys from it, never from model arguments: their strict schemas leave the key out,
// so a model that sends one fails validation before any hook or execute runs (K3-I5). The binder blocks a tool whose
// conversation lacks a key it needs.
import type { Context } from "@earendil-works/chord/context";
import { defineDoc, defineExtension, hook, ToolTask, type ConversationId, type DocumentReader, type Extension, type Tx } from "@earendil-works/pi-durable";

/** Spec 5.3 ContextDoc, RV1 subset: scope only (labels, parent and narrowedBy arrive with forks and children). */
export type ContextDoc = { v: 1; scope: Record<string, string> };

export const ContextDocument = defineDoc<ContextDoc>({
	kind: "kleya.context",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ v: 1, scope: {} }),
});

/**
 * Set a conversation's scope inside the host's commit. Keys may be added; a key that is already set may not be changed
 * or removed (K3-I3), so the commit fails instead.
 */
export async function writeContext(tx: Tx, conversationId: ConversationId, scope: Readonly<Record<string, string>>): Promise<void> {
	const doc = await tx.doc(ContextDocument, conversationId);
	for (const [key, value] of Object.entries(doc.scope)) {
		if (scope[key] !== value) throw new Error(`context scope key "${key}" is set and cannot be changed or removed`);
	}
	for (const [key, value] of Object.entries(scope)) {
		if (typeof value !== "string" || value.length === 0) throw new Error(`context scope key "${key}" must be a non-empty string`);
		if (doc.scope[key] === undefined) doc.scope[key] = value;
	}
}

/** The scope value a tool is bound to. Throws when the conversation has none, so the tool cannot fall back to anything. */
export async function boundScope(reader: DocumentReader, conversationId: ConversationId, key: string, context: Context): Promise<string> {
	const value = (await reader.snapshot(ContextDocument, conversationId, context))?.scope[key];
	if (value === undefined) throw new Error(`conversation has no "${key}" in its context`);
	return value;
}

/** A beforeTool hook that blocks each named tool when its conversation lacks one of the scope keys it needs. */
export function contextBinder(requirements: Readonly<Record<string, readonly string[]>>): Extension {
	return defineExtension({
		name: "kleya.context-binder",
		hooks: [
			hook(ToolTask, {
				beforeTool: async (call, api, context) => {
					const keys = requirements[call.name];
					if (keys === undefined) return undefined;
					const scope = (await api.snapshot(ContextDocument, api.conversationId, context))?.scope ?? {};
					const missing = keys.filter((key) => scope[key] === undefined);
					return missing.length === 0 ? undefined : { block: `${call.name} needs context scope ${missing.join(", ")}, which this conversation does not have` };
				},
			}),
		],
	});
}
