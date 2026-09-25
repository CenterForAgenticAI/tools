import { isMap, isScalar, isSeq, parseDocument, type Document, type Node } from "yaml";

import {
	deduplicateFindings,
	type FindingPath,
	type TaggedScalar,
	type YamlFinding,
} from "./findings.js";
import { customTags, isAllowedTag } from "./tags.js";

export interface ParsedYaml {
	source: string;
	value?: unknown;
	tags: TaggedScalar[];
	findings: YamlFinding[];
	document?: Document;
}

function childPath(path: FindingPath, segment: string | number): FindingPath {
	return [...path, segment];
}

function scalarTagStyle(node: Node): TaggedScalar["style"] | undefined {
	if (!isScalar(node)) return undefined;
	if (node.type === "BLOCK_LITERAL") return "literal";
	if (node.type === "BLOCK_FOLDED") return "folded";
	return undefined;
}

function explicitTag(node: Node): string | undefined {
	return typeof node.tag === "string" ? node.tag : undefined;
}

function walkNode(node: Node | null | undefined, path: FindingPath, tags: TaggedScalar[], findings: YamlFinding[]): void {
	if (!node) return;
	const tag = explicitTag(node);
	if (tag && !tag.startsWith("!!") && !isAllowedTag(tag)) {
		findings.push({ code: "yaml-unknown-tag", severity: "error", path, tag });
	}
	if (tag && isAllowedTag(tag)) {
		const style = scalarTagStyle(node);
		if (style) tags.push({ path, tag, style });
		else findings.push({ code: "yaml-tag-style", severity: "error", path, tag, style: isScalar(node) ? String(node.type ?? "plain") : "collection" });
	}
	if (isMap(node)) {
		for (const pair of node.items) {
			const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key?.toString() ?? "");
			walkNode(pair.value as Node | null | undefined, childPath(path, key), tags, findings);
		}
	} else if (isSeq(node)) {
		node.items.forEach((item, index) => walkNode(item as Node | null | undefined, childPath(path, index), tags, findings));
	}
}

function syntaxFindings(document: Document): YamlFinding[] {
	return document.errors.map((error) => ({
		code: "yaml-syntax" as const,
		severity: "error" as const,
		path: [] as const,
		message: error.message,
	}));
}

/** Parse one YAML document while retaining the exact authored source. */
export function parseYaml(source: string): ParsedYaml {
	let document: Document;
	try {
		document = parseDocument(source, {
			customTags,
			keepSourceTokens: true,
			prettyErrors: false,
		});
	} catch (error) {
		return {
			source,
			tags: [],
			findings: [{ code: "yaml-syntax", severity: "error", path: [], message: error instanceof Error ? error.message : String(error) }],
		};
	}
	const tags: TaggedScalar[] = [];
	const findings = syntaxFindings(document);
	walkNode(document.contents as Node | null | undefined, [], tags, findings);
	if (document.contents === null) findings.push({ code: "yaml-syntax", severity: "error", path: [], message: "YAML document is empty" });
	if (document.contents && document.errors.length === 0 && document.contents) {
		try {
			return { source, value: document.toJS(), tags, findings: deduplicateFindings(findings), document };
		} catch (error) {
			findings.push({ code: "yaml-syntax", severity: "error", path: [], message: error instanceof Error ? error.message : String(error) });
		}
	}
	return { source, tags, findings: deduplicateFindings(findings), document };
}

export function parseWorkspec(source: string): ParsedYaml & { valid: boolean } {
	const parsed = parseYaml(source);
	return { ...parsed, valid: parsed.findings.every((finding) => finding.severity !== "error") };
}
