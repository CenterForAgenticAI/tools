/** REQ-C2 control: context_edit entries are selected from the current branch
 * path, not the whole session tree; forks copy only that selected branch.
 * Mutation: replay all tree context edits instead of the selected path.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { foldStateFromBranch, planFold } from "../src/folds/fold-adapter.js";
import { fold, OPENING_SUMMARY, requestText, SAFETY_CONFIG, safetyRoot, safetySession, seedOpening, user } from "./fixtures/safety/session.js";

test("REQ-C2: tree navigation and fork cannot leak another branch's fold into a provider request", async () => {
	const root = safetyRoot();
	const manager = SessionManager.create(root, path.join(root, "sessions"));
	const ids = seedOpening(manager);
	const sourceFile = manager.getSessionFile();
	assert.ok(sourceFile);
	const sharedLeaf = manager.getLeafId();
	assert.ok(sharedLeaf);
	user(manager, "SAFETY-BRANCH-A-ONLY");
	fold(manager);
	const foldedLeaf = manager.getLeafId();
	assert.ok(foldedLeaf);
	let live: Awaited<ReturnType<typeof safetySession>> | undefined;
	try {
		live = await safetySession(root, manager);
		await live.prompt("SAFETY-BRANCH-PROBE");
		assert.ok(requestText(live.requests[0]!).includes(OPENING_SUMMARY));
		assert.doesNotMatch(requestText(live.requests[0]!), /SAFETY-ALPHA-ANSWER|SAFETY-BETA-QUESTION/u);
		live.session.dispose();

		// SessionManager.branch is the SDK path used by /tree navigation.
		manager.branch(sharedLeaf);
		user(manager, "SAFETY-BRANCH-B-ONLY");
		const branchBLeaf = manager.getLeafId();
		assert.ok(branchBLeaf);
		assert.deepEqual(foldStateFromBranch(manager.getBranch()).active, []);
		// The whole file still contains A's folds, but B must not resolve b1.
		const foreign = planFold({ branch: manager.getBranch(), startRef: "b1", endRef: "b1", summary: "Do not import branch A.",
			modelContextLimit: 64_000, config: SAFETY_CONFIG });
		assert.equal(foreign.ok, false, "foreign fold refs must not resolve");
		live = await safetySession(root, manager);
		await live.prompt("SAFETY-BRANCH-PROBE");
		const bRequest = requestText(live.requests[0]!);
		assert.doesNotMatch(bRequest, /SAFETY-OPENING|SAFETY-BRANCH-A-ONLY/u);
		assert.match(bRequest, /SAFETY-ALPHA-ANSWER/u);
		assert.match(bRequest, /SAFETY-BETA-ANSWER/u);
		assert.match(bRequest, /SAFETY-BRANCH-B-ONLY/u);
		live.session.dispose();

		manager.branch(branchBLeaf);
		const extracted = manager.createBranchedSession(branchBLeaf);
		assert.ok(extracted);
		const forked = SessionManager.forkFrom(extracted, root, path.join(root, "forks"));
		assert.notEqual(forked.getSessionId(), manager.getSessionId());
		assert.deepEqual(foldStateFromBranch(forked.getBranch()).active, []);
		live = await safetySession(root, forked);
		await live.prompt("SAFETY-FORK-PROBE");
		assert.doesNotMatch(requestText(live.requests[0]!), /SAFETY-OPENING|SAFETY-BRANCH-A-ONLY/u);
		assert.match(requestText(live.requests[0]!), /SAFETY-ALPHA-ANSWER/u);
		live.session.dispose();

		fold(forked, "m00001", "m00004", "SAFETY-FORK-SUMMARY: only this independent fork folds the opening.");
		const source = SessionManager.open(sourceFile, path.join(root, "sessions"));
		source.branch(branchBLeaf);
		live = await safetySession(root, source);
		await live.prompt("SAFETY-SOURCE-AFTER-FORK-PROBE");
		assert.doesNotMatch(requestText(live.requests[0]!), /SAFETY-FORK-SUMMARY|SAFETY-OPENING/u);
		assert.match(requestText(live.requests[0]!), /SAFETY-ALPHA-ANSWER/u);
		live.session.dispose();

		source.branch(foldedLeaf);
		live = await safetySession(root, source);
		await live.prompt("SAFETY-RETURN-TO-A-PROBE");
		assert.ok(requestText(live.requests[0]!).includes(OPENING_SUMMARY));
		assert.doesNotMatch(requestText(live.requests[0]!), /SAFETY-BRANCH-B-ONLY|SAFETY-FORK-SUMMARY/u);
		assert.equal(source.getEntry(ids[0]!)?.type, "message", "folding must not move originals between branches");
	} finally { live?.session.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});
