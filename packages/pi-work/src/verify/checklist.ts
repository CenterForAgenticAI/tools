import type { ChecklistItemResult, ChecklistResults, IncompleteChecklistResults, TreeIdentity, VerificationFailure } from "./results.js";

export interface ChecklistReport {
	index: number;
	done: boolean;
}

export type ChecklistReports = readonly ChecklistReport[] | Readonly<Record<string, boolean>> | undefined;

function accountingFailure(message: string): VerificationFailure {
	return { code: "checklist-accounting", message };
}

/** Exact index-based checklist accounting; item text is never used as an identity. */
export function verifyChecklist(items: readonly string[] | undefined, reports: ChecklistReports, tree: TreeIdentity): ChecklistResults {
	const authored = items ?? [];
	const normalized: ChecklistReport[] = [];
	if (Array.isArray(reports)) normalized.push(...reports);
	else if (reports && typeof reports === "object") {
		for (const [key, value] of Object.entries(reports)) {
			const index = Number(key);
			if (Number.isInteger(index) && typeof value === "boolean") normalized.push({ index, done: value });
			else normalized.push({ index: Number.NaN, done: false });
		}
	}
	const counts = new Map<number, number>();
	for (const report of normalized) counts.set(report.index, (counts.get(report.index) ?? 0) + 1);
	const failures: VerificationFailure[] = [];
	const missing: number[] = [];
	const results: ChecklistItemResult[] = authored.map((item, index) => {
		const count = counts.get(index) ?? 0;
		if (count !== 1) {
			missing.push(index);
			failures.push(accountingFailure(count === 0 ? `checklist item ${index} was not reported` : `checklist item ${index} was reported ${count} times`));
			return { index, item, done: false, tree };
		}
		const report = normalized.find((candidate) => candidate.index === index);
		const done = report?.done === true;
		if (!done) failures.push({ code: "checklist-incomplete", message: `checklist item ${index} is not done`, indexes: [index] });
		return { index, item, done, tree };
	});
	for (const report of normalized) {
		if (!Number.isInteger(report.index) || report.index < 0 || report.index >= authored.length) {
			failures.push(accountingFailure(`checklist report index ${String(report.index)} is out of range`));
		}
		// The per-item duplicate failure above is sufficient for exact accounting.
	}
	const uniqueFailures = failures.filter((candidate, index, all) => all.findIndex((other) => other.code === candidate.code && other.message === candidate.message) === index);
	const complete = authored.length === results.length && uniqueFailures.length === 0 && results.every((result) => result.done);
	if (complete) return { outcome: "complete", items: results, failures: [], tree };
	const [firstFailure, ...restFailures] = uniqueFailures;
	const incompleteFailures: [VerificationFailure, ...VerificationFailure[]] = firstFailure ? [firstFailure, ...restFailures] : [{ code: "checklist-accounting", message: "checklist accounting failed" }];
	const incomplete: IncompleteChecklistResults = { outcome: "incomplete", items: results, failures: incompleteFailures, tree };
	return incomplete;
}
