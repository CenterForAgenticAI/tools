import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Extension load reads the project's .pi/context-aware.json, which sits at the
// worktree top level, so finding it takes git. The lookup runs synchronously
// before Pi can draw anything, and each git process there is start-up time.
// Issue #182.

interface LoadResult {
	readonly gitCommands: readonly string[];
	readonly tools: ReadonlySet<string>;
}

const REAL_GIT = process.platform === "win32" ? "" : execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

async function loadExtensionIn(root: string, cwd: string, label: string): Promise<LoadResult> {
	const bin = path.join(root, `bin-${label}`);
	const log = path.join(root, `git-${label}.log`);
	fs.mkdirSync(bin);
	// Records each command, then runs the real git so the answers stay real.
	fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${REAL_GIT}' "$@"\n`);
	fs.chmodSync(path.join(bin, "git"), 0o755);
	const prior = { cwd: process.cwd(), path: process.env.PATH, home: process.env.HOME, agentDir: process.env.PI_CODING_AGENT_DIR };
	const tools = new Set<string>();
	const noop = () => undefined;
	const api = new Proxy({}, {
		get(_target, key) {
			if (key === "registerTool") return (tool: { name: string }) => { tools.add(tool.name); };
			if (key === "events") return { emit: noop, on: () => noop };
			return noop;
		},
	}) as unknown as ExtensionAPI;
	try {
		process.env.PATH = `${bin}${path.delimiter}${prior.path ?? ""}`;
		process.env.HOME = root;
		process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
		process.chdir(cwd);
		// A fresh module instance, so the memoized project root starts empty.
		const extension = await import(`../src/index.js?project-config-git=${label}-${Date.now()}`);
		extension.default(api);
	} finally {
		process.chdir(prior.cwd);
		process.env.PATH = prior.path;
		if (prior.home === undefined) delete process.env.HOME;
		else process.env.HOME = prior.home;
		if (prior.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prior.agentDir;
	}
	const gitCommands = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
	return { gitCommands, tools };
}

test("extension load finds the top-level project config with one git command", { skip: process.platform === "win32" }, async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-project-git-")));
	try {
		fs.mkdirSync(path.join(root, "agent"));
		const repo = path.join(root, "repo");
		const nested = path.join(repo, "packages", "app");
		fs.mkdirSync(nested, { recursive: true });
		execFileSync(REAL_GIT, ["init", "-q", repo]);

		// Without a project file, load registers the handoff tool.
		const bare = await loadExtensionIn(root, nested, "bare");
		assert.deepEqual(bare.gitCommands, [`-C ${nested} rev-parse --show-toplevel`]);
		assert.equal(bare.tools.has("compact_session"), true);

		// A project file at the top level that sets summarizer.enabled defers the
		// handoff tool to session start. Load runs from a nested directory, so the
		// file is found only through the top-level path git reported.
		fs.mkdirSync(path.join(repo, ".pi"));
		fs.writeFileSync(path.join(repo, ".pi", "context-aware.json"), JSON.stringify({ summarizer: { enabled: true } }));
		const configured = await loadExtensionIn(root, nested, "configured");
		assert.deepEqual(configured.gitCommands, [`-C ${nested} rev-parse --show-toplevel`]);
		assert.equal(configured.tools.has("compact_session"), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
