/** Additive, provider-neutral contracts for optional peer packages. */

import {
	WORKSTREAM_SCHEMA_VERSION,
	type WorkstreamRef,
	type WorkstreamStatus,
} from "./workstream-schema.js";

export const INTERCOM_CONTRACT_VERSION = 1 as const;
export const FOCUS_SEED_CONTRACT_VERSION = 1 as const;
export const FOCUS_SEED_CHANNEL = "context-aware.focus-seed.v1" as const;
export const WORKTREE_LAUNCHER_CONTRACT_VERSION = 1 as const;
export const TERMINAL_ACK_CONTRACT_VERSION = 1 as const;

export type PeerRef = Pick<WorkstreamRef, "kind" | "value">;

export interface RelevanceMetadata {
	readonly score: number;
	readonly reason: string;
}

export interface CanonicalTargetUpdate {
	readonly kind: "path" | "branch" | "commit" | "url";
	readonly value: string;
	readonly updatedAt: string;
	readonly source: "user" | "agent" | "launcher";
}

/** Optional metadata consumed by pi-intercom; it never carries routing instructions. */
export interface IntercomMetadata {
	readonly schemaVersion: typeof INTERCOM_CONTRACT_VERSION;
	readonly workstreamId: string;
	readonly piSessionId: string;
	readonly intercomConnectionId?: string;
	readonly objective: string;
	readonly status: WorkstreamStatus;
	readonly refs: readonly PeerRef[];
	readonly relevance?: RelevanceMetadata;
	readonly canonicalTargetUpdate?: CanonicalTargetUpdate;
}

export interface PeerTerminalLocation {
	readonly terminalId: string;
	readonly kind: "cmux" | "tmux" | "other";
	readonly location?: string;
}

export interface WorkspaceLocation {
	readonly kind: "path" | "branch" | "url";
	readonly value: string;
}

/** Expiring metadata consumed by pi-worktree-launcher; it does not launch or create worktrees. */
export interface WorktreeHandoff {
	readonly schemaVersion: typeof WORKTREE_LAUNCHER_CONTRACT_VERSION;
	readonly handoffId: string;
	readonly workstreamId: string;
	readonly parentPiSessionId: string;
	readonly objective: string;
	readonly status: WorkstreamStatus;
	readonly refs?: readonly PeerRef[];
	readonly requestedLocation?: WorkspaceLocation;
	readonly expiresAt: string;
}

/** A host's declaration of what a session it created is for. */
export interface FocusSeed {
	readonly schemaVersion: typeof FOCUS_SEED_CONTRACT_VERSION;
	readonly objective: string;
	readonly boundaries?: readonly string[];
	readonly refs?: readonly PeerRef[];
	/** Which host declared this, e.g. "pi-delegate". */
	readonly host?: string;
	readonly parentPiSessionId?: string;
}

export interface TerminalLocationAcknowledgement {
	readonly schemaVersion: typeof TERMINAL_ACK_CONTRACT_VERSION;
	readonly handoffId: string;
	readonly workstreamId: string;
	readonly piSessionId: string;
	readonly terminal: PeerTerminalLocation;
	readonly workspace?: WorkspaceLocation;
	readonly acknowledgedAt: string;
}

export interface OwnershipBoundary {
	readonly owns: readonly string[];
	readonly doesNotOwn: readonly string[];
}

export const CONTEXT_AWARE_OWNERSHIP: OwnershipBoundary = {
	owns: [
		"durable workstream identity and bounded projections",
		"versioned peer metadata validation",
		"privacy-safe diagnostics and capability health",
	],
	doesNotOwn: [
		"pi-intercom routing, wake policy, or replies",
		"Git worktree creation, selection, launch, or cleanup",
		"terminal process launching or command construction",
		"graft-managed worktree lifecycle",
	],
};

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max = 512): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function timestamp(value: unknown): value is string {
	return boundedString(value, 64) && Number.isFinite(Date.parse(value));
}

function status(value: unknown): value is WorkstreamStatus {
	return value === "active" || value === "paused" || value === "completed" || value === "detached";
}

const REF_KINDS: readonly PeerRef["kind"][] = [
	"gitlab-mr", "github-issue", "graft-spec", "branch", "commit", "path", "url", "other",
];

function parseRefs(value: unknown, optional: boolean): PeerRef[] | undefined {
	if (value === undefined && optional) return undefined;
	if (!Array.isArray(value) || value.length > 50) return undefined;
	const refs: PeerRef[] = [];
	for (const candidate of value) {
		if (!isRecord(candidate) || !REF_KINDS.includes(candidate.kind as PeerRef["kind"]) || !boundedString(candidate.value)) return undefined;
		refs.push({ kind: candidate.kind as PeerRef["kind"], value: candidate.value });
	}
	return refs;
}

function parseTerminal(value: unknown): PeerTerminalLocation | undefined {
	if (!isRecord(value) || !boundedString(value.terminalId, 256)) return undefined;
	if (value.kind !== "cmux" && value.kind !== "tmux" && value.kind !== "other") return undefined;
	if (value.location !== undefined && !boundedString(value.location, 512)) return undefined;
	return {
		terminalId: value.terminalId,
		kind: value.kind,
		...(value.location === undefined ? {} : { location: value.location }),
	};
}

function parseCanonicalTargetUpdate(value: unknown): CanonicalTargetUpdate | undefined {
	if (!isRecord(value) || !timestamp(value.updatedAt) || !boundedString(value.value, 512)) return undefined;
	if (value.kind !== "path" && value.kind !== "branch" && value.kind !== "commit" && value.kind !== "url") return undefined;
	if (value.source !== "user" && value.source !== "agent" && value.source !== "launcher") return undefined;
	return { kind: value.kind, value: value.value, updatedAt: value.updatedAt, source: value.source };
}

function parseWorkspaceLocation(value: unknown): WorkspaceLocation | undefined {
	if (!isRecord(value) || !boundedString(value.value, 512)) return undefined;
	if (value.kind !== "path" && value.kind !== "branch" && value.kind !== "url") return undefined;
	return { kind: value.kind, value: value.value };
}

/**
 * Unknown, absent, and newer peer data are deliberately ignored. This allows
 * older peers to interoperate with additive v1 metadata without imports.
 */
export function parseIntercomMetadata(value: unknown): IntercomMetadata | undefined {
	if (value === undefined || value === null) return undefined;
	if (!isRecord(value) || value.schemaVersion !== INTERCOM_CONTRACT_VERSION) return undefined;
	if (!boundedString(value.workstreamId, 256) || !boundedString(value.piSessionId, 256) || !boundedString(value.objective, 1_000)) return undefined;
	if (value.workstreamId === value.piSessionId) return undefined;
	if (!status(value.status)) return undefined;
	const refs = parseRefs(value.refs, false);
	if (!refs) return undefined;
	if (value.intercomConnectionId !== undefined && !boundedString(value.intercomConnectionId, 256)) return undefined;
	let relevance: RelevanceMetadata | undefined;
	if (value.relevance !== undefined) {
		if (!isRecord(value.relevance) || typeof value.relevance.score !== "number" || !Number.isFinite(value.relevance.score) || value.relevance.score < 0 || value.relevance.score > 1 || !boundedString(value.relevance.reason, 240)) return undefined;
		relevance = { score: value.relevance.score, reason: value.relevance.reason };
	}
	let canonicalTargetUpdate: CanonicalTargetUpdate | undefined;
	if (value.canonicalTargetUpdate !== undefined) {
		canonicalTargetUpdate = parseCanonicalTargetUpdate(value.canonicalTargetUpdate);
		if (!canonicalTargetUpdate) return undefined;
	}
	return {
		schemaVersion: INTERCOM_CONTRACT_VERSION,
		workstreamId: value.workstreamId,
		piSessionId: value.piSessionId,
		...(value.intercomConnectionId === undefined ? {} : { intercomConnectionId: value.intercomConnectionId }),
		objective: value.objective,
		status: value.status,
		refs,
		...(relevance === undefined ? {} : { relevance }),
		...(canonicalTargetUpdate === undefined ? {} : { canonicalTargetUpdate }),
	};
}

export function parseFocusSeed(value: unknown): FocusSeed | undefined {
	if (value === undefined || value === null || !isRecord(value) || value.schemaVersion !== FOCUS_SEED_CONTRACT_VERSION) return undefined;
	if (!boundedString(value.objective, 1_000)) return undefined;
	let boundaries: string[] | undefined;
	if (value.boundaries !== undefined) {
		if (!Array.isArray(value.boundaries) || value.boundaries.length > 50 || value.boundaries.some((item) => !boundedString(item, 512))) return undefined;
		boundaries = [...value.boundaries] as string[];
	}
	const refs = parseRefs(value.refs, true);
	if (value.refs !== undefined && !refs) return undefined;
	if (value.host !== undefined && !boundedString(value.host, 256)) return undefined;
	if (value.parentPiSessionId !== undefined && !boundedString(value.parentPiSessionId, 256)) return undefined;
	return {
		schemaVersion: FOCUS_SEED_CONTRACT_VERSION,
		objective: value.objective,
		...(boundaries === undefined ? {} : { boundaries }),
		...(refs === undefined ? {} : { refs }),
		...(value.host === undefined ? {} : { host: value.host }),
		...(value.parentPiSessionId === undefined ? {} : { parentPiSessionId: value.parentPiSessionId }),
	};
}

export function parseWorktreeHandoff(value: unknown): WorktreeHandoff | undefined {
	if (value === undefined || value === null || !isRecord(value) || value.schemaVersion !== WORKTREE_LAUNCHER_CONTRACT_VERSION) return undefined;
	if (!boundedString(value.handoffId, 256) || !boundedString(value.workstreamId, 256) || !boundedString(value.parentPiSessionId, 256) || !boundedString(value.objective, 1_000) || !status(value.status) || !timestamp(value.expiresAt)) return undefined;
	if (value.workstreamId === value.parentPiSessionId) return undefined;
	const refs = parseRefs(value.refs, true);
	if (value.refs !== undefined && !refs) return undefined;
	const requestedLocation = value.requestedLocation === undefined ? undefined : parseWorkspaceLocation(value.requestedLocation);
	if (value.requestedLocation !== undefined && !requestedLocation) return undefined;
	return {
		schemaVersion: WORKTREE_LAUNCHER_CONTRACT_VERSION,
		handoffId: value.handoffId,
		workstreamId: value.workstreamId,
		parentPiSessionId: value.parentPiSessionId,
		objective: value.objective,
		status: value.status,
		...(refs === undefined ? {} : { refs }),
		...(requestedLocation === undefined ? {} : { requestedLocation }),
		expiresAt: value.expiresAt,
	};
}

export function parseTerminalLocationAcknowledgement(value: unknown): TerminalLocationAcknowledgement | undefined {
	if (value === undefined || value === null || !isRecord(value) || value.schemaVersion !== TERMINAL_ACK_CONTRACT_VERSION) return undefined;
	if (!boundedString(value.handoffId, 256) || !boundedString(value.workstreamId, 256) || !boundedString(value.piSessionId, 256) || !timestamp(value.acknowledgedAt)) return undefined;
	if (value.workstreamId === value.piSessionId) return undefined;
	const terminal = parseTerminal(value.terminal);
	if (!terminal) return undefined;
	const workspace = value.workspace === undefined ? undefined : parseWorkspaceLocation(value.workspace);
	if (value.workspace !== undefined && !workspace) return undefined;
	return {
		schemaVersion: TERMINAL_ACK_CONTRACT_VERSION,
		handoffId: value.handoffId,
		workstreamId: value.workstreamId,
		piSessionId: value.piSessionId,
		terminal,
		...(workspace === undefined ? {} : { workspace }),
		acknowledgedAt: value.acknowledgedAt,
	};
}

export function isHandoffExpired(handoff: WorktreeHandoff, now = new Date()): boolean {
	return Date.parse(handoff.expiresAt) <= now.getTime();
}

export function isSupportedPeerSchema(value: unknown, version: number): boolean {
	return isRecord(value) && value.schemaVersion === version;
}

export { WORKSTREAM_SCHEMA_VERSION };
