/** Durable workstream contracts. These values are transcript-facing data contracts, not Pi internals. */

export const WORKSTREAM_SCHEMA_VERSION = 1 as const;
/** The pinned block's named cap leaves the 4,000-character focus projection and 64-character compaction-history caps within 8,000. */
export const MAX_PINNED_VERBATIM_BLOCK_CHARS = 3_936 as const;
export const ACTIVITY_SCHEMA_VERSION = 1 as const;
export const REGISTRY_SCHEMA_VERSION = 1 as const;
export const PI_CODING_AGENT_API_BASELINE = "^0.80.6" as const;
export const PI_AI_API_BASELINE = "^0.80.6" as const;
export const PI_CODING_AGENT_PUBLIC_SEAMS = ["ExtensionAPI", "ExtensionContext", "SessionManager", "appendEntry", "modelRegistry"] as const;
export const PI_AI_PUBLIC_SEAMS = ["complete", "stream", "completeSimple", "streamSimple"] as const;

// Branded JSON-compatible strings make the four lifecycle identities distinct
// to TypeScript callers while retaining ordinary string serialization.
export type WorkstreamId = string & { readonly __workstreamId: unique symbol };
export type PiSessionId = string & { readonly __piSessionId: unique symbol };
export type IntercomConnectionId = string & { readonly __intercomConnectionId: unique symbol };
export type TerminalId = string & { readonly __terminalId: unique symbol };

export type WorkstreamStatus = "active" | "paused" | "completed" | "detached";
export type ActivityKind = "progress" | "decision" | "blocker" | "handoff" | "diagnostic-gap";
export type RegistryState = "active" | "closed" | "stale";
export type CapabilityName = "luna-activity" | "cmux" | "tmux" | "intercom" | "worktree-launcher";

export interface TerminalIdentity {
	readonly terminalId: TerminalId;
	readonly kind: "cmux" | "tmux" | "other";
	readonly location?: string;
}

export interface WorkstreamIdentity {
	readonly workstreamId: WorkstreamId;
	readonly piSessionId: PiSessionId;
	readonly intercomConnectionId?: IntercomConnectionId;
	readonly terminal?: TerminalIdentity;
}

export interface WorkstreamGoal {
	readonly id: string;
	readonly text: string;
	readonly status: "pending" | "active" | "blocked" | "done";
}

export interface WorkstreamRef {
	readonly kind: "gitlab-mr" | "github-issue" | "graft-spec" | "branch" | "commit" | "path" | "url" | "other";
	readonly value: string;
}

export interface WorkstreamProvenance {
	readonly source: "transcript" | "launcher" | "user" | "host";
	readonly parentPiSessionId?: PiSessionId;
	readonly inheritedWorkstreamId?: WorkstreamId;
	readonly handoffId?: string;
	/** Names the creating process when source is "host". */
	readonly host?: string;
}

export type WorkstreamMutationActor = "user" | "agent" | "seed" | "tool" | "peer" | "related-session";
export type WorkstreamMutationKind = "objective" | "goal" | "ref" | "boundary" | "status" | "detach" | "pinned-block";

/** Authorization and revision provenance persisted alongside an accepted snapshot. */
export interface WorkstreamMutation {
	readonly kind: WorkstreamMutationKind;
	readonly actor: WorkstreamMutationActor;
	readonly reason: string;
	readonly timestamp: string;
	readonly priorRevision: number;
	readonly newRevision: number;
	readonly accepted: boolean;
	readonly workstreamId: WorkstreamId;
	readonly previousWorkstreamId?: WorkstreamId;
	readonly newWorkstreamId?: WorkstreamId;
	readonly proposedObjective?: string;
}

export interface WorkstreamSnapshot extends WorkstreamIdentity {
	readonly schemaVersion: typeof WORKSTREAM_SCHEMA_VERSION;
	readonly eventId: string;
	readonly revision: number;
	readonly objective: string;
	readonly objectivePinned: boolean;
	readonly status: WorkstreamStatus;
	readonly goals: readonly WorkstreamGoal[];
	readonly refs: readonly WorkstreamRef[];
	readonly boundaries: readonly string[];
	/** Redacted once when set; later projections must reproduce this stored text unchanged. */
	readonly pinnedVerbatimBlock?: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly provenance?: WorkstreamProvenance;
}

export interface ActivityEvent extends WorkstreamIdentity {
	readonly schemaVersion: typeof ACTIVITY_SCHEMA_VERSION;
	readonly eventId: string;
	readonly occurredAt: string;
	readonly kind: ActivityKind;
	readonly summary: string;
	readonly relevant: boolean;
	readonly sourceEntryIds: readonly string[];
}

export interface RegistryProjection extends WorkstreamIdentity {
	readonly schemaVersion: typeof REGISTRY_SCHEMA_VERSION;
	readonly projectKey: string;
	readonly incarnation: string;
	readonly pid: number;
	readonly pidStart: string;
	readonly sequence: number;
	readonly state: RegistryState;
	readonly objective: string;
	readonly status: WorkstreamStatus;
	readonly refs: readonly WorkstreamRef[];
	readonly heartbeatAt: string;
	readonly updatedAt: string;
	readonly expiresAt?: string;
}

export interface CapabilityGate {
	readonly capability: CapabilityName;
	readonly enabled: boolean;
	readonly available: boolean;
	readonly reason?: string;
}

export interface PlatformContract {
	readonly codingAgent: typeof PI_CODING_AGENT_API_BASELINE;
	readonly piAi: typeof PI_AI_API_BASELINE;
	readonly codingAgentPublicSeams: typeof PI_CODING_AGENT_PUBLIC_SEAMS;
	readonly piAiPublicSeams: typeof PI_AI_PUBLIC_SEAMS;
	readonly incompatibleHostAction: "upgrade";
	readonly optionalCapabilities: readonly CapabilityName[];
}

export const PLATFORM_CONTRACT: PlatformContract = {
	codingAgent: PI_CODING_AGENT_API_BASELINE,
	piAi: PI_AI_API_BASELINE,
	codingAgentPublicSeams: PI_CODING_AGENT_PUBLIC_SEAMS,
	piAiPublicSeams: PI_AI_PUBLIC_SEAMS,
	incompatibleHostAction: "upgrade",
	optionalCapabilities: ["luna-activity", "cmux", "tmux", "intercom", "worktree-launcher"],
};

export function asWorkstreamId(value: string): WorkstreamId {
	return value as WorkstreamId;
}

export function asPiSessionId(value: string): PiSessionId {
	return value as PiSessionId;
}

export function asIntercomConnectionId(value: string): IntercomConnectionId {
	return value as IntercomConnectionId;
}

export function asTerminalId(value: string): TerminalId {
	return value as TerminalId;
}

export function isCapabilityName(value: unknown): value is CapabilityName {
	return PLATFORM_CONTRACT.optionalCapabilities.includes(value as CapabilityName);
}

export function parseCapabilityGate(value: unknown): CapabilityGate | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const candidate = value as Record<string, unknown>;
	if (!isCapabilityName(candidate.capability) || typeof candidate.enabled !== "boolean" || typeof candidate.available !== "boolean") return null;
	if (candidate.reason !== undefined && (typeof candidate.reason !== "string" || candidate.reason.trim().length === 0 || candidate.reason.length > 240)) return null;
	return {
		capability: candidate.capability,
		enabled: candidate.enabled,
		available: candidate.available,
		...(candidate.reason === undefined ? {} : { reason: candidate.reason }),
	};
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, maxLength = 512): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function isoTimestamp(value: unknown): value is string {
	return nonEmptyString(value, 64) && Number.isFinite(Date.parse(value));
}

function positiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

const REF_KINDS: readonly WorkstreamRef["kind"][] = [
	"gitlab-mr", "github-issue", "graft-spec", "branch", "commit", "path", "url", "other",
];
const ACTIVITY_KINDS: readonly ActivityKind[] = ["progress", "decision", "blocker", "handoff", "diagnostic-gap"];
const WORKSTREAM_STATUSES: readonly WorkstreamStatus[] = ["active", "paused", "completed", "detached"];
const GOAL_STATUSES: readonly WorkstreamGoal["status"][] = ["pending", "active", "blocked", "done"];
const MUTATION_KINDS: readonly WorkstreamMutationKind[] = ["objective", "goal", "ref", "boundary", "status", "detach", "pinned-block"];
const MUTATION_ACTORS: readonly WorkstreamMutationActor[] = ["user", "agent", "seed", "tool", "peer", "related-session"];

function parseIdentity(value: RecordValue): WorkstreamIdentity | null {
	if (!nonEmptyString(value.workstreamId, 256) || !nonEmptyString(value.piSessionId, 256)) return null;
	if (value.workstreamId === value.piSessionId) return null;
	if (value.intercomConnectionId !== undefined && !nonEmptyString(value.intercomConnectionId, 256)) return null;
	if (value.intercomConnectionId === value.workstreamId || value.intercomConnectionId === value.piSessionId) return null;
	let terminal: TerminalIdentity | undefined;
	if (value.terminal !== undefined) {
		if (!isRecord(value.terminal) || !nonEmptyString(value.terminal.terminalId, 256)) return null;
		if (value.terminal.kind !== "cmux" && value.terminal.kind !== "tmux" && value.terminal.kind !== "other") return null;
		if (value.terminal.location !== undefined && !nonEmptyString(value.terminal.location, 512)) return null;
		if (value.terminal.terminalId === value.workstreamId || value.terminal.terminalId === value.piSessionId || value.terminal.terminalId === value.intercomConnectionId) return null;
		terminal = {
			terminalId: asTerminalId(value.terminal.terminalId),
			kind: value.terminal.kind,
			...(value.terminal.location === undefined ? {} : { location: value.terminal.location }),
		};
	}
	return {
		workstreamId: asWorkstreamId(value.workstreamId),
		piSessionId: asPiSessionId(value.piSessionId),
		...(value.intercomConnectionId === undefined ? {} : { intercomConnectionId: asIntercomConnectionId(value.intercomConnectionId) }),
		...(terminal === undefined ? {} : { terminal }),
	};
}

function parseGoals(value: unknown): WorkstreamGoal[] | null {
	if (!Array.isArray(value) || value.length > 50) return null;
	const goals: WorkstreamGoal[] = [];
	for (const candidate of value) {
		if (!isRecord(candidate) || !nonEmptyString(candidate.id, 128) || !nonEmptyString(candidate.text, 512)) return null;
		if (!GOAL_STATUSES.includes(candidate.status as WorkstreamGoal["status"])) return null;
		goals.push({ id: candidate.id, text: candidate.text, status: candidate.status as WorkstreamGoal["status"] });
	}
	return goals;
}

function parseRefs(value: unknown): WorkstreamRef[] | null {
	if (!Array.isArray(value) || value.length > 100) return null;
	const refs: WorkstreamRef[] = [];
	for (const candidate of value) {
		if (!isRecord(candidate) || !REF_KINDS.includes(candidate.kind as WorkstreamRef["kind"]) || !nonEmptyString(candidate.value, 512)) return null;
		refs.push({ kind: candidate.kind as WorkstreamRef["kind"], value: candidate.value });
	}
	return refs;
}

function parseProvenance(value: unknown): WorkstreamProvenance | undefined | null {
	if (value === undefined) return undefined;
	if (!isRecord(value) || (value.source !== "transcript" && value.source !== "launcher" && value.source !== "user" && value.source !== "host")) return null;
	if (value.parentPiSessionId !== undefined && !nonEmptyString(value.parentPiSessionId, 256)) return null;
	if (value.inheritedWorkstreamId !== undefined && !nonEmptyString(value.inheritedWorkstreamId, 256)) return null;
	if (value.handoffId !== undefined && !nonEmptyString(value.handoffId, 256)) return null;
	if (value.host !== undefined && !nonEmptyString(value.host, 256)) return null;
	return {
		source: value.source,
		...(value.parentPiSessionId === undefined ? {} : { parentPiSessionId: asPiSessionId(value.parentPiSessionId) }),
		...(value.inheritedWorkstreamId === undefined ? {} : { inheritedWorkstreamId: asWorkstreamId(value.inheritedWorkstreamId) }),
		...(value.handoffId === undefined ? {} : { handoffId: value.handoffId }),
		...(value.host === undefined ? {} : { host: value.host }),
	};
}

export function parseWorkstreamMutation(value: unknown): WorkstreamMutation | null {
	if (!isRecord(value)) return null;
	if (!MUTATION_KINDS.includes(value.kind as WorkstreamMutationKind) || !MUTATION_ACTORS.includes(value.actor as WorkstreamMutationActor)) return null;
	if (!nonEmptyString(value.reason, 240) || !isoTimestamp(value.timestamp)) return null;
	if (typeof value.priorRevision !== "number" || !Number.isSafeInteger(value.priorRevision) || value.priorRevision < 0) return null;
	if (typeof value.newRevision !== "number" || !Number.isSafeInteger(value.newRevision) || value.newRevision <= 0) return null;
	if (typeof value.accepted !== "boolean" || !nonEmptyString(value.workstreamId, 256)) return null;
	if (value.previousWorkstreamId !== undefined && !nonEmptyString(value.previousWorkstreamId, 256)) return null;
	if (value.newWorkstreamId !== undefined && !nonEmptyString(value.newWorkstreamId, 256)) return null;
	if (value.proposedObjective !== undefined && !nonEmptyString(value.proposedObjective, 1_000)) return null;
	return {
		kind: value.kind as WorkstreamMutationKind,
		actor: value.actor as WorkstreamMutationActor,
		reason: value.reason,
		timestamp: value.timestamp,
		priorRevision: value.priorRevision,
		newRevision: value.newRevision,
		accepted: value.accepted,
		workstreamId: asWorkstreamId(value.workstreamId),
		...(value.previousWorkstreamId === undefined ? {} : { previousWorkstreamId: asWorkstreamId(value.previousWorkstreamId) }),
		...(value.newWorkstreamId === undefined ? {} : { newWorkstreamId: asWorkstreamId(value.newWorkstreamId) }),
		...(value.proposedObjective === undefined ? {} : { proposedObjective: value.proposedObjective }),
	};
}

/** Parse a complete transcript-authoritative snapshot; unsupported data returns null. */
export function parseWorkstreamSnapshot(value: unknown): WorkstreamSnapshot | null {
	if (!isRecord(value) || value.schemaVersion !== WORKSTREAM_SCHEMA_VERSION) return null;
	const identity = parseIdentity(value);
	const goals = parseGoals(value.goals);
	const refs = parseRefs(value.refs);
	const provenance = parseProvenance(value.provenance);
	if (!identity || !goals || !refs || provenance === null) return null;
	if (!nonEmptyString(value.eventId, 256) || !positiveInteger(value.revision) || !nonEmptyString(value.objective, 1_000)) return null;
	if (typeof value.objectivePinned !== "boolean" || !WORKSTREAM_STATUSES.includes(value.status as WorkstreamStatus)) return null;
	if (!Array.isArray(value.boundaries) || value.boundaries.length > 50 || value.boundaries.some((item) => !nonEmptyString(item, 512))) return null;
	if (value.pinnedVerbatimBlock !== undefined && (typeof value.pinnedVerbatimBlock !== "string" || value.pinnedVerbatimBlock.length > MAX_PINNED_VERBATIM_BLOCK_CHARS)) return null;
	if (!isoTimestamp(value.createdAt) || !isoTimestamp(value.updatedAt)) return null;
	if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) return null;
	return {
		...identity,
		schemaVersion: WORKSTREAM_SCHEMA_VERSION,
		eventId: value.eventId,
		revision: value.revision,
		objective: value.objective,
		objectivePinned: value.objectivePinned,
		status: value.status as WorkstreamStatus,
		goals,
		refs,
		boundaries: [...value.boundaries] as string[],
		...(value.pinnedVerbatimBlock === undefined ? {} : { pinnedVerbatimBlock: value.pinnedVerbatimBlock }),
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
		...(provenance === undefined ? {} : { provenance }),
	};
}

export function isWorkstreamSnapshot(value: unknown): value is WorkstreamSnapshot {
	return parseWorkstreamSnapshot(value) !== null;
}

/** Parse an activity event independently from the workstream snapshot schema. */
export function parseActivityEvent(value: unknown): ActivityEvent | null {
	if (!isRecord(value) || value.schemaVersion !== ACTIVITY_SCHEMA_VERSION) return null;
	const identity = parseIdentity(value);
	if (!identity || !nonEmptyString(value.eventId, 256) || !isoTimestamp(value.occurredAt)) return null;
	if (!ACTIVITY_KINDS.includes(value.kind as ActivityKind) || !nonEmptyString(value.summary, 160)) return null;
	if (typeof value.relevant !== "boolean" || !Array.isArray(value.sourceEntryIds) || value.sourceEntryIds.length > 20) return null;
	if (value.sourceEntryIds.some((entryId) => !nonEmptyString(entryId, 256))) return null;
	return {
		...identity,
		schemaVersion: ACTIVITY_SCHEMA_VERSION,
		eventId: value.eventId,
		occurredAt: value.occurredAt,
		kind: value.kind as ActivityKind,
		summary: value.summary,
		relevant: value.relevant,
		sourceEntryIds: [...value.sourceEntryIds] as string[],
	};
}

export function isActivityEvent(value: unknown): value is ActivityEvent {
	return parseActivityEvent(value) !== null;
}

/** Parse a bounded local registry projection; projections never become authority. */
export function parseRegistryProjection(value: unknown): RegistryProjection | null {
	if (!isRecord(value) || value.schemaVersion !== REGISTRY_SCHEMA_VERSION) return null;
	const identity = parseIdentity(value);
	const refs = parseRefs(value.refs);
	if (!identity || !refs || !nonEmptyString(value.projectKey, 512) || !nonEmptyString(value.incarnation, 256)) return null;
	const pid = typeof value.pid === "number" ? value.pid : undefined;
	if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return null;
	if (!isoTimestamp(value.pidStart)) return null;
	if (!positiveInteger(value.sequence) || !WORKSTREAM_STATUSES.includes(value.status as WorkstreamStatus)) return null;
	if (!nonEmptyString(value.objective, 1_000) || !isoTimestamp(value.heartbeatAt) || !isoTimestamp(value.updatedAt)) return null;
	if (value.expiresAt !== undefined && !isoTimestamp(value.expiresAt)) return null;
	if (value.state !== "active" && value.state !== "closed" && value.state !== "stale") return null;
	return {
		...identity,
		schemaVersion: REGISTRY_SCHEMA_VERSION,
		projectKey: value.projectKey,
		incarnation: value.incarnation,
		pid,
		pidStart: value.pidStart,
		sequence: value.sequence,
		state: value.state,
		objective: value.objective,
		status: value.status as WorkstreamStatus,
		refs,
		heartbeatAt: value.heartbeatAt,
		updatedAt: value.updatedAt,
		...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }),
	};
}

export function isRegistryProjection(value: unknown): value is RegistryProjection {
	return parseRegistryProjection(value) !== null;
}
