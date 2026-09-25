import nodePath from "node:path";

import type { FindingPath, SchemaFinding } from "./findings.js";

const agentInputPathFormat = "agent-input-path";

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStaticAgentInputPath(value: string): boolean {
	if (nodePath.isAbsolute(value)) return false;
	const normalized = nodePath.normalize(value);
	return normalized !== "." && normalized !== `.${nodePath.sep}`;
}

/** Validate formats owned by pi-work without depending on a process-global TypeBox registry. */
export function workspecFormatFindings(value: unknown): SchemaFinding[] {
	if (!record(value) || !Array.isArray(value.work)) return [];
	const findings: SchemaFinding[] = [];

	function inspectNodes(nodes: readonly unknown[], path: FindingPath): void {
		nodes.forEach((node, nodeIndex) => {
			if (!record(node)) return;
			const nodePathSegments = [...path, nodeIndex];
			if (Array.isArray(node.acceptance)) {
				node.acceptance.forEach((criterion, criterionIndex) => {
					if (!record(criterion) || !record(criterion.evidence) || criterion.evidence.kind !== "agent" || !Array.isArray(criterion.evidence.inputs)) return;
					criterion.evidence.inputs.forEach((input, inputIndex) => {
						if (typeof input !== "string" || isStaticAgentInputPath(input)) return;
						findings.push({
							code: "schema-invalid",
							severity: "error",
							path: [...nodePathSegments, "acceptance", criterionIndex, "evidence", "inputs", inputIndex],
							keyword: "format",
							params: { format: agentInputPathFormat },
							message: `Expected string to match '${agentInputPathFormat}' format`,
						});
					});
				});
			}
			if (Array.isArray(node.work)) inspectNodes(node.work, [...nodePathSegments, "work"]);
		});
	}

	inspectNodes(value.work, ["work"]);
	return findings;
}
