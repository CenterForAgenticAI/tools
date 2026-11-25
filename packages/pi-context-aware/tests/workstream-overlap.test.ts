import test from "node:test";
import assert from "node:assert/strict";
import {
	OVERLAP_EXCLUDED_KINDS,
	OVERLAP_MATCH_KINDS,
	classifyOverlaps,
	normalizeOverlapRef,
	type OverlapCandidate,
} from "../src/workstream/workstream-overlap.js";
import { REF_KINDS, REGISTRY_SCHEMA_VERSION, asPiSessionId, asWorkstreamId, type WorkstreamRef } from "../src/snapshot-contracts/schema.js";

const timestamp = "2026-07-20T00:00:00.000Z";

function candidate(overrides: Partial<OverlapCandidate> = {}): OverlapCandidate {
	return {
		schemaVersion: REGISTRY_SCHEMA_VERSION,
		workstreamId: asWorkstreamId("ws-1"),
		piSessionId: asPiSessionId("pi-1"),
		projectKey: "project-key",
		incarnation: "inc-1",
		pid: 41,
		pidStart: timestamp,
		sequence: 1,
		state: "active",
		objective: "Ship the registry",
		status: "active",
		refs: [],
		heartbeatAt: timestamp,
		updatedAt: timestamp,
		...overrides,
	};
}

test("overlap normalization is typed and exact for provider-scoped references", () => {
	assert.equal(normalizeOverlapRef({ kind: "gitlab-mr", value: "https://gitlab.example/group/project/-/merge_requests/42" }), "gitlab-mr:gitlab.example/group/project!42");
	assert.notEqual(
		normalizeOverlapRef({ kind: "gitlab-mr", value: "https://gitlab.example/group/project/-/merge_requests/42" }),
		normalizeOverlapRef({ kind: "gitlab-mr", value: "https://gitlab.other/group/project/-/merge_requests/42" }),
	);
	assert.equal(normalizeOverlapRef({ kind: "github-issue", value: " OWNER/REPO#7 " }), "github-issue:owner/repo#7");
	assert.equal(normalizeOverlapRef({ kind: "graft-spec", value: "0001-Durable-Session-Workstreams.yaml" }), "graft-spec:0001-durable-session-workstreams");
});

test("strong references take precedence over branch and path matches", () => {
	const current = candidate({
		refs: [
			{ kind: "gitlab-mr", value: "https://gitlab.example/group/project/-/merge_requests/42" },
			{ kind: "branch", value: "feature/registry" },
			{ kind: "path", value: "/repo/workstream.ts" },
		],
	});
	const other = candidate({
		workstreamId: asWorkstreamId("ws-2"),
		piSessionId: asPiSessionId("pi-2"),
		refs: [
			{ kind: "gitlab-mr", value: "https://gitlab.example/group/project/-/merge_requests/42" },
			{ kind: "branch", value: "refs/heads/feature/registry" },
			{ kind: "path", value: "/repo/workstream.ts" },
		],
	});
	const result = classifyOverlaps(current, [other]);
	assert.equal(result.classification, "potential-collision");
	assert.equal(result.matches[0]?.kind, "gitlab-mr");
	assert.equal(result.matches.length, 1);
	assert.match(result.action, /review|collision/i);
	const otherProject = { ...other, projectKey: "different-project" };
	assert.equal(classifyOverlaps(current, [otherProject]).classification, "potential-collision");
	const malformed = { ...other, schemaVersion: 99 } as unknown as OverlapCandidate;
	assert.equal(classifyOverlaps(current, [malformed]).classification, "none");
});

test("strong references are global and outrank lower-precedence matches across candidates", () => {
	const current = candidate({
		refs: [
			{ kind: "gitlab-mr", value: "https://gitlab.example/group/project/-/merge_requests/42" },
			{ kind: "branch", value: "feature/registry" },
			{ kind: "path", value: "/repo/workstream.ts" },
		],
	});
	const strong = candidate({
		workstreamId: asWorkstreamId("ws-2"),
		piSessionId: asPiSessionId("pi-2"),
		projectKey: "other-project",
		refs: [{ kind: "gitlab-mr", value: "https://gitlab.example/group/project/-/merge_requests/42" }],
	});
	const branch = candidate({
		workstreamId: asWorkstreamId("ws-3"),
		piSessionId: asPiSessionId("pi-3"),
		refs: [{ kind: "branch", value: "feature/registry" }],
	});
	const pathOnly = candidate({
		workstreamId: asWorkstreamId("ws-4"),
		piSessionId: asPiSessionId("pi-4"),
		projectKey: "another-project",
		refs: [{ kind: "path", value: "/repo/workstream.ts" }],
	});
	const result = classifyOverlaps(current, [branch, pathOnly, strong]);
	assert.equal(result.classification, "potential-collision");
	assert.deepEqual(result.matches.map((match) => match.kind), ["gitlab-mr"]);
	assert.equal(result.matches[0]?.withPiSessionId, "pi-2");
});

test("branch matches are scoped to the same project and path matches are lower severity", () => {
	const current = candidate({ refs: [{ kind: "branch", value: "main" }, { kind: "path", value: "/repo/README.md" }] });
	const branch = candidate({ workstreamId: asWorkstreamId("ws-2"), piSessionId: asPiSessionId("pi-2"), refs: [{ kind: "branch", value: "refs/heads/main" }] });
	const otherProject = candidate({ workstreamId: asWorkstreamId("ws-3"), piSessionId: asPiSessionId("pi-3"), projectKey: "other-project", refs: [{ kind: "branch", value: "main" }] });
	const pathOnly = candidate({ workstreamId: asWorkstreamId("ws-4"), piSessionId: asPiSessionId("pi-4"), refs: [{ kind: "path", value: "/repo/README.md" }] });
	assert.equal(classifyOverlaps(current, [branch]).classification, "workspace-collision");
	assert.equal(classifyOverlaps(current, [otherProject]).classification, "none");
	assert.equal(classifyOverlaps(current, [pathOnly]).classification, "workspace-collision");
	const commonDirectoryBranch = candidate({
		commonDirectory: "/repo/.git",
		refs: [{ kind: "branch", value: "main" }],
	});
	const commonDirectoryOther = candidate({
		commonDirectory: "/repo/.git",
		projectKey: "other-project",
		workstreamId: asWorkstreamId("ws-5"),
		piSessionId: asPiSessionId("pi-5"),
		refs: [{ kind: "branch", value: "main" }],
	});
	assert.equal(classifyOverlaps(commonDirectoryBranch, [commonDirectoryOther]).classification, "workspace-collision");
});

test("same-workstream matches are intentional and stale records are advisory-excluded", () => {
	const current = candidate({ refs: [{ kind: "commit", value: "ABCDEF" }] });
	const chain = candidate({ piSessionId: asPiSessionId("pi-2"), refs: [{ kind: "commit", value: "abcdef" }] });
	const stale = candidate({ workstreamId: asWorkstreamId("ws-2"), piSessionId: asPiSessionId("pi-2"), state: "stale", refs: [{ kind: "commit", value: "abcdef" }] });
	assert.equal(classifyOverlaps(current, [chain]).classification, "intentional-chain");
	assert.equal(classifyOverlaps(current, [stale]).classification, "none");
	const malformedCurrent = { ...current, refs: "not-an-array" } as unknown as OverlapCandidate;
	assert.equal(classifyOverlaps(malformedCurrent, [chain]).classification, "none");
});

test("paths preserve internal whitespace for exact overlap identity", () => {
	const current = candidate({ refs: [{ kind: "path", value: "/repo/Two  Words" }] });
	const other = candidate({
		workstreamId: asWorkstreamId("ws-2"),
		piSessionId: asPiSessionId("pi-2"),
		refs: [{ kind: "path", value: "/repo/Two Words" }],
	});
	assert.equal(classifyOverlaps(current, [other]).classification, "none", "internal path whitespace is significant");
});

test("branch prefix stripping preserves case for exact overlap identity", () => {
	const current = candidate({ refs: [{ kind: "branch", value: "Feature/Main" }] });
	const other = candidate({
		workstreamId: asWorkstreamId("ws-2"),
		piSessionId: asPiSessionId("pi-2"),
		refs: [{ kind: "branch", value: "REFS/HEADS/Feature/Main" }],
	});
	assert.equal(classifyOverlaps(current, [other]).classification, "none", "branch prefix spelling is significant");
});

test("branch overlap values remain case-sensitive while other refs normalize", () => {
	const current = candidate({ refs: [{ kind: "branch", value: "Feature/Registry" }] });
	const other = candidate({
		workstreamId: asWorkstreamId("ws-2"),
		piSessionId: asPiSessionId("pi-2"),
		refs: [{ kind: "branch", value: "feature/registry" }],
	});
	assert.equal(classifyOverlaps(current, [other]).classification, "none", "branch names preserve case");
});

function sharing(ref: WorkstreamRef, otherRef: WorkstreamRef = ref): ReturnType<typeof classifyOverlaps> {
	const current = candidate({ refs: [ref] });
	const other = candidate({
		workstreamId: asWorkstreamId("ws-2"),
		piSessionId: asPiSessionId("pi-2"),
		projectKey: "other-project",
		refs: [otherRef],
	});
	return classifyOverlaps(current, [other]);
}

test("two sessions that share an issue ref get the collision warning", () => {
	const result = sharing({ kind: "issue", value: "group/project#448" });
	assert.equal(result.classification, "potential-collision");
	assert.deepEqual(result.matches.map((match) => [match.kind, match.value]), [["issue", "group/project#448"]]);
	assert.equal(sharing({ kind: "issue", value: "group/project#448" }, { kind: "issue", value: "group/project#449" }).classification, "none");
});

test("two sessions that share a change ref get the collision warning", () => {
	const result = sharing({ kind: "change", value: "group/project!387" });
	assert.equal(result.classification, "potential-collision");
	assert.deepEqual(result.matches.map((match) => [match.kind, match.value]), [["change", "group/project!387"]]);
	assert.equal(sharing({ kind: "change", value: "group/project!387" }, { kind: "change", value: "group/project!388" }).classification, "none");
});

test("issue and change refs compare their URL forms exactly", () => {
	assert.equal(normalizeOverlapRef({ kind: "issue", value: "https://gitlab.example/Group/Project/-/issues/12/" }), "issue:gitlab.example/group/project#12");
	assert.equal(normalizeOverlapRef({ kind: "issue", value: "https://github.com/owner/repo/issues/7" }), "issue:github.com/owner/repo#7");
	assert.equal(normalizeOverlapRef({ kind: "change", value: "https://gitlab.example/group/project/-/merge_requests/12" }), "change:gitlab.example/group/project!12");
	assert.equal(normalizeOverlapRef({ kind: "change", value: "https://github.com/owner/repo/pull/7" }), "change:github.com/owner/repo!7");
	assert.equal(normalizeOverlapRef({ kind: "change", value: " Group/Project!12 " }), "change:group/project!12");
	// An issue and a change with the same number are different work.
	assert.equal(sharing({ kind: "issue", value: "group/project#12" }, { kind: "change", value: "group/project!12" }).classification, "none");
});

test("every accepted ref kind either counts as overlap or is excluded with a reason", () => {
	for (const kind of REF_KINDS) {
		const matched = OVERLAP_MATCH_KINDS.includes(kind as (typeof OVERLAP_MATCH_KINDS)[number]);
		const reason = OVERLAP_EXCLUDED_KINDS[kind];
		assert.ok(matched !== (reason !== undefined), `${kind} must be either matched or excluded, not both or neither`);
		if (reason !== undefined) assert.ok(reason.length > 20, `${kind} needs a stated reason`);
		if (matched) assert.notEqual(normalizeOverlapRef({ kind, value: kind === "path" ? "/repo/x" : "group/project#1" }), null, `${kind} must normalize`);
		else assert.equal(normalizeOverlapRef({ kind, value: "https://example.test/x" }), null, `${kind} must not normalize`);
	}
});

