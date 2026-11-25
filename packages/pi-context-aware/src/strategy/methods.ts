/**
 * Context methods (pi-context-aware#526, ADR 0002): what a live session can do about its context. A session runs a
 * list of methods, `strategy.methods`, composed into one recipe (`composeRecipe` in ./live.ts) that one stage loop
 * runs; the plan checker settles their plans. A later method (mask, trim) is added to the list, not swapped in.
 *
 * - `fold`: the kernel's growth nudge and the model's folds (`context_fold`).
 * - `compact`: seeded compaction (`context_compact`).
 *
 * The pressure note is shared by every method and always runs.
 */

export const CONTEXT_METHODS = ["fold", "compact"] as const;

export type ContextMethod = (typeof CONTEXT_METHODS)[number];

declare const methodSetBrand: unique symbol;

/** A non-empty list of known methods with none twice, in the order the setting lists them. Built only by `toMethodSet`. */
export type MethodSet = readonly ContextMethod[] & { readonly [methodSetBrand]: true };

/** True only for a name in `CONTEXT_METHODS`, compared exactly. */
export function isContextMethod(name: string): name is ContextMethod {
	return (CONTEXT_METHODS as readonly string[]).includes(name);
}

/** The list as a method set, or null when it is empty or names a method twice. */
export function toMethodSet(methods: readonly ContextMethod[]): MethodSet | null {
	if (methods.length === 0 || new Set(methods).size !== methods.length) return null;
	return Object.freeze([...methods]) as unknown as MethodSet;
}

/** Both methods: what a session runs when nothing else chooses. */
export const DEFAULT_METHODS: MethodSet = toMethodSet(["fold", "compact"])!;

/** The separator in a method set's id: `fold+compact`. Not a character a method name holds. */
const ID_SEPARATOR = "+";

/** The id of a method set, and of the recipe composed from it: the methods joined with `+`, in list order. */
export function methodSetId(methods: MethodSet): string {
	return methods.join(ID_SEPARATOR);
}

/** A method set id read back, or null when it is not one: an unknown or repeated method, or an empty part. */
export function parseMethodSetId(id: string): MethodSet | null {
	const parts = id.split(ID_SEPARATOR);
	return parts.every(isContextMethod) ? toMethodSet(parts) : null;
}

/** True when the set holds the method. */
export function hasMethod(methods: readonly ContextMethod[], method: ContextMethod): boolean {
	return methods.includes(method);
}

/** The context tool each method brings. */
const METHOD_OF_TOOL: ReadonlyMap<string, ContextMethod> = new Map<string, ContextMethod>([["context_fold", "fold"], ["context_compact", "compact"]]);

/**
 * True unless the tool belongs to a method the session does not run (CR-FOLD-ONLY-COMPACT-NUDGE). A Fabric
 * code-mode host reaches every registered tool, a hidden one too, so reachability alone would let a nudge name
 * `context_compact` in a session without `compact`. Tools of no method are always offered.
 */
export function toolOfferedBy(methods: readonly ContextMethod[], toolName: string): boolean {
	const method = METHOD_OF_TOOL.get(toolName);
	return method === undefined || hasMethod(methods, method);
}
