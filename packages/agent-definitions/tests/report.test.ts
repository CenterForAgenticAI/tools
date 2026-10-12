import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatLoweringReport } from "../src/report.ts";

describe("formatLoweringReport", () => {
	it("says nothing was lost when there are no entries", () => {
		assert.equal(
			formatLoweringReport({ target: "opencode", direction: "export", entries: [] }),
			"export opencode: nothing lost\n",
		);
	});

	it("uses the singular for one change and names the replacement", () => {
		assert.equal(
			formatLoweringReport({
				target: "claude-code",
				direction: "export",
				entries: [
					{
						path: "workspace.isolation",
						action: "weakened",
						result: "isolation: worktree",
						reason: "Claude Code has no disposable copy.",
					},
				],
			}),
			'export claude-code: 1 change\n- workspace.isolation: weakened to "isolation: worktree". Claude Code has no disposable copy.\n',
		);
	});

	it("lists every entry in order and omits a missing replacement", () => {
		assert.equal(
			formatLoweringReport({
				target: "pi-durable",
				direction: "runtime",
				entries: [
					{ path: "limits.maxTurns", action: "dropped", reason: "configure() has no turn limit." },
					{ path: "skills", action: "inlined", result: "instructions", reason: "configure() has no skill slot." },
				],
			}),
			'runtime pi-durable: 2 changes\n- limits.maxTurns: dropped. configure() has no turn limit.\n- skills: inlined to "instructions". configure() has no skill slot.\n',
		);
	});
});
