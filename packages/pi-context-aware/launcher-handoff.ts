/** Versioned launcher handoff creation, validation, and child acknowledgement; parent self-consumption is rejected before append or acknowledgement. */

import {
	isHandoffExpired,
	parseTerminalLocationAcknowledgement,
	parseWorktreeHandoff,
	TERMINAL_ACK_CONTRACT_VERSION,
	WORKTREE_LAUNCHER_CONTRACT_VERSION,
	type TerminalLocationAcknowledgement,
	type WorktreeHandoff,
	type WorkspaceLocation,
} from "./peer-contracts.js";
import { asPiSessionId, asTerminalId, type TerminalIdentity } from "./workstream-schema.js";
import {
	appendWorkstreamSnapshot,
	createWorkstreamSnapshot,
	type AppendEntryApi,
} from "./workstream-state.js";

export interface LauncherHandoffInput extends Omit<WorktreeHandoff, "schemaVersion"> {
	readonly requestedLocation?: WorkspaceLocation;
}

export interface LauncherChildLocation {
	readonly piSessionId: string;
	readonly terminal: {
		readonly terminalId: string;
		readonly kind: "cmux" | "tmux" | "other";
		readonly location?: string;
	};
	readonly workspace?: WorkspaceLocation;
}

export interface ConsumeLauncherHandoffOptions {
	readonly handoff: unknown;
	readonly now: Date;
	readonly child: LauncherChildLocation;
	readonly appendEntry: AppendEntryApi["appendEntry"];
	readonly acknowledge: (acknowledgement: TerminalLocationAcknowledgement) => void;
	readonly idFactory?: () => string;
}

export interface ConsumedLauncherHandoff {
	readonly snapshot: ReturnType<typeof createWorkstreamSnapshot>;
	readonly acknowledgement: TerminalLocationAcknowledgement;
	readonly acknowledged: boolean;
}

// A transcript append callback identifies one authoritative Pi session stream. Keep the
// already-appended snapshot beside that sink so an acknowledgement retry can publish only
// the missing acknowledgement rather than duplicate authoritative state.
const consumedHandoffs = new WeakMap<AppendEntryApi["appendEntry"], Map<string, ConsumedLauncherHandoff>>();

function handoffKey(handoff: WorktreeHandoff, child: LauncherChildLocation): string {
	return JSON.stringify([handoff.handoffId, handoff.workstreamId, child.piSessionId, child.terminal.terminalId]);
}

function retryAcknowledgement(
	consumed: ConsumedLauncherHandoff,
	acknowledge: (acknowledgement: TerminalLocationAcknowledgement) => void,
): ConsumedLauncherHandoff {
	let acknowledged = true;
	try { acknowledge(consumed.acknowledgement); } catch { acknowledged = false; }
	return { ...consumed, acknowledged };
}

/** Create additive metadata for the optional worktree-launcher peer. */
export function createLauncherHandoff(input: LauncherHandoffInput): WorktreeHandoff {
	const parsed = parseWorktreeHandoff({ schemaVersion: WORKTREE_LAUNCHER_CONTRACT_VERSION, ...input });
	if (!parsed) throw new Error("launcher handoff does not satisfy the schema");
	return parsed;
}

/** Parse only a supported, non-expired handoff. Unknown or malformed peers are ignored. */
export function parseLauncherHandoff(value: unknown, now: Date): WorktreeHandoff | undefined {
	const parsed = parseWorktreeHandoff(value);
	return parsed && !isHandoffExpired(parsed, now) ? parsed : undefined;
}

/** Consume valid child metadata by appending a transcript-authoritative snapshot first. */
export function consumeLauncherHandoff(options: ConsumeLauncherHandoffOptions): ConsumedLauncherHandoff | undefined {
	const handoff = parseLauncherHandoff(options.handoff, options.now);
	if (!handoff || options.child.piSessionId === handoff.parentPiSessionId) return undefined;
	if (options.child.terminal.terminalId === handoff.workstreamId || options.child.terminal.terminalId === options.child.piSessionId) return undefined;
	const key = handoffKey(handoff, options.child);
	const streamHandoffs = consumedHandoffs.get(options.appendEntry);
	const existing = streamHandoffs?.get(key);
	if (existing) return retryAcknowledgement(existing, options.acknowledge);
	let terminal: TerminalIdentity;
	try {
		terminal = {
			terminalId: asTerminalId(options.child.terminal.terminalId),
			kind: options.child.terminal.kind,
			...(options.child.terminal.location === undefined ? {} : { location: options.child.terminal.location }),
		};
	} catch {
		return undefined;
	}
	const acknowledgementValue = {
		schemaVersion: TERMINAL_ACK_CONTRACT_VERSION,
		handoffId: handoff.handoffId,
		workstreamId: handoff.workstreamId,
		piSessionId: options.child.piSessionId,
		terminal: {
			terminalId: options.child.terminal.terminalId,
			kind: options.child.terminal.kind,
			...(options.child.terminal.location === undefined ? {} : { location: options.child.terminal.location }),
		},
		...(options.child.workspace === undefined ? {} : { workspace: options.child.workspace }),
		acknowledgedAt: options.now.toISOString(),
	};
	const acknowledgement = parseTerminalLocationAcknowledgement(acknowledgementValue);
	if (!acknowledgement) return undefined;
	let snapshot: ReturnType<typeof createWorkstreamSnapshot>;
	try {
		snapshot = createWorkstreamSnapshot({
			workstreamId: handoff.workstreamId,
			piSessionId: options.child.piSessionId,
			terminal,
			objective: handoff.objective,
			status: handoff.status,
			refs: handoff.refs,
			now: options.now,
			provenance: {
				source: "launcher",
				parentPiSessionId: asPiSessionId(handoff.parentPiSessionId),
				handoffId: handoff.handoffId,
			},
			idFactory: options.idFactory,
		});
	} catch {
		return undefined;
	}
	appendWorkstreamSnapshot({ appendEntry: options.appendEntry }, snapshot);
	const consumed: ConsumedLauncherHandoff = { snapshot, acknowledgement, acknowledged: true };
	const acknowledged = retryAcknowledgement(consumed, options.acknowledge);
	(streamHandoffs ?? new Map<string, ConsumedLauncherHandoff>()).set(key, acknowledged);
	if (!streamHandoffs) consumedHandoffs.set(options.appendEntry, new Map([[key, acknowledged]]));
	return acknowledged;
}
