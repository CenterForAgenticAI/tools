import { HARD_MAX_DEPTH } from "../depth-guard.js";
import { parseToolGrant } from "../tool-selector.js";

export interface DelegateOnlyConfig {
	allowlist: string[];
	readBytesPerCall: number;
	readBytesPerTurn: number;
	resultAdvisoryBytes: number;
	resultHardCapBytes: number;
	nestingDepth: number;
}

export const DEFAULT_DELEGATE_ONLY_CONFIG: Readonly<DelegateOnlyConfig> = {
	allowlist: [],
	readBytesPerCall: 16384,
	readBytesPerTurn: 65536,
	resultAdvisoryBytes: 4096,
	resultHardCapBytes: 16384,
	nestingDepth: 2,
};

type DelegateOnlyDiagnosticSink = (message: string) => void;
const ignoreDiagnostic: DelegateOnlyDiagnosticSink = () => {};

function isPlainObject(source: unknown): source is Record<string, unknown> {
	if (source === null || typeof source !== "object") return false;
	const prototype = Object.getPrototypeOf(source);
	return prototype === Object.prototype || prototype === null;
}

export function parseDelegateOnly(
	source: unknown,
	diagnosticSink: DelegateOnlyDiagnosticSink = ignoreDiagnostic,
): DelegateOnlyConfig {
	const defaults: DelegateOnlyConfig = {
		allowlist: [...DEFAULT_DELEGATE_ONLY_CONFIG.allowlist],
		readBytesPerCall: DEFAULT_DELEGATE_ONLY_CONFIG.readBytesPerCall,
		readBytesPerTurn: DEFAULT_DELEGATE_ONLY_CONFIG.readBytesPerTurn,
		resultAdvisoryBytes: DEFAULT_DELEGATE_ONLY_CONFIG.resultAdvisoryBytes,
		resultHardCapBytes: DEFAULT_DELEGATE_ONLY_CONFIG.resultHardCapBytes,
		nestingDepth: DEFAULT_DELEGATE_ONLY_CONFIG.nestingDepth,
	};
	if (source === undefined) return defaults;
	if (!isPlainObject(source)) {
		diagnosticSink("[delegate] ignoring invalid delegateOnly; expected a plain object");
		return defaults;
	}

	const out: DelegateOnlyConfig = {
		allowlist: defaults.allowlist,
		readBytesPerCall: defaults.readBytesPerCall,
		readBytesPerTurn: defaults.readBytesPerTurn,
		resultAdvisoryBytes: defaults.resultAdvisoryBytes,
		resultHardCapBytes: defaults.resultHardCapBytes,
		nestingDepth: defaults.nestingDepth,
	};
	if (Object.prototype.hasOwnProperty.call(source, "allowlist")) {
		if (
			Array.isArray(source.allowlist) &&
			source.allowlist.every((value) =>
				typeof value === "string" && value.length > 0 && !("error" in parseToolGrant(value)))
		) {
			out.allowlist = [...source.allowlist];
		} else {
			diagnosticSink("[delegate] ignoring invalid delegateOnly.allowlist; expected an array of non-empty strings");
		}
	}

	const numericFields = [
		"readBytesPerCall",
		"readBytesPerTurn",
		"resultAdvisoryBytes",
		"resultHardCapBytes",
		"nestingDepth",
	] as const;
	for (const field of numericFields) {
		if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
		const value = source[field];
		const valid =
			typeof value === "number" &&
			(field === "nestingDepth"
				? Number.isSafeInteger(value) && value <= HARD_MAX_DEPTH
				: Number.isFinite(value) && Number.isInteger(value)) &&
			value >= 0;
		if (valid) {
			out[field] = value;
		} else {
			diagnosticSink(
				field === "nestingDepth"
					? `[delegate] ignoring invalid delegateOnly.${field}; expected a safe integer from 0 to ${HARD_MAX_DEPTH}`
					: `[delegate] ignoring invalid delegateOnly.${field}; expected a finite non-negative integer`,
			);
		}
	}
	return out;
}
