import type { FindingPath } from "../schema/findings.js";
import type { WorkNode, Workspec } from "../schema/workspec.js";

export interface LocatedWorkNode {
	node: WorkNode;
	path: FindingPath;
}

export interface TouchDeclaration {
	target: string;
	nodeId: string;
	path: FindingPath;
	nodePath: FindingPath;
}

export interface TouchOverlap {
	target: string;
	nodeIds: string[];
	declarations: TouchDeclaration[];
	count: number;
}

export function normalizeTouchTarget(target: string): string {
	return target.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/").replace(/\/+$/, "");
}

export function flattenWorkNodes(specOrNodes: Workspec | readonly WorkNode[]): LocatedWorkNode[] {
	const isSpec = !Array.isArray(specOrNodes);
	const root: readonly WorkNode[] = isSpec ? (specOrNodes as Workspec).work : specOrNodes;
	const rootPath: FindingPath = isSpec ? ["work"] : [];
	const result: LocatedWorkNode[] = [];
	function visit(nodes: readonly WorkNode[], path: FindingPath): void {
		nodes.forEach((node, index) => {
			const nodePath = [...path, index];
			result.push({ node, path: nodePath });
			if ("work" in node && Array.isArray(node.work)) visit(node.work, [...nodePath, "work"]);
		});
	}
	visit(root, rootPath);
	return result;
}

/**
 * Find exact normalized target declarations shared by at least two distinct nodes.
 * Selectors are compared as declared writable roots; this deliberately does not
 * attempt filesystem or glob-language intersection.
 */
export function findTouchOverlaps(specOrNodes: Workspec | readonly WorkNode[] | readonly LocatedWorkNode[]): TouchOverlap[] {
	const located: readonly LocatedWorkNode[] = Array.isArray(specOrNodes)
		? (specOrNodes.length === 0
			? []
			: "path" in (specOrNodes[0] as object)
				? specOrNodes as readonly LocatedWorkNode[]
				: flattenWorkNodes(specOrNodes as readonly WorkNode[]))
		: flattenWorkNodes(specOrNodes as Workspec);
	const groups = new Map<string, TouchDeclaration[]>();
	for (const entry of located) {
		const touches = entry.node.touches ?? [];
		const seen = new Set<string>();
		for (let index = 0; index < touches.length; index++) {
			const target = normalizeTouchTarget(touches[index]);
			if (!target || seen.has(target)) continue;
			seen.add(target);
			const declarations = groups.get(target) ?? [];
			declarations.push({ target, nodeId: entry.node.id, path: [...entry.path, "touches", index], nodePath: entry.path });
			groups.set(target, declarations);
		}
	}
	return [...groups.entries()]
		.map(([target, declarations]) => ({
			target,
			declarations,
			nodeIds: [...new Set(declarations.map((declaration) => declaration.nodeId))],
			count: new Set(declarations.map((declaration) => JSON.stringify(declaration.nodePath))).size,
		}))
		.filter((overlap) => overlap.count >= 2)
		.sort((a, b) => a.target.localeCompare(b.target));
}
