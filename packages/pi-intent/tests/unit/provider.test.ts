import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import type { FabricComponentContext, FabricInvocationContext, FabricProvider } from "pi-fabric/protocol";

import { INTENT_COMPONENT, confineRepoDir, createIntentProvider, runKit, type KitRun, type KitRunOptions } from "../../src/provider.js";

function findRoot(from: string): string {
	for (let dir = from; ; dir = dirname(dir)) {
		if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "kit"))) return dir;
		if (dirname(dir) === dir) throw new Error("repository root not found");
	}
}
const repoRoot = findRoot(import.meta.dirname);

interface Call {
	argv: readonly string[];
	options: KitRunOptions;
}

function scratch(): string {
	mkdirSync(join(repoRoot, ".scratch"), { recursive: true });
	return mkdtempSync(join(repoRoot, ".scratch", "provider-"));
}

/** A repository directory that has the vendored kit scripts present (empty files; the runner is faked). */
function vendoredRepo(): string {
	const dir = scratch();
	mkdirSync(join(dir, ".intent", "tools"), { recursive: true });
	for (const name of ["check", "gate", "conform", "receipt"]) writeFileSync(join(dir, ".intent", "tools", `intent-${name}.mjs`), "// stub\n");
	return dir;
}

const context = (cwd: string): FabricInvocationContext => ({ cwd, signal: undefined }) as unknown as FabricInvocationContext;

function fake(result: Partial<KitRun> = {}): { provider: FabricProvider; calls: Call[] } {
	const calls: Call[] = [];
	const provider = createIntentProvider({
		run: async (argv, options) => {
			calls.push({ argv, options });
			return { status: 0, stdout: "", stderr: "", timedOut: false, ...result };
		},
	});
	return { provider, calls };
}

test("the provider offers check, gate, conform and receipt, and nothing that approves", async () => {
	const { provider } = fake();
	const actions = await provider.list({} as never, context("/"));
	assert.equal(provider.name, "intent");
	assert.deepEqual(actions.map((a) => a.name).sort(), ["check", "conform", "gate", "receipt"]);
	assert.ok(!actions.some((a) => /approv|sha256|write/i.test(a.name)));
	const risks = Object.fromEntries(actions.map((a) => [a.name, a.risk]));
	assert.deepEqual(risks, { check: "execute", gate: "execute", conform: "execute", receipt: "network" });
	for (const a of actions) assert.equal(await provider.describe(a.name, context("/")).then((d) => d?.name), a.name);
	assert.equal(await provider.describe("approve", context("/")), undefined);
});

test("an action the provider does not offer is rejected, including approve", async () => {
	const dir = vendoredRepo();
	try {
		const { provider, calls } = fake();
		for (const name of ["approve", "init", "constructor", "__proto__"]) await assert.rejects(provider.invoke(name, { repoDir: dir }, context(dir)), /unknown action/i);
		assert.equal(calls.length, 0);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("exit codes map to pass, reject and unavailable, and the last output line becomes the message", async () => {
	const dir = vendoredRepo();
	try {
		const cases: Array<[Partial<KitRun>, string, number | null]> = [
			[{ status: 0, stdout: "noise\nintent-check: ok (1 approved record(s))\n" }, "pass", 0],
			[{ status: 1, stderr: "LAWS.bend changed since approval\n" }, "reject", 1],
			[{ status: 2, stderr: "unavailable: .intent/records\n" }, "unavailable", 2],
			[{ status: 7, stderr: "boom\n" }, "unavailable", 7],
			[{ status: null, timedOut: true }, "unavailable", null],
		];
		for (const [result, verdict, exitCode] of cases) {
			const { provider } = fake(result);
			const out = (await provider.invoke("check", { repoDir: dir }, context(dir))) as Record<string, unknown>;
			assert.equal(out.action, "check");
			assert.equal(out.verdict, verdict);
			assert.equal(out.exitCode, exitCode);
		}
		const { provider } = fake({ status: 0, stdout: "noise\nintent-check: ok (1 approved record(s))\n" });
		const out = (await provider.invoke("check", { repoDir: dir }, context(dir))) as { message: string };
		assert.equal(out.message, "intent-check: ok (1 approved record(s))");
		const timeout = (await fake({ status: null, timedOut: true }).provider.invoke("gate", { repoDir: dir }, context(dir))) as { message: string };
		assert.match(timeout.message, /timed out/i);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("each action runs the repository's vendored script with an argv array and no shell", async () => {
	const dir = vendoredRepo();
	try {
		const { provider, calls } = fake();
		await provider.invoke("check", { repoDir: dir }, context(dir));
		await provider.invoke("gate", {}, context(dir));
		await provider.invoke("conform", { repoDir: dir, requireCoverage: true }, context(dir));
		await provider.invoke("conform", { repoDir: dir }, context(dir));
		await provider.invoke("receipt", { repoDir: dir, recordId: "0001-transitions", model: "typesafe/jev-1.13" }, context(dir));
		const tool = (name: string): string => join(dir, ".intent", "tools", `intent-${name}.mjs`);
		assert.deepEqual(calls.map((c) => [...c.argv]), [
			[tool("check"), dir],
			[tool("gate"), dir],
			[tool("conform"), dir, "--require-coverage"],
			[tool("conform"), dir],
			[tool("receipt"), dir, "0001-transitions", "typesafe/jev-1.13"],
		]);
		for (const c of calls) assert.equal(c.options.cwd, dir);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("caller fields other than the declared ones never reach the subprocess", async () => {
	const dir = vendoredRepo();
	try {
		const { provider, calls } = fake();
		await provider.invoke("gate", { repoDir: dir, shell: true, env: { NODE_OPTIONS: "--require /tmp/x" }, timeoutMs: 1, cwd: "/", argv: ["rm", "-rf", "/"], maxBuffer: 1 }, context(dir));
		assert.equal(calls.length, 1);
		assert.deepEqual(Object.keys(calls[0]!.options).sort(), ["cwd", "maxOutputBytes", "signal", "timeoutMs"]);
		assert.ok(calls[0]!.options.timeoutMs > 1);
		assert.equal(calls[0]!.options.cwd, dir);
		assert.ok(!calls[0]!.argv.includes("rm"));
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a repository directory outside the session cwd is refused, including through a symlink", async () => {
	const dir = vendoredRepo();
	const outside = vendoredRepo();
	try {
		symlinkSync(outside, join(dir, "escape"));
		const { provider, calls } = fake();
		for (const repoDir of [outside, join(dir, ".."), "/", join(dir, "escape"), "../elsewhere", "bad\0dir"]) {
			await assert.rejects(provider.invoke("check", { repoDir }, context(dir)), /outside|invalid/i, repoDir);
		}
		assert.equal(calls.length, 0);
		// a relative directory inside the cwd is accepted
		mkdirSync(join(dir, "sub", ".intent", "tools"), { recursive: true });
		writeFileSync(join(dir, "sub", ".intent", "tools", "intent-check.mjs"), "// stub\n");
		await provider.invoke("check", { repoDir: "sub" }, context(dir));
		assert.equal(calls.length, 1);
	} finally { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("a vendored script that is missing or a symlink is unavailable, not run", async () => {
	const dir = scratch();
	const outside = vendoredRepo();
	try {
		const { provider, calls } = fake();
		const missing = (await provider.invoke("check", { repoDir: dir }, context(dir))) as { verdict: string; message: string };
		assert.equal(missing.verdict, "unavailable");
		assert.match(missing.message, /vendor/i);
		mkdirSync(join(dir, ".intent", "tools"), { recursive: true });
		symlinkSync(join(outside, ".intent", "tools", "intent-check.mjs"), join(dir, ".intent", "tools", "intent-check.mjs"));
		const linked = (await provider.invoke("check", { repoDir: dir }, context(dir))) as { verdict: string };
		assert.equal(linked.verdict, "unavailable");
		// a link that stays inside the repository is refused too: the kit entry point exits 0 without running when linked
		rmSync(join(dir, ".intent", "tools", "intent-check.mjs"));
		writeFileSync(join(dir, ".intent", "tools", "check-copy.mjs"), "// stub\n");
		symlinkSync(join(dir, ".intent", "tools", "check-copy.mjs"), join(dir, ".intent", "tools", "intent-check.mjs"));
		const inside = (await provider.invoke("check", { repoDir: dir }, context(dir))) as { verdict: string };
		assert.equal(inside.verdict, "unavailable");
		assert.equal(calls.length, 0);
	} finally { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("receipt arguments that could become options or paths are refused", async () => {
	const dir = vendoredRepo();
	try {
		const { provider, calls } = fake();
		for (const args of [
			{ recordId: "../0001-x", model: "m" }, { recordId: "0001-x; rm -rf /", model: "m" }, { recordId: "0001-x", model: "--help" },
			{ recordId: "0001-x", model: "" }, { recordId: "0001-x" }, { model: "m" }, { recordId: 1, model: "m" },
		]) await assert.rejects(provider.invoke("receipt", { repoDir: dir, ...args }, context(dir)), /invalid|required/i, JSON.stringify(args));
		assert.equal(calls.length, 0);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a long output is truncated to its tail and flagged", async () => {
	const dir = vendoredRepo();
	try {
		const long = "x".repeat(100_000) + "\nintent-gate: ok (3 negative controls)\n";
		const { provider } = fake({ stdout: long });
		const out = (await provider.invoke("gate", { repoDir: dir }, context(dir))) as { output: string; truncated: boolean; message: string };
		assert.equal(out.truncated, true);
		assert.ok(out.output.length <= 16_384);
		assert.match(out.output, /intent-gate: ok/);
		assert.equal(out.message, "intent-gate: ok (3 negative controls)");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the real runner executes the vendored check: pass on the example, reject once the laws change", async () => {
	const dir = scratch();
	try {
		cpSync(join(repoRoot, "examples", "transitions"), dir, { recursive: true });
		renameSync(join(dir, "intent"), join(dir, ".intent"));
		execFileSync(process.execPath, [join(repoRoot, "bin", "pi-intent.mjs"), "vendor", dir], { stdio: "pipe" });
		const provider = createIntentProvider();
		const ok = (await provider.invoke("check", { repoDir: dir }, context(dir))) as { verdict: string; message: string };
		assert.equal(ok.verdict, "pass", JSON.stringify(ok));
		assert.match(ok.message, /intent-check: ok/);
		writeFileSync(join(dir, ".intent", "model", "LAWS.bend"), "# tampered\n", { flag: "a" });
		const bad = (await provider.invoke("check", { repoDir: dir }, context(dir))) as { verdict: string; exitCode: number };
		assert.equal(bad.verdict, "reject");
		assert.equal(bad.exitCode, 1);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the component provides the intent provider and withdraws it with its lease", async () => {
	assert.equal(INTENT_COMPONENT.name, "pi-intent");
	assert.deepEqual(INTENT_COMPONENT.provides, ["intent"]);
	const provided: FabricProvider[] = [];
	let retired = 0;
	const fakeContext = { provide: (p: FabricProvider) => { provided.push(p); return { retire: () => { retired++; } }; }, defer: (d: unknown) => d } as unknown as FabricComponentContext;
	const effect = await INTENT_COMPONENT.activate(fakeContext, undefined);
	assert.equal(provided.length, 1);
	assert.equal(provided[0]!.name, "intent");
	assert.equal(typeof effect, "function", "activate must return a disposer");
	assert.equal(retired, 0);
	await (effect as () => unknown)();
	assert.equal(retired, 1);
});

test("a single oversized last line is capped in the message as well as in the output", async () => {
	const dir = vendoredRepo();
	try {
		const { provider } = fake({ stdout: "y".repeat(100_000) + "\n" });
		const out = (await provider.invoke("gate", { repoDir: dir }, context(dir))) as { message: string; output: string };
		assert.ok(out.message.length <= 600, String(out.message.length));
		assert.ok(out.output.length <= 16_384);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

function script(dir: string, body: string): string {
	const path = join(dir, "run.mjs");
	writeFileSync(path, body);
	return path;
}
const runOptions = (cwd: string, extra: Partial<KitRunOptions> = {}): KitRunOptions => ({ cwd, timeoutMs: 10_000, maxOutputBytes: 1_000_000, signal: undefined, ...extra });
const gone = async (marker: string): Promise<boolean> => { await new Promise((r) => setTimeout(r, 1_200)); return !existsSync(marker); };

test("the real runner ends the whole process tree on timeout, so a descendant cannot keep writing", async () => {
	const dir = scratch();
	try {
		const marker = join(dir, "marker");
		const file = script(dir, `import { spawn } from "node:child_process"; spawn(process.execPath, ["-e", "setTimeout(()=>require('fs').writeFileSync(" + JSON.stringify(${JSON.stringify(marker)}) + ",'x'),700)"], { stdio: "ignore" }); setInterval(()=>{},1000);`);
		const out = await runKit([file], runOptions(dir, { timeoutMs: 300 }));
		assert.equal(out.timedOut, true);
		assert.doesNotMatch(out.stderr, /killed by/, "our own timeout kill is not reported as a signal kill");
		assert.equal(await gone(marker), true, "a descendant survived the timeout");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the real runner ends the tree on cancellation and on output overflow", async () => {
	const dir = scratch();
	try {
		const marker = join(dir, "marker");
		const child = `import { spawn } from "node:child_process"; spawn(process.execPath, ["-e", "setTimeout(()=>require('fs').writeFileSync(" + JSON.stringify(${JSON.stringify(marker)}) + ",'x'),700)"], { stdio: "ignore" });`;
		const ready = join(dir, "ready");
		const hang = script(dir, child + "import('node:fs').then((fs) => fs.writeFileSync(" + JSON.stringify(ready) + ", 'x')); setInterval(()=>{},1000);");
		const controller = new AbortController();
		const pending = runKit([hang], runOptions(dir, { signal: controller.signal }));
		await until(ready);
		controller.abort();
		const cancelled = await pending;
		assert.equal(cancelled.timedOut, false);
		assert.equal(cancelled.status, null);
		assert.equal(await gone(marker), true, "a descendant survived the cancel");
		const flood = script(dir, child + "process.stdout.write('z'.repeat(200000)); setInterval(()=>{},1000);");
		const over = await runKit([flood], runOptions(dir, { maxOutputBytes: 1_000 }));
		assert.equal(over.status, null);
		assert.match(over.stderr, /size cap/);
		assert.equal(await gone(marker), true, "a descendant survived the overflow");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the real runner reports a normal exit code and output", async () => {
	const dir = scratch();
	try {
		const out = await runKit([script(dir, "console.log('hello'); console.error('warn'); process.exitCode = 1;")], runOptions(dir));
		assert.deepEqual([out.status, out.stdout.trim(), out.stderr.trim(), out.timedOut], [1, "hello", "warn", false]);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a repository whose check script is linked reports unavailable instead of a pass for a check that never ran", async () => {
	const dir = scratch();
	try {
		cpSync(join(repoRoot, "examples", "transitions"), dir, { recursive: true });
		renameSync(join(dir, "intent"), join(dir, ".intent"));
		execFileSync(process.execPath, [join(repoRoot, "bin", "pi-intent.mjs"), "vendor", dir], { stdio: "pipe" });
		const tools = join(dir, ".intent", "tools");
		renameSync(join(tools, "intent-check.mjs"), join(tools, "check-copy.mjs"));
		symlinkSync(join(tools, "check-copy.mjs"), join(tools, "intent-check.mjs"));
		writeFileSync(join(dir, ".intent", "model", "LAWS.bend"), "# tampered\n", { flag: "a" });
		const out = (await createIntentProvider().invoke("check", { repoDir: dir }, context(dir))) as { verdict: string };
		assert.equal(out.verdict, "unavailable");
		assert.ok(readFileSync(join(dir, ".intent", "tools", "check-copy.mjs"), "utf8").length > 0);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

const until = async (path: string, ms = 5_000): Promise<void> => {
	for (const start = Date.now(); !existsSync(path); ) {
		if (Date.now() - start > ms) throw new Error("timed out waiting for " + path);
		await new Promise((r) => setTimeout(r, 20));
	}
};
const spawnLate = (marker: string, delay: number, stdio: string): string => "import { spawn } from \"node:child_process\"; spawn(process.execPath, [\"-e\", \"setTimeout(()=>require('fs').writeFileSync(\" + JSON.stringify(" + JSON.stringify(marker) + ") + \",'x')," + delay + ")\"], { stdio: \"" + stdio + "\" }).unref();";

test("a leader that exits cleanly keeps its exit status and its descendants are ended, even when they hold the output pipes", async () => {
	const dir = scratch();
	try {
		const marker = join(dir, "marker");
		const file = script(dir, spawnLate(marker, 600, "inherit") + "process.exit(0);");
		const started = Date.now();
		const out = await runKit([file], runOptions(dir, { timeoutMs: 5_000 }));
		assert.equal(out.timedOut, false);
		assert.equal(out.status, 0);
		assert.ok(Date.now() - started < 450, "settled only after the descendant released the pipes: " + String(Date.now() - started) + "ms");
		assert.equal(await gone(marker), true, "a descendant survived a clean exit");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a multibyte character split across chunks is decoded whole on both streams", async () => {
	const dir = scratch();
	try {
		const body = "process.stdout.write(Buffer.from([0xe2])); process.stderr.write(Buffer.from([0xf0, 0x9f])); setTimeout(()=>{ process.stdout.write(Buffer.from([0x82, 0xac])); process.stderr.write(Buffer.from([0x98, 0x80])); }, 120);";
		const out = await runKit([script(dir, body)], runOptions(dir));
		assert.equal(out.stdout, "\u20ac");
		assert.equal(out.stderr, "\u{1F600}");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an overflow or a cancel is still explained when the script already wrote to stderr", async () => {
	const dir = scratch();
	try {
		const flood = script(dir, "process.stderr.write('warning first\\n'); process.stdout.write('z'.repeat(200000)); setInterval(()=>{},1000);");
		const over = await runKit([flood], runOptions(dir, { maxOutputBytes: 1_000 }));
		assert.match(over.stderr, /warning first/);
		assert.match(over.stderr, /size cap/);
		const ready = join(dir, "ready");
		const hang = script(dir, "process.stderr.write('warn\\n'); import('node:fs').then((fs) => fs.writeFileSync(" + JSON.stringify(ready) + ", 'x')); setInterval(()=>{},1000);");
		const controller = new AbortController();
		const pending = runKit([hang], runOptions(dir, { signal: controller.signal }));
		await until(ready);
		controller.abort();
		const cancelled = await pending;
		assert.match(cancelled.stderr, /warn/);
		assert.match(cancelled.stderr, /cancelled/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the cancel listener is removed once the run ends", async () => {
	const dir = scratch();
	try {
		let added = 0;
		let removed = 0;
		const signal = { aborted: false, addEventListener: () => { added++; }, removeEventListener: () => { removed++; } } as unknown as AbortSignal;
		await runKit([script(dir, "process.exitCode = 0;")], runOptions(dir, { signal }));
		assert.equal(added, 1);
		assert.equal(removed, 1);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the runner refuses a platform where it cannot end the process tree", async () => {
	const dir = scratch();
	const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
	try {
		Object.defineProperty(process, "platform", { value: "win32" });
		const out = await runKit([script(dir, "console.log('ran')")], runOptions(dir));
		assert.equal(out.stdout, "");
		assert.equal(out.status, null);
		assert.match(out.stderr, /POSIX/);
	} finally { Object.defineProperty(process, "platform", platform); rmSync(dir, { recursive: true, force: true }); }
});

test("every message stays within the documented 500 characters, the missing-kit message included", async () => {
	const repo = vendoredRepo();
	const dir = scratch();
	try {
		const { provider } = fake({ stdout: "y".repeat(5_000) + "\n" });
		const long = (await provider.invoke("gate", { repoDir: repo }, context(repo))) as { message: string };
		assert.equal(long.message.length, 500);
		let deep = dir;
		for (const part of ["a".repeat(200), "b".repeat(200), "c".repeat(200)]) { deep = join(deep, part); mkdirSync(deep); }
		const missing = (await createIntentProvider().invoke("check", { repoDir: deep }, context(deep))) as { message: string; verdict: string };
		assert.equal(missing.verdict, "unavailable");
		assert.ok(missing.message.length <= 500, String(missing.message.length));
	} finally { rmSync(repo, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); }
});

test("a child directory whose name starts with two dots is inside the session cwd; a parent is not", () => {
	const dir = scratch();
	try {
		mkdirSync(join(dir, "..inside"));
		assert.equal(confineRepoDir("..inside", dir), join(realpathSync(dir), "..inside"));
		assert.throws(() => confineRepoDir("..", dir), /outside the session cwd/);
		const sibling = mkdtempSync(join(dirname(dir), "sibling-"));
		try { assert.throws(() => confineRepoDir(join("..", sibling.split("/").at(-1) as string), dir), /outside the session cwd/); } finally { rmSync(sibling, { recursive: true, force: true }); }
	} finally { rmSync(dir, { recursive: true, force: true }); }
});


test("a descendant that escaped the group and still holds the pipes does not hold the run open past the grace period", async () => {
	const dir = scratch();
	const pidFile = join(dir, "escaped.pid");
	try {
		const body = "import { spawn } from \"node:child_process\"; spawn(process.execPath, [\"-e\", \"require('fs').writeFileSync(\" + JSON.stringify(" + JSON.stringify(pidFile) + ") + \", String(process.pid)); setTimeout(()=>{}, 4000)\"], { stdio: \"inherit\", detached: true }).unref(); process.stdout.write('bye\\n'); process.exit(0);";
		const started = Date.now();
		const out = await runKit([script(dir, body)], runOptions(dir, { timeoutMs: 20_000 }));
		assert.equal(out.status, 0);
		assert.equal(out.timedOut, false);
		assert.equal(out.stdout, "bye\n");
		assert.ok(Date.now() - started < 3_000, "held open by the escaped descendant: " + String(Date.now() - started) + "ms");
	} finally {
		if (existsSync(pidFile)) { try { const pid = Number(readFileSync(pidFile, "utf8")); if (pid > 0) process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a script killed by a signal says which signal", async () => {
	const dir = scratch();
	try {
		const out = await runKit([script(dir, "process.kill(process.pid, 'SIGTERM'); setInterval(()=>{},1000);")], runOptions(dir));
		assert.equal(out.status, null);
		assert.match(out.stderr, /SIGTERM/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
