/**
 * Whether anything will deliver a compaction seed once the current run ends.
 *
 * `compact_session` ends the agent run and relies on the host to keep the
 * session alive: after the run settles, context-aware compacts it and sends the
 * next-phase seed, which starts a new run. A Fabric child does not stay alive
 * for that: its runner reports the child complete when the run ends, so the
 * seed never runs and the work after the handoff is lost without an error.
 * pi-fabric advertises no way to continue a child, so a child refuses the
 * handoff and keeps working.
 *
 * A headless SDK host (no UI, Pi's default `print` mode) is not refused: an
 * embedder that keeps the session open does deliver the seed, and nothing in
 * the extension context tells it apart from one that exits.
 */

export type SeedContinuation =
	| { readonly available: true }
	| { readonly available: false; readonly reason: "fabric-child" };

type Env = Readonly<Record<string, string | undefined>>;

/**
 * True when pi-fabric launched this process as a child agent.
 *
 * Reads only the variables pi-fabric documents as its stable child environment
 * contract: `PI_FABRIC_LINEAGE` (JSON with `worker: true` and `depth`) and
 * `PI_FABRIC_DEPTH` (the root is 0). A value that is set but unreadable still
 * marks a child, so a malformed value keeps the run going rather than ending it.
 */
export function isFabricChild(env: Env = process.env): boolean {
	const lineage = env.PI_FABRIC_LINEAGE;
	if (lineage !== undefined && lineage.trim() !== "") {
		try {
			const parsed: unknown = JSON.parse(lineage);
			if (parsed !== null && typeof parsed === "object") {
				const record = parsed as { worker?: unknown; depth?: unknown };
				// Only an explicit root record defers to the depth variable.
				if (record.worker === false && record.depth === 0) return depthMarksChild(env.PI_FABRIC_DEPTH);
			}
		} catch {
			// Set but unreadable: still a child.
		}
		return true;
	}
	return depthMarksChild(env.PI_FABRIC_DEPTH);
}

function depthMarksChild(raw: string | undefined): boolean {
	if (raw === undefined || raw.trim() === "") return false;
	const depth = Number(raw);
	// The root is 0. Any other value that is set, including garbage, is a child.
	return depth !== 0;
}

export function seedContinuation(env: Env = process.env): SeedContinuation {
	return isFabricChild(env) ? { available: false, reason: "fabric-child" } : { available: true };
}

/** The error compact_session throws when nothing would continue the session. */
export function seedContinuationRefusalMessage(foldInvocation?: string): string {
	const fold = foldInvocation ? ` If context is tight, use ${foldInvocation} to fold finished, older ranges.` : "";
	return `Refused: compact_session is unavailable in a Fabric child session. The child ends as soon as its run ends, so nothing would deliver the next-phase seed and ending the run now would lose the rest of the work. Nothing was compacted. Keep working and finish your result in this run.${fold}`;
}
