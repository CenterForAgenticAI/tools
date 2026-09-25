import type { Finding } from "./findings.js";
import type { AdvisoryDisposition, Workspec } from "./workspec.js";

/**
 * A finding a disposition can name. Only an advisory that identifies a specific
 * subject is dispositionable: without a target, one reason would silently cover a
 * whole class of findings, which is the blanket suppression this field replaces.
 */
function targetOf(finding: Finding): string | undefined {
	return "target" in finding && typeof finding.target === "string" ? finding.target : undefined;
}

function matches(finding: Finding, disposition: AdvisoryDisposition): boolean {
	return finding.code === disposition.code && targetOf(finding) === disposition.target;
}

export interface DispositionOutcome {
	readonly findings: readonly Finding[];
}

/**
 * Annotate accepted advisories and reject dispositions that overreach.
 *
 * Three rules, all of them fail-loud rather than fail-quiet:
 *
 * - A disposition naming a warning attaches its reason to that warning. The warning
 *   is still reported; it is marked accepted, never dropped.
 * - A disposition naming an error is itself an error. Accepting an error is the
 *   suppression this mechanism exists instead of.
 * - A disposition naming nothing is a warning. A reason kept after the finding it
 *   explained has gone is stale, and a reader should be told rather than left to
 *   assume it still applies.
 */
export function applyAdvisoryDispositions(spec: Workspec, findings: readonly Finding[]): DispositionOutcome {
	const dispositions = spec.advisory_dispositions ?? [];
	if (dispositions.length === 0) return { findings };

	const extra: Finding[] = [];
	const annotated = findings.map((finding) => {
		if (finding.severity !== "warning") return finding;
		const disposition = dispositions.find((candidate) => matches(finding, candidate));
		if (!disposition) return finding;
		return { ...finding, disposition: { reason: disposition.reason, authority: disposition.authority, at: disposition.at } };
	});

	for (const [index, disposition] of dispositions.entries()) {
		const path = ["advisory_dispositions", index] as const;
		const targeted = findings.filter((finding) => matches(finding, disposition));
		// Checked on the code alone, not on code and target. An error is refused because
		// of what it is, and most errors carry no target to match on, so requiring one
		// would turn "you may not accept an error" into a misleading stale-reason warning.
		const errors = findings.filter((finding) => finding.code === disposition.code && finding.severity === "error");
		if (errors.length > 0) {
			extra.push({
				code: "disposition-targets-error",
				severity: "error",
				path: [...path],
				dispositionCode: disposition.code,
				target: disposition.target,
				message: `advisory_dispositions[${index}] accepts ${disposition.code}, which this spec raises as an error; only an advisory can be accepted`,
			});
			continue;
		}
		if (targeted.length === 0) {
			// Say which of the two reasons applies. An advisory that carries no target can
			// never be matched, so telling its author the spec "does not raise" it is false,
			// and the remedy that follows from it — delete the reason — is the wrong move.
			const untargetable = findings.some((finding) => finding.code === disposition.code && targetOf(finding) === undefined);
			extra.push({
				code: "disposition-unmatched",
				severity: "warning",
				path: [...path],
				dispositionCode: disposition.code,
				target: disposition.target,
				message: untargetable
					? `advisory_dispositions[${index}] accepts ${disposition.code}, which this spec raises without a target; only an advisory that names a subject can be accepted, so no target value would match`
					: `advisory_dispositions[${index}] accepts ${disposition.code} for ${disposition.target}, which this spec does not raise; remove the stale reason`,
			});
		}
	}

	return { findings: [...annotated, ...extra] };
}
