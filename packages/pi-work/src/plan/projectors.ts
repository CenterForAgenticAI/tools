import type { WorkNodeProjector } from "../schema/workspec.js";
import type {
	NodeContractAssembly,
	ProjectionInput,
	ProjectionKind,
	RemediationData,
	RenderProjectorOverrides,
	PlanFinding,
	ReportedEvidence,
} from "./types.js";

function json(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

function section(title: string, value: string): string {
	return `### ${title}\n\n${value}`;
}

function scalar(value: unknown): string {
	return value === undefined ? "_not declared / not applicable_" : String(value);
}

function renderAcceptance(value: NodeContractAssembly["node"]["acceptance"]): string {
	if (value === undefined) return "_not declared / not applicable_";
	if (value.length === 0) return "_declared empty_";
	return value.map((criterion) => [
		`#### ${criterion.id}`,
		criterion.statement,
		"Evidence:",
		json(criterion.evidence),
	].join("\n\n")).join("\n\n");
}

function renderChecklist(value: NodeContractAssembly["node"]["checklist"]): string {
	if (value === undefined) return "_not declared / not applicable_";
	if (value.length === 0) return "_declared empty_";
	return value.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

function renderChildren(value: NodeContractAssembly["node"]["work"]): string {
	if (value === undefined) return "_not declared / not applicable_";
	if (value.length === 0) return "_declared empty_";
	return value.map((child) => `- **${child.id}** — ${child.task} _(child acceptance criteria are separately owned)_`).join("\n");
}

function renderField(value: unknown): string {
	return value === undefined ? "_not declared / not applicable_" : json(value);
}

/** One exhaustive field table. Adding a WorkNode union field fails this declaration. */
export const workNodeProjectors = {
	id: { worker: (a) => section("id", scalar(a.node.id)), review: (a) => section("id", scalar(a.node.id)), remediation: (a) => section("id", scalar(a.node.id)) },
	task: { worker: (a) => section("task", scalar(a.node.task)), review: (a) => section("task", scalar(a.node.task)), remediation: (a) => section("task", scalar(a.node.task)) },
	description: { worker: (a) => section("description", scalar(a.node.description)), review: (a) => section("description", scalar(a.node.description)), remediation: (a) => section("description", scalar(a.node.description)) },
	depends_on: { worker: (a) => section("depends_on", renderField(a.node.depends_on)), review: (a) => section("depends_on", renderField(a.node.depends_on)), remediation: (a) => section("depends_on", renderField(a.node.depends_on)) },
	touches: { worker: (a) => section("touches", renderField(a.node.touches)), review: (a) => section("touches", renderField(a.node.touches)), remediation: (a) => section("touches", renderField(a.node.touches)) },
	refs: { worker: (a) => section("refs", renderField(a.node.refs)), review: (a) => section("refs", renderField(a.node.refs)), remediation: (a) => section("refs", renderField(a.node.refs)) },
	worker: { worker: (a) => section("worker", renderField(a.node.worker)), review: (a) => section("worker", renderField(a.node.worker)), remediation: (a) => section("worker", renderField(a.node.worker)) },
	acceptance: { worker: (a) => section("acceptance (owned by this node)", renderAcceptance(a.node.acceptance)), review: (a) => section("acceptance (owned by this node)", renderAcceptance(a.node.acceptance)), remediation: (a) => section("acceptance (owned by this node)", renderAcceptance(a.node.acceptance)) },
	checklist: { worker: (a) => section("checklist", renderChecklist(a.node.checklist)), review: (a) => section("checklist", renderChecklist(a.node.checklist)), remediation: (a) => section("checklist", renderChecklist(a.node.checklist)) },
	work: { worker: (a) => section("child work roster", renderChildren(a.node.work)), review: (a) => section("child work roster", renderChildren(a.node.work)), remediation: (a) => section("child work roster", renderChildren(a.node.work)) },
} satisfies WorkNodeProjector<(assembly: NodeContractAssembly) => string>;

type ProjectorTable = typeof workNodeProjectors;

function renderContext(assembly: NodeContractAssembly): string {
	const parents = assembly.parents.length === 0
		? "_none (root node)_"
		: assembly.parents.map((parent) => `- **${parent.id}** (${parent.address.join(" /")}): ${parent.task}${parent.description === undefined ? "" : ` — ${parent.description}`}`).join("\n");
	return [
		section("spec title", assembly.spec.title),
		section("spec description", assembly.spec.description),
		section("spec intent", assembly.spec.intent),
		section("node address", assembly.address.join(" /")),
		section("parent context", parents),
	].join("\n\n");
}

export function validateRemediationData(assembly: NodeContractAssembly, remediation: RemediationData): PlanFinding[] {
	const owned = new Set((assembly.node.acceptance ?? []).map((criterion) => criterion.id));
	const findings: PlanFinding[] = [];
	for (const criterionId of remediation.failedCriterionIds) {
		if (!owned.has(criterionId)) findings.push({ code: "invalid-remediation", path: [...assembly.path, "acceptance"], message: `failed criterion ${JSON.stringify(criterionId)} is not owned by ${assembly.node.id}` });
	}
	for (const [index, concern] of remediation.concerns.entries()) {
		if (!owned.has(concern.criterionId)) findings.push({ code: "invalid-remediation", path: [...assembly.path, "remediation", "concerns", index, "criterionId"], message: `reviewer concern criterion ${JSON.stringify(concern.criterionId)} is not owned by ${assembly.node.id}` });
		for (const [citationIndex, citation] of concern.citations.entries()) {
			if (!Number.isInteger(citation.line) || citation.line < 1 || (citation.endLine !== undefined && (!Number.isInteger(citation.endLine) || citation.endLine < citation.line))) {
				findings.push({ code: "invalid-remediation", path: [...assembly.path, "remediation", "concerns", index, "citations", citationIndex], message: "file citations require positive ordered line numbers" });
			}
		}
	}
	return findings;
}

function renderSupplement(assembly: NodeContractAssembly, input: ProjectionInput): string {
	if (input.kind === "worker") return "";
	if (input.kind === "review") {
		return section("worker-reported evidence", input.workerReportedEvidence.length === 0
			? "_none reported_"
			: input.workerReportedEvidence.map((report) => `#### ${report.criterionId}\n\n${report.verbatim}`).join("\n\n"));
	}
	const remediation = input.remediation;
	const concerns = remediation.concerns.length === 0 ? "_none cited_" : remediation.concerns.map((concern) => {
		const citations = concern.citations.map((citation) => `${citation.path}:${citation.line}${citation.endLine === undefined ? "" : `-${citation.endLine}`}`).join(", ");
		return `#### ${concern.criterionId}\n\n${concern.concern}\n\nCitations: ${citations}`;
	}).join("\n\n");
	const evidence = remediation.priorEvidenceResults.length === 0 ? "_none recorded_" : remediation.priorEvidenceResults.map((result) => `#### ${result.criterionId}\n\n${result.verbatim}`).join("\n\n");
	return [
		section("failed criterion ids", remediation.failedCriterionIds.join(", ")),
		section("reviewer concerns", concerns),
		section("prior evidence results (verbatim)", evidence),
	].join("\n\n");
}

function projectorsFor(overrides: RenderProjectorOverrides): ProjectorTable {
	if (Object.keys(overrides).length === 0) return workNodeProjectors;
	const result = { ...workNodeProjectors } as ProjectorTable;
	for (const field of Object.keys(overrides) as (keyof ProjectorTable)[]) {
		const replacement = overrides[field];
		if (!replacement) continue;
		result[field] = { ...result[field], ...replacement };
	}
	return result;
}

export function renderProjection(assembly: NodeContractAssembly, input: ProjectionInput, overrides: RenderProjectorOverrides = {}): string {
	if (input.kind === "remediation") {
		const findings = validateRemediationData(assembly, input.remediation);
		if (findings.length > 0) throw new Error(findings.map((finding) => finding.message).join("; "));
	}
	const table = projectorsFor(overrides);
	const kind: ProjectionKind = input.kind;
	const fields = (Object.keys(table) as (keyof ProjectorTable)[]).map((field) => table[field][kind](assembly));
	return ["# Work contract", renderContext(assembly), ...fields, renderSupplement(assembly, input)].filter(Boolean).join("\n\n") + "\n";
}

export function renderWorkerBrief(assembly: NodeContractAssembly, overrides?: RenderProjectorOverrides): string {
	return renderProjection(assembly, { kind: "worker" }, overrides);
}

export function renderReviewContract(assembly: NodeContractAssembly, workerReportedEvidence: readonly ReportedEvidence[], overrides?: RenderProjectorOverrides): string {
	return renderProjection(assembly, { kind: "review", workerReportedEvidence }, overrides);
}

export function renderRemediationBrief(assembly: NodeContractAssembly, remediation: RemediationData, overrides?: RenderProjectorOverrides): string {
	return renderProjection(assembly, { kind: "remediation", remediation }, overrides);
}
