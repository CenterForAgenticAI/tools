/**
 * Which profile a shell or Pi process is in, and where that came from.
 * Mirrors `selectSource` in model/Domain.bend (laws L1-L3).
 */
export type Source = "explicit" | "exported" | "global-default" | "builtin-default";

export interface SelectionInput {
	/** `run NAME` or `--profile NAME`. */
	readonly explicit?: string | undefined;
	/** An exported `PI_CODING_AGENT_DIR`. */
	readonly exportedDir?: string | undefined;
	/** The global default profile name, if one is set. */
	readonly globalDefault?: string | undefined;
	/** `PI_PROFILE_NO_GLOBAL_DEFAULT` is set. */
	readonly noGlobalDefault: boolean;
}

export function selectSource(input: SelectionInput): Source {
	if (input.explicit !== undefined) return "explicit";
	if (input.exportedDir !== undefined) return "exported";
	if (input.noGlobalDefault) return "builtin-default";
	return input.globalDefault !== undefined ? "global-default" : "builtin-default";
}
