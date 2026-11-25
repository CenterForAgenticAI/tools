/** Exact, typed overlap classification for non-authoritative registry projections. */

import fs from "node:fs";
import path from "node:path";
import { parseRegistryProjection, type RegistryProjection, type WorkstreamRef } from "./workstream-schema.js";

export type OverlapKind = "gitlab-mr" | "github-issue" | "graft-spec" | "commit" | "branch" | "path";
export type OverlapClassification = "none" | "intentional-chain" | "potential-collision" | "workspace-collision";

export interface OverlapCandidate extends RegistryProjection {
	/** Optional canonical project identity for callers that do not use projectKey. */
	readonly commonDirectory?: string;
}

export interface OverlapMatch {
	readonly kind: OverlapKind;
	readonly value: string;
	readonly withPiSessionId: string;
	readonly withWorkstreamId: string;
}

export interface OverlapResult {
	readonly classification: OverlapClassification;
	readonly matches: readonly OverlapMatch[];
	readonly action: string;
}

const STRONG_KINDS: readonly OverlapKind[] = ["gitlab-mr", "github-issue", "graft-spec", "commit"];
const MATCH_KINDS: readonly OverlapKind[] = [...STRONG_KINDS, "branch", "path"];

function collapse(value: string): string {
	return value.trim().replaceAll(/\s+/g, " ");
}

function normalizeGitLabHost(value: string): string {
	const url = /^https?:\/\/([^/]+)\/(.+)$/i.exec(value);
	return url === null ? value : `${url[1]!.toLowerCase()}/${url[2]!}`;
}

function stripGitLabUrl(value: string): string {
	return normalizeGitLabHost(value)
		.replace(/\/-\/merge_requests\//i, "!")
		.replace(/\/merge_requests\//i, "!");
}

function stripGitHubUrl(value: string): string {
	return value
		.replace(/^https?:\/\/github\.com\//i, "")
		.replace(/\/issues\//i, "#");
}

function normalizedPath(value: string): string {
	const resolved = path.resolve(value);
	try {
		return fs.realpathSync.native(resolved).replaceAll("\\", "/").replace(/\/$/, "");
	} catch {
		return resolved.replaceAll("\\", "/").replace(/\/$/, "");
	}
}

/** Normalize a supported reference without fuzzy or embedding-based matching. */
export function normalizeOverlapRef(ref: WorkstreamRef): string | null {
	if (!MATCH_KINDS.includes(ref.kind as OverlapKind)) return null;
	let value = (ref.kind === "path" ? ref.value.trim() : collapse(ref.value)).replaceAll("\\", "/");
	if (!value) return null;
	switch (ref.kind) {
		case "gitlab-mr":
			value = stripGitLabUrl(value).replace(/\.json$/i, "").toLowerCase();
			break;
		case "github-issue":
			value = stripGitHubUrl(value).replace(/\.json$/i, "").toLowerCase();
			break;
		case "graft-spec":
			value = value.replace(/^.*\//, "").replace(/\.ya?ml$/i, "").toLowerCase();
			break;
		case "commit":
			value = value.toLowerCase();
			break;
		case "branch":
			value = value.replace(/^refs\/heads\//, "");
			break;
		case "path":
			value = normalizedPath(value);
			break;
	}
	return value ? `${ref.kind}:${value}` : null;
}

function validCandidate(candidate: OverlapCandidate): OverlapCandidate | null {
	const parsed = parseRegistryProjection(candidate);
	if (!parsed) return null;
	return candidate.commonDirectory === undefined ? parsed : { ...parsed, commonDirectory: candidate.commonDirectory };
}

function sameGitCommonDirectory(first: OverlapCandidate, second: OverlapCandidate): boolean {
	if (first.commonDirectory !== undefined && second.commonDirectory !== undefined) {
		return normalizedPath(first.commonDirectory) === normalizedPath(second.commonDirectory);
	}
	return first.projectKey === second.projectKey;
}

function refsByKind(candidate: OverlapCandidate, kinds: readonly OverlapKind[]): Map<string, WorkstreamRef> {
	const result = new Map<string, WorkstreamRef>();
	for (const ref of candidate.refs) {
		if (!kinds.includes(ref.kind as OverlapKind)) continue;
		const normalized = normalizeOverlapRef(ref);
		if (normalized !== null) result.set(normalized, ref);
	}
	return result;
}

function matchesFor(current: OverlapCandidate, other: OverlapCandidate, kinds: readonly OverlapKind[]): OverlapMatch[] {
	const currentRefs = refsByKind(current, kinds);
	const matches: OverlapMatch[] = [];
	for (const ref of other.refs) {
		const normalized = normalizeOverlapRef(ref);
		if (!normalized || !currentRefs.has(normalized)) continue;
		matches.push({
			kind: ref.kind as OverlapKind,
			value: normalized.slice(normalized.indexOf(":") + 1),
			withPiSessionId: other.piSessionId,
			withWorkstreamId: other.workstreamId,
		});
	}
	return matches.filter((match, index, all) => all.findIndex((item) => item.kind === match.kind && item.value === match.value && item.withPiSessionId === match.withPiSessionId) === index);
}

/** Classify exact overlaps; the result is advisory and never mutates transcript state. */
export function classifyOverlaps(current: OverlapCandidate, candidates: readonly OverlapCandidate[], options: { readonly includeStale?: boolean } = {}): OverlapResult {
	const validatedCurrent = validCandidate(current);
	if (!validatedCurrent || validatedCurrent.state === "stale") return { classification: "none", matches: [], action: "No exact overlap detected." };
	const strongMatches: OverlapMatch[] = [];
	const branchMatches: OverlapMatch[] = [];
	const pathMatches: OverlapMatch[] = [];
	for (const other of candidates) {
		const validatedOther = validCandidate(other);
		if (!validatedOther || validatedOther.piSessionId === validatedCurrent.piSessionId) continue;
		if (!options.includeStale && validatedOther.state === "stale") continue;
		strongMatches.push(...matchesFor(validatedCurrent, validatedOther, STRONG_KINDS));
		if (sameGitCommonDirectory(validatedCurrent, validatedOther)) {
			branchMatches.push(...matchesFor(validatedCurrent, validatedOther, ["branch"]));
		}
		pathMatches.push(...matchesFor(validatedCurrent, validatedOther, ["path"]));
	}
	const matches = strongMatches.length > 0 ? strongMatches : branchMatches.length > 0 ? branchMatches : pathMatches;
	const uniqueMatches = matches.filter((match, index, all) => all.findIndex((item) => item.kind === match.kind && item.value === match.value && item.withPiSessionId === match.withPiSessionId) === index);
	if (uniqueMatches.length === 0) return { classification: "none", matches: [], action: "No exact overlap detected." };
	const sameWorkstream = uniqueMatches.every((match) => match.withWorkstreamId === validatedCurrent.workstreamId);
	if (sameWorkstream) return {
		classification: "intentional-chain",
		matches: uniqueMatches,
		action: "These sessions share a workstream and form an intentional chain; review only if the handoff is unexpected.",
	};
	const strong = uniqueMatches.some((match) => STRONG_KINDS.includes(match.kind));
	return {
		classification: strong ? "potential-collision" : "workspace-collision",
		matches: uniqueMatches,
		action: strong
			? "Distinct workstreams claim the same strong reference; review the objective and coordinate before proceeding."
			: "Sessions share a workspace reference; review the target before editing or jumping.",
	};
}

export function findOverlaps(current: OverlapCandidate, candidates: readonly OverlapCandidate[], options: { readonly includeStale?: boolean } = {}): OverlapResult {
	return classifyOverlaps(current, candidates, options);
}
