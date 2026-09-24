import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	assessCompactionOwnership,
	resolvePiAutoCompactionSetting,
} from "../compaction-ownership.js";

function settingsFixture(): { root: string; cwd: string; agentDir: string } {
	const root = path.join(os.tmpdir(), `context-aware-ownership-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	return { root, cwd, agentDir };
}

test("automatic compaction ownership has exactly two warning states", () => {
	const matrix = [
		{ contextAware: true, piNative: false, state: "context-aware", warns: false },
		{ contextAware: false, piNative: true, state: "pi-native", warns: false },
		{ contextAware: true, piNative: true, state: "competing", warns: true },
		{ contextAware: false, piNative: false, state: "none", warns: true },
	] as const;

	for (const expected of matrix) {
		const actual = assessCompactionOwnership(expected.contextAware, expected.piNative);
		assert.equal(actual.state, expected.state);
		assert.equal(actual.warning !== undefined, expected.warns);
	}
});

test("disabled context-aware summarization reports that ownership is deferred", () => {
	for (const contextAware of [false, true]) {
		for (const piNative of [false, true]) {
			const actual = assessCompactionOwnership(contextAware, piNative, false);
			assert.equal(actual.state, "deferred");
			assert.equal(actual.warning, undefined);
		}
	}
});

test("Pi automatic compaction defaults on and reports the file layer that wins", () => {
	const fixture = settingsFixture();
	try {
		assert.deepEqual(resolvePiAutoCompactionSetting({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			projectTrusted: true,
		}), {
			ok: true,
			enabled: true,
			source: "default",
		});

		fs.writeFileSync(path.join(fixture.agentDir, "settings.json"), JSON.stringify({
			compaction: { enabled: false },
		}));
		assert.deepEqual(resolvePiAutoCompactionSetting({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			projectTrusted: true,
		}), {
			ok: true,
			enabled: false,
			source: "global",
			settingsPath: path.join(fixture.agentDir, "settings.json"),
		});

		fs.writeFileSync(path.join(fixture.cwd, ".pi", "settings.json"), JSON.stringify({
			compaction: { enabled: true },
		}));
		assert.deepEqual(resolvePiAutoCompactionSetting({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			projectTrusted: true,
		}), {
			ok: true,
			enabled: true,
			source: "project",
			settingsPath: path.join(fixture.cwd, ".pi", "settings.json"),
		});
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("untrusted project settings cannot override the global Pi compaction setting", () => {
	const fixture = settingsFixture();
	try {
		fs.writeFileSync(path.join(fixture.agentDir, "settings.json"), JSON.stringify({
			compaction: { enabled: false },
		}));
		fs.writeFileSync(path.join(fixture.cwd, ".pi", "settings.json"), JSON.stringify({
			compaction: { enabled: true },
		}));
		assert.deepEqual(resolvePiAutoCompactionSetting({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			projectTrusted: false,
		}), {
			ok: true,
			enabled: false,
			source: "global",
			settingsPath: path.join(fixture.agentDir, "settings.json"),
		});
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("malformed Pi settings produce an unknown result instead of guessing an owner", () => {
	const fixture = settingsFixture();
	try {
		fs.writeFileSync(path.join(fixture.cwd, ".pi", "settings.json"), "{ invalid json");
		const result = resolvePiAutoCompactionSetting({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			projectTrusted: true,
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.diagnostic, /project Pi settings/i);
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("a non-boolean Pi compaction setting is unknown rather than coerced", () => {
	const fixture = settingsFixture();
	try {
		for (const compaction of [{ enabled: "false" }, null, []]) {
			fs.writeFileSync(path.join(fixture.agentDir, "settings.json"), JSON.stringify({ compaction }));
			const result = resolvePiAutoCompactionSetting({
				cwd: fixture.cwd,
				agentDir: fixture.agentDir,
				projectTrusted: true,
			});
			assert.equal(result.ok, false);
			if (!result.ok) assert.match(result.diagnostic, /not a boolean/i);
		}
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});
