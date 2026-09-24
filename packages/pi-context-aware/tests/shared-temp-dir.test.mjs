import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Keeps the suite out of the temp directory the whole machine shares.
 *
 * A run that writes into `/tmp` directly leaves its directories behind for
 * good: nothing owns them afterwards, and they accumulate until someone
 * notices tens of thousands of them. `scripts/with-temp-root.mjs` gives each
 * run its own root and deletes it, which covers every call site that asks
 * `os.tmpdir()` where to write.
 *
 * Three things can defeat that, so all three are checked here rather than left
 * to review: naming `/tmp` directly, which steps around TMPDIR; unwiring the
 * wrapper from the scripts that start a run; and the wrapper reporting success
 * for a run that was killed.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const wrapper = path.join(repoRoot, "scripts", "with-temp-root.mjs");

function runWrapper(args, { env = {}, onStdout, timeoutMs = 5000 } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [wrapper, ...args], {
			detached: true,
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;

		const killGroup = () => {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				// The process group has already exited.
			}
		};
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			killGroup();
			reject(new Error(`wrapper did not exit within ${timeoutMs}ms; stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`));
		}, timeoutMs);

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			try {
				onStdout?.(stdout, child);
			} catch (error) {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				killGroup();
				reject(error);
			}
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error);
		});
		child.on("exit", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ code, signal, stdout, stderr });
		});
	});
}

/**
 * Calls that bring a file or directory into existence, so a `/tmp` literal in
 * their arguments is a write to shared state. The check is built from this list
 * rather than from any specific offender, so a call site added later is caught
 * without anyone remembering to extend a list of known bad files.
 *
 * `open`/`openSync` are deliberately absent: their mode argument decides
 * whether they write, so including them reported ordinary reads as leaks.
 */
const CREATORS = [
	"mkdtemp",
	"mkdtempSync",
	"mkdir",
	"mkdirSync",
	"writeFile",
	"writeFileSync",
	"appendFile",
	"appendFileSync",
	"copyFile",
	"copyFileSync",
	"cp",
	"cpSync",
	"rename",
	"renameSync",
	"createWriteStream",
];

/**
 * Matches across newlines and through one nested call such as `path.join(`, so
 * a wrapped or multiline argument list cannot slip past. `[^)]` admits both.
 * The bound keeps a pathological file from backtracking.
 */
const SHARED_TMP_WRITE = new RegExp(`(?:${CREATORS.join("|")})\\s*\\([^;]{0,200}?["'\`]/tmp`, "g");

const SKIP_DIRS = new Set(["node_modules", ".git", ".worktrees", ".test-dist", "dist", "coverage"]);

// This file names the pattern it bans, so scanning it would always match. Keyed
// on the full path, not the basename, so a same-named file elsewhere is scanned.
const SELF = fileURLToPath(import.meta.url);

function sourceFiles(dir, out = []) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (SKIP_DIRS.has(entry.name)) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) sourceFiles(full, out);
		else if (/\.(ts|mts|mjs|js)$/.test(entry.name) && full !== SELF) out.push(full);
	}
	return out;
}

/** Line number of a character offset, for a readable failure. */
function lineOf(text, index) {
	return text.slice(0, index).split("\n").length;
}

test("no source file writes into the shared temp directory", () => {
	const offenders = [];
	for (const file of sourceFiles(repoRoot)) {
		const text = fs.readFileSync(file, "utf8");
		SHARED_TMP_WRITE.lastIndex = 0;
		for (const match of text.matchAll(SHARED_TMP_WRITE)) {
			offenders.push(`${path.relative(repoRoot, file)}:${lineOf(text, match.index)}: ${match[0].replace(/\s+/g, " ").trim()}`);
		}
	}
	assert.deepEqual(
		offenders,
		[],
		"These write into the machine's shared temp directory, so what they create is never removed.\n" +
			"Use os.tmpdir() instead -- the test run redirects it to a private root that gets deleted.\n\n" +
			offenders.join("\n"),
	);
});

test("the shared-temp write guard reaches nested destinations without crossing statements", () => {
	const matches = (source) => {
		SHARED_TMP_WRITE.lastIndex = 0;
		return [...source.matchAll(SHARED_TMP_WRITE)].map((match) => match[0]);
	};

	assert.deepEqual(matches('copyFileSync(path.join("source", "file"), "/tmp/destination")'), [
		'copyFileSync(path.join("source", "file"), "/tmp',
	]);
	assert.deepEqual(matches('writeFileSync(os.tmpdir(), "safe");\nconst unrelated = "/tmp/not-a-write";'), []);
});

/**
 * A script may chain steps with `&&`, `||`, `;`, `|`, or a newline. Each step
 * that is not simply delegating to another npm script has to be launched BY
 * the wrapper, so the wrapper owns the TMPDIR the step runs under.
 * Merely mentioning the wrapper somewhere in the line is not enough:
 * `node --test x && node with-temp-root.mjs true` runs the tests
 * outside any root.
 */
const EXECUTORS = /^(?:\w+=\S*\s+)*(?:node|npx|tsx|sh|bash|c8|vitest)\b/;

function unwrappedSteps(body) {
	return body
		.split(/&&|\|\||[;|\n]/)
		.map((step) => step.trim())
		.filter((step) => step.length > 0)
		// Delegation to another npm script: that script is covered by this rule.
		.filter((step) => !/^npm run [\w:-]+$/.test(step))
		// Only steps that execute code can create temp files. A step like
		// `rm -rf .test-dist` or `tsc -p ...` has nothing to contain.
		.filter((step) => EXECUTORS.test(step))
		// Anything left must be launched BY the wrapper, after optional VAR=value.
		.filter((step) => !/^(?:\w+=\S*\s+)*node\s+\S*(?:^|\/)with-temp-root\.mjs\s/.test(step));
}

test("the wrapper guard checks every supported separator", () => {
	for (const separator of ["&&", "||", ";", "\n", "|"]) {
		const body = `node scripts/with-temp-root.mjs true ${separator} node --test x`;
		assert.deepEqual(
			unwrappedSteps(body),
			["node --test x"],
			`a step chained by ${JSON.stringify(separator)} after a wrapped command must be reported`,
		);
	}

	assert.deepEqual(unwrappedSteps("node scripts/with-temp-root.mjs a | node scripts/with-temp-root.mjs b"), []);
});

test("the wrapper guard rejects a lookalike script path", () => {
	assert.deepEqual(unwrappedSteps("node scripts/not-with-temp-root.mjs true"), ["node scripts/not-with-temp-root.mjs true"]);
});

test("scripts that start a test run go through the temp-root wrapper", () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
	// Selected by NAME rather than by what the body happens to invoke: matching
	// the body for a runner leaves anything reaching temp files another way --
	// a shell harness, a packaging smoke test -- silently uncovered.
	const entryPoints = Object.entries(pkg.scripts ?? {}).filter(([name]) => /^(?:test|coverage|smoke)/.test(name));

	assert.ok(entryPoints.length > 0, "expected at least one test entry point");

	const offenders = [];
	for (const [name, body] of entryPoints) {
		for (const step of unwrappedSteps(body)) offenders.push(`${name}: ${step}`);
	}

	assert.deepEqual(offenders, [], "These steps run outside a private temp root, so the run leaks into /tmp:\n" + offenders.join("\n"));
});

test("the wrapper reports a killed run as a failure, not a success", () => {
	// Regression: re-raising a signal while our own handler was still attached
	// made the wrapper catch its own signal and exit 0, which would report a
	// cancelled or killed gate as passing.
	for (const signal of ["TERM", "INT", "HUP"]) {
		const result = spawnSync(process.execPath, [wrapper, "sh", "-c", `kill -${signal} $$`], { encoding: "utf8" });
		const status = result.signal ? 1 : result.status;
		assert.notEqual(status, 0, `a child killed by SIG${signal} must not report success (got status ${result.status}, signal ${result.signal})`);
	}
});

test("a caught cancellation signal still makes the wrapper fail", async () => {
	let sent = false;
	const result = await runWrapper([
		process.execPath,
		"--input-type=module",
		"-e",
		'process.on("SIGTERM", () => process.exit(0)); console.log("READY"); setInterval(() => {}, 1000);',
	], {
		onStdout(stdout, child) {
			if (sent || !stdout.includes("READY")) return;
			sent = true;
			child.kill("SIGTERM");
		},
	});

	assert.ok(result.signal === "SIGTERM" || result.code === 143, `expected SIGTERM cancellation, got ${JSON.stringify(result)}`);
});

test("an ignored cancellation signal is forcefully bounded", async () => {
	let sent = false;
	const result = await runWrapper(
		[
			process.execPath,
			"--input-type=module",
			"-e",
			'process.on("SIGTERM", () => {}); console.log("READY"); setInterval(() => {}, 1000);',
		],
		{
			env: { PI_TEST_SHUTDOWN_GRACE_MS: "50" },
			onStdout(stdout, child) {
				if (sent || !stdout.includes("READY")) return;
				sent = true;
				child.kill("SIGTERM");
			},
			timeoutMs: 2000,
		},
	);

	assert.ok(result.signal === "SIGKILL" || result.code === 137, `expected bounded SIGKILL escalation, got ${JSON.stringify(result)}`);
});

test("the wrapper forwards a later cancellation signal", async () => {
	let sent = 0;
	const result = await runWrapper(
		[
			process.execPath,
			"--input-type=module",
			"-e",
			'let count = 0; process.on("SIGTERM", () => { count += 1; if (count === 1) console.log("FIRST"); else process.exit(0); }); console.log("READY"); setInterval(() => {}, 1000);',
		],
		{
			env: { PI_TEST_SHUTDOWN_GRACE_MS: "500" },
			onStdout(stdout, child) {
				if (sent === 0 && stdout.includes("READY")) {
					sent = 1;
					child.kill("SIGTERM");
				} else if (sent === 1 && stdout.includes("FIRST")) {
					sent = 2;
					child.kill("SIGTERM");
				}
			},
			timeoutMs: 2000,
		},
	);

	assert.equal(sent, 2, `expected to send two signals; stdout=${JSON.stringify(result.stdout)}`);
	assert.ok(result.signal === "SIGTERM" || result.code === 143, `expected the second SIGTERM to reach the child, got ${JSON.stringify(result)}`);
});

test("a signal delivered during run-root cleanup still cancels the wrapper", async () => {
	const childScript = [
		'import { spawn } from "node:child_process";',
		'import fs from "node:fs";',
		'import path from "node:path";',
		'for (let index = 0; index < 5000; index += 1) fs.writeFileSync(path.join(process.env.TMPDIR, `entry-${index}`), "x");',
		'const wrapperPid = process.ppid;',
		'const killer = spawn(process.execPath, ["--input-type=module", "-e", `setTimeout(() => { try { process.kill(${wrapperPid}, "SIGTERM"); } catch {} }, 25);`], { detached: true, stdio: "ignore" });',
		"killer.unref();",
	].join("\n");

	const result = await runWrapper([process.execPath, "--input-type=module", "-e", childScript], { timeoutMs: 10000 });

	assert.ok(result.signal === "SIGTERM" || result.code === 143, `expected cleanup-time SIGTERM cancellation, got ${JSON.stringify(result)}`);
});

test("the wrapper preserves an ordinary exit status", () => {
	const failed = spawnSync(process.execPath, [wrapper, "sh", "-c", "exit 37"], { encoding: "utf8" });
	assert.equal(failed.status, 37);

	const passed = spawnSync(process.execPath, [wrapper, "true"], { encoding: "utf8" });
	assert.equal(passed.status, 0);
});

test("the wrapper removes its run root when the command cannot start", () => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-error-cleanup-"));
	try {
		const missingCommand = path.join(parent, "command-does-not-exist");
		const result = spawnSync(process.execPath, [wrapper, missingCommand], {
			encoding: "utf8",
			env: { ...process.env, TMPDIR: parent },
		});

		assert.equal(result.status, 127);
		assert.deepEqual(fs.readdirSync(parent), [], "the failed launch must not leave its private run root behind");
	} finally {
		fs.rmSync(parent, { recursive: true, force: true });
	}
});

test("an operator's TMPDIR is honoured, and a stale one degrades instead of crashing", () => {
	const runRootUnder = (env) => {
		const probe = spawnSync(process.execPath, [wrapper, "sh", "-c", 'printf %s "$TMPDIR"'], { encoding: "utf8", env: { ...process.env, ...env } });
		return { status: probe.status, root: probe.stdout.trim() };
	};

	// A usable TMPDIR is what lets an operator move the run off tmpfs.
	const moved = fs.mkdtempSync(path.join(os.tmpdir(), "operator-tmpdir-"));
	try {
		const honoured = runRootUnder({ TMPDIR: moved });
		assert.equal(honoured.status, 0);
		assert.ok(honoured.root.startsWith(moved), `expected the run root under ${moved}, got ${honoured.root}`);
	} finally {
		fs.rmSync(moved, { recursive: true, force: true });
	}

	// Regression: os.tmpdir() reads TMPDIR, so falling back to it after
	// rejecting TMPDIR returned the rejected value and mkdtemp crashed.
	const stale = runRootUnder({ TMPDIR: path.join(os.tmpdir(), "stale-does-not-exist-", String(process.pid)) });
	assert.equal(stale.status, 0, "a stale TMPDIR must degrade to the platform default, not fail the run");
	assert.ok(stale.root.length > 0 && fs.existsSync(path.dirname(stale.root)), `run root ${stale.root} should sit in a real directory`);
});


test("the wrapper removes the run root it created", () => {
	const probe = spawnSync(process.execPath, [wrapper, "sh", "-c", 'printf %s "$TMPDIR"'], { encoding: "utf8" });
	assert.equal(probe.status, 0);
	const runRoot = probe.stdout.trim();
	assert.ok(runRoot.startsWith(os.tmpdir()), `run root ${runRoot} should sit under ${os.tmpdir()}`);
	assert.equal(fs.existsSync(runRoot), false, `run root ${runRoot} should have been removed`);
});
