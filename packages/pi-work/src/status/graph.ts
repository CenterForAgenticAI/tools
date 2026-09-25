import { isCompositeNode } from "../schema/dependencies.js";
import type { WorkNode, Workspec } from "../schema/workspec.js";
import { addressKey, assembleWorkspec } from "../plan/index.js";
import type { NodeAddress, StatusFinding, StatusGraphBuild } from "./types.js";

function startsWithAddress(address: NodeAddress, prefix: NodeAddress): boolean {
	return address.length >= prefix.length && prefix.every((segment, index) => address[index] === segment);
}

function parentAddress(address: NodeAddress): NodeAddress {
	return address.slice(0, -1);
}

function childNodes(assemblies: readonly { address: NodeAddress; node: WorkNode }[], parent: NodeAddress): readonly { address: NodeAddress; node: WorkNode }[] {
	return assemblies.filter((assembly) => assembly.address.length === parent.length + 1 && startsWithAddress(assembly.address, parent));
}

/** Build a qualified, deterministic graph from the already validated source spec. */
export function buildStatusGraph(spec: Workspec): StatusGraphBuild {
	const assembled = assembleWorkspec(spec);
	const findings: StatusFinding[] = [];
	const byAddress = new Map(assembled.byAddress);
	const children = new Map<string, NodeAddress[]>();
	const dependencies = new Map<string, NodeAddress[]>();
	const ancestorDependencies = new Map<string, NodeAddress[]>();

	for (const assembly of assembled.assemblies) {
		const key = addressKey(assembly.address);
		if (children.has(key)) {
			findings.push({ code: "duplicate-node-address", address: assembly.address, message: `node address ${key} occurs more than once` });
		}
		children.set(key, isCompositeNode(assembly.node) ? childNodes(assembled.assemblies, assembly.address).map((child) => child.address) : []);

		const parent = parentAddress(assembly.address);
		const siblings = childNodes(assembled.assemblies, parent);
		const siblingById = new Map<string, NodeAddress[]>();
		for (const sibling of siblings) {
			const addresses = siblingById.get(sibling.node.id) ?? [];
			addresses.push(sibling.address);
			siblingById.set(sibling.node.id, addresses);
		}
		const direct: NodeAddress[] = [];
		for (const dependency of assembly.node.depends_on ?? []) {
			const matches = siblingById.get(dependency) ?? [];
			if (matches.length !== 1) {
				if (matches.length > 1) findings.push({ code: "ambiguous-node-id", nodeId: dependency, addresses: matches, message: `dependency ${dependency} resolves to more than one qualified address` });
				else findings.push({ code: "missing-node-address", address: [...parent, dependency], message: `dependency ${dependency} does not resolve in the node's sibling scope` });
				continue;
			}
			direct.push(matches[0]!);
		}
		dependencies.set(key, direct);

		const ancestor = new Map<string, NodeAddress>();
		for (let depth = 0; depth <= assembly.address.length; depth += 1) {
			const ancestorAddress = assembly.address.slice(0, depth);
			const ancestorAssembly = byAddress.get(addressKey(ancestorAddress));
			if (!ancestorAssembly) continue;
			for (const dependency of dependencies.get(addressKey(ancestorAddress)) ?? []) ancestor.set(addressKey(dependency), dependency);
		}
		ancestorDependencies.set(key, [...ancestor.values()]);
	}

	return {
		graph: { assemblies: assembled.assemblies, byAddress, children, dependencies, ancestorDependencies },
		findings,
	};
}
