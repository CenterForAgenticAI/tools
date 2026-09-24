/** Bounded, non-authoritative session rendering and safe jump delegation. */

import {
	parseRegistryProjection,
	type RegistryProjection,
} from "./workstream-schema.js";
import {
	findOverlaps,
	type OverlapResult,
} from "./workstream-overlap.js";
import {
	redactText,
	sanitizeRegistryProjection,
	type RedactionOptions,
} from "./workstream-safety.js";
import type { WorkspaceLocation } from "./peer-contracts.js";

export interface SessionViewOptions {
	readonly sessions: readonly RegistryProjection[];
	readonly currentSessionId?: string;
	readonly now?: number;
	readonly redaction?: RedactionOptions;
	readonly locationFor?: (session: RegistryProjection) => WorkspaceLocation | undefined;
	readonly overlapFor?: (session: RegistryProjection, sessions: readonly RegistryProjection[]) => OverlapResult;
}

export interface JumpTarget {
	readonly piSessionId: string;
	readonly workstreamId: string;
	readonly state: RegistryProjection["state"];
	readonly terminal?: RegistryProjection["terminal"];
	readonly refs: RegistryProjection["refs"];
}

export interface SessionJumpOptions {
	readonly isAlive: (target: JumpTarget) => boolean;
	readonly launcher?: { readonly jump: (target: JumpTarget) => boolean };
	/** Deliberately metadata-only: this module never constructs or executes terminal commands. */
	readonly terminal?: { readonly execute: (command: never) => void };
	readonly location?: WorkspaceLocation;
	readonly home?: string;
	readonly cwd?: string;
}

export interface SessionJumpResult {
	readonly jumped: boolean;
	readonly reason?: "target is not live" | "launcher unavailable" | "launcher rejected" | "target metadata invalid";
	readonly fallback?: WorkspaceLocation;
}

function validSessions(sessions: readonly RegistryProjection[]): RegistryProjection[] {
	return sessions
		.map((session) => parseRegistryProjection(session))
		.filter((session): session is RegistryProjection => session !== null);
}

function safeLocation(location: WorkspaceLocation | undefined, options: Pick<SessionJumpOptions, "home" | "cwd">): WorkspaceLocation | undefined {
	if (!location) return undefined;
	let controlCharacter = -1;
	for (let index = 0; index < location.value.length; index += 1) {
		const code = location.value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) {
			controlCharacter = index;
			break;
		}
	}
	const value = controlCharacter < 0 ? location.value : location.value.slice(0, controlCharacter);
	return {
		...location,
		value: redactText(value, {
			home: options.home,
			cwd: options.cwd,
			maxLength: location.kind === "path" ? 240 : 512,
		}),
	};
}

function fallbackFor(target: RegistryProjection, options: Pick<SessionJumpOptions, "location" | "home" | "cwd">): WorkspaceLocation | undefined {
	if (options.location) return safeLocation(options.location, options);
	const pathRef = target.refs.find((ref) => ref.kind === "path");
	return pathRef ? safeLocation({ kind: "path", value: pathRef.value }, options) : undefined;
}

/** Render only validated, bounded registry projections; registry data remains a projection. */
export function renderSessionsView(options: SessionViewOptions): string {
	const sessions = validSessions(options.sessions);
	const overlapFor = options.overlapFor ?? ((session, all) => findOverlaps(session, all));
	const lines = sessions.map((original) => {
		const session = sanitizeRegistryProjection(original, options.redaction);
		const overlap = overlapFor(original, sessions);
		const location = options.locationFor?.(original);
		const stale = session.state === "stale";
		const terminalLocation = original.terminal?.location === undefined ? undefined : safeLocation(
			{ kind: "path", value: original.terminal.location },
			options.redaction ?? {},
		);
		const terminal = terminalLocation === undefined ? "" : ` terminal=${session.terminal?.kind}:${terminalLocation.value}`;
		const workspace = location === undefined ? "" : ` location=${safeLocation(location, options.redaction ?? {})?.value ?? ""}`;
		return [
			`${session.piSessionId} workstream=${session.workstreamId}`,
			`objective=${session.objective}`,
			`status=${session.status} lifecycle=${stale ? "stale" : session.state}`,
			`refs=${session.refs.map((ref) => `${ref.kind}:${ref.value}`).join(",") || "none"}`,
			`last-activity=${session.heartbeatAt}`,
			`overlap=${overlap.classification} (${overlap.action})`,
			`${terminal}${workspace}`,
		].join(" ").trim();
	});
	return lines.join("\n");
}

/** Revalidate liveness immediately before delegating a jump; stale metadata cannot authorize one. */
export function requestSessionJump(target: RegistryProjection, options: SessionJumpOptions): SessionJumpResult {
	const parsed = parseRegistryProjection(target);
	if (!parsed) return { jumped: false, reason: "target metadata invalid" };
	const safeFallback = fallbackFor(parsed, options);
	if (parsed.state === "closed") return { jumped: false, reason: "target is not live", ...(safeFallback === undefined ? {} : { fallback: safeFallback }) };
	const alive = (() => {
		try { return parsed.state !== "stale" && options.isAlive(parsed); } catch { return false; }
	})();
	if (!alive) return { jumped: false, reason: "target is not live", ...(safeFallback === undefined ? {} : { fallback: safeFallback }) };
	if (!options.launcher) return { jumped: false, reason: "launcher unavailable", ...(safeFallback === undefined ? {} : { fallback: safeFallback }) };
	try {
		if (!options.launcher.jump(parsed)) return { jumped: false, reason: "launcher rejected", ...(safeFallback === undefined ? {} : { fallback: safeFallback }) };
		return { jumped: true };
	} catch {
		return { jumped: false, reason: "launcher rejected", ...(safeFallback === undefined ? {} : { fallback: safeFallback }) };
	}
}
