/** Consume a host focus declaration into transcript-authoritative workstream state. */

import { parseFocusSeed, type FocusSeed } from "./peer-contracts.js";
import { asPiSessionId } from "./workstream-schema.js";
import {
	appendWorkstreamSnapshot,
	createWorkstreamSnapshot,
	type AppendEntryApi,
} from "./workstream-state.js";

export interface ConsumeFocusSeedOptions {
	readonly seed: unknown;
	readonly workstreamId: string;
	readonly piSessionId: string;
	readonly now: Date;
	readonly appendEntry: AppendEntryApi["appendEntry"];
	readonly idFactory?: () => string;
}

export interface ConsumedFocusSeed {
	readonly seed: FocusSeed;
	readonly snapshot: ReturnType<typeof createWorkstreamSnapshot>;
}

/** Parse and append a host declaration as an unpinned active workstream. */
export function consumeFocusSeed(options: ConsumeFocusSeedOptions): ConsumedFocusSeed | undefined {
	const seed = parseFocusSeed(options.seed);
	if (!seed) return undefined;
	let snapshot: ReturnType<typeof createWorkstreamSnapshot>;
	try {
		snapshot = createWorkstreamSnapshot({
			workstreamId: options.workstreamId,
			piSessionId: options.piSessionId,
			objective: seed.objective,
			objectivePinned: false,
			refs: seed.refs,
			boundaries: seed.boundaries,
			now: options.now,
			provenance: {
				source: "host",
				...(seed.host === undefined ? {} : { host: seed.host }),
				...(seed.parentPiSessionId === undefined ? {} : { parentPiSessionId: asPiSessionId(seed.parentPiSessionId) }),
			},
			idFactory: options.idFactory,
		});
	} catch {
		return undefined;
	}
	appendWorkstreamSnapshot({ appendEntry: options.appendEntry }, snapshot);
	return { seed, snapshot };
}
