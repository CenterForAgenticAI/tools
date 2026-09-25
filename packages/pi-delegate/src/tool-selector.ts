/** Pure parser for authored tool grants. Keep this module dependency-free. */

export enum ToolSelectorDiagnosticCode {
	SELECTOR_MALFORMED = "SELECTOR_MALFORMED",
	OWNER_NOT_FOUND = "OWNER_NOT_FOUND",
	OWNER_AMBIGUOUS = "OWNER_AMBIGUOUS",
	MODULE_UNKNOWN = "MODULE_UNKNOWN",
	TOOL_UNDECLARED = "TOOL_UNDECLARED",
	PROVIDER_MISMATCH = "PROVIDER_MISMATCH",
}

export interface BuiltinToolGrant {
	kind: "builtin";
	authored: string;
	tool: string;
	action?: string;
}

export interface ExtensionToolGrant {
	kind: "extension";
	authored: string;
	owner: string;
	module?: string;
	tool?: string;
	action?: string;
	/** True for the compatibility form whose final slash separates owner and tool. */
	legacy: boolean;
}

export interface ToolGrantError {
	authored: string;
	error: ToolSelectorDiagnosticCode;
}

export type ToolGrant = BuiltinToolGrant | ExtensionToolGrant | ToolGrantError;

const MODULE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SELECTOR_PART = /^\S+$/;

function malformed(authored: string): ToolGrantError {
	return { authored, error: ToolSelectorDiagnosticCode.SELECTOR_MALFORMED };
}

function validPart(value: string): boolean {
	return value.length > 0 && SELECTOR_PART.test(value);
}

function parseLegacyExtension(authored: string, spec: string): ToolGrant {
	const slash = spec.lastIndexOf("/");
	if (slash < 0) {
		if (!validPart(spec)) return malformed(authored);
		const hash = spec.indexOf("#");
		if (hash >= 0 && (
			hash === 0 || hash === spec.length - 1 || spec.indexOf("#", hash + 1) >= 0
		)) return malformed(authored);
		return { kind: "extension", authored, owner: spec, legacy: true };
	}
	const owner = spec.slice(0, slash).trim();
	const leaf = spec.slice(slash + 1).trim();
	if (!validPart(owner) || !validPart(leaf)) return malformed(authored);
	const hash = owner.indexOf("#");
	if (hash >= 0 && (
		hash === 0 || hash === owner.length - 1 || owner.indexOf("#", hash + 1) >= 0
	)) return malformed(authored);
	const actionColon = leaf.indexOf(":");
	if (actionColon < 0) {
		return { kind: "extension", authored, owner, tool: leaf, legacy: true };
	}
	const tool = leaf.slice(0, actionColon).trim();
	const action = leaf.slice(actionColon + 1).trim();
	if (!validPart(tool) || !validPart(action) || action.includes(":")) return malformed(authored);
	return { kind: "extension", authored, owner, tool, action, legacy: true };
}

function parseColonExtension(authored: string, spec: string, delimiter: number): ToolGrant {
	const authority = spec.slice(0, delimiter).trim();
	const capability = spec.slice(delimiter + 1).trim();
	if (!validPart(authority) || !validPart(capability)) return malformed(authored);

	const hash = authority.indexOf("#");
	if (hash >= 0 && authority.indexOf("#", hash + 1) >= 0) return malformed(authored);
	const owner = (hash < 0 ? authority : authority.slice(0, hash)).trim();
	const module = hash < 0 ? undefined : authority.slice(hash + 1).trim();
	if (!validPart(owner) || owner.includes(":")) return malformed(authored);
	if (module !== undefined && !MODULE_ID.test(module)) return malformed(authored);

	const actionColon = capability.indexOf(":");
	const tool = (actionColon < 0 ? capability : capability.slice(0, actionColon)).trim();
	const action = actionColon < 0 ? undefined : capability.slice(actionColon + 1).trim();
	if (!validPart(tool) || tool.includes("#") || tool.includes("/")) return malformed(authored);
	if (action !== undefined && (!validPart(action) || action.includes(":"))) return malformed(authored);
	return {
		kind: "extension",
		authored,
		owner,
		...(module !== undefined ? { module } : {}),
		tool,
		...(action !== undefined ? { action } : {}),
		legacy: false,
	};
}

/** Parse one authored tool grant without consulting the filesystem or loaded tools. */
export function parseToolGrant(authored: string): ToolGrant {
	const trimmed = authored.trim();
	if (!trimmed) return malformed(authored);
	if (!trimmed.startsWith("ext:")) {
		const colon = trimmed.indexOf(":");
		const tool = (colon < 0 ? trimmed : trimmed.slice(0, colon)).trim();
		const action = colon < 0 ? undefined : trimmed.slice(colon + 1).trim();
		if (!validPart(tool) || (action !== undefined && (!validPart(action) || action.includes(":")))) {
			return malformed(authored);
		}
		return {
			kind: "builtin",
			authored,
			tool,
			...(action !== undefined ? { action } : {}),
		};
	}

	const spec = trimmed.slice("ext:".length).trim();
	if (!spec) return malformed(authored);
	const delimiter = spec.indexOf(":");
	const finalSlash = spec.lastIndexOf("/");
	if (delimiter < 0 || finalSlash > delimiter) return parseLegacyExtension(authored, spec);
	if (finalSlash >= 0) {
		const authority = spec.slice(0, delimiter);
		const slashCount = [...authority].filter((character) => character === "/").length;
		// The new form permits the one slash in an npm scoped package owner. Any
		// other slash before the first colon is the old owner/tool delimiter; in
		// that case the colon belongs to the action on the final tool leaf.
		if (!(authority.startsWith("@") && slashCount === 1)) {
			return parseLegacyExtension(authored, spec);
		}
	}
	return parseColonExtension(authored, spec, delimiter);
}

export function toolSelectorDiagnostic(
	code: ToolSelectorDiagnosticCode,
	message: string,
): string {
	return `[tool-selector:${code}] ${message}`;
}
