import test from "node:test";
import assert from "node:assert/strict";
import { rejectReasons } from "../src/parity/outcome.js";

// Real planner and kernel messages, one per pattern alternative. A reworded message falls to "other" and fails here.
const SAMPLES: readonly (readonly [string, string])[] = [
	["summary-empty", "Summary is empty — provide a meaningful summary of the compressed range."],
	["summary-short", "Summary too short (10 chars, min 20). The summary must capture the compressed range's key information."],
	["summary-long", "Summary too long (900 chars, max 800). Strip noise."],
	["unknown-ref", 'startId="m99999" does not exist in this session (typo or wrong session) — run acp_status for current refs.'],
	["unknown-ref", "None of the 1 requested range(s) resolved — every ref is unknown to this session."],
	["unknown-ref", 'Invalid boundary ref(s): startId="x", endId="y". Use mNNNNN or bN.'],
	["dangling-ref", "Requested range(s) cannot be anchored (e.g. m00001..m00002) — the refs exist."],
	["consumed", "Requested range(s) already compressed (e.g. m00001..m00002) — nothing new."],
	["consumed", 'startId="m00001" not found in visible context (likely consumed by an existing block).'],
	["consumed", "Range m00001..m00002 contains no new compressible messages — every message in it is covered."],
	["consumed", "Range contains no compressible messages — all are already covered by active blocks or protected."],
	["consumed", 'startId="m1" is a hidden orphan compress call (no matching block) — snapped to next instead.'],
	["consumed", 'startId="b1" is an active block but none of its content is visible in the current context.'],
	["protected-zone", "Range is entirely within the protected zone (the last 4 messages)."],
	["split", "Block range would split an entry or tool pair; include the adjacent entries explicitly."],
	["too-small", "Total compressible content too small (1530 chars across 1 range(s), min 5000)."],
	["no-fold", "The engine created no fold for this range."],
	["no-fold", "The fold covers no session entry."],
	["header-missing", "Session header is unavailable."],
	["stub-summary", "[stub-summary] the summary is cut off"],
];

for (const [reason, message] of SAMPLES) {
	test(`rejectReasons: ${reason} from the real text "${message.slice(0, 40)}"`, () => {
		assert.deepEqual(rejectReasons([message]), [reason]);
	});
}

test("rejectReasons: text no pattern knows is other", () => {
	assert.deepEqual(rejectReasons(["a reworded planner error"]), ["other"]);
});
