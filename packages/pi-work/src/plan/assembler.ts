import { isCompositeNode } from "../schema/dependencies.js";
import type { FindingPath } from "../schema/findings.js";
import type { WorkNode, Workspec } from "../schema/workspec.js";
import type { NodeAddress, NodeContractAssembly, ParentContext } from "./types.js";

export interface AssemblyIndex {
	readonly assemblies: readonly NodeContractAssembly[];
	readonly byAddress: ReadonlyMap<string, NodeContractAssembly>;
}

export function addressKey(address: NodeAddress): string {
	return JSON.stringify(address);
}

export function formatNodeAddress(address: NodeAddress): string {
	return address.length === 0 ? "$" : address.join(" /");
}

/** Assemble every node once, carrying its immutable ancestor context during the DFS. */
export function assembleWorkspec(spec: Workspec): AssemblyIndex {
	const assemblies: NodeContractAssembly[] = [];
	const byAddress = new Map<string, NodeContractAssembly>();
	const specContext = { title: spec.title, description: spec.description, intent: spec.intent } as const;

	function visit(nodes: readonly WorkNode[], parentPath: FindingPath, parentAddress: NodeAddress, parents: readonly ParentContext[]): void {
		nodes.forEach((node, index) => {
			const path: FindingPath = [...parentPath, index];
			const address: NodeAddress = [...parentAddress, node.id];
			const assembly: NodeContractAssembly = {
				spec: specContext,
				node,
				address,
				path,
				parents,
			};
			assemblies.push(assembly);
			byAddress.set(addressKey(address), assembly);
			if (isCompositeNode(node)) {
				const current: ParentContext = {
					address,
					path,
					id: node.id,
					task: node.task,
					...(node.description === undefined ? {} : { description: node.description }),
				};
				visit(node.work, [...path, "work"], address, [...parents, current]);
			}
		});
	}

	visit(spec.work, ["work"], [], []);
	return { assemblies, byAddress };
}

export const assembleNodeContracts = assembleWorkspec;
