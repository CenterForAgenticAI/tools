import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { getWorkStatus, type WorkStatusDetails } from "../status/index.js";
import type { NodeAddress } from "../plan/index.js";
import { renderBlockers } from "../status/derive.js";
import { renderFinding } from "../schema/findings.js";

export const MAX_RENDERED_TEXT = 4000;

const NodeAddressSchema = Type.Array(Type.String({ minLength: 1 }), { minItems: 1 });
const ChecklistReportSchema = Type.Object({ index: Type.Integer(), done: Type.Boolean() }, { additionalProperties: false });
const RefreshSchema = Type.Object({
	nodeAddresses: Type.Optional(Type.Array(NodeAddressSchema)),
	checklists: Type.Optional(Type.Array(Type.Object({ nodeAddress: NodeAddressSchema, reports: Type.Array(ChecklistReportSchema) }, { additionalProperties: false }))),
}, { additionalProperties: false });

export const WorkStatusParameters = Type.Object({
	path: Type.String({ minLength: 1 }),
	worktreePath: Type.String({ minLength: 1 }),
	expectedCommit: Type.String({ minLength: 1 }),
	refresh: Type.Optional(RefreshSchema),
}, { additionalProperties: false });

export type WorkStatusToolDetails = WorkStatusDetails;
export type { WorkStatusDetails } from "../status/index.js";

function render(details: WorkStatusDetails): string {
	const lines = [`${details.specState}: ${details.nodes.length} node(s)`, `spec: ${details.path}`, `cache: ${details.cachePath}`];
	if (details.currentTree?.kind === "git") lines.push(`tree: ${details.currentTree.worktreePath}@${details.currentTree.resolvedCommit}`);
	for (const finding of details.findings) {
		// A path-input rejection is only actionable if the caller can see which path was
		// refused, so defer to the shared renderer that carries the message.
		if ("severity" in finding) lines.push(finding.code === "absolute-path" ? renderFinding(finding) : `${finding.severity} ${finding.code}`);
		else lines.push(`finding ${finding.code}: ${finding.message}`);
	}
	for (const node of details.nodes) {
		lines.push(`${node.address.join(" /")} — ${node.lifecycleText}`);
		lines.push(`  ${node.verificationText}`);
		lines.push(`  ${node.reviewText}`);
		for (const dispatch of node.dispatches) lines.push(`  dispatch hint only: node ${dispatch.nodeId} ↔ run ${dispatch.runId}/${dispatch.forkName}`);
		if (node.blockers.length > 0) lines.push(`  waiting for: ${renderBlockers(node.blockers)}`);
	}
	if (details.refresh.status === "blocked") lines.push(`refresh: blocked — ${details.refresh.message}`);
	if (details.truncated) lines.push("… output truncated");
	return lines.join("\n");
}

function response(details: WorkStatusDetails): { content: [{ type: "text"; text: string }]; details: WorkStatusDetails } {
	const rendered = render(details);
	if (rendered.length <= MAX_RENDERED_TEXT) return { content: [{ type: "text", text: rendered }], details };
	return { content: [{ type: "text", text: `${rendered.slice(0, MAX_RENDERED_TEXT - 24)}\n… output truncated` }], details: { ...details, truncated: true } };
}

export const workStatusTool = defineTool({
	name: "work_status",
	label: "Work status",
	description: "Derive qualified workspec node status from the current source and observed verification cache.",
	parameters: WorkStatusParameters,
	async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
		const result = await getWorkStatus({
			path: params.path,
			worktreePath: params.worktreePath,
			expectedCommit: params.expectedCommit,
			signal,
			...(params.refresh === undefined ? {} : {
				refresh: {
					nodeAddresses: params.refresh.nodeAddresses as NodeAddress[] | undefined,
					checklists: params.refresh.checklists?.map((entry) => ({ nodeAddress: entry.nodeAddress as NodeAddress, reports: entry.reports })),
				},
			}),
		});
		return response(result.details);
	},
});
