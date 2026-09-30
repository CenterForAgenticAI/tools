import type {
	Destination,
	GraphSourceBody,
	NodeId,
	NodeSource,
	TemplateNodeSource,
} from "../model.js";

export type { GraphSource } from "../model.js";

export interface ParserBoundary {
	readonly document: unknown;
	readonly source?: GraphSourceBody;
}

export interface ShorthandParseResult {
	body?: GraphSourceBody;
	diagnostics: Array<{ code: string; message: string; path?: string }>;
}

type Segment =
	| { kind: "node"; name: NodeId; limit?: { max: number; onLimit: Destination }; routes: Array<{ verdict: string; to: Destination }> }
	| { kind: "parallel"; names: NodeId[] };

const namePattern = /^[a-z][a-z0-9-]*$/;
const terminalPattern = /^(?:done|fail)$/;

function diagnostic(code: string, message: string, path?: string) {
	return { code, message, ...(path ? { path } : {}) };
}

function parseDestination(value: string): { destination?: Destination; limit?: { max: number; onLimit: Destination }; error?: string } {
	const match = /^(?<name>[a-z][a-z0-9-]*|done|fail)(?:@(?<max>\d+)(?:>(?<onLimit>[a-z][a-z0-9-]*|done|fail))?)?$/.exec(value);
	if (!match?.groups) return { error: `Invalid destination ${value}.` };
	const destination = match.groups.name as Destination;
	if (!match.groups.max) return { destination };
	if (!match.groups.onLimit) return { error: `Limit on ${destination} must name a destination.` };
	return {
		destination,
		limit: { max: Number(match.groups.max), onLimit: match.groups.onLimit as Destination },
	};
}

function parseNodeSegment(value: string, index: number, targetLimits: Map<NodeId, { max: number; onLimit: Destination }>): { segment?: Segment; diagnostics: ShorthandParseResult["diagnostics"] } {
	const diagnostics: ShorthandParseResult["diagnostics"] = [];
	const trimmed = value.trim();
	const parallel = /^parallel\((.*)\)$/.exec(trimmed);
	if (parallel) {
		const names = parallel[1].split(",").map((name) => name.trim()).filter(Boolean);
		if (names.length < 2 || names.some((name) => !namePattern.test(name))) {
			diagnostics.push(diagnostic("E-SOURCE-SHAPE", `Invalid parallel segment ${trimmed}.`, `graph[${index}]`));
			return { diagnostics };
		}
		return { segment: { kind: "parallel", names }, diagnostics };
	}

	const match = /^(?<name>[a-z][a-z0-9-]*)(?<rest>.*)$/.exec(trimmed);
	if (!match?.groups) {
		diagnostics.push(diagnostic("E-SOURCE-SHAPE", `Invalid shorthand segment ${trimmed}.`, `graph[${index}]`));
		return { diagnostics };
	}
	const name = match.groups.name;
	let rest = match.groups.rest.trim();
	let limit: { max: number; onLimit: Destination } | undefined;
	const routes: Array<{ verdict: string; to: Destination }> = [];

	const ownLimit = /^@(?<max>\d+)(?:>(?<target>[a-z][a-z0-9-]*|done|fail))?/.exec(rest);
	if (ownLimit?.groups) {
		if (!ownLimit.groups.target) {
			diagnostics.push(diagnostic("E-SHORTHAND-LIMIT-NO-DEST", `Limit on ${name} has no destination.`, `graph[${index}]`));
		} else {
			limit = { max: Number(ownLimit.groups.max), onLimit: ownLimit.groups.target as Destination };
		}
		rest = rest.slice(ownLimit[0].length).trim();
	}

	while (rest) {
		const route = /^\?(?<verdict>[a-z][a-z0-9-]*)=(?<target>[a-z][a-z0-9-]*|done|fail)(?<targetLimit>@\d+(?:>[a-z][a-z0-9-]*|done|fail))?/.exec(rest);
		if (!route?.groups) {
			diagnostics.push(diagnostic("E-SOURCE-SHAPE", `Invalid route in shorthand segment ${trimmed}.`, `graph[${index}]`));
			break;
		}
		const parsed = parseDestination(`${route.groups.target}${route.groups.targetLimit ?? ""}`);
		if (parsed.error || !parsed.destination) {
			diagnostics.push(diagnostic("E-SHORTHAND-LIMIT-NO-DEST", parsed.error ?? "Invalid route.", `graph[${index}]`));
		} else {
			routes.push({ verdict: route.groups.verdict, to: parsed.destination });
			if (parsed.limit) {
				// The target's limit is applied after all segments have been collected.
				(targetLimits as Map<NodeId, { max: number; onLimit: Destination }>).set(parsed.destination, parsed.limit);
			}
		}
		rest = rest.slice(route[0].length).trim();
	}
	return { segment: { kind: "node", name, ...(limit === undefined ? {} : { limit }), routes }, diagnostics };
}

/** Parse the topology-only shorthand from the graph frontmatter. */
export function parseShorthand(value: string): ShorthandParseResult {
	const targetLimits = new Map<NodeId, { max: number; onLimit: Destination }>();
	const diagnostics: ShorthandParseResult["diagnostics"] = [];
	const pieces = value.split("->").map((piece) => piece.trim()).filter(Boolean);
	if (pieces.length < 2) {
		return { diagnostics: [diagnostic("E-SOURCE-SHAPE", "A shorthand graph needs a node and a terminal.", "graph")] };
	}
	const terminal = pieces.at(-1);
	if (!terminal || !terminalPattern.test(terminal)) {
		return { diagnostics: [diagnostic("E-SOURCE-SHAPE", "A shorthand graph must end at done or fail.", "graph")] };
	}
	const segmentValues = pieces.slice(0, -1);
	const segments: Segment[] = [];
	for (const [index, piece] of segmentValues.entries()) {
		const parsed = parseNodeSegment(piece, index, targetLimits);
		diagnostics.push(...parsed.diagnostics);
		if (parsed.segment) segments.push(parsed.segment);
	}
	if (diagnostics.length) return { diagnostics };
	if (segments[0]?.kind === "parallel") {
		diagnostics.push(diagnostic("E-SHORTHAND-PARALLEL-ENTRY", "A parallel group cannot be the entry point.", "graph[0]"));
	}
	if (segments.at(-1)?.kind === "parallel") {
		diagnostics.push(diagnostic("E-SHORTHAND-PARALLEL-TERMINAL", "A parallel group needs a following join node.", `graph[${segments.length - 1}]`));
	}
	if (diagnostics.length) return { diagnostics };

	const names = new Set<NodeId>();
	for (const segment of segments) {
		const segmentNames = segment.kind === "node" ? [segment.name] : segment.names;
		for (const name of segmentNames) {
			if (names.has(name)) diagnostics.push(diagnostic("E-SOURCE-SHAPE", `Duplicate shorthand node ${name}.`, "graph"));
			names.add(name);
		}
	}
	const checkDestination = (destination: Destination) => {
		if (!terminalPattern.test(destination) && !names.has(destination)) {
			diagnostics.push(diagnostic("E-SHORTHAND-DANGLING-TARGET", `Shorthand destination ${destination} is not a segment.`, "graph"));
		}
	};
	for (const segment of segments) {
		if (segment.kind === "node") {
			segment.routes.forEach((route) => checkDestination(route.to));
			if (segment.limit) checkDestination(segment.limit.onLimit);
		}
	}
	for (const [name, limit] of targetLimits) {
		if (!names.has(name)) diagnostics.push(diagnostic("E-SHORTHAND-DANGLING-TARGET", `Shorthand destination ${name} is not a segment.`, "graph"));
		checkDestination(limit.onLimit);
	}
	if (diagnostics.length) return { diagnostics };

	const nodes: Record<NodeId, NodeSource> = {};
	for (const segment of segments) {
		if (segment.kind === "parallel") {
			for (const name of segment.names) nodes[name] = { template: name } satisfies TemplateNodeSource;
		} else {
			const node: TemplateNodeSource = { template: segment.name };
			if (segment.limit) { node.limit = segment.limit.max; node.onLimit = segment.limit.onLimit; }
			const targetLimit = targetLimits.get(segment.name);
			if (targetLimit) { node.limit = targetLimit.max; node.onLimit = targetLimit.onLimit; }
			if (segment.routes.length) node.on = Object.fromEntries(segment.routes.map((route) => [route.verdict, route.to]));
			nodes[segment.name] = node;
		}
	}
	for (const [index, segment] of segments.entries()) {
		const next = segments[index + 1];
		const following: Destination[] = next
			? next.kind === "parallel" ? next.names : [next.name]
			: [terminal];
		if (segment.kind === "node") {
			const node = nodes[segment.name] as TemplateNodeSource;
			if (!segment.routes.length) node.next = following.length === 1 ? following[0] : following;
		} else {
			if (!next) continue;
			const destination = following[0] ?? terminal;
			for (const name of segment.names) (nodes[name] as TemplateNodeSource).next = destination;
		}
	}
	return { body: { entry: segments[0].kind === "node" ? segments[0].name : segments[0].names[0], nodes }, diagnostics };
}
