import type { CommandEvidence, CommandExpectation } from "../schema/workspec.js";

export const COMMAND_OUTPUT_TAIL_LIMIT = 1024;
export const EMPTY_COMMAND_OUTPUT = "[empty]";
/** Visible marker for a removed inherited value; it carries no source value. */
export const REDACTED_INHERITED_VALUE = "[redacted inherited value]";
export const SUPPRESSED_COMMAND_OUTPUT = "[command output suppressed after redaction safety check]";
export const TRUNCATED_COMMAND_OUTPUT = "… [truncated]";

/** Values captured when the child environment was constructed, never read at emission time. */
export interface InheritedValuesSnapshot {
	readonly values: readonly string[];
	readonly named: Readonly<Record<string, string>>;
}

export function inheritedValuesSnapshot(values: readonly string[], named: Readonly<Record<string, string>> = {}): InheritedValuesSnapshot {
	return Object.freeze({ values: Object.freeze([...new Set(values.filter((value) => value.length > 0))].sort((left, right) => right.length - left.length)), named: Object.freeze({ ...named }) });
}

function inheritedValues(snapshot: InheritedValuesSnapshot): readonly string[] {
	return snapshot.values;
}

function tail(text: string): string {
	if (text.length <= COMMAND_OUTPUT_TAIL_LIMIT) return text;
	return `${TRUNCATED_COMMAND_OUTPUT}\n${text.slice(-COMMAND_OUTPUT_TAIL_LIMIT)}`;
}

/** The final emission check: no inherited value may leave the verifier in command-derived text. */
function safeToEmit(values: readonly string[], text: string): boolean {
	return values.every((value) => !text.includes(value));
}

function redactForEmission(values: readonly string[], text: string): string {
	const redacted = tail(values.reduce((current, value) => current.split(value).join(REDACTED_INHERITED_VALUE), text));
	if (safeToEmit(values, redacted)) return redacted;
	const suppressed = tail(SUPPRESSED_COMMAND_OUTPUT);
	return safeToEmit(values, suppressed) ? suppressed : "";
}

/**
 * Produce the only persisted or rendered representation of command text.
 * Redaction is followed by an emission check; if its readable placeholder would
 * retain a value, the stream is suppressed and may lose its original tail.
 */
export function redactCommandOutput(snapshot: InheritedValuesSnapshot, stdout: string, stderr: string): { stdout: string; stderr: string } {
	const values = inheritedValues(snapshot);
	return { stdout: redactForEmission(values, stdout), stderr: redactForEmission(values, stderr) };
}

/** Redact a failure containing command-derived text without truncating its diagnostic. */
export function redactCommandFailure(snapshot: InheritedValuesSnapshot, message: string): string {
	const values = inheritedValues(snapshot);
	const redacted = values.reduce((current, value) => current.split(value).join(REDACTED_INHERITED_VALUE), message);
	return safeToEmit(values, redacted) ? redacted : "[command failure suppressed after redaction safety check]";
}

/** Render an empty command stream with its explicit label only when that label is safe to emit. */
export function renderCommandOutputTail(snapshot: InheritedValuesSnapshot, value: string | undefined): string {
	const text = value === undefined || value.length === 0 ? EMPTY_COMMAND_OUTPUT : value;
	return safeToEmit(inheritedValues(snapshot), text) ? text : "";
}

/** Redact one command-derived field through the same bounded output representation. */
export function redactCommandText(snapshot: InheritedValuesSnapshot, value: string): string {
	return redactCommandOutput(snapshot, value, "").stdout;
}

/** Redact the complete command contract before it leaves the verifier. */
export function redactCommandEvidence(evidence: CommandEvidence, snapshot: InheritedValuesSnapshot): CommandEvidence {
	return {
		kind: "command",
		...(evidence.inherit_env === undefined ? {} : { inherit_env: [...evidence.inherit_env] }),
		...(evidence.timeout_ms === undefined ? {} : { timeout_ms: evidence.timeout_ms }),
		run: typeof evidence.run === "string" ? redactCommandText(snapshot, evidence.run) : evidence.run,
		expect: {
			exit: evidence.expect.exit,
			output_includes: typeof evidence.expect.output_includes === "string"
				? redactCommandText(snapshot, evidence.expect.output_includes)
				: evidence.expect.output_includes,
		},
	};
}

/** Reject serialized command expectations that retain a captured inherited value. */
export function commandExpectationMatches(snapshot: InheritedValuesSnapshot, expectation: CommandExpectation): boolean {
	return expectation.output_includes === redactCommandText(snapshot, expectation.output_includes);
}

/** Reject serialized command evidence that bypassed the command redaction boundary. */
export function commandEvidenceMatches(evidence: CommandEvidence, snapshot: InheritedValuesSnapshot): boolean {
	const redacted = redactCommandEvidence(evidence, snapshot);
	return evidence.run === redacted.run && evidence.expect.exit === redacted.expect.exit && evidence.expect.output_includes === redacted.expect.output_includes;
}

function boundedTail(text: string): boolean {
	if (text.length <= COMMAND_OUTPUT_TAIL_LIMIT) return true;
	return text.startsWith(`${TRUNCATED_COMMAND_OUTPUT}\n`) && text.length <= TRUNCATED_COMMAND_OUTPUT.length + 1 + COMMAND_OUTPUT_TAIL_LIMIT;
}

/** A persisted proof must retain the one canonical bounded and redacted output form. */
export function commandOutputMatches(snapshot: InheritedValuesSnapshot, stdout: string, stderr: string, expected: string): boolean {
	if (expected.length === 0 || !boundedTail(stdout) || !boundedTail(stderr)) return false;
	return inheritedValues(snapshot).every((value) => !stdout.includes(value) && !stderr.includes(value));
}
