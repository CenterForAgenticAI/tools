import type { FindingPath, SemanticFinding } from "./findings.js";
import type { AcceptanceCriterion, WorkNode, Workspec } from "./workspec.js";

function at(path: FindingPath, segment: string | number): FindingPath {
	return [...path, segment];
}

function hasWork(node: WorkNode): node is WorkNode & { work: WorkNode[] } {
	return "work" in node && Array.isArray(node.work);
}

function nodeId(node: WorkNode): string {
	return node.id;
}

/** Validate IDs, criteria identity, sibling dependency scope, and cycles. */
export function validateDependencies(spec: Workspec): SemanticFinding[] {
	const findings: SemanticFinding[] = [];
	function visitScope(nodes: WorkNode[], scopePath: FindingPath): void {
		const ids = new Map<string, number>();
		for (let index = 0; index < nodes.length; index++) {
			const node = nodes[index];
			const id = nodeId(node);
			const path = at(at(scopePath, index), "id");
			const previous = ids.get(id);
			if (previous !== undefined) {
				findings.push({ code: "duplicate-node-id", severity: "error", path, id, relatedPaths: [at(at(scopePath, previous), "id")] });
			} else ids.set(id, index);
			validateCriteria(node, at(scopePath, index));
		}
		for (let index = 0; index < nodes.length; index++) {
			const node = nodes[index];
			if (node.depends_on) {
				for (let dependencyIndex = 0; dependencyIndex < node.depends_on.length; dependencyIndex++) {
					const dependency = node.depends_on[dependencyIndex];
					const dependencyPath = at(at(at(scopePath, index), "depends_on"), dependencyIndex);
					if (dependency === node.id) findings.push({ code: "dependency-self", severity: "error", path: dependencyPath, dependency });
					else if (!ids.has(dependency)) findings.push({ code: "dependency-unresolved", severity: "error", path: dependencyPath, dependency });
				}
			}
		}
		const graph = new Map<string, string[]>();
		for (const node of nodes) graph.set(node.id, (node.depends_on ?? []).filter((id) => ids.has(id)));
		findCycles(graph, nodes, scopePath, findings);
		for (let index = 0; index < nodes.length; index++) {
			const node = nodes[index];
			if (hasWork(node)) visitScope(node.work as WorkNode[], at(at(scopePath, index), "work"));
		}
	}
	function validateCriteria(node: WorkNode, path: FindingPath): void {
		const seen = new Map<string, number>();
		const criteria = node.acceptance ?? [];
		for (let index = 0; index < criteria.length; index++) {
			const criterion = criteria[index];
			const prior = seen.get(criterion.id);
			const criterionPath = at(at(path, "acceptance"), index);
			if (prior !== undefined) findings.push({ code: "duplicate-criterion-id", severity: "error", path: at(criterionPath, "id"), id: criterion.id, relatedPaths: [at(at(at(path, "acceptance"), prior), "id")] });
			else seen.set(criterion.id, index);
		}
	}
	visitScope(spec.work, ["work"]);
	return findings;
}

function findCycles(graph: Map<string, string[]>, nodes: WorkNode[], scopePath: FindingPath, findings: SemanticFinding[]): void {
	const paths = new Map(nodes.map((node, index) => [node.id, at(at(scopePath, index), "depends_on")]));
	const indexes = new Map<string, number>();
	const lowlinks = new Map<string, number>();
	const stack: string[] = [];
	const onStack = new Set<string>();
	const components: string[][] = [];
	let nextIndex = 0;

	function visit(id: string): void {
		indexes.set(id, nextIndex);
		lowlinks.set(id, nextIndex);
		nextIndex++;
		stack.push(id);
		onStack.add(id);
		for (const dependency of graph.get(id) ?? []) {
			if (!indexes.has(dependency)) {
				visit(dependency);
				lowlinks.set(id, Math.min(lowlinks.get(id)!, lowlinks.get(dependency)!));
			} else if (onStack.has(dependency)) {
				lowlinks.set(id, Math.min(lowlinks.get(id)!, indexes.get(dependency)!));
			}
		}
		if (lowlinks.get(id) !== indexes.get(id)) return;
		const component: string[] = [];
		let member: string;
		do {
			member = stack.pop()!;
			onStack.delete(member);
			component.push(member);
		} while (member !== id);
		if (component.length > 1) components.push(component.sort());
		}
	for (const node of nodes) if (!indexes.has(node.id)) visit(node.id);
	for (const members of components.sort((a, b) => a[0].localeCompare(b[0]))) {
		findings.push({
			code: "dependency-cycle",
			severity: "error",
			path: paths.get(members[0]) ?? scopePath,
			members,
			relatedPaths: members.map((member) => paths.get(member) ?? scopePath),
		});
	}
}

export function isCompositeNode(node: WorkNode): node is WorkNode & { work: WorkNode[] } {
	return hasWork(node);
}

export type { AcceptanceCriterion };
