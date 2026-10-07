import { spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { FabricActionDescriptor, FabricComponentDefinition, FabricInvocationContext, FabricProvider } from "pi-fabric/protocol";

/** What a kit script run produced. The kit scripts exit 0 (pass), 1 (reject) or 2 (missing input or tool). */
export interface KitRun {
	status: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/** The only options the provider ever hands to a subprocess; none of them come from the caller. */
export interface KitRunOptions {
	cwd: string;
	timeoutMs: number;
	maxOutputBytes: number;
	signal: AbortSignal | undefined;
}

export type KitRunner = (argv: readonly string[], options: KitRunOptions) => Promise<KitRun>;

export interface IntentProviderOptions {
	run?: KitRunner;
}

export type IntentVerdict = "pass" | "reject" | "unavailable";

export interface IntentActionResult {
	action: string;
	verdict: IntentVerdict;
	exitCode: number | null;
	message: string;
	output: string;
	truncated: boolean;
}

const OUTPUT_TAIL_CHARS = 16_384;
const MESSAGE_MAX_CHARS = 500;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const RECORD_ID = /^\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface ActionSpec {
	description: string;
	risk: FabricActionDescriptor["risk"];
	timeoutMs: number;
	properties: Record<string, unknown>;
	required: string[];
	argv(script: string, repoDir: string, args: Record<string, unknown>): string[];
}

const repoDirProperty = { type: "string", description: "Repository directory; defaults to the session cwd and must stay inside it." };

/** The offered actions. There is deliberately no approve action: approved-by and laws.sha256 belong to a person. */
const ACTIONS: Record<string, ActionSpec> = {
	check: {
		description: "Run the repository's vendored intent-check: record structure, approved law hash and Jev receipt verdict, offline.",
		risk: "execute", timeoutMs: 120_000, required: [],
		properties: { repoDir: repoDirProperty },
		argv: (script, repoDir) => [script, repoDir],
	},
	gate: {
		description: "Run the vendored intent-gate: Bend proofs, negative controls and the scanner cross-check.",
		risk: "execute", timeoutMs: 900_000, required: [],
		properties: { repoDir: repoDirProperty },
		argv: (script, repoDir) => [script, repoDir],
	},
	conform: {
		description: "Run the vendored intent-conform: the model against the real code through the conformance manifest.",
		risk: "execute", timeoutMs: 900_000, required: [],
		properties: { repoDir: repoDirProperty, requireCoverage: { type: "boolean", description: "Fail when a law has no conformance check." } },
		argv: (script, repoDir, args) => [script, repoDir, ...(args.requireCoverage === true ? ["--require-coverage"] : [])],
	},
	receipt: {
		description: "Run the vendored intent-receipt: judge an approved record against the approved laws with Jev and write the receipt. Spends on Jev.",
		risk: "network", timeoutMs: 1_800_000, required: ["recordId", "model"],
		properties: {
			repoDir: repoDirProperty,
			recordId: { type: "string", pattern: RECORD_ID.source, description: "Record id such as 0001-transitions." },
			model: { type: "string", minLength: 1, description: "Jev model, for example typesafe/jev-1.13." },
		},
		argv: (script, repoDir, args) => [script, repoDir, args.recordId as string, args.model as string],
	},
};

function describe(name: string, spec: ActionSpec): FabricActionDescriptor {
	return {
		name,
		description: spec.description,
		risk: spec.risk,
		inputSchema: { type: "object", properties: spec.properties, required: spec.required, additionalProperties: false },
		outputSchema: {
			type: "object",
			properties: {
				action: { type: "string" },
				verdict: { enum: ["pass", "reject", "unavailable"] },
				exitCode: { type: ["integer", "null"] },
				message: { type: "string" },
				output: { type: "string" },
				truncated: { type: "boolean" },
			},
			required: ["action", "verdict", "exitCode", "message", "output", "truncated"],
		},
	};
}

function inside(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Resolve the repository directory and require that it stays inside the session cwd, links included. */
export function confineRepoDir(repoDir: unknown, cwd: string): string {
	if (repoDir !== undefined && (typeof repoDir !== "string" || repoDir === "" || repoDir.includes("\0"))) throw new Error("invalid repoDir");
	let base: string;
	let target: string;
	try {
		base = realpathSync(cwd);
		target = realpathSync(resolve(cwd, repoDir ?? "."));
	} catch {
		throw new Error("invalid repoDir: the directory does not exist");
	}
	if (!inside(base, target)) throw new Error("repoDir is outside the session cwd");
	return target;
}

/**
 * The repository's vendored script, so the provider checks what CI checks. Undefined when it is missing, is not a regular file, or sits
 * behind a link. A linked script is refused because the kit entry point compares its own path with its resolved path and exits 0
 * without running anything when they differ, which would report a pass for a check that never ran.
 */
function vendoredScript(repoDir: string, name: string): string | undefined {
	const path = join(repoDir, ".intent", "tools", `intent-${name}.mjs`);
	try {
		if (!lstatSync(path).isFile()) return undefined;
		return realpathSync(path) === path ? path : undefined;
	} catch {
		return undefined;
	}
}

/** One limiter for every message, the ellipsis included in the budget. */
const limit = (text: string): string => (text.length > MESSAGE_MAX_CHARS ? `${text.slice(0, MESSAGE_MAX_CHARS - 3)}...` : text);
const lastLine = (text: string): string => limit(text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? "");

function result(action: string, run: KitRun, timeoutMs: number): IntentActionResult {
	const combined = run.stderr ? `${run.stdout}${run.stdout && !run.stdout.endsWith("\n") ? "\n" : ""}${run.stderr}` : run.stdout;
	const verdict: IntentVerdict = run.timedOut ? "unavailable" : run.status === 0 ? "pass" : run.status === 1 ? "reject" : "unavailable";
	const message = run.timedOut ? `${action} timed out after ${Math.round(timeoutMs / 1000)}s` : (run.status === 0 ? lastLine(run.stdout) : lastLine(run.stderr) || lastLine(run.stdout)) || `${action} exited ${String(run.status)}`;
	const truncated = combined.length > OUTPUT_TAIL_CHARS;
	return { action, verdict, exitCode: run.status, message, output: truncated ? combined.slice(-OUTPUT_TAIL_CHARS) : combined, truncated };
}

/**
 * Run a script with node, an argv array and no shell. The child leads its own process group, so a timeout, a cancel, an output overflow or
 * the leader's own exit ends every member of that group (gate and conform spawn Bend and the oracles), not only the first process. A
 * descendant that starts its own group or session is outside this guarantee. The runner needs POSIX process groups and refuses to run
 * elsewhere. Only the fixed options below reach spawn.
 */
export const runKit: KitRunner = (argv, options) =>
	new Promise((resolvePromise) => {
		if (process.platform === "win32") {
			resolvePromise({ status: null, stdout: "", stderr: "the intent provider needs POSIX process groups to end a run's process tree; it does not run on this platform", timedOut: false });
			return;
		}
		const child = spawn(process.execPath, [...argv], { cwd: options.cwd, shell: false, windowsHide: true, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		const decoders = { out: new StringDecoder("utf8"), err: new StringDecoder("utf8") };
		let stdout = "";
		let stderr = "";
		let size = 0;
		let reason: "timeout" | "abort" | "overflow" | undefined;
		let settled = false;
		let grace: NodeJS.Timeout | undefined;
		const killGroup = (): void => {
			try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* none left */ }
		};
		const killTree = (why: "timeout" | "abort" | "overflow"): void => {
			reason ??= why;
			killGroup();
		};
		const timer = setTimeout(() => killTree("timeout"), options.timeoutMs);
		const onAbort = (): void => killTree("abort");
		if (options.signal?.aborted) onAbort(); else options.signal?.addEventListener("abort", onAbort, { once: true });
		const take = (chunk: Buffer, into: "out" | "err"): void => {
			size += chunk.length;
			if (size > options.maxOutputBytes) return killTree("overflow");
			if (into === "out") stdout += decoders.out.write(chunk); else stderr += decoders.err.write(chunk);
		};
		child.stdout.on("data", (c: Buffer) => take(c, "out"));
		child.stderr.on("data", (c: Buffer) => take(c, "err"));
		const finish = (status: number | null, extra = "", signal: NodeJS.Signals | null = null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(grace);
			options.signal?.removeEventListener("abort", onAbort);
			// No kill here: every path that reaches finish with a live group has already killed it (the exit handler, killTree), and a second
			// kill after the leader was reaped could hit a reused process group id.
			// A run stopped mid-character on overflow ends with U+FFFD from the decoder flush; the run is already marked as stopped.
			stdout += decoders.out.end();
			stderr += decoders.err.end();
			const note = reason === "overflow" ? "output exceeded the size cap; the run was stopped" : reason === "abort" ? "cancelled" : reason ? "" : extra || (signal ? `killed by ${signal}` : "");
			resolvePromise({ status: reason ? null : status, stdout, stderr: note ? `${stderr}${stderr && !stderr.endsWith("\n") ? "\n" : ""}${note}` : stderr, timedOut: reason === "timeout" });
		};
		child.on("error", (e) => finish(null, e.message));
		// The leader is gone: end what it left behind now, keep reading until the pipes close, and do not wait for a descendant
		// that escaped the group and still holds them.
		child.on("exit", (code, signal) => {
			killGroup();
			grace = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(code, "", signal); }, 1_000);
		});
		child.on("close", (code, signal) => finish(code, "", signal));
	});

function requireString(args: Record<string, unknown>, key: string, pattern?: RegExp): string {
	const value = args[key];
	if (typeof value !== "string" || value === "") throw new Error(`${key} is required`);
	if (pattern ? !pattern.test(value) : value.startsWith("-") || value.includes("\0")) throw new Error(`invalid ${key}`);
	return value;
}

/** The `intent` Fabric provider: typed wrappers over the repository's vendored kit scripts. */
export function createIntentProvider(options: IntentProviderOptions = {}): FabricProvider {
	const run = options.run ?? runKit;
	return {
		name: "intent",
		description: "Check, gate, conform and receipt for compiled-intent repositories; approval stays with a person",
		async list() {
			return Object.entries(ACTIONS).map(([name, spec]) => describe(name, spec));
		},
		async describe(actionName) {
			return Object.hasOwn(ACTIONS, actionName) ? describe(actionName, ACTIONS[actionName] as ActionSpec) : undefined;
		},
		async invoke(actionName, args, context: FabricInvocationContext) {
			if (!Object.hasOwn(ACTIONS, actionName)) throw new Error(`unknown action intent.${actionName}`);
			const spec = ACTIONS[actionName] as ActionSpec;
			// Copy only the named fields; nothing else from the caller reaches the subprocess.
			const picked: Record<string, unknown> = {};
			for (const key of Object.keys(spec.properties)) if (key !== "repoDir" && args[key] !== undefined) picked[key] = args[key];
			if (actionName === "receipt") {
				picked.recordId = requireString(args, "recordId", RECORD_ID);
				picked.model = requireString(args, "model");
			}
			const repoDir = confineRepoDir(args.repoDir, context.cwd);
			const script = vendoredScript(repoDir, actionName);
			if (!script) {
				return { action: actionName, verdict: "unavailable", exitCode: null, message: limit(`.intent/tools/intent-${actionName}.mjs is missing; run pi-intent vendor ${repoDir}`), output: "", truncated: false } satisfies IntentActionResult;
			}
			const out = await run(spec.argv(script, repoDir, picked), { cwd: repoDir, timeoutMs: spec.timeoutMs, maxOutputBytes: MAX_OUTPUT_BYTES, signal: context.signal });
			return result(actionName, out, spec.timeoutMs);
		},
	};
}

/** The component that mounts the provider; Fabric unwinds it on reload or removal. */
export const INTENT_COMPONENT: FabricComponentDefinition = {
	name: "pi-intent",
	description: "Compiled-intent checks as typed Fabric actions",
	provides: ["intent"],
	guarantee: "managed",
	activate(context) {
		const lease = context.provide(createIntentProvider());
		return () => lease.retire();
	},
};
