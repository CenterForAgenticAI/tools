import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { validateDependencies } from "../schema/dependencies.js";
import { findTouchOverlaps, type LocatedWorkNode } from "../lint/touches-overlap.js";
import { renderWorkerBrief } from "./projectors.js";
import { addressKey, assembleWorkspec, formatNodeAddress } from "./assembler.js";
import type { CanonicalDelegateRun, CompilePlanOptions, DelegateFocus, DelegateHandoff, DelegateInvocation, NodeContractAssembly, PlanFinding, PlanReceipt, PlanResult } from "./types.js";
import type { Workspec } from "./types.js";

function sha256(source: string): string {
	return createHash("sha256").update(source, "utf8").digest("hex");
}

function briefPathFor(directory: string, contentSha256: string): string {
	return path.join(directory, `${contentSha256}.md`);
}

async function writeBrief(filePath: string, content: string): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeFile(temporary, content, "utf8");
		await rename(temporary, filePath);
	} catch (error) {
		try { await rename(temporary, `${temporary}.failed`); } catch { /* best effort cleanup */ }
		throw error;
	}
}

function profileFinding(assembly: NodeContractAssembly, profile: string): PlanFinding {
	return {
		code: "worker-profile-unsupported",
		path: [...assembly.path, "worker", "profile"],
		profile,
		message: `worker.profile ${JSON.stringify(profile)} cannot be compiled until pi-delegate profile support (#142) ships`,
	};
}

function invalidSpecFindings(spec: Workspec): PlanFinding[] {
	return validateDependencies(spec).map((finding) => ({
		code: "invalid-spec",
		message: `spec validation failed: ${finding.code} at ${finding.path.length === 0 ? "$" : finding.path.join(".")}`,
	}));
}

const MAX_FOCUS_OBJECTIVE_CHARS = 1000;
const MAX_FOCUS_BOUNDARIES = 50;
const MAX_FOCUS_BOUNDARY_CHARS = 512;

/**
 * Seed the worker's durable objective from the node's own task and declared
 * touches -- the same material the by-reference brief already renders as prose.
 * Truncate to pi-delegate's published limits rather than emitting a payload it
 * would reject: a refused namespace is a dispatch that reports success while
 * seeding nothing.
 */
function focusFor(assembly: NodeContractAssembly): DelegateFocus | undefined {
	const objective = assembly.node.task.trim();
	if (objective.length === 0) return undefined;
	const touches = assembly.node.touches ?? [];
	const boundaries = touches.length === 0
		? []
		: [`Confine writes to the declared touches: ${touches.join(", ")}`]
			.map((boundary) => boundary.slice(0, MAX_FOCUS_BOUNDARY_CHARS))
			.slice(0, MAX_FOCUS_BOUNDARIES);
	return {
		objective: objective.slice(0, MAX_FOCUS_OBJECTIVE_CHARS),
		...(boundaries.length === 0 ? {} : { boundaries }),
	};
}

function handoffFor(assembly: NodeContractAssembly): DelegateHandoff | undefined {
	const tasks = assembly.node.checklist;
	const focus = focusFor(assembly);
	// pi-delegate rejects an empty tasks list outright -- "omit it rather than
	// passing an empty list" -- so a node with focus but no checklist must carry
	// focus alone rather than an empty carrier.
	if (tasks === undefined || tasks.length === 0) return focus === undefined ? undefined : { focus };
	return { tasks: [...tasks], ...(focus === undefined ? {} : { focus }) };
}

export async function compileWorkPlan(spec: Workspec, options: CompilePlanOptions): Promise<PlanResult> {
	const specFindings = invalidSpecFindings(spec);
	if (specFindings.length > 0) return { ok: false, plans: [], advisories: [], worktree: false, findings: specFindings };
	if (options.nodeAddresses.length === 0) {
		return { ok: false, plans: [], advisories: [], worktree: false, findings: [{ code: "node-address-required", path: ["nodeAddresses"], message: "at least one ready node address is required" }] };
	}
	const seen = new Set<string>();
	const duplicateFindings: PlanFinding[] = [];
	for (const address of options.nodeAddresses) {
		const key = addressKey(address);
		if (seen.has(key)) duplicateFindings.push({ code: "duplicate-node-address", address, message: `duplicate node address ${formatNodeAddress(address)}` });
		seen.add(key);
	}
	if (duplicateFindings.length > 0) return { ok: false, plans: [], advisories: [], worktree: false, findings: duplicateFindings };

	const index = assembleWorkspec(spec);
	const selected: NodeContractAssembly[] = [];
	const selectionFindings: PlanFinding[] = [];
	for (const address of options.nodeAddresses) {
		const assembly = index.byAddress.get(addressKey(address));
		if (!assembly) selectionFindings.push({ code: "node-address-not-found", address, message: `node address ${formatNodeAddress(address)} does not exist` });
		else selected.push(assembly);
	}
	if (selectionFindings.length > 0) return { ok: false, plans: [], advisories: [], worktree: false, findings: selectionFindings };

	const profileFindings = selected.flatMap((assembly) => assembly.node.worker?.profile === undefined ? [] : [profileFinding(assembly, assembly.node.worker.profile)]);
	if (profileFindings.length > 0) return { ok: false, plans: [], advisories: [], worktree: false, findings: profileFindings };

	const briefDirectory = path.resolve(options.briefDirectory ?? path.join(options.cwd, ".work", ".cache", "briefs"));
	const worktree = selected.length > 1;
	const receipts: PlanReceipt[] = [];
	for (const assembly of selected) {
		const content = renderWorkerBrief(assembly);
		const contentSha256 = sha256(content);
		const briefPath = briefPathFor(briefDirectory, contentSha256);
		try {
			await writeBrief(briefPath, content);
		} catch (error) {
			return {
				ok: false,
				plans: [],
				advisories: [],
				worktree: false,
				findings: [{ code: "brief-write-error", path: assembly.path, message: error instanceof Error ? error.message : String(error) }],
			};
		}
		const agent = assembly.node.worker?.agent ?? "worker";
		const task = `Execute the assembled work contract for node ${assembly.node.id}; read the contract from the attached brief.`;
		const handoff = handoffFor(assembly);
		const shared = {
			agent,
			...(assembly.node.worker?.skills === undefined ? {} : { skills: assembly.node.worker.skills }),
			...(assembly.node.worker?.model === undefined ? {} : { model: assembly.node.worker.model }),
			...(worktree ? {} : { cwd: path.resolve(options.cwd) }),
			reads: [briefPath] as [string],
			task,
			...(assembly.node.touches === undefined ? {} : { writableRoots: assembly.node.touches }),
			confineWrites: true as const,
			escalation: "local" as const,
			worktree,
		};
		const delegate: DelegateInvocation = shared;
		const canonicalRun: CanonicalDelegateRun = {
			name: assembly.node.id,
			...shared,
			mode: "solo",
			...(handoff === undefined ? {} : { handoff }),
		};
		receipts.push({
			nodeId: assembly.node.id,
			nodeAddress: assembly.address,
			schemaPath: assembly.path,
			briefPath,
			briefSha256: contentSha256,
			// One digest per namespace, over that namespace's own bytes. Hashing the
			// pair would not match what the runtime records for either.
			...(handoff?.tasks === undefined ? {} : { handoffSha256: sha256(JSON.stringify(handoff.tasks)) }),
			...(handoff?.focus === undefined ? {} : { focusSha256: sha256(JSON.stringify(handoff.focus)) }),
			delegate,
			canonicalDelegate: { runs: [canonicalRun] },
		});
	}
	const located: LocatedWorkNode[] = selected.map((assembly) => ({ node: assembly.node, path: assembly.path }));
	const overlaps = findTouchOverlaps(located);
	return { ok: true, plans: receipts, advisories: overlaps.length === 0 ? [] : [{ kind: "touch-overlap", overlaps }], worktree };
}

export type WorkPlanCompilationResult = Awaited<ReturnType<typeof compileWorkPlan>> & { readonly worktree?: boolean };
